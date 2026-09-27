import { createHmac, createHash } from "node:crypto"
import { spawn } from "node:child_process"

export const DEFAULT_GATEWAY_REGION = process.env.AWS_DEFAULT_REGION || process.env.AWS_REGION || "us-west-2"

const AWS_BIN = process.env.AWS_BIN || "aws"
const AWS_PATH_PREFIX = "/usr/local/bin:/opt/homebrew/bin"

function commandEnv(extra = {}) {
  return {
    ...process.env,
    PATH: `${AWS_PATH_PREFIX}:${process.env.PATH || ""}`,
    AWS_DEFAULT_REGION: extra.region || process.env.AWS_DEFAULT_REGION || DEFAULT_GATEWAY_REGION,
    ...extra,
  }
}

export function runAws(args, { region = DEFAULT_GATEWAY_REGION } = {}) {
  return new Promise(resolve => {
    const p = spawn(AWS_BIN, args, { env: commandEnv({ region }) })
    let out = "", err = ""
    p.stdout.on("data", d => (out += d))
    p.stderr.on("data", d => (err += d))
    p.on("close", code => resolve({ code, out, err }))
    p.on("error", e => resolve({ code: -1, out, err: String(e.message || e) }))
  })
}

export function parseJsonResult(result, label) {
  if (result.code !== 0) {
    const msg = (result.err || result.out || "").trim()
    throw new Error(`${label} failed${msg ? `: ${msg}` : ""}`)
  }
  try {
    return JSON.parse(result.out || "{}")
  } catch (e) {
    throw new Error(`${label} returned non-JSON output: ${String(e.message || e)}`)
  }
}

export function gatewayHost(gatewayId, region = DEFAULT_GATEWAY_REGION) {
  return `${gatewayId}.gateway.bedrock-agentcore.${region}.amazonaws.com`
}

export function gatewayInferenceUrl(gatewayId, region = DEFAULT_GATEWAY_REGION, path = "v1/models") {
  const clean = String(path || "").replace(/^\/+/, "")
  return `https://${gatewayHost(gatewayId, region)}/inference/${clean}`
}

export function classifyGateway(gateway, targets = []) {
  const names = targets.map(t => String(t.name || "").toLowerCase())
  const hasInferenceHint = names.some(n => /(^|[-_])(bedrock|openai|anthropic|inference|llm|model)([-_]|$)/.test(n))
  return {
    ...gateway,
    targetCount: targets.length,
    targets,
    endpoint: gateway.gatewayUrl || `https://${gatewayHost(gateway.gatewayId, gateway.region || DEFAULT_GATEWAY_REGION)}`,
    inference: {
      likelyConfigured: hasInferenceHint,
      reason: hasInferenceHint
        ? "Target names suggest an inference/model provider target."
        : "No target name suggests an inference provider yet.",
    },
  }
}

export async function listGatewayInventory({ region = DEFAULT_GATEWAY_REGION } = {}) {
  const gatewaysRaw = parseJsonResult(await runAws([
    "bedrock-agentcore-control", "list-gateways", "--region", region, "--output", "json",
  ], { region }), "list-gateways")
  const gateways = []
  for (const g of gatewaysRaw.items || []) {
    let targets = [], targetError = null
    let rateLimits = [], rateLimitError = null
    try {
      const targetsRaw = parseJsonResult(await runAws([
        "bedrock-agentcore-control", "list-gateway-targets",
        "--gateway-identifier", g.gatewayId, "--region", region, "--output", "json",
      ], { region }), `list-gateway-targets ${g.gatewayId}`)
      targets = targetsRaw.items || []
    } catch (e) {
      targetError = String(e.message || e)
    }
    try {
      const rl = await listGatewayRateLimits({ gatewayId: g.gatewayId, region })
      rateLimits = rl.rateLimits || []
    } catch (e) {
      rateLimitError = String(e.message || e)
    }
    gateways.push({ ...classifyGateway({ ...g, region }, targets), targetError, rateLimits, rateLimitError })
  }
  gateways.sort((a, b) =>
    Number(Boolean(b.inference?.likelyConfigured)) - Number(Boolean(a.inference?.likelyConfigured)) ||
    String(a.name || a.gatewayId).localeCompare(String(b.name || b.gatewayId))
  )
  return { ok: true, region, gateways, source: "aws bedrock-agentcore-control" }
}

