// ── scripts/test.ts ───────────────────────────────────────────────────────
// Invariant test suite (no framework, no deps). Resets a fresh DB, runs the
// loop, and asserts the safety + behaviour guarantees the product depends on.
// Run: npm test    Exits non-zero on any failure (CI gate).

import { seed } from "../src/db/seed.ts";
import * as repo from "../src/db/repo.ts";
import { runLoop } from "../src/agents/orchestrator.ts";
import { approveAction, rejectAction } from "../src/worker/approvals.ts";
import { executeAction } from "../src/agents/media-buyer.ts";
import { evaluate } from "../src/guardrails/engine.ts";
import { applyPct } from "../src/shared/money.ts";
import type { ProposedAction } from "../src/shared/types.ts";
import type { ObjectGuardState } from "../src/guardrails/types.ts";

let fail = 0;
const check = (name: string, cond: boolean, detail = ""): void => {
  console.log(`${cond ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m"}  ${name}${detail ? "  — " + detail : ""}`);
  if (!cond) fail++;
};
async function throwsAsync(fn: () => Promise<unknown>): Promise<Error | null> {
  try { await fn(); return null; } catch (e) { return e as Error; }
}

console.log("\n── AdPilot invariant tests ───────────────────────────────");
seed();
const acct = repo.listAccounts()[0];
const sum = await runLoop(acct.id);

// 1) The OODA loop produces the expected guardrail mix.
check("loop yields 5 queued / 1 modified / 1 blocked / 1 deferred",
  sum.queued === 5 && sum.modified === 1 && sum.blocked === 1 && sum.deferred === 1,
  `got q=${sum.queued} m=${sum.modified} b=${sum.blocked} d=${sum.deferred}`);

// 2) Double-approve is rejected with a 409-class error.
const q0 = repo.listActions(acct.id, ["queued"])[0].id as string;
await approveAction(q0, "first");
const dbl = await throwsAsync(() => approveAction(q0, "second"));
check("double-approve rejected", !!dbl && (dbl as { status?: number }).status === 409, dbl ? dbl.message : "no throw");

// 3) SAFETY: kill switch blocks approval (and execution).
repo.setAccountStatus(acct.id, "killed");
const kId = repo.listActions(acct.id, ["queued"])[0].id as string;
const killErr = await throwsAsync(() => approveAction(kId, "while killed"));
const kStatus = repo.getAction(kId)?.status as string;
check("kill switch blocks approval", !!killErr && kStatus !== "executed", `status='${kStatus}'`);

// 4) SAFETY backstop: Media Buyer refuses to execute directly while killed.
const beErr = await throwsAsync(() => executeAction(kId));
check("media-buyer backstop blocks execute while killed", !!beErr && repo.getAction(kId)?.status !== "executed");
repo.setAccountStatus(acct.id, "connected");

// 5) Unknown account → typed 404, not a 500.
let nf: { status?: number } | null = null;
try { repo.getAccountContext("does-not-exist"); } catch (e) { nf = e as { status?: number }; }
check("unknown account → 404", !!nf && nf.status === 404);

// 6) Re-running the loop preserves decided/executed history.
const execBefore = repo.listActions(acct.id).filter((a) => a.status === "executed").length;
repo.clearUndecidedActions(acct.id);
const execAfter = repo.listActions(acct.id).filter((a) => a.status === "executed").length;
check("re-run preserves executed history", execBefore > 0 && execAfter === execBefore, `before=${execBefore} after=${execAfter}`);

// 7) Reject works; rejecting a decided action is a conflict.
await runLoop(acct.id);
const r0 = repo.listActions(acct.id, ["queued"])[0].id as string;
rejectAction(r0, "no thanks");
check("reject moves action to rejected", repo.getAction(r0)?.status === "rejected");
let rejErr: { status?: number } | null = null;
try { rejectAction(r0, "again"); } catch (e) { rejErr = e as { status?: number }; }
check("re-reject is a conflict", !!rejErr && rejErr.status === 409);

// 8) Guardrail engine units (pure-function level).
const ctx = repo.getAccountContext(acct.id);
const learningState: ObjectGuardState = {
  level: "ad_set", externalId: "X", learningStatus: "learning", inLearningUntil: new Date(Date.now() + 2 * 86400000).toISOString(),
  conversionsInWindow: 20, lastEditedAt: new Date().toISOString(), currentBudgetMinor: 250000,
  window: { spendMinor: 1_000_000, impressions: 50000, days: 5, cpaMinor: 49000 }, isAnomaly: false,
};
const reduce: ProposedAction = {
  id: "t", accountId: ctx.externalId, level: "ad_set", targetExternalId: "X", type: "reduce_budget",
  payload: { newBudgetMinor: applyPct(250000, -30) }, rationale: "", evidence: [], expectedImpact: { metric: "cpa", direction: "down" },
  confidence: 0.5, rollback: {}, status: "proposed",
};
check("guardrail blocks edit in learning phase", evaluate(reduce, ctx, ctx.guardrails, learningState).verdict === "block");

const winnerState: ObjectGuardState = {
  level: "ad_set", externalId: "W", learningStatus: "active", inLearningUntil: null,
  conversionsInWindow: 140, lastEditedAt: new Date(Date.now() - 6 * 86400000).toISOString(), currentBudgetMinor: 400000,
  window: { spendMinor: 2_700_000, impressions: 250000, days: 7, cpaMinor: 20400 }, isAnomaly: false,
};
const scale: ProposedAction = { ...reduce, type: "scale_budget", targetExternalId: "W", payload: { newBudgetMinor: applyPct(400000, 35) } };
const v = evaluate(scale, ctx, ctx.guardrails, winnerState);
check("guardrail caps +35% scale to +25%", v.verdict === "modify" && Number(v.modifiedPayload?.newBudgetMinor) === applyPct(400000, 25),
  `verdict=${v.verdict} newBudget=${v.modifiedPayload?.newBudgetMinor}`);

console.log("──────────────────────────────────────────────────────────");
console.log(fail === 0 ? `\x1b[32mAll tests passed.\x1b[0m\n` : `\x1b[31m${fail} test(s) failed.\x1b[0m\n`);
process.exit(fail === 0 ? 0 : 1);
