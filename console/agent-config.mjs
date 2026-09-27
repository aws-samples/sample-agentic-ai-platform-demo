// agent-config.yaml — the domain team's config-as-code entry into the wizard.
// A builder who already keeps their agent config in git pastes/uploads the file
// instead of re-filling the compose form; the console parses it, validates it
// against the SAME governed vocabulary the form is limited to (APPROVED
// registry models, known guardrail ids), and populates the wizard state.
//
// The parser is a deliberate YAML SUBSET, not a YAML implementation — the
// console has no dependencies, and the schema below is all the file may contain:
// nested maps, flat lists of scalars, `#` comments, space indentation. Block
// scalars, anchors, flow collections and multi-document files are rejected with
// a line number rather than silently half-parsed.
//
//   name: retail-insights
//   model: global.anthropic.claude-haiku-4-5-20251001-v1:0
//   system_prompt: app/chat_agent/instructions.md   # a FILE REFERENCE, never inline text
//   rag:
//     datasource: retail-product-reviews
//     index: retail-reviews-v3
//     retrieval:
//       top_k: 6
//   memory:
//     retention_days: 30
//     scope: per-user
//   guardrails:
//     - pii-filter
//   eval:
//     golden_dataset: eval/golden/retail-insights.jsonl
//     threshold: 0.8

// Strip a trailing `# comment`. A quoted scalar may legitimately contain #, so
// scan past the closing quote first; everything else strips from the first
// whitespace-preceded #.
function stripComment(s) {
  const q = s[0]
  if (q === '"' || q === "'") {
    const end = s.indexOf(q, 1)
    if (end > 0) return (s.slice(0, end + 1) + afterQuote(s.slice(end + 1))).trim()
  }
  return bareComment(s).trim()
}
function bareComment(s) {
  const i = s.search(/(^|\s)#/)
  return i < 0 ? s : s.slice(0, i)
}
function afterQuote(s) {
  return bareComment(s)
}

function scalar(v) {
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) return v.slice(1, -1)
  if (v === "true") return true
  if (v === "false") return false
  if (v === "null" || v === "~" || v === "") return null
  if (/^-?\d+$/.test(v)) return parseInt(v, 10)
  if (/^-?\d*\.\d+$/.test(v)) return parseFloat(v)
  return v
}

