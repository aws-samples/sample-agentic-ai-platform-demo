// platform-gate: v1 — transcript recorder for the eval gate.
// Reads agentcore/datasets/golden.jsonl, replays each scenario's turns
// against a running local dev runtime (`agentcore dev --logs`, default
// localhost:8080), and writes the agent's replies to
// gates/transcripts/<scenario_id>.txt — exactly what run-eval.mjs scores.
//
// Usage:
//   agentcore dev --logs                 # terminal 1
//   node gates/record-transcripts.mjs    # terminal 2
// Then commit gates/transcripts/ and push — the eval gate reads committed
// transcripts, it does not invoke the agent itself.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs"

const datasetPath = "agentcore/datasets/golden.jsonl"
const endpoint = process.env.AGENTCORE_DEV_URL || "http://localhost:8080/invocations"

if (!existsSync(datasetPath)) fail(`Golden dataset missing: ${datasetPath}`)
const scenarios = readFileSync(datasetPath, "utf8").split("\n").filter(Boolean).map(l => JSON.parse(l))
if (!scenarios.length) fail(`Golden dataset is empty: ${datasetPath}`)

mkdirSync("gates/transcripts", { recursive: true })

let failures = 0
for (const s of scenarios) {
  const turns = (s.turns || []).filter(t => t?.input)
  if (!turns.length) { console.error(`skip ${s.scenario_id}: no turns[].input in dataset`); failures++; continue }
  // TLP-B11 #15: replay EVERY turn (not just the first) against the same
  // session, so multi-turn scenarios are genuinely executed — the schema's
  // turns array is a real conversation, not decoration.
  const sessionId = `rec-${s.scenario_id}-${Date.now()}`
  const replies = []
  try {
    for (const turn of turns) {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Amzn-Bedrock-AgentCore-Runtime-Session-Id": sessionId,
        },
        // Both runtime payload contracts in one body: blueprint runtimes read
        // `prompt` and ignore the rest; ask-style runtimes (operation/question)
        // read theirs and ignore `prompt`. One recorder, no per-repo glue.
        body: JSON.stringify({ prompt: turn.input, operation: "ask", question: turn.input }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      replies.push(await extractReply(res))
    }
    // Transcript holds ONLY agent replies (never the user inputs), so
    // deterministic "contains" checks can't be satisfied by echoed questions.
    const text = replies.length === 1 ? replies[0]
      : replies.map((r, i) => `--- turn ${i + 1} ---\n${r}`).join("\n")
    writeFileSync(`gates/transcripts/${s.scenario_id}.txt`, text)
    // TLP-B11 #11: provenance sidecar — records that this transcript came
    // from a real agent invocation, not a hand-written file. run-eval.mjs
    // flags transcripts that lack it.
    writeFileSync(`gates/transcripts/${s.scenario_id}.meta.json`, JSON.stringify({
      scenario_id: s.scenario_id,
      recordedAt: new Date().toISOString(),
      source: "record-transcripts.mjs",
      endpoint,
      sessionId,
      turns: turns.length,
    }, null, 2))
    console.log(`recorded gates/transcripts/${s.scenario_id}.txt (${turns.length} turn(s), ${text.length} chars)`)
  } catch (e) {
    console.error(`FAILED ${s.scenario_id}: ${e.message}`)
    failures++
  }
}

if (failures) fail(`${failures} scenario(s) failed to record. Is the local dev runtime up? Run "agentcore dev --logs" in another terminal first.`)
console.log(`Recorded ${scenarios.length} transcript(s) under gates/transcripts/.`)

// The dev runtime streams AgentCore-shaped events (SSE-ish JSON lines) or
// returns a single JSON body depending on CLI version; handle both, falling
// back to the raw response text so the transcript is never empty.
async function extractReply(res) {
  const raw = await res.text()
  const texts = []
  for (const line of raw.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const obj = JSON.parse(trimmed.replace(/^data:\s*/, ""))
      const blocks = obj?.event?.contentBlockDelta?.delta?.text
      if (typeof blocks === "string") texts.push(blocks)
      // Ask-style runtimes return one JSON envelope whose `answer` field is
      // the agent's reply — score that, not the whole envelope.
      else if (typeof obj?.answer === "string") texts.push(obj.answer)
      else if (typeof obj === "string") texts.push(obj)
    } catch { /* not a JSON line, ignore */ }
  }
  return (texts.join("") || raw).trim()
}

function fail(msg) { console.error(`\nRECORD TRANSCRIPTS FAILED\n${msg}`); process.exit(1) }
