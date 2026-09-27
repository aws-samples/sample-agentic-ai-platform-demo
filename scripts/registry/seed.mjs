#!/usr/bin/env node
// Seed the real AWS Agent Registry in the active AWS account.
//
// Contract used here is the agent-registry-control API (migrated from the
// public-preview bedrock-agentcore namespace, which is discontinued 2026-09-17):
//   - A2AAgent -> recordType AGENT (descriptors.a2aAgentCard)
//   - Skill -> recordType SKILL (descriptors.agentSkillsDefinition)
//   - Blueprint -> recordType CUSTOM (descriptors.custom)
//   - MCPServer entries are not registry records; they attach to AgentCore Gateway.
//
// The script is intentionally idempotent. If a record name/version already
// exists, it reuses that record and applies approval/tagging as needed.
import { readFileSync, writeFileSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import {
  AgentRegistryControlClient,
  CreateRegistryCommand,
  CreateRegistryRecordCommand,
  GetRegistryCommand,
  GetRegistryRecordCommand,
  ListRegistriesCommand,
  ListRegistryRecordsCommand,
  SubmitRegistryRecordForApprovalCommand,
  TagResourceCommand,
  UpdateRegistryRecordStatusCommand,
} from "@aws-sdk/client-agent-registry-control"

const REGION = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || "us-west-2"
const REGISTRY_NAME_PREFIX = process.env.REGISTRY_NAME_PREFIX || "platform_demo"
const CONSOLE_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "console")
const CONFIG_PATH = join(CONSOLE_DIR, "registry-config.json")
const TAGS = { project: "agentic-ai-platform-demo", managedBy: "seed", "auto-delete": "no" }

const cp = new AgentRegistryControlClient({ region: REGION })

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const sanitizeName = s => {
  const n = String(s).replace(/[^A-Za-z0-9_.\-/]/g, "_")
  return /^[A-Za-z]/.test(n) ? n : `x_${n}`
}
const sanitizeRegistryName = s => {
  const n = String(s).replace(/[^A-Za-z0-9_]/g, "_")
  return /^[A-Za-z]/.test(n) ? n : `x_${n}`
}
const registryNameForDomain = domainId =>
  sanitizeRegistryName(`${REGISTRY_NAME_PREFIX}_${String(domainId).replace(/-/g, "_")}`)
const isConflict = e => e?.name === "ConflictException" || /already exists|conflict/i.test(String(e?.message || ""))

async function tagArn(resourceArn, label) {
  if (!resourceArn) return
  try {
    await cp.send(new TagResourceCommand({ resourceArn, tags: TAGS }))
  } catch (e) {
    console.warn(`  tag ${label}: skipped (${e.name || "Error"}: ${e.message})`)
  }
}

async function getRegistry(registryId) {
  if (!registryId) return null
  try {
    return await cp.send(new GetRegistryCommand({ registryId }))
  } catch {
    return null
  }
}

async function findRegistryByName(name) {
  const matches = []
  let nextToken
  do {
    const r = await cp.send(new ListRegistriesCommand({ maxResults: 50, nextToken }))
    matches.push(...(r.registries || []).filter(x => x.name === name))
    nextToken = r.nextToken
  } while (nextToken)
  return matches.find(r => r.status === "READY")
    || matches.find(r => !String(r.status || "").endsWith("_FAILED"))
    || matches[0]
    || null
}

async function ensureRegistry(target) {
  let registry = target.registryId ? await getRegistry(target.registryId) : null
  if (!registry || registry.status === "CREATE_FAILED") registry = await findRegistryByName(target.name)
  if (registry?.status === "READY") {
    console.log(`registry ${target.name}: exists (${registry.registryId}, READY)`)
    await tagArn(registry.registryArn, `registry ${target.name}`)
    return registry
  }
  if (registry && registry.status !== "CREATE_FAILED") {
    console.log(`registry ${target.name}: waiting for ${registry.status} (${registry.registryId})`)
  } else {
    // new API: omitting approvalConfiguration.autoApprovalRules = manual approval
    // (replaces the old autoApproval: false)
    const created = await cp.send(new CreateRegistryCommand({
      name: target.name,
      description: target.description,
    }))
    registry = { registryArn: created.registryArn, registryId: created.registryArn.split("/").pop() }
    console.log(`registry ${target.name}: created (${registry.registryId}), waiting for READY`)
  }
  for (let i = 0; i < 36; i++) {
    await sleep(5000)
    const found = await getRegistry(registry.registryId) || await findRegistryByName(target.name)
    if (found?.status === "READY") {
      await tagArn(found.registryArn, `registry ${target.name}`)
      console.log(`registry ${target.name}: READY`)
      return found
    }
    if (found && !["CREATING", "UPDATING", "READY"].includes(found.status)) {
      throw new Error(`registry ${target.name} entered ${found.status}: ${found.statusReason || "no reason"}`)
    }
  }
  throw new Error(`registry ${target.name} did not reach READY in time`)
}

