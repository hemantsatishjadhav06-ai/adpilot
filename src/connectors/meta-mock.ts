// ── src/connectors/meta-mock.ts ───────────────────────────────────────────
// Mock Meta connector. The "platform truth" is the seeded SQLite mirror, so
// READ methods return seeded data and WRITE methods run in DRY-RUN: they log
// the exact payload that WOULD be sent, register an idempotency key, and never
// touch a real account. Swap this file for a facebook-nodejs-business-sdk
// implementation to go live — the AdConnector interface is unchanged.

import type { AdConnector, MetricsQuery, WriteResult } from "./types.ts";
import type { AccountState, CampaignTree, MetricSnapshot, ObjectLevel } from "../shared/types.ts";
import { DRY_RUN, RateLimiter, IdempotencyStore } from "./shared.ts";
import { log } from "../shared/logger.ts";
import * as repo from "../db/repo.ts";

export class MetaMockConnector implements AdConnector {
  readonly platform = "meta" as const;
  private limiter = new RateLimiter();
  private idem = new IdempotencyStore();

  private acctDbId(externalId: string): string {
    const a = repo.listAccounts().find((x) => x.external_account_id === externalId);
    if (!a) throw new Error(`unknown account ${externalId}`);
    return a.id;
  }

  async getAccount(externalId: string): Promise<AccountState> {
    this.limiter.take();
    const ctx = repo.getAccountContext(this.acctDbId(externalId));
    return {
      externalId,
      platform: "meta",
      displayName: ctx.displayName,
      status: ctx.status,
      currencyMinorPerUnit: 100,
    };
  }

  async getObjects(externalId: string): Promise<CampaignTree> {
    this.limiter.take();
    const acctId = this.acctDbId(externalId);
    return { account: await this.getAccount(externalId), campaigns: repo.getCampaignTree(acctId) };
  }

  async getMetrics(externalId: string, q: MetricsQuery): Promise<MetricSnapshot[]> {
    this.limiter.take();
    const acctId = this.acctDbId(externalId);
    if (q.objectExternalId) return repo.getSnapshots(acctId, q.objectExternalId, q.sinceIso);
    return repo.getAccountSnapshots(acctId, q.level, q.sinceIso);
  }

  async getTaxonomies(_externalId: string): Promise<{ interests: string[]; geos: string[] }> {
    return { interests: ["fitness", "gym", "bodybuilding", "nutrition", "running"], geos: ["IN", "IN-MH", "IN-KA"] };
  }

  // ── WRITE (dry-run) ───────────────────────────────────────────────────────
  private write(idemKey: string, externalId: string, echo: Record<string, unknown>): WriteResult {
    if (this.idem.has(idemKey)) return this.idem.get(idemKey) as WriteResult;
    if (DRY_RUN) {
      log.warn(`[DRY-RUN] Meta write suppressed`, { externalId, ...echo, idemKey });
    } else {
      // Production: call facebook-nodejs-business-sdk here.
      log.info(`[LIVE] Meta write`, { externalId, ...echo });
    }
    const res: WriteResult = { ok: true, externalId, dryRun: DRY_RUN, idempotencyKey: idemKey, echo };
    this.idem.set(idemKey, res);
    return res;
  }

  async updateBudget(externalId: string, adSetExternalId: string, newBudgetMinor: number, idem: string) {
    return this.write(idem, externalId, { op: "updateBudget", adSetExternalId, newBudgetMinor });
  }
  async updateBid(externalId: string, adSetExternalId: string, newBidMinor: number, idem: string) {
    return this.write(idem, externalId, { op: "updateBid", adSetExternalId, newBidMinor });
  }
  async pause(externalId: string, level: ObjectLevel, objectExternalId: string, idem: string) {
    return this.write(idem, externalId, { op: "pause", level, objectExternalId });
  }
  async enable(externalId: string, level: ObjectLevel, objectExternalId: string, idem: string) {
    return this.write(idem, externalId, { op: "enable", level, objectExternalId });
  }
  async refreshCreative(externalId: string, adExternalId: string, newCreative: Record<string, unknown>, idem: string) {
    return this.write(idem, externalId, { op: "refreshCreative", adExternalId, newCreative });
  }
  async launchTest(externalId: string, adSetExternalId: string, variants: Record<string, unknown>[], idem: string) {
    return this.write(idem, externalId, { op: "launchTest", adSetExternalId, variantCount: variants.length });
  }
}
