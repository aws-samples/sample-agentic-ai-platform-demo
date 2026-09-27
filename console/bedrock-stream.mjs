// G15: real token streaming from Bedrock ConverseStream — the AWS CLI has no
// converse-stream operation, so this signs the HTTPS call itself (SigV4,
// node:crypto) and parses the response's binary eventstream framing. Vanilla
// node only: no new npm dependencies (SPEC rule). Credentials come from the
// same chain the CLI uses (`aws configure export-credentials`), so this works
// wherever `aws bedrock-runtime converse` already works.
import { createHmac, createHash } from "node:crypto"
import { request } from "node:https"
import { execFile } from "node:child_process"

const credsFromCli = () => new Promise((resolve, reject) =>
  execFile("aws", ["configure", "export-credentials"], (err, out) =>
    err ? reject(new Error("no AWS credentials (aws configure export-credentials failed)"))
        : resolve(JSON.parse(out))))

const hmac = (key, data) => createHmac("sha256", key).update(data).digest()
const sha256hex = data => createHash("sha256").update(data).digest("hex")

export function signV4({ method = "POST", host, path, region, service, body, creds }) {
  const amzDate = new Date().toISOString().replace(/[-:]|\.\d{3}/g, "")
  const date = amzDate.slice(0, 8)
  const headers = { "content-type": "application/json", host, "x-amz-date": amzDate }
  if (creds.SessionToken) headers["x-amz-security-token"] = creds.SessionToken
  const names = Object.keys(headers).sort()
  const canonical = [
    method, path, "",
    names.map(n => `${n}:${headers[n]}\n`).join(""),
    names.join(";"),
    sha256hex(body),
  ].join("\n")
  const scope = `${date}/${region}/${service}/aws4_request`
  const toSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256hex(canonical)].join("\n")
  let key = hmac(`AWS4${creds.SecretAccessKey}`, date)
  for (const step of [region, service, "aws4_request"]) key = hmac(key, step)
  const signature = createHmac("sha256", key).update(toSign).digest("hex")
  return {
    ...headers,
    authorization: `AWS4-HMAC-SHA256 Credential=${creds.AccessKeyId}/${scope}, SignedHeaders=${names.join(";")}, Signature=${signature}`,
  }
}

// Incremental parser for AWS eventstream framing:
// [total u32][headersLen u32][prelude crc u32][headers][payload][message crc u32].
// Header: nameLen u8 · name · type u8 · value (length depends on type).
// Returns a feed(chunk) function; onEvent(headers, payloadBuffer) per frame.
export function eventStreamParser(onEvent) {
  let buf = Buffer.alloc(0)
  const VALUE_LEN = { 0: 0, 1: 0, 2: 1, 3: 2, 4: 4, 5: 8, 8: 8, 9: 16 } // fixed-size types
  return chunk => {
    buf = Buffer.concat([buf, chunk])
    while (buf.length >= 16) {
      const total = buf.readUInt32BE(0)
      if (buf.length < total) break
      const headersEnd = 12 + buf.readUInt32BE(4)
      const headers = {}
      let o = 12
      while (o < headersEnd) {
        const nameLen = buf.readUInt8(o); o += 1
        const name = buf.toString("utf8", o, o + nameLen); o += nameLen
        const type = buf.readUInt8(o); o += 1
        if (type === 6 || type === 7) {           // bytearray / string: u16 length prefix
          const vLen = buf.readUInt16BE(o); o += 2
          if (type === 7) headers[name] = buf.toString("utf8", o, o + vLen)
          o += vLen
        } else { o += VALUE_LEN[type] ?? 0 }
      }
      onEvent(headers, buf.subarray(headersEnd, total - 4))
      buf = buf.subarray(total)
    }
  }
}

// Streams one Converse call; onText(delta) per token fragment; resolves with
// the full text. Rejection carries e.streamed=true if fragments were already
// emitted (callers must not retry through a non-streaming fallback then).
export function converseStream({ region, modelId, system, messages, inferenceConfig, onText, onMetadata }) {
  return new Promise(async (resolve, reject) => {
    let full = "", errBody = ""
    const fail = e => { e.streamed = full.length > 0; reject(e) }
    let creds
    try { creds = await credsFromCli() } catch (e) { return fail(e) }
    const host = `bedrock-runtime.${region}.amazonaws.com`
    const path = `/model/${encodeURIComponent(modelId)}/converse-stream`
    const body = JSON.stringify({ system, messages, inferenceConfig })
    const headers = signV4({ host, path, region, service: "bedrock", body, creds })
    const req = request({ host, path, method: "POST", headers }, res => {
      if (res.statusCode !== 200) {
        res.on("data", d => errBody += d)
        res.on("end", () => fail(new Error(`ConverseStream HTTP ${res.statusCode}: ${errBody.slice(0, 200)}`)))
        return
      }
      const feed = eventStreamParser((h, payload) => {
        if (h[":message-type"] === "exception" || h[":exception-type"])
          return fail(new Error(`${h[":exception-type"] || "streamError"}: ${payload.toString().slice(0, 200)}`))
        if (h[":event-type"] === "contentBlockDelta") {
          try {
            const t = JSON.parse(payload.toString()).delta?.text || ""
            if (t) { full += t; onText(t) }
          } catch {}
        }
        // Trailing metadata frame carries usage {inputTokens,outputTokens} +
        // metrics {latencyMs} — real counters for the playground chips.
        if (h[":event-type"] === "metadata" && onMetadata) {
          try {
            const m = JSON.parse(payload.toString())
            if (m.usage || m.metrics) onMetadata({ usage: m.usage || null, metrics: m.metrics || null })
          } catch {}
        }
      })
      res.on("data", feed)
      res.on("end", () => resolve(full))
      res.on("error", fail)
    })
    req.on("error", fail)
    req.setTimeout(120000, () => req.destroy(new Error("stream timeout")))
    req.end(body)
  })
}
