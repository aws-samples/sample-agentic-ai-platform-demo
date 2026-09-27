import { readFileSync, writeFileSync, existsSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = dirname(fileURLToPath(import.meta.url))
export const MODEL_ACCESS_PATH = join(__dirname, "model-access-policies.json")

const DEFAULT_CONFIG = {
  version: 1,
  identityDimension: "$.context.jwt.team",
  policies: [{
    id: "default",
    modelPattern: "*",
    allowedDomains: ["platform"],
    requestableDomains: [],
    rateLimitProfile: { requestsPerMinute: 50, tokensPerMinute: 120000, connectionsPerSecond: 12 },
  }],
}

export function loadModelAccessConfig(path = MODEL_ACCESS_PATH) {
  if (!existsSync(path)) return DEFAULT_CONFIG
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"))
    return normalizeConfig(parsed)
  } catch {
    return DEFAULT_CONFIG
  }
}

export function saveModelAccessConfig(config, path = MODEL_ACCESS_PATH) {
  writeFileSync(path, JSON.stringify(normalizeConfig(config), null, 2))
}

export function normalizeConfig(config) {
  const out = {
    version: Number(config?.version || 1),
    note: config?.note || "",
    identityDimension: String(config?.identityDimension || "$.context.jwt.team"),
    policies: Array.isArray(config?.policies) ? config.policies.map(normalizePolicy) : [],
  }
  if (!out.policies.length) out.policies.push(normalizePolicy(DEFAULT_CONFIG.policies[0]))
  return out
}

function normalizePolicy(policy = {}) {
  return {
    id: String(policy.id || policy.modelId || policy.modelPattern || "policy"),
    modelId: policy.modelId ? String(policy.modelId) : null,
    modelPattern: String(policy.modelPattern || policy.modelId || "*"),
    description: String(policy.description || ""),
    allowedDomains: normalizeDomainList(policy.allowedDomains),
    requestableDomains: normalizeDomainList(policy.requestableDomains),
    rateLimitProfile: normalizeRateLimitProfile(policy.rateLimitProfile),
  }
}

function normalizeDomainList(list) {
  return [...new Set((Array.isArray(list) ? list : [])
    .map(v => String(v || "").trim())
    .filter(Boolean))]
}

function normalizeRateLimitProfile(profile = {}) {
  const n = (v, fallback) => {
    const out = Number(v)
    return Number.isFinite(out) && out > 0 ? Math.floor(out) : fallback
  }
  return {
    requestsPerMinute: n(profile.requestsPerMinute, 50),
    tokensPerMinute: n(profile.tokensPerMinute, 120000),
    connectionsPerSecond: n(profile.connectionsPerSecond, 12),
  }
}

function globRegex(pattern) {
  const escaped = String(pattern || "*")
    .replace(/[|\\{}()[\]^$+?.]/g, "\\$&")
    .replace(/\*/g, ".*")
  return new RegExp(`^${escaped}$`, "i")
}

function specificity(policy) {
  if (policy.modelId) return 100000 + policy.modelId.length
  return String(policy.modelPattern || "").replace(/\*/g, "").length
}

export function resolveModelPolicy(modelId, config = loadModelAccessConfig()) {
  const id = String(modelId || "")
  const policies = normalizeConfig(config).policies
  const matches = policies.filter(policy =>
    (policy.modelId && policy.modelId === id) || globRegex(policy.modelPattern).test(id)
  )
  return [...(matches.length ? matches : policies.filter(p => p.modelPattern === "*"))]
    .sort((a, b) => specificity(b) - specificity(a))[0] || normalizePolicy(DEFAULT_CONFIG.policies[0])
}

export function domainListed(list = [], domain) {
  if (!domain) return false
  return list.includes("*") || list.includes(domain)
}

export function expandDomainList(list = [], domains = []) {
  const domainIds = domains.map(d => typeof d === "string" ? d : d.id).filter(Boolean)
  return list.includes("*") ? domainIds : list
}

export function buildRateLimitPlan({ model, policy, domains = [], identityDimension }) {
  const modelId = model?.runtimeModelId || model?.id || model
  const p = policy || resolveModelPolicy(modelId)
  const profile = p.rateLimitProfile || {}
  const effectiveDomains = expandDomainList(p.allowedDomains || [], domains)
  const dim = identityDimension || "$.context.jwt.team"
  return {
    identityDimension: dim,
    entries: [
      {
        name: `${p.id}-per-domain-model-traffic`,
        dimensionKeys: ["qualifiedModelId", dim],
        appliesToDomains: effectiveDomains,
        requestLimit: { rate: profile.requestsPerMinute, interval: "minute" },
        tokenLimit: { rate: profile.tokensPerMinute, interval: "minute" },
        dimensions: effectiveDomains.map(domain => ({
          qualifiedModelId: String(modelId || ""),
          [dim]: domain,
        })),
      },
      {
        name: `${p.id}-per-model-connections`,
        dimensionKeys: ["qualifiedModelId"],
        appliesToDomains: ["all allowed domains"],
        connectionLimit: { rate: profile.connectionsPerSecond, interval: "second" },
        dimensions: [{ qualifiedModelId: String(modelId || "") }],
      },
    ],
  }
}

export function evaluateModelAccess({
  modelId,
  domain,
  isPlatform = false,
  activeDomainGrant = null,
  latestRequest = null,
  domains = [],
  config = loadModelAccessConfig(),
}) {
  const policy = resolveModelPolicy(modelId, config)
  const allowedByPolicy = domainListed(policy.allowedDomains, domain)
  const allowedByGrant = Boolean(activeDomainGrant)
  const requestableByPolicy = domainListed(policy.requestableDomains, domain)
  const visible = Boolean(isPlatform || allowedByPolicy || allowedByGrant || requestableByPolicy || latestRequest)
  const allowed = Boolean(isPlatform || allowedByPolicy || allowedByGrant)
  const requestable = Boolean(!allowed && requestableByPolicy)
  const status = isPlatform ? "platform"
    : allowedByPolicy ? "allowed"
    : allowedByGrant ? "grant-approved"
    : latestRequest?.status === "pending" ? "pending"
    : latestRequest?.status === "rejected" ? "rejected"
    : latestRequest?.status === "expired" ? "expired"
    : requestable ? "requestable"
    : "hidden"
  return {
    visible,
    allowed,
    requestable,
    status,
    reason: policy.description || "",
    domain,
    grant: activeDomainGrant ? { id: activeDomainGrant.id, status: activeDomainGrant.status, expiresAt: activeDomainGrant.expiresAt } : null,
    request: latestRequest ? {
      id: latestRequest.id,
      status: latestRequest.status,
      requestedAt: latestRequest.requestedAt,
      decidedBy: latestRequest.decidedBy,
      decidedAt: latestRequest.decidedAt,
      expiresAt: latestRequest.expiresAt,
    } : null,
    policy: {
      id: policy.id,
      modelId: policy.modelId,
      modelPattern: policy.modelPattern,
      description: policy.description,
      allowedDomains: policy.allowedDomains,
      requestableDomains: policy.requestableDomains,
      rateLimitProfile: policy.rateLimitProfile,
    },
    rateLimitPlan: buildRateLimitPlan({ model: { id: modelId }, policy, domains, identityDimension: config.identityDimension }),
  }
}
