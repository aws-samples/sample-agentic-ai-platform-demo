import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
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
  apiRequest,
  createAcceptanceOwnership,
  createAwsBrokerResourceAdapter,
  createBrowserEnvironment,
  createPrivateArtifactDirectory,
  readHostedAcceptanceStackOutputs,
} from "./hosted-control-plane-acceptance.mjs";

const DEFAULT_OPERATION_TIMEOUT_MS = 28_000;
const DEFAULT_JOURNEY_TIMEOUT_MS = 180_000;
const DEFAULT_BROWSER_PROCESS_TERMINATION_TIMEOUT_MS = 5_000;
const DEFAULT_CLEANUP_ATTEMPTS = 2;
const MIN_CREATE_RECONCILIATION_TIMEOUT_MS = 100;
const MAX_CREATE_RECONCILIATION_TIMEOUT_MS = 5_000;
const CREATE_RECONCILIATION_POLL_INTERVAL_MS = 25;
const MAX_RESPONSE_BYTES = 1_048_576;
const MAX_BROWSER_WORKER_OUTPUT_BYTES = 16_384;
const MAX_BROKER_REQUEST_BYTES = 64 * 1024;
const MAX_BROKER_RESPONSE_BYTES = 16 * 1024;
const MAX_OPERATOR_INPUT_BYTES = 64 * 1024;
const MANAGED_BY = "agentic-ai-platform-demo";
const VIEWPORTS = Object.freeze([
  { name: "desktop", width: 1440, height: 950 },
  { name: "mobile", width: 390, height: 844 },
]);
const EXPECTED_BROWSER_ROLES = Object.freeze([
  "admin",
  "lead",
  "builder",
  "user",
  "user-reload",
  "admin",
]);
const EXPECTED_SCREENSHOTS = Object.freeze(
  VIEWPORTS.flatMap(({ name }) => [
    `admin-${name}.png`,
    `lead-${name}.png`,
    `builder-${name}.png`,
    `user-${name}.png`,
    `user-reload-${name}.png`,
  ]),
);
const USERNAME_PATTERN = /^[\p{L}\p{M}\p{S}\p{N}\p{P}]{1,128}$/u;
const DOMAIN_PATTERN = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;
const JOURNEY_RESOURCE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/;
const RESERVED_DOMAINS = new Set(["platform", "shared"]);
const BROWSER_DIAGNOSTIC_STAGES = Object.freeze([
  "administrator-return",
  "administrator-gateway",
  "approved-agent-mobile-layout",
  "build-full-journey",
  "browser",
  "browser-layout",
  "builder-navigation",
  "cleanup",
  "demo-assist-non-operator",
  "demo-assist-operator",
  "demo-journey-admin",
  "demo-journey-builder",
  "demo-journey-launch",
  "demo-journey-lead",
  "demo-journey-next",
  "demo-journey-previous",
  "demo-journey-return",
  "demo-journey-role-reconciliation",
  "demo-journey-user",
  "demo-selector-only",
  "lead-navigation",
  "scoped-registry-label",
  "scoped-registry-read-only",
  "timeout",
  "user-overview-data",
  "user-overview-navigation",
]);
const BROWSER_DEADLINE_TIMERS = Object.freeze({
  clearTimeout,
  setTimeout,
});
const requireServerlessDependency = createRequire(
  new URL("../infra/serverless-platform/package.json", import.meta.url),
);
const {
  AdminAddUserToGroupCommand,
  AdminCreateUserCommand,
  AdminDeleteUserCommand,
  AdminGetUserCommand,
  AdminInitiateAuthCommand,
  AdminListGroupsForUserCommand,
  AdminSetUserPasswordCommand,
  CognitoIdentityProviderClient,
  GetGroupCommand,
  ResourceNotFoundException,
} = requireServerlessDependency(
  "@aws-sdk/client-cognito-identity-provider",
);

class HostedRoleSwitchingError extends Error {
  constructor(code, message, { stage } = {}) {
    super(message);
    this.name = "HostedRoleSwitchingError";
    this.code = code;
    if (stage !== undefined) this.stage = stage;
  }
}

function configurationFailure() {
  return new HostedRoleSwitchingError(
    "HOSTED_ROLE_SWITCHING_CONFIGURATION_INVALID",
    "Hosted role-switching acceptance configuration is invalid.",
  );
}

function acceptanceFailure(stage = "acceptance") {
  return new HostedRoleSwitchingError(
    "HOSTED_ROLE_SWITCHING_FAILED",
    "Hosted role-switching acceptance failed.",
    { stage },
  );
}

function browserDiagnosticStage(value, fallback) {
  return (
    typeof value === "string"
    && BROWSER_DIAGNOSTIC_STAGES.includes(value)
  )
    ? value
    : fallback;
}

export async function runBrowserStage(stage, operation) {
  try {
    return await operation();
  } catch (error) {
    if (
      error instanceof HostedRoleSwitchingError
      && error.code === "HOSTED_ROLE_SWITCHING_FAILED"
    ) {
      throw error;
    }
    throw acceptanceFailure(
      browserDiagnosticStage(stage, "browser"),
    );
  }
}

function cleanupFailure() {
  return new HostedRoleSwitchingError(
    "HOSTED_ROLE_SWITCHING_CLEANUP_FAILED",
    "Hosted role-switching acceptance cleanup failed.",
    { stage: "cleanup" },
  );
}

function isPlainObject(value) {
  return Boolean(
    value
    && typeof value === "object"
    && !Array.isArray(value)
    && (
      Object.getPrototypeOf(value) === Object.prototype
      || Object.getPrototypeOf(value) === null
    )
  );
}

function requiredString(value) {
  if (typeof value !== "string" || !value.trim()) {
    throw configurationFailure();
  }
  return value.trim();
}

function normalizeOperatorUsernames(usernames) {
  if (
    !Array.isArray(usernames)
    || usernames.length < 1
    || usernames.length > 100
  ) {
    throw configurationFailure();
  }
  const normalized = usernames.map((username) => requiredString(username));
  if (
    normalized.some((username, index) =>
      username !== usernames[index] || !USERNAME_PATTERN.test(username))
    || new Set(normalized).size !== normalized.length
  ) {
    throw configurationFailure();
  }
  return normalized;
}

export function readPrivateOperatorUsernames(
  path,
  readFile = readFileSync,
) {
  const normalizedPath = requiredString(path);
  let input;
  try {
    input = readFile(normalizedPath, "utf8");
  } catch {
    throw configurationFailure();
  }
  if (
    typeof input !== "string"
    || Buffer.byteLength(input) > MAX_OPERATOR_INPUT_BYTES
  ) {
    throw configurationFailure();
  }
  let document;
  try {
    document = JSON.parse(input);
  } catch {
    throw configurationFailure();
  }
  if (
    !isPlainObject(document)
    || Reflect.ownKeys(document).length !== 1
    || !Object.hasOwn(document, "usernames")
  ) {
    throw configurationFailure();
  }
  return normalizeOperatorUsernames(document.usernames);
}

function positiveInteger(value) {
  if (!Number.isInteger(value) || value <= 0 || value > 300_000) {
    throw configurationFailure();
  }
  return value;
}

function runComponent(value, maximumLength) {
  const normalized = requiredString(value);
  if (
    !/^[1-9][0-9]*$/.test(normalized)
    || normalized.length > maximumLength
  ) {
    throw configurationFailure();
  }
  return normalized;
}

export function roleSwitchingUsernames({ runId, runAttempt }) {
  const normalizedRunId = runComponent(runId, 20);
  const normalizedAttempt = runComponent(runAttempt, 6);
  return {
    administrator:
      `hosted-role-switching-admin-${normalizedRunId}-${normalizedAttempt}`,
    reviewer:
      `hosted-role-switching-reviewer-${normalizedRunId}-${normalizedAttempt}`,
    ordinary:
      `hosted-role-switching-ordinary-${normalizedRunId}-${normalizedAttempt}`,
  };
}

export function roleSwitchingRequestIds({ runId, runAttempt }) {
  const normalizedRunId = runComponent(runId, 20);
  const normalizedAttempt = runComponent(runAttempt, 6);
  const ownership = createAcceptanceOwnership({
    verifierRunId: normalizedRunId,
    verifierRunAttempt: normalizedAttempt,
  });
  const requestId = (operation) => {
    const bytes = createHash("sha256")
      .update(
        `hosted-role-switching:${operation}:`
          + `${normalizedRunId}:${normalizedAttempt}`,
      )
      .digest()
      .subarray(0, 16);
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
  };
  return {
    adminDomain: ownership.requestIds.domain,
    builderConfigureAgent: requestId("builder-configure-agent"),
    builderCreateAgent: requestId("builder-create-agent"),
    builderDomain: ownership.requestIds.isolation,
    builderProduction: requestId("builder-production"),
    builderRegistry: ownership.requestIds.registry,
    builderTestAgent: requestId("builder-test-agent"),
    journeyFullPreview: requestId("journey-full-preview"),
    journeyMinimalCreate: requestId("journey-minimal-create"),
    journeyMinimalPreview: requestId("journey-minimal-preview"),
    journeySpecContract: requestId("journey-spec-contract"),
    journeySpecCreate: requestId("journey-spec-create"),
    journeySpecMessageOne: requestId("journey-spec-message-1"),
    journeySpecMessageTwo: requestId("journey-spec-message-2"),
    journeySpecPreview: requestId("journey-spec-preview"),
    leadAccessGrant: requestId("lead-access-grant"),
    leadApproval: requestId("lead-approval"),
    leadDomain: requestId("lead-domain"),
    leadEntitlementGrant: requestId("lead-entitlement-grant"),
    userFeedback: requestId("user-feedback"),
    userDomain: requestId("user-domain"),
    userInvoke: requestId("user-invoke"),
  };
}

function normalizedDomain(value, { allowPlatform = false } = {}) {
  if (
    typeof value !== "string"
    || value.length > 64
    || !DOMAIN_PATTERN.test(value)
    || (RESERVED_DOMAINS.has(value) && !(allowPlatform && value === "platform"))
  ) {
    throw configurationFailure();
  }
  return value;
}

export function demoRoleHeaders(role, domain) {
  if (!["admin", "lead", "builder", "user"].includes(role)) {
    throw configurationFailure();
  }
  if (role === "admin" && domain !== undefined && domain !== null) {
    return {
      "x-demo-role": role,
      "x-active-domain": normalizedDomain(domain, { allowPlatform: true }),
    };
  }
  if (role === "lead" || role === "builder") {
    if (domain === undefined) throw configurationFailure();
    return {
      "x-demo-role": role,
      "x-active-domain": normalizedDomain(domain),
    };
  }
  if (domain !== undefined && domain !== null) {
    throw configurationFailure();
  }
  return { "x-demo-role": role };
}

function validateConfiguration({
  applicationUrl,
  clientId,
  fixtureRegistryId,
  journeyTimeoutMs,
  operatorUsernames,
  operationTimeoutMs,
  preferredBuilderModelId,
  region,
  runAttempt,
  runId,
  userPoolId,
}) {
  let parsedUrl;
  try {
    parsedUrl = new URL(requiredString(applicationUrl));
  } catch {
    throw configurationFailure();
  }
  if (
    parsedUrl.protocol !== "https:"
    || parsedUrl.username
    || parsedUrl.password
    || parsedUrl.search
    || parsedUrl.hash
  ) {
    throw configurationFailure();
  }
  const normalizedRegion = requiredString(region);
  const normalizedPoolId = requiredString(userPoolId);
  const normalizedClientId = requiredString(clientId);
  const normalizedRegistryId = requiredString(fixtureRegistryId);
  if (
    !/^[a-z]{2}(?:-[a-z0-9]+)+-\d+$/.test(normalizedRegion)
    || !normalizedPoolId.startsWith(`${normalizedRegion}_`)
    || !/^[A-Za-z0-9_+]{1,128}$/.test(normalizedClientId)
    || !/^[A-Za-z0-9]{12,16}$/.test(normalizedRegistryId)
  ) {
    throw configurationFailure();
  }
  const normalizedOperators = operatorUsernames === undefined
    ? []
    : normalizeOperatorUsernames(operatorUsernames);
  let normalizedBuilderModelId;
  if (preferredBuilderModelId !== undefined) {
    normalizedBuilderModelId = requiredString(preferredBuilderModelId);
    if (
      normalizedBuilderModelId !== preferredBuilderModelId
      || !MODEL_ID_PATTERN.test(normalizedBuilderModelId)
    ) {
      throw configurationFailure();
    }
  }
  return {
    applicationUrl: parsedUrl.toString().replace(/\/+$/, ""),
    clientId: normalizedClientId,
    fixtureRegistryId: normalizedRegistryId,
    journeyTimeoutMs: positiveInteger(journeyTimeoutMs),
    operatorUsernames: normalizedOperators,
    operationTimeoutMs: positiveInteger(operationTimeoutMs),
    preferredBuilderModelId: normalizedBuilderModelId,
    region: normalizedRegion,
    runAttempt: runComponent(runAttempt, 6),
    runId: runComponent(runId, 20),
    userPoolId: normalizedPoolId,
  };
}

export function selectBuilderModel(models, preferredBuilderModelId) {
  if (!Array.isArray(models)) return null;
  const usable = models.filter((model) =>
    isPlainObject(model)
    && typeof model.id === "string"
    && MODEL_ID_PATTERN.test(model.id)
    && model.access?.usable === true
  );
  if (preferredBuilderModelId === undefined) return usable[0] ?? null;
  return usable.find(({ id }) => id === preferredBuilderModelId) ?? null;
}

export function normalizeBuilderBuildOptions(input) {
  if (!isPlainObject(input)) return null;
  const options = {
    framework: input.framework,
    deployTarget: input.deployTarget,
    memory: input.memory,
    streaming: input.streaming,
    identity: input.identity,
    guardrails: input.guardrails,
  };
  return (
    typeof options.framework === "string"
    && options.framework.length > 0
    && typeof options.deployTarget === "string"
    && options.deployTarget.length > 0
    && ["none", "shortTerm", "longAndShortTerm"].includes(options.memory)
    && ["streaming", "identity", "guardrails"].every(
      (key) => typeof options[key] === "boolean",
    )
  )
    ? options
    : null;
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
    "adminGetUser",
    "adminInitiateAuth",
    "adminListGroupsForUser",
    "adminSetUserPassword",
    "getGroup",
    "isGroupNotFound",
    "isUserNotFound",
  ];
  const resourceMethods = [
    "persistActorMapping",
    "persistPersonaJourneyFixture",
    "provisionExperienceFixture",
    "recoverExperienceFixture",
    "cleanupAgentBuildingJourneyFixtures",
    "cleanupPersonaJourneyFixture",
    "cleanupExperienceFixture",
    "cleanupExactResources",
    "recoverActorMapping",
    "recoverDomain",
    "recoverRegistryFixture",
  ];
  if (
    !browser
    || typeof browser.verifyRoleJourney !== "function"
    || !cognito
    || cognitoMethods.some((method) =>
      typeof cognito[method] !== "function"
    )
    || !resources
    || resourceMethods.some((method) =>
      typeof resources[method] !== "function"
    )
    || typeof fetchImpl !== "function"
    || typeof randomPassword !== "function"
  ) {
    throw configurationFailure();
  }
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

function verifierIdentities(identity) {
  const usernames = roleSwitchingUsernames(identity);
  const runSuffix = `${identity.runId}-${identity.runAttempt}`;
  return [
    {
      label: "administrator",
      name: `Hosted role-switching administrator ${runSuffix}`,
      username: usernames.administrator,
      groups: ["platform-admin", "demo-operator"],
    },
    {
      label: "reviewer",
      name: `Hosted role-switching reviewer ${runSuffix}`,
      username: usernames.reviewer,
      groups: ["platform-admin", "demo-operator"],
    },
    {
      label: "ordinary",
      name: `Hosted role-switching ordinary user ${runSuffix}`,
      username: usernames.ordinary,
      groups: ["end-user"],
    },
  ];
}

function verifierDefinitions(randomPassword, identity) {
  let verifiers;
  try {
    verifiers = verifierIdentities(identity).map((verifier) => ({
      ...verifier,
      password: randomPassword(verifier.label),
    }));
  } catch {
    throw configurationFailure();
  }
  if (
    verifiers.some(({ password }) => !validPassword(password))
    || verifiers[0].password === verifiers[1].password
  ) {
    throw configurationFailure();
  }
  return verifiers;
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
    throw acceptanceFailure("authenticate");
  }
  return {
    accessToken: result.AccessToken,
    idToken: result.IdToken,
    expiresAt: Date.now() + expiresIn * 1_000,
  };
}

