// ── src/db/repo.ts ────────────────────────────────────────────────────────
// Typed repository: maps snake_case rows to the camelCase domain shapes in
// shared/types.ts. Every tenant query is scoped by org_id in code (Doc 04 §11).

import { all, get, run, newId, nowIso } from "./client.ts";
import { notFound } from "../shared/errors.ts";
import type {
  AccountContext, GuardrailConfig, CampaignTree, CampaignNode, AdSetNode,
  AdNode, MetricSnapshot, ProposedAction, ObjectLevel,
} from "../shared/types.ts";

// ── Accounts ──────────────────────────────────────────────────────────────
interface AcctRow {
  id: string; org_id: string; platform: string; external_account_id: string;
  display_name: string; autonomy_level: string; monthly_cap_minor: number;
  daily_cap_minor: number; target_kpi: string; target_value: number;
  conversion_tracking_ok: number; status: string;
}

export function listAccounts(): AcctRow[] {
  return all<AcctRow>(`SELECT * FROM ad_accounts ORDER BY created_at`);
}

function monthStartIso(): string {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString();
}
function latestWindowStartIso(acctId: string): string {
  const r = get<{ w: string }>(
    `SELECT MAX(window_start) w FROM metric_snapshots WHERE ad_account_id=?`, [acctId],
  );
  return r?.w ?? new Date(0).toISOString();
}

export function getGuardrailConfig(orgId: string, acctId: string): GuardrailConfig {
  const row = get<Record<string, unknown>>(
    `SELECT * FROM guardrail_configs WHERE org_id=? AND ad_account_id=?`, [orgId, acctId],
  );
  if (!row) throw new Error(`no guardrail_config for account ${acctId}`);
  const mdd = JSON.parse(row.min_data_to_decide as string);
  return {
    maxBudgetIncreasePct: row.max_budget_increase_pct as number,
    minEditIntervalHours: row.min_edit_interval_hours as number,
    minConversionsToEdit: row.min_conversions_to_edit as number,
    minDataToDecide: { spendMinor: mdd.spendMinor, impressions: mdd.impressions, days: mdd.days },
    maxActionsPerCycle: row.max_actions_per_cycle as number,
    cpaPauseMultiplier: row.cpa_pause_multiplier as number,
    monthlyCapMinor: 0, // filled by getAccountContext from ad_accounts
    dailyCapMinor: 0,
  };
}

export function getAccountContext(acctId: string): AccountContext {
  const a = get<AcctRow>(`SELECT * FROM ad_accounts WHERE id=?`, [acctId]);
  if (!a) throw notFound(`no account ${acctId}`);
  const g = getGuardrailConfig(a.org_id, acctId);
  g.monthlyCapMinor = a.monthly_cap_minor;
  g.dailyCapMinor = a.daily_cap_minor;

  const month = get<{ s: number }>(
    `SELECT COALESCE(SUM(spend_minor),0) s FROM metric_snapshots
     WHERE ad_account_id=? AND level='ad_set' AND window_start>=?`,
    [acctId, monthStartIso()],
  );
  const day = get<{ s: number }>(
    `SELECT COALESCE(SUM(spend_minor),0) s FROM metric_snapshots
     WHERE ad_account_id=? AND level='ad_set' AND window_start=?`,
    [acctId, latestWindowStartIso(acctId)],
  );

  return {
    accountDbId: a.id,
    orgId: a.org_id,
    externalId: a.external_account_id,
    platform: a.platform as AccountContext["platform"],
    displayName: a.display_name,
    autonomyLevel: a.autonomy_level as AccountContext["autonomyLevel"],
    targetKpi: a.target_kpi as AccountContext["targetKpi"],
    targetValue: a.target_value,
    conversionTrackingOk: !!a.conversion_tracking_ok,
    status: a.status as AccountContext["status"],
    guardrails: g,
    monthSpendMinor: month?.s ?? 0,
    daySpendMinor: day?.s ?? 0,
  };
}

export function setAccountStatus(acctId: string, status: "connected" | "paused" | "killed"): void {
  run(`UPDATE ad_accounts SET status=? WHERE id=?`, [status, acctId]);
}

// ── Campaign mirror ─────────────────────────────────────────────────────────
export function getCampaignTree(acctId: string): CampaignNode[] {
  const camps = all<Record<string, unknown>>(
    `SELECT * FROM campaigns WHERE ad_account_id=? ORDER BY name`, [acctId],
  );
  return camps.map((c): CampaignNode => {
    const adSets = all<Record<string, unknown>>(
      `SELECT * FROM ad_sets WHERE campaign_id=? ORDER BY name`, [c.id],
    ).map((s): AdSetNode => ({
      externalId: s.external_id as string,
      name: s.name as string,
      budgetMinor: s.budget_minor as number,
      bidStrategy: s.bid_strategy as string,
      status: s.status as string,
      learningStatus: (s.learning_status as AdSetNode["learningStatus"]) ?? "active",
      conversionsInWindow: s.conversions_in_window as number,
      inLearningUntil: (s.in_learning_until as string) ?? null,
      lastEditedAt: (s.last_edited_at as string) ?? null,
      ads: all<Record<string, unknown>>(
        `SELECT * FROM ads WHERE ad_set_id=? ORDER BY name`, [s.id],
      ).map((ad): AdNode => ({
        externalId: ad.external_id as string,
        name: ad.name as string,
        creativeExternalId: ad.creative_id as string,
        status: ad.status as string,
        lastEditedAt: (ad.last_edited_at as string) ?? null,
      })),
    }));
    return {
      externalId: c.external_id as string,
      name: c.name as string,
      objective: c.objective as string,
      status: c.status as string,
      adSets,
    };
  });
}

