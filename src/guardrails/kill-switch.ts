// ── src/guardrails/kill-switch.ts ─────────────────────────────────────────
// Global kill switch (Doc 03 §3). When an account is killed, every write is
// blocked unconditionally — the always-on safety backstop.

import type { AccountContext } from "../shared/types.ts";
import type { RuleResult } from "./types.ts";
import { allow, block } from "./types.ts";

export function checkKillSwitch(ctx: AccountContext): RuleResult {
  if (ctx.status === "killed") return block("KILL SWITCH engaged for this account — all writes blocked");
  return allow();
}