async function withDeadline(operation, timeoutMs) {
  const controller = new AbortController();
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(() => operation(controller.signal)),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(acceptanceFailure("timeout"));
        }, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function runStage(stage, operation, timeoutMs) {
  try {
    return await withDeadline(operation, timeoutMs);
  } catch (error) {
    if (error instanceof HostedRoleSwitchingError) {
      throw error;
    }
    throw acceptanceFailure(stage);
  }
}

async function retryCleanup(operation, attempts, timeoutMs) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await withDeadline(operation, timeoutMs);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

function isUsernameExists(error) {
  return error?.name === "UsernameExistsException"
    || error?.code === "UsernameExistsException";
}

function isAmbiguousCreateFailure(error, timedOut) {
  if (isUsernameExists(error)) return false;
  if (timedOut) return true;
  const identifiers = new Set([
    error?.name,
    error?.code,
  ]);
  if ([
    "AbortError",
    "TimeoutError",
    "RequestTimeout",
    "RequestTimeoutException",
    "NetworkingError",
    "ECONNRESET",
    "ECONNABORTED",
    "ETIMEDOUT",
    "EPIPE",
    "ENOTFOUND",
    "EAI_AGAIN",
  ].some((identifier) => identifiers.has(identifier))) {
    return true;
  }
  return Number(error?.$metadata?.httpStatusCode) >= 500;
}

function createReconciliationTimeoutMs(timeoutMs) {
  return Math.min(
    Math.max(timeoutMs, MIN_CREATE_RECONCILIATION_TIMEOUT_MS),
    MAX_CREATE_RECONCILIATION_TIMEOUT_MS,
  );
}

async function awaitBoundedCreateSettlement(settlement, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      settlement,
      new Promise((resolve) => {
        timer = setTimeout(
          () => resolve({ status: "unsettled" }),
          createReconciliationTimeoutMs(timeoutMs),
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function reconcileAmbiguousVerifierCreate({
  cognito,
  timeoutMs,
  userPoolId,
  verifier,
}) {
  const reconciliationTimeoutMs = createReconciliationTimeoutMs(timeoutMs);
  const deadline = Date.now() + reconciliationTimeoutMs;
  while (Date.now() < deadline) {
    const remainingMs = deadline - Date.now();
    const controller = new AbortController();
    let timer;
    const lookup = Promise.resolve().then(() =>
      cognito.adminGetUser({
        userPoolId,
        username: verifier.username,
      }, {
        abortSignal: controller.signal,
      })).then(
      (record) => ({ status: "found", record }),
      (error) => ({ status: "rejected", error }),
    );
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve({ status: "timed-out" });
      }, remainingMs);
    });
    let outcome;
    try {
      outcome = await Promise.race([lookup, timeout]);
    } finally {
      clearTimeout(timer);
    }
    if (outcome.status === "found") {
      try {
        return {
          status: "owned",
          subject: actorFromVerifier(outcome.record, verifier),
        };
      } catch {
        return { status: "unresolved" };
      }
    }
    if (
      outcome.status === "timed-out"
      || !cognito.isUserNotFound(outcome.error)
    ) {
      return { status: "unresolved" };
    }
    const pollDelayMs = Math.min(
      CREATE_RECONCILIATION_POLL_INTERVAL_MS,
      deadline - Date.now(),
    );
    if (pollDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, pollDelayMs));
    }
  }
  return { status: "unresolved" };
}

async function provisionVerifier(
  cognito,
  config,
  verifier,
  ownedVerifierSubjects,
  timeoutMs,
) {
  await runStage(`${verifier.label}-preflight`, async () => {
    try {
      await cognito.adminGetUser({
        userPoolId: config.userPoolId,
        username: verifier.username,
      });
    } catch (error) {
      if (cognito.isUserNotFound(error)) return;
      throw error;
    }
    throw acceptanceFailure(`${verifier.label}-preflight`);
  }, timeoutMs);
  const controller = new AbortController();
  let timer;
  let timedOut = false;
  const settlement = Promise.resolve().then(() =>
    cognito.adminCreateUser({
      userPoolId: config.userPoolId,
      username: verifier.username,
      messageAction: "SUPPRESS",
      userAttributes: [
        { name: "name", value: verifier.name },
        { name: "custom:managed_by", value: MANAGED_BY },
      ],
    }, {
      abortSignal: controller.signal,
    })).then(
    (record) => ({ status: "fulfilled", record }),
    (error) => ({ status: "rejected", error }),
  );
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
      resolve({ status: "timed-out" });
    }, timeoutMs);
  });
  let outcome;
  try {
    outcome = await Promise.race([settlement, timeout]);
    if (outcome.status === "timed-out") {
      outcome = await awaitBoundedCreateSettlement(settlement, timeoutMs);
    }
  } finally {
    clearTimeout(timer);
  }
  if (outcome.status !== "fulfilled") {
    const failure = acceptanceFailure(`${verifier.label}-create`);
    if (
      isAmbiguousCreateFailure(outcome.error, timedOut)
    ) {
      const reconciliation = await reconcileAmbiguousVerifierCreate({
        cognito,
        timeoutMs,
        userPoolId: config.userPoolId,
        verifier,
      });
      if (reconciliation.status === "owned") {
        ownedVerifierSubjects.set(
          verifier.username,
          reconciliation.subject,
        );
      } else {
        failure.cleanupCode =
          "HOSTED_ROLE_SWITCHING_CLEANUP_FAILED";
      }
    }
    throw failure;
  }
  let subject = null;
  try {
    subject = actorFromVerifier(outcome.record, verifier);
  } finally {
    ownedVerifierSubjects.set(verifier.username, subject);
  }
  if (timedOut) throw acceptanceFailure(`${verifier.label}-create`);
  await runStage(`${verifier.label}-password`, () =>
    cognito.adminSetUserPassword({
      userPoolId: config.userPoolId,
      username: verifier.username,
      password: verifier.password,
      permanent: true,
    }), timeoutMs);
  for (const groupName of verifier.groups) {
    await runStage(`${verifier.label}-group`, () =>
      cognito.adminAddUserToGroup({
        userPoolId: config.userPoolId,
        username: verifier.username,
        groupName,
      }), timeoutMs);
  }
}

async function authenticateVerifier(cognito, config, verifier, timeoutMs) {
  return runStage(`${verifier.label}-authenticate`, async () =>
    tokensFromAuthentication(await cognito.adminInitiateAuth({
      userPoolId: config.userPoolId,
      clientId: config.clientId,
      username: verifier.username,
      password: verifier.password,
      authFlow: "ADMIN_USER_PASSWORD_AUTH",
    })), timeoutMs);
}

function scopedFetch(fetchImpl, extraHeaders) {
  return (url, options = {}) => {
    const headers = new Headers(options.headers ?? {});
    for (const [name, value] of Object.entries(extraHeaders)) {
      headers.set(name, value);
    }
    return fetchImpl(url, {
      ...options,
      headers: Object.fromEntries(headers.entries()),
    });
  };
}

async function roleMutationRequest({
  applicationUrl,
  body,
  fetchImpl,
  method,
  path,
  requestId,
  signal,
  token,
}) {
  if (
    method !== "PUT"
    || !isPlainObject(body)
    || typeof requestId !== "string"
  ) {
    throw acceptanceFailure("api-request");
  }
  const serializedBody = JSON.stringify(body);
  if (Buffer.byteLength(serializedBody) > MAX_RESPONSE_BYTES) {
    throw acceptanceFailure("api-request");
  }
  const response = await fetchImpl(`${applicationUrl}${path}`, {
    method,
    headers: {
      accept: "application/json",
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "x-request-id": requestId,
    },
    body: serializedBody,
    signal,
  });
  const contentType = response?.headers?.get?.("content-type");
  const text = await response?.text?.();
  if (
    typeof response?.status !== "number"
    || typeof contentType !== "string"
    || !/^application\/json(?:\s*;|$)/i.test(contentType)
    || typeof text !== "string"
    || Buffer.byteLength(text) > MAX_RESPONSE_BYTES
  ) {
    throw acceptanceFailure("api-response");
  }
  let responseBody;
  try {
    responseBody = JSON.parse(text);
  } catch {
    throw acceptanceFailure("api-response");
  }
  if (!isPlainObject(responseBody)) {
    throw acceptanceFailure("api-response");
  }
  return { response, body: responseBody };
}

async function requestApi({
  applicationUrl,
  body,
  fetchImpl,
  headers = {},
  method = "GET",
  path,
  requestId,
  timeoutMs,
  token,
}) {
  if (method === "PUT") {
    return withDeadline((signal) =>
      roleMutationRequest({
        applicationUrl,
        body,
        fetchImpl: scopedFetch(fetchImpl, headers),
        method,
        path,
        requestId,
        signal,
        token,
      }), timeoutMs);
  }
  return withDeadline((signal) =>
    apiRequest({
      applicationUrl,
      body,
      fetchImpl: scopedFetch(fetchImpl, headers),
      maxResponseBytes: MAX_RESPONSE_BYTES,
      method,
      path,
      requestId,
      signal,
      token,
    }), timeoutMs);
}

function assertResponse(result, status, code) {
  if (
    result?.response?.status !== status
    || (
      code !== undefined
      && result?.body?.code !== code
    )
  ) {
    throw acceptanceFailure("api-contract");
  }
  return result.body;
}

function validateBaseAdministrator(profile) {
  if (
    profile?.ok !== true
    || profile.role !== "admin"
    || profile.authenticatedRole !== "admin"
    || profile.identityProvider !== "cognito"
    || profile.canSwitchDemoRole !== true
    || !Array.isArray(profile.groups)
    || !profile.groups.includes("platform-admin")
    || !profile.groups.includes("demo-operator")
    || !Array.isArray(profile.availableDemoRoles)
    || !isDeepStrictEqual(
      profile.availableDemoRoles,
      ["admin", "lead", "builder", "user"],
    )
    || !Array.isArray(profile.availableDemoDomains)
    || typeof profile.user !== "string"
    || !profile.user
  ) {
    throw acceptanceFailure("administrator-profile");
  }
  if (profile.availableDemoDomains.some((domain) =>
    !isPlainObject(domain)
    || typeof domain.id !== "string"
    || typeof domain.name !== "string"
    || RESERVED_DOMAINS.has(domain.id)
    || !DOMAIN_PATTERN.test(domain.id)
  )) {
    throw acceptanceFailure("administrator-domains");
  }
  const journeyDomain = [...profile.availableDemoDomains]
    .sort((left, right) => left.id.localeCompare(right.id))[0];
  if (journeyDomain === undefined) {
    throw acceptanceFailure("administrator-domains");
  }
  return {
    actor: profile.user,
    journeyDomain: {
      id: journeyDomain.id,
      name: journeyDomain.name,
    },
  };
}

function validateEffectiveProfile(profile, role, domain) {
  if (
    profile?.ok !== true
    || profile.authenticatedRole !== "admin"
    || profile.role !== role
    || profile.demoRoleActive !== true
    || profile.canSwitchDemoRole !== true
    || (
      domain === null
        ? profile.domain !== null
        : (
            profile.domain !== domain
            || !isDeepStrictEqual(profile.domains, [domain])
          )
    )
  ) {
    throw acceptanceFailure(`${role}-profile`);
  }
}

function validateDomainProjection(body, expectedIds) {
  if (
    body?.ok !== true
    || !Array.isArray(body.domains)
    || !isDeepStrictEqual(
      body.domains.map(({ id }) => id),
      expectedIds,
    )
  ) {
    throw acceptanceFailure("domain-isolation");
  }
}

function validateScopedRegistry(body, domain) {
  if (
    body?.ok !== true
    || body.source !== "aws"
    || !Array.isArray(body.entries)
    || body.entries.some((entry) =>
      !isPlainObject(entry)
      || ![domain, "shared"].includes(entry.domain)
    )
  ) {
    throw acceptanceFailure("registry-domain-isolation");
  }
}

function validateHostedCollection(body, resource, domain) {
  if (
    body?.ok !== true
    || body.resource !== resource
    || !Array.isArray(body.items)
    || (
      domain !== undefined
      && body.items.some((item) =>
        !isPlainObject(item) || item.domainId !== domain)
    )
  ) {
    throw acceptanceFailure(`${resource}-scope`);
  }
}

function containsForbiddenExperienceKey(value) {
  if (Array.isArray(value)) {
    return value.some(containsForbiddenExperienceKey);
  }
  if (!isPlainObject(value)) return false;
  const forbidden = new Set([
    "_aws",
    "runtimeArn",
    "runtimeId",
    "endpointArn",
    "endpointName",
    "projectId",
    "createdBy",
    "decidedBy",
    "statusReason",
  ]);
  return Object.entries(value).some(([key, child]) =>
    forbidden.has(key) || containsForbiddenExperienceKey(child)
  );
}

function validateEndUserAgents(body, expectedEntitledAgentIds) {
  const expectedIds = Array.isArray(expectedEntitledAgentIds)
    ? expectedEntitledAgentIds
    : [];
  const expectedIdSet = new Set(expectedIds);
  const actualIds = Array.isArray(body?.items)
    ? body.items.map(({ id } = {}) => id)
    : [];
  if (
    body?.ok !== true
    || !Array.isArray(body.items)
    || !Array.isArray(body.requestableItems)
    || expectedIds.length === 0
    || expectedIdSet.size !== expectedIds.length
    || expectedIds.some((id) => !/^agent-[a-f0-9]{32}$/.test(id))
    || actualIds.length !== expectedIds.length
    || new Set(actualIds).size !== actualIds.length
    || actualIds.some((id) => !expectedIdSet.has(id))
    || body.items.some((agent) =>
      !isPlainObject(agent)
      || !/^agent-[a-f0-9]{32}$/.test(agent.id)
      || typeof agent.name !== "string"
      || typeof agent.description !== "string"
    )
    || body.requestableItems.some((agent) =>
      !isPlainObject(agent)
      || !/^agent-[a-f0-9]{32}$/.test(agent.id)
      || typeof agent.domainId !== "string"
      || typeof agent.name !== "string"
      || typeof agent.description !== "string"
      || Object.keys(agent).some((key) =>
        !["id", "domainId", "name", "description"].includes(key))
    )
    || containsForbiddenExperienceKey(body)
  ) {
    throw acceptanceFailure("end-user-agents");
  }
}

function validateEndUserList(body, resource) {
  if (
    body?.ok !== true
    || !Array.isArray(body.items)
    || containsForbiddenExperienceKey(body)
  ) {
    throw acceptanceFailure(`end-user-${resource}`);
  }
}

function validateAgentEntitlements(body, domainId) {
  const keys = new Set([
    "subjectType",
    "subject",
    "domainId",
    "projectId",
    "agentId",
    "status",
    "expiresAt",
    "grantedAt",
    "revokedAt",
  ]);
  const timestampOrNull = (value) =>
    value === null
    || (
      typeof value === "string"
      && value.length <= 64
      && Number.isFinite(Date.parse(value))
    );
  if (
    body?.ok !== true
    || !Array.isArray(body.items)
    || body.items.length === 0
    || !(
      body.cursor === null
      || (
        typeof body.cursor === "string"
        && body.cursor.length > 0
        && body.cursor.length <= 4096
      )
    )
    || body.items.some((item) =>
      !isPlainObject(item)
      || Reflect.ownKeys(item).length !== keys.size
      || Reflect.ownKeys(item).some((key) =>
        typeof key !== "string" || !keys.has(key))
      || !["USER", "GROUP", "DOMAIN"].includes(item.subjectType)
      || typeof item.subject !== "string"
      || !item.subject
      || typeof item.domainId !== "string"
      || !item.domainId
      || (domainId !== undefined && item.domainId !== domainId)
      || typeof item.projectId !== "string"
      || !item.projectId
      || typeof item.agentId !== "string"
      || !item.agentId
      || !["ACTIVE", "REVOKED"].includes(item.status)
      || !timestampOrNull(item.expiresAt)
      || !timestampOrNull(item.grantedAt)
      || !timestampOrNull(item.revokedAt)
    )
  ) {
    throw acceptanceFailure("agent-entitlements");
  }
}

