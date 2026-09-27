import {
  DynamoDBClient,
  QueryCommand,
} from "@aws-sdk/client-dynamodb";
import {
  IdentityScopeError,
  ownStringClaim,
  preflightEffectiveIdentity,
  projectEffectiveIdentity,
  verifyCurrentDemoOperator,
} from "./identity.mjs";
import {
  RESERVED_DOMAIN_IDS,
} from "../authz/capabilities.mjs";

const ERROR_DEFINITIONS = {
  NOT_AUTHENTICATED: {
    statusCode: 401,
    message: "Sign in is required.",
    retryable: false,
  },
  DEMO_ROLE_NOT_ALLOWED: {
    statusCode: 403,
    message: "The requested demo role is not allowed.",
    retryable: false,
  },
  DEMO_DOMAIN_REQUIRED: {
    statusCode: 403,
    message: "An available demo domain is required.",
    retryable: false,
  },
  DEMO_DOMAIN_NOT_ALLOWED: {
    statusCode: 403,
    message: "The requested demo domain is not allowed.",
    retryable: false,
  },
  DEMO_CONTEXT_UNAVAILABLE: {
    statusCode: 503,
    message: "Demo role context is temporarily unavailable.",
    retryable: true,
  },
  DOMAIN_DIRECTORY_UNAVAILABLE: {
    statusCode: 503,
    message: "Your available domains could not be loaded. Try again.",
    retryable: true,
  },
  ROUTE_NOT_FOUND: {
    statusCode: 404,
    message: "The requested route is not available.",
    retryable: false,
  },
};
const DOMAIN_ID_PATTERN = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;
const DOMAIN_STATE_MAX_ITEMS = 100;
const DOMAIN_STATE_MAX_PAGES = 10;
const DOMAIN_STATE_TIMEOUT_MS = 1_000;

function response(statusCode, body) {
  return {
    statusCode,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
    body: JSON.stringify(body),
  };
}

function errorResponse(code, requestId) {
  const definition = ERROR_DEFINITIONS[code]
    || ERROR_DEFINITIONS.DEMO_CONTEXT_UNAVAILABLE;
  return response(definition.statusCode, {
    ok: false,
    code: ERROR_DEFINITIONS[code] ? code : "DEMO_CONTEXT_UNAVAILABLE",
    message: definition.message,
    requestId,
    retryable: definition.retryable,
  });
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

function ownString(value, key) {
  if (!isPlainObject(value) || !Object.hasOwn(value, key)) {
    return null;
  }
  const field = value[key];
  if (typeof field !== "string") return null;
  const normalized = field.trim();
  return normalized || null;
}

function attributeString(item, key) {
  if (!isPlainObject(item) || !Object.hasOwn(item, key)) {
    throw new Error("Platform domain state is malformed.");
  }
  const attribute = item[key];
  if (
    !isPlainObject(attribute)
    || Object.keys(attribute).length !== 1
    || typeof attribute.S !== "string"
  ) {
    throw new Error("Platform domain state is malformed.");
  }
  return attribute.S;
}

function domainFromItem(item) {
  if (
    !isPlainObject(item)
    || Object.keys(item).length !== 6
    || ![
      "pk",
      "sk",
      "entityType",
      "id",
      "name",
      "status",
    ].every((key) => Object.hasOwn(item, key))
  ) {
    throw new Error("Platform domain state is malformed.");
  }
  const id = attributeString(item, "id");
  if (
    attributeString(item, "pk") !== "DOMAIN"
    || attributeString(item, "sk") !== `DOMAIN#${id}`
    || attributeString(item, "entityType") !== "DOMAIN"
  ) {
    throw new Error("Platform domain state is malformed.");
  }
  return {
    id,
    name: attributeString(item, "name"),
    status: attributeString(item, "status"),
  };
}

function lastDomainKey(value) {
  if (value === undefined) return undefined;
  if (
    !isPlainObject(value)
    || Object.keys(value).length !== 2
    || !Object.hasOwn(value, "pk")
    || !Object.hasOwn(value, "sk")
    || attributeString(value, "pk") !== "DOMAIN"
    || !attributeString(value, "sk").startsWith("DOMAIN#")
  ) {
    throw new Error("Platform domain state is malformed.");
  }
  return value;
}

function abortError() {
  const error = new Error("Platform domain state request was aborted.");
  error.name = "AbortError";
  return error;
}

function waitForAbortablePromise(promise, abortSignal) {
  if (abortSignal.aborted) {
    return Promise.reject(abortError());
  }
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      reject(abortError());
    };
    const cleanup = () => {
      abortSignal.removeEventListener("abort", onAbort);
    };
    abortSignal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve(promise).then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error) => {
        cleanup();
        reject(error);
      },
    );
  });
}