async function findRecord(registryId, name, recordVersion) {
  let nextToken
  do {
    // new API: name is a structured filter, not a top-level param
    const r = await cp.send(new ListRegistryRecordsCommand({
      registryId, maxResults: 50, nextToken,
      filters: [{ name: "name", values: [name] }],
    }))
    const hit = (r.registryRecords || []).find(x => x.name === name && x.recordVersion === recordVersion)
    if (hit) return hit
    nextToken = r.nextToken
  } while (nextToken)
  return null
}

async function getRecord(registryId, recordId) {
  return cp.send(new GetRegistryRecordCommand({ registryId, recordId }))
}

async function waitForRecord(registryId, recordId) {
  let record = await getRecord(registryId, recordId)
  for (let i = 0; ["CREATING", "UPDATING"].includes(record.status) && i < 36; i++) {
    await sleep(2500)
    record = await getRecord(registryId, recordId)
  }
  return record
}

async function ensureRecord(registryId, input) {
  try {
    const r = await cp.send(new CreateRegistryRecordCommand({ registryId, ...input }))
    const recordId = r.recordId || r.recordArn?.split("/").pop()
    console.log(`  record ${input.name}@${input.recordVersion}: created (${r.status})`)
    await tagArn(r.recordArn, `record ${input.name}@${input.recordVersion}`)
    return { recordId, status: r.status, recordArn: r.recordArn, created: true }
  } catch (e) {
    if (!isConflict(e)) throw e
    const existing = await findRecord(registryId, input.name, input.recordVersion)
    if (!existing) throw new Error(`record ${input.name}@${input.recordVersion} conflicted but was not returned by list`)
    console.log(`  record ${input.name}@${input.recordVersion}: exists (${existing.status})`)
    await tagArn(existing.recordArn, `record ${input.name}@${input.recordVersion}`)
    return { recordId: existing.recordId, status: existing.status, recordArn: existing.recordArn, created: false }
  }
}

async function approveRecord(registryId, recordId, label, currentStatus) {
  let record = currentStatus === "CREATING" || currentStatus === "UPDATING"
    ? await waitForRecord(registryId, recordId)
    : await getRecord(registryId, recordId)
  if (record.status === "APPROVED") return
  if (record.status === "DRAFT") {
    await cp.send(new SubmitRegistryRecordForApprovalCommand({ registryId, recordId }))
    record = await waitForRecord(registryId, recordId)
  }
  if (record.status === "PENDING_APPROVAL") {
    await cp.send(new UpdateRegistryRecordStatusCommand({
      registryId,
      recordId,
      status: "APPROVED",
      statusReason: "Seeded platform-curated entry; approved by seed script acting as platform admin.",
    }))
    console.log(`  record ${label}: APPROVED`)
    return
  }
  console.log(`  record ${label}: status ${record.status}, not approving`)
}

function a2aDescriptor(entry, version) {
  const c = version.content || {}
  const card = {
    protocolVersion: "0.3.0",
    name: c.card?.name || entry.name,
    description: c.card?.description || entry.description,
    url: c.baseUrl,
    preferredTransport: "JSONRPC",
    version: c.card?.version || version.semver,
    provider: c.card?.provider,
    documentationUrl: c.card?.documentationUrl,
    capabilities: c.card?.capabilities || {},
    authentication: c.card?.authentication,
    defaultInputModes: c.card?.defaultInputModes || ["text/plain"],
    defaultOutputModes: c.card?.defaultOutputModes || ["text/plain"],
    skills: c.card?.skills || [],
    "x-platform": {
      id: entry.id,
      displayName: entry.name,
      domain: entry.domain,
      governanceMode: entry.governanceMode,
      domainOwner: entry.domainOwner,
      access: c.access || ["admin"],
      changelog: version.changelog,
      createdBy: version.createdBy,
    },
  }
  return { a2aAgentCard: { dataSchemaVersion: "0.3.0", data: JSON.stringify(card) } }
}

