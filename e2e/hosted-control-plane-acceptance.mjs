import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  fileURLToPath,
  pathToFileURL,
} from "node:url";
import { isDeepStrictEqual } from "node:util";
import {
  InvokeCommand,
  LambdaClient,
} from "@aws-sdk/client-lambda";
import {
  isAwsCliUserNotFound,
  runAwsCli,
} from "../infra/serverless-platform/scripts/seed-demo-users.mjs";

const MANAGED_BY = "agentic-ai-platform-demo";
const CANONICAL_REGISTRY_STORE =
  "AWS Agent Registry + AgentCore Gateway";
const CANONICAL_REGISTRY_TYPES = Object.freeze([
  "Skill",
  "MCPServer",
  "A2AAgent",
  "Agent",
  "Model",
  "Blueprint",
]);
const CANONICAL_REGISTRY_STATUSES = Object.freeze([
  "DRAFT",
  "IN_REVIEW",
  "APPROVED",
  "REJECTED",
  "DEPRECATED",
]);
const REQUIRED_REGISTRY_TYPES = Object.freeze([
  "Blueprint",
  "Skill",
  "Model",
  "MCPServer",
]);
const VIEWPORTS = Object.freeze([
  { name: "desktop", width: 1440, height: 950 },
  { name: "mobile", width: 390, height: 844 },
]);
const DEFAULT_OPERATION_TIMEOUT_MS = 20_000;
const BROKER_LAMBDA_TIMEOUT_MS = 120_000;
const DEFAULT_RESOURCE_OPERATION_TIMEOUT_MS = 150_000;
const DEFAULT_BROWSER_PROCESS_TERMINATION_TIMEOUT_MS = 5_000;
const DEFAULT_CLEANUP_ATTEMPTS = 2;
const DEFAULT_EXTERNAL_CLEANUP_ATTEMPTS = 3;
const DEFAULT_MAX_API_RESPONSE_BYTES = 1_048_576;
const REGISTRY_RELIABILITY_REQUEST_COUNT = 6;
const REGISTRY_REJECTION_REASON = "Hosted acceptance rejection path.";
const MAX_API_REQUEST_BYTES = 65_536;
const MAX_BROKER_REQUEST_BYTES = 65_536;
const MAX_BROKER_RESPONSE_BYTES = 16_384;
const MAX_BROWSER_WORKER_OUTPUT_BYTES = 16_384;
const ACCEPTANCE_TAGS = Object.freeze({
  "auto-delete": "no",
  project: "agentic-ai-platform-demo",
  managedBy: "hosted-acceptance",
});
const BROWSER_ENVIRONMENT_KEYS = Object.freeze([
  "PATH",
  "HOME",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LANGUAGE",
  "LC_ALL",
  "LC_CTYPE",
  "DISPLAY",
  "WAYLAND_DISPLAY",
  "XDG_RUNTIME_DIR",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "PLAYWRIGHT_BROWSERS_PATH",
]);
const DEFAULT_DEADLINE_TIMERS = Object.freeze({
  setTimeout,
  clearTimeout,
});
const DEFAULT_WEB_OUTPUTS_PATH = fileURLToPath(new URL(
  "../infra/serverless-platform/deployment-outputs.json",
  import.meta.url,
));
const DEFAULT_CONTROL_PLANE_OUTPUTS_PATH = fileURLToPath(new URL(
  "../infra/platform-registry/control-plane-outputs.json",
  import.meta.url,
));

class HostedAcceptanceError extends Error {
  constructor(code, message, { cleanupCode, stage } = {}) {
    super(message);
    this.name = "HostedAcceptanceError";
    this.code = code;
    if (stage !== undefined) this.stage = stage;
    if (cleanupCode !== undefined) this.cleanupCode = cleanupCode;
  }
}

function stableFailure(stage, cleanupCode) {
  return new HostedAcceptanceError(
    "HOSTED_ACCEPTANCE_FAILED",
    "Hosted control-plane acceptance failed.",
    { cleanupCode, stage },
  );
}

function cleanupFailure() {
  return new HostedAcceptanceError(
    "HOSTED_ACCEPTANCE_CLEANUP_FAILED",
    "Hosted control-plane acceptance cleanup failed.",
    { stage: "cleanup" },
  );
}

function apiRequestFailure() {
  return new HostedAcceptanceError(
    "HOSTED_API_REQUEST_INVALID",
    "Hosted API request failed.",
  );
}

function requiredString(value, name) {
  if (typeof value !== "string" || !value.trim()) {
    throw new HostedAcceptanceError(
      "HOSTED_ACCEPTANCE_CONFIGURATION_INVALID",
      `Hosted control-plane acceptance requires ${name}.`,
    );
  }
  return value.trim();
}

export function createBrowserEnvironment(environment = {}) {
  const sanitized = {};
  for (const key of BROWSER_ENVIRONMENT_KEYS) {
    const value = environment[key];
    if (typeof value === "string" && value !== "") {
      sanitized[key] = value;
    }
  }
  return sanitized;
}

function validateConfiguration({
  applicationUrl,
  clientId,
  region,
  userPoolId,
}) {
  const normalizedApplicationUrl = requiredString(
    applicationUrl,
    "applicationUrl",
  ).replace(/\/+$/, "");
  const normalizedClientId = requiredString(clientId, "clientId");
  const normalizedRegion = requiredString(region, "region");
  const normalizedUserPoolId = requiredString(userPoolId, "userPoolId");
  let parsedUrl;
  try {
    parsedUrl = new URL(normalizedApplicationUrl);
  } catch {
    throw new HostedAcceptanceError(
      "HOSTED_ACCEPTANCE_CONFIGURATION_INVALID",
      "Hosted control-plane acceptance requires a valid applicationUrl.",
    );
  }
  if (
    parsedUrl.protocol !== "https:"
    || parsedUrl.username
    || parsedUrl.password
    || parsedUrl.search
    || parsedUrl.hash
  ) {
    throw new HostedAcceptanceError(
      "HOSTED_ACCEPTANCE_CONFIGURATION_INVALID",
      "Hosted control-plane acceptance requires a credential-free HTTPS origin.",
    );
  }
  if (
    !/^[a-z]{2}(?:-[a-z0-9]+)+-\d+$/.test(normalizedRegion)
    || !normalizedUserPoolId.startsWith(`${normalizedRegion}_`)
    || !/^[A-Za-z0-9_+]{1,128}$/.test(normalizedClientId)
  ) {
    throw new HostedAcceptanceError(
      "HOSTED_ACCEPTANCE_CONFIGURATION_INVALID",
      "Hosted control-plane acceptance Cognito configuration is invalid.",
    );
  }
  return {
    applicationUrl: normalizedApplicationUrl,
    clientId: normalizedClientId,
    region: normalizedRegion,
    userPoolId: normalizedUserPoolId,
  };
}

function defaultRandomPassword() {
  return `Aa1!${randomBytes(24).toString("base64url")}`;
}

function validPassword(password) {
  return typeof password === "string"
    && password.length >= 14
    && password.length <= 256
    && /[A-Z]/.test(password)
    && /[a-z]/.test(password)
    && /\d/.test(password)
    && /[^A-Za-z0-9]/.test(password);
}

function verifierRunComponent(value, name, maximumLength) {
  const normalized = requiredString(value, name);
  if (
    !/^[1-9][0-9]*$/.test(normalized)
    || normalized.length > maximumLength
  ) {
    throw new HostedAcceptanceError(
      "HOSTED_ACCEPTANCE_CONFIGURATION_INVALID",
      "Hosted control-plane acceptance verifier identity is invalid.",
    );
  }
  return normalized;
}

export function verifierUsernames({
  verifierRunId,
  verifierRunAttempt,
}) {
  const runId = verifierRunComponent(verifierRunId, "verifierRunId", 20);
  const runAttempt = verifierRunComponent(
    verifierRunAttempt,
    "verifierRunAttempt",
    6,
  );
  return [
    `hosted-acceptance-admin-${runId}-${runAttempt}`,
    `hosted-acceptance-isolation-${runId}-${runAttempt}`,
  ];
}

function deterministicUuid(namespace) {
  const bytes = createHash("sha256").update(namespace).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join("-");
}

export function createAcceptanceOwnership({
  verifierRunId,
  verifierRunAttempt,
}) {
  const runId = verifierRunComponent(verifierRunId, "verifierRunId", 20);
  const runAttempt = verifierRunComponent(
    verifierRunAttempt,
    "verifierRunAttempt",
    6,
  );
  const domainName = `Hosted Acceptance ${runId} ${runAttempt}`;
  const domainId = `hosted_acceptance_${runId}_${runAttempt}`;
  const registryEntryId = `hosted-acceptance-${runId}-${runAttempt}`;
  const registryRecordName = `hosted_acceptance_${runId}_${runAttempt}`;
  const registryVersion = "1.0.0";
  const registryDisplayName = `${domainName} Blueprint`;
  const registryDescription =
    `Temporary governance fixture for hosted acceptance run `
    + `${runId} attempt ${runAttempt}.`;
  const registryDescriptor = {
    resourceKind: "blueprint",
    blueprintId: registryEntryId,
    displayName: registryDisplayName,
    useCase: registryDescription,
    template: { framework: "Strands" },
    compat: {},
    version: registryVersion,
    defaultVersion: registryVersion,
    hostedAcceptance: {
      runId,
      runAttempt,
      project: ACCEPTANCE_TAGS.project,
      managedBy: ACCEPTANCE_TAGS.managedBy,
    },
  };
  return {
    runId,
    runAttempt,
    domainName,
    domainId,
    ownerGroup: `domain-hosted-acceptance-${runId}-${runAttempt}`,
    registryEntryId,
    registryRecordName,
    registryVersion,
    registryDisplayName,
    registryDescription,
    registryDescriptor,
    tags: { ...ACCEPTANCE_TAGS },
    fixtureClientToken: deterministicUuid(
      `hosted-acceptance:fixture:${runId}:${runAttempt}`,
    ),
    requestIds: {
      domain: deterministicUuid(
        `hosted-acceptance:domain:${runId}:${runAttempt}`,
      ),
      registry: deterministicUuid(
        `hosted-acceptance:registry:${runId}:${runAttempt}`,
      ),
      isolation: deterministicUuid(
        `hosted-acceptance:isolation:${runId}:${runAttempt}`,
      ),
    },
  };
}

export function createRegistryDecisionOwnerships({
  verifierRunId,
  verifierRunAttempt,
}) {
  const approve = createAcceptanceOwnership({
    verifierRunId,
    verifierRunAttempt,
  });
  const maximumRunId = (10n ** 20n) - 1n;
  let rejectionRunId = (
    BigInt(
      `0x${createHash("sha256")
        .update(
          `hosted-acceptance:registry-reject:${approve.runId}:`
            + approve.runAttempt,
        )
        .digest("hex")}`,
    ) % maximumRunId
  ) + 1n;
  if (rejectionRunId.toString() === approve.runId) {
    rejectionRunId = rejectionRunId === maximumRunId
      ? 1n
      : rejectionRunId + 1n;
  }
  return {
    approve,
    reject: createAcceptanceOwnership({
      verifierRunId: rejectionRunId.toString(),
      verifierRunAttempt: approve.runAttempt,
    }),
  };
}

function validatedOwnership(ownership) {
  if (
    !ownership
    || typeof ownership !== "object"
    || Array.isArray(ownership)
  ) {
    throw new HostedAcceptanceError(
      "HOSTED_ACCEPTANCE_CONFIGURATION_INVALID",
      "Hosted control-plane acceptance ownership is invalid.",
    );
  }
  const expected = createAcceptanceOwnership({
    verifierRunId: ownership.runId,
    verifierRunAttempt: ownership.runAttempt,
  });
  if (!isDeepStrictEqual(ownership, expected)) {
    throw new HostedAcceptanceError(
      "HOSTED_ACCEPTANCE_CONFIGURATION_INVALID",
      "Hosted control-plane acceptance ownership is invalid.",
    );
  }
  return expected;
}

function verifierDefinitions(
  randomPassword,
  { verifierRunId, verifierRunAttempt },
) {
  const [administratorUsername, isolationUsername] = verifierUsernames({
    verifierRunId,
    verifierRunAttempt,
  });
  const verifiers = [
    {
      label: "administrator",
      username: administratorUsername,
      name: "Hosted acceptance administrator",
      groupName: "platform-admin",
    },
    {
      label: "isolation",
      username: isolationUsername,
      name: "Hosted acceptance isolation verifier",
      groupName: "end-user",
    },
  ].map((verifier) => ({
    ...verifier,
    password: randomPassword(verifier.label),
  }));
  if (
    verifiers.some(({ password }) => !validPassword(password))
    || verifiers[0].password === verifiers[1].password
  ) {
    throw new HostedAcceptanceError(
      "HOSTED_ACCEPTANCE_CONFIGURATION_INVALID",
      "Hosted control-plane acceptance password generation failed.",
    );
  }
  return verifiers;
}

