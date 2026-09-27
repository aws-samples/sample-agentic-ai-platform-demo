/**
 * Gateway Model Discovery — reads available models from AgentCore Gateway
 * inference targets instead of static catalog.json.
 *
 * The gateway is the source of truth for model AVAILABILITY (what can actually
 * be called). catalog.json remains the source of metadata (pricing, labels,
 * vendor, tier) and is used to enrich gateway-discovered models.
 *
 * Env switches:
 *   MODEL_SOURCE=gateway|catalog (default: gateway if config exists, else catalog)
 */

import { listGatewayModels, isAnthropicMessagesModel, DEFAULT_GATEWAY_REGION, runAws, parseJsonResult } from "./agentcore-gateway.mjs"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const VENDOR_BY_PROVIDER = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  google: "Google",
  amazon: "Amazon",
  meta: "Meta",
  mistral: "Mistral AI",
  cohere: "Cohere",
  deepseek: "DeepSeek",
  minimax: "MiniMax",
  moonshotai: "Moonshot AI",
  nvidia: "NVIDIA",
  qwen: "Qwen",
  writer: "Writer",
  xai: "xAI",
  zai: "Z.ai",
}

// ---- Config ----

/**
 * Load gateway config from gateway-config.json (or inline from registry-config.json).
 * Returns null if no config found (falls back to catalog mode).
 */
export function loadGatewayConfig(baseDir) {
  // Try dedicated gateway-config.json first
  try {
    const raw = readFileSync(join(baseDir, "gateway-config.json"), "utf8")
    return JSON.parse(raw)
  } catch {}
  // Fall back to inferenceGateway in registry-config.json
  try {
    const raw = readFileSync(join(baseDir, "registry-config.json"), "utf8")
    const rc = JSON.parse(raw)
    if (rc.inferenceGateway) return { gateways: [rc.inferenceGateway, rc.inferenceGatewayClaude].filter(Boolean) }
  } catch {}
  return null
}

// ---- Discovery ----

/** Cache: { models[], lastRefreshed, source } */
let _cache = null
const CACHE_TTL_MS = 5 * 60 * 1000 // 5 minutes

/**
 * Discover models from all configured inference gateways.
 * Merges results from multiple gateways (e.g. us-west-2 bedrock-mantle + us-east-1 Claude).
 * Enriches with catalog.json metadata (pricing, labels, tier).
 */
export async function discoverGatewayModels(config, catalog) {
  if (!config || !config.gateways || config.gateways.length === 0) {
    return { ok: false, source: "none", error: "No inference gateways configured", models: [] }
  }

  const allModels = []
  const errors = []

  for (const gw of config.gateways) {
    try {
      const result = await listGatewayModels({
        gatewayId: gw.gatewayId,
        region: gw.region || DEFAULT_GATEWAY_REGION,
      })
      if (result.ok && result.models.length > 0) {
        for (const m of result.models) {
          allModels.push({
            id: m.id,
            owned_by: m.owned_by,
            gateway: gw.name || gw.gatewayId,
            gatewayId: gw.gatewayId,
            region: gw.region || DEFAULT_GATEWAY_REGION,
            api: isAnthropicMessagesModel(m.id) ? "messages" : "chat-completions",
          })
        }
      } else if (!result.ok) {
        errors.push({ gateway: gw.name || gw.gatewayId, error: result.error || "Unknown error" })
      }
    } catch (e) {
      errors.push({ gateway: gw.name || gw.gatewayId, error: String(e.message || e) })
    }
  }

  return {
    ok: allModels.length > 0,
    source: "gateway",
    gateways: config.gateways.map(g => g.name || g.gatewayId),
    models: allModels,
    errors: errors.length > 0 ? errors : undefined,
    discoveredAt: new Date().toISOString(),
  }
}

/**
 * Enrich gateway-discovered models with catalog.json metadata.
 * Gateway provides: id, gateway, region, api
 * Catalog provides: label, vendor, tier, pricing, approved, noTemperature
 *
 * Models in gateway but NOT in catalog get a generated label.
 * Models in catalog but NOT in gateway are excluded (not available).
 */
