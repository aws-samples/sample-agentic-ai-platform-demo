import {
  WorkspaceServiceError,
  createWorkspaceService,
} from "./service.mjs";
import { validateProjectResourcePolicy } from "../../../../console/public/project-resource-policy.mjs";
import {
  BedrockAgentCoreControlClient,
  GetMemoryCommand,
} from "@aws-sdk/client-bedrock-agentcore-control";
import {
  BedrockAgentClient,
  GetKnowledgeBaseCommand,
} from "@aws-sdk/client-bedrock-agent";

const ROUTES = Object.freeze({
  "/api/projects": "projects",
  "/api/agents": "agents",
  "/api/deployments": "deployments",
  "/api/approvals": "approvals",
});
const ROLES = new Set(["admin", "lead", "builder", "user"]);
const DOMAIN_ID_PATTERN = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;
const SUBJECT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/;
const MAX_PAGE_SIZE = 50;
const MAX_CURSOR_LENGTH = 4096;
const MAX_DOMAIN_ID_LENGTH = 64;
const MAX_BODY_BYTES = 64 * 1024;
const REQUEST_ID_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/;
const PROJECT_ID_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;
const DEFAULT_TIMEOUT_MS = 1_500;

const ERROR_DEFINITIONS = Object.freeze({
  NOT_AUTHENTICATED: {
    statusCode: 401,
    message: "Sign in is required.",
    retryable: false,
  },
  INVALID_REQUEST: {
    statusCode: 400,
    message: "The workspace request is invalid.",
    retryable: false,
  },
  INVALID_QUERY: {
    statusCode: 400,
    message: "The workspace query is invalid.",
    retryable: false,
  },
  INVALID_REQUEST_ID: {
    statusCode: 400,
    message: "A valid idempotency request ID is required.",
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
  FORBIDDEN: {
    statusCode: 403,
    message: "The requested operation is not allowed.",
    retryable: false,
  },
  NOT_FOUND: {
    statusCode: 404,
    message: "Resource not found.",
    retryable: false,
  },
  CONFLICT: {
    statusCode: 409,
    message: "The resource state does not permit this operation.",
    retryable: false,
  },
  IDENTITY_UNAVAILABLE: {
    statusCode: 503,
    message: "Identity context is temporarily unavailable.",
    retryable: true,
  },
  WORKSPACE_UNAVAILABLE: {
    statusCode: 503,
    message: "Workspace inventory is temporarily unavailable.",
    retryable: true,
  },
  WORKSPACE_TIMEOUT: {
    statusCode: 504,
    message: "The workspace request timed out.",
    retryable: true,
  },
  ROUTE_NOT_FOUND: {
    statusCode: 404,
    message: "The requested route is not available.",
    retryable: false,
  },
});

class WorkspaceTimeoutError extends Error {
  constructor() {
    super("Workspace request timed out.");
    this.name = "WorkspaceTimeoutError";
  }
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
  if (!isPlainObject(value) || !Object.hasOwn(value, key)) return null;
  const field = value[key];
  if (
    typeof field !== "string"
    || field.length === 0
    || field !== field.trim()
    || /[\u0000-\u001f\u007f]/.test(field)
  ) {
    return null;
  }
  return field;
}

function validDomainId(value) {
  return (
    typeof value === "string"
    && value.length <= MAX_DOMAIN_ID_LENGTH
    && DOMAIN_ID_PATTERN.test(value)
  );
}

function singleIdentityDomain(identity) {
  const descriptor = Object.getOwnPropertyDescriptor(identity, "domains");
  if (!descriptor || !Object.hasOwn(descriptor, "value")) return null;
  const domains = descriptor.value;
  if (!Array.isArray(domains) || domains.length !== 1) return null;
  const domain = Object.getOwnPropertyDescriptor(domains, "0");
  return domain
    && Object.hasOwn(domain, "value")
    && validDomainId(domain.value)
    ? domain.value
    : null;
}

function response(statusCode, value) {
  return {
    statusCode,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
    body: JSON.stringify(value),
  };
}

function errorResponse(code, requestId) {
  const detail = ERROR_DEFINITIONS[code]
    || ERROR_DEFINITIONS.WORKSPACE_UNAVAILABLE;
  return response(detail.statusCode, {
    ok: false,
    code: ERROR_DEFINITIONS[code] ? code : "WORKSPACE_UNAVAILABLE",
    message: detail.message,
    requestId,
    retryable: detail.retryable,
  });
}

function singleHeader(headers, name) {
  if (headers === undefined || headers === null) {
    return { present: false, value: null };
  }
  if (!isPlainObject(headers)) {
    return { invalid: true, present: false, value: null };
  }
  const keys = Object.keys(headers)
    .filter((key) => key.toLowerCase() === name);
  if (keys.length > 1) {
    return { invalid: true, present: false, value: null };
  }
  if (keys.length === 0) {
    return { present: false, value: null };
  }
  const value = headers[keys[0]];
  if (
    typeof value !== "string"
    || value.length === 0
    || value !== value.trim()
    || /[\u0000-\u001f\u007f]/.test(value)
  ) {
    return { invalid: true, present: true, value: null };
  }
  return { present: true, value };
}

function parseQuery(event) {
  const query = event.queryStringParameters;
  if (
    query !== undefined
    && query !== null
    && !isPlainObject(query)
  ) {
    return null;
  }
  const values = query ?? {};
  const keys = Object.keys(values);
  if (keys.some((key) => !["limit", "cursor"].includes(key))) return null;
  if (keys.some((key) => typeof values[key] !== "string")) return null;

  if (
    event.rawQueryString !== undefined
    && typeof event.rawQueryString !== "string"
  ) {
    return null;
  }
  if (typeof event.rawQueryString === "string") {
    const raw = new URLSearchParams(event.rawQueryString);
    const rawKeys = [...raw.keys()];
    if (
      rawKeys.some((key) => !["limit", "cursor"].includes(key))
      || new Set(rawKeys).size !== rawKeys.length
      || rawKeys.length !== keys.length
      || rawKeys.some((key) => raw.get(key) !== values[key])
    ) {
      return null;
    }
  }

  let limit = 20;
  if (Object.hasOwn(values, "limit")) {
    if (!/^[1-9][0-9]?$/.test(values.limit)) return null;
    limit = Number(values.limit);
    if (limit > MAX_PAGE_SIZE) return null;
  }
  if (
    Object.hasOwn(values, "cursor")
    && (
      values.cursor.length === 0
      || values.cursor.length > MAX_CURSOR_LENGTH
      || !/^[A-Za-z0-9_-]+$/.test(values.cursor)
    )
  ) {
    return null;
  }
  return {
    limit,
    ...(Object.hasOwn(values, "cursor")
      ? { cursor: values.cursor }
      : {}),
  };
}

function hasNoQuery(event) {
  const query = event.queryStringParameters;
  if (
    query !== undefined
    && query !== null
    && (
      !isPlainObject(query)
      || Object.keys(query).length !== 0
    )
  ) {
    return false;
  }
  return (
    event.rawQueryString === undefined
    || event.rawQueryString === null
    || event.rawQueryString === ""
  );
}

function decodeBody(event) {
  if (typeof event.body !== "string" || event.body.length === 0) return null;
  let bytes;
  if (event.isBase64Encoded === true) {
    if (
      event.body.length % 4 !== 0
      || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
        event.body,
      )
    ) {
      return null;
    }
    bytes = Buffer.from(event.body, "base64");
    if (bytes.toString("base64") !== event.body) return null;
  } else {
    bytes = Buffer.from(event.body, "utf8");
  }
  if (bytes.length > MAX_BODY_BYTES) return null;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const value = JSON.parse(text);
    return isPlainObject(value) ? value : null;
  } catch {
    return null;
  }
}

