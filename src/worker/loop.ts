// ── src/worker/loop.ts ────────────────────────────────────────────────────
// Per-account cron fan-out. In production this is an Inngest function with
// durable, retryable steps (Doc 01, Doc 05 services/worker). Here it runs the
// OODA loop for every connected account once. Run: npm run loop

import { migrate } from "../db/client.ts";
import * as repo from "../db/repo.ts";
import { runLoop } from "../agents/orchestrator.ts";
import { log, banner } from "../shared/logger.ts";

export async function runAllAccounts(): Promise<void> {
  migrate();
  const accounts = repo.listAccounts();
  if (!accounts.length) {
    log.warn("No accounts found — run `npm run seed` first.");
    return;
  }
  for (const a of accounts) {
    banner(`OODA cycle — ${a.display_name} (${a.external_account_id})`);
    await runLoop(a.id);
  }
}

// Run when invoked directly.
if (import.meta.filename === process.argv[1]) {
  runAllAccounts().catch((e) => { log.error("loop failed", { err: String(e) }); process.exit(1); });
}
