import { createHash } from "node:crypto";

const DOMAIN_SOURCE_IDENTITY_PREFIX = "domain_";
const MAX_SOURCE_IDENTITY_LENGTH = 64;
const MAX_DOMAIN_ID_LENGTH = 64;
const DOMAIN_ID_PATTERN = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;

function validDomainId(value) {
  return (
    typeof value === "string"
    && value.length > 0
    && value.length <= MAX_DOMAIN_ID_LENGTH
    && DOMAIN_ID_PATTERN.test(value)
  );
}

export function domainGatewaySourceIdentity(domainId) {
  if (!validDomainId(domainId)) {
    throw new TypeError("Gateway domain identity is invalid.");
  }
  const direct = `${DOMAIN_SOURCE_IDENTITY_PREFIX}${domainId}`;
  if (direct.length <= MAX_SOURCE_IDENTITY_LENGTH) {
    return direct;
  }
  const digest = createHash("sha256")
    .update(domainId)
    .digest("hex")
    .slice(0, 32);
  return `${DOMAIN_SOURCE_IDENTITY_PREFIX}${domainId.slice(0, 24)}_${digest}`;
}
