// ── src/llm/route-model.ts ────────────────────────────────────────────────
// Claude model routing by job (Doc 01 §2). Many accounts × a loop every few
// hours = a lot of calls, so route by task to control cost. Swappable in one
// place; track cost per account in Langfuse (tracing.ts).

export type TaskType =
  | "strategy"          // media plan, high-stakes scale/kill judgment
  | "scale_kill"
  | "analysis"          // performance analysis
  | "copy"              // creative copy generation
  | "routine_optimise"  // routine optimisation proposals
  | "classify"          // anomaly tagging, formatting, routing
  | "format";

const MODELS = {
  opus: "claude-opus-4-8",
  sonnet: "claude-sonnet-4-6",
  haiku: "claude-haiku-4-5-20251001",
} as const;

export function routeModel(task: TaskType): string {
  switch (task) {
    case "strategy":
    case "scale_kill":
      return MODELS.opus; // judgment-heavy, low frequency
    case "analysis":
    case "copy":
    case "routine_optimise":
      return MODELS.sonnet; // the workhorse
    case "classify":
    case "format":
    default:
      return MODELS.haiku; // high volume, cheap
  }
}