function validateProjectBody(value) {
  if (
    !isPlainObject(value)
    || Object.keys(value).filter(key => key !== "resourcePolicy").sort().join(",")
      !== "description,id,name"
    || typeof value.id !== "string"
    || !PROJECT_ID_PATTERN.test(value.id)
    || typeof value.name !== "string"
    || value.name.length === 0
    || value.name.length > 128
    || value.name !== value.name.trim()
    || /[\u0000-\u001f\u007f]/.test(value.name)
    || typeof value.description !== "string"
    || value.description.length > 4096
    || value.description !== value.description.trim()
    || /[\u0000-\u001f\u007f]/.test(value.description)
  ) {
    return null;
  }
  let resourcePolicy;
  if (Object.hasOwn(value, "resourcePolicy")) {
    try { resourcePolicy = validateProjectResourcePolicy(value.resourcePolicy); }
    catch { return null; }
  }
  return {
    id: value.id,
    name: value.name,
    description: value.description,
    ...(resourcePolicy !== undefined ? { resourcePolicy } : {}),
  };
}

function validateAuthenticatedProjection(value, subject) {
  if (
    !isPlainObject(value)
    || value.actor !== subject
    || !ROLES.has(value.role)
  ) {
    throw new Error("Authenticated identity projection is invalid.");
  }
  return value;
}

