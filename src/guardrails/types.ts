// ── src/guardrails/types.ts ───────────────────────────────────────────────
// The guardrail engine is DETERMINISTIC and pure: no LLM, no network (Doc 03
// §3, Doc 05 boundary rules). An LLM proposes; this code decides.

import type { ObjectLevel, GuardrailVerdict } from "../shared/types.ts";

/** Everything a rule needs to know about the object an action targets. */
export interface ObjectGuardState {
  level: ObjectLevel;
  externalId: string;
  learningStatus: "learning" | "active" | "limited";
  inLearningUntil: string | null;
  conversionsInWindow: number;
  lastEditedAt: string | null;
  currentBudgetMinor: number;
  window: { spendMinor: number; impressions: number; days: number; cpaMinor: number };
  isAnomaly: boolean; // CPA > multiplier × target, sustained
}

export interface RuleResult {
  verdict: GuardrailVerdict;
  reasons: string[];
  modifiedPayload?: Record<string, unknown>;
}

export const ALLOW: RuleResult = { verdict: "allow", reasons: [] };
export const allow = (reason?: string): RuleResult => ({ verdict: "allow", reasons: reason ? [reason] : [] });
export const block = (reason: string): RuleResult => ({ verdict: "block", reasons: [reason] });
export const modify = (reason: string, modifiedPayload: Record<string, unknown>): RuleResult => ({
  verdict: "modify", reasons: [reason], modifiedPayload,
});

export function hoursSince(iso: string | null): number {
  if (!iso) return Infinity;
  return (Date.now() - new Date(iso).getTime()) / 3_600_000;
}
export function isInLearning(obj: ObjectGuardState): boolean {
  if (obj.learningStatus === "learning") return true;
  if (obj.inLearningUntil && new Date(obj.inLearningUntil).getTime() > Date.now()) return true;
  return false;
}

const EDIT_TYPES = new Set(["scale_budget", "reduce_budget", "adjust_bid", "expand_audience", "narrow_audience"]);
export const isEdit = (type: string): boolean => EDIT_TYPES.has(type);
