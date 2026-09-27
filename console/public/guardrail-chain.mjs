// platform-gate: v1 - canonical ordered guardrail configuration contract.
const ENTRY_KEYS = new Set([
  "id",
  "enabled",
  "action",
  "runMode",
  "message",
  "priority",
]);

export const GUARDRAIL_ACTIONS = Object.freeze([
  "Block",
  "Flag",
  "Redact",
]);
export const GUARDRAIL_RUN_MODES = Object.freeze([
  "Pre-Agent Execution",
  "Post-Agent Execution",
]);

const ACTIONS = new Set(GUARDRAIL_ACTIONS);
const RUN_MODES = new Set(GUARDRAIL_RUN_MODES);
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/;

export const GUARDRAIL_CATALOG = Object.freeze([
  Object.freeze({
    id: "pii-detection",
    name: "PII Detection",
    mandatory: true,
    action: "Block",
    runMode: "Pre-Agent Execution",
  }),
  Object.freeze({
    id: "harmful-content",
    name: "Harmful Content",
    mandatory: true,
    action: "Block",
    runMode: "Pre-Agent Execution",
  }),
  Object.freeze({
    id: "jailbreaking",
    name: "Jailbreaking",
    mandatory: true,
    action: "Block",
    runMode: "Pre-Agent Execution",
  }),
  Object.freeze({
    id: "prompt-injection",
    name: "Prompt Injection",
    mandatory: true,
    action: "Block",
    runMode: "Pre-Agent Execution",
  }),
  Object.freeze({
    id: "topic-restriction",
    name: "Topic Restriction",
    mandatory: false,
    action: "Flag",
    runMode: "Post-Agent Execution",
  }),
]);

const CATALOG_BY_ID = new Map(
  GUARDRAIL_CATALOG.map((entry) => [entry.id, entry]),
);

function plain(value) {
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

function exact(value, keys) {
  return plain(value)
    && Object.keys(value).length === keys.size
    && Object.keys(value).every((key) => keys.has(key));
}

export function defaultGuardrailChain() {
  return GUARDRAIL_CATALOG.map((entry, priority) => ({
    id: entry.id,
    enabled: true,
    action: entry.action,
    runMode: entry.runMode,
    message: "",
    priority,
  }));
}

export function validateGuardrailChain(value) {
  if (
    !Array.isArray(value)
    || value.length !== GUARDRAIL_CATALOG.length
  ) {
    throw new TypeError("Guardrail chain is malformed.");
  }
  const seen = new Set();
  const result = value.map((entry, priority) => {
    if (!exact(entry, ENTRY_KEYS)) {
      throw new TypeError("Guardrail chain is malformed.");
    }
    const catalog = CATALOG_BY_ID.get(entry.id);
    if (catalog?.mandatory && !entry.enabled) {
      throw new TypeError(
        `Mandatory guardrail "${entry.id}" cannot be disabled.`,
      );
    }
    if (
      !catalog
      || seen.has(entry.id)
      || typeof entry.enabled !== "boolean"
      || !ACTIONS.has(entry.action)
      || !RUN_MODES.has(entry.runMode)
      || typeof entry.message !== "string"
      || entry.message.length > 500
      || entry.message !== entry.message.trim()
      || CONTROL_CHARACTER_PATTERN.test(entry.message)
      || entry.priority !== priority
    ) {
      throw new TypeError("Guardrail chain is malformed.");
    }
    seen.add(entry.id);
    return { ...entry };
  });
  if (seen.size !== GUARDRAIL_CATALOG.length) {
    throw new TypeError("Guardrail chain is malformed.");
  }
  return result;
}