function validateEffectiveProjection(
  value,
  subject,
  anticipatedRole,
  activeDomainIds,
) {
  if (
    !isPlainObject(value)
    || value.actor !== subject
    || value.role !== anticipatedRole
    || !ROLES.has(value.role)
  ) {
    throw new Error("Effective identity projection is invalid.");
  }
  if (
    (value.role === "lead" || value.role === "builder")
    && (
      !validDomainId(value.domain)
      || !activeDomainIds.includes(value.domain)
    )
  ) {
    throw new Error("Effective domain projection is invalid.");
  }
  return value;
}

function validateDomains(value) {
  if (!Array.isArray(value)) throw new Error("Domain directory is invalid.");
  const ids = [];
  for (const domain of value) {
    if (
      !isPlainObject(domain)
      || Object.keys(domain).length !== 1
      || !Object.hasOwn(domain, "id")
      || typeof domain.id !== "string"
      || !validDomainId(domain.id)
      || ids.includes(domain.id)
    ) {
      throw new Error("Domain directory is invalid.");
    }
    ids.push(domain.id);
  }
  return ids;
}

function knownIdentityCode(error) {
  if (
    error
    && error.statusCode === 403
    && [
      "DEMO_ROLE_NOT_ALLOWED",
      "DEMO_DOMAIN_REQUIRED",
      "DEMO_DOMAIN_NOT_ALLOWED",
    ].includes(error.code)
  ) {
    return error.code;
  }
  return null;
}

function mapServiceError(error) {
  if (
    error instanceof WorkspaceServiceError
    && Object.hasOwn(ERROR_DEFINITIONS, error.code)
  ) {
    return error.code;
  }
  if (error?.name === "AbortError") return "WORKSPACE_TIMEOUT";
  return "WORKSPACE_UNAVAILABLE";
}

const _projectMemoriesCache = new Map();
const PROJECT_MEMORIES_TTL_MS = 60_000;

function configuredProjectMemories(agents, domainId, projectId) {
  const scoped = agents.filter(
    (agent) =>
      agent.domainId === domainId
      && agent.projectId === projectId,
  );
  const memoryIds = new Set(scoped.flatMap((agent) => agent.memoryIds));
  const knowledgeBaseIds = new Set(
    scoped.flatMap((agent) => agent.knowledgeBaseIds),
  );
  return {
    memories: [...memoryIds].map((memoryId) => ({
      name: memoryId,
      memoryId,
      strategies: [],
      status: null,
    })),
    knowledgeBases: [...knowledgeBaseIds].map((knowledgeBaseId) => ({
      name: knowledgeBaseId,
      knowledgeBaseId,
      status: null,
    })),
  };
}

async function fetchConfiguredProjectMemoriesLive(configured, region) {
  const agentCoreClient = new BedrockAgentCoreControlClient({ region });
  const bedrockAgentClient = new BedrockAgentClient({ region });

  const memories = await Promise.all(
    configured.memories.map(async (memory) => {
      try {
        const res = await agentCoreClient.send(
          new GetMemoryCommand({ memoryId: memory.memoryId }),
        );
        return {
          ...memory,
          name: res.memory?.name ?? memory.name,
          status: res.memory?.status ?? res.status ?? null,
        };
      } catch {
        return memory;
      }
    }),
  );
  const knowledgeBases = await Promise.all(
    configured.knowledgeBases.map(async (knowledgeBase) => {
      try {
        const res = await bedrockAgentClient.send(
          new GetKnowledgeBaseCommand({
            knowledgeBaseId: knowledgeBase.knowledgeBaseId,
          }),
        );
        return {
          ...knowledgeBase,
          name: res.knowledgeBase?.name ?? knowledgeBase.name,
          status: res.knowledgeBase?.status ?? null,
        };
      } catch {
        return knowledgeBase;
      }
    }),
  );
  return { memories, knowledgeBases };
}

