// Typed validation of an uploaded agent-config.yaml, BEFORE anything is applied.
//
// schemas/agent-config.schema.json is the single source of truth for what the
// file may contain; this module walks it and reports every violation as
// { path, line, message } — the YAML path AND the line the offending field sits
// on, so a builder fixes the file instead of guessing which of 40 lines the
// console disliked.
//
// Two layers, in order:
//  1. PLATFORM-LOCKED BASELINE (x-platform-locked in the schema). Identity,
//     observability and the org/domain-enforced guardrails are merged by the
//     platform on generate. A config that tries to SET or OVERRIDE one is
//     rejected outright — the persona-privilege negative case — because
//     silently ignoring it lets the author believe the override worked. When
//     this layer bites it is the only thing reported: the privilege violation
//     is the headline, not the type errors derived from it.
//  2. THE SCHEMA itself.
//
// normalizeAgentConfig() still runs after, for the GOVERNED-VOCABULARY checks a
// schema cannot express (is this model APPROVED for *your* domain, is this
// guardrail id one the console really knows) — schema-valid is necessary, not
// sufficient.
//
// No JSON-Schema library: the console ships with no runtime dependencies (see
// the agent-config.mjs header), so the keyword subset the schema actually uses
// is walked here — type, required, properties, additionalProperties, enum,
// pattern, minLength, minimum/maximum/exclusiveMinimum, items, uniqueItems,
// minItems. A keyword the walker does not implement would silently go
// unchecked, so schemaKeywordGaps() below is asserted empty by the unit tests.
import { readFileSync } from "node:fs"
import { parseYamlWithLines } from "./agent-config.mjs"

export const SCHEMA_PATH = new URL("../schemas/agent-config.schema.json", import.meta.url)
export const AGENT_CONFIG_SCHEMA = JSON.parse(readFileSync(SCHEMA_PATH, "utf8"))

const SUPPORTED_KEYWORDS = new Set([
  "$schema", "$id", "title", "description", "x-platform-locked", "x-hint",
  "type", "required", "properties", "additionalProperties",
  "enum", "pattern", "minLength", "minimum", "maximum", "exclusiveMinimum",
  "items", "uniqueItems", "minItems",
])

// Every keyword used anywhere in the schema that the walker does not implement.
// Asserted empty by the tests, so adding an unimplemented keyword to the schema
// file fails the suite instead of quietly skipping that constraint.
export function schemaKeywordGaps(schema = AGENT_CONFIG_SCHEMA, out = []) {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return out
  for (const [k, v] of Object.entries(schema)) {
    if (!SUPPORTED_KEYWORDS.has(k)) out.push(k)
    if (k === "properties") for (const sub of Object.values(v)) schemaKeywordGaps(sub, out)
    else if (k === "items") schemaKeywordGaps(v, out)
  }
  return out
}

// The line a path sits on, falling back to its nearest recorded ancestor: a
// missing required key has no line of its own, so it is reported against the
// block that should have carried it (line 1 for a top-level omission).
function lineOf(lines, path) {
  let p = path
  while (p) {
    if (lines[p] != null) return lines[p]
    const cut = Math.max(p.lastIndexOf("."), p.lastIndexOf("["))
    p = cut < 0 ? "" : p.slice(0, cut)
  }
  return 1
}

const join = (base, key) => (base ? `${base}.${key}` : key)
const typeName = v => (v === null ? "nothing" : Array.isArray(v) ? "a list" : typeof v === "object" ? "a block" : typeof v)
const WANTED = { integer: "a whole number", number: "a number", array: "a list", object: "a block", string: "text", boolean: "true or false" }

function typeMatches(value, type) {
  if (type === "integer") return Number.isInteger(value)
  if (type === "number") return typeof value === "number" && Number.isFinite(value)
  if (type === "array") return Array.isArray(value)
  if (type === "object") return !!value && typeof value === "object" && !Array.isArray(value)
  return typeof value === type
}