function createDynamoDomainState({ tableName, dynamo }) {
  if (
    typeof tableName !== "string"
    || !tableName.trim()
    || !dynamo
    || typeof dynamo.send !== "function"
  ) {
    throw new Error("Platform domain state configuration is unavailable.");
  }
  const normalizedTableName = tableName.trim();
  return {
    async listDomains({ abortSignal }) {
      const domains = [];
      const seenKeys = new Set();
      let pageCount = 0;
      let exclusiveStartKey;
      do {
        if (pageCount >= DOMAIN_STATE_MAX_PAGES) {
          throw new Error("Platform domain state exceeds its page limit.");
        }
        const remainingItems = DOMAIN_STATE_MAX_ITEMS - domains.length;
        const queryLimit = remainingItems === 0 ? 1 : remainingItems;
        const result = await waitForAbortablePromise(
          dynamo.send(
            new QueryCommand({
              TableName: normalizedTableName,
              KeyConditionExpression: "#pk = :pk",
              ExpressionAttributeNames: {
                "#entityType": "entityType",
                "#id": "id",
                "#name": "name",
                "#pk": "pk",
                "#sk": "sk",
                "#status": "status",
              },
              ExpressionAttributeValues: {
                ":pk": { S: "DOMAIN" },
              },
              ProjectionExpression:
                "#pk, #sk, #entityType, #id, #name, #status",
              Select: "SPECIFIC_ATTRIBUTES",
              Limit: queryLimit,
              ConsistentRead: true,
              ScanIndexForward: true,
              ...(exclusiveStartKey
                ? { ExclusiveStartKey: exclusiveStartKey }
                : {}),
            }),
            { abortSignal },
          ),
          abortSignal,
        );
        pageCount += 1;
        if (!isPlainObject(result)) {
          throw new Error("Platform domain state is malformed.");
        }
        const items = result.Items ?? [];
        if (
          !Array.isArray(items)
          || items.length > queryLimit
        ) {
          throw new Error("Platform domain state is malformed.");
        }
        if (remainingItems === 0 && items.length > 0) {
          throw new Error("Platform domain state exceeds its item limit.");
        }
        if (remainingItems > 0) {
          domains.push(...items.map(domainFromItem));
        }
        exclusiveStartKey = lastDomainKey(result.LastEvaluatedKey);
        if (exclusiveStartKey) {
          const serialized = JSON.stringify(exclusiveStartKey);
          if (seenKeys.has(serialized)) {
            throw new Error("Platform domain state is malformed.");
          }
          seenKeys.add(serialized);
        }
      } while (exclusiveStartKey);
      return domains;
    },
  };
}

async function withDomainStateDeadline(deadlineTimers, operation) {
  const controller = new AbortController();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = deadlineTimers.setTimeout(() => {
      controller.abort();
      reject(new Error("Platform domain state request exceeded its deadline."));
    }, DOMAIN_STATE_TIMEOUT_MS);
  });
  const request = Promise.resolve().then(
    () => operation(controller.signal),
  );
  try {
    return await Promise.race([request, timeout]);
  } catch (error) {
    if (!controller.signal.aborted) {
      controller.abort();
    }
    throw error;
  } finally {
    deadlineTimers.clearTimeout(timer);
  }
}

