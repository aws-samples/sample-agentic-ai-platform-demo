import { createDirtyTracker } from "../dirty-state.mjs"

const esc = value => String(value ?? "").replace(/[&<>"']/g, char => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
}[char]))
const usd = value => typeof value === "number" && Number.isFinite(value) && value >= 0
  ? `$${value > 0 && value < .000001 ? value.toPrecision(3) : value.toFixed(6)}` : "unknown"
const sameScope = (value, scope) => value?.domainId === scope.domainId && value?.projectId === scope.projectId

export function validateBudgetInput(input) {
  const monthlyLimitUsd = Number(input.monthlyLimitUsd)
  const thresholdPercent = Number(input.thresholdPercent)
  if (!["string", "number"].includes(typeof input.monthlyLimitUsd)
    || !["string", "number"].includes(typeof input.thresholdPercent)
    || !Number.isFinite(monthlyLimitUsd) || monthlyLimitUsd <= 0 || monthlyLimitUsd > 1e9
    || !Number.isInteger(thresholdPercent) || thresholdPercent < 1 || thresholdPercent > 100) {
    throw new Error("Enter a positive monthly limit up to 1,000,000,000 USD and an integer threshold from 1 to 100%.")
  }
  return { monthlyLimitUsd, thresholdPercent }
}

function validConfig(budget, scope) {
  if (!sameScope(budget, scope) || !Number.isSafeInteger(budget.version) || budget.version < 1
    || budget.currency !== "USD" || budget.period !== "CALENDAR_MONTH_UTC"
    || typeof budget.monthlyLimitUsd !== "number" || typeof budget.thresholdPercent !== "number") return false
  try { validateBudgetInput(budget); return true } catch { return false }
}

function readView(value, scope) {
  if (value?.ok !== true || value.resource !== "project-budget" || !sameScope(value.scope, scope)
    || !sameScope(value.project, scope) || value.project.status !== "ACTIVE"
    || typeof value.project.ownerSubject !== "string"
    || !["admin", "lead", "builder"].includes(value.access?.role)
    || value.access.canEdit !== ["admin", "lead"].includes(value.access.role)
    || !(value.budget === null || validConfig(value.budget, scope))) {
    throw new Error("The authorized project budget could not be read.")
  }
  if (value.evaluation != null && (!sameScope(value.evaluation, scope)
    || value.evaluation.configVersion !== value.budget?.version
    || value.evaluation.currency !== "USD" || value.evaluation.basis !== "estimate")) {
    throw new Error("The project budget evaluation is invalid.")
  }
  return value
}

