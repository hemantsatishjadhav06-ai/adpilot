// ── src/analytics/significance.ts ─────────────────────────────────────────
// Bayesian Beta-Binomial P(A>B) for creative/audience A/B comparisons
// (Doc 03 §4). Prefer Bayesian over fixed-horizon p-values to avoid the
// "peeking" problem of checking every loop. Plus a data-sufficiency gate:
// declare a winner only at P(A>B) >= threshold AND a minimum sample.
//
// In production this graduates to the FastAPI scipy/statsmodels service
// (Doc 01 §3 / Doc 03 §4). The GATES matter more than the exact test, and the
// gates are encoded here from day one.

// Deterministic PRNG (seeded) so verdicts are reproducible across loop runs.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randn(rng: () => number): number {
  // Box–Muller
  let u = 0, v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// Marsaglia–Tsang gamma sampler (alpha >= 1; here alpha = 1 + successes >= 1).
function gammaSample(alpha: number, rng: () => number): number {
  const d = alpha - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x = 0, v = 0;
    do { x = randn(rng); v = 1 + c * x; } while (v <= 0);
    v = v * v * v;
    const u = rng();
    if (u < 1 - 0.0331 * x ** 4) return d * v;
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}

function betaSample(a: number, b: number, rng: () => number): number {
  const x = gammaSample(a, rng);
  const y = gammaSample(b, rng);
  return x / (x + y);
}

export interface ABVerdict {
  pAbeatsB: number; // posterior P(rate_A > rate_B)
  rateA: number;
  rateB: number;
  liftPct: number; // (rateA - rateB)/rateB
  minSampleMet: boolean;
  significant: boolean; // pAbeatsB >= threshold AND minSampleMet
}

/**
 * @param aSucc successes for A (e.g. conversions), aTrials trials (e.g. clicks)
 * Uniform Beta(1,1) prior. Monte-Carlo posterior comparison.
 */
export function betaBinomial(
  aSucc: number, aTrials: number, bSucc: number, bTrials: number,
  opts: { threshold?: number; minTrials?: number; minSucc?: number; iters?: number } = {},
): ABVerdict {
  const threshold = opts.threshold ?? 0.95;
  const minTrials = opts.minTrials ?? 300;
  const minSucc = opts.minSucc ?? 25;
  const iters = opts.iters ?? 20000;

  const seed = (aSucc * 73856093) ^ (aTrials * 19349663) ^ (bSucc * 83492791) ^ (bTrials * 2654435761);
  const rng = mulberry32(seed);

  let wins = 0;
  for (let i = 0; i < iters; i++) {
    const ra = betaSample(1 + aSucc, 1 + (aTrials - aSucc), rng);
    const rb = betaSample(1 + bSucc, 1 + (bTrials - bSucc), rng);
    if (ra > rb) wins++;
  }
  const pAbeatsB = wins / iters;
  const rateA = aTrials > 0 ? aSucc / aTrials : 0;
  const rateB = bTrials > 0 ? bSucc / bTrials : 0;
  const minSampleMet =
    aTrials >= minTrials && bTrials >= minTrials && aSucc + bSucc >= minSucc;
  return {
    pAbeatsB: +pAbeatsB.toFixed(4),
    rateA: +rateA.toFixed(4),
    rateB: +rateB.toFixed(4),
    liftPct: rateB > 0 ? +(((rateA - rateB) / rateB) * 100).toFixed(1) : 0,
    minSampleMet,
    significant: pAbeatsB >= threshold && minSampleMet,
  };
}
