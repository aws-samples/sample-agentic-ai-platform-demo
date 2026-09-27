#!/usr/bin/env node
// D9/D10: create the NEW platform tools gateway (capability-split second leg —
// tools/MCP, parallel to the LLM gateway) and attach the demo MCP servers as
// real MCP targets. MCP servers do NOT go into the Agent Registry; they attach
// here at deploy/startup time, and the console's MCP list reads this gateway's
// target list directly. Never touches any existing gateway.
//
// Uses the AWS CLI (`bedrock-agentcore-control`), the same real API surface
// console/agentcore-gateway.mjs already shells out to.
//
//   node scripts/registry/setup-tools-gateway.mjs
import { spawn } from "node:child_process"
import { readFileSync, writeFileSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

const REGION = process.env.AWS_REGION || "us-west-2"
const GATEWAY_NAME = "platform-tools-gw"
const ROLE_NAME = "platform-tools-gw-role"
const CONSOLE_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "console")
const CONFIG_PATH = join(CONSOLE_DIR, "registry-config.json")

// MCP servers to attach as REAL gateway targets. Only real, reachable
// endpoints belong here — the registry-seed.json entries with illustrative
// mcp.example URLs stay console-local seed data and are never attached to a
// live gateway.
const MCP_TARGETS = [
  { name: "aws-docs", endpoint: "https://knowledge-mcp.global.api.aws", description: "AWS Knowledge MCP server (real public endpoint) — AWS docs search/read." },
]

function run(cmd, args) {
  return new Promise(resolve => {
    const p = spawn(cmd, args, { env: process.env })
    let out = "", err = ""
    p.stdout.on("data", d => (out += d))
    p.stderr.on("data", d => (err += d))
    p.on("close", code => resolve({ code, out, err }))
    p.on("error", e => resolve({ code: -1, out, err: String(e.message || e) }))
  })
}

async function aws(args) {
  const r = await run("aws", [...args, "--region", REGION, "--output", "json"])
  if (r.code !== 0) throw new Error(`aws ${args.slice(0, 3).join(" ")} failed: ${(r.err || r.out).trim()}`)
  return r.out ? JSON.parse(r.out) : {}
}

async function ensureRole() {
  try {
    const r = await run("aws", ["iam", "get-role", "--role-name", ROLE_NAME, "--output", "json"])
    if (r.code === 0) {
      console.log(`role ${ROLE_NAME}: exists`)
      return JSON.parse(r.out).Role.Arn
    }
    // Confused-deputy guard: only AgentCore acting on THIS account may assume the role.
    const ident = await aws(["sts", "get-caller-identity"])
    const trust = JSON.stringify({
      Version: "2012-10-17",
      Statement: [{
        Effect: "Allow",
        Principal: { Service: "bedrock-agentcore.amazonaws.com" },
        Action: "sts:AssumeRole",
        Condition: { StringEquals: { "aws:SourceAccount": ident.Account } },
      }],
    })
    const created = await aws(["iam", "create-role", "--role-name", ROLE_NAME,
      "--assume-role-policy-document", trust,
      "--description", "Execution role for the platform-tools-gw AgentCore Gateway (D10)",
      "--tags", "Key=project,Value=agentic-ai-platform-demo", "Key=managedBy,Value=setup-tools-gateway", "Key=auto-delete,Value=no"])
    console.log(`role ${ROLE_NAME}: created`)
    // IAM eventual consistency: give the new role a moment before CreateGateway.
    await new Promise(r2 => setTimeout(r2, 10000))
    return created.Role.Arn
  } catch (e) {
    throw new Error(`ensureRole failed: ${e.message}`)
  }
}

async function findGateway() {
  const r = await aws(["bedrock-agentcore-control", "list-gateways"])
  return (r.items || []).find(g => g.name === GATEWAY_NAME) || null
}

