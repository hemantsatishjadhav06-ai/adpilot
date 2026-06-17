-- ── src/db/schema.sql ─────────────────────────────────────────────────────
-- Faithful SQLite port of Doc 04 (Supabase/Postgres) data model.
-- Multi-tenant: every tenant table carries org_id. SQLite has no Row-Level
-- Security, so org scoping is enforced in code (Doc 04 §11 calls in-code
-- scoping the required backstop even under Postgres RLS). Money is in minor
-- units (paise/cents) as INTEGER — never floats. Times are ISO-8601 text.

PRAGMA foreign_keys = ON;

-- 1. Tenancy & identity ----------------------------------------------------
CREATE TABLE IF NOT EXISTS organizations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  plan TEXT NOT NULL DEFAULT 'trial',
  stripe_customer_id TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS memberships (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  role TEXT NOT NULL DEFAULT 'owner'           -- owner|admin|member
);

-- 2. Ad accounts & connections ---------------------------------------------
CREATE TABLE IF NOT EXISTS ad_accounts (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id),
  platform TEXT NOT NULL,                       -- 'meta' | 'google'
  external_account_id TEXT NOT NULL,            -- act_xxx / customer id
  display_name TEXT NOT NULL,
  autonomy_level TEXT NOT NULL DEFAULT 'copilot',
  monthly_cap_minor INTEGER NOT NULL,
  daily_cap_minor INTEGER NOT NULL,
  target_kpi TEXT NOT NULL,                      -- 'cpa' | 'roas'
  target_value INTEGER NOT NULL,                 -- minor units (cpa) or ratio*100 (roas)
  conversion_tracking_ok INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'connected',      -- connected|paused|killed
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS oauth_connections (
  id TEXT PRIMARY KEY,
  ad_account_id TEXT NOT NULL REFERENCES ad_accounts(id),
  encrypted_access_token TEXT NOT NULL,          -- encrypted at rest (Vault/KMS) in prod
  encrypted_refresh_token TEXT,
  scopes TEXT,
  expires_at TEXT,
  rotated_at TEXT
);

-- 3. Strategy & brief -------------------------------------------------------
CREATE TABLE IF NOT EXISTS briefs (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id),
  ad_account_id TEXT NOT NULL REFERENCES ad_accounts(id),
  product TEXT, offer TEXT, goal TEXT,
  budget_minor INTEGER,
  target_kpi TEXT, target_value INTEGER,
  audience_hints TEXT,                            -- json
  brand_assets TEXT,                              -- json
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS strategies (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id),
  ad_account_id TEXT NOT NULL REFERENCES ad_accounts(id),
  brief_id TEXT REFERENCES briefs(id),
  media_plan TEXT,                                -- json
  kpis TEXT,                                      -- json
  version INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'active',
  created_by_agent TEXT,
  created_at TEXT NOT NULL
);

-- 4. Campaign object mirror -------------------------------------------------
CREATE TABLE IF NOT EXISTS campaigns (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id),
  ad_account_id TEXT NOT NULL REFERENCES ad_accounts(id),
  external_id TEXT NOT NULL,
  name TEXT NOT NULL,
  objective TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  learning_status TEXT,
  last_edited_at TEXT,
  in_learning_until TEXT,
  raw TEXT
);

CREATE TABLE IF NOT EXISTS ad_sets (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id),
  campaign_id TEXT NOT NULL REFERENCES campaigns(id),
  external_id TEXT NOT NULL,
  name TEXT NOT NULL,
  budget_minor INTEGER NOT NULL,
  bid_strategy TEXT,
  targeting TEXT,                                 -- json
  status TEXT NOT NULL DEFAULT 'active',
  learning_status TEXT,                           -- 'learning'|'active'|'limited'
  conversions_in_window INTEGER NOT NULL DEFAULT 0,
  last_edited_at TEXT,
  in_learning_until TEXT,
  raw TEXT
);

CREATE TABLE IF NOT EXISTS ads (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id),
  ad_set_id TEXT NOT NULL REFERENCES ad_sets(id),
  external_id TEXT NOT NULL,
  creative_id TEXT,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  last_edited_at TEXT,
  raw TEXT
);

-- 5. Creative ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS creatives (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id),
  ad_account_id TEXT NOT NULL REFERENCES ad_accounts(id),
  format TEXT,                                    -- 'image'|'video'|'text'
  headline TEXT, primary_text TEXT, cta TEXT, angle TEXT, hook TEXT,
  asset_url TEXT,
  source TEXT,                                    -- 'generated'|'uploaded'
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS creative_tests (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id),
  ad_set_id TEXT NOT NULL REFERENCES ad_sets(id),
  variant_ids TEXT,                               -- json array of ad external ids
  metric TEXT,
  winner_id TEXT,
  significance REAL,
  decided_at TEXT,
  status TEXT NOT NULL DEFAULT 'running'
);