function defaultDomainStateFactory() {
  return createDynamoDomainState({
    tableName: process.env.PLATFORM_STATE_TABLE_NAME,
    dynamo: new DynamoDBClient({}),
  });
}

function validateDomainState(domainState) {
  if (
    !isPlainObject(domainState)
    || typeof domainState.listDomains !== "function"
  ) {
    throw new TypeError("Domain state must provide listDomains.");
  }
  return domainState;
}

function authoritativeActiveDomains(value) {
  if (!Array.isArray(value)) {
    throw new Error("Platform domain state is malformed.");
  }
  const domains = new Map();
  for (const candidate of value) {
    const id = ownString(candidate, "id");
    const name = ownString(candidate, "name");
    const status = Object.hasOwn(candidate ?? {}, "status")
      ? ownString(candidate, "status")
      : "ACTIVE";
    if (
      !id
      || id.length > 64
      || !DOMAIN_ID_PATTERN.test(id)
      || RESERVED_DOMAIN_IDS.includes(id)
      || !name
      || name.length > 128
      || /[\u0000-\u001f\u007f]/.test(name)
    ) {
      throw new Error("Platform domain state is malformed.");
    }
    if (status !== "ACTIVE") continue;
    const existing = domains.get(id);
    if (existing && existing.name !== name) {
      throw new Error("Platform domain state is malformed.");
    }
    domains.set(id, { id, name });
  }
  return [...domains.values()]
    .sort((left, right) => left.id.localeCompare(right.id));
}

function demoSelectorDomains(domains) {
  return domains.filter(({ id }) => id !== "platform" && id !== "shared");
}