export function enrichModelsWithCatalog(gatewayModels, catalogModels) {
  const catalogMap = new Map()
  for (const cm of catalogModels || []) {
    for (const key of modelMatchKeys(cm.id)) catalogMap.set(key, cm)
  }

  return gatewayModels.map(gm => {
    const catalog = modelMatchKeys(gm.id).map(k => catalogMap.get(k)).find(Boolean)
    const vendor = catalog?.vendor || modelVendor(gm.id, gm.owned_by)

    return {
      id: gm.id,
      label: catalog?.label || humanizeModelId(gm.id),
      vendor,
      tier: catalog?.tier || null,
      runtime: "bedrock",
      runtimeModelId: catalog?.id || gm.id,
      // Governance default: a gateway-discovered model with NO catalog match
      // is visible but NOT approved — reachable-through-the-gateway is an
      // infrastructure fact, not a platform approval decision.
      approved: catalog ? (catalog.approved !== false) : false,
      noTemperature: catalog?.noTemperature || false,
      pricing: catalog?.pricing || null,
      gateway: gm.gateway,
      gatewayId: gm.gatewayId,
      region: gm.region,
      api: gm.api,
      source: "gateway",
      catalogMatch: !!catalog,
    }
  })
}

/**
 * Model identifiers can differ between catalog metadata and gateway discovery:
 *   catalog: global.anthropic.claude-haiku-4-5-20251001-v1:0
 *   gateway: bedrock-claude/anthropic.claude-haiku-4-5
 * These keys deliberately normalize transport prefixes and date/version suffixes.
 */
export function modelMatchKeys(id) {
  const bare = bareModelId(id)
  const canonical = bare.replace(/-\d{8}-v\d(?::\d+)?$/i, "")
  return [...new Set([String(id || ""), bare, `global.${bare}`, canonical, `global.${canonical}`].filter(Boolean))]
}