export async function listGatewayRateLimits({ gatewayId, region = DEFAULT_GATEWAY_REGION } = {}) {
  const raw = parseJsonResult(await runAws([
    "bedrock-agentcore-control", "list-gateway-rate-limits",
    "--gateway-identifier", gatewayId, "--region", region, "--output", "json",
  ], { region }), `list-gateway-rate-limits ${gatewayId}`)
  return { ok: true, gatewayId, region, rateLimits: raw.items || raw.rateLimits || raw.gatewayRateLimits || [] }
}

function hashHex(value) {
  return createHash("sha256").update(value).digest("hex")
}

function hmac(key, value, encoding) {
  return createHmac("sha256", key).update(value).digest(encoding)
}

function credentialScope(dateStamp, region, service) {
  return `${dateStamp}/${region}/${service}/aws4_request`
}

export function signAwsRequest({
  method = "GET",
  url,
  region = DEFAULT_GATEWAY_REGION,
  service = "bedrock-agentcore",
  body = "",
  credentials,
  now = new Date(),
  headers = {},
}) {
  if (!credentials?.AccessKeyId || !credentials?.SecretAccessKey) {
    throw new Error("AWS credentials are required for SigV4 signing.")
  }
  const u = new URL(url)
  const amz = now.toISOString().replace(/[:-]|\.\d{3}/g, "")
  const dateStamp = amz.slice(0, 8)
  const payloadHash = hashHex(body)
  const baseHeaders = {
    ...headers,
    host: u.host,
    "x-amz-date": amz,
    "x-amz-content-sha256": payloadHash,
  }
  if (credentials.SessionToken) baseHeaders["x-amz-security-token"] = credentials.SessionToken
  const canonicalHeaders = Object.entries(baseHeaders)
    .map(([k, v]) => [k.toLowerCase(), String(v).trim().replace(/\s+/g, " ")])
    .sort(([a], [b]) => a.localeCompare(b))
  const signedHeaders = canonicalHeaders.map(([k]) => k).join(";")
  const canonicalQuery = [...u.searchParams.entries()]
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .sort()
    .join("&")
  const canonicalRequest = [
    method.toUpperCase(),
    u.pathname || "/",
    canonicalQuery,
    canonicalHeaders.map(([k, v]) => `${k}:${v}\n`).join(""),
    signedHeaders,
    payloadHash,
  ].join("\n")
  const algorithm = "AWS4-HMAC-SHA256"
  const scope = credentialScope(dateStamp, region, service)
  const stringToSign = [algorithm, amz, scope, hashHex(canonicalRequest)].join("\n")
  const kDate = hmac(`AWS4${credentials.SecretAccessKey}`, dateStamp)
  const kRegion = hmac(kDate, region)
  const kService = hmac(kRegion, service)
  const kSigning = hmac(kService, "aws4_request")
  const signature = hmac(kSigning, stringToSign, "hex")
  const authorization = `${algorithm} Credential=${credentials.AccessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`
  return {
    headers: {
      ...baseHeaders,
      Authorization: authorization,
    },
    canonicalRequest,
    stringToSign,
    signedHeaders,
  }
}

async function resolveAwsCredentials({ region = DEFAULT_GATEWAY_REGION } = {}) {
  if (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY) {
    return {
      AccessKeyId: process.env.AWS_ACCESS_KEY_ID,
      SecretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
      SessionToken: process.env.AWS_SESSION_TOKEN,
    }
  }
  const r = await runAws(["configure", "export-credentials", "--format", "process"], { region })
  const parsed = parseJsonResult(r, "aws configure export-credentials")
  return {
    AccessKeyId: parsed.AccessKeyId || parsed.AccessKey,
    SecretAccessKey: parsed.SecretAccessKey || parsed.SecretKey,
    SessionToken: parsed.SessionToken,
  }
}