export function createApiHandler({
  deadlineTimers = globalThis,
  demoOperatorVerifier = verifyCurrentDemoOperator,
  domainState,
  domainStateFactory = defaultDomainStateFactory,
} = {}) {
  if (
    domainState !== undefined
    && domainState !== null
  ) {
    validateDomainState(domainState);
  }
  if (typeof domainStateFactory !== "function") {
    throw new TypeError("Domain state factory is invalid.");
  }
  if (typeof demoOperatorVerifier !== "function") {
    throw new TypeError("Demo operator verifier is invalid.");
  }
  if (
    !deadlineTimers
    || typeof deadlineTimers.setTimeout !== "function"
    || typeof deadlineTimers.clearTimeout !== "function"
  ) {
    throw new TypeError("Domain state deadline timers are invalid.");
  }
  let resolvedDomainState = domainState;

  return async function apiHandler(event = {}) {
    const method = event.requestContext?.http?.method || "";
    const path = event.requestContext?.http?.path || "";
    const requestId = event.requestContext?.requestId || "unknown";

    if (method === "GET" && path === "/api/health") {
      return response(200, {
        ok: true,
        service: "agentic-platform-api",
        stage: "web-identity",
      });
    }

    if (method === "GET" && path === "/api/me") {
      const claims = event.requestContext?.authorizer?.jwt?.claims;
      if (
        !ownStringClaim(claims, "sub")
        || ownStringClaim(claims, "token_use") !== "access"
      ) {
        return errorResponse("NOT_AUTHENTICATED", requestId);
      }

      let preflight;
      try {
        preflight = preflightEffectiveIdentity(claims, event.headers);
      } catch (error) {
        if (
          error instanceof IdentityScopeError
          && Object.hasOwn(ERROR_DEFINITIONS, error.code)
          && ERROR_DEFINITIONS[error.code].statusCode === 403
        ) {
          return errorResponse(error.code, requestId);
        }
        return errorResponse("DEMO_CONTEXT_UNAVAILABLE", requestId);
      }

      let currentlyAuthorized = false;
      if (preflight.canSwitchDemoRole) {
        try {
          currentlyAuthorized = await demoOperatorVerifier(claims);
        } catch {
          return errorResponse("DEMO_CONTEXT_UNAVAILABLE", requestId);
        }
        if (
          preflight.roleHeader.present
          && currentlyAuthorized !== true
        ) {
          return errorResponse("DEMO_ROLE_NOT_ALLOWED", requestId);
        }
      }

      const maySwitchDemoRole =
        preflight.canSwitchDemoRole
        && currentlyAuthorized === true;
      const ordinaryScoped = !preflight.canSwitchDemoRole
        && ["lead", "builder"].includes(preflight.authenticatedIdentity.role);
      let availableDomains = [];
      let availableDemoDomains = [];
      if (maySwitchDemoRole || ordinaryScoped) {
        try {
          resolvedDomainState ??= validateDomainState(
            domainStateFactory(),
          );
          availableDomains = authoritativeActiveDomains(
            await withDomainStateDeadline(
              deadlineTimers,
              (abortSignal) => resolvedDomainState.listDomains({
                abortSignal,
              }),
            ),
          );
          availableDemoDomains = maySwitchDemoRole
            ? demoSelectorDomains(availableDomains) : [];
        } catch {
          return errorResponse(ordinaryScoped
            ? "DOMAIN_DIRECTORY_UNAVAILABLE" : "DEMO_CONTEXT_UNAVAILABLE", requestId);
        }
      }

      // Bootstrap is confined to /me. Operational identity projection remains strict.
      if (ordinaryScoped) {
        const availableOrdinaryDomains = availableDomains.filter(({ id }) =>
          preflight.authenticatedIdentity.domains.includes(id));
        const selected = preflight.domainHeader.present
          ? preflight.requestedDomain
          : availableOrdinaryDomains.length === 1
            ? availableOrdinaryDomains[0].id : null;
        if (selected && !availableOrdinaryDomains.some(({ id }) => id === selected)) {
          return errorResponse("DEMO_DOMAIN_NOT_ALLOWED", requestId);
        }
        if (!selected) {
          return response(200, {
            ok: true,
            profileType: "authenticated-unscoped",
            scopeStatus: availableOrdinaryDomains.length ? "selection-required" : "no-access",
            user: preflight.authenticatedIdentity.user,
            name: preflight.authenticatedIdentity.name,
            role: preflight.authenticatedIdentity.role,
            authenticatedRole: preflight.authenticatedIdentity.role,
            identityProvider: "cognito",
            domain: null,
            domains: availableOrdinaryDomains.map(({ id }) => id),
            availableDomains: availableOrdinaryDomains,
            capabilities: [],
            demoRoleActive: false,
            canSwitchDemoRole: false,
            availableDemoRoles: [],
            availableDemoDomains: [],
          });
        }
        try {
          const identity = projectEffectiveIdentity(claims, {
            "x-active-domain": selected,
          }, { availableDomains, demoOperatorAuthorized: false });
          return response(200, {
            ...identity,
            profileType: "scoped",
            scopeStatus: "ready",
            domains: availableOrdinaryDomains.map(({ id }) => id),
            availableDomains: availableOrdinaryDomains,
            availableDemoDomains: [],
          });
        } catch (error) {
          return errorResponse(error instanceof IdentityScopeError
            ? error.code : "DOMAIN_DIRECTORY_UNAVAILABLE", requestId);
        }
      }

      try {
        const identity = projectEffectiveIdentity(
          claims,
          event.headers,
          maySwitchDemoRole
            ? {
                availableDomains,
                availableDemoDomains,
                demoOperatorAuthorized: true,
              }
            : { demoOperatorAuthorized: false },
        );
        return response(200, {
          ...identity,
          availableDemoDomains: maySwitchDemoRole
            ? availableDemoDomains
            : [],
        });
      } catch (error) {
        if (
          error instanceof IdentityScopeError
          && Object.hasOwn(ERROR_DEFINITIONS, error.code)
          && ERROR_DEFINITIONS[error.code].statusCode === 403
        ) {
          return errorResponse(error.code, requestId);
        }
        return errorResponse("DEMO_CONTEXT_UNAVAILABLE", requestId);
      }
    }

    return errorResponse("ROUTE_NOT_FOUND", requestId);
  };
}

export const handler = createApiHandler();
