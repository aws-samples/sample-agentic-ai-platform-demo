#!/usr/bin/env node
import { createServer } from "node:http"
import { randomUUID } from "node:crypto"
import { spawnSync } from "node:child_process"
import { Readable } from "node:stream"
import { DEFAULT_GATEWAY_REGION, extractChatText, gatewayHost, isAnthropicMessagesModel, signAwsRequest } from "./agentcore-gateway.mjs"

const gatewayId = process.env.AI_GATEWAY_ID
const region = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || DEFAULT_GATEWAY_REGION
const port = Number(process.env.AI_GATEWAY_PROXY_PORT || 8787)
const forceModel = process.env.AI_GATEWAY_FORCE_MODEL || ""

if (!gatewayId) {
  console.error("Set AI_GATEWAY_ID before starting the proxy.")
  process.exit(2)
}

function awsCredentials() {
  if (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY) {
    return {
      AccessKeyId: process.env.AWS_ACCESS_KEY_ID,
      SecretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
      SessionToken: process.env.AWS_SESSION_TOKEN,
    }
  }
  const r = spawnSync("aws", ["configure", "export-credentials", "--format", "process"], {
    encoding: "utf8",
    env: { ...process.env, PATH: `/usr/local/bin:/opt/homebrew/bin:${process.env.PATH || ""}`, AWS_DEFAULT_REGION: region },
  })
  if (r.status !== 0) throw new Error(r.stderr || r.stdout || "Could not export AWS credentials.")
  return JSON.parse(r.stdout)
}

function readBody(req) {
  return new Promise(resolve => {
    let body = ""
    req.on("data", chunk => body += chunk)
    req.on("end", () => resolve(body))
  })
}

function messageText(content) {
  if (typeof content === "string") return content
  if (Array.isArray(content)) return content.map(c => typeof c === "string" ? c : c?.text || "").join("")
  return ""
}

function toOpenAiChatBody(anthropicBody) {
  const messages = []
  if (anthropicBody.system) messages.push({ role: "system", content: messageText(anthropicBody.system) })
  for (const m of anthropicBody.messages || []) {
    messages.push({ role: m.role === "assistant" ? "assistant" : "user", content: messageText(m.content) })
  }
  return {
    model: forceModel || anthropicBody.model,
    messages,
    max_tokens: anthropicBody.max_tokens || 1024,
    temperature: anthropicBody.temperature,
    stream: false,
  }
}

function toNativeAnthropicBody(anthropicBody) {
  return {
    ...anthropicBody,
    model: forceModel || anthropicBody.model,
  }
}

function anthropicResponse(openAiData, model) {
  const text = extractChatText(openAiData)
  return {
    id: `msg_${randomUUID().replace(/-/g, "")}`,
    type: "message",
    role: "assistant",
    model,
    content: [{ type: "text", text }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: openAiData?.usage?.prompt_tokens || 0,
      output_tokens: openAiData?.usage?.completion_tokens || 0,
    },
  }
}

async function signedGatewayFetch(path, method, body, extraHeaders = {}) {
  const cleanPath = path.startsWith("/inference/") ? path.slice("/inference".length) : path
  const url = `https://${gatewayHost(gatewayId, region)}/inference${cleanPath}`
  const headers = { "content-type": "application/json", ...extraHeaders }
  const signed = signAwsRequest({ method, url, region, body, credentials: awsCredentials(), headers }).headers
  return fetch(url, { method, headers: signed, body: method === "GET" ? undefined : body })
}

function writeAnthropicStream(res, payload) {
  const text = payload.content?.[0]?.text || ""
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" })
  const send = (event, data) => {
    res.write(`event: ${event}\n`)
    res.write(`data: ${JSON.stringify(data)}\n\n`)
  }
  send("message_start", { type: "message_start", message: { ...payload, content: [], stop_reason: null, usage: { input_tokens: payload.usage.input_tokens, output_tokens: 0 } } })
  send("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })
  send("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } })
  send("content_block_stop", { type: "content_block_stop", index: 0 })
  send("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: payload.usage.output_tokens } })
  send("message_stop", { type: "message_stop" })
  res.write("data: [DONE]\n\n")
  res.end()
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`)
    if (url.pathname === "/health") {
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ ok: true, gatewayId, region, forceModel }))
      return
    }

    const raw = await readBody(req)
    if (url.pathname === "/v1/messages" && req.method === "POST") {
      const incoming = raw ? JSON.parse(raw) : {}
      const selectedModel = forceModel || incoming.model || ""
      if (isAnthropicMessagesModel(selectedModel)) {
        const body = JSON.stringify(toNativeAnthropicBody(incoming))
        const upstream = await signedGatewayFetch("/v1/messages", "POST", body, {
          "anthropic-version": req.headers["anthropic-version"] || "2023-06-01",
        })
        res.writeHead(upstream.status, Object.fromEntries(upstream.headers.entries()))
        if (upstream.body) Readable.fromWeb(upstream.body).pipe(res)
        else res.end()
        return
      }
      const openAiBody = toOpenAiChatBody(incoming)
      const upstream = await signedGatewayFetch("/v1/chat/completions", "POST", JSON.stringify(openAiBody))
      const text = await upstream.text()
      const data = text ? JSON.parse(text) : null
      if (!upstream.ok) {
        res.writeHead(upstream.status, { "content-type": "application/json" })
        res.end(text)
        return
      }
      const payload = anthropicResponse(data, incoming.model || openAiBody.model)
      if (incoming.stream) writeAnthropicStream(res, payload)
      else {
        res.writeHead(200, { "content-type": "application/json" })
        res.end(JSON.stringify(payload))
      }
      return
    }

    let body = raw
    try {
      const parsed = raw ? JSON.parse(raw) : null
      if (parsed && forceModel && parsed.model) {
        parsed.model = forceModel
        body = JSON.stringify(parsed)
      }
    } catch {}

    const upstream = await signedGatewayFetch(url.pathname + url.search, req.method, body, {})
    res.writeHead(upstream.status, Object.fromEntries(upstream.headers.entries()))
    if (upstream.body) Readable.fromWeb(upstream.body).pipe(res)
    else res.end()
  } catch (e) {
    res.writeHead(500, { "content-type": "application/json" })
    res.end(JSON.stringify({ ok: false, error: String(e.message || e) }))
  }
})

server.listen(port, "127.0.0.1", () => {
  console.log(`AI Gateway SigV4 proxy listening on http://127.0.0.1:${port}`)
  console.log(`Upstream: https://${gatewayHost(gatewayId, region)}/inference`)
})
