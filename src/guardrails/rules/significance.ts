// ── src/guardrails/rules/significance.ts ──────────────────────────────────
// Significance / data-sufficiency guardrails (Doc 03 §3–4). No scale/kill on
// performance grounds until minimum data exists; A/B-driven actions require a
// significance verdict. One bad day is never enough.

import type { ProposedAction, GuardrailConfig } from "../../shared/types.ts";
import type { ObjectGuardState, RuleResult } from "../types.ts";
import { allow, block } from "../types.ts";
import { fmtINR } from "../../shared/money.ts";

const PERFORMANCE_DRIVEN = new Set(["scale_budget", "reduce_budget", "adjust_bid"]);
const AB_DRIVEN = new Set(["pause", "launch_new_test"]);

export function checkSignificance(
  action: ProposedAction, cfg: GuardrailConfig, obj: ObjectGuardState,
): RuleResult {
  // Anomaly pauses bypass the data gate — stopping runaway spend is always safe.
  if (obj.isAnomaly) return allow("anomaly response — data gate bypassed (stopping spend is safe)");

  if (PERFORMANCE_DRIVEN.has(action.type)) {
    const w = obj.window;
    const m = cfg.minDataToDecide;
    if (w.spendMinor < m.spendMinor || w.impressions < m.impressions || w.days < m.days) {
      return block(
        `insufficient data to decide: ${fmtINR(w.spendMinor)}/${w.impressions} impr/${w.days}d ` +
        `(need ≥ ${fmtINR(m.spendMinor)}/${m.impressions}/${m.days}d)`,
      );
    }
  }

  if (AB_DRIVEN.has(action.type)) {
    // If the proposal cites an A/B significance figure, enforce the threshold.
    const sig = action.evidence.find((e) => typeof e.significance === "number")?.significance;
    if (typeof sig === "number" && sig < 0.95) {
      return block(`A/B comparison not yet significant (P(A>B)=${sig.toFixed(2)} < 0.95)`);
    }
  }

  return allow();
}
