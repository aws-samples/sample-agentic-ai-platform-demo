import { createHash } from "node:crypto";
import { foundationCatalog, resourceKey } from "../../../../console/public/domain-foundation-catalog.mjs";

export const STEPS = Object.freeze([
  ["registry", "Verify AI Registry selections"],
  ["domain", "Create domain and Registry"],
  ["identity", "Assign domain administrator"],
  ["model", "Apply domain resource access"],
  ["environments", "Prepare environment foundations"],
  ["verify", "Verify foundation and hand over"],
]);
const ID = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;
export class BootstrapError extends Error {
  constructor(code, message, statusCode = 409) {
    super(message); this.code = code; this.statusCode = statusCode;
  }
}
export function fingerprint(value) {
  const canonical = value => Array.isArray(value) ? value.map(canonical)
    : value && typeof value === "object"
      ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]))
      : value;
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}
export function environmentRequestToken(operation) {
  // CloudFormation excludes underscores even though platform domain IDs use them.
  return `domain-${fingerprint(operation.domainId).slice(0, 32)}-${operation.attempt}`;
}
function fail(code, message, status) { throw new BootstrapError(code, message, status); }
function exact(input, keys) {
  if (!input || typeof input !== "object" || Array.isArray(input)
      || Object.keys(input).length !== keys.length || keys.some(key => !Object.hasOwn(input, key))) {
    fail("INVALID_CONFIGURATION", "Domain configuration is invalid.", 400);
  }
}
function string(value, name, max = 256) {
  if (typeof value !== "string" || !value.trim() || value !== value.trim()
      || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) {
    fail("INVALID_CONFIGURATION", `${name} is invalid.`, 400);
  }
  return value;
}
export function validateConfiguration(input, target) {
  exact(input, ["name", "description", "owner", "administrator", "accountId", "region", "environments",
    "blueprints", "models", "resources"]);
  const name = string(input.name, "Domain name", 57).replace(/[ _-]+/g, " ");
  const domainId = name.toLowerCase().replaceAll(" ", "_");
  if (!/^[A-Za-z][A-Za-z0-9]*(?: [A-Za-z0-9]+)*$/.test(name) || domainId.length < 2
      || !ID.test(domainId) || ["shared", "platform", "lead", "builder", "domain_builder",
        "platform_admin", "end_user", "demo_operator"].includes(domainId)) {
    fail("INVALID_CONFIGURATION", "Use a unique business domain name with letters and numbers.", 400);
  }
  if (input.accountId !== target.accountId || input.region !== target.region) {
    fail("TARGET_NOT_CONNECTED", "Select the connected AWS account and region.", 400);
  }
  if (!Array.isArray(input.environments) || !input.environments.includes("dev")
      || new Set(input.environments).size !== input.environments.length
      || input.environments.some(value => !["dev", "preprod", "prod"].includes(value))) {
    fail("INVALID_CONFIGURATION", "Select dev and any additional environments to prepare.", 400);
  }
  if (typeof input.description !== "string" || input.description.length > 2048
      || /[\u0000-\u001f\u007f]/.test(input.description)) {
    fail("INVALID_CONFIGURATION", "Description is invalid.", 400);
  }
  string(input.owner, "Business owner");
  string(input.administrator, "Domain administrator", 128);
  const validRef = ref => ref && typeof ref === "object" && !Array.isArray(ref)
    && Object.keys(ref).sort().join(",") === "id,recordId,registryId,type,version"
    && ["type", "id", "version"].every(key => typeof ref[key] === "string" && ref[key].length > 0 && ref[key].length <= 512)
    && ["registryId", "recordId"].every(key => ref[key] === null || (typeof ref[key] === "string" && ref[key].length <= 128));
  if (["blueprints", "models", "resources"].some(field =>
    !Array.isArray(input[field]) || input[field].length > 50
      || input[field].some(ref => !validRef(ref))
      || new Set(input[field].map(resourceKey)).size !== input[field].length)) {
    fail("INVALID_CONFIGURATION", "Resource selections are invalid.", 400);
  }
  return { ...input, name, domainId, environments: [...input.environments].sort(),
    ...Object.fromEntries(["blueprints", "models", "resources"].map(field =>
      [field, [...input[field]].sort((a, b) => resourceKey(a).localeCompare(resourceKey(b)))])) };
}
export function resolveConfiguration(config, registry) {
  // Domain environments do not depend on an agent blueprint. A partial display
  // inventory can authorize only exact, readable APPROVED selections; an
  // unrelated unreadable record does not authorize itself or block empty setup.
  const catalog = foundationCatalog(registry, { displayOnly: true });
  const find = (ref, entries, label) => {
    const found = entries.find(entry => resourceKey(entry.ref) === resourceKey(ref || {}));
    if (!found) fail("REGISTRY_CHANGED", `${label} is no longer available in the Registry. Review the current selections.`);
    return found;
  };
  const blueprints = config.blueprints.map(ref => find(ref, catalog.blueprints, "Selected agent blueprint"));
  const models = config.models.map(ref => find(ref, catalog.models, "Selected model"));
  const resources = config.resources.map(ref => find(ref, catalog.resources, "Selected resource"));
  return { blueprints, models, resources };
}
export function createBootstrapService({ store, registry, administrators, workflows, actions, target, now = () => new Date().toISOString() }) {
  function resolvePlan(config, inventory, admins) {
    const administrator = admins.find(admin => admin.username === config.administrator
      && admin.enabled && admin.eligible && typeof admin.subject === "string" && admin.subject);
    if (!administrator) fail("ADMINISTRATOR_UNAVAILABLE", "Select an available administrator from the user directory.");
    return { ...resolveConfiguration(config, inventory),
      administrator: { username: administrator.username, subject: administrator.subject } };
  }
  async function preview(identity, input) {
    if (identity.role !== "admin") fail("FORBIDDEN", "Platform administrator access is required.", 403);
    const config = validateConfiguration(input, target);
    const [inventory, admins] = await Promise.all([registry(identity), administrators()]);
    const resolved = resolvePlan(config, inventory, admins);
    await actions.preflight(config, resolved);
    const warnings = inventory.incomplete === true || inventory.completeness === "incomplete"
      ? [{ code: "REGISTRY_PARTIAL", message: "Some Registry records could not be read. Only the selected, readable approved resources will be enabled." }] : [];
    return { config, resolved, previewHash: fingerprint({ config, resolved }), target, warnings };
  }
  async function read(identity, domainId) {
    if (!ID.test(domainId)) fail("INVALID_DOMAIN", "Domain is invalid.", 400);
    if (identity.role !== "admin" && !(
      ["lead", "builder"].includes(identity.role) && identity.activeDomain === domainId
      && identity.domainIds.includes(domainId))) fail("NOT_FOUND", "Domain not found.", 404);
    const operation = await store.get(domainId);
    if (!operation) return { operation: null };
    const { actor, ...visible } = operation;
    return { operation: visible };
  }
  return {
    async catalog(identity) {
      if (identity.role !== "admin") fail("FORBIDDEN", "Platform administrator access is required.", 403);
      const [inventory, admins] = await Promise.all([registry(identity), administrators()]);
      return { ...foundationCatalog(inventory, { displayOnly: true }), administrators: admins, target,
        defaultAdministrator: admins.find(admin => admin.username === identity.username && admin.enabled && admin.eligible)?.username || null };
    },
    preview,
    async review(identity, input) {
      try { return { ...await preview(identity, input), ready: true, blockers: [] }; }
      catch (error) {
        if (!(error instanceof BootstrapError) || error.statusCode !== 409) throw error;
        return { ready: false, config: validateConfiguration(input, target), target,
          blockers: [{ code: error.code, message: error.message }] };
      }
    },
    read,
    async start(identity, input) {
      exact(input, ["configuration", "previewHash"]);
      const plan = await preview(identity, input.configuration);
      if (plan.previewHash !== input.previewHash) {
        fail("REGISTRY_CHANGED", "AI Registry or the configuration changed. Review the updated plan before starting.");
      }
      let operation = await store.get(plan.config.domainId);
      if (operation) {
        if (operation.configurationHash !== plan.previewHash || operation.actor.subject !== identity.subject) {
          fail("DOMAIN_EXISTS", "This domain already has a bootstrap operation.");
        }
      } else {
        operation = {
          schemaVersion: 2, domainId: plan.config.domainId, operationId: `domain-${plan.config.domainId}`,
          configurationHash: plan.previewHash, configuration: plan.config,
          // Immutable evidence of exactly what was reviewed. Catalog reads always
          // resolve live Registry content, never this execution snapshot.
          applied: plan.resolved, actor: { subject: identity.subject, username: identity.username },
          status: "QUEUED", attempt: 1, createdAt: now(), updatedAt: now(),
          steps: STEPS.map(([id, label]) => ({ id, label, status: "PENDING" })),
          outputs: {},
        };
        await store.create(operation);
      }
      if (operation.status === "QUEUED") await workflows.start(operation);
      return read(identity, operation.domainId);
    },
    async retry(identity, domainId) {
      if (identity.role !== "admin") fail("FORBIDDEN", "Platform administrator access is required.", 403);
      const { operation } = await read(identity, domainId);
      if (!operation || operation.status !== "FAILED") fail("NOT_RETRYABLE", "Only a failed operation can be retried.");
      const current = await store.get(domainId);
      // Only resume the reviewed immutable configuration, including all references.
      const resolved = resolvePlan(current.configuration, await registry(identity), await administrators());
      if (fingerprint({ config: current.configuration, resolved }) !== current.configurationHash) {
        fail("REGISTRY_CHANGED", "Registry definitions changed. This operation cannot resume with different content.");
      }
      if (current.actor.subject !== identity.subject) fail("FORBIDDEN", "The initiating administrator must resume this operation.", 403);
      const next = { ...current,
        attempt: current.attempt + 1, status: "QUEUED", updatedAt: now(), error: null };
      await store.replace(next, current);
      await workflows.start(next);
      return read(identity, domainId);
    },
    async execute(domainId, step, attempt) {
      if (!STEPS.some(([id]) => id === step)) fail("INVALID_STEP", "Bootstrap step is invalid.");
      const current = await store.get(domainId);
      if (!current || current.attempt !== attempt || !["QUEUED", "RUNNING"].includes(current.status)) {
        fail("STALE_OPERATION", "Bootstrap execution is no longer current.");
      }
      const index = current.steps.findIndex(item => item.id === step);
      if (current.steps[index].status === "SUCCEEDED") return;
      if (current.steps.slice(0, index).some(item => item.status !== "SUCCEEDED")) {
        fail("OUT_OF_ORDER", "Previous bootstrap steps are incomplete.");
      }
      // Execution retries may enter RUNNING again. Each action must reconcile its
      // exact operation-owned resources and refuse unrelated resources.
      const running = { ...current, status: "RUNNING", updatedAt: now(),
        steps: current.steps.map(item => item.id === step ? { ...item, status: "RUNNING" } : item) };
      await store.replace(running, current);
      await actions.verifyActor(current.actor);
      let result;
      try {
        result = step === "registry"
          ? resolvePlan(current.configuration, await registry(current.actor), await administrators())
          : await actions[step](running);
      } catch (error) {
        // The domain API persists its Registry ARN and returns a retryable 503
        // while AWS is still creating it. Resume that same idempotent request.
        if (step === "domain" && error instanceof BootstrapError
            && error.code === "DOMAIN_PROVISIONING_FAILED" && error.statusCode === 503) {
          error.name = "FoundationInProgress";
        }
        throw error;
      }
      if (step === "registry"
          && fingerprint({ config: current.configuration, resolved: result }) !== current.configurationHash) {
        fail("REGISTRY_CHANGED", "Registry content changed after review.");
      }
      const latest = await store.get(domainId);
      if (latest.attempt !== attempt || latest.status !== "RUNNING") fail("STALE_OPERATION", "Bootstrap execution changed.");
      const done = { ...latest, updatedAt: now(),
        status: step === "verify" ? "SUCCEEDED" : "RUNNING",
        steps: running.steps.map(item => item.id === step ? { ...item, status: "SUCCEEDED" } : item),
        outputs: { ...latest.outputs, ...(step === "registry" ? {} : result) } };
      await store.replace(done, latest);
    },
    async failure(domainId, attempt, error) {
      const current = await store.get(domainId);
      if (!current || current.attempt !== attempt || ["SUCCEEDED", "FAILED"].includes(current.status)) return;
      const message = error instanceof BootstrapError ? error.message
        : "Foundation setup could not complete. Retry after checking the operation logs.";
      await store.replace({ ...current, status: "FAILED", updatedAt: now(), error: message,
        steps: current.steps.map(step => step.status === "RUNNING" ? { ...step, status: "FAILED" } : step) }, current);
    },
  };
}
