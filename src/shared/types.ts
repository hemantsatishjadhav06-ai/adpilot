// ── src/shared/types.ts ───────────────────────────────────────────────────
// The spine of the system. Everything the Optimizer produces and the Media
// Buyer consumes is one shape: ProposedAction (Doc 02 §4).
// Strip-friendly: string-literal unions instead of enums.

export type Platform = "meta" | "google";
export type AutonomyLevel = "manual" | "copilot" | "autopilot" | "full_auto";
export type TargetKpi = "cpa" | "roas";
export type ObjectLevel = "campaign" | "ad_set" | "ad";

export type ActionType =
  | "scale_budget"
  | "reduce_budget"
  | "pause"
  | "enable"
  | "adjust_bid"
  | "refresh_creative"
  | "expand_audience"
  | "narrow_audience"
  | "launch_new_test";

export type GuardrailVerdict = "allow" | "modify" | "block";

export type ActionStatus =
  | "proposed"
  | "queued"
  | "approved"
  | "rejected"
  | "executing"
  | "executed"
  | "rolled_back"
  | "failed";

/** What the Analyst found and the Optimizer cites as justification. */
export interface Evidence {
  metric: string;
  value: number;
  target: number;
  window: string;
  sampleSize: number;
  significance?: number; // 0–1 (e.g. P(A>B)) when relevant
}

export interface ExpectedImpact {
  metric: string;
  direction: "up" | "down";
  estimate?: number;
}

/**
 * The single contract that makes Co-pilot, Autopilot, audit logging and
 * rollback all work from one mechanism (Doc 02 §4).
 */
export interface ProposedAction {
  id: string;
  accountId: string;
  level: ObjectLevel;
  targetExternalId: string;
  targetName?: string; // convenience for UI / logs
  type: ActionType;
  payload: Record<string, unknown>; // platform-specific change
  rationale: string; // human-readable "why"
  evidence: Evidence[];
  expectedImpact: ExpectedImpact;
  confidence: number; // 0–1
  rollback: Record<string, unknown>; // how to undo it
  guardrailVerdict?: GuardrailVerdict;
  guardrailReasons?: string[]; // why the engine allowed / modified / blocked
  status: ActionStatus;
  proposedByAgent?: string;
}

// ── Connector-facing read shapes (Doc 06 §3) ──────────────────────────────

export interface AccountState {
  externalId: string;
  platform: Platform;
  displayName: string;
  status: "connected" | "paused" | "killed";
  currencyMinorPerUnit: number; // 100 for INR/USD (paise/cents)
}

export interface CampaignNode {
  externalId: string;
  name: string;
  objective: string;
  status: string;
  adSets: AdSetNode[];
}

export interface AdSetNode {
  externalId: string;
  name: string;
  budgetMinor: number;
  bidStrategy: string;
  status: string;
  learningStatus: "learning" | "active" | "limited";
  conversionsInWindow: number;
  inLearningUntil: string | null; // ISO timestamp
  lastEditedAt: string | null; // ISO timestamp
  ads: AdNode[];
}

export interface AdNode {
  externalId: string;
  name: string;
  creativeExternalId: string;
  status: string;
  lastEditedAt: string | null;
}

export interface CampaignTree {
  account: AccountState;
  campaigns: CampaignNode[];
}

/** A normalised metric snapshot for one object over one window (Doc 04 §6). */
export interface MetricSnapshot {
  level: ObjectLevel;
  objectExternalId: string;
  windowStart: string;
  windowEnd: string;
  spendMinor: number;
  impressions: number;
  clicks: number;
  conversions: number;
  ctr: number; // %
  cpcMinor: number;
  cpmMinor: number;
  cpaMinor: number;
  roas: number;
  frequency: number;
  capturedAt: string;
}

// ── Guardrail config (Doc 04 §8) ──────────────────────────────────────────

export interface GuardrailConfig {
  maxBudgetIncreasePct: number; // e.g. 25
  minEditIntervalHours: number; // e.g. 36
  minConversionsToEdit: number; // e.g. 50
  minDataToDecide: { spendMinor: number; impressions: number; days: number };
  maxActionsPerCycle: number; // e.g. 5
  cpaPauseMultiplier: number; // e.g. 3
  monthlyCapMinor: number;
  dailyCapMinor: number;
}

/** Everything the deterministic guardrail engine needs, for one account. */
export interface AccountContext {
  accountDbId: string;
  orgId: string;
  externalId: string;
  platform: Platform;
  displayName: string;
  autonomyLevel: AutonomyLevel;
  targetKpi: TargetKpi;
  targetValue: number; // minor units for cpa, ratio for roas
  conversionTrackingOk: boolean;
  status: "connected" | "paused" | "killed";
  guardrails: GuardrailConfig;
  monthSpendMinor: number; // spend so far this calendar month
  daySpendMinor: number; // spend so far today
}
