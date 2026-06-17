// ── scripts/demo.ts ───────────────────────────────────────────────────────
// End-to-end narrated run (no server, no browser): seed → OODA loop → show the
// proposal queue with guardrail verdicts → approve the anomaly pause and watch
// the Media Buyer execute it in DRY-RUN with a full audit trail.
// Run: npm run demo

import { execSync } from "node:child_process";
import { migrate } from "../src/db/client.ts";
import * as repo from "../src/db/repo.ts";
import { runLoop } from "../src/agents/orchestrator.ts";
import { approveAction } from "../src/worker/approvals.ts";
import { fmtINR } from "../src/shared/money.ts";
import { banner, log } from "../src/shared/logger.ts";

function reseed(): void {
  banner("STEP 1 · Seed a Meta TEST account (no live spend)");
  execSync("node --experimental-strip-types --experimental-sqlite --no-warnings src/db/seed.ts", { stdio: "inherit" });
}

async function main(): Promise<void> {
  reseed();
  migrate();
  const acct = repo.listAccounts()[0];

  banner("STEP 2 · Run the OODA loop (OBSERVE → ORIENT → DECIDE → GUARDRAIL → QUEUE)");
  const s = await runLoop(acct.id);
  console.log(`\n  Autonomy: ${s.autonomy.toUpperCase()}  |  observed ${s.observedAdSets} ad sets, ${s.observedAds} ads`);
  console.log(`  Optimizer proposed ${s.proposed} actions → ${s.queued} queued · ${s.modified} modified · ${s.blocked} blocked · ${s.deferred} deferred\n`);

  banner("STEP 3 · The Co-pilot approval queue (what a media buyer sees)");
  const queued = repo.listActions(acct.id, ["queued"]).map((r) => r);
  for (const a of queued) {
    const ev = JSON.parse((a.evidence as string) ?? "[]");
    const reasons = JSON.parse((a.guardrail_reasons as string) ?? "[]");
    console.log(`\n  ▸ ${(a.type as string).toUpperCase()} — ${a.target_name}   [${a.guardrail_verdict}]  conf ${a.confidence}`);
    console.log(`    why: ${a.rationale}`);
    if (ev.length) console.log(`    evidence: ${ev.map((e: { metric: string; value: number }) => `${e.metric}=${e.value}`).join(", ")}`);
    if (reasons.length) console.log(`    guardrail: ${reasons.join("; ")}`);
  }

  banner("STEP 4 · Guardrails that fired (blocked + deferred — surfaced, never executed)");
  for (const a of repo.listActions(acct.id, ["proposed"])) {
    const reasons = JSON.parse((a.guardrail_reasons as string) ?? "[]");
    const tag = a.guardrail_verdict === "block" ? "BLOCKED" : "DEFERRED";
    console.log(`  ✗ ${tag}: ${a.type} — ${a.target_name}\n      ${reasons.join("; ")}`);
  }

  banner("STEP 5 · Human approves the anomaly pause → Media Buyer executes (DRY-RUN)");
  const anomaly = queued.find((a) => a.type === "pause" && JSON.parse((a.payload as string) ?? "{}").urgent);
  if (anomaly) {
    const r = await approveAction(anomaly.id as string, "approved in demo");
    log.info(`Executed (dryRun=${r.dryRun}) — local mirror + audit log updated`, { action: anomaly.target_name });
    const after = repo.getAction(anomaly.id as string);
    console.log(`    action status → ${after?.status}`);
  }

  banner("STEP 6 · Append-only audit trail (most recent first)");
  for (const e of repo.listAudit(acct.id, 8)) {
    console.log(`  ${(e.created_at as string).slice(11, 19)}  ${(e.actor_type as string).padEnd(7)} ${e.event}`);
  }

  banner("STEP 7 · The kill switch (always-on safety backstop)");
  repo.setAccountStatus(acct.id, "killed");
  console.log(`  Account status set to KILLED → the guardrail engine now blocks 100% of writes.`);
  console.log(`  (Re-run \`npm run seed\` to reset.)\n`);

  console.log(`\n  ✔ Phase 0→1 MVP ran end-to-end. Monthly cap ${fmtINR(acct.monthly_cap_minor as number)} · daily cap ${fmtINR(acct.daily_cap_minor as number)} enforced.`);
  console.log(`  ✔ Co-pilot: nothing touched a live account; all writes were DRY-RUN.`);
  console.log(`  → Start the dashboard with:  npm run serve   then open http://localhost:8787\n`);
}

main().catch((e) => { console.error(e); process.exit(1); });
