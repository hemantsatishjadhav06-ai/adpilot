// ── src/analytics/metrics.ts ──────────────────────────────────────────────
// Derive CTR / CPA / ROAS / frequency over a window from daily snapshots, plus
// trend helpers. Pure functions, no I/O.

import type { MetricSnapshot } from "../shared/types.ts";

export interface WindowSummary {
  spendMinor: number;
  impressions: number;
  clicks: number;
  conversions: number;
  ctr: number; // %
  cpaMinor: number;
  roas: number;
  frequency: number; // mean of daily frequency in window
  days: number;
}

export function summarize(snaps: MetricSnapshot[]): WindowSummary {
  const s = snaps.reduce(
    (acc, x) => {
      acc.spendMinor += x.spendMinor;
      acc.impressions += x.impressions;
      acc.clicks += x.clicks;
      acc.conversions += x.conversions;
      acc.roasW += x.roas * x.spendMinor; // spend-weighted ROAS
      acc.freq += x.frequency;
      return acc;
    },
    { spendMinor: 0, impressions: 0, clicks: 0, conversions: 0, roasW: 0, freq: 0 },
  );
  const ctr = s.impressions > 0 ? (s.clicks / s.impressions) * 100 : 0;
  const cpaMinor = s.conversions > 0 ? Math.round(s.spendMinor / s.conversions) : s.spendMinor;
  const roas = s.spendMinor > 0 ? s.roasW / s.spendMinor : 0;
  const frequency = snaps.length ? s.freq / snaps.length : 0;
  return {
    spendMinor: s.spendMinor, impressions: s.impressions, clicks: s.clicks,
    conversions: s.conversions, ctr: +ctr.toFixed(3), cpaMinor,
    roas: +roas.toFixed(2), frequency: +frequency.toFixed(2), days: snaps.length,
  };
}

/** Trailing window: keep only snapshots within `days` of the most recent. */
export function trailing(snaps: MetricSnapshot[], days: number): MetricSnapshot[] {
  if (!snaps.length) return [];
  const last = new Date(snaps[snaps.length - 1].windowEnd).getTime();
  const cutoff = last - days * 86_400_000;
  return snaps.filter((s) => new Date(s.windowEnd).getTime() > cutoff);
}

/** Normalised slope of a series (per step, relative to mean). */
export function slope(values: number[]): number {
  const n = values.length;
  if (n < 2) return 0;
  const xs = values.map((_, i) => i);
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = values.reduce((a, b) => a + b, 0) / n;
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) { num += (xs[i] - mx) * (values[i] - my); den += (xs[i] - mx) ** 2; }
  const m = den === 0 ? 0 : num / den;
  return my === 0 ? 0 : m / my;
}

export function meanOf(values: number[]): number {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
}
