// TLP-B4: two-layer (4-eyes) guardrail-EXEMPTION store. A domain lead (or a
// platform admin acting for a domain) asks to exempt ONE project from ONE
// domain-enforced guardrail. Two DISTINCT human decision points:
//   requested -> pending_domain   (layer 1: a domain lead who is NOT the
//                                  requester; a single-lead domain escalates
//                                  layer 1 to the platform peers — the same
//                                  TLP-B1/B3 break-glass escalation pattern)
//             -> pending_platform (layer 2: a platform admin who is neither
//                                  the requester nor the layer-1 decider)
//             -> applied          (ONLY here does the exemption take effect)
// Either layer can reject -> rejected_domain / rejected_platform.
// Org-enforced guardrails are NEVER exemptable — those requests are refused
// before a row exists (server route). Every state change AND every blocked
// decision attempt lands in the row's history[] audit array. Persisted in a
// console-local JSON store (gitignored, like the other B3 stores).
import { randomUUID } from "node:crypto"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

const STORE_PATH = join(dirname(fileURLToPath(import.meta.url)), "policy-exemptions.json")

export const EXEMPTION_STATUSES = ["pending_domain", "pending_platform", "applied", "rejected_domain", "rejected_platform", "expired", "revoked"]

// TLP-B6 (booked P2, B4 signoff §4): applied exemptions are no longer
// permanent. Layer-2 approval stamps an expiresAt (approver-chosen TTL or
// this default), and an applied exemption can be revoked by the same roles
// that approve. Both endings restore the guardrail to the project harness.
export const DEFAULT_EXEMPTION_TTL_DAYS = 30

export function loadExemptions() {
  if (!existsSync(STORE_PATH)) return []
  try { return JSON.parse(readFileSync(STORE_PATH, "utf8")) } catch { return [] }
}
export function saveExemptions(list) { writeFileSync(STORE_PATH, JSON.stringify(list, null, 2)) }

const historyEntry = (action, who, note) => ({
  action, who, at: new Date().toISOString(), ...(note ? { note } : {}),
})

// Idempotent per (project, guardrail): one open request at a time.
export const openExemption = (list, project, guardrail) =>
  list.find(r => r.project === project && r.guardrail === guardrail &&
    (r.status === "pending_domain" || r.status === "pending_platform")) || null

// layer1Queue: 'domain' when the owning domain has at least one lead who is
// not the requester; otherwise 'platform' (single-lead escalation).
export function createExemption({ project, domain, guardrail, requestedBy, requesterName, reason, layer1Queue }) {
  const row = {
    id: randomUUID(), project, domain, guardrail,
    requestedBy, requesterName: requesterName || requestedBy,
    reason: String(reason).trim(),
    layer1Queue,
    status: "pending_domain",
    layer1DecidedBy: null, layer1DecidedAt: null,
    layer2DecidedBy: null, layer2DecidedAt: null,
    requestedAt: new Date().toISOString(),
    history: [historyEntry("requested", requestedBy,
      layer1Queue === "platform" ? "single-lead domain — layer 1 escalated to platform peers" : undefined)],
  }
  const list = loadExemptions()
  list.unshift(row)
  saveExemptions(list)
  return row
}

// Record a BLOCKED decision attempt on the row's own audit trail (never a
// silent 403) and persist. Returns the history entry for the obs-audit sink.
export function recordBlockedAttempt(row, action, who, note) {
  const entry = historyEntry(action, who, note)
  const list = loadExemptions()
  const r = list.find(x => x.id === row.id)
  if (r) { r.history.push(entry); saveExemptions(list); row.history = r.history }
  return entry
}

// Apply a legitimate layer decision (eligibility + 4-eyes guards are checked
// by the caller BEFORE this). layer is inferred from status. ttlDays applies
// only when layer 2 approves: the exemption gets an expiresAt stamp (TLP-B6 —
// approved exemptions are time-boxed, never permanent).
export function applyDecision(row, decidedBy, decision, note, ttlDays) {
  const list = loadExemptions()
  const r = list.find(x => x.id === row.id)
  if (!r) return null
  const approve = decision === "approve"
  if (r.status === "pending_domain") {
    r.status = approve ? "pending_platform" : "rejected_domain"
    r.layer1DecidedBy = decidedBy
    r.layer1DecidedAt = new Date().toISOString()
    r.history.push(historyEntry(approve ? "layer1-approved" : "layer1-rejected", decidedBy, note))
  } else if (r.status === "pending_platform") {
    r.status = approve ? "applied" : "rejected_platform"
    r.layer2DecidedBy = decidedBy
    r.layer2DecidedAt = new Date().toISOString()
    if (approve) {
      const days = Number.isFinite(ttlDays) && ttlDays > 0 ? ttlDays : DEFAULT_EXEMPTION_TTL_DAYS
      r.expiresAt = new Date(Date.now() + days * 86400000).toISOString()
      r.history.push(historyEntry("layer2-approved-applied", decidedBy,
        (note ? note + " · " : "") + `expires ${r.expiresAt} (${days}d TTL)`))
    } else {
      r.history.push(historyEntry("layer2-rejected", decidedBy, note))
    }
  }
  saveExemptions(list)
  return r
}

// TLP-B6: revoke an APPLIED exemption. Caller checks eligibility (the same
// roles that approve) and reverses the harness effect; this only records the
// state change + audit entry. Self-service revoke of one's own exemption is
// ALLOWED — but never invisible: the history entry + obs-audit row name the
// revoker, so governance visibility is preserved.
export function revokeExemption(row, revokedBy, note) {
  const list = loadExemptions()
  const r = list.find(x => x.id === row.id)
  if (!r || r.status !== "applied") return null
  r.status = "revoked"
  r.revokedBy = revokedBy
  r.revokedAt = new Date().toISOString()
  r.history.push(historyEntry("revoked", revokedBy, note))
  saveExemptions(list)
  return r
}

// TLP-B6: expiry is honored at READ time, like grant expiry (never only at
// approval). Transitions every applied row past its expiresAt to `expired`
// and returns the newly-expired rows so the caller can reverse the harness
// effect for each. Rows without expiresAt (pre-B6 approvals) get the default
// TTL measured from layer-2 approval time.
export function expireDueExemptions(now = Date.now()) {
  const list = loadExemptions()
  const due = []
  for (const r of list) {
    if (r.status !== "applied") continue
    const expiresAt = r.expiresAt ||
      new Date(new Date(r.layer2DecidedAt || r.requestedAt).getTime() + DEFAULT_EXEMPTION_TTL_DAYS * 86400000).toISOString()
    if (new Date(expiresAt).getTime() > now) continue
    r.status = "expired"
    r.expiresAt = expiresAt
    r.expiredAt = new Date(now).toISOString()
    r.history.push(historyEntry("expired", "system", `TTL reached (${expiresAt})`))
    due.push(r)
  }
  if (due.length) saveExemptions(list)
  return due
}
