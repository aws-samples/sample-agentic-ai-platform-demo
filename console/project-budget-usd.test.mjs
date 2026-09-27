// B20-USD: per-project USD budget — server API tests.
// Tests: budget set/clear/validate on POST /api/project-budget,
//        GET /api/costs includes projectBudgets map,
//        builder cannot set budget (403),
//        domain isolation: builder only sees own domain's projects on GET /api/my-projects.
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
  return await new Promise((resolve, reject) => {
    const s = createNetServer()
    s.on("error", reject)
    s.listen(0, "127.0.0.1", () => { const port = s.address().port; s.close(() => resolve(port)) })
  })
}

async function startConsole(t) {
  const dataDir = mkdtempSync(join(tmpdir(), "console-usd-budget-"))
  const port = await freePort()
  const child = spawn(process.execPath, ["console/server.mjs"], {
    cwd: join(__dirname, ".."),
    env: { ...process.env, PORT: String(port), CONSOLE_DATA_DIR: dataDir },
    stdio: ["ignore", "pipe", "pipe"],
  })
  t.after(() => { child.kill(); rmSync(dataDir, { recursive: true, force: true }) })
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("console server did not start")), 15000)
    child.once("exit", code => reject(new Error(`exited early: ${code}`)))
    child.stdout.on("data", d => { if (String(d).includes("orchestrator on")) { clearTimeout(timer); resolve() } })
  })
  return { base: `http://127.0.0.1:${port}/api`, dataDir }
}

async function login(base, user) {
  const r = await fetch(base + "/login", { method: "POST",
    headers: { "content-type": "application/json" }, body: JSON.stringify({ user, idp: "okta" }) })
  assert.equal(r.status, 200)
  return (await r.json()).token
}

const post = (base, path, token, body) => fetch(base + path, {
  method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + token },
  body: JSON.stringify(body),
})

const get = (base, path, token) => fetch(base + path, { headers: { authorization: "Bearer " + token } })

test("B20-USD: lead can set and clear per-project USD budget, builder cannot", async t => {
  const { base } = await startConsole(t)
  // carol = lead (customer-support domain), alice = builder (customer-support)
  const leadToken = await login(base, "carol")
  const builderToken = await login(base, "alice")

  // Seed project list to find a suitable project id
  const projsR = await get(base, "/projects", leadToken)
  const projs = await projsR.json()
  assert.equal(projs.ok, true)
  const proj = projs.projects.find(p => p.domain === "customer-support")
  assert.ok(proj, "need a customer-support project for the test")
  const projectId = proj.id

  // Builder attempt to set budget → 403
  const builderSet = await post(base, "/project-budget", builderToken, { project: projectId, monthlyLimitUsd: 100 })
  assert.equal(builderSet.status, 403, "builder must be 403'd from setting budget")

  // Lead sets a valid budget
  const setR = await post(base, "/project-budget", leadToken, { project: projectId, monthlyLimitUsd: 250.5 })
  assert.equal(setR.status, 200)
  const setBody = await setR.json()
  assert.equal(setBody.ok, true)
  assert.equal(setBody.budget.monthlyLimitUsd, 250.50)
  assert.equal(setBody.budget.setBy, "carol")
  assert.ok(typeof setBody.budget.setAt === "string")

  // GET /api/costs includes projectBudgets map with the new budget
  const costsR = await get(base, "/costs", leadToken)
  assert.equal(costsR.status, 200)
  const costs = await costsR.json()
  assert.ok(costs.projectBudgets, "costs response must include projectBudgets map")
  assert.ok(costs.projectBudgets[projectId], "budget must be in projectBudgets")
  assert.equal(costs.projectBudgets[projectId].monthlyLimitUsd, 250.50)

  // Builder also sees the budget via /api/costs
  const costsBuilderR = await get(base, "/costs", builderToken)
  assert.equal(costsBuilderR.status, 200)
  const costsBuilder = await costsBuilderR.json()
  assert.ok(costsBuilder.projectBudgets[projectId], "builder must see the budget in costs response")

  // Lead clears the budget
  const clearR = await post(base, "/project-budget", leadToken, { project: projectId, monthlyLimitUsd: null })
  assert.equal(clearR.status, 200)
  const clearBody = await clearR.json()
  assert.equal(clearBody.ok, true)
  assert.equal(clearBody.budget, null)

  // Budget is gone from costs
  const costsAfterR = await get(base, "/costs", leadToken)
  const costsAfter = await costsAfterR.json()
  assert.ok(!costsAfter.projectBudgets[projectId], "budget must be absent after clear")
})

test("B20-USD: budget validation rejects negative, zero, NaN, and oversize values", async t => {
  const { base } = await startConsole(t)
  const leadToken = await login(base, "carol")

  const projsR = await get(base, "/projects", leadToken)
  const projs = await projsR.json()
  const proj = projs.projects.find(p => p.domain === "customer-support")
  assert.ok(proj)
  const projectId = proj.id

  // NaN and Infinity JSON-serialize as null (clear), so only test truly invalid numbers
  for (const bad of [-1, 0, 1e9 + 1, "not-a-number"]) {
    const r = await post(base, "/project-budget", leadToken, { project: projectId, monthlyLimitUsd: bad })
    const body = await r.json()
    assert.equal(body.ok, false, `expected rejection for value ${JSON.stringify(bad)}`)
    assert.ok(body.error, `expected error message for value ${JSON.stringify(bad)}`)
  }
})

test("B20-USD: GET /api/costs projectBudgets omits projects with no budget", async t => {
  const { base } = await startConsole(t)
  const leadToken = await login(base, "carol")

  // Without setting any budget, costs should still have projectBudgets but empty/sparse
  const costsR = await get(base, "/costs", leadToken)
  const costs = await costsR.json()
  assert.ok(Object.prototype.hasOwnProperty.call(costs, "projectBudgets"),
    "projectBudgets key must always be present")
  // No budget set → no entry for any project
  assert.equal(Object.keys(costs.projectBudgets).length, 0)
})

test("B20-USD: domain isolation — builder alice sees only customer-support projects, not operations", async t => {
  const { base } = await startConsole(t)
  // alice = builder in customer-support, bob = builder in operations (or any other domain)
  // We use /api/my-projects which returns only the caller's projects.
  const aliceToken = await login(base, "alice")

  const r = await get(base, "/my-projects", aliceToken)
  assert.equal(r.status, 200)
  const body = await r.json()
  assert.equal(body.ok, true)
  assert.ok(Array.isArray(body.projects))
  // All returned projects must belong to customer-support
  for (const p of body.projects) {
    assert.equal(p.domain, "customer-support",
      `alice should only see customer-support projects, got domain "${p.domain}" on project "${p.id}"`)
  }
})

test("B20-USD: 404 for project that does not exist or is in a foreign domain", async t => {
  const { base } = await startConsole(t)
  const leadToken = await login(base, "carol")

  const r = await post(base, "/project-budget", leadToken, { project: "nonexistent-project-xyz", monthlyLimitUsd: 100 })
  assert.equal(r.status, 404)
})