async function getConfiguredProjectMemories({
  agents,
  domainId,
  projectId,
  region,
}) {
  const configured = configuredProjectMemories(
    agents,
    domainId,
    projectId,
  );
  const cacheKey = JSON.stringify([
    region,
    domainId,
    projectId,
    configured.memories.map(({ memoryId }) => memoryId),
    configured.knowledgeBases.map(({ knowledgeBaseId }) => knowledgeBaseId),
  ]);
  const now = Date.now();
  const cached = _projectMemoriesCache.get(cacheKey);
  if (cached && now - cached.at < PROJECT_MEMORIES_TTL_MS) {
    return cached.data;
  }
  const data = await fetchConfiguredProjectMemoriesLive(configured, region);
  _projectMemoriesCache.set(cacheKey, { at: now, data });
  return data;
}

async function collectWorkspaceItems(read, input) {
  const items = [];
  const seen = new Set();
  let cursor;
  do {
    const page = await read({
      ...input,
      limit: MAX_PAGE_SIZE,
      ...(cursor ? { cursor } : {}),
    });
    items.push(...page.items);
    cursor = page.cursor;
    if (cursor && seen.has(cursor)) {
      throw new Error("Workspace pagination repeated a cursor.");
    }
    if (cursor) seen.add(cursor);
  } while (cursor);
  return items;
}

