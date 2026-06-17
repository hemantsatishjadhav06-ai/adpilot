// ── src/guardrails/rules/cadence.ts ───────────────────────────────────────
// Cadence / learning-phase guardrails — "the make-or-break" (Doc 03 §3).
// Significant edits to an ad set in the learning phase (or with too few
// conversions, or edited too recently) reset learning and tank delivery. This
// is the #1 way naive automation destroys ROAS, so it is a HARD BLOCK.
//
// Pausing / refreshing creative / launching new tests are exempt: stopping
// spend is the one always-safe action, and refresh + new tests are *preferred*
// over editing in-flight winners.

import type { ProposedAction, GuardrailConfig } from "../../shared/types.ts";
import type { ObjectGuardState, RuleResult } from "../types.ts";
import { allow, block, isEdit, isInLearning, hoursSince } from "../types.ts";

export function checkCadence(
  action: ProposedAction, cfg: GuardrailConfig, obj: ObjectGuardState,
): RuleResult {
  if (!isEdit(action.type)) return allow(); // pause/enable/refresh/launch_test exempt

  if (isInLearning(obj)) {
    const until = obj.inLearningUntil ? ` (learning until ${new Date(obj.inLearningUntil).toISOString().slice(0, 10)})` : "";
    return block(`ad set is in the LEARNING PHASE${until} — significant edits reset learning and tank delivery`);
  }

  if (obj.conversionsInWindow < cfg.minConversionsToEdit) {
    return block(
      `only ${obj.conversionsInWindow} conversions in window (< ${cfg.minConversionsToEdit} required before editing)`,
    );
  }

  const since = hoursSince(obj.lastEditedAt);
  if (since < cfg.minEditIntervalHours) {
    return block(
      `last edited ${since.toFixed(0)}h ago (< ${cfg.minEditIntervalHours}h minimum hold time between edits)`,
    );
  }

  return allow();
}