function validateAccessMembers(body, {
  domainId,
  projectId,
  requireItems = false,
}) {
  const bodyKeys = new Set([
    "ok",
    "domainId",
    ...(projectId === undefined ? [] : ["projectId"]),
    "items",
    "cursor",
  ]);
  const memberKeys = new Set([
    "username",
    "subject",
    "enabled",
    "userStatus",
  ]);
  if (
    !isPlainObject(body)
    || Reflect.ownKeys(body).length !== bodyKeys.size
    || Reflect.ownKeys(body).some((key) =>
      typeof key !== "string" || !bodyKeys.has(key))
    || body.ok !== true
    || body.domainId !== domainId
    || (
      projectId !== undefined
      && body.projectId !== projectId
    )
    || !Array.isArray(body.items)
    || (requireItems && body.items.length === 0)
    || !(
      body.cursor === null
      || (
        typeof body.cursor === "string"
        && body.cursor.length > 0
        && body.cursor.length <= 2048
      )
    )
    || body.items.some((member) =>
      !isPlainObject(member)
      || Reflect.ownKeys(member).length !== memberKeys.size
      || Reflect.ownKeys(member).some((key) =>
        typeof key !== "string" || !memberKeys.has(key))
      || typeof member.username !== "string"
      || !member.username
      || typeof member.subject !== "string"
      || !member.subject
      || typeof member.enabled !== "boolean"
      || typeof member.userStatus !== "string"
      || !member.userStatus
    )
  ) {
    throw acceptanceFailure("access-members");
  }
}

function validateBrowserEvidence(evidence, domain) {
  if (
    !isPlainObject(evidence)
    || evidence.domainId !== domain.id
    || !isDeepStrictEqual(evidence.roles, EXPECTED_BROWSER_ROLES)
    || !isDeepStrictEqual(evidence.screenshots, EXPECTED_SCREENSHOTS)
  ) {
    throw acceptanceFailure("browser-evidence");
  }
}

function projectOperatorRecord(record, groupResponse) {
  const subjects = Array.isArray(record?.UserAttributes)
    ? record.UserAttributes.filter(({ Name, Value } = {}) =>
        Name === "sub"
        && typeof Value === "string"
        && Value
      )
    : [];
  const groups = Array.isArray(groupResponse?.Groups)
    ? groupResponse.Groups.map((group) => group?.GroupName)
    : [];
  if (
    typeof record?.Username !== "string"
    || record.Enabled !== true
    || record.UserStatus !== "CONFIRMED"
    || subjects.length !== 1
    || groups.some((group) => typeof group !== "string" || !group)
    || new Set(groups).size !== groups.length
    || !groups.includes("platform-admin")
    || !groups.includes("demo-operator")
  ) {
    throw acceptanceFailure("operator-postcondition");
  }
  return {
    enabled: true,
    groups: groups.toSorted(),
    status: "CONFIRMED",
    subject: subjects[0].Value,
    username: record.Username,
  };
}

