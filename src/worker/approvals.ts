// ── src/worker/approvals.ts ───────────────────────────────────────────────
// Co-pilot approval handling. Approving a queued action routes it to the Media
// Buyer for execution (dry-run here); rejecting closes it out. Both are
// audited. This is the human-in-the-loop half of the ProposedAction spine.

import * as repo from "../db/repo.ts";
import { executeAction } from "../agents/media-buyer.ts";
import { log } from "../shared/logger.ts";

export async function approveAction(actionId: string, note = ""): Promise<{ executed: boolean; dryRun: boolean }> {
  const a = repo.getAction(actionId);
  if (!a) throw new Error(`no action ${actionId}`);
  if (a.status !== "queued") throw new Error(`action ${actionId} is '${a.status}', not 'queued'`);

  const orgId = a.org_id as string;
  const userId = repo.getDefaultUserId(orgId);
  repo.insertApproval(orgId, actionId, "approved", userId, note);
  repo.updateActionStatus(actionId, "approved", { approved_by_user: userId, decided_at: new Date().toISOString() });
  repo.audit(orgId, a.ad_account_id as string, "human", userId, actionId, "approved", null, { note });
  log.info("action approved → executing", { actionId, type: a.type });

  const res = await executeAction(actionId);
  return { executed: res.ok, dryRun: res.dryRun };
}

export function rejectAction(actionId: string, note = ""): void {
  const a = repo.getAction(actionId);
  if (!a) throw new Error(`no action ${actionId}`);
  const orgId = a.org_id as string;
  const userId = repo.getDefaultUserId(orgId);
  repo.insertApproval(orgId, actionId, "rejected", userId, note);
  repo.updateActionStatus(actionId, "rejected", { decided_at: new Date().toISOString() });
  repo.audit(orgId, a.ad_account_id as string, "human", userId, actionId, "rejected", null, { note });
  log.info("action rejected", { actionId, type: a.type });
}
