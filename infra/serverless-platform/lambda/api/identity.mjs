import {
  AdminGetUserCommand,
  AdminListGroupsForUserCommand,
  CognitoIdentityProviderClient,
} from "@aws-sdk/client-cognito-identity-provider";
import {
  RESERVED_DOMAIN_IDS,
  RESERVED_DOMAIN_GROUP_NAMES,
  capabilitiesForRole,
} from "../authz/capabilities.mjs";

const ROLE_GROUPS = new Map([
  ["platform-admin", "admin"],
  ["domain-builder", "builder"],
  ["domain-lead", "lead"],
  ["end-user", "user"],
]);
const ACCESS_GROUPS = new Set([
  ...ROLE_GROUPS.keys(),
  "demo-operator",
  ...RESERVED_DOMAIN_GROUP_NAMES,
]);
const DEMO_ROLES = Object.freeze([
  "admin",
  "lead",
  "builder",
  "user",
]);
const DOMAIN_GROUP = /^domain-([a-z0-9]+(?:-[a-z0-9]+)*)$/;
const DOMAIN_ID_PATTERN = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;
const MAX_DOMAIN_ID_LENGTH = 64;
const MAX_COGNITO_GROUP_PAGES = 10;
const COGNITO_GROUP_PAGE_LIMIT = 60;
const DOMAIN_ALIASES = new Map([
  ["customer-support", "customer_support"],
]);

export class IdentityScopeError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "IdentityScopeError";
    this.code = code;
    this.statusCode = 403;
    this.retryable = false;
  }
}

function ownClaim(claims, key) {
  if (
    claims === null
    || (typeof claims !== "object" && typeof claims !== "function")
    || !Object.hasOwn(claims, key)
  ) {
    return undefined;
  }
  return claims[key];
}

export function ownStringClaim(claims, key) {
  const value = ownClaim(claims, key);
  if (typeof value !== "string") {
    return null;
  }

  const normalized = value.trim();
  return normalized || null;
}

function isPlainObject(value) {
  return Boolean(
    value
    && typeof value === "object"
    && !Array.isArray(value)
    && (
      Object.getPrototypeOf(value) === Object.prototype
      || Object.getPrototypeOf(value) === null
    ),
  );
}

function validCognitoUsername(value) {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > 128
    || value !== value.trim()
    || /[\u0000-\u001f\u007f]/.test(value)
  ) {
    return null;
  }
  return value;
}

function cognitoUserSubject(user) {
  const attributes = ownClaim(user, "UserAttributes");
  if (!Array.isArray(attributes)) return null;

  const subjects = attributes
    .filter((attribute) =>
      isPlainObject(attribute)
      && ownStringClaim(attribute, "Name") === "sub")
    .map((attribute) => ownStringClaim(attribute, "Value"));
  return subjects.length === 1 ? subjects[0] : null;
}

function cognitoUsername(claims) {
  const values = [
    ownClaim(claims, "cognito:username"),
    ownClaim(claims, "username"),
  ].filter((value) => value !== undefined);
  if (values.length === 0) {
    return null;
  }

  const normalized = values.map(validCognitoUsername);
  if (
    normalized.some((value) => value === null)
    || new Set(normalized).size !== 1
  ) {
    return null;
  }
  return normalized[0];
}

