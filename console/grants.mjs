// G3 (governance-foundation): ONE generalized grant-request object for every
// elevated-access flow — trace/memory content, tool + tool-credential use, and
// data scopes. Decision record: agent.md (current ownership and authorization contract).
// The former ACCESS_REQUESTS (trace/memory/dataset) live on THIS store now; the
// legacy /api/obs-access-* endpoints read it through legacyGrantView (compat
// read path), so one queue and one audit trail serve both old and new callers.
// The store is in-memory like SESSIONS by design: a restart clears runtime
// grant state, never the audit trail.
import { randomUUID } from "node:crypto"

// TLP-B1 additions: "kb" (Knowledge-Base document content — platform sessions
// need an owning-lead grant to read cross-plane KB full text, spec §8) and
// "registryUse" (use-approval for access:"restricted" AI Registry entries —
// escalates to the platform per spec §9, never decided inside a domain). The
// LLM Gateway slice adds "model" for time-boxed domain access to restricted
// inference targets.
export const GRANT_RESOURCE_TYPES = ["trace", "memory", "tool", "toolCredential", "dataScope", "kb", "registryUse", "model"]
export const GRANT_MAX_S = 24 * 3600

// Legacy "kind" vocabulary (obs-access era) <-> SPEC resourceType.
const TYPE_TO_KIND = { trace: "trace", memory: "memory", dataScope: "dataset", kb: "kb", registryUse: "registryUse", model: "model" }
export const resourceTypeForKind = kind =>
  kind === "memory" ? "memory" : kind === "dataset" ? "dataScope" : kind === "kb" ? "kb" : kind === "registryUse" ? "registryUse" : kind === "model" ? "model" : "trace"

// Evidence-gate: a DATA-DRIVEN precondition per grant type — the check below
// reads this table, nothing is hard-coded per type. Adding/removing a
// precondition is an edit here, not new code. toolCredential is the shipped
// default: handing an agent a credential needs a reference to supporting
// evidence (eval run, approval ticket) before the owner even sees the request.
export const GRANT_PRECONDITIONS = {
  toolCredential: {
    field: "evidence",
    message: "Tool-credential grants require evidence (an eval run or approval reference) before they can be requested.",
  },
}

// SPEC status vocabulary: pending|approved|rejected|expired. "revoked" is kept
// as a deliberate extension — revocation has teeth (T11) and is audited; folding
// it into "expired" would erase who cut the grant short.
export const GRANT_REQUESTS = []

// Expiry sweep audits through this sink (server wires appendObsAudit in).
let auditSink = () => {}
export function setGrantAuditSink(fn) { auditSink = fn }

// Audit entries keep the exact legacy field names per kind (who/kind/memoryId/
// project/agentId) — smokes and the obs-audit UI assert them. New types carry
// a generic resourceId.
// CONTRACT (R-014): `purpose` is user free text and is INTENTIONALLY NOT
// written into audit entries — the audit trail stays PII-clean by design, not
// by luck. If purpose context is ever needed on an audit row, it must pass
// through maskPII first (see the break-glass read in server.mjs).
export const grantAuditEntry = (who, r, action) => ({
  who,
  kind: TYPE_TO_KIND[r.resourceType] || r.resourceType,
  ...(r.resourceType === "memory" ? { memoryId: r.resourceId }
    : r.resourceType === "dataScope" ? { project: r.resourceId }
    : r.resourceType === "trace" ? { agentId: r.resourceId }
    : { resourceId: r.resourceId }),
  // G9: audit rows carry the owning domain so the unified Audit page can scope
  // them per-session (additive — no consumer asserted its absence).
  ...(r.domain ? { domain: r.domain } : {}),
  action, requestId: r.id, timestamp: new Date().toISOString(),
})

// Flip any approved-but-lapsed grant to expired exactly once (status change
// guards double-audit). Runs on every read path so expiry is enforced in real
// time (independent review R-003), never only at grant time.
export function sweepExpiredGrants() {
  for (const r of GRANT_REQUESTS) {
    if (r.status === "approved" && Date.now() > Date.parse(r.expiresAt)) {
      r.status = "expired"
      auditSink(grantAuditEntry(r.requestedBy, r, "access-expired"))
    }
  }
}

// Active grant for (user, resourceType, resource) — or null. Sweep first so a
// lapsed grant is denied on the very request that replays it.
export function activeGrant(user, resourceType, resourceId) {
  sweepExpiredGrants()
  return GRANT_REQUESTS.find(r => r.requestedBy === user && r.resourceType === resourceType && r.resourceId === resourceId && r.status === "approved") || null
}

