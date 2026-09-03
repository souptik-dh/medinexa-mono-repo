import { z, type ZodTypeAny, type ZodError } from "zod";
import { badRequest } from "@/lib/errors";

export function parseBody<T extends ZodTypeAny>(
  schema: T,
  body: Record<string, unknown>,
): z.infer<T> {
  const result = schema.safeParse(body);
  if (!result.success) {
    const issue = result.error.issues[0];
    throw badRequest("VALIDATION_ERROR", issue.message, issue.path.join(".") || null);
  }
  return result.data;
}

export const emailSchema = z.string().trim().toLowerCase().email("Invalid email address.");
export const optionalEmailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .email("Invalid email address.")
  .optional()
  .nullable();
export const phoneSchema = z
  .string()
  .trim()
  .regex(/^(\+91)?[6-9]\d{9}$/, "Invalid Indian phone number. Use a 10-digit mobile number.")
  .refine((v) => {
    const digits = v.replace(/\D/g, "");
    const local = digits.length === 12 ? digits.slice(2) : digits.slice(-10);
    return /^[6-9]/.test(local);
  }, "Invalid Indian phone number. Must start with 6-9.")
  .transform((v) => {
    const digits = v.replace(/\D/g, "");
    const local = digits.length === 12 ? digits.slice(2) : digits.slice(-10);
    return `+91${local}`;
  });
export const otpSchema = z.string().regex(/^\d{6}$/, "OTP must be 6 digits.");
export const passwordSchema = z
  .string()
  .min(8, "Password must be at least 8 characters.")
  .max(128, "Password must be at most 128 characters.");
export const idSchema = z.string().uuid("Invalid identifier.");
export const currencySchema = z.string().trim().toUpperCase().length(3);
export const timeSchema = z
  .string()
  .regex(/^\d{2}:\d{2}$/, "Time must be in HH:MM (24h) format.")
  .refine((t) => {
    const [h, m] = t.split(":").map(Number);
    return h >= 0 && h <= 23 && m >= 0 && m <= 59;
  }, "Time is out of range.");

export function parsePagination(
  searchParams: URLSearchParams,
): { limit: number; cursor: string | null } {
  const rawLimit = Number(searchParams.get("limit") ?? 20);
  const limit = Number.isInteger(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 100) : 20;
  return { limit, cursor: searchParams.get("cursor") };
}

export function isIntId(v: unknown): boolean {
  return typeof v === "string" && v.length > 0 && /^\d+$/.test(v);
}

export function zodErrorMessage(error: ZodError): string {
  return error.issues[0]?.message ?? "Invalid input.";
}