function validateAdapters({
  browser,
  cognito,
  fetchImpl,
  randomPassword,
  resources,
}) {
  const cognitoMethods = [
    "adminAddUserToGroup",
    "adminCreateUser",
    "adminDeleteUser",
    "adminInitiateAuth",
    "adminSetUserPassword",
  ];
  if (
    !cognito
    || cognitoMethods.some((method) => typeof cognito[method] !== "function")
    || !browser
    || typeof browser.verifyRegistry !== "function"
    || !resources
    || [
      "cleanupExactResources",
      "createRegistryFixture",
      "persistActorMapping",
      "recoverActorMapping",
      "recoverDomain",
      "recoverRegistryFixture",
    ].some((method) => typeof resources[method] !== "function")
    || typeof fetchImpl !== "function"
    || typeof randomPassword !== "function"
  ) {
    throw new HostedAcceptanceError(
      "HOSTED_ACCEPTANCE_CONFIGURATION_INVALID",
      "Hosted control-plane acceptance adapters are invalid.",
    );
  }
}

function positiveInteger(value, name) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new HostedAcceptanceError(
      "HOSTED_ACCEPTANCE_CONFIGURATION_INVALID",
      `Hosted control-plane acceptance requires a positive ${name}.`,
    );
  }
  return value;
}

function brokerOperationTimeout(value) {
  const timeoutMs = positiveInteger(
    value,
    "resourceOperationTimeoutMs",
  );
  if (timeoutMs <= BROKER_LAMBDA_TIMEOUT_MS) {
    throw new HostedAcceptanceError(
      "HOSTED_ACCEPTANCE_CONFIGURATION_INVALID",
      "Hosted control-plane acceptance requires the resource operation "
        + "timeout to exceed the broker Lambda timeout.",
    );
  }
  return timeoutMs;
}

async function defaultRunWithDeadline(
  operation,
  {
    timeoutMs,
    timers = DEFAULT_DEADLINE_TIMERS,
    controller = new AbortController(),
  },
) {
  let timeout;
  let operationPromise;
  try {
    operationPromise = Promise.resolve(operation(controller.signal));
  } catch (error) {
    operationPromise = Promise.reject(error);
  }
  const deadline = new Promise((_, reject) => {
    timeout = timers.setTimeout(() => {
      controller.abort();
      reject(new Error("Hosted acceptance operation timed out."));
    }, timeoutMs);
  });
  try {
    return await Promise.race([
      operationPromise,
      deadline,
    ]);
  } finally {
    timers.clearTimeout(timeout);
  }
}

async function runStage(
  stage,
  operation,
  {
    deadlineTimers,
    operationTimeoutMs,
    runWithDeadline = defaultRunWithDeadline,
  },
) {
  try {
    return await runWithDeadline(operation, {
      timeoutMs: operationTimeoutMs,
      timers: deadlineTimers,
    });
  } catch (error) {
    throw stableFailure(
      stage,
      error?.cleanupCode === "HOSTED_ACCEPTANCE_CLEANUP_FAILED"
        ? error.cleanupCode
        : undefined,
    );
  }
}

async function retryCleanup(operation, {
  attempts,
  deadlineTimers,
  operationTimeoutMs,
  runWithDeadline = defaultRunWithDeadline,
}) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await runWithDeadline(operation, {
        timeoutMs: operationTimeoutMs,
        timers: deadlineTimers,
      });
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

async function provisionVerifier(cognito, config, verifier, stageOptions) {
  await runStage(`${verifier.label}-create`, () =>
    cognito.adminCreateUser({
      userPoolId: config.userPoolId,
      username: verifier.username,
      messageAction: "SUPPRESS",
      userAttributes: [
        { name: "name", value: verifier.name },
        { name: "custom:managed_by", value: MANAGED_BY },
      ],
    }), stageOptions);
  await runStage(`${verifier.label}-password`, () =>
    cognito.adminSetUserPassword({
      userPoolId: config.userPoolId,
      username: verifier.username,
      password: verifier.password,
      permanent: true,
    }), stageOptions);
  await runStage(`${verifier.label}-group`, () =>
    cognito.adminAddUserToGroup({
      userPoolId: config.userPoolId,
      username: verifier.username,
      groupName: verifier.groupName,
    }), stageOptions);
}

function tokensFromAuthentication(response) {
  const result = response?.AuthenticationResult;
  const expiresIn = Number(result?.ExpiresIn);
  if (
    !result
    || typeof result.AccessToken !== "string"
    || !result.AccessToken
    || typeof result.IdToken !== "string"
    || !result.IdToken
    || !Number.isFinite(expiresIn)
    || expiresIn <= 0
  ) {
    throw new Error("Cognito authentication response was invalid.");
  }
  return {
    accessToken: result.AccessToken,
    idToken: result.IdToken,
    expiresAt: Date.now() + expiresIn * 1_000,
  };
}

async function authenticateVerifier(
  cognito,
  config,
  verifier,
  stageOptions,
) {
  return runStage(`${verifier.label}-authenticate`, async () =>
    tokensFromAuthentication(await cognito.adminInitiateAuth({
      userPoolId: config.userPoolId,
      clientId: config.clientId,
      username: verifier.username,
      password: verifier.password,
      authFlow: "ADMIN_USER_PASSWORD_AUTH",
    })), stageOptions);
}

async function responseJson(response, maximumBytes) {
  if (
    !response
    || typeof response.status !== "number"
    || !response.headers
    || typeof response.headers.get !== "function"
    || typeof response.text !== "function"
  ) {
    throw apiRequestFailure();
  }
  const contentType = response.headers.get("content-type");
  if (
    typeof contentType !== "string"
    || !/^application\/json(?:\s*;|$)/i.test(contentType)
  ) {
    throw apiRequestFailure();
  }
  let text;
  try {
    text = await response.text();
  } catch {
    throw apiRequestFailure();
  }
  if (
    typeof text !== "string"
    || Buffer.byteLength(text) > maximumBytes
  ) {
    throw apiRequestFailure();
  }
  try {
    const body = JSON.parse(text);
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new Error();
    }
    return body;
  } catch {
    throw apiRequestFailure();
  }
}

