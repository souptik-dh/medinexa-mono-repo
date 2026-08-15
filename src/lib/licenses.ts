import type { Row } from "@/lib/db";
import { badRequest } from "@/lib/errors";

export const LICENSE_TYPES = [
  "trade-license",
  "drug-license",
  "clinical-establishment-registration",
] as const;

export type LicenseType = (typeof LICENSE_TYPES)[number];

export const REQUIRED_LICENSE_TYPES: LicenseType[] = ["trade-license"];

const LICENSE_COLUMNS: Record<LicenseType, { number: string; url: string }> = {
  "trade-license": { number: "trade_license_number", url: "trade_license_url" },
  "drug-license": { number: "drug_license_number", url: "drug_license_url" },
  "clinical-establishment-registration": {
    number: "clinical_establishment_reg_number",
    url: "clinical_establishment_reg_url",
  },
};

export function licenseColumns(type: string): { number: string; url: string } {
  if (!(LICENSE_TYPES as readonly string[]).includes(type)) {
    throw badRequest(
      "INVALID_LICENSE_TYPE",
      `type must be one of: ${LICENSE_TYPES.join(", ")}.`,
      "type",
    );
  }
  return LICENSE_COLUMNS[type as LicenseType];
}

export function licenseFields(row: Row) {
  return {
    trade_license_number: row.trade_license_number ?? null,
    trade_license_url: row.trade_license_url ?? null,
    drug_license_number: row.drug_license_number ?? null,
    drug_license_url: row.drug_license_url ?? null,
    clinical_establishment_reg_number: row.clinical_establishment_reg_number ?? null,
    clinical_establishment_reg_url: row.clinical_establishment_reg_url ?? null,
  };
}

// Clinics only (not branches) — the PRDEODB trade-license validation state.
export function tradeLicenseValidationFields(row: Row) {
  return {
    trade_license_validated: !!row.trade_license_validated,
    trade_license_validation_status: row.trade_license_validation_status ?? "PENDING",
    trade_license_validated_at: row.trade_license_validated_at ?? null,
  };
}