export function createWorkspaceHandler({
  identityProjector,
  identityVerifier,
  domainDirectory,
  workspaceState,
  authorizer,
  projectResourceValidator,
  projectMemoriesProvider = getConfiguredProjectMemories,
  region = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || "us-west-2",
  timeoutMs = DEFAULT_TIMEOUT_MS,
  projectCreateTimeoutMs = timeoutMs,
  deadlineTimers = globalThis,
} = {}) {
  if (
    !identityProjector
    || typeof identityProjector.projectAuthenticated !== "function"
    || typeof identityProjector.projectEffective !== "function"
  ) {
    throw new TypeError("Identity projector is invalid.");
  }
  if (typeof identityVerifier !== "function") {
    throw new TypeError("Identity verifier is invalid.");
  }
  if (
    !domainDirectory
    || typeof domainDirectory.listActiveDomains !== "function"
  ) {
    throw new TypeError("Domain directory is invalid.");
  }
  if (
    typeof projectMemoriesProvider !== "function"
    ||
    !Number.isSafeInteger(projectCreateTimeoutMs)
    || projectCreateTimeoutMs < 1
    || projectCreateTimeoutMs > 30_000
    || !Number.isSafeInteger(timeoutMs)
    || timeoutMs < 1
    || timeoutMs > 30_000
    || !deadlineTimers
    || typeof deadlineTimers.setTimeout !== "function"
    || typeof deadlineTimers.clearTimeout !== "function"
  ) {
    throw new TypeError("Workspace timeout configuration is invalid.");
  }

  const service = createWorkspaceService({
    workspaceState,
    authorizer,
    projectResourceValidator,
  });

  return async function workspaceHandler(event = {}) {
    const method = event.requestContext?.http?.method || "";
    const path = event.requestContext?.http?.path || "";
    const requestId = event.requestContext?.requestId || "unknown";
    const resource = ROUTES[path];
    const isProjectCreate = method === "POST" && path === "/api/projects";
    const isProjectMemories =
      method === "GET" && path === "/api/project-memories";

    if (!resource && !isProjectMemories) {
      return errorResponse("ROUTE_NOT_FOUND", requestId);
    }
    if (method !== "GET" && !isProjectCreate) {
      return errorResponse("INVALID_REQUEST", requestId);
    }
    let query;
    let requestBody;
    if (isProjectCreate) {
      if (!hasNoQuery(event)) {
        return errorResponse("INVALID_REQUEST", requestId);
      }
      requestBody = validateProjectBody(decodeBody(event));
      if (!requestBody) return errorResponse("INVALID_REQUEST", requestId);
    } else if (isProjectMemories) {
      if (event.body !== undefined && event.body !== null) {
        return errorResponse("INVALID_REQUEST", requestId);
      }
      // project param is validated after auth
    } else {
      if (event.body !== undefined && event.body !== null) {
        return errorResponse("INVALID_REQUEST", requestId);
      }
      query = parseQuery(event);
      if (!query) return errorResponse("INVALID_QUERY", requestId);
    }

    const requestClaims = event.requestContext?.authorizer?.jwt?.claims;
    const subject = ownString(requestClaims, "sub");
    if (
      !subject
      || !SUBJECT_PATTERN.test(subject)
      || ownString(requestClaims, "token_use") !== "access"
    ) {
      return errorResponse("NOT_AUTHENTICATED", requestId);
    }

    let authenticated;
    try {
      authenticated = validateAuthenticatedProjection(
        identityProjector.projectAuthenticated(requestClaims),
        subject,
      );
    } catch {
      return errorResponse("IDENTITY_UNAVAILABLE", requestId);
    }

    const roleHeader = singleHeader(event.headers, "x-demo-role");
    const domainHeader = singleHeader(event.headers, "x-active-domain");
    const mutationRequestHeader = isProjectCreate
      ? singleHeader(event.headers, "x-request-id")
      : { present: false, value: null };
    if (roleHeader.invalid) {
      return errorResponse("DEMO_ROLE_NOT_ALLOWED", requestId);
    }
    if (domainHeader.invalid) {
      return errorResponse("DEMO_DOMAIN_NOT_ALLOWED", requestId);
    }
    if (
      isProjectCreate
      && (
        mutationRequestHeader.invalid
        || !mutationRequestHeader.present
        || !REQUEST_ID_PATTERN.test(mutationRequestHeader.value)
      )
    ) {
      return errorResponse("INVALID_REQUEST_ID", requestId);
    }

    let anticipatedRole = roleHeader.present
      ? null
      : authenticated.role;
    const permanentDomain =
      !roleHeader.present
      && (anticipatedRole === "lead" || anticipatedRole === "builder")
        ? singleIdentityDomain(authenticated)
        : null;
    if (
      !roleHeader.present
      && anticipatedRole === "user"
      && !isProjectCreate
    ) {
      return errorResponse("FORBIDDEN", requestId);
    }
    if (
      !roleHeader.present
      &&
      (anticipatedRole === "lead" || anticipatedRole === "builder")
      && !domainHeader.present
      && permanentDomain === null
    ) {
      return errorResponse("DEMO_DOMAIN_REQUIRED", requestId);
    }

    const abortController = new AbortController();
    let timeoutHandle;
    const timeout = new Promise((_, reject) => {
      timeoutHandle = deadlineTimers.setTimeout(() => {
        abortController.abort();
        reject(new WorkspaceTimeoutError());
      }, isProjectCreate ? projectCreateTimeoutMs : timeoutMs);
    });

    const operation = (async () => {
      if (roleHeader.present) {
        let verified;
        try {
          verified = await identityVerifier(requestClaims, {
            abortSignal: abortController.signal,
          });
        } catch (error) {
          if (abortController.signal.aborted) throw error;
          throw Object.assign(new Error("Identity unavailable."), {
            workspaceCode: "IDENTITY_UNAVAILABLE",
          });
        }
        if (verified !== true || !ROLES.has(roleHeader.value)) {
          throw Object.assign(new Error("Demo role not allowed."), {
            workspaceCode: "DEMO_ROLE_NOT_ALLOWED",
          });
        }
        anticipatedRole = roleHeader.value;
        if (anticipatedRole === "user" && !isProjectCreate) {
          throw Object.assign(new Error("Forbidden."), {
            workspaceCode: "FORBIDDEN",
          });
        }
        if (
          (anticipatedRole === "lead" || anticipatedRole === "builder")
          && !domainHeader.present
        ) {
          throw Object.assign(new Error("Demo domain required."), {
            workspaceCode: "DEMO_DOMAIN_REQUIRED",
          });
        }
      }

      if (isProjectCreate) {
        if (
          anticipatedRole === "user"
          && domainHeader.present
        ) {
          throw Object.assign(new Error("Demo domain not allowed."), {
            workspaceCode: "DEMO_DOMAIN_NOT_ALLOWED",
          });
        }
        const provisionalDomain =
          anticipatedRole === "lead" || anticipatedRole === "builder"
            ? (
              domainHeader.present
                ? domainHeader.value
                : permanentDomain
            )
            : null;
        if (
          provisionalDomain !== null
          && !validDomainId(provisionalDomain)
        ) {
          throw Object.assign(new Error("Demo domain not allowed."), {
            workspaceCode: "DEMO_DOMAIN_NOT_ALLOWED",
          });
        }
        await service.preauthorizeProjectCreate({
          identity: {
            actor: subject,
            role: anticipatedRole,
            activeDomain: provisionalDomain,
            domainIds: anticipatedRole === "admin"
              ? ["platform"]
              : provisionalDomain === null
                ? []
                : [provisionalDomain],
          },
          requestId: mutationRequestHeader.value,
          payload: requestBody,
          abortSignal: abortController.signal,
        });
      }

      const activeDomains = await domainDirectory.listActiveDomains({
        abortSignal: abortController.signal,
      });
      const activeDomainIds = validateDomains(activeDomains);

      let effective;
      try {
        effective = validateEffectiveProjection(
          identityProjector.projectEffective(
            requestClaims,
            event.headers,
            {
              availableDomains: activeDomains,
              availableDemoDomains: activeDomains,
            },
          ),
          subject,
          anticipatedRole,
          activeDomainIds,
        );
      } catch (error) {
        const code = knownIdentityCode(error);
        if (code) throw Object.assign(new Error(code), { workspaceCode: code });
        throw Object.assign(new Error("Identity unavailable."), {
          workspaceCode: "IDENTITY_UNAVAILABLE",
        });
      }

      const identity = {
        actor: subject,
        role: effective.role,
        activeDomain: effective.role === "admin"
          ? (effective.domain ?? null)
          : effective.role === "user"
            ? null
            : effective.domain,
        domainIds: effective.role === "admin"
          ? activeDomainIds
          : effective.role === "user"
            ? []
            : [effective.domain],
      };
      if (isProjectMemories) {
        const projectId = ownString(
          event.queryStringParameters ?? {},
          "project",
        );
        if (!projectId || !PROJECT_ID_PATTERN.test(projectId)) {
          throw Object.assign(new Error("Project param required."), {
            workspaceCode: "INVALID_QUERY",
          });
        }

        const visibleProjects = await collectWorkspaceItems(
          (request) => service.listProjects(request),
          { identity, abortSignal: abortController.signal },
        );
        const workspaceDomain = identity.role === "admin"
          ? "platform"
          : identity.activeDomain;
        const project = visibleProjects.find(
          (candidate) =>
            candidate.id === projectId
            && candidate.domainId === workspaceDomain,
        );
        if (!project) {
          throw Object.assign(new Error("Project not found."), {
            workspaceCode: "NOT_FOUND",
          });
        }

        const data = await projectMemoriesProvider({
          agents: await collectWorkspaceItems(
            (request) => service.listAgents(request),
            { identity, abortSignal: abortController.signal },
          ),
          domainId: project.domainId,
          projectId: project.id,
          region,
        });
        return response(200, {
          ok: true,
          resource: "project-memories",
          projectId,
          memories: data.memories,
          knowledgeBases: data.knowledgeBases,
        });
      }
      if (isProjectCreate) {
        const project = await service.createProject({
          identity,
          requestId: mutationRequestHeader.value,
          payload: requestBody,
          abortSignal: abortController.signal,
        });
        return response(201, {
          ok: true,
          resource: "project",
          project,
        });
      }
      const result = await service[`list${
        resource[0].toUpperCase()
      }${resource.slice(1)}`]({
        identity,
        ...query,
        abortSignal: abortController.signal,
      });
      return response(200, {
        ok: true,
        resource,
        items: result.items,
        cursor: result.cursor,
      });
    })();

    try {
      return await Promise.race([operation, timeout]);
    } catch (error) {
      if (error instanceof WorkspaceTimeoutError) {
        return errorResponse("WORKSPACE_TIMEOUT", requestId);
      }
      if (error?.workspaceCode) {
        return errorResponse(error.workspaceCode, requestId);
      }
      return errorResponse(mapServiceError(error), requestId);
    } finally {
      deadlineTimers.clearTimeout(timeoutHandle);
    }
  };
}