export async function apiRequest({
  applicationUrl,
  body,
  fetchImpl,
  maxResponseBytes = DEFAULT_MAX_API_RESPONSE_BYTES,
  method = "GET",
  path,
  requestId,
  signal,
  token,
}) {
  if (
    typeof fetchImpl !== "function"
    || !["GET", "POST"].includes(method)
    || typeof applicationUrl !== "string"
    || !/^https:\/\/[^/?#]+(?:\/[^?#]*)?$/.test(applicationUrl)
    || typeof path !== "string"
    || !/^\/api\/[A-Za-z0-9/?=&._~-]+$/.test(path)
    || !meaningfulString(token)
    || !Number.isInteger(maxResponseBytes)
    || maxResponseBytes <= 0
    || maxResponseBytes > DEFAULT_MAX_API_RESPONSE_BYTES
    || (
      requestId !== undefined
      && !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
        .test(requestId)
    )
    || (method === "GET" && body !== undefined)
    || (
      method === "POST"
      && (
        !body
        || typeof body !== "object"
        || Array.isArray(body)
      )
    )
  ) {
    throw apiRequestFailure();
  }
  let serializedBody;
  if (method === "POST") {
    try {
      serializedBody = JSON.stringify(body);
    } catch {
      throw apiRequestFailure();
    }
    if (Buffer.byteLength(serializedBody) > MAX_API_REQUEST_BYTES) {
      throw apiRequestFailure();
    }
  }
  try {
    const response = await fetchImpl(`${applicationUrl}${path}`, {
      method,
      headers: {
        accept: "application/json",
        authorization: `Bearer ${token}`,
        ...(method === "POST"
          ? { "content-type": "application/json" }
          : {}),
        ...(requestId === undefined ? {} : { "x-request-id": requestId }),
      },
      ...(serializedBody === undefined ? {} : { body: serializedBody }),
      signal,
    });
    return {
      response,
      body: await responseJson(response, maxResponseBytes),
    };
  } catch (error) {
    if (
      error instanceof HostedAcceptanceError
      && error.code === "HOSTED_API_REQUEST_INVALID"
    ) {
      throw error;
    }
    throw apiRequestFailure();
  }
}

function representativeRegistryEntries(body) {
  if (
    body?.ok !== true
    || body?.source !== "aws"
    || body.store !== CANONICAL_REGISTRY_STORE
    || !Array.isArray(body.entries)
    || !Array.isArray(body.types)
    || body.types.length !== CANONICAL_REGISTRY_TYPES.length
    || body.types.some(
      (type, index) => type !== CANONICAL_REGISTRY_TYPES[index],
    )
    || !Array.isArray(body.statuses)
    || body.statuses.length !== CANONICAL_REGISTRY_STATUSES.length
    || body.statuses.some(
      (status, index) => status !== CANONICAL_REGISTRY_STATUSES[index],
    )
  ) {
    throw new Error("Registry response did not identify its AWS source.");
  }
  const recordIds = new Set();
  for (const entry of body.entries) {
    const id = typeof entry?.id === "string" ? entry.id.trim() : "";
    if (!id || recordIds.has(id)) {
      throw new Error("Registry response contained invalid record IDs.");
    }
    recordIds.add(id);
  }
  return REQUIRED_REGISTRY_TYPES.map((type) => {
    const entry = body.entries.find((candidate) =>
      candidate?.type === type
      && typeof candidate.name === "string"
      && candidate.name.trim()
    );
    if (!entry) {
      throw new Error("Registry response omitted a required entry type.");
    }
    const gatewayBacked = type === "Model" || type === "MCPServer";
    if (
      gatewayBacked
      && (
        entry._source !== "gateway"
        || !meaningfulString(entry._gateway)
      )
    ) {
      throw new Error(
        "Registry response omitted authoritative AgentCore Gateway provenance.",
      );
    }
    return {
      id: entry.id.trim(),
      name: entry.name.trim(),
      type,
      ...(gatewayBacked
        ? {
            gateway: entry._gateway.trim(),
            source: "gateway",
          }
        : {}),
    };
  });
}

function configuredFixtureRegistryId(body) {
  for (const type of ["Blueprint", "Skill"]) {
    for (const entry of body.entries) {
      if (entry?.type !== type) continue;
      const registryId = entry?._aws?.registryId
        ?? entry?.versions?.find((version) =>
          meaningfulString(version?._aws?.registryId)
        )?._aws?.registryId;
      if (
        typeof registryId === "string"
        && /^[A-Za-z0-9]{12,16}$/.test(registryId)
      ) {
        return registryId;
      }
    }
  }
  throw new Error("Registry response omitted an authoritative fixture Registry.");
}

function meaningfulString(value) {
  return typeof value === "string" && Boolean(value.trim());
}

function requiredAdapterString(value, pattern) {
  return typeof value === "string" && pattern.test(value);
}

function httpsUrl(value) {
  if (!meaningfulString(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && Boolean(url.hostname);
  } catch {
    return false;
  }
}

function uniqueNormalizedIds(items, readId) {
  const ids = new Set();
  for (const item of items) {
    const id = readId(item);
    if (!meaningfulString(id)) return false;
    const normalized = id.trim();
    if (ids.has(normalized)) return false;
    ids.add(normalized);
  }
  return true;
}

function validateAdministratorIdentity(body) {
  if (
    body?.ok !== true
    || body.role !== "admin"
    || body.identityProvider !== "cognito"
    || !meaningfulString(body.user)
    || !meaningfulString(body.username)
    || !meaningfulString(body.name)
    || !Array.isArray(body.groups)
    || !body.groups.includes("platform-admin")
    || !Array.isArray(body.capabilities)
    || !body.capabilities.includes("viewAllDomains")
    || !body.capabilities.includes("manageRegistryEntries")
    || !body.capabilities.includes("approveRegistryVersion")
    || !Array.isArray(body.domains)
    || body.domain !== null
  ) {
    throw new Error("Administrator identity response was invalid.");
  }
}

function validateGateway(body, expectedRegion) {
  const models = body?.models;
  const toolsGateway = body?.toolsGateway;
  const llmGateway = body?.llmGateway;
  const targets = toolsGateway?.targets;
  if (
    body?.ok !== true
    || body.source !== "aws"
    || body.region !== expectedRegion
    || !Array.isArray(models)
    || models.length === 0
    || !Array.isArray(targets)
    || targets.length === 0
    || !meaningfulString(toolsGateway?.gatewayId)
    || !meaningfulString(toolsGateway?.name)
    || !httpsUrl(toolsGateway?.gatewayUrl)
    || !Number.isInteger(toolsGateway?.targetCount)
    || toolsGateway.targetCount !== targets.length
    || !meaningfulString(llmGateway?.gatewayId)
    || !meaningfulString(llmGateway?.name)
    || !httpsUrl(llmGateway?.gatewayUrl)
    || !Number.isInteger(llmGateway?.modelCount)
    || llmGateway.modelCount !== models.length
    || llmGateway.gatewayId.trim() === toolsGateway.gatewayId.trim()
    || !uniqueNormalizedIds(models, (model) => model?.id)
    || !uniqueNormalizedIds(targets, (target) => target?.targetId)
    || models.some((model) =>
      !model
      || typeof model !== "object"
      || !meaningfulString(model.id)
      || !meaningfulString(model.name)
      || model.type !== "Model"
      || !meaningfulString(model.defaultVersion)
      || !Array.isArray(model.versions)
      || model.versions.length === 0
      || !model.versions.some((version) =>
        version?.semver === model.defaultVersion
        && version?.content?.gatewayId === llmGateway.gatewayId
        && version?.content?.gatewayModelId === model.id.trim()
      )
    )
    || targets.some((target) =>
      !target
      || typeof target !== "object"
      || !meaningfulString(target.targetId)
      || !meaningfulString(target.name)
      || !meaningfulString(target.status)
      || !httpsUrl(target.endpoint)
      || target.gatewayIdentifier !== toolsGateway.gatewayId
    )
  ) {
    throw new Error("AI Gateway response was incomplete.");
  }
  if (!targets.some(({ status }) => status.toUpperCase() === "READY")) {
    throw new Error("AI Gateway response had no ready tools target.");
  }
}

async function validateApis({
  applicationUrl,
  fetchImpl,
  adminTokens,
  isolationTokens,
  region,
  stageOptions,
}) {
  const administrator = await runStage("api-me", async (signal) => {
    const me = await apiRequest({
      applicationUrl,
      fetchImpl,
      path: "/api/me",
      signal,
      token: adminTokens.accessToken,
    });
    if (me.response.status !== 200) {
      throw new Error("Administrator identity response was invalid.");
    }
    validateAdministratorIdentity(me.body);
    return me.body;
  }, stageOptions);

  let registryValidation;
  for (
    let request = 0;
    request < REGISTRY_RELIABILITY_REQUEST_COUNT;
    request += 1
  ) {
    registryValidation = await runStage(
      "api-registry",
      async (signal) => {
        const registry = await apiRequest({
          applicationUrl,
          fetchImpl,
          path: "/api/registry",
          signal,
          token: adminTokens.accessToken,
        });
        if (registry.response.status !== 200) {
          throw new Error("Administrator Registry request failed.");
        }
        return {
          fixtureRegistryId: configuredFixtureRegistryId(registry.body),
          representativeEntries: representativeRegistryEntries(registry.body),
        };
      },
      stageOptions,
    );
  }

  await runStage("api-gateway", async (signal) => {
    const gateway = await apiRequest({
      applicationUrl,
      fetchImpl,
      path: "/api/ai-gateway",
      signal,
      token: adminTokens.accessToken,
    });
    if (gateway.response.status !== 200) {
      throw new Error("Administrator AI Gateway request failed.");
    }
    validateGateway(gateway.body, region);
  }, stageOptions);

  const isolated = await runStage("api-isolation", (signal) =>
    apiRequest({
      applicationUrl,
      fetchImpl,
      path: "/api/registry",
      signal,
      token: isolationTokens.accessToken,
    }), stageOptions);
  if (
    isolated.response.status !== 403
    || isolated.body?.code !== "FORBIDDEN"
  ) {
    throw new Error("End-user Registry isolation was not enforced.");
  }
  return {
    administrator,
    ...registryValidation,
  };
}

function expectedDomainPayload(ownership) {
  return {
    name: ownership.domainName,
    owner: `${ownership.domainName} domain team`,
    ownerGroup: ownership.ownerGroup,
    tokenBudget: "",
    description: `${ownership.domainName} domain agents.`,
  };
}

function expectedRegistryDecisionPayload(ownership, decision = "approve") {
  return {
    id: ownership.registryEntryId,
    semver: ownership.registryVersion,
    decision,
    reason: decision === "reject" ? REGISTRY_REJECTION_REASON : "",
  };
}

function exactObjectKeys(value, expectedKeys) {
  return value
    && typeof value === "object"
    && !Array.isArray(value)
    && isDeepStrictEqual(Object.keys(value).sort(), [...expectedKeys].sort());
}

function projectDomainEvidence(domain) {
  return {
    createdBy: domain?.createdBy,
    id: domain?.id,
    name: domain?.name,
    ownerGroup: domain?.ownerGroup,
    registryArn: domain?.registryArn,
    registryId: domain?.registryId,
    status: domain?.status,
  };
}

function projectRegistryEvidence(version) {
  return {
    entryId: version?.entryId ?? version?.id,
    recordId: version?.recordId ?? version?._aws?.recordId,
    registryId: version?.registryId ?? version?._aws?.registryId,
    semver: version?.semver,
    status: version?.status,
  };
}

export function projectBrowserWorkerEvidence(browserResult) {
  const registryVersion = browserResult?.registry
    ?? browserResult?.mutations?.registry?.result?.version;
  const rejectedRegistryVersion = browserResult?.rejectedRegistry
    ?? browserResult?.mutations?.registryRejection?.result?.version;
  return {
    domain: projectDomainEvidence(browserResult?.domain),
    domainRequestId: browserResult?.domainRequestId
      ?? browserResult?.mutations?.domain?.requestId,
    registry: projectRegistryEvidence(registryVersion),
    registryRequestId: browserResult?.registryRequestId
      ?? browserResult?.mutations?.registry?.requestId,
    rejectedRegistry: projectRegistryEvidence(rejectedRegistryVersion),
    rejectedRegistryRequestId:
      browserResult?.rejectedRegistryRequestId
        ?? browserResult?.mutations?.registryRejection?.requestId,
  };
}

function validateBrowserMutationResult({
  actor,
  browserResult,
  ownership,
  rejectionOwnership,
  registryFixture,
  rejectionRegistryFixture,
}) {
  const domain = browserResult?.domain;
  const registry = browserResult?.registry;
  const rejectedRegistry = browserResult?.rejectedRegistry;
  if (
    !exactObjectKeys(browserResult, [
      "domain",
      "domainRequestId",
      "registry",
      "registryRequestId",
      "rejectedRegistry",
      "rejectedRegistryRequestId",
    ])
    || !exactObjectKeys(domain, [
      "createdBy",
      "id",
      "name",
      "ownerGroup",
      "registryArn",
      "registryId",
      "status",
    ])
    || !exactObjectKeys(registry, [
      "entryId",
      "recordId",
      "registryId",
      "semver",
      "status",
    ])
    || !exactObjectKeys(rejectedRegistry, [
      "entryId",
      "recordId",
      "registryId",
      "semver",
      "status",
    ])
    || domain.id !== ownership.domainId
    || domain.name !== ownership.domainName
    || domain.ownerGroup !== ownership.ownerGroup
    || domain.status !== "ACTIVE"
    || !meaningfulString(domain.createdBy)
    || (actor !== undefined && domain.createdBy !== actor)
    || !requiredAdapterString(domain.registryId, /^[A-Za-z0-9]{12,16}$/)
    || !requiredAdapterString(
      domain.registryArn,
      /^arn:aws:agent-registry:[a-z0-9-]+:[0-9]{12}:registry\/[A-Za-z0-9]{12,16}$/,
    )
    || browserResult.domainRequestId !== ownership.requestIds.domain
    || browserResult.registryRequestId !== ownership.requestIds.registry
    || browserResult.rejectedRegistryRequestId
      !== rejectionOwnership.requestIds.registry
    || registry.entryId !== ownership.registryEntryId
    || registry.semver !== ownership.registryVersion
    || registry.status !== "APPROVED"
    || registry.registryId !== registryFixture.registryId
    || registry.recordId !== registryFixture.recordId
    || rejectedRegistry.entryId !== rejectionOwnership.registryEntryId
    || rejectedRegistry.semver !== rejectionOwnership.registryVersion
    || rejectedRegistry.status !== "REJECTED"
    || rejectedRegistry.registryId !== rejectionRegistryFixture.registryId
    || rejectedRegistry.recordId !== rejectionRegistryFixture.recordId
  ) {
    throw new Error("Hosted browser mutation evidence was invalid.");
  }
  return browserResult;
}

function authoritativeRegistryVersion(body, fixture) {
  const entry = body?.entries?.find((candidate) =>
    candidate?.id === fixture.entryId
  );
  return entry?.versions?.find((version) =>
    version?.semver === fixture.semver
    && version?._aws?.registryId === fixture.registryId
    && version?._aws?.recordId === fixture.recordId
  ) ?? null;
}

async function verifyHostedMutations({
  applicationUrl,
  browserResult,
  fetchImpl,
  adminTokens,
  isolationTokens,
  ownership,
  rejectionOwnership,
  registryFixture,
  rejectionRegistryFixture,
  stageOptions,
}) {
  const domainPayload = expectedDomainPayload(ownership);
  const registryPayload = expectedRegistryDecisionPayload(
    ownership,
    "approve",
  );
  const rejectionPayload = expectedRegistryDecisionPayload(
    rejectionOwnership,
    "reject",
  );
  await runStage("api-domains", async (signal) => {
    const response = await apiRequest({
      applicationUrl,
      fetchImpl,
      method: "GET",
      path: "/api/domains",
      signal,
      token: adminTokens.accessToken,
    });
    const domain = response.body?.domains?.find((candidate) =>
      candidate?.id === ownership.domainId
    );
    if (
      response.response.status !== 200
      || !domain
      || domain.registryId !== browserResult.domain.registryId
      || domain.registryArn !== browserResult.domain.registryArn
      || domain.name !== ownership.domainName
    ) {
      throw new Error("Created domain was not durably listed.");
    }
  }, stageOptions);

  await runStage("api-domain-replay", async (signal) => {
    const response = await apiRequest({
      applicationUrl,
      body: domainPayload,
      fetchImpl,
      method: "POST",
      path: "/api/domain-create",
      requestId: browserResult.domainRequestId,
      signal,
      token: adminTokens.accessToken,
    });
    if (
      response.response.status !== 200
      || !isDeepStrictEqual(
        projectDomainEvidence(response.body?.domain),
        browserResult.domain,
      )
    ) {
      throw new Error("Domain mutation was not idempotent.");
    }
  }, stageOptions);

  await runStage("api-domain-isolation", async (signal) => {
    const response = await apiRequest({
      applicationUrl,
      body: domainPayload,
      fetchImpl,
      method: "POST",
      path: "/api/domain-create",
      requestId: ownership.requestIds.isolation,
      signal,
      token: isolationTokens.accessToken,
    });
    if (
      response.response.status !== 403
      || response.body?.code !== "FORBIDDEN"
    ) {
      throw new Error("End-user domain mutation was not forbidden.");
    }
  }, stageOptions);

  await runStage("api-registry-approve-replay", async (signal) => {
    const response = await apiRequest({
      applicationUrl,
      body: registryPayload,
      fetchImpl,
      method: "POST",
      path: "/api/registry-decide",
      requestId: browserResult.registryRequestId,
      signal,
      token: adminTokens.accessToken,
    });
    if (
      response.response.status !== 200
      || !isDeepStrictEqual(
        projectRegistryEvidence(response.body?.version),
        browserResult.registry,
      )
    ) {
      throw new Error("Registry mutation was not idempotent.");
    }
  }, stageOptions);

  await runStage("api-registry-reject-replay", async (signal) => {
    const response = await apiRequest({
      applicationUrl,
      body: rejectionPayload,
      fetchImpl,
      method: "POST",
      path: "/api/registry-decide",
      requestId: browserResult.rejectedRegistryRequestId,
      signal,
      token: adminTokens.accessToken,
    });
    if (
      response.response.status !== 200
      || !isDeepStrictEqual(
        projectRegistryEvidence(response.body?.version),
        browserResult.rejectedRegistry,
      )
    ) {
      throw new Error("Registry rejection was not idempotent.");
    }
  }, stageOptions);

  await runStage("api-registry-status", async (signal) => {
    const response = await apiRequest({
      applicationUrl,
      fetchImpl,
      method: "GET",
      path: "/api/registry",
      signal,
      token: adminTokens.accessToken,
    });
    const version = authoritativeRegistryVersion(
      response.body,
      registryFixture,
    );
    const rejectedVersion = authoritativeRegistryVersion(
      response.body,
      rejectionRegistryFixture,
    );
    if (
      response.response.status !== 200
      || version?.status
        !== browserResult.registry.status
      || rejectedVersion?.status
        !== browserResult.rejectedRegistry.status
    ) {
      throw new Error("Registry authoritative status was not refreshed.");
    }
  }, stageOptions);
}

export function createPrivateArtifactDirectory({
  makeDirectory = mkdtempSync,
  setMode = chmodSync,
  removeDirectory = rmSync,
  temporaryRoot = tmpdir(),
} = {}) {
  let directory;
  try {
    directory = makeDirectory(
      join(temporaryRoot, "agentic-platform-hosted-acceptance-"),
    );
    setMode(directory, 0o700);
    return directory;
  } catch (error) {
    if (directory !== undefined) {
      try {
        removeDirectory(directory, { recursive: true, force: true });
      } catch {
        throw cleanupFailure();
      }
    }
    throw error;
  }
}

export async function runHostedAcceptance({
  applicationUrl,
  clientId,
  region,
  userPoolId,
  cognito,
  browser,
  resources,
  fetchImpl = fetch,
  randomPassword = defaultRandomPassword,
  removeArtifactDirectory = rmSync,
  operationTimeoutMs = DEFAULT_OPERATION_TIMEOUT_MS,
  resourceOperationTimeoutMs = DEFAULT_RESOURCE_OPERATION_TIMEOUT_MS,
  cleanupAttempts = DEFAULT_CLEANUP_ATTEMPTS,
  deadlineTimers = DEFAULT_DEADLINE_TIMERS,
  runWithDeadline = defaultRunWithDeadline,
  verifierRunId,
  verifierRunAttempt,
}) {
  const config = validateConfiguration({
    applicationUrl,
    clientId,
    region,
    userPoolId,
  });
  validateAdapters({
    browser,
    cognito,
    fetchImpl,
    randomPassword,
    resources,
  });
  const boundedOperationTimeoutMs = positiveInteger(
    operationTimeoutMs,
    "operationTimeoutMs",
  );
  const boundedCleanupAttempts = positiveInteger(
    cleanupAttempts,
    "cleanupAttempts",
  );
  const boundedResourceOperationTimeoutMs = brokerOperationTimeout(
    resourceOperationTimeoutMs,
  );
  const stageOptions = {
    deadlineTimers,
    operationTimeoutMs: boundedOperationTimeoutMs,
    runWithDeadline,
  };
  const resourceStageOptions = {
    ...stageOptions,
    operationTimeoutMs: boundedResourceOperationTimeoutMs,
  };
  const verifiers = verifierDefinitions(randomPassword, {
    verifierRunId,
    verifierRunAttempt,
  });
  const {
    approve: ownership,
    reject: rejectionOwnership,
  } = createRegistryDecisionOwnerships({
    verifierRunId,
    verifierRunAttempt,
  });
  let artifactDirectory;
  let administratorIdentity;
  let adminTokens;
  let browserResult;
  let domain;
  let failure;
  let fixtureRegistryId;
  let registryFixture;
  let rejectionRegistryFixture;
  let result;

  try {
    for (const verifier of verifiers) {
      await provisionVerifier(cognito, config, verifier, stageOptions);
    }
    const [administrator, isolation] = verifiers;
    adminTokens = await authenticateVerifier(
      cognito,
      config,
      administrator,
      stageOptions,
    );
    const isolationTokens = await authenticateVerifier(
      cognito,
      config,
      isolation,
      stageOptions,
    );
    const validation = await validateApis({
      applicationUrl: config.applicationUrl,
      fetchImpl,
      adminTokens,
      isolationTokens,
      region: config.region,
      stageOptions,
    });
    administratorIdentity = validation.administrator;
    fixtureRegistryId = validation.fixtureRegistryId;
    await runStage(
      "actor-map",
      () => resources.persistActorMapping({
        actor: administratorIdentity.user,
        ownership,
      }),
      resourceStageOptions,
    );
    registryFixture = await runStage(
      "fixture-create",
      () => resources.createRegistryFixture({
        ownership,
        registryId: fixtureRegistryId,
      }),
      resourceStageOptions,
    );
    rejectionRegistryFixture = await runStage(
      "fixture-create",
      () => resources.createRegistryFixture({
        ownership: rejectionOwnership,
        registryId: fixtureRegistryId,
      }),
      resourceStageOptions,
    );
    artifactDirectory = createPrivateArtifactDirectory();
    const verifyBrowser = () => browser.verifyRegistry({
        applicationUrl: config.applicationUrl,
        tokens: adminTokens,
        representativeEntries: validation.representativeEntries,
        artifactDirectory,
        ownership,
        rejectionOwnership,
        registryFixture,
        rejectionRegistryFixture,
      });
    if (browser.managesOwnDeadline === true) {
      try {
        browserResult = await verifyBrowser();
      } catch (error) {
        throw stableFailure(
          "browser",
          error?.cleanupCode === "HOSTED_ACCEPTANCE_CLEANUP_FAILED"
            ? error.cleanupCode
            : undefined,
        );
      }
    } else {
      browserResult = await runStage(
        "browser",
        verifyBrowser,
        stageOptions,
      );
    }
    browserResult = validateBrowserMutationResult({
      actor: administratorIdentity.user,
      browserResult,
      ownership,
      rejectionOwnership,
      registryFixture,
      rejectionRegistryFixture,
    });
    registryFixture = {
      ...registryFixture,
      status: browserResult.registry.status,
    };
    rejectionRegistryFixture = {
      ...rejectionRegistryFixture,
      status: browserResult.rejectedRegistry.status,
    };
    domain = browserResult.domain;
    await verifyHostedMutations({
      applicationUrl: config.applicationUrl,
      browserResult,
      fetchImpl,
      adminTokens,
      isolationTokens,
      ownership,
      rejectionOwnership,
      registryFixture,
      rejectionRegistryFixture,
      stageOptions,
    });
    result = { ok: true };
  } catch (error) {
    failure = error instanceof HostedAcceptanceError
      && error.code === "HOSTED_ACCEPTANCE_FAILED"
      ? error
      : stableFailure("acceptance");
  } finally {
    let cleanupFailed = false;
    if (fixtureRegistryId !== undefined) {
      try {
        const recoveredRegistryFixture = await retryCleanup(() =>
          resources.recoverRegistryFixture({
            ownership,
            registryId: fixtureRegistryId,
          }), {
          ...resourceStageOptions,
          attempts: boundedCleanupAttempts,
        });
        if (
          recoveredRegistryFixture === null
          && registryFixture !== undefined
        ) {
          throw cleanupFailure();
        }
        registryFixture = recoveredRegistryFixture;
      } catch {
        cleanupFailed = true;
      }
    }
    if (fixtureRegistryId !== undefined) {
      try {
        const recoveredRejectionRegistryFixture = await retryCleanup(() =>
          resources.recoverRegistryFixture({
            ownership: rejectionOwnership,
            registryId: fixtureRegistryId,
          }), {
          ...resourceStageOptions,
          attempts: boundedCleanupAttempts,
        });
        if (
          recoveredRejectionRegistryFixture === null
          && rejectionRegistryFixture !== undefined
        ) {
          throw cleanupFailure();
        }
        rejectionRegistryFixture = recoveredRejectionRegistryFixture;
      } catch {
        cleanupFailed = true;
      }
    }
    if (
      domain === undefined
      && administratorIdentity !== undefined
      && adminTokens !== undefined
    ) {
      try {
        const response = await retryCleanup((signal) =>
          apiRequest({
            applicationUrl: config.applicationUrl,
            fetchImpl,
            method: "GET",
            path: "/api/domains",
            signal,
            token: adminTokens.accessToken,
          }), {
          ...stageOptions,
          attempts: boundedCleanupAttempts,
        });
        domain = response.body?.domains?.find((candidate) =>
          candidate?.id === ownership.domainId
        );
      } catch {
        // The exact DynamoDB adapter recovery below remains available.
      }
    }
    if (
      domain === undefined
      && administratorIdentity !== undefined
    ) {
      try {
        domain = await retryCleanup(() => resources.recoverDomain({
          actor: administratorIdentity.user,
          ownership,
        }), {
          ...resourceStageOptions,
          attempts: boundedCleanupAttempts,
        });
      } catch {
        cleanupFailed = true;
      }
    }
    if (rejectionRegistryFixture != null) {
      try {
        await retryCleanup(() => resources.cleanupExactResources({
          actor: administratorIdentity?.user,
          domain: undefined,
          ownership: rejectionOwnership,
          registryRecord: rejectionRegistryFixture,
          requestIds: [],
        }), {
          ...resourceStageOptions,
          attempts: boundedCleanupAttempts,
        });
      } catch {
        cleanupFailed = true;
      }
    }
    if (
      registryFixture !== undefined
      || domain !== undefined
      || administratorIdentity !== undefined
    ) {
      try {
        await retryCleanup(() => resources.cleanupExactResources({
          actor: administratorIdentity?.user ?? domain?.createdBy,
          domain,
          ownership,
          registryRecord: registryFixture,
          requestIds: [
            {
              requestId: ownership.requestIds.domain,
              route: "POST /api/domain-create",
            },
          ],
        }), {
          ...resourceStageOptions,
          attempts: boundedCleanupAttempts,
        });
      } catch {
        cleanupFailed = true;
      }
    }
    if (artifactDirectory !== undefined) {
      try {
        await retryCleanup(() =>
          removeArtifactDirectory(
            artifactDirectory,
            { recursive: true, force: true },
          ), {
          ...stageOptions,
          attempts: boundedCleanupAttempts,
        });
      } catch {
        cleanupFailed = true;
      }
    }
    for (const verifier of verifiers) {
      try {
        await retryCleanup(async () => {
          try {
            await cognito.adminDeleteUser({
              userPoolId: config.userPoolId,
              username: verifier.username,
            });
          } catch (error) {
            if (cognito.isUserNotFound?.(error) !== true) throw error;
          }
        }, {
          ...stageOptions,
          attempts: boundedCleanupAttempts,
        });
      } catch {
        cleanupFailed = true;
      }
    }
    if (cleanupFailed) {
      if (failure) {
        failure.cleanupCode = "HOSTED_ACCEPTANCE_CLEANUP_FAILED";
      } else {
        failure = cleanupFailure();
      }
    }
  }

  if (failure) throw failure;
  return result;
}

export async function cleanupHostedVerifierUsers({
  userPoolId,
  cognito,
  verifierRunId,
  verifierRunAttempt,
  operationTimeoutMs = DEFAULT_OPERATION_TIMEOUT_MS,
  cleanupAttempts = DEFAULT_EXTERNAL_CLEANUP_ATTEMPTS,
  deadlineTimers = DEFAULT_DEADLINE_TIMERS,
  runWithDeadline = defaultRunWithDeadline,
}) {
  const normalizedUserPoolId = requiredString(userPoolId, "userPoolId");
  if (
    !cognito
    || typeof cognito.adminDeleteUser !== "function"
    || typeof cognito.isUserNotFound !== "function"
  ) {
    throw new HostedAcceptanceError(
      "HOSTED_ACCEPTANCE_CONFIGURATION_INVALID",
      "Hosted control-plane acceptance cleanup adapter is invalid.",
    );
  }
  const usernames = verifierUsernames({
    verifierRunId,
    verifierRunAttempt,
  });
  const stageOptions = {
    attempts: positiveInteger(cleanupAttempts, "cleanupAttempts"),
    deadlineTimers,
    operationTimeoutMs: positiveInteger(
      operationTimeoutMs,
      "operationTimeoutMs",
    ),
    runWithDeadline,
  };
  let failed = false;
  for (const username of usernames) {
    try {
      await retryCleanup(async () => {
        try {
          await cognito.adminDeleteUser({
            userPoolId: normalizedUserPoolId,
            username,
          });
        } catch (error) {
          if (cognito.isUserNotFound(error) !== true) throw error;
        }
      }, stageOptions);
    } catch {
      failed = true;
    }
  }
  if (failed) throw cleanupFailure();
  return { deletedUsernames: usernames, ok: true };
}

export async function cleanupHostedAcceptanceRun({
  cognito,
  fixtureRegistryId,
  resources,
  userPoolId,
  verifierRunId,
  verifierRunAttempt,
  operationTimeoutMs = DEFAULT_OPERATION_TIMEOUT_MS,
  resourceOperationTimeoutMs = DEFAULT_RESOURCE_OPERATION_TIMEOUT_MS,
  cleanupAttempts = DEFAULT_EXTERNAL_CLEANUP_ATTEMPTS,
  deadlineTimers = DEFAULT_DEADLINE_TIMERS,
  runWithDeadline = defaultRunWithDeadline,
}) {
  const {
    approve: ownership,
    reject: rejectionOwnership,
  } = createRegistryDecisionOwnerships({
    verifierRunId,
    verifierRunAttempt,
  });
  const normalizedUserPoolId = requiredString(userPoolId, "userPoolId");
  const normalizedFixtureRegistryId = requiredString(
    fixtureRegistryId,
    "fixtureRegistryId",
  );
  if (
    !/^[A-Za-z0-9]{12,16}$/.test(normalizedFixtureRegistryId)
    || !cognito
    || typeof cognito.adminGetUser !== "function"
    || typeof cognito.adminDeleteUser !== "function"
    || typeof cognito.isUserNotFound !== "function"
    || !resources
    || [
      "cleanupExactResources",
      "recoverActorMapping",
      "recoverDomain",
      "recoverRegistryFixture",
    ].some((method) => typeof resources[method] !== "function")
  ) {
    throw new HostedAcceptanceError(
      "HOSTED_ACCEPTANCE_CONFIGURATION_INVALID",
      "Hosted control-plane acceptance cleanup configuration is invalid.",
    );
  }
  const stageOptions = {
    attempts: positiveInteger(cleanupAttempts, "cleanupAttempts"),
    deadlineTimers,
    operationTimeoutMs: positiveInteger(
      operationTimeoutMs,
      "operationTimeoutMs",
    ),
    runWithDeadline,
  };
  const resourceStageOptions = {
    ...stageOptions,
    operationTimeoutMs: brokerOperationTimeout(
      resourceOperationTimeoutMs,
    ),
  };
  const [administratorUsername] = verifierUsernames({
    verifierRunId,
    verifierRunAttempt,
  });
  let actor;
  let domain;
  let failed = false;
  let mappedActor;
  let registryRecord;
  let rejectionRegistryRecord;
  try {
    const user = await retryCleanup(() => cognito.adminGetUser({
      userPoolId: normalizedUserPoolId,
      username: administratorUsername,
    }), stageOptions);
    const subjects = Array.isArray(user?.UserAttributes)
      ? user.UserAttributes.filter(({ Name, Value } = {}) =>
          Name === "sub" && meaningfulString(Value)
        )
      : [];
    if (subjects.length !== 1) {
      failed = true;
    } else {
      actor = subjects[0].Value.trim();
    }
  } catch (error) {
    if (cognito.isUserNotFound(error) !== true) failed = true;
  }
  try {
    mappedActor = await retryCleanup(() =>
      resources.recoverActorMapping({ ownership }), resourceStageOptions);
    if (mappedActor !== null) {
      if (actor !== undefined && actor !== mappedActor) {
        failed = true;
      } else {
        actor = mappedActor;
      }
    }
  } catch {
    failed = true;
  }
  try {
    registryRecord = await retryCleanup(() =>
      resources.recoverRegistryFixture({
        ownership,
        registryId: normalizedFixtureRegistryId,
      }), resourceStageOptions);
  } catch {
    failed = true;
  }
  try {
    rejectionRegistryRecord = await retryCleanup(() =>
      resources.recoverRegistryFixture({
        ownership: rejectionOwnership,
        registryId: normalizedFixtureRegistryId,
      }), resourceStageOptions);
  } catch {
    failed = true;
  }
  try {
    domain = await retryCleanup(() => resources.recoverDomain({
      actor,
      ownership,
    }), resourceStageOptions);
    actor ??= domain?.createdBy;
  } catch {
    failed = true;
  }
  if (actor === undefined) failed = true;
  if (rejectionRegistryRecord != null) {
    try {
      await retryCleanup(() => resources.cleanupExactResources({
        actor,
        domain: undefined,
        ownership: rejectionOwnership,
        registryRecord: rejectionRegistryRecord,
        requestIds: [],
      }), resourceStageOptions);
    } catch {
      failed = true;
    }
  }
  if (
    actor !== undefined
    || domain != null
    || registryRecord != null
  ) {
    try {
      await retryCleanup(() => resources.cleanupExactResources({
        actor,
        domain,
        ownership,
        registryRecord,
        requestIds: actor === undefined
          ? []
          : [
              {
                requestId: ownership.requestIds.domain,
                route: "POST /api/domain-create",
              },
            ],
      }), resourceStageOptions);
    } catch {
      failed = true;
    }
  }
  try {
    await cleanupHostedVerifierUsers({
      userPoolId: normalizedUserPoolId,
      cognito,
      verifierRunId,
      verifierRunAttempt,
      operationTimeoutMs: stageOptions.operationTimeoutMs,
      cleanupAttempts: stageOptions.attempts,
      deadlineTimers,
      runWithDeadline,
    });
  } catch {
    failed = true;
  }
  if (failed) throw cleanupFailure();
  return { ok: true };
}

function validBrokerFunctionArn(
  value,
  { accountId, region } = {},
) {
  if (!meaningfulString(value)) return false;
  const match = value.match(
    /^arn:[a-z0-9-]+:lambda:([a-z]{2}(?:-[a-z0-9]+)+-\d+):([0-9]{12}):function:AgenticPlatform-Web-HostedAcceptanceBroker$/,
  );
  return Boolean(
    match
    && (region === undefined || match[1] === region)
    && (accountId === undefined || match[2] === accountId)
  );
}

export function createAwsBrokerResourceAdapter({
  accountId,
  brokerFunctionArn,
  lambdaClient,
  region,
}) {
  if (
    !/^[0-9]{12}$/.test(accountId)
    || !/^[a-z]{2}(?:-[a-z0-9]+)+-\d+$/.test(region)
    || !validBrokerFunctionArn(
      brokerFunctionArn,
      { accountId, region },
    )
    || !lambdaClient
    || typeof lambdaClient.send !== "function"
  ) {
    throw new HostedAcceptanceError(
      "HOSTED_ACCEPTANCE_CONFIGURATION_INVALID",
      "Hosted control-plane acceptance resource adapter is invalid.",
    );
  }
  const expectedExperienceFixture = (input, result) => {
    const runId = input?.ownership?.runId;
    const runAttempt = input?.ownership?.runAttempt;
    const domainId = input?.domainId ?? result?.domainId;
    if (
      typeof runId !== "string"
      || typeof runAttempt !== "string"
      || typeof domainId !== "string"
    ) {
      throw cleanupFailure();
    }
    return {
      domainId,
      projectId: `hosted-project-${runId}-${runAttempt}`,
      agentId: `hosted-agent-${runId}-${runAttempt}`,
      deploymentId: `hosted-production-${runId}-${runAttempt}`,
    };
  };
  const validatedResult = (operation, input, result) => {
    if (
      operation === "provisionExperienceFixture"
      || operation === "recoverExperienceFixture"
    ) {
      if (operation === "recoverExperienceFixture" && result === null) {
        return null;
      }
      const expected = expectedExperienceFixture(input, result);
      if (
        !exactObjectKeys(result, Object.keys(expected))
        || !isDeepStrictEqual(result, expected)
      ) {
        throw cleanupFailure();
      }
      return expected;
    }
    return result;
  };
  const invoke = async (operation, input) => {
    let payload;
    try {
      payload = Buffer.from(JSON.stringify({ operation, input }), "utf8");
    } catch {
      throw cleanupFailure();
    }
    if (
      payload.length === 0
      || payload.length > MAX_BROKER_REQUEST_BYTES
    ) {
      throw cleanupFailure();
    }
    let response;
    try {
      response = await lambdaClient.send(new InvokeCommand({
        FunctionName: brokerFunctionArn,
        InvocationType: "RequestResponse",
        LogType: "None",
        Payload: payload,
      }));
    } catch {
      throw cleanupFailure();
    }
    const responsePayload = response?.Payload;
    if (
      response?.StatusCode !== 200
      || response.FunctionError !== undefined
      || !(responsePayload instanceof Uint8Array)
      || responsePayload.byteLength === 0
      || responsePayload.byteLength > MAX_BROKER_RESPONSE_BYTES
    ) {
      throw cleanupFailure();
    }
    let body;
    try {
      body = JSON.parse(Buffer.from(responsePayload).toString("utf8"));
    } catch {
      throw cleanupFailure();
    }
    if (
      !exactObjectKeys(body, ["ok", "result"])
      || body.ok !== true
    ) {
      throw cleanupFailure();
    }
    return validatedResult(operation, input, body.result);
  };
  return Object.fromEntries(
    [
      "persistActorMapping",
      "recoverActorMapping",
      "createRegistryFixture",
      "recoverRegistryFixture",
      "recoverDomain",
      "provisionExperienceFixture",
      "recoverExperienceFixture",
      "cleanupExperienceFixture",
      "cleanupExactResources",
    ].map((operation) => [
      operation,
      (input) => invoke(operation, input),
    ]),
  );
}

function cliOptions(region, timeoutMs, input) {
  return {
    ...(input === undefined ? {} : { input }),
    environment: {
      ...process.env,
      AWS_REGION: region,
      AWS_DEFAULT_REGION: region,
    },
    timeoutMs,
  };
}

function parseAwsJson(stdout) {
  try {
    const document = JSON.parse(stdout);
    if (!document || typeof document !== "object" || Array.isArray(document)) {
      throw new Error();
    }
    return document;
  } catch {
    throw new Error("AWS CLI returned an invalid response.");
  }
}

export function createAwsCognitoAdapter({
  region = process.env.AWS_REGION,
  runAws = runAwsCli,
  operationTimeoutMs = DEFAULT_OPERATION_TIMEOUT_MS,
} = {}) {
  const awsRegion = requiredString(region, "AWS region");
  const timeoutMs = positiveInteger(
    operationTimeoutMs,
    "operationTimeoutMs",
  );
  return {
    async adminCreateUser({
      messageAction,
      userAttributes,
      userPoolId,
      username,
    }) {
      const response = await runAws(
        [
          "cognito-idp",
          "admin-create-user",
          "--cli-input-json",
          "file:///dev/stdin",
          "--region",
          awsRegion,
        ],
        cliOptions(awsRegion, timeoutMs, JSON.stringify({
          UserPoolId: userPoolId,
          Username: username,
          UserAttributes: userAttributes.map(({ name, value }) => ({
            Name: name,
            Value: value,
          })),
          MessageAction: messageAction,
        })),
      );
      const user = parseAwsJson(response.stdout).User;
      return {
        Username: user?.Username,
        Enabled: user?.Enabled,
        UserStatus: user?.UserStatus,
        UserAttributes: user?.Attributes,
      };
    },
    async adminSetUserPassword({
      password,
      permanent,
      userPoolId,
      username,
    }) {
      await runAws(
        [
          "cognito-idp",
          "admin-set-user-password",
          "--cli-input-json",
          "file:///dev/stdin",
          "--region",
          awsRegion,
        ],
        cliOptions(awsRegion, timeoutMs, JSON.stringify({
          UserPoolId: userPoolId,
          Username: username,
          Password: password,
          Permanent: permanent,
        })),
      );
    },
    async adminAddUserToGroup({
      groupName,
      userPoolId,
      username,
    }) {
      await runAws(
        [
          "cognito-idp",
          "admin-add-user-to-group",
          "--user-pool-id",
          userPoolId,
          "--username",
          username,
          "--group-name",
          groupName,
          "--region",
          awsRegion,
        ],
        cliOptions(awsRegion, timeoutMs),
      );
    },
    async adminGetUser({ userPoolId, username }) {
      const response = await runAws(
        [
          "cognito-idp",
          "admin-get-user",
          "--user-pool-id",
          userPoolId,
          "--username",
          username,
          "--region",
          awsRegion,
          "--output",
          "json",
        ],
        cliOptions(awsRegion, timeoutMs),
      );
      return parseAwsJson(response.stdout);
    },
    async adminInitiateAuth({
      authFlow,
      clientId,
      password,
      userPoolId,
      username,
    }) {
      const response = await runAws(
        [
          "cognito-idp",
          "admin-initiate-auth",
          "--cli-input-json",
          "file:///dev/stdin",
          "--region",
          awsRegion,
          "--output",
          "json",
        ],
        cliOptions(awsRegion, timeoutMs, JSON.stringify({
          UserPoolId: userPoolId,
          ClientId: clientId,
          AuthFlow: authFlow,
          AuthParameters: {
            USERNAME: username,
            PASSWORD: password,
          },
        })),
      );
      return parseAwsJson(response.stdout);
    },
    async adminDeleteUser({ userPoolId, username }) {
      await runAws(
        [
          "cognito-idp",
          "admin-delete-user",
          "--user-pool-id",
          userPoolId,
          "--username",
          username,
          "--region",
          awsRegion,
        ],
        cliOptions(awsRegion, timeoutMs),
      );
    },
    isUserNotFound: isAwsCliUserNotFound,
  };
}

function browserLayoutProblems() {
  const problems = [];
  const viewportWidth = document.documentElement.clientWidth;
  if (document.documentElement.scrollWidth > viewportWidth + 2) {
    problems.push("document-overflow");
  }
  for (const element of document.querySelectorAll(
    "#main, #regstore, #regbox",
  )) {
    const style = getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden") continue;
    const rect = element.getBoundingClientRect();
    if (rect.left < -2 || rect.right > viewportWidth + 2) {
      problems.push("horizontal-clipping");
      break;
    }
  }
  const registryBox = document.querySelector("#regbox");
  const registryTable = registryBox?.querySelector("table");
  if (
    registryBox
    && registryTable
    && registryBox.scrollWidth > registryBox.clientWidth + 2
    && !["auto", "scroll"].includes(getComputedStyle(registryBox).overflowX)
  ) {
    problems.push("uncontained-table-overflow");
  }
  const side = document.querySelector("#side")?.getBoundingClientRect();
  const main = document.querySelector("#main")?.getBoundingClientRect();
  if (
    side
    && main
    && side.width > 0
    && side.height > 0
    && main.width > 0
    && main.height > 0
    && side.left < main.right - 1
    && side.right > main.left + 1
    && side.top < main.bottom - 1
    && side.bottom > main.top + 1
  ) {
    problems.push("shell-overlap");
  }
  const rows = [...document.querySelectorAll("#regbox .regrow")]
    .map((row) => row.getBoundingClientRect())
    .filter((rect) => rect.width > 0 && rect.height > 0)
    .sort((left, right) => left.top - right.top);
  for (let index = 1; index < rows.length; index += 1) {
    if (rows[index].top < rows[index - 1].bottom - 1) {
      problems.push("row-overlap");
      break;
    }
  }
  return problems;
}

function registryRowHasExactIdentityAndType({ id, type }) {
  const visiblyRendered = (element) => {
    if (!element || element.getClientRects().length === 0) return false;
    for (
      let current = element;
      current instanceof Element;
      current = current.parentElement
    ) {
      const style = getComputedStyle(current);
      if (
        style.display === "none"
        || ["hidden", "collapse"].includes(style.visibility)
        || Number(style.opacity) === 0
      ) {
        return false;
      }
    }
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };
  const row = [...document.querySelectorAll("#regbox .regrow")]
    .find((candidate) => candidate.dataset.regid === id);
  if (!row) return false;
  const typeCell = row.querySelector("td:nth-child(2)");
  const typeMarker = [...(typeCell?.querySelectorAll(".chip.type") || [])]
    .find((candidate) => candidate.textContent?.trim() === type);
  return typeCell?.textContent?.trim() === type
    && visiblyRendered(row)
    && visiblyRendered(typeCell)
    && visiblyRendered(typeMarker);
}

function gatewayRegistryRowHasVisibleSource({ gateway, id }) {
  const visiblyRendered = (element) => {
    if (!element || element.getClientRects().length === 0) return false;
    for (
      let current = element;
      current instanceof Element;
      current = current.parentElement
    ) {
      const style = getComputedStyle(current);
      if (
        style.display === "none"
        || ["hidden", "collapse"].includes(style.visibility)
        || Number(style.opacity) === 0
      ) {
        return false;
      }
    }
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };
  const row = [...document.querySelectorAll("#regbox .regrow")]
    .find((candidate) => candidate.dataset.regid === id);
  const badge = [...(row?.querySelectorAll(".chip") || [])]
    .find((candidate) =>
      candidate.textContent?.trim().toLowerCase() === "gateway"
      && candidate.getAttribute("title")?.includes(gateway)
    );
  return visiblyRendered(row) && visiblyRendered(badge);
}

function liveAwsBadgeVisible() {
  const visiblyRendered = (element) => {
    if (!element || element.getClientRects().length === 0) return false;
    for (
      let current = element;
      current instanceof Element;
      current = current.parentElement
    ) {
      const style = getComputedStyle(current);
      if (
        style.display === "none"
        || ["hidden", "collapse"].includes(style.visibility)
        || Number(style.opacity) === 0
      ) {
        return false;
      }
    }
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };
  const badge = [...document.querySelectorAll("#regstore .chip")]
    .find((candidate) =>
      candidate.textContent?.trim().toLowerCase() === "live aws"
    );
  return visiblyRendered(badge);
}

function browserResponseMatches(response, method, path) {
  try {
    return response.request().method() === method
      && new URL(response.url()).pathname === path;
  } catch {
    return false;
  }
}

async function browserMutationEvidence(response) {
  const request = response.request();
  const headers = await request.allHeaders();
  const text = await response.text();
  if (
    Buffer.byteLength(text) > DEFAULT_MAX_API_RESPONSE_BYTES
    || typeof headers["x-request-id"] !== "string"
  ) {
    throw new Error("Hosted browser mutation evidence was invalid.");
  }
  let payload;
  let result;
  try {
    payload = JSON.parse(request.postData());
    result = JSON.parse(text);
  } catch {
    throw new Error("Hosted browser mutation evidence was invalid.");
  }
  if (
    !payload
    || typeof payload !== "object"
    || Array.isArray(payload)
    || !result
    || typeof result !== "object"
    || Array.isArray(result)
  ) {
    throw new Error("Hosted browser mutation evidence was invalid.");
  }
  return {
    payload,
    requestId: headers["x-request-id"],
    result,
  };
}

async function replayBrowserRegistryDecision(page, {
  payload,
  requestId,
}) {
  const replay = await page.evaluate(async ({
    maximumBytes,
    payload: decisionPayload,
    requestId: mutationRequestId,
  }) => {
    let tokens;
    try {
      tokens = JSON.parse(
        sessionStorage.getItem("console.cognito.tokens"),
      );
    } catch {
      throw new Error("Hosted browser mutation replay was invalid.");
    }
    if (typeof tokens?.accessToken !== "string") {
      throw new Error("Hosted browser mutation replay was invalid.");
    }
    const baseUrl = String(
      globalThis.__RUNTIME_CONFIG__?.apiBaseUrl ?? "/api",
    ).replace(/\/+$/, "");
    const response = await fetch(`${baseUrl}/registry-decide`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${tokens.accessToken}`,
        "content-type": "application/json",
        "x-request-id": mutationRequestId,
      },
      body: JSON.stringify(decisionPayload),
    });
    const text = await response.text();
    if (
      new TextEncoder().encode(text).byteLength > maximumBytes
    ) {
      throw new Error("Hosted browser mutation replay was invalid.");
    }
    return { status: response.status, text };
  }, {
    maximumBytes: DEFAULT_MAX_API_RESPONSE_BYTES,
    payload,
    requestId,
  });
  let result;
  try {
    result = JSON.parse(replay.text);
  } catch {
    throw new Error("Hosted browser mutation replay was invalid.");
  }
  if (
    replay.status !== 200
    || !result
    || typeof result !== "object"
    || Array.isArray(result)
  ) {
    throw new Error("Hosted browser mutation replay was invalid.");
  }
  return { payload, requestId, result };
}

async function filterRegistryToEntry({
  bounded,
  entryId,
  page,
  timeoutMs,
}) {
  const visibleState = await bounded(() => page.waitForFunction(
    (expectedEntryId) => {
      const visible = (element) =>
        element instanceof HTMLElement
        && element.getClientRects().length > 0;
      const row = Array.from(
        document.querySelectorAll("#regbox .regrow"),
      ).find((candidate) =>
        candidate.dataset.regid === expectedEntryId
      );
      if (visible(row)) return "row";
      return visible(document.querySelector("#regsearch"))
        ? "search"
        : false;
    },
    entryId,
    { timeout: timeoutMs },
  ));
  if (await visibleState.jsonValue() === "row") return;

  const searchControl = page.locator("#regsearch").first();
  const refreshResponsePromise = page.waitForResponse(
    (response) => browserResponseMatches(
      response,
      "GET",
      "/api/registry",
    ),
    { timeout: timeoutMs },
  );
  await bounded(() => searchControl.fill(entryId, {
    timeout: timeoutMs,
  }));
  await bounded(() => refreshResponsePromise);
  await bounded(() => page.waitForFunction(
    (expectedEntryId) => Array.from(
      document.querySelectorAll("#regbox .regrow"),
    ).some((row) =>
      row.dataset.regid === expectedEntryId
      && row.getClientRects().length > 0
    ),
    entryId,
    { timeout: timeoutMs },
  ));
}

async function clearRegistryFilter({
  bounded,
  page,
  timeoutMs,
}) {
  const searchControl = page.locator("#regsearch").first();
  if (
    !await bounded(() => searchControl.isVisible())
    || await bounded(() => searchControl.inputValue()) === ""
  ) {
    return;
  }
  const refreshResponsePromise = page.waitForResponse(
    (response) => browserResponseMatches(
      response,
      "GET",
      "/api/registry",
    ),
    { timeout: timeoutMs },
  );
  await bounded(() => searchControl.fill("", {
    timeout: timeoutMs,
  }));
  await bounded(() => refreshResponsePromise);
}

async function performBrowserRegistryDecision({
  bounded,
  decision,
  ownership,
  page,
  registryFixture,
  timeoutMs,
}) {
  const registryControl = page.locator(
    '.nav[data-shellnav="registry"]',
  ).first();
  const registrySearch = page.locator("#regsearch").first();
  if (!await bounded(() => registrySearch.isVisible())) {
    const initialRegistryResponse = page.waitForResponse(
      (response) => browserResponseMatches(
        response,
        "GET",
        "/api/registry",
      ),
      { timeout: timeoutMs },
    );
    await bounded(() => registryControl.click({ timeout: timeoutMs }));
    await bounded(() => initialRegistryResponse);
    await bounded(() => page.waitForFunction(
      liveAwsBadgeVisible,
      undefined,
      { timeout: timeoutMs },
    ));
  }
  await filterRegistryToEntry({
    bounded,
    entryId: registryFixture.entryId,
    page,
    timeoutMs,
  });
  const registryRow = page.locator(
    `#regbox .regrow[data-regid="${registryFixture.entryId}"]`,
  ).first();
  await bounded(() => registryRow.click({ timeout: timeoutMs }));
  const decisionControl = page.locator(
    `.${decision === "approve" ? "regapprove" : "regreject"}`
      + `[data-id="${registryFixture.entryId}"]`
      + `[data-semver="${registryFixture.semver}"]`,
  ).first();
  let registryMutation;
  if (await bounded(() => decisionControl.isVisible())) {
    const registryResponsePromise = page.waitForResponse(
      (response) => browserResponseMatches(
        response,
        "POST",
        "/api/registry-decide",
      ),
      { timeout: timeoutMs },
    );
    const refreshResponsePromise = page.waitForResponse(
      (response) => browserResponseMatches(
        response,
        "GET",
        "/api/registry",
      ),
      { timeout: timeoutMs },
    );
    let dialogPromise;
    if (decision === "reject") {
      dialogPromise = new Promise((resolve, reject) => {
        page.once("dialog", (dialog) => {
          dialog.accept(REGISTRY_REJECTION_REASON).then(resolve, reject);
        });
      });
    }
    await bounded(() => decisionControl.click({ timeout: timeoutMs }));
    const waits = [
      bounded(() => registryResponsePromise),
      bounded(() => refreshResponsePromise),
    ];
    if (dialogPromise !== undefined) {
      waits.push(bounded(() => dialogPromise));
    }
    const [registryResponse] = await Promise.all(waits);
    registryMutation = await bounded(() =>
      browserMutationEvidence(registryResponse));
  } else {
    const versionControl = page.locator(
      `#regdrawerwrap [data-regversion="${registryFixture.semver}"]`,
    ).first();
    await bounded(() => versionControl.click({ timeout: timeoutMs }));
    const terminalStatus = decision === "approve" ? "APPROVED" : "REJECTED";
    const statusBadge = versionControl.locator(".badge").first();
    const statusText = await bounded(() =>
      statusBadge.textContent({ timeout: timeoutMs }));
    if (
      !await bounded(() => statusBadge.isVisible())
      || statusText?.trim() !== terminalStatus
    ) {
      throw new Error("Hosted Registry decision control is unavailable.");
    }
    registryMutation = await bounded(() =>
      replayBrowserRegistryDecision(page, {
        payload: expectedRegistryDecisionPayload(ownership, decision),
        requestId: ownership.requestIds.registry,
      }));
    const refreshResponsePromise = page.waitForResponse(
      (response) => browserResponseMatches(
        response,
        "GET",
        "/api/registry",
      ),
      { timeout: timeoutMs },
    );
    await bounded(() => registryControl.click({ timeout: timeoutMs }));
    await bounded(() => refreshResponsePromise);
  }
  const selectedVersion = page.locator(
    `#regdrawerwrap [data-regversion="${registryFixture.semver}"]`
      + '[data-selected="true"]',
  ).first();
  await bounded(() => selectedVersion.waitFor({
    state: "visible",
    timeout: timeoutMs,
  }));
  const authoritativeStatus =
    registryMutation.result?.version?.status;
  const drawerText = await bounded(() => page.locator(
    "#regdrawerwrap",
  ).textContent({ timeout: timeoutMs }));
  if (
    !drawerText?.includes(registryFixture.entryId)
    || !drawerText.includes("Authoritative status:")
    || !drawerText.includes(authoritativeStatus)
  ) {
    throw new Error("Hosted Registry decision was not visibly refreshed.");
  }
  await bounded(async () => {
    const closeControl = page.locator("#regdrawerclose").first();
    if (await closeControl.isVisible()) {
      await closeControl.click({ timeout: timeoutMs });
    }
  });
  return registryMutation;
}

async function performHostedBrowserJourney({
  bounded,
  ownership,
  page,
  rejectionOwnership,
  registryFixture,
  rejectionRegistryFixture,
  timeoutMs,
}) {
  const domainPayload = expectedDomainPayload(ownership);
  const domainControl = page.locator(
    '.nav[data-shellnav="domains"]',
  ).first();
  await bounded(() => domainControl.waitFor({
    state: "visible",
    timeout: timeoutMs,
  }));
  await bounded(() => domainControl.click({ timeout: timeoutMs }));
  await bounded(() => page.locator("#dcreate").waitFor({
    state: "visible",
    timeout: timeoutMs,
  }));
  for (const [selector, value] of [
    ["#dname", domainPayload.name],
    ["#downer", domainPayload.owner],
    ["#dgroup", domainPayload.ownerGroup],
    ["#dbudget", domainPayload.tokenBudget],
    ["#ddesc", domainPayload.description],
  ]) {
    await bounded(() => page.locator(selector).fill(value, {
      timeout: timeoutMs,
    }));
  }
  const domainResponsePromise = page.waitForResponse(
    (response) => browserResponseMatches(
      response,
      "POST",
      "/api/domain-create",
    ),
    { timeout: timeoutMs },
  );
  await bounded(() =>
    page.locator("#dcreate").click({ timeout: timeoutMs }));
  const domainResponse = await bounded(() => domainResponsePromise);
  const domainMutation = await bounded(() =>
    browserMutationEvidence(domainResponse));
  const domain = domainMutation.result?.domain;
  const successMessage =
    `Domain ${domain?.name} is active with Agent Registry `
    + `${domain?.registryId}. Assign Cognito group ${domain?.ownerGroup} `
    + "to onboard builders.";
  await bounded(() => page.waitForFunction(
    (message) => document.querySelector("#domstatus")
      ?.textContent?.replace(/\s+/g, " ").trim() === message,
    successMessage,
    { timeout: timeoutMs },
  ));

  await bounded(() => page.reload({
    waitUntil: "domcontentloaded",
    timeout: timeoutMs,
  }));
  const reloadedDomainControl = page.locator(
    '.nav[data-shellnav="domains"]',
  ).first();
  await bounded(() => reloadedDomainControl.waitFor({
    state: "visible",
    timeout: timeoutMs,
  }));
  await bounded(() =>
    reloadedDomainControl.click({ timeout: timeoutMs }));
  await bounded(() => page.waitForFunction(
    (domainId) => [...document.querySelectorAll("#domroster .item")]
      .some((row) => {
        const exactId = [...row.querySelectorAll(".chip")]
          .some((chip) => chip.textContent?.trim() === domainId);
        const bounds = row.getBoundingClientRect();
        return exactId && bounds.width > 0 && bounds.height > 0;
      }),
    ownership.domainId,
    { timeout: timeoutMs },
  ));

  const registryMutation = await performBrowserRegistryDecision({
    bounded,
    decision: "approve",
    ownership,
    page,
    registryFixture,
    timeoutMs,
  });
  const registryRejectionMutation =
    await performBrowserRegistryDecision({
      bounded,
      decision: "reject",
      ownership: rejectionOwnership,
      page,
      registryFixture: rejectionRegistryFixture,
      timeoutMs,
    });
  return projectBrowserWorkerEvidence({
    domain,
    mutations: {
      domain: domainMutation,
      registry: registryMutation,
      registryRejection: registryRejectionMutation,
    },
  });
}

export function createPlaywrightBrowserAdapter({
  chromium,
  environment = process.env,
  operationTimeoutMs = DEFAULT_OPERATION_TIMEOUT_MS,
  cleanupAttempts = DEFAULT_CLEANUP_ATTEMPTS,
  deadlineTimers = DEFAULT_DEADLINE_TIMERS,
  runWithDeadline = defaultRunWithDeadline,
}) {
  if (!chromium || typeof chromium.launch !== "function") {
    throw new Error("Playwright Chromium adapter is unavailable.");
  }
  const timeoutMs = positiveInteger(
    operationTimeoutMs,
    "operationTimeoutMs",
  );
  const boundedCleanupAttempts = positiveInteger(
    cleanupAttempts,
    "cleanupAttempts",
  );
  const browserEnvironment = createBrowserEnvironment(environment);
  const bounded = (operation) => runWithDeadline(operation, {
    timeoutMs,
    timers: deadlineTimers,
  });
  const close = async (operation) => {
    try {
      await retryCleanup(operation, {
        attempts: boundedCleanupAttempts,
        deadlineTimers,
        operationTimeoutMs: timeoutMs,
        runWithDeadline,
      });
      return undefined;
    } catch {
      return new Error("Hosted browser cleanup failed.");
    }
  };
  return {
    async verifyRegistry({
      applicationUrl,
      artifactDirectory,
      ownership,
      rejectionOwnership,
      representativeEntries,
      registryFixture,
      rejectionRegistryFixture,
      tokens,
    }) {
      const hostedJourney = ownership !== undefined
        || registryFixture !== undefined
        || rejectionOwnership !== undefined
        || rejectionRegistryFixture !== undefined;
      const hostedOwnership = hostedJourney
        ? validatedOwnership(ownership)
        : undefined;
      const hostedRejectionOwnership = hostedJourney
        ? validatedOwnership(rejectionOwnership)
        : undefined;
      if (
        hostedJourney
        && (
          !registryFixture
          || registryFixture.entryId !== hostedOwnership.registryEntryId
          || registryFixture.semver !== hostedOwnership.registryVersion
          || !rejectionRegistryFixture
          || rejectionRegistryFixture.entryId
            !== hostedRejectionOwnership.registryEntryId
          || rejectionRegistryFixture.semver
            !== hostedRejectionOwnership.registryVersion
          || rejectionRegistryFixture.entryId === registryFixture.entryId
          || hostedRejectionOwnership.requestIds.registry
            === hostedOwnership.requestIds.registry
        )
      ) {
        throw new Error("Hosted browser Registry fixture was invalid.");
      }
      const playwrightBrowser = await bounded(() =>
        chromium.launch({
          env: browserEnvironment,
          headless: true,
          timeout: timeoutMs,
        }));
      let primaryFailure;
      let mutationResult;
      try {
        for (const viewport of VIEWPORTS) {
          const context = await bounded(() => playwrightBrowser.newContext({
            viewport: {
              width: viewport.width,
              height: viewport.height,
            },
          }));
          try {
            const page = await bounded(() => context.newPage());
            page.setDefaultTimeout?.(timeoutMs);
            page.setDefaultNavigationTimeout?.(timeoutMs);
            await bounded(() => page.addInitScript((session) => {
              sessionStorage.setItem(
                "console.cognito.tokens",
                JSON.stringify(session.tokens),
              );
              if (session.requestIds.length === 0) return;
              const indexKey = "hosted.acceptance.request-id-index";
              if (sessionStorage.getItem(indexKey) === null) {
                sessionStorage.setItem(indexKey, "0");
              }
              Object.defineProperty(globalThis.crypto, "randomUUID", {
                configurable: true,
                value() {
                  const index = Number(
                    sessionStorage.getItem(indexKey) ?? "0",
                  );
                  const requestId = session.requestIds[index];
                  if (requestId === undefined) {
                    throw new Error("Hosted request ID sequence exhausted.");
                  }
                  sessionStorage.setItem(indexKey, String(index + 1));
                  return requestId;
                },
              });
            }, {
              requestIds: hostedOwnership
                ? [
                    hostedOwnership.requestIds.domain,
                    hostedOwnership.requestIds.registry,
                    hostedRejectionOwnership.requestIds.registry,
                  ]
                : [],
              tokens,
            }));
            await bounded(() => page.goto(applicationUrl, {
              waitUntil: "domcontentloaded",
              timeout: timeoutMs,
            }));
            if (hostedOwnership && viewport.name === "desktop") {
              mutationResult = await performHostedBrowserJourney({
                bounded,
                ownership: hostedOwnership,
                page,
                rejectionOwnership: hostedRejectionOwnership,
                registryFixture,
                rejectionRegistryFixture,
                timeoutMs,
              });
            }
            const registryControl = page.locator(
              '.nav[data-shellnav="registry"]',
            ).first();
            await bounded(() => registryControl.waitFor({
              state: "visible",
              timeout: timeoutMs,
            }));
            if (!(hostedOwnership && viewport.name === "desktop")) {
              await bounded(() =>
                registryControl.click({ timeout: timeoutMs }));
            }
            await bounded(() => page.waitForFunction(
              () => document.querySelector("#regstore")
                ?.textContent?.includes("live AWS"),
              undefined,
              { timeout: timeoutMs },
            ));
            const storeText = await bounded(() =>
              page.locator("#regstore").textContent({ timeout: timeoutMs }));
            if (
              !/live AWS/i.test(storeText ?? "")
              || /local file|file fallback/i.test(storeText ?? "")
            ) {
              throw new Error("Registry source label was not live AWS.");
            }
            if (!await bounded(() => page.evaluate(liveAwsBadgeVisible))) {
              throw new Error(
                "Hosted acceptance live AWS badge was not visibly rendered.",
              );
            }
            for (const entry of representativeEntries) {
              await filterRegistryToEntry({
                bounded,
                entryId: entry.id,
                page,
                timeoutMs,
              });
              const rowMatches = await bounded(() => page.evaluate(
                registryRowHasExactIdentityAndType,
                entry,
              ));
              if (!rowMatches) {
                throw new Error(
                  "Hosted acceptance exact Registry row identity and type "
                    + "were not visibly rendered.",
                );
              }
            }
            const gatewayEntries = representativeEntries.filter(
              ({ source }) => source === "gateway",
            );
            for (const entry of gatewayEntries) {
              await filterRegistryToEntry({
                bounded,
                entryId: entry.id,
                page,
                timeoutMs,
              });
              const gatewaySourceVisible = await bounded(() => page.evaluate(
                gatewayRegistryRowHasVisibleSource,
                entry,
              ));
              if (!gatewaySourceVisible) {
                throw new Error(
                  "Hosted acceptance gateway-backed Registry row source "
                    + "was not visibly rendered.",
                );
              }
            }
            await clearRegistryFilter({
              bounded,
              page,
              timeoutMs,
            });
            const layoutProblems = await bounded(() =>
              page.evaluate(browserLayoutProblems));
            if (layoutProblems.length > 0) {
              throw new Error("Registry layout acceptance failed.");
            }
            await bounded(() => page.screenshot({
              path: join(
                artifactDirectory,
                `registry-${viewport.name}.png`,
              ),
              fullPage: true,
              timeout: timeoutMs,
            }));
            if (gatewayEntries.length > 0) {
              await bounded(() => page.screenshot({
                path: join(
                  artifactDirectory,
                  `gateway-${viewport.name}.png`,
                ),
                fullPage: true,
                timeout: timeoutMs,
              }));
            }
          } catch (error) {
            primaryFailure = error;
            throw error;
          } finally {
            const contextCleanupFailure = await close(() => context.close());
            if (contextCleanupFailure) {
              if (primaryFailure) {
                primaryFailure.cleanupCode =
                  "HOSTED_ACCEPTANCE_CLEANUP_FAILED";
              } else {
                primaryFailure = contextCleanupFailure;
                throw contextCleanupFailure;
              }
            }
          }
        }
        return mutationResult;
      } catch (error) {
        primaryFailure ??= error;
        throw primaryFailure;
      } finally {
        const browserCleanupFailure = await close(() =>
          playwrightBrowser.close());
        if (browserCleanupFailure) {
          if (primaryFailure) {
            primaryFailure.cleanupCode =
              "HOSTED_ACCEPTANCE_CLEANUP_FAILED";
          } else {
            throw browserCleanupFailure;
          }
        }
      }
    },
  };
}

function browserWorkerFailure({
  cleanupCode,
  retryable = false,
} = {}) {
  const error = new Error("Hosted browser verification failed.");
  error.code = "HOSTED_BROWSER_FAILED";
  error.retryable = retryable;
  if (cleanupCode === "HOSTED_ACCEPTANCE_CLEANUP_FAILED") {
    error.cleanupCode = cleanupCode;
  }
  return error;
}

function runBrowserWorkerProcess(input, {
  deadlineTimers,
  environment,
  killProcess,
  operationTimeoutMs,
  processExecutable,
  processTerminationTimeoutMs,
  spawnProcess,
  workerPath,
}) {
  return new Promise((resolve, reject) => {
    let child;
    let output = "";
    let outputOverflow = false;
    let spawnFailed = false;
    let operationTimeout;
    let settled = false;
    let terminationFailure;
    let terminationTimeout;
    let terminating = false;

    const destroyChildStdio = () => {
      for (const stream of [child?.stdin, child?.stdout, child?.stderr]) {
        try {
          stream?.destroy();
        } catch {
          // Termination remains bounded by the secondary deadline.
        }
      }
    };
    const clearTimers = () => {
      if (operationTimeout !== undefined) {
        deadlineTimers.clearTimeout(operationTimeout);
        operationTimeout = undefined;
      }
      if (terminationTimeout !== undefined) {
        deadlineTimers.clearTimeout(terminationTimeout);
        terminationTimeout = undefined;
      }
    };
    const settle = (operation) => {
      if (settled) return;
      settled = true;
      clearTimers();
      destroyChildStdio();
      operation();
    };
    const killProcessGroup = () => {
      if (!Number.isInteger(child?.pid) || child.pid <= 0) return "failed";
      try {
        killProcess(-child.pid, "SIGKILL");
        return "delivered";
      } catch (error) {
        return error?.code === "ESRCH" ? "absent" : "failed";
      }
    };
    const processGroupAbsent = () => {
      if (!Number.isInteger(child?.pid) || child.pid <= 0) return false;
      try {
        killProcess(-child.pid, 0);
        return false;
      } catch (error) {
        return error?.code === "ESRCH";
      }
    };
    const killDirectChild = () => {
      try {
        child?.kill?.("SIGKILL");
      } catch {
        // The secondary deadline still guarantees a stable return.
      }
    };
    const unrefChild = () => {
      try {
        child?.unref?.();
      } catch {
        // Stdio destruction and rejection remain bounded.
      }
    };
    const terminate = (failure) => {
      if (terminating || settled) return;
      terminating = true;
      terminationFailure = failure;
      if (operationTimeout !== undefined) {
        deadlineTimers.clearTimeout(operationTimeout);
        operationTimeout = undefined;
      }
      terminationTimeout = deadlineTimers.setTimeout(() => {
        terminationTimeout = undefined;
        killProcessGroup();
        killDirectChild();
        destroyChildStdio();
        unrefChild();
        terminationFailure.retryable = false;
        settle(() => reject(terminationFailure));
      }, processTerminationTimeoutMs);
      if (killProcessGroup() === "failed") {
        terminationFailure.retryable = false;
        killDirectChild();
      }
      destroyChildStdio();
    };
    const terminateClosedProcessGroup = (failure) => {
      if (terminating || settled) return;
      terminating = true;
      terminationFailure = failure;
      terminationFailure.retryable = false;
      if (operationTimeout !== undefined) {
        deadlineTimers.clearTimeout(operationTimeout);
        operationTimeout = undefined;
      }
      const delivery = killProcessGroup();
      if (delivery === "failed") {
        settle(() => reject(terminationFailure));
        return;
      }
      if (delivery === "absent" || processGroupAbsent()) {
        terminationFailure.retryable = true;
        settle(() => reject(terminationFailure));
        return;
      }
      terminationTimeout = deadlineTimers.setTimeout(() => {
        terminationTimeout = undefined;
        terminationFailure.retryable = processGroupAbsent();
        settle(() => reject(terminationFailure));
      }, processTerminationTimeoutMs);
    };

    try {
      child = spawnProcess(
        processExecutable,
        [workerPath],
        {
          detached: true,
          env: environment,
          stdio: ["pipe", "pipe", "pipe"],
        },
      );
    } catch {
      reject(browserWorkerFailure());
      return;
    }

    operationTimeout = deadlineTimers.setTimeout(() => {
      terminate(browserWorkerFailure({ retryable: true }));
    }, operationTimeoutMs);

    child.stdout.on("data", (chunk) => {
      if (outputOverflow) return;
      output += chunk.toString();
      if (Buffer.byteLength(output) > MAX_BROWSER_WORKER_OUTPUT_BYTES) {
        outputOverflow = true;
        output = "";
        terminate(browserWorkerFailure());
      }
    });
    child.stderr.on("data", () => {
      // Consume without retaining output that could contain browser data.
    });
    child.on("error", () => {
      spawnFailed = true;
      terminate(browserWorkerFailure());
    });
    child.on("close", (code) => {
      if (terminating) {
        settle(() => reject(terminationFailure));
        return;
      }
      if (spawnFailed || outputOverflow) {
        settle(() => reject(browserWorkerFailure()));
        return;
      }
      let response;
      try {
        response = JSON.parse(output.trim());
      } catch {
        settle(() => reject(browserWorkerFailure()));
        return;
      }
      if (code === 0 && response?.ok === true) {
        let result = response.result;
        try {
          if (
            !exactObjectKeys(
              response,
              result === undefined ? ["ok"] : ["ok", "result"],
            )
          ) {
            throw new Error("Hosted browser worker response was invalid.");
          }
          const hostedJourney = input.ownership !== undefined
            || input.registryFixture !== undefined
            || input.rejectionOwnership !== undefined
            || input.rejectionRegistryFixture !== undefined;
          if (hostedJourney) {
            result = validateBrowserMutationResult({
              actor: undefined,
              browserResult: result,
              ownership: validatedOwnership(input.ownership),
              rejectionOwnership: validatedOwnership(
                input.rejectionOwnership,
              ),
              registryFixture: input.registryFixture,
              rejectionRegistryFixture:
                input.rejectionRegistryFixture,
            });
          } else if (result !== undefined) {
            throw new Error("Hosted browser worker response was invalid.");
          }
        } catch {
          settle(() => reject(browserWorkerFailure()));
          return;
        }
        settle(() => resolve(result));
        return;
      }
      const failure = browserWorkerFailure({
        cleanupCode: response?.cleanupCode,
      });
      if (
        response?.cleanupCode === "HOSTED_ACCEPTANCE_CLEANUP_FAILED"
      ) {
        terminateClosedProcessGroup(failure);
        return;
      }
      settle(() => reject(failure));
    });
    child.stdin.on("error", () => {
      spawnFailed = true;
      terminate(browserWorkerFailure());
    });
    child.stdin.end(JSON.stringify({
      ...input,
      operationTimeoutMs,
    }));
  });
}

export function createPlaywrightBrowserProcessAdapter({
  cleanupAttempts = DEFAULT_CLEANUP_ATTEMPTS,
  deadlineTimers = DEFAULT_DEADLINE_TIMERS,
  environment = process.env,
  killProcess = process.kill,
  operationTimeoutMs = DEFAULT_OPERATION_TIMEOUT_MS,
  processExecutable = process.execPath,
  processTerminationTimeoutMs =
    DEFAULT_BROWSER_PROCESS_TERMINATION_TIMEOUT_MS,
  spawnProcess = spawn,
  workerUrl = new URL(
    "./hosted-control-plane-browser-worker.mjs",
    import.meta.url,
  ),
} = {}) {
  const attempts = positiveInteger(cleanupAttempts, "cleanupAttempts");
  const timeoutMs = positiveInteger(
    operationTimeoutMs,
    "operationTimeoutMs",
  );
  const terminationTimeoutMs = positiveInteger(
    processTerminationTimeoutMs,
    "processTerminationTimeoutMs",
  );
  const workerPath = fileURLToPath(workerUrl);
  const workerEnvironment = createBrowserEnvironment(environment);
  return {
    managesOwnDeadline: true,
    async verifyRegistry(input) {
      let primaryFailure;
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        try {
          return await runBrowserWorkerProcess(input, {
            deadlineTimers,
            environment: workerEnvironment,
            killProcess,
            operationTimeoutMs: timeoutMs,
            processExecutable,
            processTerminationTimeoutMs: terminationTimeoutMs,
            spawnProcess,
            workerPath,
          });
        } catch (error) {
          primaryFailure ??= error;
          if (
            error?.cleanupCode === "HOSTED_ACCEPTANCE_CLEANUP_FAILED"
            && primaryFailure.cleanupCode === undefined
          ) {
            primaryFailure.cleanupCode = error.cleanupCode;
          }
          if (error?.retryable !== true || attempt === attempts - 1) {
            throw primaryFailure;
          }
        }
      }
    },
  };
}

function requiredEnvironment(env, name) {
  return requiredString(env[name], name);
}

function uniqueStackOutput(document, key) {
  if (
    !document
    || typeof document !== "object"
    || Array.isArray(document)
  ) {
    throw new HostedAcceptanceError(
      "HOSTED_ACCEPTANCE_CONFIGURATION_INVALID",
      "Hosted control-plane acceptance stack outputs are invalid.",
    );
  }
  const matches = Object.values(document).filter((stack) =>
    stack
    && typeof stack === "object"
    && !Array.isArray(stack)
    && Object.hasOwn(stack, key)
  );
  if (
    matches.length !== 1
    || !meaningfulString(matches[0][key])
  ) {
    throw new HostedAcceptanceError(
      "HOSTED_ACCEPTANCE_CONFIGURATION_INVALID",
      "Hosted control-plane acceptance stack outputs are invalid.",
    );
  }
  return matches[0][key].trim();
}

export function parseHostedAcceptanceStackOutputs({
  controlPlaneOutputs,
  webOutputs,
}) {
  const applicationUrl = uniqueStackOutput(
    webOutputs,
    "ApplicationUrl",
  ).replace(/\/+$/, "");
  const clientId = uniqueStackOutput(webOutputs, "UserPoolClientId");
  const brokerFunctionArn = uniqueStackOutput(
    webOutputs,
    "HostedAcceptanceBrokerFunctionArn",
  );
  const fixtureRegistryId = uniqueStackOutput(
    controlPlaneOutputs,
    "SharedRegistryId",
  );
  const starterBuilderModelId = uniqueStackOutput(
    webOutputs,
    "StarterBuilderModelId",
  );
  const userPoolId = uniqueStackOutput(webOutputs, "UserPoolId");
  if (
    !httpsUrl(applicationUrl)
    || !validBrokerFunctionArn(brokerFunctionArn)
    || !/^[A-Za-z0-9_+]{1,128}$/.test(clientId)
    || !/^[A-Za-z0-9]{12,16}$/.test(fixtureRegistryId)
    || !/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/.test(
      starterBuilderModelId,
    )
    || !/^[a-z]{2}(?:-[a-z0-9]+)+-\d+_[A-Za-z0-9]+$/.test(userPoolId)
  ) {
    throw new HostedAcceptanceError(
      "HOSTED_ACCEPTANCE_CONFIGURATION_INVALID",
      "Hosted control-plane acceptance stack outputs are invalid.",
    );
  }
  return {
    applicationUrl,
    brokerFunctionArn,
    clientId,
    fixtureRegistryId,
    starterBuilderModelId,
    userPoolId,
  };
}

export function readHostedAcceptanceStackOutputs({
  controlPlaneOutputsPath = DEFAULT_CONTROL_PLANE_OUTPUTS_PATH,
  readFile = readFileSync,
  webOutputsPath = DEFAULT_WEB_OUTPUTS_PATH,
} = {}) {
  let controlPlaneOutputs;
  let webOutputs;
  try {
    controlPlaneOutputs = JSON.parse(
      readFile(controlPlaneOutputsPath, "utf8"),
    );
    webOutputs = JSON.parse(readFile(webOutputsPath, "utf8"));
  } catch {
    throw new HostedAcceptanceError(
      "HOSTED_ACCEPTANCE_CONFIGURATION_INVALID",
      "Hosted control-plane acceptance stack outputs are invalid.",
    );
  }
  return parseHostedAcceptanceStackOutputs({
    controlPlaneOutputs,
    webOutputs,
  });
}

export async function runCli({
  argv = [],
  dependencies = {},
  env = process.env,
} = {}) {
  const cleanupOnly = argv.length === 1 && argv[0] === "--cleanup-only";
  if (argv.length !== 0 && !cleanupOnly) {
    throw new HostedAcceptanceError(
      "HOSTED_ACCEPTANCE_CONFIGURATION_INVALID",
      "Usage: hosted-control-plane-acceptance.mjs [--cleanup-only]",
    );
  }
  const region = requiredEnvironment(env, "AWS_REGION");
  const accountId = requiredEnvironment(env, "AWS_ACCOUNT_ID");
  if (!/^[0-9]{12}$/.test(accountId)) {
    throw new HostedAcceptanceError(
      "HOSTED_ACCEPTANCE_CONFIGURATION_INVALID",
      "Hosted control-plane acceptance AWS account is invalid.",
    );
  }
  const readStackOutputs = dependencies.readStackOutputs
    ?? readHostedAcceptanceStackOutputs;
  const outputs = readStackOutputs({
    controlPlaneOutputsPath:
      env.HOSTED_ACCEPTANCE_CONTROL_PLANE_OUTPUTS_FILE
      ?? DEFAULT_CONTROL_PLANE_OUTPUTS_PATH,
    webOutputsPath:
      env.HOSTED_ACCEPTANCE_WEB_OUTPUTS_FILE
      ?? DEFAULT_WEB_OUTPUTS_PATH,
  });
  if (
    !outputs.userPoolId.startsWith(`${region}_`)
    || !validBrokerFunctionArn(
      outputs.brokerFunctionArn,
      { accountId, region },
    )
  ) {
    throw new HostedAcceptanceError(
      "HOSTED_ACCEPTANCE_CONFIGURATION_INVALID",
      "Hosted control-plane acceptance stack outputs are invalid.",
    );
  }
  const cognito = (
    dependencies.createCognitoAdapter
    ?? createAwsCognitoAdapter
  )({ region });
  const lambdaClient = (
    dependencies.createLambdaClient
    ?? ((input) => new LambdaClient(input))
  )({ region });
  const resources = (
    dependencies.createResourceAdapter
    ?? createAwsBrokerResourceAdapter
  )({
    accountId,
    brokerFunctionArn: outputs.brokerFunctionArn,
    lambdaClient,
    region,
  });
  const common = {
    userPoolId: outputs.userPoolId,
    verifierRunId: requiredEnvironment(env, "HOSTED_ACCEPTANCE_RUN_ID"),
    verifierRunAttempt: requiredEnvironment(
      env,
      "HOSTED_ACCEPTANCE_RUN_ATTEMPT",
    ),
  };
  if (cleanupOnly) {
    await (
      dependencies.cleanupRun
      ?? cleanupHostedAcceptanceRun
    )({
      ...common,
      cognito,
      fixtureRegistryId: outputs.fixtureRegistryId,
      operationTimeoutMs: DEFAULT_OPERATION_TIMEOUT_MS,
      resourceOperationTimeoutMs: DEFAULT_RESOURCE_OPERATION_TIMEOUT_MS,
      resources,
    });
    return "cleanup";
  }
  await (
    dependencies.runAcceptance
    ?? runHostedAcceptance
  )({
    applicationUrl: outputs.applicationUrl,
    clientId: outputs.clientId,
    region,
    ...common,
    cognito,
    operationTimeoutMs: DEFAULT_OPERATION_TIMEOUT_MS,
    resourceOperationTimeoutMs: DEFAULT_RESOURCE_OPERATION_TIMEOUT_MS,
    browser: (
      dependencies.createBrowserAdapter
      ?? createPlaywrightBrowserProcessAdapter
    )({
      environment: env,
      operationTimeoutMs: DEFAULT_OPERATION_TIMEOUT_MS,
    }),
    resources,
  });
  return "acceptance";
}

const isExecutable = process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isExecutable) {
  try {
    const mode = await runCli({
      argv: process.argv.slice(2),
      env: process.env,
    });
    console.log(
      mode === "cleanup"
        ? "Hosted verifier cleanup completed."
        : "Hosted control-plane acceptance passed.",
    );
  } catch (error) {
    console.error(
      error instanceof Error
        ? error.message
        : "Hosted control-plane acceptance failed.",
    );
    process.exitCode = 1;
  }
}
