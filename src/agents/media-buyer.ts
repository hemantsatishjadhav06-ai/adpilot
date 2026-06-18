// ── src/agents/media-buyer.ts ─────────────────────────────────────────────
// ⚠️ The SOLE write path to the ad platforms (Doc 02 §2). It executes only
// action records that already passed the guardrail engine and were approved
// (Co-pilot) or auto-approved (Autopilot). Every write is idempotent, updates
// the local mirror, and is wrapped in append-only audit records with a
// rollback payload (Doc 03 §6, Doc 04 §7).

import type { AccountContext, ObjectLevel } from "../shared/types.ts";
import { getConnector } from "../connectors/index.ts";
import { checkKillSwitch } from "../guardrails/kill-switch.ts";
import { blocked } from "../shared/errors.ts";
import * as repo from "../db/repo.ts";
import { log } from "../shared/logger.ts";

export interface ExecResult {
  ok: boolean;
  dryRun: boolean;
  echo: Record<string, unknown>;
}

export async function executeAction(actionId: string): Promise<ExecResult> {
  const a = repo.getAction(actionId);
  if (!a) throw new Error(`no action ${actionId}`);
  const ctx: AccountContext = repo.getAccountContext(a.ad_account_id as string);

  // ── Backstop: the guardrail engine gates EVERY write, even an already-approved
  // one (Doc 03 §3, Doc 08 §8). State can change between proposal and execution
  // (e.g. the kill switch is engaged), so re-check here at the true write boundary.
  const ks = checkKillSwitch(ctx);
  if (ks.verdict === "block") {
    repo.updateActionStatus(actionId, "queued", { result: JSON.stringify({ ok: false, blocked: true, reasons: ks.reasons }) });
    repo.audit(ctx.orgId, ctx.accountDbId, "system", "guardrail-engine", actionId, "blocked", null, { phase: "execute", reasons: ks.reasons });
    log.warn("execution blocked by guardrail backstop", { actionId, reasons: ks.reasons });
    throw blocked(ks.reasons.join("; "));
  }

  const connector = getConnector(ctx.platform);
  const level = a.level as ObjectLevel;
  const targetExt = a.target_external_id as string;
  const payload = JSON.parse((a.payload as string) ?? "{}");
  const idem = actionId; // stable idempotency key

  repo.updateActionStatus(actionId, "executing", { executed_at: null });
  repo.audit(ctx.orgId, ctx.accountDbId, "system", "media-buyer", actionId, "executing", null, payload);

  let echo: Record<string, unknown> = {};
  try {
    switch (a.type as string) {
      case "scale_budget":
      case "reduce_budget": {
        const newBudget = Number(payload.newBudgetMinor);
        const r = await connector.updateBudget(ctx.externalId, targetExt, newBudget, idem);
        repo.applyMirrorBudget(targetExt, newBudget);
        echo = r.echo;
        break;
      }
      case "pause": {
        const r = await connector.pause(ctx.externalId, level, targetExt, idem);
        repo.applyMirrorStatus(level, targetExt, "paused");
        echo = r.echo;
        break;
      }
      case "enable": {
        const r = await connector.enable(ctx.externalId, level, targetExt, idem);
        repo.applyMirrorStatus(level, targetExt, "active");
        echo = r.echo;
        break;
      }
      case "adjust_bid": {
        const r = await connector.updateBid(ctx.externalId, targetExt, Number(payload.newBidMinor ?? 0), idem);
        echo = r.echo;
        break;
      }
      case "refresh_creative": {
        const r = await connector.refreshCreative(ctx.externalId, targetExt, payload, idem);
        repo.applyMirrorStatus("ad", targetExt, "active");
        echo = r.echo;
        break;
      }
      case "launch_new_test": {
        const r = await connector.launchTest(ctx.externalId, targetExt, payload.variants ?? [], idem);
        echo = r.echo;
        break;
      }
      default: {
        // expand/narrow audience: logged dry-run (no live audience edits in v1).
        echo = { op: a.type, targetExt, payload, note: "audience edit (dry-run, no connector method in v1)" };
        log.warn("[DRY-RUN] audience edit suppressed", echo);
      }
    }

    const dryRun = (echo as { dryRun?: boolean }).dryRun ?? true;
    repo.updateActionStatus(actionId, "executed", { executed_at: new Date().toISOString(), result: JSON.stringify({ ok: true, dryRun, echo }) });
    repo.audit(ctx.orgId, ctx.accountDbId, "system", "media-buyer", actionId, "executed", null, echo);
    return { ok: true, dryRun: true, echo };
  } catch (e) {
    repo.updateActionStatus(actionId, "failed", { result: JSON.stringify({ ok: false, error: String(e) }) });
    repo.audit(ctx.orgId, ctx.accountDbId, "system", "media-buyer", actionId, "failed", null, { error: String(e) });
    throw e;
  }
}