// Latest request (any status) by this user for a resource — locked-state UIs
// render pending / denied / expired from it instead of a blank form.
export const latestGrantRequest = (user, resourceType, resourceId) =>
  GRANT_REQUESTS.find(r => r.requestedBy === user && r.resourceType === resourceType && r.resourceId === resourceId) || null

// Validate + insert a request. Authorization and domain scoping stay in the
// server routes (they need the session and resource lookups); this owns the
// SPEC shape. Returns { invalid, message } on bad input — the caller maps
// `invalid` codes to endpoint-appropriate wording — or { request, existing }.
export function createGrantRequest({ resourceType, resourceId, requestedBy, requesterName, onBehalfOfProject, domain, originDomain, purpose, durationS, evidence }) {
  if (!GRANT_RESOURCE_TYPES.includes(resourceType))
    return { invalid: "resourceType", message: `resourceType must be one of ${GRANT_RESOURCE_TYPES.join(", ")}.` }
  if (!resourceId) return { invalid: "resourceId", message: "resourceId is required." }
  const why = String(purpose || "").trim()
  if (!why) return { invalid: "purpose", message: "A purpose is required — the resource owner reviews it before granting access." }
  const dur = Math.floor(Number(durationS))
  if (!Number.isFinite(dur) || dur < 1 || dur > GRANT_MAX_S)
    return { invalid: "duration", message: `durationS must be 1..${GRANT_MAX_S} seconds.` }
  const pre = GRANT_PRECONDITIONS[resourceType]
  if (pre && !evidence) return { invalid: "precondition", message: pre.message }
  // Idempotent per (user, resource): an open request is returned, not duplicated.
  const open = latestGrantRequest(requestedBy, resourceType, resourceId)
  if (open && open.status === "pending") return { request: open, existing: true }
  const request = {
    id: randomUUID(), resourceType, resourceId,
    requestedBy, requesterName: requesterName || requestedBy,
    onBehalfOfProject: String(onBehalfOfProject || "").trim() || null,
    domain: domain ?? null,
    // TLP-B3 §6.4: the requester's HOME domain at request time. When a request
    // escalates (domain:"platform" — restricted-entry use, single-lead
    // break-glass), the origin domain's console tracks its status READ-ONLY;
    // the deciding queue stays keyed on `domain` alone.
    originDomain: originDomain ?? domain ?? null,
    purpose: why, durationS: dur, evidence: evidence ?? null,
    status: "pending", requestedAt: new Date().toISOString(),
    decidedBy: null, decidedAt: null, expiresAt: null,
  }
  GRANT_REQUESTS.unshift(request)
  return { request }
}

// TLP-B4 (4-eyes): requester ≠ approver is answered with a 403 in every decide
// route (domain-lead layer AND platform decideBreakGlass layer). This store-
// level guard makes the invariant unbypassable — a future decide path that
// forgets the route check fails loudly here instead of silently recording a
// self-approved grant.
function assertFourEyes(r, decidedBy) {
  if (decidedBy === r.requestedBy)
    throw new Error("Requester and approver must be different people — refusing to record a self-decided grant.")
}

export function approveGrant(r, decidedBy) {
  assertFourEyes(r, decidedBy)
  r.status = "approved"
  r.decidedBy = decidedBy
  r.decidedAt = new Date().toISOString()
  r.expiresAt = new Date(Date.now() + r.durationS * 1000).toISOString()
}

export function rejectGrant(r, decidedBy) {
  assertFourEyes(r, decidedBy)
  r.status = "rejected"
  r.decidedBy = decidedBy
  r.decidedAt = new Date().toISOString()
}

export function revokeGrant(r) { r.status = "revoked" }

// Compat read path: the pre-G3 ACCESS_REQUESTS field names the existing UI and
// smokes consume (kind/justification, "denied"). Never exposes evidence — the
// legacy surfaces never carried it.
export const legacyGrantView = r => ({
  id: r.id,
  kind: TYPE_TO_KIND[r.resourceType] || r.resourceType,
  resourceId: r.resourceId,
  requestedBy: r.requestedBy, requesterName: r.requesterName, domain: r.domain,
  justification: r.purpose, durationS: r.durationS,
  status: r.status === "rejected" ? "denied" : r.status,
  requestedAt: r.requestedAt, decidedBy: r.decidedBy, decidedAt: r.decidedAt, expiresAt: r.expiresAt,
})
