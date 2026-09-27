#!/usr/bin/env node
import { parseArgs } from "node:util"
import { DEFAULT_GATEWAY_REGION, invokeGatewayModel, listGatewayModels } from "./agentcore-gateway.mjs"

const { values } = parseArgs({
  options: {
    "gateway-id": { type: "string" },
    region: { type: "string" },
    model: { type: "string" },
    prompt: { type: "string" },
    "max-tokens": { type: "string" },
    api: { type: "string" },
    "list-models": { type: "boolean" },
    json: { type: "boolean" },
  },
})

const gatewayId = values["gateway-id"] || process.env.AI_GATEWAY_ID
const region = values.region || process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || DEFAULT_GATEWAY_REGION
const model = values.model || process.env.AI_GATEWAY_MODEL
const prompt = values.prompt || process.env.AI_GATEWAY_PROMPT || "Reply with one short sentence through AgentCore Gateway."
const maxTokens = Number(values["max-tokens"] || process.env.AI_GATEWAY_MAX_TOKENS || 256)
const api = values.api || process.env.AI_GATEWAY_API || "auto"

if (!gatewayId || (!model && !values["list-models"])) {
  console.error("Usage: node console/invoke-ai-gateway.mjs --gateway-id <id> --model <model-id> --prompt <text> [--api auto|chat|messages]")
  process.exit(2)
}

const result = values["list-models"]
  ? await listGatewayModels({ gatewayId, region })
  : await invokeGatewayModel({ gatewayId, region, model, prompt, maxTokens, api })
if (values.json) {
  console.log(JSON.stringify(result, null, 2))
} else if (values["list-models"]) {
  for (const m of result.models || []) console.log(m.id)
} else if (result.ok) {
  console.log(result.output || JSON.stringify(result.data, null, 2))
} else {
  console.error(result.text || result.statusText || `Gateway call failed with HTTP ${result.status}`)
}

if (!result.ok) process.exit(1)
