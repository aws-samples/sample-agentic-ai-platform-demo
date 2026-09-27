import test from "node:test"
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { createServer as createNetServer } from "node:net"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = dirname(fileURLToPath(import.meta.url))

async function freePort() {
  return new Promise((resolve, reject) => {
    const s = createNetServer()
    s.on("error", reject)
    s.listen(0, "127.0.0.1", () => {
      const port = s.address().port
      s.close(() => resolve(port))
    })
  })
}

async function startConsole(t) {
  const dataDir = mkdtempSync(join(tmpdir(), "console-fb-"))
  const port = await freePort()
  const child = spawn(process.execPath, ["console/server.mjs"], {
    cwd: join(__dirname, ".."),
    env: { ...process.env, PORT: String(port), CONSOLE_DATA_DIR: dataDir },
    stdio: ["ignore", "pipe", "pipe"],
  })
  t.after(() => {
    child.kill()
    rmSync(dataDir, { recursive: true, force: true })
  })
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("console server did not start")), 10000)
    child.once("exit", code => reject(new Error(`console server exited early: ${code}`)))
    child.stdout.on("data", d => {
      if (String(d).includes("orchestrator on")) {
        clearTimeout(timer)
        resolve()
      }
    })
  })
  return { base: `http://127.0.0.1:${port}/api`, dataDir }
}

async function login(base, user) {
  const r = await fetch(base + "/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ user, idp: "okta" }),
  })
  assert.equal(r.status, 200)
  return await r.json()
}

const post = (base, path, token, body) => fetch(base + path, {
  method: "POST",
  headers: { "content-type": "application/json", authorization: "Bearer " + token },
  body: JSON.stringify(body),
})

const getJson = async (base, path, token) => {
  const r = await fetch(base + path, { headers: { authorization: "Bearer " + token } })
  assert.equal(r.status, 200)
  return await r.json()
}

// ---- validation: bad rating ----
test("fleet-feedback: bad rating rejected with 400", async t => {
  const { base } = await startConsole(t)
  const session = await login(base, "melanie")
  const r = await post(base, "/fleet-feedback", session.token, {
    project: "supportdesk", sessionId: "sess-1", turnIndex: 0, rating: "meh",
  })
  assert.equal(r.status, 400)
  const body = await r.json()
  assert.equal(body.ok, false)
  assert.ok(/up.*down|down.*up|must be/.test(body.error), `expected rating error, got: ${body.error}`)
})

// ---- validation: oversize comment rejected ----
test("fleet-feedback: comment over 2048 chars rejected with 400", async t => {
  const { base } = await startConsole(t)
  const session = await login(base, "melanie")
  const r = await post(base, "/fleet-feedback", session.token, {
    project: "supportdesk", sessionId: "sess-1", turnIndex: 0, rating: "up",
    comment: "x".repeat(2049),
  })
  assert.equal(r.status, 400)
  const body = await r.json()
  assert.equal(body.ok, false)
  assert.ok(/2048/.test(body.error), `expected length error, got: ${body.error}`)
})

// ---- validation: unknown project rejected ----
test("fleet-feedback: unknown project rejected (404 or guardProject)", async t => {
  const { base } = await startConsole(t)
  const session = await login(base, "alice")
  // alice is scoped to customer-support — platform-assistant is a platform project
  const r = await post(base, "/fleet-feedback", session.token, {
    project: "platform-assistant", sessionId: "sess-1", turnIndex: 0, rating: "up",
  })
  // guardProject returns 404 for foreign projects to scoped sessions
  assert.ok([403, 404].includes(r.status), `expected 403 or 404 for foreign project, got ${r.status}`)
})

// ---- unauthenticated request rejected ----
test("fleet-feedback: unauthenticated request rejected with 401", async t => {
  const { base } = await startConsole(t)
  const r = await post(base, "/fleet-feedback", "invalid-token", {
    project: "supportdesk", sessionId: "sess-1", turnIndex: 0, rating: "up",
  })
  assert.equal(r.status, 401)
  const body = await r.json()
  assert.equal(body.ok, false)
})

// ---- ledger append with correct response shape ----
test("fleet-feedback: response has correct shape when entry is accepted", async t => {
  const { base } = await startConsole(t)
  const session = await login(base, "melanie")
  const r = await post(base, "/fleet-feedback", session.token, {
    project: "supportdesk", sessionId: "sess-abc", turnIndex: 2, rating: "down",
    comment: "not helpful",
  })
  assert.equal(r.status, 200)
  const body = await r.json()
  assert.equal(body.ok, true)
  assert.ok(typeof body.id === "string" && body.id.length > 0, "response includes id")
  assert.ok(["cloudwatch", "unavailable"].includes(body.observability), "observability field present")
})

// ---- end user (user bundle) can submit feedback ----
test("fleet-feedback: end-user session can submit feedback", async t => {
  const { base } = await startConsole(t)
  const session = await login(base, "enduser")
  const r = await post(base, "/fleet-feedback", session.token, {
    project: "supportdesk", sessionId: "sess-eu", turnIndex: 0, rating: "up",
  })
  assert.equal(r.status, 200)
  const body = await r.json()
  assert.equal(body.ok, true)
})

// ---- obs-traces: feedback-ledger feedback is read back via obs-traces ----
// This test verifies that:
//  (a) obs-traces does not crash when the feedback ledger contains entries
//  (b) the simulated fallback still works (no real usage entries in a fresh server)
//  (c) the locked response shape is correct for a session without access
test("obs-traces: route returns valid shape and handles feedback ledger gracefully", async t => {
  const { base } = await startConsole(t)
  const carol = await login(base, "carol")

  // First submit feedback so the feedback-ledger is non-empty
  const fbR = await post(base, "/fleet-feedback", carol.token, {
    project: "supportdesk", sessionId: "sess-shape-test", turnIndex: 0, rating: "up",
  })
  assert.equal(fbR.status, 200)
  const fbBody = await fbR.json()
  assert.equal(fbBody.ok, true)

  // Now read obs-traces — carol owns the customer-support content plane
  const r = await fetch(base + "/obs-traces?agent=supportdesk", {
    headers: { authorization: "Bearer " + carol.token },
  })
  assert.equal(r.status, 200)
  const body = await r.json()
  assert.equal(body.ok, true)

  if (body.locked) {
    // Access gated but route did not crash — the locked shape is valid
    assert.ok(body.reason, "locked response has reason")
    return
  }

  // When access is granted, traces array must be present
  assert.ok(Array.isArray(body.traces), "traces is an array")
  // simulated flag must be a boolean
  assert.ok(typeof body.simulated === "boolean", "simulated is a boolean")
  // Every trace has required fields
  for (const tr of body.traces) {
    assert.ok(typeof tr.traceId === "string", "trace has traceId")
    assert.ok(typeof tr.sessionId === "string", "trace has sessionId")
    assert.ok(typeof tr.input === "string", "trace has input")
    assert.ok(typeof tr.output === "string", "trace has output")
    // If feedback is present it must have a valid rating
    if (tr.feedback) {
      assert.ok(["up", "down"].includes(tr.feedback.rating), "feedback rating is valid")
    }
  }
})
