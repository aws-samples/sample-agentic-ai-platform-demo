// Reader capability is an operator attestation, never inferred from this binary.
// Omitted settings preserve the deployed legacy record shape.
export function costJournalEnabled(compatibility = {}) {
  if (!compatibility || typeof compatibility !== "object" || Array.isArray(compatibility)
    || Reflect.ownKeys(compatibility).some(key => !["writerVersion", "readerVersion"].includes(key))) {
    throw new TypeError("Invocation journal compatibility configuration is invalid.");
  }
  const { writerVersion = "legacy", readerVersion = "legacy" } = compatibility;
  if (!["legacy", "cost-v1"].includes(writerVersion)
    || !["legacy", "accounting-v1", "cost-v1"].includes(readerVersion)
    || (writerVersion === "cost-v1" && readerVersion !== "cost-v1")) {
    throw new TypeError("Invocation journal compatibility requires compatible readers before cost-v1 writes.");
  }
  return writerVersion === "cost-v1";
}

export function journalCompatibilityFromEnv(env) {
  const compatibility = {
    writerVersion: env.EXPERIENCE_JOURNAL_WRITE_VERSION,
    readerVersion: env.EXPERIENCE_JOURNAL_READER_VERSION,
  };
  costJournalEnabled(compatibility);
  return compatibility;
}
