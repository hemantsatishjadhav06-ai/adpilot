// ── src/agents/optimizer.ts ───────────────────────────────────────────────
// DECIDE (Doc 03 §1). Consumes the Analyst report and produces ranked
// ProposedActions with rationale / evidence / expectedImpact / confidence /
// rollback. Deterministic by default (Doc 01 §3: "for v1 you can approximate
// in TS"); the optional LLM (client.ts) only refines rationale prose — the
// decision logic and the guardrail GATES never depend on it.
//
// The system prompt at prompts/optimizer/v1.md encodes the same rules and the
// learning-phase discipline, so the LLM path stays consistent with this code.

import { randomUUID } from "node:crypto";
import type { AccountContext, ProposedAction, Evidence } from "../shared/types.ts";
import type { AnalystReport, AdSetAnalysis } from "./analyst.ts";
import { applyPct, fmtINR } from "../shared/money.ts";

const PROMPT_VERSION = "optimizer/v1";

function ev(metric: string, value: number, target: number, window: string, sampleSize: number, significance?: number): Evidence {
  return { metric, value, target, window, sampleSize, significance };
}

export function propose(report: AnalystReport, ctx: AccountContext): ProposedAction[] {
  const out: ProposedAction[] = [];
  const acct = ctx.externalId;
  const W = `${report.adSets[0]?.window.days ?? 7}d`;
  const targetCpa = ctx.targetValue;

  const base = (over: Partial<ProposedAction>): ProposedAction => ({
    id: randomUUID(),
    accountId: acct,
    level: "ad_set",
    targetExternalId: "",
    type: "scale_budget",
    payload: {},
    rationale: "",
    evidence: [],
    expectedImpact: { metric: "cpa", direction: "down" },
    confidence: 0.7,
    rollback: {},
    status: "proposed",
    proposedByAgent: PROMPT_VERSION,
    ...over,
  });

  for (const s of report.adSets) {
    const cpaRupees = Math.round(s.window.cpaMinor / 100);
    const targetRupees = Math.round(targetCpa / 100);

    // 1) Stop the bleed — anomaly pause (highest priority, always-safe).
    if (s.isAnomaly) {
      out.push(base({
        level: "ad_set", targetExternalId: s.externalId, targetName: s.name, type: "pause",
        payload: { _priority: 100, urgent: true, note: "auto-pause policy would fire even in Co-pilot" },
        rationale: `CPA ₹${cpaRupees} is ${s.cpaRatio}× the ₹${targetRupees} target and sustained over the recent window — pause to stop runaway spend.`,
        evidence: [ev("cpa_minor", s.window.cpaMinor, targetCpa, W, s.window.conversions)],
        expectedImpact: { metric: "wasted_spend", direction: "down", estimate: s.budgetMinor },
        confidence: 0.95,
        rollback: { op: "enable", level: "ad_set", externalId: s.externalId },
      }));
      continue; // don't also reduce a set we're pausing
    }

    // 2) Cut moderate losers (1.5–3× target) — reduce, don't pause.
    if (s.cpaRatio >= 1.5) {
      const newBudget = applyPct(s.budgetMinor, -30);
      const learningCaveat = s.learningStatus === "learning" || (s.inLearningUntil && new Date(s.inLearningUntil) > new Date());
      out.push(base({
        level: "ad_set", targetExternalId: s.externalId, targetName: s.name, type: "reduce_budget",
        payload: { newBudgetMinor: newBudget, _priority: 80 },
        rationale: learningCaveat
          ? `CPA ₹${cpaRupees} (${s.cpaRatio}× target) is poor, BUT this ad set appears to be in the learning phase — flagging for guardrail review rather than editing in-flight.`
          : `CPA ₹${cpaRupees} is ${s.cpaRatio}× the ₹${targetRupees} target — cut budget 30% to ${fmtINR(newBudget)} rather than pausing, to preserve learning while limiting loss.`,
        evidence: [ev("cpa_minor", s.window.cpaMinor, targetCpa, W, s.window.conversions)],
        expectedImpact: { metric: "cpa", direction: "down" },
        confidence: learningCaveat ? 0.5 : 0.8,
        rollback: { op: "updateBudget", externalId: s.externalId, newBudgetMinor: s.budgetMinor },
      }));
      continue;
    }

    // 3) Protect & extend winners (CPA comfortably below target).
    if (s.cpaRatio > 0 && s.cpaRatio <= 0.8) {
      const newBudget = applyPct(s.budgetMinor, 35); // intentionally aggressive; guardrail caps to 25%
      out.push(base({
        level: "ad_set", targetExternalId: s.externalId, targetName: s.name, type: "scale_budget",
        payload: { newBudgetMinor: newBudget, _priority: 70 },
        rationale: `CPA ₹${cpaRupees} is well under the ₹${targetRupees} target at ROAS ${s.window.roas} with ${s.conversionsInWindow} conversions — scale budget to capture more volume.`,
        evidence: [
          ev("cpa_minor", s.window.cpaMinor, targetCpa, W, s.window.conversions),
          ev("roas", s.window.roas, 2.5, W, s.window.conversions),
        ],
        expectedImpact: { metric: "conversions", direction: "up" },
        confidence: 0.85,
        rollback: { op: "updateBudget", externalId: s.externalId, newBudgetMinor: s.budgetMinor },
      }));
      continue;
    }

    // 4) Healthy-but-flat sets: a low-priority audience expansion to test.
    if (s.cpaRatio > 0.8 && s.cpaRatio < 1.5 && s.learningStatus === "active") {
      out.push(base({
        level: "ad_set", targetExternalId: s.externalId, targetName: s.name, type: "expand_audience",
        payload: { add: ["lookalike_2pct"], _priority: 30 },
        rationale: `CPA ₹${cpaRupees} is on target; test a modest audience expansion (2% lookalike) to find incremental volume.`,
        evidence: [ev("cpa_minor", s.window.cpaMinor, targetCpa, W, s.window.conversions)],
        expectedImpact: { metric: "reach", direction: "up" },
        confidence: 0.55,
        rollback: { op: "narrow_audience", externalId: s.externalId, remove: ["lookalike_2pct"] },
      }));
    }
  }

  // 5) Creative fatigue → refresh (not a budget cut).
  for (const ad of report.ads) {
    if (ad.fatigue.fatigued) {
      out.push(base({
        level: "ad", targetExternalId: ad.externalId, targetName: ad.name, type: "refresh_creative",
        payload: { reason: "fatigue", briefHint: "new hook + visual; keep proven angle", _priority: 55 },
        rationale: `${ad.name}: ${ad.fatigue.reason} — refresh the creative to recover CTR.`,
        evidence: [ev("frequency", ad.fatigue.frequencyLatest, 3.5, W, ad.window.impressions)],
        expectedImpact: { metric: "ctr", direction: "up" },
        confidence: 0.75,
        rollback: { op: "noop", note: "previous creative retained, can re-enable" },
      }));
    }
  }

  // 6) Creative tests → pause the loser once significant.
  for (const t of report.tests) {
    if (t.verdict.significant && t.loserExternalId) {
      const loser = report.ads.find((a) => a.externalId === t.loserExternalId);
      out.push(base({
        level: "ad", targetExternalId: t.loserExternalId, targetName: loser?.name ?? t.loserExternalId, type: "pause",
        payload: { reason: "lost_ab_test", winner: t.winnerExternalId, _priority: 60 },
        rationale: `A/B winner decided: P(winner>loser)=${t.verdict.pAbeatsB} with ${t.verdict.liftPct}% CVR lift — pause the losing variant and shift delivery to the winner.`,
        evidence: [ev("cvr", t.verdict.rateB, t.verdict.rateA, W, (loser?.window.clicks ?? 0), t.verdict.pAbeatsB)],
        expectedImpact: { metric: "cpa", direction: "down" },
        confidence: t.verdict.pAbeatsB,
        rollback: { op: "enable", level: "ad", externalId: t.loserExternalId },
      }));
    }
  }

  return out;
}
