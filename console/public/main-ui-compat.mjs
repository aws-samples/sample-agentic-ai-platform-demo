import { costSummary, sumCostValues, validateCostRows } from "./cost-view.mjs";
import { builderModelCatalog } from "./builder-model-catalog.mjs";

function items(response) {
  return response?.ok === true && Array.isArray(response.items)
    ? response.items
    : [];
}

function entries(response) {
  return response?.ok === true && Array.isArray(response.entries)
    ? response.entries
    : [];
}

export function normalizeSelectedResourceIds(selectedIds, approvedChoices) {
  const allowedIds = new Set(
    (Array.isArray(approvedChoices) ? approvedChoices : [])
      .map((choice) => String(choice?.id || "").trim())
      .filter(Boolean),
  );
  const selected = (
    selectedIds
    && typeof selectedIds !== "string"
    && typeof selectedIds[Symbol.iterator] === "function"
  )
    ? selectedIds
    : [];
  const seen = new Set();
  const normalized = [];

  for (const selectedId of selected) {
    const id = String(selectedId || "").trim();
    if (!id || seen.has(id) || !allowedIds.has(id)) continue;
    seen.add(id);
    normalized.push(id);
  }
  return normalized;
}

const PAGINATION_INVALID = {
  ok: false,
  code: "PAGINATION_INVALID",
  message: "The hosted collection pagination response is invalid.",
};

export async function collectPagedItems(readPage, { maxPages = 100 } = {}) {
  if (typeof readPage !== "function" || maxPages < 1) {
    return PAGINATION_INVALID;
  }
  const collected = [];
  const seen = new Set();
  let cursor = null;
  let firstResponse = null;

  for (let page = 0; page < maxPages; page += 1) {
    const response = await readPage(cursor);
    if (response?.ok !== true) return response;
    if (
      !Array.isArray(response.items)
      || !(response.cursor === null || typeof response.cursor === "string")
    ) {
      return PAGINATION_INVALID;
    }
    firstResponse ??= response;
    collected.push(...response.items);
    if (response.cursor === null) {
      return {
        ...firstResponse,
        items: collected,
        cursor: null,
      };
    }
    if (!response.cursor || seen.has(response.cursor)) {
      return PAGINATION_INVALID;
    }
    seen.add(response.cursor);
    cursor = response.cursor;
  }
  return PAGINATION_INVALID;
}

function resolvedStatus(entry) {
  if (typeof entry?.resolved?.status === "string") {
    return entry.resolved.status;
  }
  const versions = Array.isArray(entry?.versions) ? entry.versions : [];
  return versions.at(-1)?.status || null;
}

function approvedEntries(registry, type) {
  return entries(registry).filter((entry) =>
    entry?.type === type && resolvedStatus(entry) === "APPROVED");
}

function latestVersion(entry) {
  const versions = Array.isArray(entry?.versions) ? entry.versions : [];
  return [...versions].sort((left, right) =>
    String(left?.semver || "").localeCompare(
      String(right?.semver || ""),
      undefined,
      { numeric: true },
    )).at(-1) || {};
}

function projectStatus(value) {
  return value === "ARCHIVED" ? "archived" : "active";
}

export function adaptProjects(projectsResponse, agentsResponse) {
  if (projectsResponse?.ok !== true) return projectsResponse;
  const agentItems = items(agentsResponse);
  const agentsByProject = new Map();
  for (const agent of agentItems) {
    const key = `${agent.domainId}/${agent.projectId}`;
    const current = agentsByProject.get(key) || [];
    current.push(agent.id);
    agentsByProject.set(key, current);
  }
  return {
    ok: true,
    projects: items(projectsResponse).map((project) => ({
      id: project.id,
      name: project.name,
      description: project.description,
      domain: project.domainId,
      owner: project.ownerSubject,
      createdBy: project.createdBySubject,
      members: (project.memberSubjects || []).map((principal) => ({
        principal,
        bundle: "builder",
      })),
      agents: agentsByProject.get(`${project.domainId}/${project.id}`) || [],
      status: projectStatus(project.status),
      createdAt: project.createdAt,
    })),
    lastProject: null,
    cursor: projectsResponse.cursor ?? null,
  };
}

export function adaptDomains(domainsResponse, agentsResponse) {
  if (domainsResponse?.ok !== true) return domainsResponse;
  const agentsByDomain = new Map();
  for (const agent of items(agentsResponse)) {
    const current = agentsByDomain.get(agent.domainId) || [];
    current.push(agent.id);
    agentsByDomain.set(agent.domainId, current);
  }
  return {
    ...domainsResponse,
    domains: (domainsResponse.domains || []).map((domain) => ({
      ...domain,
      agents: agentsByDomain.get(domain.id) || [],
    })),
  };
}

