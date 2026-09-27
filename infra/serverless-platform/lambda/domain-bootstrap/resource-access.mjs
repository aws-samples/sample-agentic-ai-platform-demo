import { fingerprint, BootstrapError, resolveConfiguration } from "./service.mjs";
import { resourceGrantType } from "./resource-policy.mjs";

export function createBootstrapResourceGrants({ workspace, registry }) {
  return async operation => {
    resolveConfiguration(operation.configuration, await registry(operation.actor));
    const grants = [];
    for (const entry of [...operation.applied.blueprints, ...operation.applied.resources]) {
      const resourceType = resourceGrantType(entry), resourceId = entry.ref.id;
      const scope = { domainId: operation.domainId, resourceType, resourceId };
      const previous = await workspace.getResourceGrant(scope);
      if (previous?.status === "REVOKED") {
        throw new BootstrapError("RESOURCE_GRANT_REVOKED", "A selected resource grant was revoked. Initialization will not restore it automatically.");
      }
      if (!previous) {
        const transaction = workspace.beginTransaction();
        const timestamp = transaction.timestamp;
        await workspace.putResourceGrant({
          record: { ...scope, status: "ACTIVE", grantedBySubject: operation.actor.subject,
            grantedAt: timestamp, revokedBySubject: null, revokedAt: null },
          expectedStatus: null, transaction,
          mutation: {
            actor: operation.actor.subject, requesterSubject: operation.actor.subject,
            effectiveRole: "admin", domainId: operation.domainId, projectId: null,
            route: "POST /internal/domain-bootstrap/resource-grants",
            requestId: `bootstrap:${operation.domainId}:${fingerprint(scope).slice(0, 16)}`,
            payloadFingerprint: fingerprint(scope),
            result: { entityType: "RESOURCE_GRANT",
              resourceKey: `grant/${operation.domainId}/${resourceType}/${resourceId}`,
              operation: "CREATE", status: "SUCCEEDED" },
            decision: "create", reason: `Initial resource access for domain ${operation.domainId}.`, timestamp, createdAt: timestamp,
          },
        });
      }
      grants.push(scope);
    }
    return { resourceGrants: grants };
  };
}
