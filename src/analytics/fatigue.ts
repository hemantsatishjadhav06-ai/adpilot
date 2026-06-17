// ── src/analytics/fatigue.ts ──────────────────────────────────────────────
// Creative fatigue = rising frequency + decaying CTR (Doc 03 §4). Triggers a
// refresh proposal, never a budget cut.

import type { MetricSnapshot } from "../shared/types.ts";
import { meanOf } from "./metrics.ts";

export interface FatigueVerdict {
  fatigued: boolean;
  frequencyLatest: number;
  ctrDropPct: number; // % drop from early-window baseline to recent
  reason: string;
}

export function detectFatigue(snaps: MetricSnapshot[]): FatigueVerdict {
  if (snaps.length < 6) {
    return { fatigued: false, frequencyLatest: snaps.at(-1)?.frequency ?? 0, ctrDropPct: 0, reason: "insufficient history" };
  }
  const head = snaps.slice(0, 3);
  const tail = snaps.slice(-3);
  const earlyCtr = meanOf(head.map((s) => s.ctr));
  const recentCtr = meanOf(tail.map((s) => s.ctr));
  const ctrDropPct = earlyCtr > 0 ? ((earlyCtr - recentCtr) / earlyCtr) * 100 : 0;
  const frequencyLatest = snaps.at(-1)!.frequency;

  const fatigued =
    (frequencyLatest >= 4.5 && ctrDropPct >= 20) || frequencyLatest >= 6 || ctrDropPct >= 40;

  const reason = fatigued
    ? `frequency ${frequencyLatest.toFixed(1)} with CTR down ${ctrDropPct.toFixed(0)}% — creative is saturating its audience`
    : "no fatigue signal";

  return { fatigued, frequencyLatest, ctrDropPct: +ctrDropPct.toFixed(1), reason };
}