async function readOperatorRecord(cognito, config, username, attempts = 1) {
  const read = async (operation) => (
    attempts === 1
      ? operation()
      : retryCleanup(operation, attempts, config.operationTimeoutMs)
  );
  const [record, groups] = await Promise.all([
    read(() => cognito.adminGetUser({
      userPoolId: config.userPoolId,
      username,
    })),
    read(() => cognito.adminListGroupsForUser({
      userPoolId: config.userPoolId,
      username,
    })),
  ]);
  return projectOperatorRecord(record, groups);
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

function validateCreatedDomain(body, ownership, actor) {
  const domain = body?.domain;
  if (
    body?.ok !== true
    || !isPlainObject(domain)
    || domain.id !== ownership.domainId
    || domain.name !== ownership.domainName
    || domain.ownerGroup !== ownership.ownerGroup
    || domain.status !== "ACTIVE"
    || domain.createdBy !== actor
    || typeof domain.registryId !== "string"
    || !/^[A-Za-z0-9]{12,16}$/.test(domain.registryId)
    || typeof domain.registryArn !== "string"
    || !/^arn:aws:agent-registry:[a-z0-9-]+:[0-9]{12}:registry\/[A-Za-z0-9]{12,16}$/
      .test(domain.registryArn)
  ) {
    throw acceptanceFailure("administrator-domain-create");
  }
  return {
    createdBy: domain.createdBy,
    id: domain.id,
    name: domain.name,
    ownerGroup: domain.ownerGroup,
    registryArn: domain.registryArn,
    registryId: domain.registryId,
    status: domain.status,
  };
}

function personaJourneyIdentity(ownership, domainId, projectId) {
  return {
    domainId,
    projectId,
    agentId: `acceptance-agent-${ownership.runId}-${ownership.runAttempt}`,
    deploymentId:
      `acceptance-production-${ownership.runId}-${ownership.runAttempt}`,
    approvalId:
      `acceptance-production-approval-`
      + `${ownership.runId}-${ownership.runAttempt}`,
  };
}

function publicAgentId({ domainId, projectId, agentId }) {
  return `agent-${
    createHash("sha256")
      .update(`${domainId}\0${projectId}\0${agentId}`)
      .digest("hex")
      .slice(0, 32)
  }`;
}

function validateActorProfile(profile, expectedRole) {
  if (
    profile?.ok !== true
    || profile.role !== expectedRole
    || typeof profile.user !== "string"
    || !profile.user
  ) {
    throw acceptanceFailure(`${expectedRole}-actor`);
  }
  return profile.user;
}

function validateAgentMutation(body, fixture, status) {
  if (
    body?.ok !== true
    || body.agent?.domainId !== fixture.domainId
    || body.agent?.projectId !== fixture.projectId
    || body.agent?.id !== fixture.agentId
    || body.agent?.status !== status
  ) {
    throw acceptanceFailure("builder-positive-journey");
  }
}

function validateDeploymentMutation(body, fixture, {
  agentStatus,
  approvalStatus,
  deploymentStatus,
}) {
  validateAgentMutation(body, fixture, agentStatus);
  if (
    body.deployment?.id !== fixture.deploymentId
    || body.deployment?.status !== deploymentStatus
    || body.approval?.id !== fixture.approvalId
    || body.approval?.status !== approvalStatus
  ) {
    throw acceptanceFailure("deployment-positive-journey");
  }
}

function agentBuildingRepositoryNames(ownership) {
  const suffix = `${ownership.runId}-${ownership.runAttempt}`;
  return {
    FULL: `acceptance-full-${suffix}`,
    MINIMAL: `acceptance-minimal-${suffix}`,
    SPEC: `acceptance-spec-${suffix}`,
  };
}

function validateJourney(body, {
  actor,
  domainId,
  preset,
  repositoryName,
  status,
}) {
  const journey = body?.journey;
  if (
    body?.ok !== true
    || !isPlainObject(journey)
    || !JOURNEY_RESOURCE_ID_PATTERN.test(journey.id)
    || journey.actor !== actor
    || journey.domainId !== domainId
    || journey.preset !== preset
    || journey.repositoryName !== repositoryName
    || journey.status !== status
  ) {
    throw acceptanceFailure(`journey-${preset.toLowerCase()}`);
  }
  return journey;
}

function contractAgentPayload(journey, payload) {
  const profile = journey?.inception?.profile;
  if (!isPlainObject(profile)) {
    throw acceptanceFailure("journey-spec-contract");
  }
  const capabilities = Array.isArray(profile.capabilities)
    ? profile.capabilities
    : [];
  const compliance = Array.isArray(profile.compliance)
    ? profile.compliance
    : [];
  const instructions = [
    profile.summary
      || `Implement the approved specification for ${journey.repositoryName}.`,
    capabilities.length
      ? `Required capabilities:\n- ${capabilities.join("\n- ")}`
      : "",
    profile.performsActions === false
      ? "The Agent must remain read-only."
      : "",
    compliance.length
      ? `Compliance requirements:\n- ${compliance.join("\n- ")}`
      : "",
  ].filter(Boolean).join("\n\n");
  return {
    ...payload,
    name: profile.name || payload.name,
    description: profile.summary || payload.description,
    buildConfig: {
      ...payload.buildConfig,
      instructions,
    },
  };
}

function validateDeliveryPreview(body, {
  actor,
  agentId,
  domainId,
  preset,
  projectId,
  repositoryName,
}) {
  const delivery = body?.delivery;
  const paths = delivery?.manifest?.entries?.map(({ path }) => path);
  if (
    body?.ok !== true
    || !isPlainObject(delivery)
    || !JOURNEY_RESOURCE_ID_PATTERN.test(delivery.id)
    || delivery.actor !== actor
    || delivery.domainId !== domainId
    || delivery.role !== "builder"
    || delivery.preset !== preset
    || delivery.repositoryName !== repositoryName
    || delivery.visibility !== "private"
    || delivery.status !== "PREVIEWED"
    || !Array.isArray(paths)
    || paths.length === 0
    || !/^[a-f0-9]{64}$/.test(delivery.manifest.fingerprint)
  ) {
    throw acceptanceFailure(`delivery-${preset.toLowerCase()}`);
  }
  if (
    preset === "MINIMAL"
    && (
      paths.some((path) => path.startsWith("app/"))
      || paths.includes("SPEC.md")
      || paths.includes(".github/workflows/deploy-dev.yml")
      || !paths.includes("README.md")
      || !paths.includes("gates/platform-gates.json")
    )
  ) {
    throw acceptanceFailure("delivery-minimal");
  }
  if (
    preset === "SPEC"
    && (
      delivery.source?.agent?.domainId !== domainId
      || delivery.source?.agent?.projectId !== projectId
      || delivery.source?.agent?.agentId !== agentId
      || delivery.source?.agent?.status !== "READY_FOR_TEST"
      ||
      paths.some((path) => path.startsWith("app/"))
      || paths.includes(".github/workflows/deploy-dev.yml")
      || !paths.includes("agent-binding.json")
      || !paths.includes("SPEC.md")
      || !paths.includes("tests/test_acceptance.py")
    )
  ) {
    throw acceptanceFailure("delivery-spec");
  }
  if (
    preset === "FULL"
    && (
      delivery.source?.snapshot?.agent?.id !== agentId
      || !paths.includes("agentcore/agentcore.json")
      || !paths.includes("gates/check-resource-bindings.mjs")
      || !paths.includes(".github/workflows/deploy-dev.yml")
    )
  ) {
    throw acceptanceFailure("delivery-full");
  }
  return delivery;
}

async function verifyAgentBuildingJourneys({
  actor,
  agentPayload,
  applicationUrl,
  builderHeaders,
  fetchImpl,
  ownership,
  personaFixture,
  requestIds,
  timeoutMs,
  token,
}) {
  const repositories = agentBuildingRepositoryNames(ownership);
  const createJourney = async (preset, requestId) => {
    const result = await requestApi({
      applicationUrl,
      body: {
        preset,
        repositoryName: repositories[preset],
      },
      fetchImpl,
      headers: builderHeaders,
      method: "POST",
      path: "/api/journeys",
      requestId,
      timeoutMs,
      token,
    });
    return validateJourney(assertResponse(result, 201), {
      actor,
      domainId: personaFixture.domainId,
      preset,
      repositoryName: repositories[preset],
      status: "DRAFT",
    });
  };
  const createPreview = async (preset, requestId, payload) => {
    const result = await requestApi({
      applicationUrl,
      body: {
        preset,
        repositoryName: repositories[preset],
        ...payload,
      },
      fetchImpl,
      headers: builderHeaders,
      method: "POST",
      path: "/api/delivery/previews",
      requestId,
      timeoutMs,
      token,
    });
    return validateDeliveryPreview(assertResponse(result, 201), {
      actor,
      agentId: personaFixture.agentId,
      domainId: personaFixture.domainId,
      preset,
      projectId: personaFixture.projectId,
      repositoryName: repositories[preset],
    });
  };

  const minimal = await createJourney(
    "MINIMAL",
    requestIds.journeyMinimalCreate,
  );
  await createPreview("MINIMAL", requestIds.journeyMinimalPreview, {
    journeyId: minimal.id,
  });

  const spec = await createJourney("SPEC", requestIds.journeySpecCreate);
  for (const [requestId, text] of [
    [
      requestIds.journeySpecMessageOne,
      "Design a read-only assistant for support staff to triage cases.",
    ],
    [
      requestIds.journeySpecMessageTwo,
      "Use the approved case system and explain when evidence is missing.",
    ],
  ]) {
    const message = await requestApi({
      applicationUrl,
      body: { text },
      fetchImpl,
      headers: builderHeaders,
      method: "POST",
      path: `/api/journeys/${encodeURIComponent(spec.id)}/messages`,
      requestId,
      timeoutMs,
      token,
    });
    validateJourney(assertResponse(message, 200), {
      actor,
      domainId: personaFixture.domainId,
      preset: "SPEC",
      repositoryName: repositories.SPEC,
      status: "DRAFT",
    });
  }
  const contract = await requestApi({
    applicationUrl,
    body: {},
    fetchImpl,
    headers: builderHeaders,
    method: "POST",
    path: `/api/journeys/${encodeURIComponent(spec.id)}/contract`,
    requestId: requestIds.journeySpecContract,
    timeoutMs,
    token,
  });
  const contracted = validateJourney(assertResponse(contract, 200), {
    actor,
    domainId: personaFixture.domainId,
    preset: "SPEC",
    repositoryName: repositories.SPEC,
    status: "CONTRACT_READY",
  });
  if (!isPlainObject(contracted.inception)) {
    throw acceptanceFailure("journey-spec-contract");
  }
  const configuredPayload = contractAgentPayload(contracted, agentPayload);
  const createdAgent = await requestApi({
    applicationUrl,
    body: configuredPayload,
    fetchImpl,
    headers: builderHeaders,
    method: "POST",
    path: "/api/agents",
    requestId: requestIds.builderCreateAgent,
    timeoutMs,
    token,
  });
  validateAgentMutation(
    assertResponse(createdAgent, 201),
    personaFixture,
    "DRAFT",
  );
  const configuredAgent = await requestApi({
    applicationUrl,
    body: configuredPayload,
    fetchImpl,
    headers: builderHeaders,
    method: "PUT",
    path: `/api/agents/${encodeURIComponent(personaFixture.agentId)}`,
    requestId: requestIds.builderConfigureAgent,
    timeoutMs,
    token,
  });
  validateAgentMutation(
    assertResponse(configuredAgent, 200),
    personaFixture,
    "READY_FOR_TEST",
  );
  await createPreview("SPEC", requestIds.journeySpecPreview, {
    journeyId: spec.id,
    projectId: personaFixture.projectId,
    agentId: personaFixture.agentId,
  });
  const testedAgent = await requestApi({
    applicationUrl,
    body: {
      domainId: personaFixture.domainId,
      projectId: personaFixture.projectId,
      prompt: "Confirm this acceptance agent is ready.",
      maxTokens: 128,
    },
    fetchImpl,
    headers: builderHeaders,
    method: "POST",
    path: `/api/agents/${encodeURIComponent(personaFixture.agentId)}/test`,
    requestId: requestIds.builderTestAgent,
    timeoutMs,
    token,
  });
  const testedBody = assertResponse(testedAgent, 200);
  validateAgentMutation(testedBody, personaFixture, "TESTED");
  if (
    typeof testedBody.test?.requestId !== "string"
    || typeof testedBody.test?.output !== "string"
  ) {
    throw acceptanceFailure("builder-test");
  }
  await createPreview("FULL", requestIds.journeyFullPreview, {
    projectId: personaFixture.projectId,
    agentId: personaFixture.agentId,
  });

  const github = await requestApi({
    applicationUrl,
    fetchImpl,
    headers: builderHeaders,
    path: "/api/delivery/github",
    timeoutMs,
    token,
  });
  const githubBody = assertResponse(github, 200);
  if (
    githubBody?.ok !== true
    || !isDeepStrictEqual(githubBody.github, {
      configured: true,
      connected: false,
      owner: null,
    })
  ) {
    throw acceptanceFailure("delivery-github-configuration");
  }
}

async function verifyApiJourney({
  applicationUrl,
  fetchImpl,
  ownership,
  requestIds,
  administratorTokens,
  reviewerTokens,
  ordinaryTokens,
  preferredBuilderModelId,
  usernames,
  resources,
  state,
  timeoutMs,
}) {
  const baseMe = await requestApi({
    applicationUrl,
    fetchImpl,
    path: "/api/me",
    timeoutMs,
    token: administratorTokens.accessToken,
  });
  const { actor, journeyDomain } = validateBaseAdministrator(
    assertResponse(baseMe, 200),
  );
  state.actor = actor;
  await resources.persistActorMapping({ actor, ownership });
  const domainPayload = expectedDomainPayload(ownership);
  let adminDomainMutation;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    adminDomainMutation = await requestApi({
      applicationUrl,
      body: domainPayload,
      fetchImpl,
      method: "POST",
      path: "/api/domain-create",
      requestId: requestIds.adminDomain,
      timeoutMs,
      token: administratorTokens.accessToken,
    });
    if (
      adminDomainMutation.response.status !== 503
      || adminDomainMutation.body.ok !== false
      || adminDomainMutation.body.code !== "DOMAIN_PROVISIONING_FAILED"
      || adminDomainMutation.body.retryable !== true
    ) {
      break;
    }
  }
  state.createdDomain = validateCreatedDomain(
    assertResponse(adminDomainMutation, 200),
    ownership,
    actor,
  );
  const domain = journeyDomain;
  state.domain = domain;
  state.experienceFixture = await resources.provisionExperienceFixture({
    actor,
    domainId: domain.id,
    ownership,
  });
  state.personaFixture = personaJourneyIdentity(
    ownership,
    domain.id,
    state.experienceFixture.projectId,
  );
  const reviewerHeaders = demoRoleHeaders("lead", domain.id);
  const reviewerMe = await requestApi({
    applicationUrl,
    fetchImpl,
    headers: reviewerHeaders,
    path: "/api/me",
    timeoutMs,
    token: reviewerTokens.accessToken,
  });
  const reviewerProfile = assertResponse(reviewerMe, 200);
  validateEffectiveProfile(reviewerProfile, "lead", domain.id);
  state.reviewerActor = reviewerProfile.user;
  const ordinaryMe = await requestApi({
    applicationUrl,
    fetchImpl,
    path: "/api/me",
    timeoutMs,
    token: ordinaryTokens.accessToken,
  });
  state.ordinaryActor = validateActorProfile(
    assertResponse(ordinaryMe, 200),
    "user",
  );
  await resources.persistPersonaJourneyFixture({
    actors: {
      administrator: actor,
      reviewer: state.reviewerActor,
      ordinary: state.ordinaryActor,
    },
    domainId: domain.id,
    ownership,
  });

  const gateway = await requestApi({
    applicationUrl,
    fetchImpl,
    path: "/api/ai-gateway",
    timeoutMs,
    token: administratorTokens.accessToken,
  });
  const gatewayBody = assertResponse(gateway, 200);
  if (
    gatewayBody?.ok !== true
    || gatewayBody.source !== "aws"
    || !Array.isArray(gatewayBody.models)
  ) {
    throw acceptanceFailure("administrator-gateway");
  }

  const adminDomains = await requestApi({
    applicationUrl,
    fetchImpl,
    path: "/api/domains",
    timeoutMs,
    token: administratorTokens.accessToken,
  });
  const adminDomainBody = assertResponse(adminDomains, 200);
  if (
    !Array.isArray(adminDomainBody?.domains)
    || !adminDomainBody.domains.some(({ id }) => id === domain.id)
  ) {
    throw acceptanceFailure("administrator-domains");
  }
  for (const resource of [
    "projects",
    "agents",
    "deployments",
    "approvals",
  ]) {
    const result = await requestApi({
      applicationUrl,
      fetchImpl,
      path: `/api/${resource}`,
      timeoutMs,
      token: administratorTokens.accessToken,
    });
    validateHostedCollection(
      assertResponse(result, 200),
      resource,
      undefined,
    );
  }
  const adminEntitlements = await requestApi({
    applicationUrl,
    fetchImpl,
    path: "/api/governance/agent-entitlements",
    timeoutMs,
    token: administratorTokens.accessToken,
  });
  validateAgentEntitlements(assertResponse(adminEntitlements, 200));
  const domainMembersPath =
    `/api/access/domain-members?domainId=${encodeURIComponent(domain.id)}`
    + "&limit=50";
  const projectMembersPath =
    `/api/access/project-members?domainId=${encodeURIComponent(domain.id)}`
    + `&projectId=${encodeURIComponent(state.experienceFixture.projectId)}`
    + "&limit=50";
  const adminDomainMembers = await requestApi({
    applicationUrl,
    fetchImpl,
    path: domainMembersPath,
    timeoutMs,
    token: administratorTokens.accessToken,
  });
  validateAccessMembers(assertResponse(adminDomainMembers, 200), {
    domainId: domain.id,
  });
  const adminProjectMembers = await requestApi({
    applicationUrl,
    fetchImpl,
    path: projectMembersPath,
    timeoutMs,
    token: administratorTokens.accessToken,
  });
  validateAccessMembers(assertResponse(adminProjectMembers, 200), {
    domainId: domain.id,
    projectId: state.experienceFixture.projectId,
    requireItems: true,
  });

  const leadHeaders = demoRoleHeaders("lead", domain.id);
  const leadMe = await requestApi({
    applicationUrl,
    fetchImpl,
    headers: leadHeaders,
    path: "/api/me",
    timeoutMs,
    token: administratorTokens.accessToken,
  });
  validateEffectiveProfile(assertResponse(leadMe, 200), "lead", domain.id);
  const leadDomains = await requestApi({
    applicationUrl,
    fetchImpl,
    headers: leadHeaders,
    path: "/api/domains",
    timeoutMs,
    token: administratorTokens.accessToken,
  });
  validateDomainProjection(assertResponse(leadDomains, 200), [domain.id]);
  const leadRegistry = await requestApi({
    applicationUrl,
    fetchImpl,
    headers: leadHeaders,
    path: "/api/registry?type=Agent",
    timeoutMs,
    token: administratorTokens.accessToken,
  });
  validateScopedRegistry(assertResponse(leadRegistry, 200), domain.id);
  const leadGateway = await requestApi({
    applicationUrl,
    fetchImpl,
    headers: leadHeaders,
    path: "/api/ai-gateway",
    timeoutMs,
    token: administratorTokens.accessToken,
  });
  const leadGatewayBody = assertResponse(leadGateway, 200);
  if (
    leadGatewayBody?.ok !== true
    || leadGatewayBody.source !== "aws"
    || !Array.isArray(leadGatewayBody.models)
  ) {
    throw acceptanceFailure("lead-gateway");
  }
  for (const resource of [
    "projects",
    "agents",
    "deployments",
    "approvals",
  ]) {
    const result = await requestApi({
      applicationUrl,
      fetchImpl,
      headers: leadHeaders,
      path: `/api/${resource}`,
      timeoutMs,
      token: administratorTokens.accessToken,
    });
    validateHostedCollection(
      assertResponse(result, 200),
      resource,
      domain.id,
    );
  }
  const leadEntitlements = await requestApi({
    applicationUrl,
    fetchImpl,
    headers: leadHeaders,
    path: "/api/governance/agent-entitlements",
    timeoutMs,
    token: administratorTokens.accessToken,
  });
  validateAgentEntitlements(
    assertResponse(leadEntitlements, 200),
    domain.id,
  );
  const leadDomainMembers = await requestApi({
    applicationUrl,
    fetchImpl,
    headers: leadHeaders,
    path: domainMembersPath,
    timeoutMs,
    token: administratorTokens.accessToken,
  });
  validateAccessMembers(assertResponse(leadDomainMembers, 200), {
    domainId: domain.id,
  });
  const leadProjectMembers = await requestApi({
    applicationUrl,
    fetchImpl,
    headers: leadHeaders,
    path: projectMembersPath,
    timeoutMs,
    token: administratorTokens.accessToken,
  });
  validateAccessMembers(assertResponse(leadProjectMembers, 200), {
    domainId: domain.id,
    projectId: state.experienceFixture.projectId,
    requireItems: true,
  });
  const leadMutation = await requestApi({
    applicationUrl,
    body: expectedDomainPayload(ownership),
    fetchImpl,
    headers: leadHeaders,
    method: "POST",
    path: "/api/domain-create",
    requestId: requestIds.leadDomain,
    timeoutMs,
    token: administratorTokens.accessToken,
  });
  const unexpectedlyCreatedDomain =
    leadMutation.response.status === 200
      ? leadMutation.body?.domain
      : undefined;
  state.unexpectedlyCreatedDomain = unexpectedlyCreatedDomain;
  assertResponse(leadMutation, 403, "FORBIDDEN");

  const builderHeaders = demoRoleHeaders("builder", domain.id);
  const builderMe = await requestApi({
    applicationUrl,
    fetchImpl,
    headers: builderHeaders,
    path: "/api/me",
    timeoutMs,
    token: administratorTokens.accessToken,
  });
  validateEffectiveProfile(
    assertResponse(builderMe, 200),
    "builder",
    domain.id,
  );
  const builderDomains = await requestApi({
    applicationUrl,
    fetchImpl,
    headers: builderHeaders,
    path: "/api/domains",
    timeoutMs,
    token: administratorTokens.accessToken,
  });
  validateDomainProjection(assertResponse(builderDomains, 200), [domain.id]);
  const builderRegistry = await requestApi({
    applicationUrl,
    fetchImpl,
    headers: builderHeaders,
    path: "/api/registry?type=Agent",
    timeoutMs,
    token: administratorTokens.accessToken,
  });
  validateScopedRegistry(assertResponse(builderRegistry, 200), domain.id);
  const builderBlueprints = await requestApi({
    applicationUrl,
    fetchImpl,
    headers: builderHeaders,
    path: "/api/registry?type=Blueprint",
    timeoutMs,
    token: administratorTokens.accessToken,
  });
  const builderBlueprintBody = assertResponse(builderBlueprints, 200);
  validateScopedRegistry(builderBlueprintBody, domain.id);
  const builderBlueprint = builderBlueprintBody.entries
    .map((entry) => ({
      entry,
      version: entry.versions?.find((version) =>
        version.semver === entry.defaultVersion
        && version.status === "APPROVED"
        && isPlainObject(version.content?.template)),
    }))
    .find(({ entry, version }) =>
      version
      && ["chat-assistant", "workflow-orchestrator"].includes(entry.id));
  if (!builderBlueprint) throw acceptanceFailure("builder-blueprint");
  for (const resource of [
    "projects",
    "agents",
    "deployments",
    "approvals",
  ]) {
    const result = await requestApi({
      applicationUrl,
      fetchImpl,
      headers: builderHeaders,
      path: `/api/${resource}`,
      timeoutMs,
      token: administratorTokens.accessToken,
    });
    validateHostedCollection(
      assertResponse(result, 200),
      resource,
      domain.id,
    );
  }
  const builderGateway = await requestApi({
    applicationUrl,
    fetchImpl,
    headers: builderHeaders,
    path: "/api/ai-gateway",
    timeoutMs,
    token: administratorTokens.accessToken,
  });
  const builderGatewayBody = assertResponse(builderGateway, 200);
  if (
    builderGatewayBody?.ok !== true
    || builderGatewayBody.source !== "aws"
    || !Array.isArray(builderGatewayBody.models)
  ) {
    throw acceptanceFailure("builder-gateway");
  }
  const builderModel = selectBuilderModel(
    builderGatewayBody.models,
    preferredBuilderModelId,
  );
  if (!builderModel) throw acceptanceFailure("builder-model");
  const builderEntitlements = await requestApi({
    applicationUrl,
    fetchImpl,
    headers: builderHeaders,
    path: "/api/governance/agent-entitlements",
    timeoutMs,
    token: administratorTokens.accessToken,
  });
  assertResponse(builderEntitlements, 403, "FORBIDDEN");
  for (const path of [domainMembersPath, projectMembersPath]) {
    const builderMembers = await requestApi({
      applicationUrl,
      fetchImpl,
      headers: builderHeaders,
      path,
      timeoutMs,
      token: administratorTokens.accessToken,
    });
    assertResponse(builderMembers, 403, "FORBIDDEN");
  }
  const builderApproval = await requestApi({
    applicationUrl,
    body: {
      id: ownership.registryEntryId,
      semver: ownership.registryVersion,
      decision: "approve",
      reason: "",
    },
    fetchImpl,
    headers: builderHeaders,
    method: "POST",
    path: "/api/registry-decide",
    requestId: requestIds.builderRegistry,
    timeoutMs,
    token: administratorTokens.accessToken,
  });
  assertResponse(builderApproval, 403, "FORBIDDEN");
  const builderAdmin = await requestApi({
    applicationUrl,
    body: expectedDomainPayload(ownership),
    fetchImpl,
    headers: builderHeaders,
    method: "POST",
    path: "/api/domain-create",
    requestId: requestIds.builderDomain,
    timeoutMs,
    token: administratorTokens.accessToken,
  });
  assertResponse(builderAdmin, 403, "FORBIDDEN");

  const personaFixture = state.personaFixture;
  const builderBuildOptions = normalizeBuilderBuildOptions(
    builderBlueprint.version.content.template,
  );
  if (!builderBuildOptions) throw acceptanceFailure("builder-blueprint");
  const agentPayload = {
    domainId: personaFixture.domainId,
    projectId: personaFixture.projectId,
    id: personaFixture.agentId,
    name: `${ownership.domainName} Positive Journey Agent`,
    description: "Temporary positive persona journey agent.",
    modelId: builderModel.id,
    toolIds: [],
    mcpServerIds: [],
    skillIds: [],
    blueprintIds: [builderBlueprint.entry.id],
    memoryIds: [],
    knowledgeBaseIds: [],
    buildConfig: {
      instructions:
        "Complete the requested task using only approved platform resources.",
      modelParameters: {
        temperature: 0,
        maxTokens: 128,
      },
      buildOptions: builderBuildOptions,
    },
  };
  await verifyAgentBuildingJourneys({
    actor,
    agentPayload,
    applicationUrl,
    builderHeaders,
    fetchImpl,
    ownership,
    personaFixture,
    requestIds,
    timeoutMs,
    token: administratorTokens.accessToken,
  });
  const production = await requestApi({
    applicationUrl,
    body: {
      domainId: personaFixture.domainId,
      projectId: personaFixture.projectId,
      agentId: personaFixture.agentId,
      deploymentId: personaFixture.deploymentId,
      approvalId: personaFixture.approvalId,
    },
    fetchImpl,
    headers: builderHeaders,
    method: "POST",
    path: "/api/deployments/production",
    requestId: requestIds.builderProduction,
    timeoutMs,
    token: administratorTokens.accessToken,
  });
  validateDeploymentMutation(
    assertResponse(production, 201),
    personaFixture,
    {
      agentStatus: "PRODUCTION_PENDING",
      approvalStatus: "PENDING",
      deploymentStatus: "REQUESTED",
    },
  );
  const approval = await requestApi({
    applicationUrl,
    body: {
      domainId: personaFixture.domainId,
      projectId: personaFixture.projectId,
      deploymentId: personaFixture.deploymentId,
      approvalId: personaFixture.approvalId,
      decision: "APPROVE",
      reason: "Approved by the hosted acceptance reviewer.",
    },
    fetchImpl,
    headers: reviewerHeaders,
    method: "POST",
    path: "/api/deployment-decisions",
    requestId: requestIds.leadApproval,
    timeoutMs,
    token: reviewerTokens.accessToken,
  });
  validateDeploymentMutation(
    assertResponse(approval, 200),
    personaFixture,
    {
      agentStatus: "PRODUCTION_DEPLOYED",
      approvalStatus: "APPROVED",
      deploymentStatus: "DEPLOYED",
    },
  );
  const membership = await requestApi({
    applicationUrl,
    body: {
      domainId: domain.id,
      username: usernames.ordinary,
      reason: "Validate Domain Lead access administration.",
    },
    fetchImpl,
    headers: reviewerHeaders,
    method: "POST",
    path: "/api/access/domain-memberships",
    requestId: requestIds.leadAccessGrant,
    timeoutMs,
    token: reviewerTokens.accessToken,
  });
  const membershipBody = assertResponse(membership, 201);
  if (
    membershipBody?.ok !== true
    || membershipBody.domainId !== domain.id
    || membershipBody.username !== usernames.ordinary
    || membershipBody.status !== "ACTIVE"
  ) {
    throw acceptanceFailure("lead-access-administration");
  }
  const userHeaders = demoRoleHeaders("user");
  const originalPublicAgentId = publicAgentId(state.experienceFixture);
  const baselineUserAgents = await requestApi({
    applicationUrl,
    fetchImpl,
    headers: userHeaders,
    path: "/api/experience/agents",
    timeoutMs,
    token: administratorTokens.accessToken,
  });
  validateEndUserAgents(
    assertResponse(baselineUserAgents, 200),
    [originalPublicAgentId],
  );
  const entitlement = await requestApi({
    applicationUrl,
    body: {
      domainId: personaFixture.domainId,
      projectId: personaFixture.projectId,
      agentId: personaFixture.agentId,
      subjectType: "USER",
      subject: actor,
      expiresAt: null,
      reason: "Entitle the acceptance End User to the approved agent.",
    },
    fetchImpl,
    headers: reviewerHeaders,
    method: "POST",
    path: "/api/governance/agent-entitlements",
    requestId: requestIds.leadEntitlementGrant,
    timeoutMs,
    token: reviewerTokens.accessToken,
  });
  const entitlementBody = assertResponse(entitlement, 201);
  if (
    entitlementBody?.ok !== true
    || entitlementBody.subject !== actor
    || entitlementBody.agentId !== personaFixture.agentId
    || entitlementBody.status !== "ACTIVE"
  ) {
    throw acceptanceFailure("lead-entitlement");
  }

  const userMe = await requestApi({
    applicationUrl,
    fetchImpl,
    headers: userHeaders,
    path: "/api/me",
    timeoutMs,
    token: administratorTokens.accessToken,
  });
  validateEffectiveProfile(assertResponse(userMe, 200), "user", null);
  const userDomains = await requestApi({
    applicationUrl,
    fetchImpl,
    headers: userHeaders,
    path: "/api/domains",
    timeoutMs,
    token: administratorTokens.accessToken,
  });
  validateDomainProjection(assertResponse(userDomains, 200), []);
  const userAgents = await requestApi({
    applicationUrl,
    fetchImpl,
    headers: userHeaders,
    path: "/api/experience/agents",
    timeoutMs,
    token: administratorTokens.accessToken,
  });
  const userAgentBody = assertResponse(userAgents, 200);
  const expectedPublicAgentId = publicAgentId(personaFixture);
  validateEndUserAgents(
    userAgentBody,
    [originalPublicAgentId, expectedPublicAgentId],
  );
  const invocation = await requestApi({
    applicationUrl,
    body: {
      agentId: expectedPublicAgentId,
      prompt: "Run the hosted acceptance positive journey.",
    },
    fetchImpl,
    headers: userHeaders,
    method: "POST",
    path: "/api/experience/invocations",
    requestId: requestIds.userInvoke,
    timeoutMs,
    token: administratorTokens.accessToken,
  });
  const invocationBody = assertResponse(invocation, 200);
  if (
    invocationBody?.ok !== true
    || invocationBody.status !== "SUCCEEDED"
    || typeof invocationBody.sessionId !== "string"
    || !invocationBody.sessionId
  ) {
    throw acceptanceFailure("end-user-invocation");
  }
  state.personaSessionId = invocationBody.sessionId;
  const sessions = await requestApi({
    applicationUrl,
    fetchImpl,
    headers: userHeaders,
    path: "/api/experience/sessions",
    timeoutMs,
    token: administratorTokens.accessToken,
  });
  const sessionBody = assertResponse(sessions, 200);
  validateEndUserList(sessionBody, "sessions");
  if (
    !sessionBody.items.some((session) =>
      session?.id === invocationBody.sessionId
      && session.agentId === expectedPublicAgentId
      && session.lastInvocationStatus === "SUCCEEDED")
  ) {
    throw acceptanceFailure("end-user-session");
  }
  const feedback = await requestApi({
    applicationUrl,
    body: {
      agentId: expectedPublicAgentId,
      sessionId: invocationBody.sessionId,
      rating: 5,
      comment: "Hosted acceptance positive journey verified.",
    },
    fetchImpl,
    headers: userHeaders,
    method: "POST",
    path: "/api/experience/feedback",
    requestId: requestIds.userFeedback,
    timeoutMs,
    token: administratorTokens.accessToken,
  });
  const feedbackBody = assertResponse(feedback, 201);
  if (
    feedbackBody?.ok !== true
    || feedbackBody.status !== "RECORDED"
    || typeof feedbackBody.id !== "string"
  ) {
    throw acceptanceFailure("end-user-feedback");
  }
  for (const resource of ["access-requests"]) {
    const result = await requestApi({
      applicationUrl,
      fetchImpl,
      headers: userHeaders,
      path: `/api/experience/${resource}`,
      timeoutMs,
      token: administratorTokens.accessToken,
    });
    validateEndUserList(assertResponse(result, 200), resource);
  }
  const userEntitlements = await requestApi({
    applicationUrl,
    fetchImpl,
    headers: userHeaders,
    path: "/api/governance/agent-entitlements",
    timeoutMs,
    token: administratorTokens.accessToken,
  });
  assertResponse(userEntitlements, 403, "FORBIDDEN");
  for (const path of [domainMembersPath, projectMembersPath]) {
    const userMembers = await requestApi({
      applicationUrl,
      fetchImpl,
      headers: userHeaders,
      path,
      timeoutMs,
      token: administratorTokens.accessToken,
    });
    assertResponse(userMembers, 403, "FORBIDDEN");
  }
  const userBuilderRoute = await requestApi({
    applicationUrl,
    fetchImpl,
    headers: userHeaders,
    path: "/api/registry",
    timeoutMs,
    token: administratorTokens.accessToken,
  });
  assertResponse(userBuilderRoute, 403, "FORBIDDEN");
  const userGateway = await requestApi({
    applicationUrl,
    fetchImpl,
    headers: userHeaders,
    path: "/api/ai-gateway",
    timeoutMs,
    token: administratorTokens.accessToken,
  });
  assertResponse(userGateway, 403, "FORBIDDEN");
  const userAdmin = await requestApi({
    applicationUrl,
    body: expectedDomainPayload(ownership),
    fetchImpl,
    headers: userHeaders,
    method: "POST",
    path: "/api/domain-create",
    requestId: requestIds.userDomain,
    timeoutMs,
    token: administratorTokens.accessToken,
  });
  assertResponse(userAdmin, 403, "FORBIDDEN");

  const forged = await requestApi({
    applicationUrl,
    fetchImpl,
    headers: demoRoleHeaders("admin"),
    path: "/api/ai-gateway",
    timeoutMs,
    token: ordinaryTokens.accessToken,
  });
  assertResponse(forged, 403, "DEMO_ROLE_NOT_ALLOWED");

  return {
    actor: state.actor,
    domain: state.domain,
    createdDomain: state.createdDomain,
  };
}