export function createProjectBudgetController({ request, scope, requestId = () => crypto.randomUUID(),
  onChange = () => {}, isCurrent = () => true } = {}) {
  scope = { domainId: scope?.domainId, projectId: scope?.projectId }
  if (typeof request !== "function" || !/^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/.test(scope.domainId ?? "")
    || !/^[a-z][a-z0-9-]{0,63}$/.test(scope.projectId ?? "")) throw new Error("Invalid project budget scope.")
  const path = "/operations/project-budgets"
  const readPath = `${path}?${new URLSearchParams(scope)}`
  const state = { phase: "idle", view: null, draft: { monthlyLimitUsd: "", thresholdPercent: "80" }, message: "", dirty: false }
  const tracker = createDirtyTracker()
  let generation = 0, saving = false, mutation = null, acknowledged = null
  const publish = (phase, message = "") => {
    state.phase = phase
    state.message = message
    if (isCurrent()) onChange(state)
  }
  const apply = view => {
    state.view = view
    state.draft = { monthlyLimitUsd: String(view.budget?.monthlyLimitUsd ?? ""),
      thresholdPercent: String(view.budget?.thresholdPercent ?? 80) }
    tracker.setBaseline("budget", state.draft)
    state.dirty = false
  }
  function edit(draft) {
    if (saving || !isCurrent() || state.view?.access.canEdit !== true) return
    state.draft = { monthlyLimitUsd: String(draft.monthlyLimitUsd), thresholdPercent: String(draft.thresholdPercent) }
    state.dirty = tracker.isDirty("budget", state.draft)
  }
  function confirm(view) {
    if (!acknowledged) return false
    if (!view.budget || view.budget.version < acknowledged.version
      || (view.budget.version === acknowledged.version
        && (view.budget.monthlyLimitUsd !== acknowledged.monthlyLimitUsd
          || view.budget.thresholdPercent !== acknowledged.thresholdPercent))) {
      throw new Error("Persisted read-back has not confirmed the saved version.")
    }
    const newer = view.budget.version > acknowledged.version
    acknowledged = null
    mutation = null
    apply(view)
    publish(newer ? "ready" : "saved", newer
      ? "A newer version is now persisted. Review the current values."
      : "Saved and verified by persisted GET read-back.")
    return true
  }
  async function load() {
    if (saving || !isCurrent()) return
    const current = ++generation
    publish("loading")
    try {
      const view = readView(await request(readPath), scope)
      if (current !== generation || !isCurrent()) return
      if (!confirm(view)) { apply(view); publish("ready") }
    } catch {
      if (current !== generation || !isCurrent()) return
      state.view = null
      publish(acknowledged ? "unconfirmed" : "load-error", acknowledged
        ? "Save acknowledged; persisted read-back is unconfirmed. Refresh to verify."
        : "Budget and access are unavailable. Refresh to retry.")
    }
  }
  async function save(draft) {
    if (saving || !isCurrent()) return
    edit(draft)
    if (acknowledged || state.view?.access.canEdit !== true) {
      publish("save-error", "Ask an authorized admin or domain lead to edit this budget, or refresh access.")
      return
    }
    let values
    try { values = validateBudgetInput(draft) } catch (error) { publish("validation-error", error.message); return }
    const body = { ...scope, expectedVersion: state.view.budget?.version ?? 0,
      currency: "USD", period: "CALENDAR_MONTH_UTC", ...values }
    const fingerprint = JSON.stringify(body)
    if (mutation?.fingerprint !== fingerprint) mutation = { fingerprint, id: requestId() }
    const current = ++generation
    saving = true
    publish("saving", "Saving project budget…")
    try {
      const result = await request(path, body, { requestId: mutation.id })
      if (current !== generation || !isCurrent()) return
      if (result?.ok !== true) {
        if (result?.code === "CONFLICT") {
          mutation = null
          const view = readView(await request(readPath), scope)
          if (!isCurrent()) return
          // The GET is authoritative even though our POST conflicted. Preserve
          // the draft, but compare it against the current persisted values.
          const draft = state.draft
          apply(view)
          state.draft = draft
          state.dirty = tracker.isDirty("budget", draft)
          publish("conflict", "Budget changed. Review the current persisted version and your draft before saving again.")
        } else {
          if (["FORBIDDEN", "NOT_FOUND"].includes(result?.code)) state.view = null
          publish("save-error", "Budget save failed. Refresh access or retry; your draft has not been confirmed saved.")
        }
        return
      }
      if (!validConfig(result.budget, scope) || result.budget.version !== body.expectedVersion + 1
        || result.budget.monthlyLimitUsd !== body.monthlyLimitUsd || result.budget.thresholdPercent !== body.thresholdPercent) {
        throw new Error("Invalid save acknowledgement.")
      }
      acknowledged = result.budget
      const view = readView(await request(readPath), scope)
      if (current === generation && isCurrent()) confirm(view)
    } catch {
      if (current !== generation || !isCurrent()) return
      publish(acknowledged ? "unconfirmed" : "save-error", acknowledged
        ? "Save acknowledged; persisted read-back is unconfirmed. Refresh to verify."
        : "Budget save failed or its outcome is unknown. Retry the same draft or refresh to verify.")
    } finally { saving = false }
  }
  return { state, load, save, edit }
}

// Tiny attributed amounts stay precise ($1.00e-7, not a misleading $0.00).
const plain = value => typeof value === "number" && Number.isFinite(value) && value >= 0
  ? `$${value > 0 && value < 0.01 ? value.toExponential(2) : value >= 100
    ? value.toLocaleString("en", { maximumFractionDigits: 0 }) : value.toFixed(2)}` : null
const day = value => {
  const at = Date.parse(value)
  return Number.isFinite(at)
    ? new Intl.DateTimeFormat("en", { dateStyle: "medium", timeZone: "UTC" }).format(at)
    : null
}

