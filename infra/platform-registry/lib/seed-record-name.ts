export function canonicalizeSeedRecordName(value: string): string {
  const canonical = String(value)
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");

  if (canonical.length === 0) {
    throw new Error("seed record name must contain a letter or digit");
  }

  return /^[A-Za-z]/.test(canonical) ? canonical : `x_${canonical}`;
}