// Next line with content, so a `key:` with no inline value can tell a nested
// map from a list without backtracking.
function nextContent(lines, from) {
  for (let i = from; i < lines.length; i++) {
    if (/^\s*(#|$)/.test(lines[i])) continue
    return { indent: lines[i].match(/^ */)[0].length, text: lines[i].trim() }
  }
  return null
}

// A syntax error carries the line it happened on as a field, not only inside
// the message text, so the import endpoint can report it in the same
// { path, line, message } shape a schema violation uses.
function syntaxError(lineNo, message, path = "") {
  const e = new Error(`line ${lineNo}: ${message}`)
  e.line = lineNo
  e.path = path
  return e
}

// Parse, and also record WHERE every value came from: `lines` maps a dotted
// YAML path (`rag.retrieval.top_k`, `guardrails[1]`) to its 1-based line, so a
// schema violation can be reported against the offending line instead of the
// whole file. One parser — parseYamlSubset() below is this function's value half.
export function parseYamlWithLines(text) {
  const lines = String(text ?? "").split(/\r?\n/)
  const root = {}
  const at = {}
  // childIndent pins the column every child of a block must sit at, so a
  // mis-indented key is an error instead of being silently reparented (which
  // would read `top_k: 6` as a top-level key nobody validates).
  const stack = [{ indent: -1, node: root, childIndent: null, path: "" }]
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]
    const lineNo = i + 1
    if (/^\s*(#|$)/.test(raw)) continue
    if (/^\s*\t/.test(raw)) throw syntaxError(lineNo, "tabs are not valid YAML indentation — use spaces")
    if (raw.trim() === "---" || raw.trim() === "...") throw syntaxError(lineNo, "multi-document files are not supported — one agent config per file")
    const indent = raw.match(/^ */)[0].length
    const line = stripComment(raw.trim())
    if (!line) continue
    const isItem = line === "-" || line.startsWith("- ")
    // A sequence may sit at its key's own indent (`guardrails:` then `- x` in
    // column 0), so only a non-item line at equal indent closes a list.
    while (stack.length > 1) {
      const top = stack[stack.length - 1]
      if (indent < top.indent || (indent === top.indent && !(isItem && Array.isArray(top.node)))) stack.pop()
      else break
    }
    const frame = stack[stack.length - 1]
    if (frame.childIndent === null) frame.childIndent = indent
    else if (indent !== frame.childIndent) throw syntaxError(lineNo, `unexpected indentation — this block's entries start at column ${frame.childIndent + 1}`, frame.path)
    const parent = frame.node
    if (isItem) {
      if (!Array.isArray(parent)) throw syntaxError(lineNo, `list item "${line}" has no list key above it`, frame.path)
      const item = line.slice(1).trim()
      if (!item) throw syntaxError(lineNo, "empty list item", frame.path)
      if (/^[A-Za-z0-9_.-]+:(\s|$)/.test(item)) throw syntaxError(lineNo, "lists of objects are not supported in an agent config", frame.path)
      at[`${frame.path}[${parent.length}]`] = lineNo
      parent.push(scalar(item))
      continue
    }
    if (Array.isArray(parent)) throw syntaxError(lineNo, `"${line}" is indented as a list item but does not start with "- "`, frame.path)
    const m = line.match(/^([A-Za-z0-9_.-]+):(.*)$/)
    if (!m) throw syntaxError(lineNo, `expected "key: value", got "${line}"`, frame.path)
    const key = m[1], value = m[2].trim()
    const path = frame.path ? `${frame.path}.${key}` : key
    at[path] = lineNo
    if (value === "") {
      const next = nextContent(lines, i + 1)
      parent[key] = next && next.indent >= indent && next.text.startsWith("-") ? [] : {}
      stack.push({ indent, node: parent[key], childIndent: null, path })
    } else {
      if (value.startsWith("[") || value.startsWith("{")) throw syntaxError(lineNo, "flow collections ([a, b] / {a: b}) are not supported — use an indented block", path)
      if (value === "|" || value === ">") throw syntaxError(lineNo, "block scalars are not supported — system_prompt must be a file reference, not inline text", path)
      parent[key] = scalar(value)
    }
  }
  return { value: root, lines: at }
}

export function parseYamlSubset(text) {
  return parseYamlWithLines(text).value
}

const TOP_KEYS = ["name", "model", "system_prompt", "rag", "memory", "guardrails", "eval"]
const MEMORY_SCOPES = ["per-user", "per-session", "shared"]

const isMap = v => !!v && typeof v === "object" && !Array.isArray(v)

// Validate + normalize into the shape the wizard state and the domain harness
// use (camelCase). `errors` blocks the import; `warnings` are shown but let it
// through — notably the platform-locked guardrails an imported list omits,
// which the platform re-adds rather than honoring the omission.
export function normalizeAgentConfig(raw, { approvedModelIds = [], knownGuardrailIds = [], lockedGuardrailIds = [] } = {}) {
  const errors = [], warnings = []
  if (!isMap(raw)) return { ok: false, errors: ["The file did not parse to a mapping of keys."], warnings, config: null }
  for (const k of Object.keys(raw)) if (!TOP_KEYS.includes(k)) warnings.push(`Ignored unknown key "${k}" — an agent config carries ${TOP_KEYS.join(", ")}.`)

  const name = typeof raw.name === "string" ? raw.name.trim() : ""
  if (!name) errors.push('"name" is required — it becomes the project name.')
  else if (!/^[a-z0-9][a-z0-9-]{1,40}$/.test(name)) errors.push(`"name" must be lowercase letters, digits and dashes (got "${name}").`)

  let model = null
  if (raw.model != null) {
    model = String(raw.model).trim()
    if (approvedModelIds.length && !approvedModelIds.includes(model))
      errors.push(`Model "${model}" is not on the approved list for your domain — pick one the AI Registry has APPROVED.`)
  }

  let systemPromptFile = null
  if (raw.system_prompt != null) {
    systemPromptFile = String(raw.system_prompt).trim()
    if (!/^[\w./-]+\.(md|markdown|txt)$/.test(systemPromptFile) || systemPromptFile.startsWith("/") || systemPromptFile.includes(".."))
      errors.push(`"system_prompt" must be a relative file reference inside the repo (e.g. app/chat_agent/instructions.md), not inline text — got "${systemPromptFile}".`)
  }

  let rag = null
  if (raw.rag != null) {
    if (!isMap(raw.rag)) errors.push('"rag" must be a block with datasource / index / retrieval.')
    else {
      const ret = isMap(raw.rag.retrieval) ? raw.rag.retrieval : {}
      const topK = ret.top_k == null ? null : Number(ret.top_k)
      if (topK != null && (!Number.isInteger(topK) || topK < 1 || topK > 50)) errors.push('"rag.retrieval.top_k" must be a whole number between 1 and 50.')
      if (!raw.rag.datasource) errors.push('"rag" needs a "datasource".')
      rag = {
        datasource: raw.rag.datasource ? String(raw.rag.datasource) : null,
        index: raw.rag.index ? String(raw.rag.index) : null,
        retrieval: { topK, rerank: ret.rerank === true },
      }
    }
  }

  let memory = null
  if (raw.memory != null) {
    if (!isMap(raw.memory)) errors.push('"memory" must be a block with retention_days / scope.')
    else {
      const days = raw.memory.retention_days == null ? null : Number(raw.memory.retention_days)
      if (days != null && (!Number.isInteger(days) || days < 1 || days > 365)) errors.push('"memory.retention_days" must be a whole number of days between 1 and 365.')
      const scope = raw.memory.scope == null ? null : String(raw.memory.scope)
      if (scope && !MEMORY_SCOPES.includes(scope)) errors.push(`"memory.scope" must be one of ${MEMORY_SCOPES.join(", ")} (got "${scope}").`)
      memory = { retentionDays: days, scope }
    }
  }

  let guardrails = null
  if (raw.guardrails != null) {
    if (!Array.isArray(raw.guardrails)) errors.push('"guardrails" must be a list of guardrail ids.')
    else {
      guardrails = raw.guardrails.map(g => String(g))
      const unknown = knownGuardrailIds.length ? guardrails.filter(g => !knownGuardrailIds.includes(g)) : []
      if (unknown.length) errors.push(`Unknown guardrail id${unknown.length > 1 ? "s" : ""} ${unknown.map(u => `"${u}"`).join(", ")} — valid ids: ${knownGuardrailIds.join(", ")}.`)
    }
  }
  // Enforcement is the platform's call, not the file's: a config that omits a
  // locked guardrail does not disable it, so say so instead of failing.
  const lockedAdded = lockedGuardrailIds.filter(g => !(guardrails || []).includes(g))
  if (lockedAdded.length) warnings.push(`Platform-enforced guardrails your config did not list are added anyway: ${lockedAdded.join(", ")}.`)

  let evalCfg = null
  if (raw.eval != null) {
    if (!isMap(raw.eval)) errors.push('"eval" must be a block with golden_dataset / threshold.')
    else {
      const threshold = raw.eval.threshold == null ? null : Number(raw.eval.threshold)
      if (threshold != null && !(threshold > 0 && threshold <= 1))
        errors.push(`"eval.threshold" is a pass rate between 0 and 1 — write 0.8, not ${raw.eval.threshold}.`)
      evalCfg = { goldenDataset: raw.eval.golden_dataset ? String(raw.eval.golden_dataset) : null, threshold }
    }
  }

  const config = {
    name, model, systemPromptFile, rag, memory,
    guardrails: guardrails || [],
    effectiveGuardrails: [...new Set([...lockedGuardrailIds, ...(guardrails || [])])],
    lockedGuardrails: [...lockedGuardrailIds],
    eval: evalCfg,
  }
  return { ok: !errors.length, errors, warnings, config: errors.length ? null : config }
}