-- 6. Metrics (time-series) --------------------------------------------------
CREATE TABLE IF NOT EXISTS metric_snapshots (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id),
  ad_account_id TEXT NOT NULL REFERENCES ad_accounts(id),
  level TEXT NOT NULL,                            -- 'campaign'|'ad_set'|'ad'
  object_external_id TEXT NOT NULL,
  window_start TEXT NOT NULL,
  window_end TEXT NOT NULL,
  spend_minor INTEGER NOT NULL,
  impressions INTEGER NOT NULL,
  clicks INTEGER NOT NULL,
  conversions INTEGER NOT NULL,
  ctr REAL, cpc_minor INTEGER, cpm_minor INTEGER,
  cpa_minor INTEGER, roas REAL, frequency REAL,
  captured_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_snap_obj
  ON metric_snapshots(org_id, object_external_id, window_end);

-- 7. Actions, approvals, audit (the spine) ----------------------------------
CREATE TABLE IF NOT EXISTS actions (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id),
  ad_account_id TEXT NOT NULL REFERENCES ad_accounts(id),
  level TEXT NOT NULL,
  target_external_id TEXT NOT NULL,
  target_name TEXT,
  type TEXT NOT NULL,
  payload TEXT,                                   -- json
  rationale TEXT,
  evidence TEXT,                                  -- json
  expected_impact TEXT,                           -- json
  confidence REAL,
  rollback TEXT,                                  -- json
  guardrail_verdict TEXT,                         -- 'allow'|'modify'|'block'
  guardrail_reasons TEXT,                         -- json
  status TEXT NOT NULL,                           -- proposed→queued→approved→executed→...
  proposed_by_agent TEXT,
  approved_by_user TEXT REFERENCES users(id),
  proposed_at TEXT, decided_at TEXT, executed_at TEXT, verified_at TEXT,
  result TEXT                                      -- json: did expected impact materialise?
);

CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id),
  action_id TEXT NOT NULL REFERENCES actions(id),
  decision TEXT NOT NULL,                          -- 'approved'|'rejected'
  decided_by TEXT REFERENCES users(id),
  note TEXT,
  decided_at TEXT NOT NULL
);

-- APPEND ONLY (in prod: revoke UPDATE/DELETE). One row per lifecycle event.
CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id),
  ad_account_id TEXT REFERENCES ad_accounts(id),
  actor_type TEXT NOT NULL,                        -- 'agent'|'human'|'system'
  actor_id TEXT,
  action_id TEXT REFERENCES actions(id),
  event TEXT NOT NULL,                             -- proposed|approved|executed|rolled_back|blocked|...
  before TEXT, after TEXT,                         -- json
  created_at TEXT NOT NULL
);

-- 8. Guardrail config -------------------------------------------------------
CREATE TABLE IF NOT EXISTS guardrail_configs (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id),
  ad_account_id TEXT NOT NULL REFERENCES ad_accounts(id),
  max_budget_increase_pct INTEGER NOT NULL DEFAULT 25,
  min_edit_interval_hours INTEGER NOT NULL DEFAULT 36,
  min_conversions_to_edit INTEGER NOT NULL DEFAULT 50,
  min_data_to_decide TEXT NOT NULL,               -- json {spendMinor,impressions,days}
  max_actions_per_cycle INTEGER NOT NULL DEFAULT 5,
  cpa_pause_multiplier INTEGER NOT NULL DEFAULT 3,
  updated_at TEXT NOT NULL
);

-- 9. Cross-account learning (the flywheel) — anonymised, NO org_id ----------
CREATE TABLE IF NOT EXISTS insights (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL DEFAULT 'global',           -- 'global' only; anonymised patterns
  vertical TEXT, platform TEXT,
  pattern_text TEXT NOT NULL,
  evidence_summary TEXT,                           -- json
  embedding TEXT,                                  -- json float[] (pgvector in prod)
  confidence REAL, sample_size INTEGER,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);

-- 10. Billing ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS subscriptions (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id),
  stripe_subscription_id TEXT, plan TEXT, status TEXT, current_period_end TEXT
);

CREATE TABLE IF NOT EXISTS usage_records (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id),
  ad_account_id TEXT REFERENCES ad_accounts(id),
  period TEXT, ad_spend_minor INTEGER, llm_cost_minor INTEGER
);