export function adaptObsScopes(domainsResponse, agentsResponse) {
  if (domainsResponse?.ok !== true) return domainsResponse;
  const agentsByDomain = new Map();
  for (const agent of items(agentsResponse)) {
    const current = agentsByDomain.get(agent.domainId) || [];
    current.push({
      type: "agent",
      id: agent.id,
      label: agent.name || agent.id,
      domain: agent.domainId,
    });
    agentsByDomain.set(agent.domainId, current);
  }
  return {
    ok: true,
    fleet: { type: "fleet", id: "all", label: "Entire platform" },
    domains: (domainsResponse.domains || []).map((domain) => ({
      type: "domain",
      id: domain.id,
      label: domain.name || domain.id,
      agents: agentsByDomain.get(domain.id) || [],
    })),
    shared: [],
  };
}

function deploymentFor(agent, deploymentItems) {
  return deploymentItems
    .filter((deployment) =>
      deployment.domainId === agent.domainId
      && deployment.projectId === agent.projectId
      && deployment.agentId === agent.id)
    .sort((left, right) =>
      String(right.updatedAt || right.requestedAt || "").localeCompare(
        String(left.updatedAt || left.requestedAt || ""),
      ))[0] || null;
}

function approvalFor(agent, deployment, approvalItems) {
  if (!deployment) return null;
  return approvalItems
    .filter((approval) =>
      approval.domainId === agent.domainId
      && approval.projectId === agent.projectId
      && approval.kind === "PRODUCTION_DEPLOYMENT"
      && approval.resourceId === deployment.id)
    .sort((left, right) =>
      String(right.requestedAt || "").localeCompare(
        String(left.requestedAt || ""),
      ))[0] || null;
}

function mainAgentStatus(agent, deployment) {
  if (deployment?.status === "DEPLOYED") return "READY";
  return agent.status || "DRAFT";
}

function mainApprovalStatus(approval) {
  if (!approval) return "NOT_SUBMITTED";
  if (approval.status === "PENDING") return "IN_REVIEW";
  return approval.status;
}

export function adaptFleet(
  agentsResponse,
  deploymentsResponse,
  approvalsResponse,
) {
  if (agentsResponse?.ok !== true) return agentsResponse;
  const deployments = items(deploymentsResponse);
  const approvals = items(approvalsResponse);
  return {
    ok: true,
    region: null,
    agents: items(agentsResponse).map((agent) => {
      const deployment = deploymentFor(agent, deployments);
      const approval = approvalFor(agent, deployment, approvals);
      return {
        project: agent.id,
        projectId: agent.projectId,
        name: agent.name,
        description: agent.description,
        domain: agent.domainId,
        owner: agent.ownerSubject,
        model: agent.modelId,
        // The agent detail panel has no /agent-detail route to fall back on,
        // so the governed configuration has to survive this projection.
        buildConfig: agent.buildConfig ?? null,
        skillIds: agent.skillIds ?? [],
        toolIds: agent.toolIds ?? [],
        mcpServerIds: agent.mcpServerIds ?? [],
        memoryIds: agent.memoryIds ?? [],
        knowledgeBaseIds: agent.knowledgeBaseIds ?? [],
        blueprint: agent.blueprintIds?.[0] || null,
        status: mainAgentStatus(agent, deployment),
        approval: mainApprovalStatus(approval),
        health: deployment?.runtimeStatus === "READY" ? "healthy" : "unknown",
        errorRate: null,
        version: deployment?.runtimeVersion || null,
        lastDeploy:
          deployment?.updatedAt
          || deployment?.decidedAt
          || deployment?.requestedAt
          || null,
      };
    }),
  };
}