async function ensureGateway(roleArn) {
  let gw = await findGateway()
  if (!gw) {
    const created = await aws(["bedrock-agentcore-control", "create-gateway",
      "--name", GATEWAY_NAME,
      "--description", "Platform tools gateway (D10): MCP targets attach here at deploy time; access via gateway FGAC (Cedar), not the registry.",
      "--role-arn", roleArn,
      "--protocol-type", "MCP",
      "--authorizer-type", "AWS_IAM",
      "--tags", JSON.stringify({ project: "agentic-ai-platform-demo", managedBy: "setup-tools-gateway", "auto-delete": "no" })])
    console.log(`gateway ${GATEWAY_NAME}: created (${created.gatewayId}), waiting for READY…`)
    gw = created
  } else {
    console.log(`gateway ${GATEWAY_NAME}: exists (${gw.gatewayId}, ${gw.status})`)
  }
  for (let i = 0; i < 36; i++) {
    const g = await aws(["bedrock-agentcore-control", "get-gateway", "--gateway-identifier", gw.gatewayId])
    if (g.status === "READY") { console.log(`gateway ${GATEWAY_NAME}: READY`); return g }
    if (!["CREATING", "UPDATING", "READY"].includes(g.status)) throw new Error(`gateway entered ${g.status}: ${JSON.stringify(g.statusReasons || [])}`)
    await new Promise(r => setTimeout(r, 5000))
  }
  throw new Error("gateway did not reach READY in time")
}

async function attachTarget(gatewayId, t) {
  const existing = await aws(["bedrock-agentcore-control", "list-gateway-targets", "--gateway-identifier", gatewayId])
  const found = (existing.items || []).find(x => x.name === t.name)
  if (found) {
    console.log(`target ${t.name}: exists (${found.targetId}, ${found.status})`)
    return { ok: true, targetId: found.targetId, status: found.status, existed: true }
  }
  try {
    // Both demo endpoints are unauthenticated MCP servers: omit
    // credentialProviderConfigurations entirely (passing an empty
    // iamCredentialProvider fails ParamValidation — it requires service/region).
    const created = await aws(["bedrock-agentcore-control", "create-gateway-target",
      "--gateway-identifier", gatewayId,
      "--name", t.name,
      "--description", t.description,
      "--target-configuration", JSON.stringify({ mcp: { mcpServer: { endpoint: t.endpoint } } })])
    // target creation is async; poll briefly for a terminal status
    let status = created.status
    for (let i = 0; i < 24 && ["CREATING", "UPDATING", "SYNCHRONIZING"].includes(status); i++) {
      await new Promise(r => setTimeout(r, 5000))
      const g = await aws(["bedrock-agentcore-control", "get-gateway-target",
        "--gateway-identifier", gatewayId, "--target-id", created.targetId])
      status = g.status
      if (status === "FAILED") return { ok: false, targetId: created.targetId, status, error: JSON.stringify(g.statusReasons || []) }
    }
    console.log(`target ${t.name}: ${status} (${created.targetId})`)
    return { ok: status === "READY", targetId: created.targetId, status }
  } catch (e) {
    console.log(`target ${t.name}: attach FAILED — ${e.message}`)
    return { ok: false, error: e.message }
  }
}

async function main() {
  console.log(`Setting up ${GATEWAY_NAME} in ${REGION}…`)
  const roleArn = await ensureRole()
  const gw = await ensureGateway(roleArn)

  const results = {}
  for (const t of MCP_TARGETS) results[t.name] = { endpoint: t.endpoint, ...(await attachTarget(gw.gatewayId, t)) }

  let config = {}
  try { config = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) } catch {}
  config.region = REGION
  config.toolsGateway = {
    name: GATEWAY_NAME,
    gatewayId: gw.gatewayId,
    gatewayArn: gw.gatewayArn,
    gatewayUrl: gw.gatewayUrl || null,
    roleArn,
    targets: results,
  }
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n")
  console.log(`\nWrote ${CONFIG_PATH}`)
  for (const [name, r] of Object.entries(results)) {
    console.log(`  ${name}: ${r.ok ? `attached (${r.status})` : `NOT attached — ${r.error || r.status}`}`)
  }
}

main().catch(e => { console.error("setup-tools-gateway failed:", e); process.exit(1) })