export function createAuthoritativeDemoOperatorVerifier({
  cognito,
  maxGroupPages = MAX_COGNITO_GROUP_PAGES,
  userPoolId,
} = {}) {
  if (
    typeof userPoolId !== "string"
    || !/^[a-z]{2}(?:-gov)?-[a-z]+-\d+_[A-Za-z0-9]+$/.test(userPoolId)
  ) {
    throw new TypeError("Cognito user pool configuration is invalid.");
  }
  if (!cognito || typeof cognito.send !== "function") {
    throw new TypeError("Cognito client is invalid.");
  }
  if (
    !Number.isInteger(maxGroupPages)
    || maxGroupPages < 1
    || maxGroupPages > MAX_COGNITO_GROUP_PAGES
  ) {
    throw new TypeError("Cognito group page limit is invalid.");
  }

  return async function verifyAuthoritativeDemoOperator(claims = {}) {
    const username = cognitoUsername(claims);
    const subject = ownStringClaim(claims, "sub");
    if (!username || !subject) {
      return false;
    }

    let user;
    try {
      user = await cognito.send(new AdminGetUserCommand({
        UserPoolId: userPoolId,
        Username: username,
      }));
    } catch (error) {
      if (error?.name === "UserNotFoundException") {
        return false;
      }
      throw error;
    }
    if (
      !isPlainObject(user)
      || ownStringClaim(user, "Username") !== username
      || user.Enabled !== true
      || cognitoUserSubject(user) !== subject
    ) {
      return false;
    }

    const groupNames = new Set();
    const seenTokens = new Set();
    let nextToken;
    for (let page = 0; page < maxGroupPages; page += 1) {
      const result = await cognito.send(
        new AdminListGroupsForUserCommand({
          UserPoolId: userPoolId,
          Username: username,
          Limit: COGNITO_GROUP_PAGE_LIMIT,
          ...(nextToken ? { NextToken: nextToken } : {}),
        }),
      );
      if (
        !isPlainObject(result)
        || !Array.isArray(result.Groups)
      ) {
        throw new Error("Cognito group response is malformed.");
      }
      for (const group of result.Groups) {
        const groupName = ownStringClaim(group, "GroupName");
        if (!groupName || groupNames.has(groupName)) {
          throw new Error("Cognito group response is malformed.");
        }
        groupNames.add(groupName);
      }

      if (!Object.hasOwn(result, "NextToken")) {
        return groupNames.has("platform-admin")
          && groupNames.has("demo-operator");
      }
      if (
        typeof result.NextToken !== "string"
        || !result.NextToken
        || result.NextToken.length > 2048
        || seenTokens.has(result.NextToken)
      ) {
        throw new Error("Cognito group pagination is malformed.");
      }
      if (page + 1 >= maxGroupPages) {
        throw new Error("Cognito group pagination exceeds its limit.");
      }
      seenTokens.add(result.NextToken);
      nextToken = result.NextToken;
    }

    throw new Error("Cognito group pagination exceeds its limit.");
  };
}

let productionDemoOperatorVerifier;

export async function verifyCurrentDemoOperator(claims = {}) {
  productionDemoOperatorVerifier ??=
    createAuthoritativeDemoOperatorVerifier({
      userPoolId: process.env.COGNITO_USER_POOL_ID,
      cognito: new CognitoIdentityProviderClient({}),
    });
  return productionDemoOperatorVerifier(claims);
}

function normalizedGroups(values) {
  return values
    .filter((value) => typeof value === "string")
    .map((value) => value.trim())
    .filter((value) => ACCESS_GROUPS.has(value) || domainFromGroup(value));
}

function domainFromGroup(group) {
  if (ACCESS_GROUPS.has(group)) {
    return null;
  }
  const match = DOMAIN_GROUP.exec(group);
  return match ? match[1].replaceAll("-", "_") : null;
}

export function groupsFromClaims(claims = {}) {
  const raw = ownClaim(claims, "cognito:groups");

  if (Array.isArray(raw)) {
    return normalizedGroups(raw);
  }

  if (typeof raw !== "string" || !raw.trim()) {
    return [];
  }

  const normalized = raw.trim();
  if (normalized.startsWith("[") || normalized.startsWith("{")) {
    try {
      const parsed = JSON.parse(normalized);
      return Array.isArray(parsed) ? normalizedGroups(parsed) : [];
    } catch {
      if (!normalized.startsWith("[") || !normalized.endsWith("]")) {
        return [];
      }
      return normalizedGroups(
        normalized.slice(1, -1).split(/[,\s]+/),
      );
    }
  }

  return normalizedGroups(normalized.split(/[,\s]+/));
}

function roleForGroups(groups) {
  const recognizedRoles = recognizedRolesForGroups(groups);
  if (recognizedRoles.length !== 1) return "user";
  return recognizedRoles[0];
}

function recognizedRolesForGroups(groups) {
  return [
    ...new Set(
      groups
        .filter((group) => ROLE_GROUPS.has(group))
        .map((group) => ROLE_GROUPS.get(group)),
    ),
  ];
}

function capabilitiesForGroups(groups, role) {
  return recognizedRolesForGroups(groups).length === 1
    ? capabilitiesForRole(role)
    : [];
}

function domainsForGroups(groups) {
  return [
    ...new Set(
      groups
        .map(domainFromGroup)
        .filter(Boolean),
    ),
  ];
}

function scopeError(code, message) {
  return new IdentityScopeError(message, code);
}