export function adaptCosts(response, domains = []) {
  if (response?.ok !== true) return response;
  let rows;
  try {
    rows = validateCostRows(response);
  } catch {
    return { ok: false, code: "COST_DATA_INVALID", message: "Cost data is unavailable." };
  }
  const summary = costSummary(response);
  const complete = response.cursor === null;
  const sum = (values, key) => complete ? sumCostValues(values, key) : null;
  const tokens = (values) => {
    const input = sum(values, "inputTokens");
    const output = sum(values, "outputTokens");
    return input !== null && output !== null && Number.isSafeInteger(input + output)
      ? input + output : null;
  };
  const names = new Map((Array.isArray(domains) ? domains : []).map(domain => [domain.id, domain.name]));
  const byDomain = new Map();
  for (const row of rows) {
    const key = row.domainId ?? "platform";
    if (!byDomain.has(key)) byDomain.set(key, []);
    byDomain.get(key).push(row);
  }
  return {
    ...response,
    ...summary,
    invocations: sum(rows, "invocationCount"),
    totalTokens: tokens(rows),
    sharedAllocatedUsd: null,
    domains: [...byDomain].map(([id, values]) => ({
      id, name: names.get(id) || id,
      items: values, scope: response.scope, window: response.window,
      invocations: sum(values, "invocationCount"), tokensUsed: tokens(values),
      costUsd: costSummary({ ...response, items: values }).totalCostUsd,
      monthlyBudgetUsd: values.every(row => row.currency === "USD") ? sum(values, "monthlyBudgetUsd") : null,
      sharedAllocatedUsd: null, tokenBudget: null, budgetPct: null, alert: null,
    })),
    perAgent: rows.filter(row => row.scopeType === "project").map(row => ({
      ...row,
      ...costSummary({ ...response, items: [row] }),
      project: row.projectId, domain: row.domainId, model: null,
      invocations: complete ? row.invocationCount ?? null : null,
      inputTokens: complete ? row.inputTokens ?? null : null,
      outputTokens: complete ? row.outputTokens ?? null : null,
      costUsd: costSummary({ ...response, items: [row] }).totalCostUsd,
      estimated: true,
      components: { llm: costSummary({ ...response, items: [row] }).totalCostUsd, memory: null, kb: null, gateway: null },
      costTrend: [],
    })),
    perModel: [],
    componentTotals: { llm: summary.totalCostUsd, memory: null, kb: null, gateway: null },
    pricing: [],
  };
}

function registryChoice(entry) {
  const version = latestVersion(entry);
  return {
    id: entry.id,
    name: entry.name,
    label: entry.name,
    description: entry.description || version.description || "",
    domain: entry.domain,
    semver: version.semver || entry.defaultVersion || null,
    content: version.content || {},
  };
}

// The platform-owned foundation every blueprint pre-wires. The local server
// derives the identical block in listBlueprints (console/server.mjs); hosted
// registry records carry only the template, so derive it here the same way —
// otherwise the wizard's locked "Foundation Harness" section renders blank.
export function blueprintFoundation(template = {}) {
  return {
    identity: "AgentCore Identity + IAM execution role",
    observability: "CloudWatch metrics + OTEL traces (auto)",
    guardrails: "Bedrock Guardrails / Cedar policy engine",
    memory: template.memory === "none"
      ? "none"
      : `AgentCore Memory (${template.memory || "shortTerm"})`,
    runtime: `${template.deployTarget || "AgentCore Runtime"} (${
      template.protocol || "HTTP"}${template.build ? ", " + template.build : ""})`,
  };
}

export function adaptBlueprints(registry, domainId = null) {
  return scopedRegistryEntries(registry, domainId)
    .filter((entry) => entry.type === "Blueprint")
    .map((entry) => {
    const choice = registryChoice(entry);
    const template = choice.content.template || choice.content;
    return {
      ...choice,
      version: choice.semver,
      template,
      // Where the harness actually lives (repo/github/s3/illustrative). The
      // detail panel renders it; absence means an older record — say unknown.
      source: choice.content.source || null,
      recommended: choice.content.recommended === true,
      foundation: choice.content.foundation || blueprintFoundation(template),
      memoryPlan: choice.content.memoryPlan || null,
      framework: template.framework || null,
      deployTarget: template.deployTarget || null,
      hosting: template.deployTarget || null,
      skills: choice.content.skillIds || [],
      tools: choice.content.toolIds || [],
      // Deployable = the platform ships a real exportable harness for it.
      // Registry records ≥1.2.0 declare that as source.kind === "repo";
      // older records fall back to the known platform pair.
      deployable: choice.content.source
        ? choice.content.source.kind === "repo"
        : PLATFORM_BLUEPRINT_IDS.has(entry.id),
    };
  }).sort((a, b) => Number(b.recommended) - Number(a.recommended)
    || a.name.localeCompare(b.name));
}

const PLATFORM_BLUEPRINT_IDS = new Set([
  "chat-assistant",
  "workflow-orchestrator",
]);

export function buildableBlueprints(blueprints) {
  return Array.isArray(blueprints)
    ? blueprints.filter((blueprint) => blueprint?.deployable === true)
    : [];
}

export function resolveBuildModelId(
  models,
  selectedId,
  preferredId = "bedrock-claude/anthropic.claude-haiku-4-5",
) {
  const available = Array.isArray(models)
    ? models.filter((model) => typeof model?.id === "string" && model.id)
    : [];
  if (available.some(({ id }) => id === selectedId)) return selectedId;
  if (available.some(({ id }) => id === preferredId)) return preferredId;
  return available[0]?.id || "";
}