export function projectBudgetHtml(state, { postCreate = false } = {}) {
  const view = state.view, config = view?.budget, evaluation = view?.evaluation
  const busy = ["loading", "saving"].includes(state.phase)
  const editable = view?.access.canEdit === true && state.phase !== "unconfirmed"
  const draft = state.draft
  const spent = plain(evaluation?.knownEstimatedCostUsd)
  const limit = plain(config?.monthlyLimitUsd)
  const percent = config && typeof evaluation?.knownEstimatedCostUsd === "number"
    && config.monthlyLimitUsd > 0
    ? (evaluation.knownEstimatedCostUsd / config.monthlyLimitUsd) * 100 : null
  return `<section class="card" data-project-budget>
    <div class="sec-h">Monthly budget · ${esc(view?.project?.projectId ?? "project")}</div>
    ${postCreate ? `<p role="status">${state.phase === "saved" ? "Project created; budget saved and verified."
      : "Project created; budget setup is incomplete until a save is verified. You can retry here or return to Cost &amp; Budget."}</p>` : ""}
    ${state.message ? `<p role="status">${esc(state.message)}</p>` : ""}
    ${config ? `<div class="cv-kpis">
        <p>Budget: <b>${limit}</b> / month <span class="cv-sub">alert at ${config.thresholdPercent}%</span></p>
        <p>Model spend this month: <b>${spent ?? "$0.00"}</b>${percent !== null ? ` <span class="cv-sub">${percent.toFixed(1)}% of budget</span>` : ""}</p>
        ${evaluation && evaluation.status === "CROSSED" ? `<p><b>⚠ Alert threshold crossed</b></p>` : ""}
      </div>
      ${spent === null ? `<p class="cv-sub">No agent usage recorded this month yet — spend shows as $0 until agents run.</p>` : ""}
      <p class="cv-sub">Remaining budget: unknown — only model usage is measured, so the true remainder cannot be
        computed. Set ${day(config.updatedAt) ?? "recently"} · counts model inference only (shared runtime and
        infrastructure are platform-level costs) · alerts at the threshold, does not hard-stop spending.</p>`
      : `<p>No budget set for this project yet.${editable ? " Set one below to get alerted when model spend crosses your threshold." : ""}</p>`}
    ${editable ? `<form data-budget-form>
      <div class="grid2">
        <label>Monthly limit (USD)<input name="monthlyLimitUsd" type="number" min="0" max="1000000000" step="any" required value="${esc(draft.monthlyLimitUsd)}"${busy ? " disabled" : ""}/></label>
        <label>Alert threshold (%)<input name="thresholdPercent" type="number" min="1" max="100" step="1" required value="${esc(draft.thresholdPercent)}"${busy ? " disabled" : ""}/></label>
      </div>
      <button type="submit" class="primary"${busy ? " disabled" : ""}>Save budget</button>
    </form>` : view?.access.canEdit === false ? "<p>Ask an authorized admin or domain lead to set or edit this project budget.</p>" : ""}
    <button type="button" data-budget-refresh${busy ? " disabled" : ""}>Refresh</button>
    ${view ? `<details class="cv-method"><summary>Details &amp; caveats</summary>
      <p>Owner: ${esc(view.project.ownerSubject)} · your access: ${esc(view.access.role)} (${view.access.canEdit ? "edit" : "read only"})${config ? ` · budget version ${config.version}` : ""}.</p>
      <p>Budgets are USD over the UTC calendar month. Token allowances are separate controls.</p>
      ${evaluation ? `<p>Evaluation window: ${esc(evaluation.window?.startTime)} to ${esc(evaluation.window?.evaluatedThrough)}
        (calendar ends ${esc(evaluation.window?.endTime)}). Status: ${esc(evaluation.status)}.
        Started runs: ${esc(evaluation.runCount ?? "unknown")}. ${esc((evaluation.reasons ?? []).join(", "))}.</p>` : ""}
      <p>Threshold alerts fire on evaluation; delivery to recipients is not confirmed by this preview.</p>
    </details>` : ""}
  </section>`
}

export async function mountProjectBudget(root, options) {
  const isCurrent = options.isCurrent ?? (() => root.isConnected)
  const confirmDiscard = options.confirmDiscard ?? (() => globalThis.confirm("Discard unsaved budget changes and refresh persisted values?"))
  const controller = createProjectBudgetController({ ...options, isCurrent, onChange(state) {
    root.innerHTML = projectBudgetHtml(state, options)
    const form = root.querySelector("[data-budget-form]")
    if (form) {
      const readDraft = () => ({ monthlyLimitUsd: form.elements.monthlyLimitUsd.value,
        thresholdPercent: form.elements.thresholdPercent.value })
      form.oninput = () => controller.edit(readDraft())
      form.onsubmit = event => {
        event.preventDefault()
        void controller.save(readDraft())
      }
    }
    root.querySelector("[data-budget-refresh]").onclick = () => {
      if (!isCurrent() || (controller.state.dirty && state.phase !== "unconfirmed" && !confirmDiscard())) return
      return controller.load()
    }
    if (state.phase === "saved") options.onSaved?.(state.view)
  } })
  options.registerDirtyGuard?.(() => isCurrent() && controller.state.dirty)
  await controller.load()
  return controller
}
