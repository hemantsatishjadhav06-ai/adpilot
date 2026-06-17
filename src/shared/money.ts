// ── src/shared/money.ts ───────────────────────────────────────────────────
// Money is stored in MINOR units (paise/cents) as integers — never floats
// (Doc 04). These helpers are the only place that crosses the minor↔major
// boundary.

export type Minor = number; // integer minor units (paise / cents)

export const toMinor = (major: number): Minor => Math.round(major * 100);
export const toMajor = (minor: Minor): number => minor / 100;

/** Format minor units as an INR string, e.g. 3050000 -> "₹30,500". */
export function fmtINR(minor: Minor): string {
  return "₹" + Math.round(toMajor(minor)).toLocaleString("en-IN");
}

/** Apply a percentage delta to a minor amount, rounding to integer minor. */
export function applyPct(minor: Minor, pct: number): Minor {
  return Math.round(minor * (1 + pct / 100));
}

/** Percentage increase from `from` to `to` (e.g. 100 -> 120 = 20). */
export function pctIncrease(from: Minor, to: Minor): number {
  if (from === 0) return Infinity;
  return ((to - from) / from) * 100;
}