async function gatewayFetch({ gatewayId, region = DEFAULT_GATEWAY_REGION, path, method = "GET", body = null, bearerToken = "", headers = {} }) {
  const url = gatewayInferenceUrl(gatewayId, region, path)
  const payload = body == null ? "" : JSON.stringify(body)
  const requestHeaders = { "content-type": "application/json", ...headers }
  let signedHeaders = requestHeaders
  if (bearerToken) {
    signedHeaders = { ...requestHeaders, Authorization: `Bearer ${bearerToken}` }
  } else {
    const credentials = await resolveAwsCredentials({ region })
    signedHeaders = signAwsRequest({ method, url, region, body: payload, credentials, headers: requestHeaders }).headers
  }
  const response = await fetch(url, { method, headers: signedHeaders, body: method === "GET" ? undefined : payload })
  const text = await response.text()
  let data = null
  try { data = text ? JSON.parse(text) : null } catch {}
  return { ok: response.ok, status: response.status, statusText: response.statusText, url, data, text }
}

export function extractModelIds(modelResponse) {
  const data = modelResponse?.data
  if (!Array.isArray(data)) return []
  return data
    .map(m => ({ id: m.id, owned_by: m.owned_by || m.owner || "unknown", object: m.object || "model" }))
    .filter(m => m.id)
}

export function extractChatText(responseData) {
  const choice = responseData?.choices?.[0]
  if (choice?.message?.content) return choice.message.content
  if (choice?.delta?.content) return choice.delta.content
  if (typeof responseData?.output_text === "string") return responseData.output_text
  if (Array.isArray(responseData?.output)) {
    return responseData.output.map(o => o.content?.map?.(c => c.text || c.output_text || "").join("") || "").join("").trim()
  }
  return ""
}

export function extractAnthropicText(responseData) {
  if (typeof responseData?.content === "string") return responseData.content
  if (Array.isArray(responseData?.content)) {
    return responseData.content
      .map(c => typeof c === "string" ? c : c?.text || "")
      .join("")
      .trim()
  }
  return extractChatText(responseData)
}

export function isAnthropicMessagesModel(model = "") {
  return /(^|\/)anthropic\.claude-|(^|\/)claude-|claude-(opus|sonnet|haiku|fable)/i.test(String(model))
}

export async function listGatewayModels({ gatewayId, region = DEFAULT_GATEWAY_REGION, bearerToken = "" }) {
  const r = await gatewayFetch({ gatewayId, region, path: "v1/models", bearerToken })
  return { ...r, models: r.ok ? extractModelIds(r.data) : [] }
}

export async function invokeGatewayChat({ gatewayId, region = DEFAULT_GATEWAY_REGION, bearerToken = "", model, prompt, maxTokens = 512 }) {
  const body = {
    model,
    messages: [{ role: "user", content: prompt }],
    max_tokens: Number(maxTokens) || 512,
    stream: false,
  }
  const r = await gatewayFetch({ gatewayId, region, path: "v1/chat/completions", method: "POST", body, bearerToken })
  return { ...r, output: r.ok ? extractChatText(r.data) : "" }
}

export async function invokeGatewayMessages({ gatewayId, region = DEFAULT_GATEWAY_REGION, bearerToken = "", model, prompt, maxTokens = 512 }) {
  const body = {
    model,
    messages: [{ role: "user", content: prompt }],
    max_tokens: Number(maxTokens) || 512,
    stream: false,
  }
  const r = await gatewayFetch({
    gatewayId,
    region,
    path: "v1/messages",
    method: "POST",
    body,
    bearerToken,
    headers: { "anthropic-version": "2023-06-01" },
  })
  return { ...r, output: r.ok ? extractAnthropicText(r.data) : "" }
}

export async function invokeGatewayModel({ gatewayId, region = DEFAULT_GATEWAY_REGION, bearerToken = "", model, prompt, maxTokens = 512, api = "auto" }) {
  const selected = api === "messages" || (api === "auto" && isAnthropicMessagesModel(model)) ? "messages" : "chat"
  if (selected === "messages") {
    return invokeGatewayMessages({ gatewayId, region, bearerToken, model, prompt, maxTokens })
  }
  return invokeGatewayChat({ gatewayId, region, bearerToken, model, prompt, maxTokens })
}
