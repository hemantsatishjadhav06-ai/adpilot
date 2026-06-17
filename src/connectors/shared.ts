// ── src/connectors/shared.ts ──────────────────────────────────────────────
// Cross-cutting connector concerns, implemented once (Doc 06 §3): rate-limit
// token bucket, exponential backoff w/ jitter, idempotency registry, dry-run
// switch. In production these wrap the real Meta/Google SDK calls.

export const DRY_RUN = (process.env.ADPILOT_DRY_RUN ?? "1") !== "0";

/** Simple token-bucket limiter (per app+account in prod). */
export class RateLimiter {
  private tokens: number;
  private readonly capacity: number;
  private readonly refillPerSec: number;
  private last: number;
  constructor(capacity = 30, refillPerSec = 10) {
    this.capacity = capacity;
    this.tokens = capacity;
    this.refillPerSec = refillPerSec;
    this.last = Date.now();
  }
  take(): boolean {
    const now = Date.now();
    this.tokens = Math.min(this.capacity, this.tokens + ((now - this.last) / 1000) * this.refillPerSec);
    this.last = now;
    if (this.tokens >= 1) { this.tokens -= 1; return true; }
    return false;
  }
}

/** Idempotency: a write with a key seen before returns the prior result. */
export class IdempotencyStore {
  private seen = new Map<string, unknown>();
  has(key: string): boolean { return this.seen.has(key); }
  get(key: string): unknown { return this.seen.get(key); }
  set(key: string, value: unknown): void { this.seen.set(key, value); }
}

export function backoffMs(attempt: number): number {
  const base = Math.min(2000, 100 * 2 ** attempt);
  return base + Math.random() * 100;
}
