export const GOVERNED_DESCRIPTOR_SCHEMA_VERSION = 1;
export const PLATFORM_BOOTSTRAP_OWNER_SUBJECT = "platform-bootstrap";
export const GOVERNED_RECORD_VERSION_BUILD = "platform-descriptor.1";
// Server-side constraint on registry recordVersion. Source: botocore
// service model bedrock-agentcore-control/2023-06-05 (shape
// RegistryRecordVersion: pattern [a-zA-Z0-9.-]+, min 1, max 255),
// corroborated by a live CreateRegistryRecord ValidationException
// observed 2026-09-02. Anchored because the service full-matches.
export const REGISTRY_RECORD_VERSION_PATTERN = /^[a-zA-Z0-9.-]+$/;
export const REGISTRY_RECORD_VERSION_MAX_LENGTH = 255;
const COMPLETE_SEMVER_PATTERN =
  /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export type GovernedResourceType = "AGENT" | "SKILL" | "BLUEPRINT";

export interface GovernedDescriptorMetadata {
  domainId: string;
  ownerSubject: string;
  resourceId: string;
  resourceType: GovernedResourceType;
  shared: boolean;
}

export function governedDomainId(domain: string): string {
  return domain.split("-").join("_");
}

// The governed marker lives in the SemVer prerelease segment (never in
// `+` build metadata) because the registry service rejects `+` — see
// REGISTRY_RECORD_VERSION_PATTERN. This matches the runtime seeder in
// serverless-platform/lambda/governance/service.mjs.
//
// ⚠️ KNOWN CONSUMERS of version ordering: the repo already contains
// hand-written comparators — console/registry-shape.mjs:312 and
// console/registry-client.mjs:122 (`cmp`) — used for
// entry.versions.sort(cmp) and defaultVersion selection. Their
// prerelease ordering is REVERSED relative to SemVer: a prerelease
// segment LOWERS precedence in SemVer,
//     1.0.0-platform-descriptor.1  <  1.0.0
// but cmp sorts the governed record ABOVE its release twin, so
// defaultVersion picks 1.0.0-platform-descriptor.1 over 1.0.0
// (measured; the old `+build` form ranked equal to 1.0.0). Whether cmp
// itself needs fixing depends on whether managed/unmanaged records of
// the same name realistically coexist — not decided here. If you rely
// on version-precedence ordering over recordVersion, account for this
// encoding first — governed records sort BELOW their own base version
// under correct SemVer semantics.
export function hasGovernedRecordVersion(version: string): boolean {
  if (!COMPLETE_SEMVER_PATTERN.test(version)) return false;
  if (!REGISTRY_RECORD_VERSION_PATTERN.test(version)) return false;
  if (version.length > REGISTRY_RECORD_VERSION_MAX_LENGTH) return false;
  const prereleaseStart = version.indexOf("-");
  if (prereleaseStart === -1) return false;
  const prerelease = version.slice(prereleaseStart + 1);
  return prerelease.split(".").slice(-2).join(".")
    === GOVERNED_RECORD_VERSION_BUILD;
}

export function governedRecordVersion(version: string): string {
  if (!COMPLETE_SEMVER_PATTERN.test(version)) {
    throw new TypeError("Governed record version must be valid SemVer.");
  }
  const [withoutBuild, build = ""] = version.split("+", 2);
  const governedSuffix = `.${GOVERNED_RECORD_VERSION_BUILD}`;
  const governed =
    withoutBuild.endsWith(`-${GOVERNED_RECORD_VERSION_BUILD}`)
      || withoutBuild.endsWith(governedSuffix)
      ? withoutBuild
      : `${withoutBuild}${withoutBuild.includes("-") ? "." : "-"}${[
        build === GOVERNED_RECORD_VERSION_BUILD
          || build.endsWith(governedSuffix)
          ? build.slice(0, -governedSuffix.length)
          : build,
        GOVERNED_RECORD_VERSION_BUILD,
      ].filter(Boolean).join(".")}`;
  if (!hasGovernedRecordVersion(governed)) {
    throw new TypeError(
      "Governed record version does not satisfy the registry constraint.",
    );
  }
  return governed;
}

export function governedDescriptor<T extends Record<string, unknown>>(
  document: T,
  metadata: GovernedDescriptorMetadata,
): T & {
  schemaVersion: 1;
  "x-platform": GovernedDescriptorMetadata;
} {
  return {
    ...document,
    schemaVersion: GOVERNED_DESCRIPTOR_SCHEMA_VERSION,
    "x-platform": {
      domainId: metadata.domainId,
      ownerSubject: metadata.ownerSubject,
      resourceId: metadata.resourceId,
      resourceType: metadata.resourceType,
      shared: metadata.shared,
    },
  };
}
