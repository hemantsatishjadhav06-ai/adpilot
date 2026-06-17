// ── src/shared/logger.ts ──────────────────────────────────────────────────
// Minimal structured logger (stand-in for pino + Sentry, Doc 01). Adds light
// ANSI colour for the demo console.

type Level = "debug" | "info" | "warn" | "error";

const COLOR: Record<Level, string> = {
  debug: "\x1b[90m",
  info: "\x1b[36m",
  warn: "\x1b[33m",
  error: "\x1b[31m",
};
const RESET = "\x1b[0m";

function emit(level: Level, msg: string, ctx?: Record<string, unknown>): void {
  const ts = new Date().toISOString();
  const tail = ctx && Object.keys(ctx).length ? " " + JSON.stringify(ctx) : "";
  // eslint-disable-next-line no-console
  console.log(`${COLOR[level]}${ts} ${level.toUpperCase().padEnd(5)}${RESET} ${msg}${tail}`);
}

export const log = {
  debug: (m: string, c?: Record<string, unknown>) => emit("debug", m, c),
  info: (m: string, c?: Record<string, unknown>) => emit("info", m, c),
  warn: (m: string, c?: Record<string, unknown>) => emit("warn", m, c),
  error: (m: string, c?: Record<string, unknown>) => emit("error", m, c),
};

/** Pretty section header for the demo script. */
export function banner(title: string): void {
  const line = "─".repeat(Math.max(8, 72 - title.length));
  console.log(`\n\x1b[1m\x1b[35m┌─ ${title} ${line}\x1b[0m`);
}
