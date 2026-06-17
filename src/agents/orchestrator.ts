// ── src/agents/orchestrator.ts ────────────────────────────────────────────
// The OODA loop for one account (Doc 03 §1):
//   OBSERVE → ORIENT (Analyst) → DECIDE (Optimizer) → GUARDRAIL (engine) →
//   ACT/QUEUE (Co-pilot ⇒ queue only) → LEARN (audit; insights in Phase 4).
//
// Co-pilot is the default and the only tier wired in this MVP: nothing
// executes without a human approval click (Doc 00 §6, Doc 07 Phase 1). Every
// candidate — queued, modified, blocked, or deferred — is persisted with its
// guardrail verdict and written to the append-only audit log.

import type { AccountContext, ProposedAction } from "../shared/types.ts";
import type { ObjectGuardState } from "../guardrails/types.ts";
import { getConnector } from "../connectors/index.ts";
import { analyzeAccount, type AnalystReport } from "./analyst.ts";
import { propose } from "./optimizer.ts";
import { evaluate, applyBlastRadius } from "../guardrails/engine.ts";
import * as repo from "../db/repo.ts";
import { log } from "../shared/logger.ts";

export interface LoopSummary {
  accountExternalId: string;
  autonomy: string;
  observedAdSets: number;
  observedAds: number;
  proposed: number;
  queued: number;
  modified: number;
  blocked: number;
  deferred: number;
  conversionTrackingOk: boolean;
  report: AnalystReport;
}

function guardStateFor(action: ProposedAction, report: AnalystReport): ObjectGuardState {
  if (action.level === "ad_set") {
    const s = report.adSets.find((x) => x.externalId === action.targetExternalId)!;
    return {
      level: "ad_set", externalId: s.externalId,
      learningStatus: s.learningStatus, inLearningUntil: s.inLearningUntil,
      conversionsInWindow: s.conversionsInWindow, lastEditedAt: s.lastEditedAt,
      currentBudgetMinor: s.budgetMinor,
      window: { spendMinor: s.window.spendMinor, impressions: s.window.impressions, days: s.window.days, cpaMinor: s.window.cpaMinor },
      isAnomaly: s.isAnomaly,
    };
  }
  const ad = report.ads.find((x) => x.externalId === action.targetExternalId)!;
  return {
    level: "ad", externalId: ad.externalId,
    learningStatus: "active", inLearningUntil: null,
    conversionsInWindow: ad.window.conversions, lastEditedAt: null,
    currentBudgetMinor: 0,
    window: { spendMinor: ad.window.spendMinor, impressions: ad.window.impressions, days: ad.window.days, cpaMinor: ad.window.cpaMinor },
    isAnomaly: false,
  };
}

export async function runLoop(accountDbId: string): Promise<LoopSummary> {
  const ctx: AccountContext = repo.getAccountContext(accountDbId);
  const connector = getConnector(ctx.platform);
  log.info(`OODA loop start`, { account: ctx.displayName, autonomy: ctx.autonomyLevel });

  // Onboarding gate (Doc 03 §5): never optimise toward a broken conversion signal.
  if (!ctx.conversionTrackingOk) {
    log.warn("conversion tracking not verified — loop runs in observe-only mode");
  }

  // OBSERVE + ORIENT
  const report = await analyzeAccount(ctx, connector);

  // DECIDE
  const candidates = ctx.conversionTrackingOk ? propose(report, ctx) : [];

  // GUARDRAIL — evaluate every candidate deterministically.
  const passable: ProposedAction[] = [];
  const blocked: ProposedAction[] = [];
  for (const a of candidates) {
    const v = evaluate(a, ctx, ctx.guardrails, guardStateFor(a, report));
    a.guardrailVerdict = v.verdict;
    a.guardrailReasons = v.reasons;
    if (v.verdict === "modify" && v.modifiedPayload) a.payload = { ...a.payload, ...v.modifiedPayload };
    if (v.verdict === "block") blocked.push(a);
    else passable.push(a);
  }

  // BLAST RADIUS — cap actions per cycle; defer the lowest-priority overflow.
  const { kept, deferred } = applyBlastRadius(passable, ctx.guardrails);

  // ACT / QUEUE (Co-pilot ⇒ queue; nothing executes) + LEARN (audit)
  let modified = 0;
  for (const a of kept) {
    a.status = "queued";
    if (a.guardrailVerdict === "modify") modified++;
    repo.insertAction(ctx.orgId, ctx.accountDbId, a);
    repo.audit(ctx.orgId, ctx.accountDbId, "agent", a.proposedByAgent ?? "optimizer", a.id,
      a.guardrailVerdict === "modify" ? "queued_modified" : "queued", null,
      { type: a.type, target: a.targetName, verdict: a.guardrailVerdict, reasons: a.guardrailReasons });
  }
  for (const a of deferred) {
    a.status = "proposed";
    a.guardrailReasons = [...(a.guardrailReasons ?? []), `deferred: blast-radius cap (${ctx.guardrails.maxActionsPerCycle} actions/cycle)`];
    repo.insertAction(ctx.orgId, ctx.accountDbId, a);
    repo.audit(ctx.orgId, ctx.accountDbId, "agent", "orchestrator", a.id, "deferred", null,
      { type: a.type, target: a.targetName });
  }
  for (const a of blocked) {
    a.status = "proposed"; // not queued — surfaced as "blocked by guardrails"
    repo.insertAction(ctx.orgId, ctx.accountDbId, a);
    repo.audit(ctx.orgId, ctx.accountDbId, "agent", "guardrail-engine", a.id, "blocked", null,
      { type: a.type, target: a.targetName, reasons: a.guardrailReasons });
  }

  const summary: LoopSummary = {
    accountExternalId: ctx.externalId,
    autonomy: ctx.autonomyLevel,
    observedAdSets: report.adSets.length,
    observedAds: report.ads.length,
    proposed: candidates.length,
    queued: kept.length,
    modified,
    blocked: blocked.length,
    deferred: deferred.length,
    conversionTrackingOk: ctx.conversionTrackingOk,
    report,
  };
  log.info("OODA loop complete", {
    queued: summary.queued, modified: summary.modified, blocked: summary.blocked, deferred: summary.deferred,
  });
  return summary;
}
