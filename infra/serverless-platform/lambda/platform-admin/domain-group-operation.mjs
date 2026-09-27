import { createHash } from "node:crypto";

const ACTOR_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/;
const DOMAIN_ID_PATTERN = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;
const OWNER_GROUP_PATTERN = /^domain-[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_DOMAIN_ID_LENGTH = 64;
const MAX_OWNER_GROUP_LENGTH = 128;

function invalidOperationIdentity() {
  return new TypeError("Domain group operation identity is invalid.");
}

function validateIdentity(identity) {
  if (
    identity === null
    || typeof identity !== "object"
    || Array.isArray(identity)
    || typeof identity.actor !== "string"
    || !ACTOR_PATTERN.test(identity.actor)
    || typeof identity.requestId !== "string"
    || !REQUEST_ID_PATTERN.test(identity.requestId)
  ) {
    throw invalidOperationIdentity();
  }
  return {
    actor: identity.actor,
    requestId: identity.requestId,
  };
}

function validateDomainId(domainId) {
  if (
    typeof domainId !== "string"
    || domainId.length > MAX_DOMAIN_ID_LENGTH
    || !DOMAIN_ID_PATTERN.test(domainId)
  ) {
    throw invalidOperationIdentity();
  }
  return domainId;
}

export function domainRegistryClientToken(identity, domainId) {
  const trustedIdentity = validateIdentity(identity);
  const trustedDomainId = validateDomainId(domainId);
  return createHash("sha256")
    .update(
      `${trustedIdentity.actor}\n`
        + `${trustedIdentity.requestId}\n`
        + trustedDomainId,
    )
    .digest("hex");
}

export function domainOwnerGroupName(domainId) {
  const trustedDomainId = validateDomainId(domainId);
  const ownerGroup = `domain-${trustedDomainId.replaceAll("_", "-")}`;
  if (
    ownerGroup.length > MAX_OWNER_GROUP_LENGTH
    || !OWNER_GROUP_PATTERN.test(ownerGroup)
  ) {
    throw invalidOperationIdentity();
  }
  return ownerGroup;
}

export function domainIdFromOwnerGroupName(ownerGroup) {
  if (
    typeof ownerGroup !== "string"
    || ownerGroup.length > MAX_OWNER_GROUP_LENGTH
    || !OWNER_GROUP_PATTERN.test(ownerGroup)
  ) {
    throw invalidOperationIdentity();
  }
  const domainId = validateDomainId(
    ownerGroup.slice("domain-".length).replaceAll("-", "_"),
  );
  if (domainOwnerGroupName(domainId) !== ownerGroup) {
    throw invalidOperationIdentity();
  }
  return domainId;
}

export function domainGroupOperationToken(identity, domainId) {
  return createHash("sha256")
    .update(
      "cognito-domain-group:v2\n"
        + domainRegistryClientToken(identity, domainId),
    )
    .digest("hex");
}

export function domainGroupOwnership(identity, domainId) {
  return Object.freeze({
    name: domainOwnerGroupName(domainId),
    operationToken: domainGroupOperationToken(identity, domainId),
  });
}