function bareModelId(id) {
  return String(id || "").replace(/^[^/]+\//, "").replace(/^global\./, "")
}

function splitProvider(id) {
  const bare = bareModelId(id)
  const m = bare.match(/^([a-z0-9-]+)\.(.+)$/i)
  return m ? { provider: m[1].toLowerCase(), model: m[2] } : { provider: "", model: bare }
}

function modelVendor(id, ownedBy) {
  const { provider } = splitProvider(id)
  const owner = String(ownedBy || "").trim()
  if (owner && !["system", "unknown"].includes(owner.toLowerCase())) {
    return VENDOR_BY_PROVIDER[owner.toLowerCase()] || titleToken(owner)
  }
  return VENDOR_BY_PROVIDER[provider] || "Unknown"
}

/**
 * Generate a human-readable label from a model ID.
 * "bedrock-mantle/anthropic.claude-sonnet-5" → "Claude Sonnet 5"
 * "bedrock-mantle/openai.gpt-oss-120b" → "GPT OSS 120B"
 */
function humanizeModelId(id) {
  const { model } = splitProvider(id)
  const cleaned = model
    .replace(/-\d{8}-v\d(?::\d+)?$/i, "")
    .replace(/[-_]/g, " ")
    .replace(/\b(claude (?:opus|sonnet|haiku)) (\d) (\d)\b/ig, "$1 $2.$3")
    .replace(/\b(gpt) (\d) (\d)\b/ig, "$1 $2.$3")
    .replace(/\b(v\d) (\d)\b/ig, "$1.$2")
  return cleaned.split(/\s+/).filter(Boolean).map(titleToken).join(" ").replace(/\b(\d+)B\b/g, "$1B").trim()
}

function titleToken(token) {
  const lower = String(token || "").toLowerCase()
  if (/^\d+b$/.test(lower)) return lower.toUpperCase()
  const acronyms = new Map([
    ["gpt", "GPT"], ["oss", "OSS"], ["vl", "VL"], ["ft", "FT"],
    ["it", "IT"], ["ai", "AI"], ["vpc", "VPC"], ["mcp", "MCP"],
  ])
  if (acronyms.has(lower)) return acronyms.get(lower)
  return token.replace(/^\w/, c => c.toUpperCase())
}

// ---- ListFoundationModels metadata enrichment (Batch 1) ----
// Gateway discovery is the access truth (what is reachable); `aws bedrock
// list-foundation-models` adds the metadata discovery cannot know: provider,
// input/output modalities, streaming support, lifecycle status. Enrichment
// only — an LFM failure never fails model discovery.

let _lfmCache = null   // { byKey: Map, fetchedAt: epoch-ms }
const LFM_TTL_MS = 10 * 60 * 1000

async function foundationModelMetadata(region) {
  if (_lfmCache && Date.now() - _lfmCache.fetchedAt < LFM_TTL_MS) return _lfmCache.byKey
  const raw = parseJsonResult(await runAws([
    "bedrock", "list-foundation-models", "--region", region, "--output", "json",
  ], { region }), "list-foundation-models")
  const byKey = new Map()
  for (const s of raw.modelSummaries || []) {
    const meta = {
      provider: s.providerName || null,
      inputModalities: s.inputModalities || [],
      outputModalities: s.outputModalities || [],
      streaming: s.responseStreamingSupported === true,
      lifecycle: s.modelLifecycle?.status || null,
    }
    for (const key of modelMatchKeys(s.modelId)) if (!byKey.has(key)) byKey.set(key, meta)
  }
  _lfmCache = { byKey, fetchedAt: Date.now() }
  return byKey
}

export function mergeLfmMetadata(models, byKey) {
  return models.map(m => {
    const meta = [...modelMatchKeys(m.id), ...modelMatchKeys(m.runtimeModelId)]
      .map(k => byKey.get(k)).find(Boolean)
    return meta ? { ...m, ...meta, lfmMatch: true } : { ...m, lfmMatch: false }
  })
}

// ---- Cached Discovery (for server use) ----

/**
 * Get models with caching. Returns cached result if fresh, otherwise re-discovers.
 * Falls back to catalog.json if gateway is unreachable.
 */
export async function getModels(config, catalog, { forceRefresh = false } = {}) {
  const modelSource = process.env.MODEL_SOURCE || (config ? "gateway" : "catalog")

  // Catalog-only mode
  if (modelSource === "catalog" || !config) {
    return {
      source: "catalog",
      sources: ["catalog.json"],
      models: (catalog.models || []).filter(m => m.approved !== false).map(m => ({ ...m, source: "catalog" })),
      lastRefreshed: null,
    }
  }

  // Gateway mode with cache
  if (!forceRefresh && _cache && (Date.now() - new Date(_cache.lastRefreshed).getTime()) < CACHE_TTL_MS) {
    return _cache
  }

  const discovery = await discoverGatewayModels(config, catalog)

  if (discovery.ok) {
    let enriched = enrichModelsWithCatalog(discovery.models, catalog.models)
    // LFM metadata merge — enrichment only, never a gate on the endpoint.
    let sources = ["gateway", "bedrock:ListFoundationModels"], sourceNotes
    try {
      const region = config.gateways[0]?.region || DEFAULT_GATEWAY_REGION
      enriched = mergeLfmMetadata(enriched, await foundationModelMetadata(region))
    } catch (e) {
      sources = ["gateway"]
      sourceNotes = "lfm-unavailable"
      console.warn(`[gateway-models] list-foundation-models failed (${String(e.message || e).slice(0, 160)}) — serving gateway data without LFM metadata.`)
    }
    _cache = {
      source: "gateway",
      sources,
      sourceNotes,
      gateways: discovery.gateways,
      models: enriched,
      lastRefreshed: discovery.discoveredAt,
      errors: discovery.errors,
    }
    return _cache
  }

  // Gateway failed — fall back to catalog
  console.warn(`[gateway-models] Discovery failed (${discovery.errors?.map(e => e.error).join("; ")}), falling back to catalog.`)
  return {
    source: "catalog-fallback",
    sources: ["catalog.json"],
    models: (catalog.models || []).filter(m => m.approved !== false).map(m => ({ ...m, source: "catalog" })),
    lastRefreshed: null,
    errors: discovery.errors,
  }
}

/** Bust the cache (e.g. after admin adds a new inference target). */
export function invalidateModelCache() {
  _cache = null
}
