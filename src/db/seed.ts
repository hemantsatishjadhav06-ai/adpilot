// ── src/db/seed.ts ────────────────────────────────────────────────────────
// Seeds a realistic Meta TEST account (no live spend). Hand-tuned scenarios so
// the OODA loop produces a rich, varied proposal set and every guardrail path
// (allow / modify / block / blast-radius defer / pause-on-anomaly) is exercised.
//
// Run: npm run seed

import { resetSchema, run, newId, nowIso } from "./client.ts";
import { toMinor } from "../shared/money.ts";
import { log, banner } from "../shared/logger.ts";

// Deterministic PRNG so the seed (and therefore the demo) is reproducible.
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rnd = mulberry32(20260617);
const jitter = (v: number, pct: number) => v * (1 + (rnd() * 2 - 1) * pct);

const DAY_MS = 86_400_000;
const TODAY = new Date("2026-06-17T00:00:00.000Z").getTime();
const dayStart = (daysAgo: number) => new Date(TODAY - daysAgo * DAY_MS).toISOString();
const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();
const daysAgoIso = (d: number) => new Date(Date.now() - d * DAY_MS).toISOString();
const inDays = (d: number) => new Date(Date.now() + d * DAY_MS).toISOString();

interface SnapProfile {
  spendPerDay: number; // major (₹)
  cpa: number; // major (₹)
  roas: number;
  ctrStart: number; // %
  ctrEnd: number; // %
  freqStart: number;
  freqEnd: number;
  imprPerDay: number;
  days: number; // how many days of history
}