function walk(value, schema, path, lines, out) {
  const add = message => out.push({ path, line: lineOf(lines, path), message })

  if (schema.type && !typeMatches(value, schema.type)) {
    // Every other keyword would just restate the same mistake.
    add(`must be ${WANTED[schema.type] || schema.type}, got ${typeName(value)}.`)
    return out
  }
  if (schema.enum && !schema.enum.includes(value)) add(`must be one of ${schema.enum.join(", ")} (got "${value}").`)
  if (typeof value === "string") {
    if (schema.minLength != null && value.length < schema.minLength) add(`must not be empty.`)
    // x-hint is the short "here is what this field takes" line; `description`
    // explains the policy to a reader of the schema and is too long to throw at
    // someone who just mistyped a path.
    if (schema.pattern && !new RegExp(schema.pattern, "u").test(value))
      add(`"${value}" is not an accepted value — ${schema["x-hint"] || `expected ${schema.pattern}`}`)
  }
  if (typeof value === "number") {
    if (schema.minimum != null && value < schema.minimum) add(`must be at least ${schema.minimum} (got ${value}).`)
    if (schema.maximum != null && value > schema.maximum) add(`must be at most ${schema.maximum} (got ${value}).`)
    if (schema.exclusiveMinimum != null && value <= schema.exclusiveMinimum) add(`must be greater than ${schema.exclusiveMinimum} (got ${value}).`)
  }
  if (Array.isArray(value)) {
    if (schema.minItems != null && value.length < schema.minItems) add(`needs at least ${schema.minItems} entr${schema.minItems === 1 ? "y" : "ies"}.`)
    if (schema.uniqueItems) {
      const seen = new Set()
      value.forEach((v, i) => {
        const k = JSON.stringify(v)
        if (seen.has(k)) out.push({ path: `${path}[${i}]`, line: lineOf(lines, `${path}[${i}]`), message: `duplicate entry "${v}" — list it once.` })
        seen.add(k)
      })
    }
    if (schema.items) value.forEach((v, i) => walk(v, schema.items, `${path}[${i}]`, lines, out))
  }
  if (typeMatches(value, "object")) {
    for (const key of schema.required || []) {
      // null is how this YAML subset spells "written but empty"; the rest of the
      // console reads that as absent, so required means "present and set".
      if (value[key] == null) {
        const p = join(path, key)
        out.push({ path: p, line: lineOf(lines, p), message: `is required.` })
      }
    }
    if (schema.additionalProperties === false) {
      const allowed = Object.keys(schema.properties || {})
      for (const key of Object.keys(value)) {
        if (allowed.includes(key)) continue
        const p = join(path, key)
        out.push({ path: p, line: lineOf(lines, p), message: `is not a field an agent config carries here — allowed: ${allowed.join(", ")}.` })
      }
    }
    for (const [key, sub] of Object.entries(schema.properties || {})) {
      // An absent OR explicitly-empty optional key is simply not set (the same
      // rule normalizeAgentConfig applies), so it is not validated further.
      if (value[key] == null) continue
      walk(value[key], sub, join(path, key), lines, out)
    }
  }
  return out
}

// Layer 1: the platform baseline a config may not touch.
function lockedBaselineIssues(value, lines, lockedGuardrailIds) {
  const locked = AGENT_CONFIG_SCHEMA["x-platform-locked"] || {}
  const out = []
  for (const key of locked.reservedKeys || []) {
    if (!(key in value)) continue
    out.push({ path: key, line: lineOf(lines, key), message: `is a platform-enforced baseline field — the platform merges it on generate; an agent-config.yaml may not set or override it.` })
  }
  // `guardrails:` written as a block of `id: <value>` pairs instead of a flat
  // list is a per-guardrail override attempt. Naming an ENFORCED guardrail that
  // way (typically `pii-filter: false`) is the disable the platform forbids —
  // report it as the baseline violation it is, not as "expected a list".
  if (value.guardrails && typeof value.guardrails === "object" && !Array.isArray(value.guardrails)) {
    for (const id of Object.keys(value.guardrails)) {
      if (!lockedGuardrailIds.includes(id)) continue
      const p = `guardrails.${id}`
      out.push({ path: p, line: lineOf(lines, p), message: `"${id}" ${locked.guardrailBaselineMessage || "is platform-enforced and may not be overridden."}` })
    }
  }
  return out
}

// Validate raw YAML text against the committed schema.
// -> { ok, issues: [{ path, line, message }], value, lines }
export function validateAgentConfigYaml(text, { lockedGuardrailIds = [] } = {}) {
  let parsed
  try {
    parsed = parseYamlWithLines(text)
  } catch (e) {
    // Malformed YAML: the parser already knows the line (and the block it was
    // in) — report it in the same shape a schema violation uses.
    return { ok: false, issues: [{ path: e.path || "", line: e.line || 1, message: String(e.message).replace(/^line \d+: /, "") }] }
  }
  const { value, lines } = parsed
  if (!value || typeof value !== "object" || Array.isArray(value))
    return { ok: false, issues: [{ path: "", line: 1, message: "The file did not parse to a mapping of keys." }] }

  const locked = lockedBaselineIssues(value, lines, lockedGuardrailIds)
  if (locked.length) return { ok: false, issues: locked, value, lines }

  const issues = walk(value, AGENT_CONFIG_SCHEMA, "", lines, [])
  return { ok: !issues.length, issues, value, lines }
}

// One line per issue for the surfaces that show a flat error list (the wizard's
// import panel, /api/generate's `errors`), so the line number reaches the user
// even where the typed `issues` array is not consumed.
export const formatIssue = i => `line ${i.line}${i.path ? ` · ${i.path}` : ""} — ${i.message}`
