export class ApiError extends Error {
  status: number;
  code: string;
  field: string | null;
  retryAfter: number | null;

  constructor(status: number, code: string, message: string, field: string | null = null, retryAfter: number | null = null) {
    super(message);
    this.status = status;
    this.code = code;
    this.field = field;
    this.retryAfter = retryAfter;
  }
}

export const badRequest = (code: string, message: string, field: string | null = null) =>
  new ApiError(400, code, message, field);
export const unauthorized = (code = "UNAUTHORIZED", message = "Authentication required.") =>
  new ApiError(401, code, message);
export const forbidden = (code: string, message: string) => new ApiError(403, code, message);
export const notFound = (code: string, message: string) => new ApiError(404, code, message);
export const conflict = (code: string, message: string) => new ApiError(409, code, message);
export const unprocessable = (code: string, message: string, field: string | null = null) =>
  new ApiError(422, code, message, field);
export const tooLarge = (code: string, message: string) => new ApiError(413, code, message);
export const unsupported = (code: string, message: string) => new ApiError(415, code, message);
export const rateLimited = (retryAfter = 60) => new ApiError(429, "RATE_LIMITED", `Too many requests. Retry after ${retryAfter} seconds.`, null, retryAfter);

export function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string };
  return e?.code === "ER_DUP_ENTRY";
}
