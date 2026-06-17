// ── src/guardrails/engine.ts ──────────────────────────────────────────────
// Deterministic policy engine. evaluate(action, ctx, cfg, objState) → verdict.
// Block dominates; otherwise modify dominates allow. Reasons accumulate so the
// approval queue and audit log can show exactly WHY (Doc 03 §3).

import type { ProposedAction, AccountContext, GuardrailConfig } from "../shared/types.ts";
import type { ObjectGuardState, RuleResult } from "./types.ts";
import { checkKillSwitch } from "./kill-switch.ts";
import { checkSpend } from "./rules/spend.ts";
import { checkCadence } from "./rules/cadence.ts";
import { checkSignificance } from "./rules/significance.ts";

export interface Verdict {
  verdict: "allow" | "modify" | "block";
  reasons: string[];
  modifiedPayload?: Record<string, unknown>;
}

export function evaluate(
  action: ProposedAction, ctx: AccountContext, cfg: GuardrailConfig, obj: ObjectGuardState,
): Verdict {
  const results: RuleResult[] = [
    checkKillSwitch(ctx),
    checkCadence(action, cfg, obj),
    checkSignificance(action, cfg, obj),
    checkSpend(action, ctx, cfg, obj),
  ];

  const reasons: string[] = [];
  let modifiedPayload: Record<string, unknown> | undefined;
  let verdict: "allow" | "modify" | "block" = "allow";

  for (const r of results) {
    reasons.push(...r.reasons);
    if (r.verdict === "block") verdict = "block";
    else if (r.verdict === "modify") {
      if (verdict !== "block") verdict = "modify";
      modifiedPayload = { ...(modifiedPayload ?? {}), ...(r.modifiedPayload ?? {}) };
    }
  }

  if (verdict === "block") return { verdict, reasons };
  if (verdict === "modify") return { verdict, reasons, modifiedPayload };
  return { verdict: "allow", reasons: reasons.length ? reasons : ["within all guardrails"] };
}

export { applyBlastRadius } from "./rules/blastRadius.ts";
export type { BlastResult } from "./rules/blastRadius.ts";