function normalizedDomain(value) {
  if (typeof value !== "string") {
    return null;
  }

  const normalized = DOMAIN_ALIASES.get(value) || value;
  if (
    !normalized
    || normalized.length > MAX_DOMAIN_ID_LENGTH
    || !DOMAIN_ID_PATTERN.test(normalized)
    || RESERVED_DOMAIN_IDS.includes(normalized)
  ) {
    return null;
  }
  return normalized;
}

function singleHeader(headers, name, errorCode, errorMessage) {
  if (
    headers === null
    || (typeof headers !== "object" && typeof headers !== "function")
  ) {
    return { present: false, value: undefined };
  }

  const matchingKeys = Object.getOwnPropertyNames(headers)
    .filter((key) => key.toLowerCase() === name);
  if (matchingKeys.length > 1) {
    throw scopeError(errorCode, errorMessage);
  }
  if (matchingKeys.length === 0) {
    return { present: false, value: undefined };
  }

  return {
    present: true,
    value: headers[matchingKeys[0]],
  };
}

function availableDomainIds(availableDomains) {
  if (!Array.isArray(availableDomains)) {
    return [];
  }

  return [
    ...new Set(
      availableDomains
        .map((domain) => normalizedDomain(ownClaim(domain, "id")))
        .filter(Boolean),
    ),
  ];
}

export function projectIdentity(claims = {}) {
  const groups = groupsFromClaims(claims);
  const role = roleForGroups(groups);
  const domains = role === "user" ? [] : domainsForGroups(groups);
  const sub = ownStringClaim(claims, "sub") || "";
  const username = ownStringClaim(claims, "cognito:username")
    || ownStringClaim(claims, "username")
    || sub;
  const email = ownStringClaim(claims, "email");
  const name = ownStringClaim(claims, "name") || email || username;

  return {
    ok: true,
    user: sub,
    username,
    name,
    email,
    role,
    groups,
    domain: null,
    domains,
    capabilities: [...capabilitiesForGroups(groups, role)],
    identityProvider: "cognito",
  };
}

export function preflightEffectiveIdentity(
  claims = {},
  headers = {},
  { demoOperatorAuthorized } = {},
) {
  const authenticatedIdentity = projectIdentity(claims);
  const tokenCanSwitchDemoRole =
    authenticatedIdentity.role === "admin"
    && authenticatedIdentity.groups.includes("platform-admin")
    && authenticatedIdentity.groups.includes("demo-operator");
  const canSwitchDemoRole =
    tokenCanSwitchDemoRole
    && demoOperatorAuthorized !== false;
  const roleHeader = singleHeader(
    headers,
    "x-demo-role",
    "DEMO_ROLE_NOT_ALLOWED",
    "The requested demo role is not allowed.",
  );
  if (
    roleHeader.present
    && (
      !canSwitchDemoRole
      || typeof roleHeader.value !== "string"
      || !DEMO_ROLES.includes(roleHeader.value)
    )
  ) {
    throw scopeError(
      "DEMO_ROLE_NOT_ALLOWED",
      "The requested demo role is not allowed.",
    );
  }

  const domainHeader = singleHeader(
    headers,
    "x-active-domain",
    "DEMO_DOMAIN_NOT_ALLOWED",
    "The requested demo domain is not allowed.",
  );
  const role = roleHeader.present
    ? roleHeader.value
    : authenticatedIdentity.role;
  if (
    domainHeader.present
    && (
      role === "user"
      || !normalizedDomain(domainHeader.value)
    )
  ) {
    throw scopeError(
      "DEMO_DOMAIN_NOT_ALLOWED",
      "The requested demo domain is not allowed.",
    );
  }
  if (
    roleHeader.present
    && (role === "lead" || role === "builder")
    && !domainHeader.present
  ) {
    throw scopeError(
      "DEMO_DOMAIN_REQUIRED",
      "An available demo domain is required.",
    );
  }

  return {
    authenticatedIdentity,
    canSwitchDemoRole,
    domainHeader,
    requestedDomain: domainHeader.present
      ? normalizedDomain(domainHeader.value)
      : null,
    roleHeader,
  };
}

