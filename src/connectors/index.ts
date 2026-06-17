// ── src/connectors/index.ts ───────────────────────────────────────────────
import type { AdConnector } from "./types.ts";
import { MetaMockConnector } from "./meta-mock.ts";

const cache = new Map<string, AdConnector>();

/** Factory: returns the connector for a platform. Google would slot in here
 *  behind the same interface (Doc 07 Phase 4). */
export function getConnector(platform: "meta" | "google"): AdConnector {
  if (platform === "google") throw new Error("Google connector not implemented in v1 (Doc 00 §5: Meta first).");
  let c = cache.get(platform);
  if (!c) { c = new MetaMockConnector(); cache.set(platform, c); }
  return c;
}
