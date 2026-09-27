// AWS Agent Registry backend for the console (agent-registry namespace;
// migrated from the public-preview bedrock-agentcore namespace, which is
// discontinued 2026-09-17).
// Read path: control-plane ListRegistryRecords/GetRegistryRecord per registry
// (owner view — DRAFT/PENDING/REJECTED included, D6) mapped back into the
// legacy ai-registry entry shape the frontend already renders. Search:
// local filtering over real control-plane records. Writes:
// UpdateRegistryRecordStatus (approve/reject),
// CreateRegistryRecord(DRAFT)+SubmitRegistryRecordForApproval.
// MCP servers are NOT registry records (D9) — the console's MCP list reads the
// tools gateway's target list, mapped by gatewayTargetToMcpEntry below.
//
// All AWS clients are injectable so unit tests run on recorded fixtures with
// no live AWS.
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { spawn } from "node:child_process"
import {
  assertUniqueEntryIds,
  gatewayTargetToMcpEntry,
  legacyStatus,
  recordToVersion,
  recordsToEntries,
} from "./registry-shape.mjs"

export {
  assertUniqueEntryIds,
  gatewayTargetToMcpEntry,
  legacyStatus,
  recordToVersion,
  recordsToEntries,
}

// ---- config -------------------------------------------------------------------

export function loadRegistryConfig(consoleDir) {
  try { return JSON.parse(readFileSync(join(consoleDir, "registry-config.json"), "utf8")) } catch { return null }
}

// ---- descriptor synthesis for the write path (propose) -------------------------

const GOVERNED_DESCRIPTOR_SCHEMA_VERSION = 1
const GOVERNED_RECORD_VERSION_BUILD = "platform-descriptor.1"
const PLATFORM_BOOTSTRAP_OWNER_SUBJECT = "platform-bootstrap"
const SUBJECT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/

const governedDomainId = domain => String(domain).replaceAll("-", "_")
const governedRecordVersion = version => {
  const [withoutBuild, build = ""] = version.split("+", 2)
  const governedSuffix = `.${GOVERNED_RECORD_VERSION_BUILD}`
  if (
    withoutBuild.endsWith(`-${GOVERNED_RECORD_VERSION_BUILD}`)
    || withoutBuild.endsWith(governedSuffix)
  ) return withoutBuild
  const retainedBuild = build === GOVERNED_RECORD_VERSION_BUILD
    || build.endsWith(governedSuffix)
    ? build.slice(0, -governedSuffix.length)
    : build
  const separator = withoutBuild.includes("-") ? "." : "-"
  return `${withoutBuild}${separator}${[
    retainedBuild,
    GOVERNED_RECORD_VERSION_BUILD,
  ].filter(Boolean).join(".")}`
}
const trustedOwnerSubject = value =>
  typeof value === "string" && SUBJECT_PATTERN.test(value)
    ? value
    : PLATFORM_BOOTSTRAP_OWNER_SUBJECT
const governedDescriptor = (document, {
  domain,
  ownerSubject,
  resourceId,
  resourceType,
}) => ({
  ...document,
  schemaVersion: GOVERNED_DESCRIPTOR_SCHEMA_VERSION,
  "x-platform": {
    domainId: governedDomainId(domain),
    ownerSubject,
    resourceId,
    resourceType,
    shared: domain === "shared",
  },
})