/** Resolve the internal ad_set/ad row id from an external id (for mirror writes). */
export function findObjectRow(level: ObjectLevel, externalId: string):
  { id: string; orgId: string } | undefined {
  const table = level === "campaign" ? "campaigns" : level === "ad_set" ? "ad_sets" : "ads";
  const r = get<{ id: string; org_id: string }>(
    `SELECT id, org_id FROM ${table} WHERE external_id=?`, [externalId],
  );
  return r ? { id: r.id, orgId: r.org_id } : undefined;
}

// ── Metrics ─────────────────────────────────────────────────────────────────
function mapSnap(r: Record<string, unknown>): MetricSnapshot {
  return {
    level: r.level as ObjectLevel,
    objectExternalId: r.object_external_id as string,
    windowStart: r.window_start as string,
    windowEnd: r.window_end as string,
    spendMinor: r.spend_minor as number,
    impressions: r.impressions as number,
    clicks: r.clicks as number,
    conversions: r.conversions as number,
    ctr: r.ctr as number,
    cpcMinor: r.cpc_minor as number,
    cpmMinor: r.cpm_minor as number,
    cpaMinor: r.cpa_minor as number,
    roas: r.roas as number,
    frequency: r.frequency as number,
    capturedAt: r.captured_at as string,
  };
}

export function getSnapshots(acctId: string, objExtId: string, sinceIso: string): MetricSnapshot[] {
  return all<Record<string, unknown>>(
    `SELECT * FROM metric_snapshots WHERE ad_account_id=? AND object_external_id=? AND window_start>=?
     ORDER BY window_start`, [acctId, objExtId, sinceIso],
  ).map(mapSnap);
}

export function getAccountSnapshots(acctId: string, level: ObjectLevel, sinceIso: string): MetricSnapshot[] {
  return all<Record<string, unknown>>(
    `SELECT * FROM metric_snapshots WHERE ad_account_id=? AND level=? AND window_start>=?
     ORDER BY object_external_id, window_start`, [acctId, level, sinceIso],
  ).map(mapSnap);
}

export interface CreativeTest { id: string; adSetExternalId: string; variantExternalIds: string[]; metric: string; status: string; }
export function getRunningCreativeTests(acctId: string): CreativeTest[] {
  const rows = all<Record<string, unknown>>(
    `SELECT ct.id, ct.variant_ids, ct.metric, ct.status, a.external_id ase
     FROM creative_tests ct JOIN ad_sets a ON a.id = ct.ad_set_id
     WHERE a.org_id IN (SELECT org_id FROM ad_accounts WHERE id=?) AND ct.status='running'`,
    [acctId],
  );
  return rows.map((r) => ({
    id: r.id as string,
    adSetExternalId: r.ase as string,
    variantExternalIds: JSON.parse(r.variant_ids as string),
    metric: r.metric as string,
    status: r.status as string,
  }));
}