// Insert daily metric_snapshots for one object, interpolating the trend.
function seedSnapshots(
  orgId: string,
  accountId: string,
  level: string,
  objExtId: string,
  p: SnapProfile,
): void {
  for (let i = p.days; i >= 1; i--) {
    const t = (p.days - i) / Math.max(1, p.days - 1); // 0..1 across history
    const ctr = p.ctrStart + (p.ctrEnd - p.ctrStart) * t;
    const freq = p.freqStart + (p.freqEnd - p.freqStart) * t;
    const impressions = Math.round(jitter(p.imprPerDay, 0.06));
    const clicks = Math.max(1, Math.round((impressions * ctr) / 100));
    const spendMinor = Math.round(jitter(toMinor(p.spendPerDay), 0.05));
    const conversions = Math.max(0, Math.round(spendMinor / toMinor(p.cpa)));
    const cpaMinor = conversions > 0 ? Math.round(spendMinor / conversions) : spendMinor;
    const cpcMinor = Math.round(spendMinor / clicks);
    const cpmMinor = Math.round((spendMinor / impressions) * 1000);
    run(
      `INSERT INTO metric_snapshots
       (id,org_id,ad_account_id,level,object_external_id,window_start,window_end,
        spend_minor,impressions,clicks,conversions,ctr,cpc_minor,cpm_minor,cpa_minor,roas,frequency,captured_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        newId(), orgId, accountId, level, objExtId,
        dayStart(i), dayStart(i - 1),
        spendMinor, impressions, clicks, conversions,
        +ctr.toFixed(3), cpcMinor, cpmMinor, cpaMinor,
        +jitter(p.roas, 0.05).toFixed(2), +freq.toFixed(2), dayStart(i - 1),
      ],
    );
  }
}

export function seed(): void {
  banner("SEED — Meta test account 'Acme Fitness D2C'");
  resetSchema();
  const now = nowIso();

  // ── Tenancy ──────────────────────────────────────────────────────────
  const orgId = newId();
  run(`INSERT INTO organizations (id,name,plan,created_at) VALUES (?,?,?,?)`, [
    orgId, "Acme Growth Co", "pro", now,
  ]);
  const userId = newId();
  run(`INSERT INTO users (id,email,created_at) VALUES (?,?,?)`, [
    userId, "owner@acme.example", now,
  ]);
  run(`INSERT INTO memberships (id,org_id,user_id,role) VALUES (?,?,?,?)`, [
    newId(), orgId, userId, "owner",
  ]);

  // ── Ad account (Meta, Co-pilot, conversion tracking verified) ─────────
  const acctId = newId();
  const TARGET_CPA = toMinor(300); // ₹300
  run(
    `INSERT INTO ad_accounts
     (id,org_id,platform,external_account_id,display_name,autonomy_level,
      monthly_cap_minor,daily_cap_minor,target_kpi,target_value,
      conversion_tracking_ok,status,created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      acctId, orgId, "meta", "act_889921", "Acme Fitness D2C",
      "copilot", toMinor(500_000), toMinor(25_000), "cpa", TARGET_CPA,
      1, "connected", now,
    ],
  );
  run(
    `INSERT INTO oauth_connections (id,ad_account_id,encrypted_access_token,scopes,expires_at,rotated_at)
     VALUES (?,?,?,?,?,?)`,
    [newId(), acctId, "enc::dryrun-token::act_889921", "ads_read,ads_management", inDays(45), now],
  );

  // ── Guardrail config (sensible defaults, Doc 04 §8) ───────────────────
  run(
    `INSERT INTO guardrail_configs
     (id,org_id,ad_account_id,max_budget_increase_pct,min_edit_interval_hours,
      min_conversions_to_edit,min_data_to_decide,max_actions_per_cycle,
      cpa_pause_multiplier,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [
      newId(), orgId, acctId, 25, 36, 50,
      JSON.stringify({ spendMinor: toMinor(5000), impressions: 5000, days: 3 }),
      5, 3, now,
    ],
  );

  // ── Brief + strategy (Intake/Strategy agent output, seeded) ───────────
  const briefId = newId();
  run(
    `INSERT INTO briefs (id,org_id,ad_account_id,product,offer,goal,budget_minor,
      target_kpi,target_value,audience_hints,brand_assets,created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      briefId, orgId, acctId, "Acme Whey Protein", "₹500 off first order",
      "purchases", toMinor(500_000), "cpa", TARGET_CPA,
      JSON.stringify({ interests: ["fitness", "gym", "bodybuilding"], age: "22-40" }),
      JSON.stringify({ logo: "acme-logo.png", palette: ["#0F172A", "#22C55E"] }), now,
    ],
  );
  run(
    `INSERT INTO strategies (id,org_id,ad_account_id,brief_id,media_plan,kpis,version,status,created_by_agent,created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [
      newId(), orgId, acctId, briefId,
      JSON.stringify({ platform: "meta", structure: "1 campaign / 5 ad sets", split: "prospecting 70% / retargeting 30%" }),
      JSON.stringify({ primary: "cpa<=300", secondary: "roas>=2.5" }),
      1, "active", "intake-strategy", now,
    ],
  );

  // ── Campaign + ad sets + ads (local mirror, Doc 04 §4) ────────────────
  const campId = newId();
  const campExt = "23851000001";
  run(
    `INSERT INTO campaigns (id,org_id,ad_account_id,external_id,name,objective,status,learning_status,last_edited_at,raw)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [campId, orgId, acctId, campExt, "Acme Fitness — Conversions", "OUTCOME_SALES", "active", "active", daysAgoIso(9), "{}"],
  );

  const adSet = (
    ext: string, name: string, budgetMajor: number, learning: string,
    convWindow: number, lastEditedIso: string, inLearningUntil: string | null,
  ) => {
    const id = newId();
    run(
      `INSERT INTO ad_sets (id,org_id,campaign_id,external_id,name,budget_minor,bid_strategy,
        targeting,status,learning_status,conversions_in_window,last_edited_at,in_learning_until,raw)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        id, orgId, campId, ext, name, toMinor(budgetMajor), "lowest_cost",
        JSON.stringify({ geo: "IN", age: "22-40" }), "active", learning,
        convWindow, lastEditedIso, inLearningUntil, "{}",
      ],
    );
    return { id, ext };
  };

  const ad = (adSetId: string, ext: string, name: string, creativeExt: string, lastEditedIso: string) => {
    run(
      `INSERT INTO ads (id,org_id,ad_set_id,external_id,creative_id,name,status,last_edited_at,raw)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [newId(), orgId, adSetId, ext, creativeExt, name, "active", lastEditedIso, "{}"],
    );
  };

  const creative = (ext: string, headline: string, hook: string, angle: string, fmt: string) => {
    run(
      `INSERT INTO creatives (id,org_id,ad_account_id,format,headline,primary_text,cta,angle,hook,asset_url,source,status,created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [ext, orgId, acctId, fmt, headline, headline + " — shop now.", "SHOP_NOW", angle, hook, "https://cdn.example/" + ext + ".jpg", "generated", "active", now],
    );
  };

  // 1) WINNER — scalable. CPA ₹205 (target ₹300), stable, plenty of conversions.
  const asWin = adSet("AS_LAL_1PCT", "Lookalike 1% — Purchasers", 4000, "active", 140, daysAgoIso(6), null);
  seedSnapshots(orgId, acctId, "ad_set", asWin.ext, {
    spendPerDay: 4000, cpa: 205, roas: 3.9, ctrStart: 2.0, ctrEnd: 2.05, freqStart: 2.4, freqEnd: 2.7, imprPerDay: 36000, days: 14,
  });
  creative("CR_LAL_A", "Fuel your gains", "stat", "authority", "image");
  ad(asWin.id, "AD_LAL_A", "LAL — Fuel your gains", "CR_LAL_A", daysAgoIso(6));

  // 2) LOSER (moderate) — CPA ₹560 ≈ 1.87× target. Reduce budget.
  const asBroad = adSet("AS_BROAD_COLD", "Broad — Cold", 5000, "active", 95, daysAgoIso(4), null);
  seedSnapshots(orgId, acctId, "ad_set", asBroad.ext, {
    spendPerDay: 5000, cpa: 560, roas: 1.25, ctrStart: 1.4, ctrEnd: 1.35, freqStart: 2.0, freqEnd: 2.3, imprPerDay: 40000, days: 14,
  });
  creative("CR_BROAD_A", "Try Acme Whey", "question", "aspiration", "image");
  ad(asBroad.id, "AD_BROAD_A", "Broad — Try Acme Whey", "CR_BROAD_A", daysAgoIso(4));

  // 3) ANOMALY — CPA ₹1020 ≈ 3.4× target, sustained. Pause-on-anomaly.
  const asRetarget = adSet("AS_RETARGET_7D", "Retargeting 7d", 3000, "active", 60, daysAgoIso(3), null);
  seedSnapshots(orgId, acctId, "ad_set", asRetarget.ext, {
    spendPerDay: 3000, cpa: 1020, roas: 0.7, ctrStart: 1.1, ctrEnd: 0.95, freqStart: 4.0, freqEnd: 6.6, imprPerDay: 18000, days: 14,
  });
  creative("CR_RT_A", "Come back — 20% off", "scarcity", "scarcity", "image");
  ad(asRetarget.id, "AD_RT_A", "Retarget — Come back", "CR_RT_A", daysAgoIso(3));

  // 4) CREATIVE TEST + FATIGUE inside one ad set.
  const asInterest = adSet("AS_INTEREST_FIT", "Interest — Fitness Enthusiasts", 3500, "active", 110, daysAgoIso(5), null);
  seedSnapshots(orgId, acctId, "ad_set", asInterest.ext, {
    spendPerDay: 3500, cpa: 290, roas: 2.6, ctrStart: 1.8, ctrEnd: 1.75, freqStart: 3.0, freqEnd: 3.3, imprPerDay: 30000, days: 14,
  });
  // 4a) Test winner (high CVR)
  creative("CR_UGC_A", "Real results in 30 days", "pattern-interrupt", "social_proof", "image");
  ad(asInterest.id, "AD_UGC_A", "UGC Hook A — Real results", "CR_UGC_A", daysAgoIso(5));
  seedSnapshots(orgId, acctId, "ad", "AD_UGC_A", {
    spendPerDay: 1700, cpa: 160, roas: 4.4, ctrStart: 2.4, ctrEnd: 2.5, freqStart: 2.6, freqEnd: 2.9, imprPerDay: 5400, days: 14,
  });
  // 4b) Test loser (low CVR)
  creative("CR_STATIC_B", "Premium whey protein", "bold-claim", "authority", "image");
  ad(asInterest.id, "AD_STATIC_B", "Static B — Premium whey", "CR_STATIC_B", daysAgoIso(5));
  seedSnapshots(orgId, acctId, "ad", "AD_STATIC_B", {
    spendPerDay: 1300, cpa: 360, roas: 2.0, ctrStart: 1.15, ctrEnd: 1.1, freqStart: 2.8, freqEnd: 3.1, imprPerDay: 8000, days: 14,
  });
  // 4c) Fatiguing creative (freq ↑, CTR ↓)
  creative("CR_CAROUSEL_C", "5 reasons athletes choose Acme", "stat", "authority", "image");
  ad(asInterest.id, "AD_CAROUSEL_C", "Carousel C — 5 reasons", "CR_CAROUSEL_C", daysAgoIso(11));
  seedSnapshots(orgId, acctId, "ad", "AD_CAROUSEL_C", {
    spendPerDay: 700, cpa: 410, roas: 1.6, ctrStart: 2.3, ctrEnd: 1.15, freqStart: 2.0, freqEnd: 5.3, imprPerDay: 9000, days: 14,
  });
  // Record the running creative test (Analyst will read it to a verdict).
  run(
    `INSERT INTO creative_tests (id,org_id,ad_set_id,variant_ids,metric,status)
     VALUES (?,?,?,?,?,?)`,
    [newId(), orgId, asInterest.id, JSON.stringify(["AD_UGC_A", "AD_STATIC_B"]), "cvr", "running"],
  );

  // 5) LEARNING-PHASE set — high CPA but locked. Guardrail must BLOCK edits.
  const asNew = adSet("AS_NEW_TEST", "New Test — June Angles", 2500, "learning", 22, hoursAgo(8), inDays(2));
  seedSnapshots(orgId, acctId, "ad_set", asNew.ext, {
    spendPerDay: 2500, cpa: 470, roas: 1.4, ctrStart: 1.6, ctrEnd: 1.55, freqStart: 1.6, freqEnd: 1.9, imprPerDay: 22000, days: 5,
  });
  creative("CR_NEW_A", "New: Acme Whey Zero", "bold-claim", "aspiration", "image");
  ad(asNew.id, "AD_NEW_A", "New — Acme Whey Zero", "CR_NEW_A", hoursAgo(8));

  // ── Cross-account flywheel priors (anonymised, global — Doc 04 §9) ─────
  const insight = (vertical: string, platform: string, text: string, conf: number, n: number) =>
    run(
      `INSERT INTO insights (id,scope,vertical,platform,pattern_text,evidence_summary,embedding,confidence,sample_size,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [newId(), "global", vertical, platform, text, JSON.stringify({ accounts: n }), JSON.stringify([]), conf, n, now, now],
    );
  insight("fitness_d2c", "meta", "Short UGC 'pattern-interrupt' hooks beat static authority claims below ₹300 CPA.", 0.82, 37);
  insight("fitness_d2c", "meta", "Retargeting frequency above ~5 correlates with sharp CPA decay; refresh before scaling.", 0.78, 52);
  insight("fitness_d2c", "meta", "1% lookalikes off purchaser seed outperform broad cold by ~40% on CPA in first 30 days.", 0.8, 44);

  log.info("Seed complete", {
    org: "Acme Growth Co",
    account: "Acme Fitness D2C (act_889921)",
    adSets: 5,
    ads: 6,
    snapshots: "14-day daily series per object",
  });
}

// Auto-run only when invoked directly (npm run seed / demo), not on import.
if (import.meta.filename === process.argv[1]) seed();