export function buildDescriptors(type, {
  id,
  name,
  description,
  content = {},
  semver,
  domain,
}) {
  if (!["A2AAgent", "Skill", "Blueprint"].includes(type)) return null
  const selectedDomain = domain ?? content.domain ?? "shared"
  const ownerSubject = trustedOwnerSubject(content.createdBy)
  const recordVersion = governedRecordVersion(semver)
  if (type === "A2AAgent") {
    const card = governedDescriptor({
      ...content.card,
      resourceKind: "agent",
      protocolVersion: content.card?.protocolVersion || "0.3.0",
      name,
      description,
      url: content.baseUrl || null, preferredTransport: "JSONRPC", version: semver,
      capabilities: content.card?.capabilities || {},
      authentication: content.card?.authentication,
      defaultInputModes: content.card?.defaultInputModes || ["text/plain"],
      defaultOutputModes: content.card?.defaultOutputModes || ["text/plain"],
      skills: content.card?.skills || [],
      "x-platform-metadata": {
        displayName: name,
        domain: selectedDomain,
        governanceMode: content.governanceMode || "federated",
        domainOwner: content.domainOwner || null,
        access: content.access || ["admin"],
        createdBy: ownerSubject,
        changelog: content.changelog,
      },
    }, {
      domain: selectedDomain,
      ownerSubject,
      resourceId: id,
      resourceType: "AGENT",
    })
    return {
      recordType: "AGENT",
      recordVersion,
      descriptors: {
        a2aAgentCard: {
          dataSchemaVersion: "0.3.0",
          data: JSON.stringify(card),
        },
      },
    }
  }
  if (type === "Skill") {
    const slug = String(id).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")
    const definition = governedDescriptor({
      resourceKind: "skill",
      id, name: slug, displayName: name, description,
      tags: [selectedDomain, content.toolType || "skill"].filter(Boolean),
      "x-platform-metadata": {
        displayName: name,
        domain: selectedDomain,
        governanceMode: content.governanceMode || "owned",
        domainOwner: content.domainOwner || null,
        tools: content.tools || [],
        toolType: content.toolType || null,
        gateway: content.gateway || null,
        auth: content.auth || null,
        access: content.access || ["admin", "builder"],
        createdBy: ownerSubject,
        changelog: content.changelog,
      },
    }, {
      domain: selectedDomain,
      ownerSubject,
      resourceId: id,
      resourceType: "SKILL",
    })
    const skillMd = ["---", `name: ${slug}`, `description: ${description}`, "---", "", `# ${name}`, "", description].join("\n")
    return {
      recordType: "SKILL",
      recordVersion,
      descriptors: {
        agentSkillsDefinition: {
          dataSchemaVersion: "0.1.0",
          data: JSON.stringify(definition),
          additionalData: { skillMd: { data: skillMd } },
        },
      },
    }
  }
  if (type === "Blueprint") {
    const blueprint = governedDescriptor({
      resourceKind: "blueprint",
      blueprintId: id,
      displayName: name,
      useCase: description,
      icon: content.icon,
      template: content.template || {},
      compat: content.compat || {},
      git: content.git,
      version: semver,
      defaultVersion: semver,
      "x-platform-metadata": {
        displayName: name,
        domain: selectedDomain,
        governanceMode: content.governanceMode || "owned",
        domainOwner: content.domainOwner || null,
        createdBy: ownerSubject,
        changelog: content.changelog,
      },
    }, {
      domain: selectedDomain,
      ownerSubject,
      resourceId: id,
      resourceType: "BLUEPRINT",
    })
    return {
      recordType: "CUSTOM",
      recordVersion,
      descriptors: { custom: { data: JSON.stringify(blueprint) } },
    }
  }
}

export const sanitizeRecordName = s => {
  const n = String(s).replace(/[^A-Za-z0-9_]/g, "_")
  return /^[A-Za-z]/.test(n) ? n : `x_${n}`
}
export const RECORD_NAME_PREFIX = { A2AAgent: "a2a", Skill: "skill", Blueprint: "blueprint" }

// ---- backend ------------------------------------------------------------------

function runAwsCli(args, region) {
  return new Promise(resolve => {
    const p = spawn(process.env.AWS_BIN || "aws", [...args, "--region", region, "--output", "json"],
      { env: { ...process.env, PATH: `/usr/local/bin:/opt/homebrew/bin:${process.env.PATH || ""}` } })
    let out = "", err = ""
    p.stdout.on("data", d => (out += d))
    p.stderr.on("data", d => (err += d))
    p.on("close", code => code === 0
      ? resolve(JSON.parse(out || "{}"))
      : resolve({ __error: (err || out).trim() }))
    p.on("error", e => resolve({ __error: String(e.message || e) }))
  })
}

const CACHE_TTL_MS = 20_000