function skillDescriptor(entry, version) {
  const c = version.content || {}
  const slug = String(entry.id).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64)
  const definition = {
    id: entry.id,
    name: slug,
    displayName: entry.name,
    description: entry.description,
    tags: [entry.domain, c.toolType || "skill"].filter(Boolean),
    "x-platform": {
      id: entry.id,
      displayName: entry.name,
      domain: entry.domain,
      governanceMode: entry.governanceMode,
      domainOwner: entry.domainOwner,
      tools: c.tools || [],
      toolType: c.toolType || null,
      gateway: c.gateway || null,
      auth: c.auth || null,
      access: c.access || ["admin", "builder"],
      changelog: version.changelog,
      createdBy: version.createdBy,
    },
  }
  const skillMd = [
    "---",
    `name: ${slug}`,
    `description: ${entry.description}`,
    "---",
    "",
    `# ${entry.name}`,
    "",
    entry.description,
    "",
    c.toolType
      ? `Typed tool (${c.toolType})${c.gateway ? ` served via the \`${c.gateway}\` gateway` : ""}.`
      : `Tools used: ${(c.tools || []).join(", ") || "none"}.`,
  ].join("\n")
  return {
    agentSkillsDefinition: {
      dataSchemaVersion: "0.1.0",
      data: JSON.stringify(definition),
      additionalData: { skillMd: { data: skillMd } },
    },
  }
}

function blueprintDescriptor(bp, compat, version) {
  return {
    custom: {
      data: JSON.stringify({
        resourceKind: "blueprint",
        blueprintId: bp.id,
        displayName: bp.name,
        useCase: bp.useCase,
        icon: bp.icon,
        template: bp.template || {},
        compat,
        git: { repo: "github.com/aws-samples/sample-agentic-ai-platform-demo", path: `blueprints/${bp.id}`, ref: "main" },
        version,
        defaultVersion: version,
      }),
    },
  }
}

async function main() {
  const domains = JSON.parse(readFileSync(join(CONSOLE_DIR, "domains.json"), "utf8"))
  const seed = JSON.parse(readFileSync(join(CONSOLE_DIR, "registry-seed.json"), "utf8"))
  const catalog = JSON.parse(readFileSync(join(CONSOLE_DIR, "catalog.json"), "utf8"))

  const targets = {
    shared: {
      name: registryNameForDomain("shared"),
      description: "Platform shared: blueprints, skills, A2A agents",
    },
    domains: Object.fromEntries(domains.map(d => [d.id, {
      name: registryNameForDomain(d.id),
      description: d.description || `${d.name || d.id} domain registry`,
    }])),
  }

  console.log(`Seeding Bedrock AgentCore registry in ${REGION} with prefix ${REGISTRY_NAME_PREFIX}`)

  const shared = await ensureRegistry(targets.shared)
  const domainRegistries = {}
  for (const [domain, target] of Object.entries(targets.domains)) {
    domainRegistries[domain] = await ensureRegistry(target)
  }

  const registryFor = domain =>
    domain && domain !== "shared" && domainRegistries[domain] ? domainRegistries[domain] : shared

  const counts = { AGENT: 0, SKILL: 0, CUSTOM: 0, skippedMcp: 0 }
  for (const entry of seed) {
    if (entry.type === "MCPServer") {
      counts.skippedMcp++
      console.log(`skip ${entry.id} (MCPServer: gateway target, not registry record)`)
      continue
    }
    if (!["A2AAgent", "Skill"].includes(entry.type)) continue
    const registry = registryFor(entry.domain)
    const recordType = entry.type === "A2AAgent" ? "AGENT" : "SKILL"
    const prefix = entry.type === "A2AAgent" ? "a2a" : "skill"
    const name = sanitizeName(`${prefix}_${entry.id}`)
    console.log(`${entry.type} ${entry.id} -> ${recordType} "${name}" in ${registry.name}`)
    for (const version of entry.versions || []) {
      const descriptors = entry.type === "A2AAgent" ? a2aDescriptor(entry, version) : skillDescriptor(entry, version)
      const { recordId, status } = await ensureRecord(registry.registryId, {
        name,
        displayName: entry.name || entry.id,
        description: entry.description || entry.name,
        recordType,
        descriptors,
        recordVersion: version.semver,
      })
      counts[recordType]++
      if (version.status === "APPROVED") await approveRecord(registry.registryId, recordId, `${name}@${version.semver}`, status)
      else console.log(`  record ${name}@${version.semver}: seed status ${version.status}; left as draft/governance content`)
    }
  }

  const compat = catalog.blueprintOptions?.compatibility || {}
  for (const bp of catalog.blueprints || []) {
    const name = sanitizeName(`blueprint_${bp.id}`)
    console.log(`Blueprint ${bp.id} -> CUSTOM "${name}" in ${shared.name}`)
    const { recordId, status } = await ensureRecord(shared.registryId, {
      name,
      displayName: bp.name || bp.id,
      description: bp.useCase || bp.name,
      recordType: "CUSTOM",
      descriptors: blueprintDescriptor(bp, compat, "1.0.0"),
      recordVersion: "1.0.0",
    })
    counts.CUSTOM++
    await approveRecord(shared.registryId, recordId, `${name}@1.0.0`, status)
  }

  let existingConfig = {}
  try { existingConfig = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) } catch {}
  const config = {
    ...existingConfig,
    region: REGION,
    seededAt: new Date().toISOString(),
    registries: {
      shared: { name: shared.name, registryId: shared.registryId, registryArn: shared.registryArn },
      domains: Object.fromEntries(Object.entries(domainRegistries).map(([id, r]) =>
        [id, { name: r.name, registryId: r.registryId, registryArn: r.registryArn }])),
    },
  }
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n")
  console.log(`\nWrote ${CONFIG_PATH}`)
  console.log(`Done. Records touched: AGENT=${counts.AGENT} SKILL=${counts.SKILL} CUSTOM(blueprint)=${counts.CUSTOM}; MCPServer entries skipped=${counts.skippedMcp}`)
}

// run only when executed directly; importable for targeted verification
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(e => { console.error("Seed failed:", e); process.exit(1) })
}

export { ensureRecord, approveRecord, getRecord, findRecord, a2aDescriptor, skillDescriptor, blueprintDescriptor }
