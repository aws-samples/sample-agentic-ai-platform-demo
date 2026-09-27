const STORAGE_KEY = "console.demo-context";
const STORAGE_ERROR_MESSAGE = "Browser session storage is unavailable.";
const INVALID_CONTEXT_MESSAGE = "Demo role context is invalid.";
const ROLES = new Set(["admin", "lead", "builder", "user"]);
const ROLE_OPTIONS = Object.freeze([
  Object.freeze({ id: "admin", label: "Platform Admin" }),
  Object.freeze({ id: "lead", label: "Domain Lead" }),
  Object.freeze({ id: "builder", label: "Domain Builder" }),
  Object.freeze({ id: "user", label: "End User" }),
]);
const DOMAIN_PATTERN = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;
const MAX_DOMAIN_LENGTH = 64;
const RESERVED_DOMAINS = new Set(["platform", "shared"]);

function storageRead() {
  try {
    return sessionStorage.getItem(STORAGE_KEY);
  } catch {
    throw new Error(STORAGE_ERROR_MESSAGE);
  }
}

function storageWrite(value) {
  try {
    if (value === null) {
      sessionStorage.removeItem(STORAGE_KEY);
      return;
    }
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(value));
  } catch {
    throw new Error(STORAGE_ERROR_MESSAGE);
  }
}

function invalidContext() {
  throw new Error(INVALID_CONTEXT_MESSAGE);
}

function isPlainRecord(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function normalizedDomain(value, { allowReserved = false } = {}) {
  if (
    typeof value !== "string"
    || !value
    || value.length > MAX_DOMAIN_LENGTH
    || !DOMAIN_PATTERN.test(value)
    || (!allowReserved && RESERVED_DOMAINS.has(value))
  ) {
    return null;
  }
  return value;
}

function normalizedContext(
  value,
  { allowAdminDomain = false, fromStorage = false } = {},
) {
  if (!isPlainRecord(value)) invalidContext();
  if (Object.getOwnPropertySymbols(value).length > 0) invalidContext();

  const keys = Object.getOwnPropertyNames(value);
  if (
    !Object.hasOwn(value, "role")
    || keys.some((key) => key !== "role" && key !== "domain")
  ) {
    invalidContext();
  }

  const { role } = value;
  if (typeof role !== "string" || !ROLES.has(role)) invalidContext();

  if (role === "lead" || role === "builder") {
    const domain = normalizedDomain(value.domain);
    if (!domain) invalidContext();
    return { role, domain };
  }

  if (role === "admin" && (allowAdminDomain || fromStorage)) {
    const domain = value.domain == null
      ? null
      : normalizedDomain(value.domain, { allowReserved: true });
    if (value.domain != null && !domain) invalidContext();
    return { role, domain };
  }

  return { role, domain: null };
}

export function getDemoContext() {
  const raw = storageRead();
  if (raw === null) return null;

  try {
    return normalizedContext(JSON.parse(raw), { fromStorage: true });
  } catch (error) {
    try {
      storageWrite(null);
    } catch (storageError) {
      throw storageError;
    }
    if (error?.message === STORAGE_ERROR_MESSAGE) throw error;
    return null;
  }
}

export function setDemoContext(value, options = {}) {
  const context = normalizedContext(value, options);
  storageWrite(context);
  return context;
}

export function clearDemoContext() {
  storageWrite(null);
}

export function availableDemoRoleOptions(profile) {
  if (!Array.isArray(profile?.availableDemoRoles)) return [];
  const allowed = new Set(
    profile.availableDemoRoles.filter((role) => ROLES.has(role)),
  );
  return ROLE_OPTIONS
    .filter(({ id }) => allowed.has(id))
    .map((option) => ({ ...option }));
}

export function demoContextHeaders() {
  const context = getDemoContext();
  if (!context) return {};
  return {
    "x-demo-role": context.role,
    ...(context.domain
      ? { "x-active-domain": context.domain }
      : {}),
  };
}