async function verifyNoResidue({
  actor,
  cognito,
  domain,
  experienceFixture,
  fixtureRegistryId,
  ownership,
  resources,
  requestIds,
  createdDomain,
  userPoolId,
}) {
  let fixtureMismatch = false;
  let cleanupDomain = createdDomain;
  if (actor !== undefined && domain !== undefined) {
    await resources.cleanupAgentBuildingJourneyFixtures({
      actor,
      domainId: domain.id,
      ownership,
    });
  }
  await resources.cleanupPersonaJourneyFixture({ ownership });
  if (actor !== undefined && domain !== undefined) {
    const fixtureInput = {
      actor,
      domainId: domain.id,
      ownership,
    };
    const recovered =
      await resources.recoverExperienceFixture(fixtureInput);
    if (
      experienceFixture !== undefined
      && recovered !== null
      && !isDeepStrictEqual(recovered, experienceFixture)
    ) {
      fixtureMismatch = true;
    }
    const fixture = recovered ?? experienceFixture;
    if (fixture !== undefined && fixture !== null) {
      await resources.cleanupExperienceFixture({
        ...fixtureInput,
        fixture,
      });
    }
    if (
      await resources.recoverExperienceFixture(fixtureInput)
        !== null
    ) {
      throw cleanupFailure();
    }
  }
  if (actor !== undefined) {
    const recoveredDomain = await resources.recoverDomain({
      actor,
      ownership,
    });
    if (
      recoveredDomain !== null
      && createdDomain !== undefined
      && (
        recoveredDomain.id !== createdDomain.id
        || recoveredDomain.name !== createdDomain.name
        || recoveredDomain.ownerGroup !== createdDomain.ownerGroup
        || recoveredDomain.registryId !== createdDomain.registryId
        || recoveredDomain.registryArn !== createdDomain.registryArn
        || recoveredDomain.status !== createdDomain.status
        || recoveredDomain.createdBy !== createdDomain.createdBy
      )
    ) {
      throw cleanupFailure();
    }
    cleanupDomain = recoveredDomain ?? createdDomain;
    await resources.cleanupExactResources({
      actor,
      domain: cleanupDomain,
      ownership,
      registryRecord: undefined,
      requestIds: [{
        route: "POST /api/domain-create",
        requestId: requestIds.adminDomain,
      }],
    });
  }
  const mapping = await resources.recoverActorMapping({ ownership });
  if (mapping !== null) throw cleanupFailure();
  if (actor !== undefined) {
    const domain = await resources.recoverDomain({ actor, ownership });
    if (domain !== null) throw cleanupFailure();
  }
  const registry = await resources.recoverRegistryFixture({
    ownership,
    registryId: fixtureRegistryId,
  });
  if (registry !== null) throw cleanupFailure();
  await verifyOwnerGroupAbsent({
    cognito,
    ownership,
    userPoolId,
  });
  if (fixtureMismatch) throw cleanupFailure();
}

async function deleteVerifier({
  cognito,
  expectedSubject,
  userPoolId,
  verifier,
}) {
  const { username } = verifier;
  let record;
  try {
    record = await cognito.adminGetUser({ userPoolId, username });
  } catch (error) {
    if (cognito.isUserNotFound(error)) return;
    throw error;
  }
  if (
    expectedSubject !== undefined
    && actorFromVerifier(record, verifier) !== expectedSubject
  ) {
    throw cleanupFailure();
  }
  if (expectedSubject === undefined) validateManagedVerifier(record, verifier);
  await cognito.adminDeleteUser({ userPoolId, username });
  try {
    await cognito.adminGetUser({ userPoolId, username });
  } catch (error) {
    if (cognito.isUserNotFound(error)) return;
    throw error;
  }
  throw cleanupFailure();
}

async function verifyOwnerGroupAbsent({
  abortSignal,
  cognito,
  ownership,
  userPoolId,
}) {
  try {
    await cognito.getGroup({
      userPoolId,
      groupName: ownership.ownerGroup,
    }, {
      abortSignal,
    });
  } catch (error) {
    if (cognito.isGroupNotFound(error)) return;
    throw error;
  }
  throw cleanupFailure();
}

function recoveredExperienceFixture(value, ownership) {
  if (value === null) return null;
  if (
    !isPlainObject(value)
    || Object.keys(value).sort().join(",")
      !== "agentId,deploymentId,domainId,projectId"
    || normalizedDomain(value.domainId) !== value.domainId
    || value.projectId
      !== `hosted-project-${ownership.runId}-${ownership.runAttempt}`
    || value.agentId
      !== `hosted-agent-${ownership.runId}-${ownership.runAttempt}`
    || value.deploymentId
      !== `hosted-production-${ownership.runId}-${ownership.runAttempt}`
  ) {
    throw cleanupFailure();
  }
  return value;
}

function validateManagedVerifier(record, verifier) {
  const { name, username } = verifier;
  const ownershipMarkers = Array.isArray(record?.UserAttributes)
    ? record.UserAttributes.filter(({ Name, Value } = {}) =>
        Name === "custom:managed_by"
        && Value === MANAGED_BY
      )
    : [];
  const names = Array.isArray(record?.UserAttributes)
    ? record.UserAttributes.filter(({ Name, Value } = {}) =>
        Name === "name"
        && Value === name
      )
    : [];
  if (
    record?.Username !== username
    || ownershipMarkers.length !== 1
    || names.length !== 1
  ) {
    throw cleanupFailure();
  }
}

function actorFromVerifier(record, verifier) {
  validateManagedVerifier(record, verifier);
  const subjects = Array.isArray(record?.UserAttributes)
    ? record.UserAttributes.filter(({ Name, Value } = {}) =>
        Name === "sub"
        && typeof Value === "string"
        && Value
      )
    : [];
  if (subjects.length !== 1) throw cleanupFailure();
  return subjects[0].Value;
}

function cognitoSend(client, command, abortSignal) {
  return client.send(
    command,
    abortSignal === undefined ? undefined : { abortSignal },
  );
}

export function createRoleSwitchingCognitoAdapter({
  region = process.env.AWS_REGION,
  cognitoClient,
} = {}) {
  const normalizedRegion = requiredString(region);
  if (!/^[a-z]{2}(?:-[a-z0-9]+)+-\d+$/.test(normalizedRegion)) {
    throw configurationFailure();
  }
  const client = cognitoClient
    ?? new CognitoIdentityProviderClient({ region: normalizedRegion });
  if (!client || typeof client.send !== "function") {
    throw configurationFailure();
  }
  return {
    async adminCreateUser({
      messageAction,
      userAttributes,
      userPoolId,
      username,
    }, { abortSignal } = {}) {
      const response = await cognitoSend(
        client,
        new AdminCreateUserCommand({
          UserPoolId: userPoolId,
          Username: username,
          UserAttributes: userAttributes.map(({ name, value }) => ({
            Name: name,
            Value: value,
          })),
          MessageAction: messageAction,
        }),
        abortSignal,
      );
      return {
        Username: response?.User?.Username,
        Enabled: response?.User?.Enabled,
        UserStatus: response?.User?.UserStatus,
        UserAttributes: response?.User?.Attributes,
      };
    },
    async adminSetUserPassword({
      password,
      permanent,
      userPoolId,
      username,
    }, { abortSignal } = {}) {
      await cognitoSend(
        client,
        new AdminSetUserPasswordCommand({
          UserPoolId: userPoolId,
          Username: username,
          Password: password,
          Permanent: permanent,
        }),
        abortSignal,
      );
    },
    async adminAddUserToGroup({
      groupName,
      userPoolId,
      username,
    }, { abortSignal } = {}) {
      await cognitoSend(
        client,
        new AdminAddUserToGroupCommand({
          UserPoolId: userPoolId,
          Username: username,
          GroupName: groupName,
        }),
        abortSignal,
      );
    },
    async adminGetUser({
      userPoolId,
      username,
    }, { abortSignal } = {}) {
      return cognitoSend(
        client,
        new AdminGetUserCommand({
          UserPoolId: userPoolId,
          Username: username,
        }),
        abortSignal,
      );
    },
    async adminListGroupsForUser({
      userPoolId,
      username,
    }, { abortSignal } = {}) {
      return cognitoSend(
        client,
        new AdminListGroupsForUserCommand({
          UserPoolId: userPoolId,
          Username: username,
        }),
        abortSignal,
      );
    },
    async adminDeleteUser({
      userPoolId,
      username,
    }, { abortSignal } = {}) {
      await cognitoSend(
        client,
        new AdminDeleteUserCommand({
          UserPoolId: userPoolId,
          Username: username,
        }),
        abortSignal,
      );
    },
    async getGroup({
      groupName,
      userPoolId,
    }, { abortSignal } = {}) {
      return cognitoSend(
        client,
        new GetGroupCommand({
          UserPoolId: userPoolId,
          GroupName: groupName,
        }),
        abortSignal,
      );
    },
    async adminInitiateAuth({
      authFlow,
      clientId,
      password,
      userPoolId,
      username,
    }, { abortSignal } = {}) {
      return cognitoSend(
        client,
        new AdminInitiateAuthCommand({
          UserPoolId: userPoolId,
          ClientId: clientId,
          AuthFlow: authFlow,
          AuthParameters: {
            USERNAME: username,
            PASSWORD: password,
          },
        }),
        abortSignal,
      );
    },
    isUserNotFound(error) {
      return error?.name === "UserNotFoundException"
        || error?.code === "UserNotFoundException";
    },
    isGroupNotFound(error) {
      return error instanceof ResourceNotFoundException;
    },
  };
}

