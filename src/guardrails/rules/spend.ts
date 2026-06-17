// ── src/guardrails/rules/spend.ts ─────────────────────────────────────────
// Spend guardrails (Doc 03 §3): hard caps, max single budget increase, daily
// cap. Money in minor units throughout.

import type { ProposedAction, GuardrailConfig, AccountContext } from "../../shared/types.ts";
import type { ObjectGuardState, RuleResult } from "../types.ts";
import { allow, block, modify } from "../types.ts";
import { pctIncrease, applyPct, fmtINR } from "../../shared/money.ts";

export function checkSpend(
  action: ProposedAction, ctx: AccountContext, cfg: GuardrailConfig, obj: ObjectGuardState,
): RuleResult {
  if (action.type !== "scale_budget") return allow();

  const requested = Number(action.payload.newBudgetMinor ?? obj.currentBudgetMinor);
  const old = obj.currentBudgetMinor;
  const reasons: string[] = [];
  let effective = requested;
  let verdict: "allow" | "modify" = "allow";
  const modifiedPayload: Record<string, unknown> = { ...action.payload };

  // Max single budget increase (respects learning, prevents runaway scaling).
  const pct = pctIncrease(old, requested);
  if (pct > cfg.maxBudgetIncreasePct) {
    effective = applyPct(old, cfg.maxBudgetIncreasePct);
    modifiedPayload.newBudgetMinor = effective;
    verdict = "modify";
    reasons.push(
      `requested +${pct.toFixed(0)}% exceeds max ${cfg.maxBudgetIncreasePct}%/24h — capped to ${fmtINR(effective)} (+${cfg.maxBudgetIncreasePct}%)`,
    );
  }

  // Hard monthly cap: block any increase once the cap is already reached.
  if (ctx.monthSpendMinor >= cfg.monthlyCapMinor) {
    return block(`monthly cap ${fmtINR(cfg.monthlyCapMinor)} already reached — no increases permitted`);
  }

  // Daily cap: the incremental daily delta must not breach the day cap.
  const delta = effective - old;
  const projectedDay = ctx.daySpendMinor + delta;
  if (projectedDay > cfg.dailyCapMinor) {
    return block(
      `projected day spend ${fmtINR(projectedDay)} would breach daily cap ${fmtINR(cfg.dailyCapMinor)}`,
    );
  }

  return verdict === "modify" ? modify(reasons.join("; "), modifiedPayload) : allow();
}
