// ── src/connectors/types.ts ───────────────────────────────────────────────
// Uniform connector interface so agents don't care which platform (Doc 06 §3).
// READ methods are used by Analyst/Audience. WRITE methods are used by the
// Media Buyer ONLY, and only after the guardrail engine has passed an action.
// Connectors contain NO business logic — just typed API calls + token/rate
// handling + idempotency + dry-run (Doc 05 import-boundary rules).

import type {
  AccountState, CampaignTree, MetricSnapshot, ObjectLevel,
} from "../shared/types.ts";

export interface MetricsQuery {
  level: ObjectLevel;
  sinceIso: string;
  objectExternalId?: string;
}

export interface WriteResult {
  ok: boolean;
  externalId: string;
  dryRun: boolean;
  idempotencyKey: string;
  echo: Record<string, unknown>; // the payload that would be / was sent
}

export interface AdConnector {
  readonly platform: "meta" | "google";

  // READ ────────────────────────────────────────────────
  getAccount(externalId: string): Promise<AccountState>;
  getObjects(externalId: string): Promise<CampaignTree>;
  getMetrics(externalId: string, q: MetricsQuery): Promise<MetricSnapshot[]>;
  getTaxonomies(externalId: string): Promise<{ interests: string[]; geos: string[] }>;

  // WRITE (Media Buyer only, post-guardrail) ─────────────
  updateBudget(externalId: string, adSetExternalId: string, newBudgetMinor: number, idem: string): Promise<WriteResult>;
  updateBid(externalId: string, adSetExternalId: string, newBidMinor: number, idem: string): Promise<WriteResult>;
  pause(externalId: string, level: ObjectLevel, objectExternalId: string, idem: string): Promise<WriteResult>;
  enable(externalId: string, level: ObjectLevel, objectExternalId: string, idem: string): Promise<WriteResult>;
  refreshCreative(externalId: string, adExternalId: string, newCreative: Record<string, unknown>, idem: string): Promise<WriteResult>;
  launchTest(externalId: string, adSetExternalId: string, variants: Record<string, unknown>[], idem: string): Promise<WriteResult>;
}