export async function cleanupHostedRoleSwitchingRun({
  cognito,
  fixtureRegistryId,
  operationTimeoutMs = DEFAULT_OPERATION_TIMEOUT_MS,
  resources,
  runAttempt,
  runId,
  userPoolId,
}) {
  const normalizedRunId = runComponent(runId, 20);
  const normalizedRunAttempt = runComponent(runAttempt, 6);
  const normalizedUserPoolId = requiredString(userPoolId);
  const normalizedFixtureRegistryId = requiredString(fixtureRegistryId);
  if (
    !/^[a-z]{2}(?:-[a-z0-9]+)+-\d+_[A-Za-z0-9]+$/
      .test(normalizedUserPoolId)
    || !/^[A-Za-z0-9]{12,16}$/.test(normalizedFixtureRegistryId)
    || !cognito
    || [
      "adminDeleteUser",
      "adminGetUser",
      "getGroup",
      "isGroupNotFound",
      "isUserNotFound",
    ].some((method) => typeof cognito[method] !== "function")
    || !resources
    || [
      "cleanupPersonaJourneyFixture",
      "cleanupAgentBuildingJourneyFixtures",
      "cleanupExperienceFixture",
      "cleanupExactResources",
      "recoverActorMapping",
      "recoverDomain",
      "recoverExperienceFixture",
      "recoverRegistryFixture",
    ].some((method) => typeof resources[method] !== "function")
  ) {
    throw configurationFailure();
  }
  const timeoutMs = positiveInteger(operationTimeoutMs);
  const ownership = createAcceptanceOwnership({
    verifierRunId: normalizedRunId,
    verifierRunAttempt: normalizedRunAttempt,
  });
  const requestIds = roleSwitchingRequestIds({
    runId: normalizedRunId,
    runAttempt: normalizedRunAttempt,
  });
  const usernames = roleSwitchingUsernames({
    runId: normalizedRunId,
    runAttempt: normalizedRunAttempt,
  });
  const verifiers = verifierIdentities({
    runAttempt: normalizedRunAttempt,
    runId: normalizedRunId,
  });
  const [administrator] = verifiers;
  let cognitoActor;
  let verifierCleanupFailed = false;
  try {
    cognitoActor = actorFromVerifier(await retryCleanup(() =>
      cognito.adminGetUser({
        userPoolId: normalizedUserPoolId,
        username: usernames.administrator,
      }), DEFAULT_CLEANUP_ATTEMPTS, timeoutMs), administrator);
  } catch (error) {
    if (!cognito.isUserNotFound(error)) verifierCleanupFailed = true;
  }
  let mappedActor;
  try {
    mappedActor = await retryCleanup(() =>
      resources.recoverActorMapping({ ownership }),
    DEFAULT_CLEANUP_ATTEMPTS, timeoutMs);
  } catch {
    throw cleanupFailure();
  }
  if (
    mappedActor !== null
    && (
      typeof mappedActor !== "string"
      || !mappedActor
      || (
        cognitoActor !== undefined
        && cognitoActor !== mappedActor
      )
    )
  ) {
    throw cleanupFailure();
  }
  const actor = mappedActor ?? cognitoActor;
  let domain;
  let registryRecord;
  let experienceFixture;
  try {
    domain = await retryCleanup(() =>
      resources.recoverDomain({ actor, ownership }),
    DEFAULT_CLEANUP_ATTEMPTS, timeoutMs);
    registryRecord = await retryCleanup(() =>
      resources.recoverRegistryFixture({
        ownership,
        registryId: normalizedFixtureRegistryId,
      }), DEFAULT_CLEANUP_ATTEMPTS, timeoutMs);
    if (actor !== undefined) {
      experienceFixture = recoveredExperienceFixture(
        await retryCleanup(() =>
          resources.recoverExperienceFixture({
            actor,
            ownership,
          }), DEFAULT_CLEANUP_ATTEMPTS, timeoutMs),
        ownership,
      );
    }
  } catch {
    throw cleanupFailure();
  }
  if (
    actor === undefined
    && (
      domain !== null
      || registryRecord !== null
    )
  ) {
    throw cleanupFailure();
  }
  try {
    await retryCleanup(() =>
      resources.cleanupPersonaJourneyFixture({ ownership }),
    DEFAULT_CLEANUP_ATTEMPTS, timeoutMs);
  } catch {
    throw cleanupFailure();
  }
  if (actor !== undefined) {
    try {
      if (experienceFixture !== null) {
        await retryCleanup(() =>
          resources.cleanupAgentBuildingJourneyFixtures({
            actor,
            domainId: experienceFixture.domainId,
            ownership,
          }), DEFAULT_CLEANUP_ATTEMPTS, timeoutMs);
        await retryCleanup(() =>
          resources.cleanupExperienceFixture({
            actor,
            domainId: experienceFixture.domainId,
            fixture: experienceFixture,
            ownership,
          }), DEFAULT_CLEANUP_ATTEMPTS, timeoutMs);
      }
    } catch {
      throw cleanupFailure();
    }
  }
  for (const verifier of verifiers) {
    try {
      await retryCleanup(() => deleteVerifier({
        cognito,
        userPoolId: normalizedUserPoolId,
        verifier,
      }), DEFAULT_CLEANUP_ATTEMPTS, timeoutMs);
    } catch {
      verifierCleanupFailed = true;
    }
  }
  if (verifierCleanupFailed) throw cleanupFailure();
  if (actor !== undefined) {
    try {
      await retryCleanup(() =>
        resources.cleanupExactResources({
          actor,
          domain,
          ownership,
          registryRecord,
          requestIds: [{
            route: "POST /api/domain-create",
            requestId: requestIds.adminDomain,
          }],
        }), DEFAULT_CLEANUP_ATTEMPTS, timeoutMs);
      if (
        await retryCleanup(() =>
          resources.recoverExperienceFixture({
            actor,
            ownership,
          }), DEFAULT_CLEANUP_ATTEMPTS, timeoutMs)
          !== null
        || await retryCleanup(() =>
          resources.recoverActorMapping({ ownership }),
        DEFAULT_CLEANUP_ATTEMPTS, timeoutMs)
          !== null
        || await retryCleanup(() =>
          resources.recoverDomain({ actor, ownership }),
        DEFAULT_CLEANUP_ATTEMPTS, timeoutMs)
          !== null
        || await retryCleanup(() =>
          resources.recoverRegistryFixture({
            ownership,
            registryId: normalizedFixtureRegistryId,
          }), DEFAULT_CLEANUP_ATTEMPTS, timeoutMs)
          !== null
      ) {
        throw cleanupFailure();
      }
    } catch {
      throw cleanupFailure();
    }
  }
  await retryCleanup((abortSignal) => verifyOwnerGroupAbsent({
    abortSignal,
    cognito,
    ownership,
    userPoolId: normalizedUserPoolId,
  }), DEFAULT_CLEANUP_ATTEMPTS, timeoutMs);
  return { ok: true };
}

export async function runHostedRoleSwitchingAcceptance({
  applicationUrl,
  browser,
  clientId,
  cognito,
  createArtifactDirectory = createPrivateArtifactDirectory,
  fetchImpl = fetch,
  fixtureRegistryId,
  journeyTimeoutMs = DEFAULT_JOURNEY_TIMEOUT_MS,
  operatorUsernames,
  operationTimeoutMs = DEFAULT_OPERATION_TIMEOUT_MS,
  preferredBuilderModelId,
  randomPassword = defaultRandomPassword,
  region,
  removeArtifactDirectory = rmSync,
  resources,
  runAttempt,
  runId,
  userPoolId,
}) {
  const config = validateConfiguration({
    applicationUrl,
    clientId,
    fixtureRegistryId,
    journeyTimeoutMs,
    operatorUsernames,
    operationTimeoutMs,
    preferredBuilderModelId,
    region,
    runAttempt,
    runId,
    userPoolId,
  });
  validateAdapters({
    browser,
    cognito,
    fetchImpl,
    randomPassword,
    resources,
  });
  const verifiers = verifierDefinitions(randomPassword, config);
  const ownership = createAcceptanceOwnership({
    verifierRunId: config.runId,
    verifierRunAttempt: config.runAttempt,
  });
  const requestIds = roleSwitchingRequestIds(config);
  const cleanupState = {};
  const ownedVerifierSubjects = new Map();
  let artifactDirectory;
  let failure;
  let operatorsBefore = [];

  try {
    for (const username of config.operatorUsernames) {
      operatorsBefore.push(await runStage(
        "operator-before",
        () => readOperatorRecord(cognito, config, username),
        config.operationTimeoutMs,
      ));
    }
    for (const verifier of verifiers) {
      await provisionVerifier(
        cognito,
        config,
        verifier,
        ownedVerifierSubjects,
        config.operationTimeoutMs,
      );
    }
    const [administrator, reviewer, ordinary] = verifiers;
    const administratorTokens = await authenticateVerifier(
      cognito,
      config,
      administrator,
      config.operationTimeoutMs,
    );
    const reviewerTokens = await authenticateVerifier(
      cognito,
      config,
      reviewer,
      config.operationTimeoutMs,
    );
    const ordinaryTokens = await authenticateVerifier(
      cognito,
      config,
      ordinary,
      config.operationTimeoutMs,
    );
    const apiEvidence = await runStage("api-journey", () =>
      verifyApiJourney({
        applicationUrl: config.applicationUrl,
        fetchImpl,
        ownership,
        requestIds,
        administratorTokens,
        reviewerTokens,
        ordinaryTokens,
        preferredBuilderModelId: config.preferredBuilderModelId,
        usernames: roleSwitchingUsernames(config),
        resources,
        state: cleanupState,
        timeoutMs: config.operationTimeoutMs,
    }), config.journeyTimeoutMs);
    artifactDirectory = createArtifactDirectory();
    const verifyBrowser = () => browser.verifyRoleJourney({
        applicationUrl: config.applicationUrl,
        artifactDirectory,
        domain: apiEvidence.domain,
        ordinaryTokens,
        tokens: administratorTokens,
      });
    let browserEvidence;
    if (browser.managesOwnDeadline === true) {
      try {
        browserEvidence = await verifyBrowser();
      } catch (error) {
        const browserFailure = acceptanceFailure(
          browserDiagnosticStage(error?.stage, "browser-journey"),
        );
        if (
          error?.cleanupCode
            === "HOSTED_ROLE_SWITCHING_CLEANUP_FAILED"
          || error?.code === "HOSTED_ROLE_SWITCHING_CLEANUP_FAILED"
        ) {
          browserFailure.cleanupCode =
            "HOSTED_ROLE_SWITCHING_CLEANUP_FAILED";
        }
        throw browserFailure;
      }
    } else {
      browserEvidence = await runStage(
        "browser-journey",
        verifyBrowser,
        config.journeyTimeoutMs,
      );
    }
    validateBrowserEvidence(browserEvidence, apiEvidence.domain);
  } catch (error) {
    failure =
      error instanceof HostedRoleSwitchingError
      && error.code === "HOSTED_ROLE_SWITCHING_FAILED"
        ? error
        : acceptanceFailure();
  } finally {
    let cleanupFailed = false;
    for (const verifier of verifiers) {
      if (!ownedVerifierSubjects.has(verifier.username)) continue;
      const expectedSubject =
        ownedVerifierSubjects.get(verifier.username) ?? undefined;
      try {
        await retryCleanup(() => deleteVerifier({
          cognito,
          expectedSubject,
          userPoolId: config.userPoolId,
          verifier,
        }), DEFAULT_CLEANUP_ATTEMPTS, config.operationTimeoutMs);
      } catch {
        cleanupFailed = true;
      }
    }
    try {
      await retryCleanup(() => verifyNoResidue({
        actor: cleanupState.actor,
        cognito,
        domain: cleanupState.domain,
        experienceFixture: cleanupState.experienceFixture,
        fixtureRegistryId: config.fixtureRegistryId,
        ownership,
        resources,
        requestIds,
        createdDomain: cleanupState.createdDomain,
        userPoolId: config.userPoolId,
      }), DEFAULT_CLEANUP_ATTEMPTS, config.operationTimeoutMs);
    } catch {
      cleanupFailed = true;
    }
    if (artifactDirectory !== undefined) {
      try {
        await retryCleanup(() =>
          removeArtifactDirectory(
            artifactDirectory,
            { recursive: true, force: true },
          ), DEFAULT_CLEANUP_ATTEMPTS, config.operationTimeoutMs);
      } catch {
        cleanupFailed = true;
      }
    }
    if (operatorsBefore.length > 0) {
      try {
        const operatorsAfter = [];
        for (const username of config.operatorUsernames) {
          operatorsAfter.push(await readOperatorRecord(
            cognito,
            config,
            username,
            DEFAULT_CLEANUP_ATTEMPTS,
          ));
        }
        if (!isDeepStrictEqual(operatorsAfter, operatorsBefore)) {
          throw cleanupFailure();
        }
      } catch {
        cleanupFailed = true;
      }
    }
    if (cleanupFailed) {
      if (failure) {
        failure.cleanupCode = "HOSTED_ROLE_SWITCHING_CLEANUP_FAILED";
      } else {
        failure = cleanupFailure();
      }
    }
  }

  if (failure) throw failure;
  return { domain: cleanupState.domain, ok: true };
}

async function browserLayoutProblems(page) {
  const problems = await page.evaluate(() => {
    const result = [];
    const viewportWidth = document.documentElement.clientWidth;
    if (document.documentElement.scrollWidth > viewportWidth + 2) {
      result.push("document-overflow");
    }
    for (const element of document.querySelectorAll("#topbar, #side, #main")) {
      const rect = element.getBoundingClientRect();
      if (
        rect.width > 0
        && (rect.left < -2 || rect.right > viewportWidth + 2)
      ) {
        result.push("horizontal-clipping");
        break;
      }
    }
    return result;
  });
  if (problems.length > 0) throw acceptanceFailure("browser-layout");
}

async function visibleNavigation(page) {
  return page.locator("[data-shellnav]:visible")
    .evaluateAll((items) => items.map((item) => item.dataset.shellnav));
}

async function assertScopedRegistryReadOnly(page, timeoutMs) {
  await page.locator("#regbox table").waitFor({
    state: "visible",
    timeout: timeoutMs,
  });
  await page.locator("#regbox .regrow").first().click();
  await page.locator("#regdrawerwrap .card").waitFor({
    state: "visible",
    timeout: timeoutMs,
  });
  const tag = page.locator(".roletag.dom");
  await tag.waitFor({ state: "visible", timeout: timeoutMs });
  if (!/Domain team · scoped catalog/i.test(await tag.textContent())) {
    throw acceptanceFailure("scoped-registry-label");
  }
  if (
    await page.locator(
      "#regwizopen, .regapprove, .regreject, #regpropose, #regsubmit",
    ).count() !== 0
  ) {
    throw acceptanceFailure("scoped-registry-read-only");
  }
}

async function assertApprovedAgentMobileLayout(page) {
  const result = await page.locator("#approvedagents").evaluate((container) => {
    const cards = [...container.querySelectorAll(".approvedagent")];
    const containerRect = container.getBoundingClientRect();
    return {
      count: cards.length,
      widths: cards.map((card) => card.getBoundingClientRect().width),
      containerWidth: containerRect.width,
    };
  });
  if (
    result.count < 1
    || result.containerWidth <= 0
    || result.widths.some((width) => width < result.containerWidth * 0.9)
  ) {
    throw acceptanceFailure("approved-agent-mobile-layout");
  }
}

async function assertDemoSelectorOnly(page, { requireSelector = false } = {}) {
  const freeText = page.locator(
    "textarea:visible,input:visible"
    + ":not([type=button]):not([type=checkbox]):not([type=color])"
    + ":not([type=file]):not([type=hidden]):not([type=image])"
    + ":not([type=radio]):not([type=range]):not([type=reset])"
    + ":not([type=submit])",
  );
  const selectors = page.locator(
    "select[data-demo-assist-controls]:visible",
  );
  if (
    await freeText.count() !== 0
    || (requireSelector && await selectors.count() < 1)
  ) {
    throw acceptanceFailure("demo-selector-only");
  }
}

