import test from "node:test"
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { createServer as createNetServer } from "node:net"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = dirname(fileURLToPath(import.meta.url))

async function freePort() {
  return await new Promise((resolve, reject) => {
    const s = createNetServer()
    s.on("error", reject)
    s.listen(0, "127.0.0.1", () => {
      const port = s.address().port
      s.close(() => resolve(port))
    })
  })
}

async function startConsole(t) {
  const dataDir = mkdtempSync(join(tmpdir(), "console-data-"))
  const port = await freePort()
  assert.notEqual(port, 4000)
  assert.notEqual(port, 4001)

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

test("B4+B5 API: seeds missing projects.json and rejects weaker project guardrails for Admin/Lead/Builder", async t => {
  const { base, dataDir } = await startConsole(t)
  const admin = await login(base, "melanie")
  const lead = await login(base, "carol")
  const builder = await login(base, "alice")

  const projects = await getJson(base, "/projects", admin.token)
  assert.equal(projects.ok, true)
  assert.ok(existsSync(join(dataDir, "projects.json")))
  assert.ok(projects.projects.some(p => p.id === "supportdesk"))

  const seeded = JSON.parse(readFileSync(join(dataDir, "projects.json"), "utf8"))
  assert.equal(seeded.find(p => p.id === "supportdesk").tokenBudget, 16000)

  const orgIds = projects.projects.find(p => p.id === "supportdesk").effectiveGuardrails
    .filter(g => g.source === "org")
    .map(g => g.id)
  assert.deepEqual(orgIds, ["pii-filter", "security-scan-gate"])

  for (const [persona, session] of [["Admin", admin], ["Lead", lead], ["Builder", builder]]) {
    const r = await post(base, "/project-guardrails", session.token, {
      projectId: "supportdesk",
      guardrails: ["tone-review"],
    })
    const body = await r.json()
    assert.equal(r.status, 400, `${persona} weakening attempt should be rejected`)
    assert.ok((body.errors || []).some(e => /org-enforced default.*cannot be removed or weakened/.test(e)), `${persona} error names the org default`)
  }

  const strengthened = await post(base, "/project-guardrails", builder.token, {
    projectId: "supportdesk",
    guardrails: ["pii-filter", "security-scan-gate", "tone-review", "pii-strict"],
  })
  assert.equal(strengthened.status, 200)
  const strengthenedBody = await strengthened.json()
  assert.equal(strengthenedBody.ok, true)

  const detail = await getJson(base, "/project-detail?id=supportdesk", builder.token)
  const effective = detail.project.effectiveGuardrails
  assert.ok(effective.some(g => g.id === "pii-filter" && g.source === "org" && g.pack === "bedrock-baseline"))
  assert.ok(effective.some(g => g.id === "security-scan-gate" && g.source === "org" && g.pack === "bedrock-baseline"))
  assert.ok(effective.some(g => g.id === "pii-strict" && g.source === "project"))
  assert.deepEqual(new Set(effective.map(g => g.source)), new Set(["org", "project"]))
})
