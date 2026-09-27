export type SeedRecordStatus =
  | "DRAFT"
  | "PENDING_APPROVAL"
  | "APPROVED";

export function normalizeSeedRecordStatus(
  value: unknown,
): SeedRecordStatus {
  if (value === undefined || value === null || value === "") {
    return "APPROVED";
  }
  if (value === "IN_REVIEW") {
    return "PENDING_APPROVAL";
  }
  if (
    value === "DRAFT"
    || value === "PENDING_APPROVAL"
    || value === "APPROVED"
  ) {
    return value;
  }
  throw new Error(`Unsupported seed record status: ${String(value)}`);
}
