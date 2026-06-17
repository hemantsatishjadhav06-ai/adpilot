// ── src/guardrails/rules/blastRadius.ts ───────────────────────────────────
// Blast-radius guardrail (Doc 03 §3): cap actions per account per cycle so we
// don't restructure everything at once and lose attribution of what worked.
// Applied AFTER per-action evaluation, across the surviving (allow/modify) set.

import type { ProposedAction, GuardrailConfig } from "../../shared/types.ts";

// Higher = more urgent. Stopping waste and protecting winners come first.
const TYPE_URGENCY: Record<string, number> = {
  pause: 90,            // anomaly / proven loser — stop the bleed
  reduce_budget: 80,
  scale_budget: 70,     // protect/extend winners
  refresh_creative: 55,
  launch_new_test: 50,
  adjust_bid: 45,
  narrow_audience: 35,
  expand_audience: 30,
  enable: 25,
};

function priority(a: ProposedAction): number {
  const base = TYPE_URGENCY[a.type] ?? 20;
  const hint = Number(a.payload._priority ?? 0); // optimizer may pin urgency (e.g. anomaly)
  return Math.max(base, hint) + a.confidence; // confidence breaks ties
}

export interface BlastResult {
  kept: ProposedAction[];
  deferred: ProposedAction[];
}

export function applyBlastRadius(actions: ProposedAction[], cfg: GuardrailConfig): BlastResult {
  const ranked = [...actions].sort((a, b) => priority(b) - priority(a));
  const kept = ranked.slice(0, cfg.maxActionsPerCycle);
  const deferred = ranked.slice(cfg.maxActionsPerCycle);
  return { kept, deferred };
}
