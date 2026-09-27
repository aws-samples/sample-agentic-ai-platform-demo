// preflight.mjs — hard-fail real-mode preflight. Any assertion failure exits 1.
// Run: node preflight.mjs   (after: source demo-env.sh)
import { execFileSync } from "node:child_process"
import { readFileSync, existsSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const REPO = dirname(fileURLToPath(import.meta.url))
const rows = []

function aws(args) {
  return execFileSync("aws", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
}

function fail(check, expected, actual, message) {
  rows.push({ check, expected, actual, ok: false })
  printTables()
  console.error(`\nFAILED assertion: ${check}\n${message}`)
  process.exit(1)
}

function pass(check, expected, actual) {
  rows.push({ check, expected, actual, ok: true })
}

function printTables() {
  const header = { check: "check", expected: "expected", actual: "actual", ok: "result" }
  const all = [header, ...rows.map(r => ({ ...r, ok: r.ok ? "PASS" : "FAIL" }))]
  const w = k => Math.max(...all.map(r => String(r[k]).length))
  const wc = w("check"), we = w("expected"), wa = w("actual")
  for (const r of all) {
    console.log(`${String(r.check).padEnd(wc)} | ${String(r.expected).padEnd(we)} | ${String(r.actual).padEnd(wa)} | ${r.ok}`)
  }
  console.log("\neffective env switches")
  for (const k of ["OBS_BACKEND", "REGISTRY_BACKEND", "MODEL_SOURCE", "PLATO_FIXTURE", "LANGFUSE_FIXTURE"]) {
    console.log(`${k.padEnd(16)} | ${process.env[k] ?? "(unset)"}`)
  }
}

function collectArns(value, out) {
  if (typeof value === "string") {
    if (value.startsWith("arn:aws:")) out.push(value)
  } else if (Array.isArray(value)) {
    value.forEach(v => collectArns(v, out))
  } else if (value && typeof value === "object") {
    Object.values(value).forEach(v => collectArns(v, out))
  }
  return out
}

// 1. Caller identity + every config ARN must be in the same account
let account
try {
  account = JSON.parse(aws(["sts", "get-caller-identity", "--output", "json"])).Account
} catch (e) {
  fail("sts get-caller-identity", "succeeds", "error", `AWS credentials unusable: ${String(e.stderr || e.message).trim().slice(0, 300)}`)
}
pass("sts get-caller-identity", "account resolves", account)

let gatewayCfg, registryCfg
try {
  gatewayCfg = JSON.parse(readFileSync(join(REPO, "console", "gateway-config.json"), "utf8"))
  registryCfg = JSON.parse(readFileSync(join(REPO, "console", "registry-config.json"), "utf8"))
} catch (e) {
  fail("config file present", "console/gateway-config.json + registry-config.json readable", "error",
    `Console config unreadable: ${String(e.message).slice(0, 300)}. Both files are account-specific and not committed — copy them in before demoing.`)
}
const arns = collectArns([gatewayCfg, registryCfg], [])
const arnAccounts = [...new Set(arns.map(a => a.split(":")[4]).filter(Boolean))]
for (const cfgAccount of arnAccounts) {
  if (cfgAccount !== account) {
    fail("config ARN account", account, cfgAccount,
      `Cross-account mismatch: console configs reference account ${cfgAccount} but your AWS credentials resolve to account ${account}. ` +
      `Fix AWS_PROFILE (or the configs) so both sides agree before demoing.`)
  }
}
pass("config ARN account", account, `${arnAccounts.join(",")} (${arns.length} ARNs)`)

// 2. Region consistency: config regions vs effective CLI region
const cfgRegions = [...new Set([
  ...arns.map(a => a.split(":")[3]),
  gatewayCfg.gateways?.map(g => g.region) ?? [],
  registryCfg.region,
].flat().filter(Boolean))]
let envRegion = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION
if (!envRegion) {
  try { envRegion = aws(["configure", "get", "region"]).trim() } catch { envRegion = "" }
}
if (cfgRegions.length !== 1) {
  fail("region consistency", "one region in configs", cfgRegions.join(","), `Configs disagree on region: ${cfgRegions.join(", ")}`)
}
const region = cfgRegions[0]
if (!envRegion || envRegion !== region) {
  fail("region consistency", region, envRegion || "(unset)",
    `Configs target ${region} but the effective AWS region is ${envRegion || "(unset)"}. Set AWS_REGION=${region}.`)
}
pass("region consistency", region, envRegion)

// 3. SSM secrets readable and non-empty (values never printed)
const lfPrefix = process.env.LANGFUSE_SSM_PREFIX || "/agentic-platform/langfuse"
const ssmNames = [`${lfPrefix}/public-key`, `${lfPrefix}/secret-key`,
  process.env.GITHUB_PAT_SSM || "/openclaw/github/melanie531-pat"]
for (const name of ssmNames) {
  let value
  try {
    value = JSON.parse(aws(["ssm", "get-parameter", "--name", name, "--with-decryption",
      "--region", region, "--output", "json"])).Parameter.Value
  } catch (e) {
    fail(`ssm ${name}`, "readable", "error", `SSM get-parameter failed for ${name}: ${String(e.stderr || e.message).trim().slice(0, 300)}`)
  }
  if (!value) fail(`ssm ${name}`, "non-empty", "(empty)", `SSM parameter ${name} exists but is empty.`)
  pass(`ssm ${name}`, "non-empty", `(set, ${value.length} chars)`)
}

// 4. At least one AgentCore runtime
let runtimes
try {
  runtimes = JSON.parse(aws(["bedrock-agentcore-control", "list-agent-runtimes",
    "--region", region, "--output", "json"])).agentRuntimes ?? []
} catch (e) {
  fail("agentcore runtimes", ">=1", "error", `list-agent-runtimes failed: ${String(e.stderr || e.message).trim().slice(0, 300)}`)
}
if (runtimes.length < 1) fail("agentcore runtimes", ">=1", "0", "No AgentCore runtimes deployed — the invoke path has nothing to call.")
pass("agentcore runtimes", ">=1", String(runtimes.length))

// 5. Cognito user pool used by the invoke path (from .demo-secrets/cognito.env)
const cogPath = join(REPO, ".demo-secrets", "cognito.env")
if (!existsSync(cogPath)) {
  fail("cognito user pool", "reachable", "no config", `.demo-secrets/cognito.env missing — per-user identity flow cannot sign in.`)
}
const cog = Object.fromEntries(readFileSync(cogPath, "utf8").split("\n")
  .filter(l => l.includes("=")).map(l => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()]))
try {
  const pool = JSON.parse(aws(["cognito-idp", "describe-user-pool", "--user-pool-id", cog.POOL_ID,
    "--region", cog.REGION || region, "--output", "json"])).UserPool
  pass("cognito user pool", cog.POOL_ID, `${pool.Name} (${pool.Status || "ACTIVE"})`)
} catch (e) {
  fail("cognito user pool", cog.POOL_ID || "(POOL_ID unset)", "error",
    `describe-user-pool failed: ${String(e.stderr || e.message).trim().slice(0, 300)}`)
}

printTables()
process.exit(0)
