// TLP-B7: blueprint submission + approval store. Only the platform role can
// submit a NEW blueprint (a structured template, not a from-scratch builder),
// and it reaches the blueprint list ONLY after a DIFFERENT platform admin
// approves it — the §9 platform-internal peer pattern (submitter ≠ approver,
// enforced server-side). Statuses:
//   pending_approval -> approved  (merged into /api/blueprints for everyone)
//                    -> rejected  (never rendered outside the platform team)
// Every state change AND every blocked decision attempt lands in the row's
// history[] audit array. Persisted console-local like policy-exemptions.json.
import { randomUUID } from "node:crypto"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

const STORE_PATH = join(dirname(fileURLToPath(import.meta.url)), "blueprint-submissions.json")

export const SUBMISSION_STATUSES = ["pending_approval", "approved", "rejected"]

export function loadSubmissions() {
  if (!existsSync(STORE_PATH)) return []
  try { return JSON.parse(readFileSync(STORE_PATH, "utf8")) } catch { return [] }
}
export function saveSubmissions(list) { writeFileSync(STORE_PATH, JSON.stringify(list, null, 2)) }

const historyEntry = (action, who, note) => ({
  action, who, at: new Date().toISOString(), ...(note ? { note } : {}),
})

// Validate a proposed blueprint against the SAME rules the registry enforces
// on Blueprint versions (catalog.blueprintOptions enums + the framework ×
// hosting compatibility matrix) plus the shape the wizard reads. Returns a
// list of human-readable errors; empty = valid.
export function validateBlueprintDraft({ id, name, useCase, template }, blueprintOptions, existingIds) {
  const errors = []
  if (!/^[a-z0-9][a-z0-9-]{1,40}$/.test(String(id || "")))
    errors.push("id must be a lowercase slug (letters, digits, dashes; 2-41 chars).")
  else if (existingIds.includes(id))
    errors.push(`id "${id}" already exists in the blueprint catalog or submission queue.`)
  if (!String(name || "").trim() || String(name).length > 80)
    errors.push("name is required (max 80 chars).")
  if (!String(useCase || "").trim() || String(useCase).length > 200)
    errors.push("description / use case is required (max 200 chars).")
  const t = template
  if (!t || typeof t !== "object" || Array.isArray(t)) {
    errors.push("template must be an object (base template selection or JSON upload).")
    return errors
  }
  const opts = blueprintOptions || {}
  if (!(opts.framework || []).includes(t.framework))
    errors.push(`template.framework must be one of: ${(opts.framework || []).join(", ")}.`)
  if (!(opts.deployTarget || []).includes(t.deployTarget))
    errors.push(`template.deployTarget must be one of: ${(opts.deployTarget || []).join(", ")}.`)
  if (!(opts.protocol || []).includes(t.protocol))
    errors.push(`template.protocol must be one of: ${(opts.protocol || []).join(", ")}.`)
  if (!(opts.memory || []).includes(t.memory))
    errors.push(`template.memory must be one of: ${(opts.memory || []).join(", ")}.`)
  const incompatible = (opts.compatibility || {})[t.framework]?.[t.deployTarget]
  if (t.framework && t.deployTarget && incompatible) errors.push(incompatible)
  for (const k of ["streaming", "identity", "guardrails"])
    if (k in t && typeof t[k] !== "boolean") errors.push(`template.${k} must be a boolean.`)
  return errors
}

// Template source: where the harness code lives. Approvers decide on real
// provenance, so the reference shape is validated — a GitHub source must be a
// public https://github.com/... URL and an S3 source an s3:// URI. Absent or
// "illustrative" is allowed and rendered as such (no code published).
export function validateBlueprintSource(source) {
  if (source == null) return []
  if (typeof source !== "object" || Array.isArray(source))
    return ["source must be an object ({kind, url|uri})."]
  if (source.kind === "illustrative") return []
  if (source.kind === "github")
    return /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/?$/.test(String(source.url || ""))
      ? [] : ["source.url must be a GitHub repository URL (https://github.com/org/repo)."]
  if (source.kind === "s3")
    return /^s3:\/\/[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]\/.+$/.test(String(source.uri || ""))
      ? [] : ["source.uri must be an S3 object URI (s3://bucket/key)."]
  return ['source.kind must be one of: illustrative, github, s3.']
}

export function createSubmission({ id, name, useCase, template, source, submittedBy, submitterName }) {
  const row = {
    id: randomUUID(),
    blueprintId: id, name, useCase, template,
    source: source || { kind: "illustrative" },
    submittedBy, submitterName: submitterName || submittedBy,
    status: "pending_approval",
    decidedBy: null, decidedAt: null,
    submittedAt: new Date().toISOString(),
    history: [historyEntry("submitted", submittedBy)],
  }
  const list = loadSubmissions()
  list.unshift(row)
  saveSubmissions(list)
  return row
}

// Record a BLOCKED decision attempt (self-approval, wrong role reached the
// store somehow) on the row's own audit trail — never a silent 403.
export function recordBlockedSubmissionAttempt(row, action, who, note) {
  const entry = historyEntry(action, who, note)
  const list = loadSubmissions()
  const r = list.find(x => x.id === row.id)
  if (r) { r.history.push(entry); saveSubmissions(list); row.history = r.history }
  return entry
}

// Apply a legitimate decision (role + submitter≠approver guards are checked
// by the caller BEFORE this).
export function decideSubmission(row, decidedBy, decision, note) {
  const list = loadSubmissions()
  const r = list.find(x => x.id === row.id)
  if (!r || r.status !== "pending_approval") return null
  const approve = decision === "approve"
  r.status = approve ? "approved" : "rejected"
  r.decidedBy = decidedBy
  r.decidedAt = new Date().toISOString()
  r.history.push(historyEntry(approve ? "approved" : "rejected", decidedBy, note))
  saveSubmissions(list)
  return r
}

// Approved submissions in catalog-blueprint shape — merged into listBlueprints()
// so approved blueprints appear everywhere the catalog ones do, while pending/
// rejected rows never leave the platform-team surfaces.
export const approvedSubmissionBlueprints = () =>
  loadSubmissions().filter(r => r.status === "approved")
    .map(r => ({ id: r.blueprintId, name: r.name, useCase: r.useCase, template: r.template }))
