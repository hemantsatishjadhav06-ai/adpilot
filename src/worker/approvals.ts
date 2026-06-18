// ── src/worker/approvals.ts ───────────────────────────────────────────────
// Co-pilot approval handling. Approving a queued action routes it to the Media
// Buyer for execution (dry-run here); rejecting closes it out. Both are
// audited. This is the human-in-the-loop half of the ProposedAction spine.

import * as repo from "../db/repo.ts";
import { executeAction } from "../agents/media-buyer.ts";
import { notFound, conflict, blocked } from "../shared/errors.ts";
import { log } from "../shared/logger.ts";

export async function approveAction(actionId: string, note = ""): Promise<{ executed: boolean; dryRun: boolean }> {
  const a = repo.getAction(actionId);
  if (!a) throw notFound(`no action ${actionId}`);
  if (a.status !== "queued") throw conflict(`action is '${a.status}', not 'queued' — cannot approve`);

  const orgId = a.org_id as string;
  const ctx = repo.getAccountContext(a.ad_account_id as string);
  // Refuse approval outright when the kill switch is engaged (the Media Buyer
  // also backstops this at the write boundary).
  if (ctx.status === "killed") {
    repo.audit(orgId, ctx.accountDbId, "system", "guardrail-engine", actionId, "blocked", null, { phase: "approve", reason: "kill switch engaged" });
    throw blocked("account kill switch is engaged — approval refused");
  }

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
  if (!a) throw notFound(`no action ${actionId}`);
  if (!["queued", "proposed"].includes(a.status as string)) {
    throw conflict(`action is '${a.status}' — cannot reject`);
  }
  const orgId = a.org_id as string;
  const userId = repo.getDefaultUserId(orgId);
  repo.insertApproval(orgId, actionId, "rejected", userId, note);
  repo.updateActionStatus(actionId, "rejected", { decided_at: new Date().toISOString() });
  repo.audit(orgId, a.ad_account_id as string, "human", userId, actionId, "rejected", null, { note });
  log.info("action rejected", { actionId, type: a.type });
}
