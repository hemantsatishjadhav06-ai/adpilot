// ── src/llm/client.ts ─────────────────────────────────────────────────────
// Anthropic client + tracing stub (Doc 01 §2, Doc 02 §5). The system runs
// fully WITHOUT an API key: the agents use deterministic logic by default and
// only call Claude when ADPILOT_USE_LLM=1 and ANTHROPIC_API_KEY is set, in
// which case the LLM refines rationale text. The decision GATES are always the
// deterministic guardrail engine — "an LLM proposes; plain code decides."

import { routeModel } from "./route-model.ts";
import type { TaskType } from "./route-model.ts";
import { log } from "../shared/logger.ts";

export const LLM_ENABLED =
  process.env.ADPILOT_USE_LLM === "1" && !!process.env.ANTHROPIC_API_KEY;

export interface ReasonRequest {
  task: TaskType;
  system: string;
  user: string;
  maxTokens?: number;
}

/** Returns model text, or null if LLM is disabled / errors (graceful). */
export async function reason(req: ReasonRequest): Promise<string | null> {
  if (!LLM_ENABLED) return null;
  const model = routeModel(req.task);
  const t0 = Date.now();
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY as string,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model,
        max_tokens: req.maxTokens ?? 512,
        system: req.system,
        messages: [{ role: "user", content: req.user }],
      }),
    });
    if (!res.ok) { log.warn("LLM call non-200", { status: res.status }); return null; }
    const json = (await res.json()) as { content?: { text?: string }[] };
    const text = json.content?.map((c) => c.text ?? "").join("") ?? null;
    trace(req.task, model, Date.now() - t0, true);
    return text;
  } catch (e) {
    trace(req.task, model, Date.now() - t0, false);
    log.warn("LLM call failed; falling back to deterministic logic", { err: String(e) });
    return null;
  }
}

/** Langfuse-style trace line (cost/latency/model per call). */
function trace(task: TaskType, model: string, ms: number, ok: boolean): void {
  log.debug("llm.trace", { task, model, ms, ok });
}