export function projectEffectiveIdentity(
  claims = {},
  headers = {},
  {
    availableDomains,
    availableDemoDomains,
    demoOperatorAuthorized,
  } = {},
) {
  const {
    authenticatedIdentity,
    canSwitchDemoRole,
    domainHeader,
    requestedDomain,
    roleHeader,
  } = preflightEffectiveIdentity(
    claims,
    headers,
    { demoOperatorAuthorized },
  );
  const baseProfile = {
    ...authenticatedIdentity,
    actor: authenticatedIdentity.user,
    authenticatedRole: authenticatedIdentity.role,
    assumedRole: null,
    demoRoleActive: false,
    canSwitchDemoRole,
    availableDemoRoles: canSwitchDemoRole ? [...DEMO_ROLES] : [],
  };

  if (!roleHeader.present) {
    if (authenticatedIdentity.role === "user") {
      return baseProfile;
    }

    let permanentScope;
    try {
      permanentScope = projectControlPlaneScope(
        claims,
        domainHeader.present ? requestedDomain : undefined,
      );
    } catch (error) {
      if (
        error instanceof IdentityScopeError
        && error.code === "DOMAIN_REQUIRED"
      ) {
        throw scopeError(
          "DEMO_DOMAIN_REQUIRED",
          "An available demo domain is required.",
        );
      }
      if (
        error instanceof IdentityScopeError
        && error.code === "DOMAIN_NOT_ALLOWED"
      ) {
        throw scopeError(
          "DEMO_DOMAIN_NOT_ALLOWED",
          "The requested demo domain is not allowed.",
        );
      }
      throw error;
    }

    if (
      permanentScope.activeDomain
      && availableDomains !== undefined
      && !availableDomainIds(availableDomains).includes(
        permanentScope.activeDomain,
      )
    ) {
      throw scopeError(
        "DEMO_DOMAIN_NOT_ALLOWED",
        "The requested demo domain is not allowed.",
      );
    }

    return {
      ...baseProfile,
      domain: permanentScope.activeDomain,
      domains: [...permanentScope.allowedDomains],
    };
  }

  const role = roleHeader.value;

  let domain = null;
  if (domainHeader.present) {
    const roleDomains =
      (role === "lead" || role === "builder")
      && availableDemoDomains !== undefined
        ? availableDemoDomains
        : availableDomains;
    const roleDomainIds = availableDomainIds(roleDomains)
      .filter((id) =>
        (role !== "lead" && role !== "builder")
        || (id !== "platform" && id !== "shared"));
    if (
      !requestedDomain
      || !roleDomainIds.includes(requestedDomain)
    ) {
      throw scopeError(
        "DEMO_DOMAIN_NOT_ALLOWED",
        "The requested demo domain is not allowed.",
      );
    }
    domain = requestedDomain;
  }

  return {
    ...baseProfile,
    role,
    domain,
    domains: domain ? [domain] : [],
    capabilities: [...capabilitiesForRole(role)],
    assumedRole: role,
    demoRoleActive: true,
  };
}

export function projectControlPlaneScope(claims = {}, activeDomain) {
  const identity = projectIdentity(claims);
  const domainWasSupplied =
    activeDomain !== undefined && activeDomain !== null;
  const requestedDomain = normalizedDomain(activeDomain);

  if (
    domainWasSupplied
    && !requestedDomain
  ) {
    throw scopeError(
      "DOMAIN_NOT_ALLOWED",
      "The active domain is not allowed.",
    );
  }

  if (identity.role === "user") {
    if (!domainWasSupplied) {
      throw scopeError(
        "DOMAIN_REQUIRED",
        "An allowed active domain is required.",
      );
    }
    throw scopeError(
      "DOMAIN_NOT_ALLOWED",
      "The active domain is not allowed.",
    );
  }

  if (identity.role === "admin") {
    return {
      role: identity.role,
      allowedDomains: identity.domains,
      activeDomain: requestedDomain,
    };
  }

  if (identity.domains.length === 0) {
    throw scopeError(
      "DOMAIN_REQUIRED",
      "An allowed active domain is required.",
    );
  }
  if (requestedDomain && !identity.domains.includes(requestedDomain)) {
    throw scopeError(
      "DOMAIN_NOT_ALLOWED",
      "The active domain is not allowed.",
    );
  }
  if (!requestedDomain && identity.domains.length > 1) {
    throw scopeError(
      "DOMAIN_REQUIRED",
      "An allowed active domain is required.",
    );
  }

  return {
    role: identity.role,
    allowedDomains: identity.domains,
    activeDomain: requestedDomain || identity.domains[0],
  };
}
