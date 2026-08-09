import { randomUUID } from "node:crypto";

export type Role = "patient" | "clinic_owner" | "branch_staff" | "doctor" | "sys_admin";

export const ALL_ROLES: Role[] = ["patient", "clinic_owner", "branch_staff", "doctor", "sys_admin"];

export function isRole(v: unknown): v is Role {
  return typeof v === "string" && (ALL_ROLES as string[]).includes(v);
}

export const newId = () => randomUUID();

export function nowIso(): string {
  return new Date().toISOString().replace("T", " ").slice(0, 23);
}

export function isoNowSql(): string {
  return new Date().toISOString().slice(0, 19).replace("T", " ");
}