async function assertHostedAccessJourneys(page, domainId, timeoutMs) {
  const domain = page.locator("#haccessdomain");
  await domain.waitFor({ state: "visible", timeout: timeoutMs });
  if (await domain.inputValue() !== domainId) {
    await domain.selectOption(domainId);
  }
  await page.locator('[data-access-tab="domain"]').click();
  await page.locator("#haccessdomaingrant").waitFor({
    state: "visible",
    timeout: timeoutMs,
  });
  await assertDemoSelectorOnly(page, { requireSelector: true });
  await page.locator('[data-access-tab="project"]').click();
  await page.locator("#haccessproject").waitFor({
    state: "visible",
    timeout: timeoutMs,
  });
  await assertDemoSelectorOnly(page, { requireSelector: true });
  await page.locator('[data-access-tab="entitlement"]').click();
  await page.locator("#hostedaccessadmin [data-access-agent]")
    .first().waitFor({
      state: "visible",
      timeout: timeoutMs,
    });
  await assertDemoSelectorOnly(page, { requireSelector: true });
}

async function openHostedFullJourney(page, timeoutMs) {
  await runBrowserStage("build-full-journey", async () => {
    const journey = page.locator('[data-hosted-journey="blueprint"]');
    await journey.waitFor({ state: "visible", timeout: timeoutMs });
    await journey.click();
    await page.locator("#hbcreate").waitFor({
      state: "visible",
      timeout: timeoutMs,
    });
  });
}

async function assertHostedBuildJourneys(page, timeoutMs) {
  await runBrowserStage("build-full-journey", async () => {
    for (const [journeyId, readySelector] of [
      ["scratch", "#hminimalpreview"],
      ["plato", "#hspecstart"],
      ["blueprint", "#hbcreate"],
    ]) {
      await page.locator(`[data-hosted-journey="${journeyId}"]`).click();
      await page.locator(readySelector).waitFor({
        state: "visible",
        timeout: timeoutMs,
      });
      await assertDemoSelectorOnly(page, { requireSelector: true });
      if (journeyId !== "blueprint") {
        await page.locator("[data-hosted-journey-back]").click();
        await page.locator('[data-hosted-journey="blueprint"]').waitFor({
          state: "visible",
          timeout: timeoutMs,
        });
      }
    }
  });
}

async function assertDemoJourneyNavigation({
  journeyId,
  nextSelector,
  page,
  startSelector,
  timeoutMs,
}) {
  const launcher = page.locator(`[data-demo-journey-start="${journeyId}"]`);
  await runBrowserStage("demo-journey-launch", async () => {
    await launcher.waitFor({ state: "visible", timeout: timeoutMs });
    await launcher.click();
    await page.locator(startSelector).waitFor({
      state: "visible",
      timeout: timeoutMs,
    });
    await assertDemoSelectorOnly(page);
    await page.waitForFunction(
      (id) => {
        const stored = sessionStorage.getItem("console.demo-assist.journey");
        if (!stored) return false;
        const active = JSON.parse(stored);
        return active.journeyId === id
          && active.step === 0
          && document.querySelector(".demo-journey-strip");
      },
      journeyId,
      { timeout: timeoutMs },
    );
  });

  await runBrowserStage("demo-journey-next", async () => {
    await page.locator(".demo-journey-strip [data-demo-journey-next]").click();
    await page.locator(nextSelector).waitFor({
      state: "visible",
      timeout: timeoutMs,
    });
    await assertDemoSelectorOnly(page);
    await page.waitForFunction(
      (id) => {
        const stored = sessionStorage.getItem("console.demo-assist.journey");
        if (!stored) return false;
        const active = JSON.parse(stored);
        return active.journeyId === id && active.step === 1;
      },
      journeyId,
      { timeout: timeoutMs },
    );
  });

  await runBrowserStage("demo-journey-previous", async () => {
    await page.locator(".demo-journey-strip [data-demo-journey-previous]")
      .click();
    await page.locator(startSelector).waitFor({
      state: "visible",
      timeout: timeoutMs,
    });
    await assertDemoSelectorOnly(page);
  });
  await runBrowserStage("demo-journey-return", async () => {
    await page.locator(".demo-journey-strip [data-demo-journey-return]")
      .click();
    await launcher.waitFor({ state: "visible", timeout: timeoutMs });
    if (
      await page.evaluate(() =>
        sessionStorage.getItem("console.demo-assist.journey"))
        !== null
    ) {
      throw acceptanceFailure("demo-journey-return");
    }
  });
}

async function waitForRole({
  domain,
  expectedNavigation,
  page,
  role,
  timeoutMs,
}) {
  const roleLabel = {
    admin: "Platform Admin",
    lead: "Domain Lead",
    builder: "Domain Builder",
    user: "End User",
  }[role];
  await page.waitForFunction(
    ({ domainId, expectedIds, expectedLabel, expectedRole }) => {
      const roleSelect = document.querySelector("#tbrole");
      if (roleSelect?.value !== expectedRole) return false;
      if (
        document.querySelector(".tb-role")?.textContent?.trim()
          !== expectedLabel
      ) {
        return false;
      }
      const domainSelect = document.querySelector("#tbdomain");
      if (
        domainId === null
          ? domainSelect !== null
          : domainSelect?.value !== domainId
      ) {
        return false;
      }
      const visible = [...document.querySelectorAll("[data-shellnav]")]
        .filter((item) => {
          const style = getComputedStyle(item);
          const rect = item.getBoundingClientRect();
          return (
            style.display !== "none"
            && style.visibility !== "hidden"
            && rect.width > 0
            && rect.height > 0
          );
        })
        .map((item) => item.dataset.shellnav);
      return JSON.stringify(visible) === JSON.stringify(expectedIds);
    },
    {
      domainId: domain,
      expectedIds: expectedNavigation,
      expectedLabel: roleLabel,
      expectedRole: role,
    },
    { timeout: timeoutMs },
  );
}

async function captureRole({
  artifactDirectory,
  name,
  page,
  screenshots,
  timeoutMs,
  viewport,
}) {
  const fileName = `${name}-${viewport}.png`;
  await browserLayoutProblems(page);
  await page.screenshot({
    path: join(artifactDirectory, fileName),
    fullPage: false,
    timeout: timeoutMs,
  });
  screenshots.push(fileName);
}

async function performRoleJourney({
  applicationUrl,
  artifactDirectory,
  context,
  domain,
  ordinaryTokens,
  page,
  timeoutMs,
  tokens,
  viewport,
}) {
  await page.addInitScript((session) => {
    sessionStorage.setItem(
      "console.cognito.tokens",
      JSON.stringify(session.tokens),
    );
  }, { tokens });
  await page.goto(applicationUrl, {
    waitUntil: "domcontentloaded",
    timeout: timeoutMs,
  });
  await page.locator("#tbrole").waitFor({
    state: "visible",
    timeout: timeoutMs,
  });
  const screenshots = [];

  await waitForRole({
    domain: null,
    expectedNavigation: [
      "dashboard",
      "domains",
      "registry",
      "gateway",
      "projects",
      "agents",
      "deployments",
      "approvals",
      "domainaccess",
      "build",
      "operations",
      "cost",
      "audit",
      "incidents",
      "breakglass",
      "publications",
    ],
    page,
    role: "admin",
    timeoutMs,
  });
  const demoAssistToggle = page.locator("#tbdemoassist");
  await demoAssistToggle.waitFor({ state: "visible", timeout: timeoutMs });
  if (!await demoAssistToggle.isChecked()) {
    throw acceptanceFailure("demo-assist-operator");
  }
  await page.locator("#hosteddashboard [data-dashboard-resource]")
    .first().waitFor({ state: "visible", timeout: timeoutMs });
  await runBrowserStage("demo-journey-admin", async () => {
    await assertDemoJourneyNavigation({
      journeyId: "govern-platform",
      nextSelector: "#domroster",
      page,
      startSelector: "#hosteddashboard",
      timeoutMs,
    });
  });
  await runBrowserStage("administrator-gateway", async () => {
    await page.locator('[data-shellnav="gateway"]').click();
    await page.locator("#hostedgateway .gateway-model").first().waitFor({
      state: "visible",
      timeout: timeoutMs,
    });
  });
  await page.locator('[data-shellnav="domainaccess"]').click();
  await assertHostedAccessJourneys(page, domain.id, timeoutMs);
  await page.locator('[data-shellnav="build"]').click();
  await assertHostedBuildJourneys(page, timeoutMs);
  await page.locator("[data-demo-assist-controls]").first().waitFor({
    state: "visible",
    timeout: timeoutMs,
  });
  await assertDemoSelectorOnly(page, { requireSelector: true });
  await captureRole({
    artifactDirectory,
    name: "admin",
    page,
    screenshots,
    timeoutMs,
    viewport,
  });

  await page.locator("#tbrole").selectOption("lead");
  await page.locator("#tbdomain").waitFor({
    state: "visible",
    timeout: timeoutMs,
  });
  await waitForRole({
    domain: domain.id,
    expectedNavigation: [
      "registry",
      "gateway",
      "projects",
      "agents",
      "deployments",
      "approvals",
      "domainaccess",
      "build",
      "operations",
      "cost",
      "audit",
      "incidents",
      "publications",
    ],
    page,
    role: "lead",
    timeoutMs,
  });
  if (!await page.locator("#side").getByText("Domain Console").isVisible()) {
    throw acceptanceFailure("lead-navigation");
  }
  await runBrowserStage("demo-journey-lead", async () => {
    await assertDemoJourneyNavigation({
      journeyId: "govern-domain",
      nextSelector: "#hostedaccessadmin",
      page,
      startSelector: '#hostedcollection[data-resource="projects"]',
      timeoutMs,
    });
  });
  await page.locator('[data-shellnav="gateway"]').click();
  await page.locator("#hostedgateway .gateway-model").first().waitFor({
    state: "visible",
    timeout: timeoutMs,
  });
  await page.locator('[data-shellnav="domainaccess"]').click();
  await assertHostedAccessJourneys(page, domain.id, timeoutMs);
  await page.locator('[data-shellnav="registry"]').click();
  await assertScopedRegistryReadOnly(page, timeoutMs);
  await page.locator('[data-shellnav="build"]').click();
  await openHostedFullJourney(page, timeoutMs);
  await assertDemoSelectorOnly(page, { requireSelector: true });

  const isolatedPage = await context.newPage();
  // per-tab-isolation: a second tab must start from the authenticated role,
  // without inheriting the first tab's selected demo context.
  try {
    await isolatedPage.addInitScript((session) => {
      sessionStorage.setItem(
        "console.cognito.tokens",
        JSON.stringify(session.tokens),
      );
    }, { tokens });
    await isolatedPage.goto(applicationUrl, {
      waitUntil: "domcontentloaded",
      timeout: timeoutMs,
    });
    await waitForRole({
      domain: null,
      expectedNavigation: [
        "dashboard",
        "domains",
        "registry",
        "gateway",
        "projects",
        "agents",
        "deployments",
        "approvals",
        "domainaccess",
        "build",
        "operations",
        "cost",
        "audit",
        "incidents",
        "breakglass",
        "publications",
      ],
      page: isolatedPage,
      role: "admin",
      timeoutMs,
    });
    await waitForRole({
      domain: domain.id,
      expectedNavigation: [
        "registry",
        "gateway",
        "projects",
        "agents",
        "deployments",
        "approvals",
        "domainaccess",
        "build",
        "operations",
        "cost",
        "audit",
        "incidents",
        "publications",
      ],
      page,
      role: "lead",
      timeoutMs,
    });
  } finally {
    await isolatedPage.close();
  }
  await captureRole({
    artifactDirectory,
    name: "lead",
    page,
    screenshots,
    timeoutMs,
    viewport,
  });

  await page.locator('[data-shellnav="projects"]').click();
  await page.locator('[data-demo-journey-start="govern-domain"]').click();
  await page.locator(".demo-journey-strip").waitFor({
    state: "visible",
    timeout: timeoutMs,
  });
  await page.locator("#tbrole").selectOption("builder");
  await waitForRole({
    domain: domain.id,
    expectedNavigation: [
      "registry",
      "gateway",
      "projects",
      "agents",
      "deployments",
      "approvals",
      "build",
      "operations",
      "cost",
      "incidents",
      "publications",
    ],
    page,
    role: "builder",
    timeoutMs,
  });
  if (
    await page.evaluate(() =>
      sessionStorage.getItem("console.demo-assist.journey"))
      !== null
    || await page.locator(".demo-journey-strip").count() !== 0
  ) {
    throw acceptanceFailure("demo-journey-role-reconciliation");
  }
  if (!await page.locator("#side")
    .getByText("Build Workspace", { exact: true }).isVisible()) {
    throw acceptanceFailure("builder-navigation");
  }
  await runBrowserStage("demo-journey-builder", async () => {
    await assertDemoJourneyNavigation({
      journeyId: "build-agent",
      nextSelector: "#hostedbuild",
      page,
      startSelector: '#hostedcollection[data-resource="projects"]',
      timeoutMs,
    });
  });
  await page.locator('[data-shellnav="gateway"]').click();
  await page.locator("#hostedgateway .gateway-model").first().waitFor({
    state: "visible",
    timeout: timeoutMs,
  });
  await page.locator('[data-shellnav="registry"]').click();
  await assertScopedRegistryReadOnly(page, timeoutMs);
  await page.locator('[data-shellnav="build"]').click();
  await openHostedFullJourney(page, timeoutMs);
  await assertDemoSelectorOnly(page, { requireSelector: true });
  await captureRole({
    artifactDirectory,
    name: "builder",
    page,
    screenshots,
    timeoutMs,
    viewport,
  });

  await page.locator("#tbrole").selectOption("user");
  await waitForRole({
    domain: null,
    expectedNavigation: [
      "overview",
      "approvedagents",
      "sessions",
      "accessrequests",
    ],
    page,
    role: "user",
    timeoutMs,
  });
  if (!await page.locator('[data-shellnav="overview"]').isVisible()) {
    throw acceptanceFailure("user-overview-navigation");
  }
  const approvedAgentSummary = page.locator("#hostedoverview .item").first();
  await approvedAgentSummary.waitFor({
    state: "visible",
    timeout: timeoutMs,
  });
  if (
    !/approved agents? available/i.test(
      await approvedAgentSummary.textContent(),
    )
  ) {
    throw acceptanceFailure("user-overview-data");
  }
  await runBrowserStage("demo-journey-user", async () => {
    await assertDemoJourneyNavigation({
      journeyId: "use-approved-agent",
      nextSelector: "#approvedagents",
      page,
      startSelector: "#hostedoverview",
      timeoutMs,
    });
  });
  await captureRole({
    artifactDirectory,
    name: "user",
    page,
    screenshots,
    timeoutMs,
    viewport,
  });

  await page.locator('[data-shellnav="approvedagents"]').click();
  await page.locator("#approvedagents .approvedagent").first().waitFor({
    state: "visible",
    timeout: timeoutMs,
  });
  await assertDemoSelectorOnly(page, { requireSelector: true });
  if (viewport === "mobile") {
    await assertApprovedAgentMobileLayout(page);
  }
  await page.locator('[data-shellnav="accessrequests"]').click();
  await page.locator("#hostedaccessrequests").waitFor({
    state: "visible",
    timeout: timeoutMs,
  });

  await page.reload({
    waitUntil: "domcontentloaded",
    timeout: timeoutMs,
  });
  await waitForRole({
    domain: null,
    expectedNavigation: [
      "overview",
      "approvedagents",
      "sessions",
      "accessrequests",
    ],
    page,
    role: "user",
    timeoutMs,
  });
  await captureRole({
    artifactDirectory,
    name: "user-reload",
    page,
    screenshots,
    timeoutMs,
    viewport,
  });

  await page.locator("#tbrole").selectOption("admin");
  await waitForRole({
    domain: null,
    expectedNavigation: [
      "dashboard",
      "domains",
      "registry",
      "gateway",
      "projects",
      "agents",
      "deployments",
      "approvals",
      "domainaccess",
      "build",
      "operations",
      "cost",
      "audit",
      "incidents",
      "breakglass",
      "publications",
    ],
    page,
    role: "admin",
    timeoutMs,
  });
  if (!isDeepStrictEqual(
    await visibleNavigation(page),
    [
      "dashboard",
      "domains",
      "registry",
      "gateway",
      "projects",
      "agents",
      "deployments",
      "approvals",
      "domainaccess",
      "build",
      "operations",
      "cost",
      "audit",
      "incidents",
      "breakglass",
      "publications",
    ],
  )) {
    throw acceptanceFailure("administrator-return");
  }

  const ordinaryPage = await context.newPage();
  try {
    await ordinaryPage.addInitScript((session) => {
      sessionStorage.setItem(
        "console.cognito.tokens",
        JSON.stringify(session.tokens),
      );
    }, { tokens: ordinaryTokens });
    await ordinaryPage.goto(applicationUrl, {
      waitUntil: "domcontentloaded",
      timeout: timeoutMs,
    });
    await ordinaryPage.locator('[data-shellnav="overview"]').waitFor({
      state: "visible",
      timeout: timeoutMs,
    });
    if (
      await ordinaryPage.locator("#tbdemoassist").count() !== 0
      || await ordinaryPage.locator("[data-demo-assist-controls]").count() !== 0
    ) {
      throw acceptanceFailure("demo-assist-non-operator");
    }
  } finally {
    await ordinaryPage.close();
  }

  await page.route("**/api/me", async (route) => {
    await route.fulfill({
      body: JSON.stringify({
        code: "TEMPORARY_FAILURE",
        ok: false,
      }),
      contentType: "application/json",
      status: 503,
    });
  }, { times: 1 });
  // rollback-failure: allow the requested context write, then make restoring
  // the previous context fail after /api/me fails. The UI must sign out.
  await page.evaluate(() => {
    const original = Storage.prototype.setItem;
    let demoContextWrites = 0;
    Storage.prototype.setItem = function setItem(key, value) {
      if (key === "console.demo-context") {
        demoContextWrites += 1;
        if (demoContextWrites === 2) {
          throw new Error("simulated storage failure");
        }
      }
      return original.call(this, key, value);
    };
  });
  await page.locator("#tbrole").selectOption("user");
  await page.locator("#cognitosignin").waitFor({
    state: "visible",
    timeout: timeoutMs,
  });
  return screenshots;
}

