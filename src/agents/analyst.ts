// ── src/agents/analyst.ts ─────────────────────────────────────────────────
// OBSERVE + ORIENT (Doc 03 §1). Reads metrics via the connector (read-only),
// derives CTR/CPA/ROAS/frequency over the trailing window, flags anomalies and
// creative fatigue, and runs each creative test to a significance verdict.
// Returns typed JSON only — never prose the next step has to parse (Doc 02 §3).

import type { AccountContext } from "../shared/types.ts";
import type { AdConnector } from "../connectors/types.ts";
import { summarize, trailing, type WindowSummary } from "../analytics/metrics.ts";
import { detectFatigue, type FatigueVerdict } from "../analytics/fatigue.ts";
import { betaBinomial, type ABVerdict } from "../analytics/significance.ts";
import * as repo from "../db/repo.ts";

const WINDOW_DAYS = 7;
const LOOKBACK_DAYS = 14;

export interface AdSetAnalysis {
  externalId: string;
  name: string;
  budgetMinor: number;
  learningStatus: "learning" | "active" | "limited";
  inLearningUntil: string | null;
  conversionsInWindow: number;
  lastEditedAt: string | null;
  window: WindowSummary;
  recentCpaMinor: number; // trailing 3 days
  targetCpaMinor: number;
  cpaRatio: number; // window CPA / target
  isAnomaly: boolean;
}

export interface AdAnalysis {
  externalId: string;
  name: string;
  adSetExternalId: string;
  window: WindowSummary;
  fatigue: FatigueVerdict;
}

export interface TestAnalysis {
  adSetExternalId: string;
  metric: string;
  variantAExternalId: string;
  variantBExternalId: string;
  verdict: ABVerdict;
  winnerExternalId: string | null;
  loserExternalId: string | null;
}

export interface AnalystReport {
  accountExternalId: string;
  generatedAt: string;
  conversionTrackingOk: boolean;
  adSets: AdSetAnalysis[];
  ads: AdAnalysis[];
  tests: TestAnalysis[];
}

function sinceIso(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString();
}

export async function analyzeAccount(ctx: AccountContext, connector: AdConnector): Promise<AnalystReport> {
  const ext = ctx.externalId;
  const tree = await connector.getObjects(ext);
  const target = ctx.targetValue; // cpa target in minor units

  // Build ad → ad_set lookup from the mirror tree.
  const adToAdSet = new Map<string, string>();
  for (const c of tree.campaigns)
    for (const s of c.adSets)
      for (const a of s.ads) adToAdSet.set(a.externalId, s.externalId);

  // ── Ad sets ───────────────────────────────────────────────────────────
  const adSets: AdSetAnalysis[] = [];
  for (const c of tree.campaigns) {
    for (const s of c.adSets) {
      const snaps = await connector.getMetrics(ext, {
        level: "ad_set", objectExternalId: s.externalId, sinceIso: sinceIso(LOOKBACK_DAYS),
      });
      const win = summarize(trailing(snaps, WINDOW_DAYS));
      const recent = summarize(trailing(snaps, 3));
      const cpaRatio = target > 0 ? win.cpaMinor / target : 0;
      const isAnomaly =
        win.cpaMinor > ctx.guardrails.cpaPauseMultiplier * target &&
        recent.cpaMinor > ctx.guardrails.cpaPauseMultiplier * target; // sustained
      adSets.push({
        externalId: s.externalId,
        name: s.name,
        budgetMinor: s.budgetMinor,
        learningStatus: s.learningStatus,
        inLearningUntil: s.inLearningUntil,
        conversionsInWindow: s.conversionsInWindow,
        lastEditedAt: s.lastEditedAt,
        window: win,
        recentCpaMinor: recent.cpaMinor,
        targetCpaMinor: target,
        cpaRatio: +cpaRatio.toFixed(2),
        isAnomaly,
      });
    }
  }

  // ── Ads (fatigue) ───────────────────────────────────────────────────────
  const ads: AdAnalysis[] = [];
  for (const [adExt, adSetExt] of adToAdSet) {
    const snaps = await connector.getMetrics(ext, {
      level: "ad", objectExternalId: adExt, sinceIso: sinceIso(LOOKBACK_DAYS),
    });
    if (!snaps.length) continue; // not every ad has its own daily series in the seed
    const adNode = tree.campaigns.flatMap((c) => c.adSets).flatMap((s) => s.ads).find((a) => a.externalId === adExt)!;
    ads.push({
      externalId: adExt,
      name: adNode.name,
      adSetExternalId: adSetExt,
      window: summarize(trailing(snaps, WINDOW_DAYS)),
      fatigue: detectFatigue(snaps),
    });
  }

  // ── Creative tests → significance verdict ────────────────────────────────
  const tests: TestAnalysis[] = [];
  for (const t of repo.getRunningCreativeTests(ctx.accountDbId)) {
    const [aExt, bExt] = t.variantExternalIds;
    const a = ads.find((x) => x.externalId === aExt);
    const b = ads.find((x) => x.externalId === bExt);
    if (!a || !b) continue;
    // CVR test: conversions (successes) per click (trials).
    const verdict = betaBinomial(
      a.window.conversions, a.window.clicks, b.window.conversions, b.window.clicks,
    );
    let winner: string | null = null, loser: string | null = null;
    if (verdict.significant) {
      if (verdict.rateA >= verdict.rateB) { winner = aExt; loser = bExt; }
      else { winner = bExt; loser = aExt; }
    }
    tests.push({
      adSetExternalId: t.adSetExternalId, metric: t.metric,
      variantAExternalId: aExt, variantBExternalId: bExt, verdict, winnerExternalId: winner, loserExternalId: loser,
    });
  }

  return {
    accountExternalId: ext,
    generatedAt: new Date().toISOString(),
    conversionTrackingOk: ctx.conversionTrackingOk,
    adSets, ads, tests,
  };
}