// The live backend. `clients` is injectable for tests:
//   { control } — SDK client instance (or stub with .send)
//   listGatewayTargets(gatewayId, region) — tools-gateway target reader
export function createRegistryBackend(config, clients = {}) {
  const region = config.region || "us-west-2"
  let sdkControl = clients.control || null
  let sdkCommands = clients.commands || null

  async function sdk() {
    if (!sdkCommands) {
      const cp = await import("@aws-sdk/client-agent-registry-control")
      sdkCommands = { cp }
      sdkControl ||= new cp.AgentRegistryControlClient({ region })
    }
    return { control: sdkControl, ...sdkCommands }
  }

  const registries = [
    { key: "shared", domain: "shared", ...config.registries.shared },
    ...Object.entries(config.registries.domains || {}).map(([id, r]) => ({ key: id, domain: id, ...r })),
  ]
  const registryById = Object.fromEntries(registries.map(r => [r.registryId, r]))
  const domainOf = record => registryById[record.registryId]?.domain ?? null

  let cache = { at: 0, entries: null, mcp: null }
  const invalidate = () => { cache = { at: 0, entries: null, mcp: null } }

  // Owner view (D6): control-plane list per registry, then per-record Get for
  // descriptors (summaries carry no descriptors).
  async function fetchEntries() {
    const { control, cp } = await sdk()
    const records = []
    for (const reg of registries) {
      let nextToken
      do {
        const r = await control.send(new cp.ListRegistryRecordsCommand({ registryId: reg.registryId, maxResults: 50, nextToken }))
        for (const s of r.registryRecords || []) records.push({ ...s, registryId: reg.registryId })
        nextToken = r.nextToken
      } while (nextToken)
    }
    const full = await Promise.all(records.map(async s => {
      try {
        const g = await control.send(new cp.GetRegistryRecordCommand({ registryId: s.registryId, recordId: s.recordId }))
        return { ...g, registryId: s.registryId }
      } catch { return s } // fall back to the summary (no descriptors) rather than dropping the record
    }))
    return recordsToEntries(full, domainOf)
  }

  async function fetchMcpEntries() {
    const gw = config.toolsGateway
    if (!gw?.gatewayId) return []
    const list = clients.listGatewayTargets
      ? await clients.listGatewayTargets(gw.gatewayId, region)
      : await runAwsCli(["bedrock-agentcore-control", "list-gateway-targets", "--gateway-identifier", gw.gatewayId], region)
    if (list.__error) {
      console.warn(`registry-client: tools gateway target list failed — ${list.__error}`)
      return []
    }
    return (list.items || []).map(t => gatewayTargetToMcpEntry(t, gw))
  }

  return {
    region,
    registries,

    async entries({ fresh = false } = {}) {
      if (!fresh && cache.entries && Date.now() - cache.at < CACHE_TTL_MS) return cache.entries
      const [regEntries, mcpEntries] = await Promise.all([fetchEntries(), fetchMcpEntries()])
      const entries = assertUniqueEntryIds([...regEntries, ...mcpEntries])
      cache = { at: Date.now(), entries, mcp: mcpEntries }
      return cache.entries
    },

    // Search over real control-plane records. Bedrock AgentCore's CLI/SDK
    // surface currently exposes list/get for registry records here, so the
    // console performs a local text filter after fetching owner-view records.
    async search(query, { domains = null } = {}) {
      const q = String(query || "").toLowerCase()
      const scoped = await fetchEntries()
      return scoped
        .filter(e => !domains || e.domain === "shared" || domains.includes(e.domain))
        .filter(e => (e.versions || []).some(v => v.status === "APPROVED"))
        .filter(e => [e.id, e.name, e.description, e.type].some(v => String(v || "").toLowerCase().includes(q)))
    },

    // Approve/reject (PENDING_APPROVAL → APPROVED|REJECTED) with statusReason.
    async decide({ registryId, recordId, decision, reason, decidedBy }) {
      const { control, cp } = await sdk()
      await control.send(new cp.UpdateRegistryRecordStatusCommand({
        registryId, recordId,
        status: decision === "approve" ? "APPROVED" : "REJECTED",
        statusReason: reason || `${decision === "approve" ? "Approved" : "Rejected"} by ${decidedBy || "platform admin"} via the console Governance queue.`,
      }))
      invalidate()
    },

    // New version registration: CreateRegistryRecord(DRAFT). Submit is separate
    // (the console's propose→submit flow mirrors DRAFT→PENDING_APPROVAL).
    async createRecord({ type, id, name, description, content, semver, domain }) {
      const reg = registries.find(r => r.domain === domain)
      if (!reg) throw new Error("Registry domain is not configured.")
      const built = buildDescriptors(type, {
        id,
        name,
        description,
        content,
        semver,
        domain: reg.domain,
      })
      if (!built) throw new Error(`type ${type} is not a registry-backed type`)
      const recordName = sanitizeRecordName(`${RECORD_NAME_PREFIX[type]}_${id}`)
      const { control, cp } = await sdk()
      const r = await control.send(new cp.CreateRegistryRecordCommand({
        registryId: reg.registryId, name: recordName, displayName: name, description,
        recordType: built.recordType,
        descriptors: built.descriptors,
        recordVersion: built.recordVersion,
      }))
      if (r.recordArn) {
        try {
          await control.send(new cp.TagResourceCommand({
            resourceArn: r.recordArn,
            tags: { project: "agentic-ai-platform-demo", managedBy: "console", "auto-delete": "no" },
          }))
        } catch (e) {
          console.warn(`registry-client: record tag failed — ${e.message}`)
        }
      }
      invalidate()
      return { registryId: reg.registryId, recordId: r.recordId || r.recordArn?.split("/").pop(), recordArn: r.recordArn, status: r.status }
    },

    async submit({ registryId, recordId }) {
      const { control, cp } = await sdk()
      // records are DRAFT only after async creation finishes; brief retry on the gap
      for (let i = 0; ; i++) {
        try {
          await control.send(new cp.SubmitRegistryRecordForApprovalCommand({ registryId, recordId }))
          break
        } catch (e) {
          if (i >= 5 || !/CREATING|Conflict|ValidationException/i.test(`${e.name} ${e.message}`)) throw e
          await new Promise(r => setTimeout(r, 2000))
        }
      }
      invalidate()
    },
  }
}