export function createPlaywrightRoleSwitchingBrowserAdapter({
  chromium,
  environment = process.env,
  operationTimeoutMs = DEFAULT_OPERATION_TIMEOUT_MS,
} = {}) {
  if (!chromium || typeof chromium.launch !== "function") {
    throw configurationFailure();
  }
  const timeoutMs = positiveInteger(operationTimeoutMs);
  const browserEnvironment = createBrowserEnvironment(environment);
  return {
    managesOwnDeadline: true,
    async verifyRoleJourney({
      applicationUrl,
      artifactDirectory,
      domain,
      ordinaryTokens,
      tokens,
    }) {
      if (
        typeof applicationUrl !== "string"
        || typeof artifactDirectory !== "string"
        || !isPlainObject(domain)
        || normalizedDomain(domain.id) !== domain.id
        || typeof domain.name !== "string"
        || !domain.name
        || typeof tokens?.accessToken !== "string"
        || typeof tokens?.idToken !== "string"
        || !Number.isFinite(tokens?.expiresAt)
        || typeof ordinaryTokens?.accessToken !== "string"
        || typeof ordinaryTokens?.idToken !== "string"
        || !Number.isFinite(ordinaryTokens?.expiresAt)
      ) {
        throw configurationFailure();
      }
      const browser = await withDeadline(() =>
        chromium.launch({
          env: browserEnvironment,
          headless: true,
          timeout: timeoutMs,
        }), timeoutMs);
      const screenshots = [];
      let failure;
      try {
        for (const viewport of VIEWPORTS) {
          const context = await withDeadline(() =>
            browser.newContext({
              viewport: {
                width: viewport.width,
                height: viewport.height,
              },
            }), timeoutMs);
          try {
            const page = await withDeadline(() =>
              context.newPage(), timeoutMs);
            page.setDefaultTimeout(timeoutMs);
            page.setDefaultNavigationTimeout(timeoutMs);
            screenshots.push(...await performRoleJourney({
              applicationUrl,
              artifactDirectory,
              context,
              domain,
              ordinaryTokens,
              page,
              timeoutMs,
              tokens,
              viewport: viewport.name,
            }));
          } catch (error) {
            failure =
              error instanceof HostedRoleSwitchingError
              && error.code === "HOSTED_ROLE_SWITCHING_FAILED"
                ? error
                : acceptanceFailure("browser");
            throw failure;
          } finally {
            try {
              await retryCleanup(
                () => context.close(),
                DEFAULT_CLEANUP_ATTEMPTS,
                timeoutMs,
              );
            } catch {
              if (failure) {
                failure.cleanupCode =
                  "HOSTED_ROLE_SWITCHING_CLEANUP_FAILED";
              } else {
                failure = cleanupFailure();
              }
            }
          }
        }
      } finally {
        try {
          await retryCleanup(
            () => browser.close(),
            DEFAULT_CLEANUP_ATTEMPTS,
            timeoutMs,
          );
        } catch {
          if (failure) {
            failure.cleanupCode =
              "HOSTED_ROLE_SWITCHING_CLEANUP_FAILED";
          } else {
            failure = cleanupFailure();
          }
        }
      }
      if (failure) throw failure;
      return {
        domainId: domain.id,
        roles: [...EXPECTED_BROWSER_ROLES],
        screenshots,
      };
    },
  };
}

function validRoleSwitchingBrowserResult(result, expectedDomainId) {
  if (
    !isPlainObject(result)
    || Object.keys(result).sort().join(",") !==
      "domainId,roles,screenshots"
    || result.domainId !== expectedDomainId
    || !isDeepStrictEqual(result.roles, [...EXPECTED_BROWSER_ROLES])
    || !isDeepStrictEqual(result.screenshots, [...EXPECTED_SCREENSHOTS])
  ) {
    throw acceptanceFailure("browser-result");
  }
  return result;
}

function roleSwitchingBrowserProcessFailure(cleanupCode, stage) {
  const error = acceptanceFailure(
    browserDiagnosticStage(stage, "browser-process"),
  );
  if (cleanupCode === "HOSTED_ROLE_SWITCHING_CLEANUP_FAILED") {
    error.cleanupCode = cleanupCode;
  }
  return error;
}

function runRoleSwitchingBrowserWorker(input, {
  deadlineTimers,
  environment,
  journeyTimeoutMs,
  killProcess,
  operationTimeoutMs,
  processExecutable,
  processTerminationTimeoutMs,
  spawnProcess,
  workerPath,
}) {
  return new Promise((resolve, reject) => {
    let child;
    let operationTimer;
    let output = "";
    let settled = false;
    let terminating = false;
    let terminationTimer;

    const destroyStdio = () => {
      for (const stream of [child?.stdin, child?.stdout, child?.stderr]) {
        try {
          stream?.destroy();
        } catch {
          // The secondary deadline still bounds cleanup.
        }
      }
    };
    const clearTimers = () => {
      if (operationTimer !== undefined) {
        deadlineTimers.clearTimeout(operationTimer);
        operationTimer = undefined;
      }
      if (terminationTimer !== undefined) {
        deadlineTimers.clearTimeout(terminationTimer);
        terminationTimer = undefined;
      }
    };
    const settle = (operation) => {
      if (settled) return;
      settled = true;
      clearTimers();
      destroyStdio();
      operation();
    };
    const killProcessGroup = () => {
      if (!Number.isInteger(child?.pid) || child.pid <= 0) return;
      try {
        killProcess(-child.pid, "SIGKILL");
      } catch {
        try {
          child.kill?.("SIGKILL");
        } catch {
          // The secondary deadline still bounds cleanup.
        }
      }
    };
    const terminate = (failure) => {
      if (settled || terminating) return;
      terminating = true;
      if (operationTimer !== undefined) {
        deadlineTimers.clearTimeout(operationTimer);
        operationTimer = undefined;
      }
      killProcessGroup();
      destroyStdio();
      terminationTimer = deadlineTimers.setTimeout(() => {
        try {
          child?.unref?.();
        } catch {
          // Rejection remains bounded.
        }
        settle(() => reject(failure));
      }, processTerminationTimeoutMs);
    };
    const rejectClosedWorker = (cleanupCode, stage) => {
      killProcessGroup();
      settle(() =>
        reject(roleSwitchingBrowserProcessFailure(cleanupCode, stage)));
    };

    try {
      child = spawnProcess(processExecutable, [workerPath], {
        detached: true,
        env: environment,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch {
      reject(roleSwitchingBrowserProcessFailure());
      return;
    }

    operationTimer = deadlineTimers.setTimeout(() => {
      terminate(roleSwitchingBrowserProcessFailure());
    }, journeyTimeoutMs);
    child.stdout.on("data", (chunk) => {
      output += chunk.toString();
      if (Buffer.byteLength(output) > MAX_BROWSER_WORKER_OUTPUT_BYTES) {
        output = "";
        terminate(roleSwitchingBrowserProcessFailure());
      }
    });
    child.stderr.on("data", () => {
      // Consume without retaining browser or credential-bearing diagnostics.
    });
    child.on("error", () => {
      terminate(roleSwitchingBrowserProcessFailure());
    });
    child.on("close", (code) => {
      if (terminating) {
        settle(() => reject(roleSwitchingBrowserProcessFailure()));
        return;
      }
      let response;
      try {
        response = JSON.parse(output.trim());
      } catch {
        rejectClosedWorker();
        return;
      }
      if (
        code === 0
        && isPlainObject(response)
        && response.ok === true
        && Object.keys(response).sort().join(",") === "ok,result"
      ) {
        try {
          const result = validRoleSwitchingBrowserResult(
            response.result,
            input.domain.id,
          );
          settle(() => resolve(result));
        } catch {
          rejectClosedWorker();
        }
        return;
      }
      rejectClosedWorker(response?.cleanupCode, response?.stage);
    });
    child.stdin.on("error", () => {
      terminate(roleSwitchingBrowserProcessFailure());
    });
    child.stdin.end(JSON.stringify({
      ...input,
      operationTimeoutMs,
    }));
  });
}

export function createPlaywrightRoleSwitchingBrowserProcessAdapter({
  deadlineTimers = BROWSER_DEADLINE_TIMERS,
  environment = process.env,
  journeyTimeoutMs = DEFAULT_JOURNEY_TIMEOUT_MS,
  killProcess = process.kill,
  operationTimeoutMs = DEFAULT_OPERATION_TIMEOUT_MS,
  processExecutable = process.execPath,
  processTerminationTimeoutMs =
    DEFAULT_BROWSER_PROCESS_TERMINATION_TIMEOUT_MS,
  spawnProcess = spawn,
  workerUrl = new URL(
    "./hosted-role-switching-browser-worker.mjs",
    import.meta.url,
  ),
} = {}) {
  const browserOperationTimeoutMs = positiveInteger(operationTimeoutMs);
  const journeyDeadlineMs = positiveInteger(journeyTimeoutMs);
  const terminationTimeoutMs = positiveInteger(
    processTerminationTimeoutMs,
  );
  const workerPath = fileURLToPath(workerUrl);
  const workerEnvironment = createBrowserEnvironment(environment);
  return {
    managesOwnDeadline: true,
    verifyRoleJourney(input) {
      return runRoleSwitchingBrowserWorker(input, {
        deadlineTimers,
        environment: workerEnvironment,
        journeyTimeoutMs: journeyDeadlineMs,
        killProcess,
        operationTimeoutMs: browserOperationTimeoutMs,
        processExecutable,
        processTerminationTimeoutMs: terminationTimeoutMs,
        spawnProcess,
        workerPath,
      });
    },
  };
}

function requiredEnvironment(environment, name) {
  return requiredString(environment[name]);
}

function validBrokerFunctionArn(value, region, accountId) {
  return typeof value === "string"
    && value ===
      `arn:aws:lambda:${region}:${accountId}:`
        + "function:AgenticPlatform-Web-HostedAcceptanceBroker";
}

export function createRoleSwitchingBrokerResourceAdapter({
  accountId,
  brokerFunctionArn,
  lambdaClient,
  region,
}) {
  const base = createAwsBrokerResourceAdapter({
    accountId,
    brokerFunctionArn,
    lambdaClient,
    region,
  });
  const invoke = async (operation, input) => {
    const payload = Buffer.from(
      JSON.stringify({ operation, input }),
      "utf8",
    );
    if (
      payload.byteLength === 0
      || payload.byteLength > MAX_BROKER_REQUEST_BYTES
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
    if (
      response?.StatusCode !== 200
      || response.FunctionError !== undefined
      || !(response.Payload instanceof Uint8Array)
      || response.Payload.byteLength === 0
      || response.Payload.byteLength > MAX_BROKER_RESPONSE_BYTES
    ) {
      throw cleanupFailure();
    }
    let body;
    try {
      body = JSON.parse(Buffer.from(response.Payload).toString("utf8"));
    } catch {
      throw cleanupFailure();
    }
    if (
      !isPlainObject(body)
      || Reflect.ownKeys(body).length !== 2
      || body.ok !== true
      || !Object.hasOwn(body, "result")
    ) {
      throw cleanupFailure();
    }
    return body.result;
  };
  return {
    ...base,
    persistPersonaJourneyFixture: (input) =>
      invoke("persistPersonaJourneyFixture", input),
    cleanupPersonaJourneyFixture: (input) =>
      invoke("cleanupPersonaJourneyFixture", input),
    cleanupAgentBuildingJourneyFixtures: (input) =>
      invoke("cleanupAgentBuildingJourneyFixtures", input),
  };
}

export async function runCli({
  argv = [],
  dependencies = {},
  env = process.env,
} = {}) {
  const cleanupOnly = argv.length === 1 && argv[0] === "--cleanup-only";
  if (argv.length !== 0 && !cleanupOnly) throw configurationFailure();
  const region = requiredEnvironment(env, "AWS_REGION");
  const accountId = requiredEnvironment(env, "AWS_ACCOUNT_ID");
  if (!/^[0-9]{12}$/.test(accountId)) throw configurationFailure();
  const outputs = (
    dependencies.readStackOutputs
    ?? readHostedAcceptanceStackOutputs
  )({
    controlPlaneOutputsPath:
      env.HOSTED_ACCEPTANCE_CONTROL_PLANE_OUTPUTS_FILE,
    webOutputsPath: env.HOSTED_ACCEPTANCE_WEB_OUTPUTS_FILE,
  });
  if (
    !outputs.userPoolId.startsWith(`${region}_`)
    || !validBrokerFunctionArn(
      outputs.brokerFunctionArn,
      region,
      accountId,
    )
  ) {
    throw configurationFailure();
  }
  const cognito = (
    dependencies.createCognitoAdapter
    ?? createRoleSwitchingCognitoAdapter
  )({ region });
  const lambdaClient = (
    dependencies.createLambdaClient
    ?? ((input) => new LambdaClient(input))
  )({ region });
  const resources = (
    dependencies.createResourceAdapter
    ?? createRoleSwitchingBrokerResourceAdapter
  )({
    accountId,
    brokerFunctionArn: outputs.brokerFunctionArn,
    lambdaClient,
    region,
  });
  const common = {
    cognito,
    fixtureRegistryId: outputs.fixtureRegistryId,
    resources,
    runAttempt: requiredEnvironment(
      env,
      "HOSTED_ROLE_SWITCHING_RUN_ATTEMPT",
    ),
    runId: requiredEnvironment(env, "HOSTED_ROLE_SWITCHING_RUN_ID"),
    userPoolId: outputs.userPoolId,
  };
  if (cleanupOnly) {
    await (
      dependencies.cleanupRun
      ?? cleanupHostedRoleSwitchingRun
    )(common);
    return "cleanup";
  }
  const operatorUsernames = (
    dependencies.readPrivateOperatorUsernames
    ?? readPrivateOperatorUsernames
  )(requiredEnvironment(env, "HOSTED_ROLE_SWITCHING_OPERATORS_FILE"));
  let browser;
  if (dependencies.createBrowserAdapter) {
    browser = dependencies.createBrowserAdapter({ environment: env });
  } else {
    browser = createPlaywrightRoleSwitchingBrowserProcessAdapter({
      environment: env,
    });
  }
  await (
    dependencies.runAcceptance
    ?? runHostedRoleSwitchingAcceptance
  )({
    applicationUrl: outputs.applicationUrl,
    browser,
    clientId: outputs.clientId,
    ...common,
    operatorUsernames,
    preferredBuilderModelId: outputs.starterBuilderModelId,
    region,
  });
  return "acceptance";
}

const isExecutable = process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isExecutable) {
  try {
    await runCli({
      argv: process.argv.slice(2),
      env: process.env,
    });
    console.log("Hosted role-switching acceptance passed.");
  } catch (error) {
    console.error(
      error instanceof Error
        ? error.message
        : "Hosted role-switching acceptance failed.",
    );
    process.exitCode = 1;
  }
}
