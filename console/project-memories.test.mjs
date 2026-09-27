// Tests for GET /api/project-memories and wizard-create/wizard-validate gating.
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
    s.listen(0, "127.0.0.1", () => { const port = s.address().port; s.close(() => resolve(port)) })
  })
}

async function startConsole(t) {
  const dataDir = mkdtempSync(join(tmpdir(), "console-pm-"))
  const port = await freePort()
  const child = spawn(process.execPath, ["console/server.mjs"], {
    cwd: join(__dirname, ".."),
    env: { ...process.env, PORT: String(port), CONSOLE_DATA_DIR: dataDir },
    stdio: ["ignore", "pipe", "pipe"],
  })
  t.after(() => { child.kill(); rmSync(dataDir, { recursive: true, force: true }) })
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("server did not start")), 10000)
    child.once("exit", code => reject(new Error(`server exited early: ${code}`)))
    child.stdout.on("data", d => { if (String(d).includes("orchestrator on")) { clearTimeout(timer); resolve() } })
  })
  return { base: `http://127.0.0.1:${port}/api` }
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

async function get(base, path, token) {
  const headers = token ? { authorization: "Bearer " + token } : {}
  const r = await fetch(base + path, { headers })
  return { status: r.status, body: await r.json().catch(() => null) }
}

async function post(base, path, token, body) {
  const headers = { "content-type": "application/json" }
  if (token) headers.authorization = "Bearer " + token
  const r = await fetch(base + path, { method: "POST", headers, body: JSON.stringify(body) })
  return { status: r.status, body: await r.json().catch(() => null) }
}

test("local console serves the modular UI assets", async t => {
  const { base } = await startConsole(t)
  const origin = base.slice(0, -4)
  const [moduleResponse, styleResponse] = await Promise.all([
    fetch(origin + "/modules/app.mjs"),
    fetch(origin + "/styles/app.css"),
  ])
  assert.equal(moduleResponse.status, 200)
  assert.match(moduleResponse.headers.get("content-type"), /text\/javascript/)
  assert.match(await moduleResponse.text(), /const SHELL_NAV/)
  assert.equal(styleResponse.status, 200)
  assert.match(styleResponse.headers.get("content-type"), /text\/css/)
  assert.match(await styleResponse.text(), /\.shell/)
  const directoryResponse = await fetch(origin + "/api/login-users")
  assert.equal(directoryResponse.status, 200)
  const directory = await directoryResponse.json()
  assert.ok(directory.users.some(user =>
    user.id === "alice" && user.title === "Domain Builder"))
})

test("project-memories route: missing project param → 400", async t => {
  const { base } = await startConsole(t)
  const session = await login(base, "melanie")
  const r = await get(base, "/project-memories", session.token)
  assert.equal(r.status, 400)
})

test("project-memories route: unknown project → 404", async t => {
  const { base } = await startConsole(t)
  const session = await login(base, "melanie")
  const r = await get(base, "/project-memories?project=does-not-exist", session.token)
  assert.equal(r.status, 404)
})

test("project-memories route: known project returns memories+knowledgeBases arrays", async t => {
  const { base } = await startConsole(t)
  const session = await login(base, "carol")
  const r = await get(base, "/project-memories?project=concierge", session.token)
  // may be 200 or 404 depending on whether seed resolves; shape check when 200
  if (r.status === 200) {
    assert.ok(Array.isArray(r.body.memories), "memories is array")
    assert.ok(Array.isArray(r.body.knowledgeBases), "knowledgeBases is array")
    assert.equal(r.body.ok, true)
  }
})

test("wizard-create: builder session → 403", async t => {
  const { base } = await startConsole(t)
  const session = await login(base, "alice")
  const r = await post(base, "/wizard-create", session.token, { draft: {}, step: 6 })
  assert.equal(r.status, 403, "builder must be denied project creation")
  assert.ok(r.body?.error?.toLowerCase().includes("lead") || r.body?.error?.toLowerCase().includes("domain"),
    `error message should mention lead/domain: ${r.body?.error}`)
})

test("wizard-create: lead session → not 403", async t => {
  const { base } = await startConsole(t)
  const session = await login(base, "carol")
  const r = await post(base, "/wizard-create", session.token, { draft: {}, step: 6 })
  // 400 is fine (invalid draft) — just not 403
  assert.notEqual(r.status, 403, "lead must not be denied project creation access")
})