// ── Actions / approvals / audit (the spine) ─────────────────────────────────
export function insertAction(orgId: string, acctId: string, a: ProposedAction): void {
  run(
    `INSERT INTO actions
     (id,org_id,ad_account_id,level,target_external_id,target_name,type,payload,rationale,
      evidence,expected_impact,confidence,rollback,guardrail_verdict,guardrail_reasons,
      status,proposed_by_agent,proposed_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      a.id, orgId, acctId, a.level, a.targetExternalId, a.targetName ?? null, a.type,
      JSON.stringify(a.payload), a.rationale, JSON.stringify(a.evidence),
      JSON.stringify(a.expectedImpact), a.confidence, JSON.stringify(a.rollback),
      a.guardrailVerdict ?? null, JSON.stringify(a.guardrailReasons ?? []),
      a.status, a.proposedByAgent ?? "optimizer", nowIso(),
    ],
  );
}

export function updateActionStatus(actionId: string, status: string, patch: Record<string, unknown> = {}): void {
  const cols = Object.keys(patch);
  const sets = ["status=?", ...cols.map((c) => `${c}=?`)].join(", ");
  run(`UPDATE actions SET ${sets} WHERE id=?`, [status, ...cols.map((c) => patch[c]), actionId]);
}

export function getAction(actionId: string): Record<string, unknown> | undefined {
  return get<Record<string, unknown>>(`SELECT * FROM actions WHERE id=?`, [actionId]);
}

export function listActions(acctId: string, statuses?: string[]): Record<string, unknown>[] {
  if (statuses && statuses.length) {
    const q = statuses.map(() => "?").join(",");
    return all(`SELECT * FROM actions WHERE ad_account_id=? AND status IN (${q}) ORDER BY proposed_at DESC`, [acctId, ...statuses]);
  }
  return all(`SELECT * FROM actions WHERE ad_account_id=? ORDER BY proposed_at DESC`, [acctId]);
}

export function insertApproval(orgId: string, actionId: string, decision: "approved" | "rejected", userId: string | null, note: string): void {
  run(
    `INSERT INTO approvals (id,org_id,action_id,decision,decided_by,note,decided_at)
     VALUES (?,?,?,?,?,?,?)`,
    [newId(), orgId, actionId, decision, userId, note, nowIso()],
  );
}

export function audit(
  orgId: string, acctId: string | null, actorType: "agent" | "human" | "system",
  actorId: string | null, actionId: string | null, event: string,
  before: unknown, after: unknown,
): void {
  run(
    `INSERT INTO audit_log (id,org_id,ad_account_id,actor_type,actor_id,action_id,event,before,after,created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [newId(), orgId, acctId, actorType, actorId, actionId, event,
     before == null ? null : JSON.stringify(before),
     after == null ? null : JSON.stringify(after), nowIso()],
  );
}

export function listAudit(acctId: string, limit = 100): Record<string, unknown>[] {
  return all(`SELECT * FROM audit_log WHERE ad_account_id=? ORDER BY created_at DESC LIMIT ?`, [acctId, limit]);
}

// Mirror mutations used by the (dry-run) Media Buyer when an action executes.
export function applyMirrorBudget(externalId: string, newBudgetMinor: number): void {
  run(`UPDATE ad_sets SET budget_minor=?, last_edited_at=? WHERE external_id=?`, [newBudgetMinor, nowIso(), externalId]);
}
export function applyMirrorStatus(level: ObjectLevel, externalId: string, status: string): void {
  const table = level === "ad_set" ? "ad_sets" : level === "ad" ? "ads" : "campaigns";
  run(`UPDATE ${table} SET status=?, last_edited_at=? WHERE external_id=?`, [status, nowIso(), externalId]);
}

export function getDefaultUserId(orgId: string): string | null {
  const r = get<{ user_id: string }>(`SELECT user_id FROM memberships WHERE org_id=? LIMIT 1`, [orgId]);
  return r?.user_id ?? null;
}

/** Account-level daily series for charts: total spend + blended CPA per day. */
export interface DailyPoint { day: string; spendMinor: number; conversions: number; cpaMinor: number; }
export function getAccountDailySeries(acctId: string, days = 14): DailyPoint[] {
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const rows = all<{ day: string; s: number; c: number }>(
    `SELECT substr(window_start,1,10) day, SUM(spend_minor) s, SUM(conversions) c
     FROM metric_snapshots WHERE ad_account_id=? AND level='ad_set' AND window_start>=?
     GROUP BY day ORDER BY day`, [acctId, since],
  );
  return rows.map((r) => ({ day: r.day, spendMinor: r.s, conversions: r.c, cpaMinor: r.c > 0 ? Math.round(r.s / r.c) : 0 }));
}

export function getInsights(): Record<string, unknown>[] {
  return all(`SELECT vertical,platform,pattern_text,confidence,sample_size FROM insights WHERE scope='global' ORDER BY confidence DESC`);
}

// Child rows (audit_log, approvals) reference actions(id), so they must be
// removed before the actions they point at or the FK constraint fails.
const UNDECIDED = "('proposed','queued')";

/** Demo affordance: clear ALL of an account's actions, approvals and audit. */
export function clearAccountActions(acctId: string): void {
  run(`DELETE FROM audit_log WHERE action_id IN (SELECT id FROM actions WHERE ad_account_id=?)`, [acctId]);
  run(`DELETE FROM approvals WHERE action_id IN (SELECT id FROM actions WHERE ad_account_id=?)`, [acctId]);
  run(`DELETE FROM actions WHERE ad_account_id=?`, [acctId]);
}

/** Re-run affordance: clear only UNDECIDED proposals (and their proposal-stage
 *  audit/approvals) so a fresh loop doesn't duplicate them, while preserving
 *  executed/approved/rejected actions and their audit history. */
export function clearUndecidedActions(acctId: string): void {
  const sel = `SELECT id FROM actions WHERE ad_account_id=? AND status IN ${UNDECIDED}`;
  run(`DELETE FROM audit_log WHERE action_id IN (${sel})`, [acctId]);
  run(`DELETE FROM approvals WHERE action_id IN (${sel})`, [acctId]);
  run(`DELETE FROM actions WHERE ad_account_id=? AND status IN ${UNDECIDED}`, [acctId]);
}

export function countByStatus(acctId: string): Record<string, number> {
  const rows = all<{ status: string; n: number }>(
    `SELECT status, COUNT(*) n FROM actions WHERE ad_account_id=? GROUP BY status`, [acctId],
  );
  const out: Record<string, number> = {};
  for (const r of rows) out[r.status] = r.n;
  return out;
}
