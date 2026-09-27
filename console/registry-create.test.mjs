import test from "node:test"
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { createServer as createNetServer } from "node:net"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = dirname(fileURLToPath(import.meta.url))

function freePort() {
  return new Promise(resolve => {
    const s = createNetServer()
    s.listen(0, "127.0.0.1", () => {
      const port = s.address().port
      s.close(() => resolve(port))
    })
  })
}

async function startConsole(t) {
  const dataDir = mkdtempSync(join(tmpdir(), "console-reg-create-"))
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

test("registry-create: GET /api/registry contains catalog-approved Model entries and no unapproved ones", async t => {
  const { base } = await startConsole(t)
  const { token } = await login(base, "melanie")
  const r = await getJson(base, "/registry", token)
  const models = (r.entries || []).filter(e => e.type === "Model")
  // catalog.json has 7 approved models — all should appear
  assert.ok(models.length > 0, `Expected catalog-approved Model entries but found none`)
  // every returned Model must be APPROVED (not gateway-discovered without approval)
  for (const m of models) {
    const versions = m.versions || []
    const hasApproved = versions.some(v => v.status === "APPROVED")
    assert.ok(hasApproved, `Model ${m.id} must have at least one APPROVED version but got: ${JSON.stringify(versions.map(v => v.status))}`)
  }
})

test("registry-create: end user role gets 403 on POST /api/registry-create", async t => {
  const { base } = await startConsole(t)
  const { token } = await login(base, "enduser")
  const r = await post(base, "/registry-create", token, {
    type: "A2AAgent",
    name: "test-agent",
    content: JSON.stringify({ name: "Test Agent", url: "https://example.com/agent" }),
  })
  assert.equal(r.status, 403)
})

test("registry-create: bad name rejected with validation error", async t => {
  const { base } = await startConsole(t)
  const { token } = await login(base, "melanie")
  const r = await post(base, "/registry-create", token, {
    type: "A2AAgent",
    name: "Invalid Name!",
    content: JSON.stringify({ name: "Test", url: "https://example.com" }),
  })
  const body = await r.json()
  assert.equal(body.ok, false)
  assert.match(body.error || "", /name must match/)
})

test("registry-create: bad JSON card rejected", async t => {
  const { base } = await startConsole(t)
  const { token } = await login(base, "melanie")
  const r = await post(base, "/registry-create", token, {
    type: "A2AAgent",
    name: "my-agent",
    content: "not json",
  })
  const body = await r.json()
  assert.equal(body.ok, false)
  assert.match(body.error || "", /JSON|json/)
})

test("registry-create: admin creates A2A agent draft and it appears in GET /api/registry", async t => {
  const { base } = await startConsole(t)
  const { token } = await login(base, "melanie")
  const id = `test-a2a-agent-${Math.random().toString(36).slice(2, 8)}`
  const r = await post(base, "/registry-create", token, {
    type: "A2AAgent",
    name: id,
    displayName: "Test A2A Agent",
    description: "A test agent",
    content: JSON.stringify({ name: "Test A2A Agent", url: "https://example.com/agent" }),
  })
  const body = await r.json()
  assert.equal(body.ok, true, `Create failed: ${body.error}`)
  assert.equal(body.entry.id, id)
  const reg = await getJson(base, "/registry", token)
  const found = (reg.entries || []).find(e => e.id === id)
  assert.ok(found, "Created entry should appear in registry list")
  assert.equal(found.type, "A2AAgent")
})

test("registry-create: admin creates and approves — entry is APPROVED in registry", async t => {
  const { base } = await startConsole(t)
  const { token } = await login(base, "melanie")
  const id = `test-skill-${Math.random().toString(36).slice(2, 8)}`
  const r = await post(base, "/registry-create", token, {
    type: "Skill",
    name: id,
    displayName: "Test Skill",
    content: "## Test Skill\nDoes things.",
    andApprove: true,
  })
  const body = await r.json()
  assert.equal(body.ok, true, `Create+approve failed: ${body.error}`)
  assert.equal(body.approved, true)
  const reg = await getJson(base, "/registry", token)
  const found = (reg.entries || []).find(e => e.id === id)
  assert.ok(found, "Entry should appear in registry after create+approve")
  const status = (found.resolved || found.versions?.[0] || {}).status
  assert.equal(status, "APPROVED")
})

test("registry-create: oversize content rejected", async t => {
  const { base } = await startConsole(t)
  const { token } = await login(base, "melanie")
  const r = await post(base, "/registry-create", token, {
    type: "Skill",
    name: "fat-skill",
    content: "x".repeat(65537),
  })
  const body = await r.json()
  assert.equal(body.ok, false)
  assert.match(body.error || "", /64KB|65536/)
})