function scopedRegistryEntries(registry, domainId) {
  const approved = entries(registry).filter((entry) =>
    resolvedStatus(entry) === "APPROVED");
  if (!domainId) return approved;
  return approved.filter((entry) =>
    entry.domain === domainId
    || entry.domain === "shared");
}

function grantedChoices(sharedResources, resourceType) {
  const values = sharedResources?.ok === true
    && Array.isArray(sharedResources.items)
      ? sharedResources.items
      : [];
  return values
    .filter((resource) =>
      resource.granted === true
      && resource.resourceType === resourceType
      && resource.registryId
      && resource.recordId)
    .map((resource) => ({
      id: `${resource.registryId}/${resource.recordId}`,
      name: resource.displayName || resource.resourceId,
      label: resource.displayName || resource.resourceId,
      description: resource.description || "",
      domain: resource.domainId,
      semver: resource.version || null,
      content: {},
    }));
}

function effectiveRegistryChoiceType(entry) {
  return entry?.type === "Skill" && Boolean(registryChoice(entry).content.toolType)
    ? "Tool"
    : entry?.type;
}

function choices(registry, type, domainId) {
  return scopedRegistryEntries(registry, domainId)
    .filter((entry) => effectiveRegistryChoiceType(entry) === type)
    .map(registryChoice);
}

export function adaptWizardPicks(
  registry,
  domainId = null,
  sharedResources = null,
) {
  return {
    ok: registry?.ok === true,
    skills: [
      ...choices(registry, "Skill", domainId),
      ...grantedChoices(sharedResources, "SKILL"),
    ],
    tools: [
      ...choices(registry, "Tool", domainId),
      ...grantedChoices(sharedResources, "TOOL"),
    ],
    mcpServers: [
      ...choices(registry, "MCPServer", domainId),
      ...grantedChoices(sharedResources, "MCP_SERVER"),
    ],
    a2aAgents: choices(registry, "A2AAgent", domainId),
    guardrails: choices(registry, "GuardrailPack", domainId),
  };
}

export function adaptBuilderCatalog(
  registry,
  gateway,
  github = null,
  domainId = null,
  sharedResources = null,
) {
  const picks = adaptWizardPicks(registry, domainId, sharedResources);
  const blueprintTemplates = adaptBlueprints(registry, domainId).map(blueprint => blueprint.template);
  const modelInventory = builderModelCatalog(registry, gateway, domainId);
  return {
    ok: registry?.ok === true,
    modelAccessUnavailable: gateway?.ok !== true,
    blueprintOptions: Object.fromEntries(
      ["framework", "deployTarget", "protocol", "memory"].map(field => [
        field,
        [...new Set(blueprintTemplates.map(template => template[field])
          .filter(value => typeof value === "string" && value.trim()))],
      ]),
    ),
    models: modelInventory
        .map((model) => ({
          id: model.id,
          label: model.name || model.label || model.id,
          vendor: model.vendor || model.provider || "AWS",
          gateway: gateway?.llmGateway?.name || null,
          region: gateway?.llmGateway?.region || null,
          runtimeReady: (model.accessByDomain?.[domainId] ?? model.access)?.usable === true,
        })),
    blueprints: scopedRegistryEntries(registry, domainId)
      .filter((entry) => entry.type === "Blueprint")
      .map((entry) => {
        const choice = registryChoice(entry);
        const template = choice.content.template || choice.content;
        return {
          ...choice,
          template,
          foundation: choice.content.foundation || {},
          framework: template.framework || null,
          deployTarget: template.deployTarget || null,
          hosting: template.deployTarget || null,
          skills: choice.content.skillIds || [],
          tools: choice.content.toolIds || [],
          deployable: PLATFORM_BLUEPRINT_IDS.has(entry.id),
        };
      }),
    skills: picks.skills,
    tools: picks.tools,
    mcpServers: picks.mcpServers,
    a2aAgents: picks.a2aAgents,
    guardrails: picks.guardrails,
    githubOrgs: github?.ok === true && Array.isArray(github.owners)
      ? github.owners
      : [],
  };
}

export function adaptAudit(response) {
  if (response?.ok !== true) return response;
  const events = items(response).map((event) => ({
    id: event.id,
    at: event.timestamp || event.createdAt || event.requestedAt || null,
    stream: "governance",
    type: event.eventType || event.kind || event.action || "AUDIT",
    action: event.action || event.status || null,
    subject: event.resource || event.resourceId || event.subject || null,
    domain: event.domainId || null,
    who: event.actor || event.actorSubject || event.requesterSubject || null,
    requestId: event.requestId || null,
    detail: event.reason || event.description || null,
  }));
  return {
    ok: true,
    events,
    total: events.length,
    types: [...new Set(events.map(({ type }) => type))],
    store: "AWS platform audit",
    cursor: response.cursor ?? null,
  };
}
