// Unit tests for the G3 generalized grant-request store: SPEC shape, input
// validation, data-driven evidence precondition, idempotent open requests,
// real-time expiry sweep (independent review R-003), and the legacy compat view mapping.
// Run: node --test console/grants.test.mjs
import test from "node:test"
import assert from "node:assert/strict"
import {
  GRANT_REQUESTS, GRANT_RESOURCE_TYPES, GRANT_PRECONDITIONS,
  createGrantRequest, approveGrant, rejectGrant, revokeGrant,
  activeGrant, latestGrantRequest, sweepExpiredGrants,
  legacyGrantView, resourceTypeForKind, grantAuditEntry, setGrantAuditSink,
} from "./grants.mjs"

const reset = () => { GRANT_REQUESTS.length = 0 }
const req = (over = {}) => createGrantRequest({
  resourceType: "tool", resourceId: "web-search", requestedBy: "alice",
  requesterName: "Alice Chen", domain: "customer-support",
  purpose: "agent needs live search", durationS: 3600, ...over,
})

test("creates a SPEC-shaped request", () => {
  reset()
  assert.ok(GRANT_RESOURCE_TYPES.includes("model"))
  const { request } = req({ onBehalfOfProject: "supportdesk" })
  assert.equal(request.resourceType, "tool")
  assert.equal(request.status, "pending")
  assert.equal(request.purpose, "agent needs live search")
  assert.equal(request.onBehalfOfProject, "supportdesk")
  assert.equal(request.evidence, null)
  assert.ok(request.id && request.requestedAt)
  assert.equal(request.decidedBy, null)
})

test("rejects unknown resourceType, missing id, empty purpose, bad duration", () => {
  reset()
  assert.equal(req({ resourceType: "spaceship" }).invalid, "resourceType")
  assert.equal(req({ resourceId: "" }).invalid, "resourceId")
  assert.equal(req({ purpose: "  " }).invalid, "purpose")
  assert.equal(req({ durationS: 0 }).invalid, "duration")
  assert.equal(req({ durationS: 999999999 }).invalid, "duration")
  assert.equal(GRANT_REQUESTS.length, 0)
})

test("evidence precondition is data-driven: toolCredential requires evidence", () => {
  reset()
  assert.ok(GRANT_PRECONDITIONS.toolCredential)
  const missing = req({ resourceType: "toolCredential", resourceId: "zendesk-api-key" })
  assert.equal(missing.invalid, "precondition")
  const withEv = req({ resourceType: "toolCredential", resourceId: "zendesk-api-key", evidence: "eval-run-42" })
  assert.equal(withEv.request.status, "pending")
  assert.equal(withEv.request.evidence, "eval-run-42")
  // types without a precondition need no evidence — the table decides, not code
  assert.ok(req({ resourceType: "memory", resourceId: "m1" }).request)
})

test("open request is idempotent per (user, resource)", () => {
  reset()
  const a = req()
  const b = req()
  assert.equal(b.existing, true)
  assert.equal(a.request.id, b.request.id)
  assert.equal(GRANT_REQUESTS.length, 1)
})

test("approve sets expiry; expired grant flips on sweep and denies on read (R-003)", () => {
  reset()
  const events = []
  setGrantAuditSink(e => events.push(e))
  const { request } = req()
  approveGrant(request, "carol")
  assert.equal(request.decidedBy, "carol")
  assert.ok(activeGrant("alice", "tool", "web-search"))
  request.expiresAt = new Date(Date.now() - 1000).toISOString()
  assert.equal(activeGrant("alice", "tool", "web-search"), null) // sweep runs inside
  assert.equal(request.status, "expired")
  sweepExpiredGrants()
  assert.equal(events.filter(e => e.action === "access-expired").length, 1) // audited exactly once
  setGrantAuditSink(() => {})
})

test("4-eyes floor: the store refuses a self-decided grant at ANY layer (TLP-B4)", () => {
  reset()
  // Domain-layer shape (domain row) — approve and reject both refuse.
  const own = req({ requestedBy: "carol", requesterName: "Carol Diaz" }).request
  assert.throws(() => approveGrant(own, "carol"), /different people/)
  assert.throws(() => rejectGrant(own, "carol"), /different people/)
  assert.equal(own.status, "pending") // refused loudly, nothing recorded
  assert.equal(own.decidedBy, null)
  // Platform-layer shape (escalated row, domain:"platform") — same floor.
  const esc = req({ resourceType: "memory", resourceId: "m-esc", requestedBy: "melanie", requesterName: "Melanie Melli", domain: "platform" }).request
  assert.throws(() => approveGrant(esc, "melanie"), /different people/)
  assert.equal(esc.status, "pending")
  // A DIFFERENT decider still works on both.
  approveGrant(own, "melanie")
  assert.equal(own.status, "approved")
  rejectGrant(esc, "frank")
  assert.equal(esc.status, "rejected")
})

test("legacy view maps resourceType->kind, purpose->justification, rejected->denied", () => {
  reset()
  const { request } = req({ resourceType: "dataScope", resourceId: "supportdesk" })
  rejectGrant(request, "carol")
  const v = legacyGrantView(request)
  assert.equal(v.kind, "dataset")
  assert.equal(v.justification, "agent needs live search")
  assert.equal(v.status, "denied")
  assert.ok(!("evidence" in v))
  assert.equal(resourceTypeForKind("dataset"), "dataScope")
  assert.equal(resourceTypeForKind("memory"), "memory")
  assert.equal(resourceTypeForKind("trace"), "trace")
})

test("revoked grant no longer reads as active; audit entries keep legacy field names", () => {
  reset()
  const { request } = req({ resourceType: "memory", resourceId: "mem-1" })
  approveGrant(request, "carol")
  revokeGrant(request)
  assert.equal(activeGrant("alice", "memory", "mem-1"), null)
  assert.equal(legacyGrantView(request).status, "revoked")
  assert.equal(grantAuditEntry("alice", request, "access-revoked").memoryId, "mem-1")
  const tool = req().request
  assert.equal(grantAuditEntry("alice", tool, "access-requested").resourceId, "web-search")
  assert.ok(latestGrantRequest("alice", "memory", "mem-1"))
})
