// ── src/shared/errors.ts ──────────────────────────────────────────────────
// Typed application errors so the API can map them to correct HTTP statuses
// instead of a blanket 500.

export class AppError extends Error {
  code: string;
  status: number;
  constructor(code: string, status: number, message: string) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.status = status;
  }
}

export const notFound = (msg: string): AppError => new AppError("NOT_FOUND", 404, msg);
export const conflict = (msg: string): AppError => new AppError("CONFLICT", 409, msg);
export const blocked = (msg: string): AppError => new AppError("GUARDRAIL_BLOCKED", 409, msg);
