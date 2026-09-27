import assert from "node:assert/strict";
import test from "node:test";

import * as mainUiCompat from "./public/main-ui-compat.mjs";
import {
  adaptAudit,
  adaptBlueprints,
  adaptBuilderCatalog,
  adaptCosts,
  adaptDomains,
  adaptFleet,
  adaptObsScopes,
  adaptProjects,
  adaptWizardPicks,
  buildableBlueprints,
  collectPagedItems,
  resolveBuildModelId,
} from "./public/main-ui-compat.mjs";

test("hosted blueprint submission pickers use the actual scoped template catalog", () => {
  const template = { framework: "Strands", deployTarget: "AgentCore Runtime", protocol: "HTTP", memory: "shortTerm" };
  const catalog = adaptBuilderCatalog({
    ok: true,
    entries: [{
      id: "chat-assistant", name: "Chat assistant", domain: "platform", type: "Blueprint",
      defaultVersion: "1.0.0", versions: [{ semver: "1.0.0", status: "APPROVED", content: { template } }],
    }],
  }, { ok: true, models: [] }, null, "platform");
  for (const [field, value] of Object.entries(template)) {
    assert.deepEqual(catalog.blueprintOptions[field], [value]);
  }
});

test("main build resource normalization drops stale cross-domain selections", () => {
  const normalized = mainUiCompat.normalizeSelectedResourceIds?.(
    [
      "shared/data-analysis",
      "operations/employee-directory",
      "",
      "shared/data-analysis",
      "customer-support/case-search",
    ],
    [
      { id: "shared/data-analysis" },
      { id: "customer-support/case-search" },
    ],
  );

  assert.deepEqual(normalized, [
    "shared/data-analysis",
    "customer-support/case-search",
  ]);
  assert.deepEqual(
    mainUiCompat.normalizeSelectedResourceIds?.(
      new Set(["shared/data-analysis"]),
      [{ id: "shared/data-analysis" }],
    ),
    ["shared/data-analysis"],
  );
  assert.deepEqual(
    mainUiCompat.normalizeSelectedResourceIds?.(
      ["operations/employee-directory"],
      null,
    ),
    [],
  );
});

const project = {
  domainId: "customer_support",
  id: "case-assist",
  name: "Case Assist",
  description: "Support workspace",
  ownerSubject: "operator",
  memberSubjects: ["builder"],
  status: "ACTIVE",
  createdBySubject: "operator",
  createdAt: "2026-09-03T00:00:00.000Z",
};

const agent = {
  domainId: "customer_support",
  projectId: "case-assist",
  id: "triage-agent",
  name: "Triage Agent",
  description: "Triage cases",
  ownerSubject: "operator",
  modelId: "anthropic.claude-opus-4-8",
  blueprintIds: ["support-blueprint"],
  status: "TESTED",
  updatedAt: "2026-09-03T01:00:00.000Z",
};

test("projects use the main UI contract and include scoped agents", () => {
  assert.deepEqual(
    adaptProjects(
      { ok: true, items: [project], cursor: null },
      { ok: true, items: [agent], cursor: null },
    ),
    {
      ok: true,
      projects: [{
        id: "case-assist",
        name: "Case Assist",
        description: "Support workspace",
        domain: "customer_support",
        owner: "operator",
        createdBy: "operator",
        members: [{ principal: "builder", bundle: "builder" }],
        agents: ["triage-agent"],
        status: "active",
        createdAt: "2026-09-03T00:00:00.000Z",
      }],
      lastProject: null,
      cursor: null,
    },
  );
});

test("fleet joins agents, deployments, and approvals without inventing records", () => {
  const result = adaptFleet(
    { ok: true, items: [agent] },
    {
      ok: true,
      items: [{
        domainId: "customer_support",
        projectId: "case-assist",
        id: "dep-1",
        agentId: "triage-agent",
        environment: "sandbox",
        status: "DEPLOYED",
        updatedAt: "2026-09-03T02:00:00.000Z",
      }],
    },
    {
      ok: true,
      items: [{
        domainId: "customer_support",
        projectId: "case-assist",
        id: "approval-1",
        kind: "PRODUCTION_DEPLOYMENT",
        resourceId: "dep-1",
        status: "PENDING",
      }],
    },
  );
  assert.equal(result.ok, true);
  assert.equal(result.agents.length, 1);
  assert.deepEqual(result.agents[0], {
    project: "triage-agent",
    projectId: "case-assist",
    name: "Triage Agent",
    description: "Triage cases",
    domain: "customer_support",
    owner: "operator",
    model: "anthropic.claude-opus-4-8",
    // Governed configuration survives the projection: the agent detail panel
    // reads it here because hosted deployments have no /agent-detail route.
    buildConfig: null,
    skillIds: [],
    toolIds: [],
    mcpServerIds: [],
    memoryIds: [],
    knowledgeBaseIds: [],
    blueprint: "support-blueprint",
    status: "READY",
    approval: "IN_REVIEW",
    health: "unknown",
    errorRate: null,
    version: null,
    lastDeploy: "2026-09-03T02:00:00.000Z",
  });
});

test("fleet ignores Registry publication approvals when reporting deployment readiness", () => {
  const result = adaptFleet(
    { ok: true, items: [agent] },
    {
      ok: true,
      items: [{
        domainId: "customer_support",
        projectId: "case-assist",
        id: "dep-1",
        agentId: "triage-agent",
        environment: "sandbox",
        status: "DEPLOYED",
      }],
    },
    {
      ok: true,
      items: [{
        domainId: "customer_support",
        projectId: "case-assist",
        id: "approval-1",
        kind: "RESOURCE_PUBLICATION",
        resourceId: "registry-1/record-1",
        status: "PENDING",
      }],
    },
  );

  assert.equal(result.agents[0].approval, "NOT_SUBMITTED");
});

test("fleet keeps a tested Agent undeployed until a deployment record is ready", () => {
  const result = adaptFleet(
    { ok: true, items: [agent] },
    { ok: true, items: [] },
    { ok: true, items: [] },
  );

  assert.equal(result.agents[0].status, "TESTED");
  assert.equal(result.agents[0].health, "unknown");
  assert.equal(result.agents[0].lastDeploy, null);
});

test("paged hosted collections are collected until the cursor is exhausted", async () => {
  const cursors = [];
  const result = await collectPagedItems(async (cursor) => {
    cursors.push(cursor);
    return cursor === null
      ? { ok: true, resource: "approvals", items: [{ id: "a" }], cursor: "next" }
      : { ok: true, resource: "approvals", items: [{ id: "b" }], cursor: null };
  });

  assert.deepEqual(cursors, [null, "next"]);
  assert.deepEqual(result, {
    ok: true,
    resource: "approvals",
    items: [{ id: "a" }, { id: "b" }],
    cursor: null,
  });
});

test("paged hosted collections fail closed on a repeated cursor", async () => {
  const result = await collectPagedItems(async () => ({
    ok: true,
    resource: "approvals",
    items: [],
    cursor: "repeat",
  }));

  assert.deepEqual(result, {
    ok: false,
    code: "PAGINATION_INVALID",
    message: "The hosted collection pagination response is invalid.",
  });
});

test("cost rows become the aggregate shape used by the main dashboards", () => {
  const result = adaptCosts({
    ok: true, resource: "costs", scope: { type: "projects" }, cursor: null,
    window: { startTime: "2026-09-10T00:00:00.000Z", endTime: "2026-09-11T00:00:00.000Z" },
    items: [{
      scopeType: "project",
      domainId: "customer_support",
      projectId: "case-assist",
      contractVersion: 1, currency: "USD", basis: "estimate",
      invocationCount: 12,
      inputTokens: 1200,
      outputTokens: 300,
      estimatedCostUsd: 1.25,
      projectedMonthlyCostUsd: 3.5,
      monthlyBudgetUsd: 10,
      projectedBudgetUtilizationPercent: 35,
    }],
  }, [{ id: "customer_support", name: "Customer Support" }]);
  assert.equal(result.invocations, 12);
  assert.equal(result.totalTokens, 1500);
  assert.equal(result.totalCostUsd, 1.25);
  assert.equal(result.domains[0].id, "customer_support");
  assert.equal(result.perAgent[0].project, "case-assist");
});

test("Registry and Gateway data drive blueprints and builder choices", () => {
  const registry = {
    ok: true,
    entries: [{
      id: "support-blueprint",
      name: "Support Blueprint",
      type: "Blueprint",
      domain: "platform",
      resolved: { status: "APPROVED" },
      versions: [{
        semver: "1.0.0",
        status: "APPROVED",
        content: { framework: "strands", deployTarget: "agentcore-runtime" },
      }],
    }, {
      id: "case-skill",
      name: "Case Skill",
      type: "Skill",
      domain: "platform",
      resolved: { status: "APPROVED" },
      versions: [{ semver: "1.0.0", status: "APPROVED", content: {} }],
    }],
  };
  const gateway = {
    ok: true,
    source: "aws",
    models: [{
      id: "anthropic.claude-opus-4-8",
      name: "Claude Opus 4.8",
      vendor: "Anthropic",
    }],
  };
  assert.equal(adaptBlueprints(registry)[0].id, "support-blueprint");
  assert.deepEqual(adaptBlueprints(registry)[0].template, {
    framework: "strands",
    deployTarget: "agentcore-runtime",
  });
  assert.equal(adaptBuilderCatalog(registry, gateway).models.length, 0);
  assert.equal(adaptWizardPicks(registry).skills[0].id, "case-skill");
});

test("tool-backed legacy Skill records are exposed as tools, not skills", () => {
  const registry = {
    ok: true,
    entries: [{
      id: "order_lookup",
      name: "Order Lookup",
      type: "Skill",
      domain: "customer_support",
      resolved: { status: "APPROVED" },
      versions: [{
        semver: "1.0.0",
        status: "APPROVED",
        content: { toolType: "agentcore_gateway" },
      }],
    }, {
      id: "customer-support",
      name: "Customer Support",
      type: "Skill",
      domain: "customer_support",
      resolved: { status: "APPROVED" },
      versions: [{
        semver: "1.0.0",
        status: "APPROVED",
        content: { tools: ["order_lookup"] },
      }],
    }],
  };

  const picks = adaptWizardPicks(registry, "customer_support");

  assert.deepEqual(picks.skills.map(({ id }) => id), ["customer-support"]);
  assert.deepEqual(picks.tools.map(({ id }) => id), ["order_lookup"]);
});

test("hosted domains include their real agents for the main dashboard", () => {
  const result = adaptDomains(
    {
      ok: true,
      domains: [{
        id: "customer_support",
        name: "Customer Support",
        owner: "Support domain team",
        status: "ACTIVE",
      }],
    },
    { ok: true, items: [agent] },
  );
  assert.equal(result.ok, true);
  assert.deepEqual(result.domains[0].agents, ["triage-agent"]);
});

test("monitoring scopes come from the hosted domain and agent collections", () => {
  assert.deepEqual(
    adaptObsScopes(
      {
        ok: true,
        domains: [{
          id: "customer_support",
          name: "Customer Support",
        }],
      },
      { ok: true, items: [agent] },
    ),
    {
      ok: true,
      fleet: { type: "fleet", id: "all", label: "Entire platform" },
      domains: [{
        type: "domain",
        id: "customer_support",
        label: "Customer Support",
        agents: [{
          type: "agent",
          id: "triage-agent",
          label: "Triage Agent",
          domain: "customer_support",
        }],
      }],
      shared: [],
    },
  );
});

test("builder choices include approved global shared resources and exact grants", () => {
  const localSkill = {
    id: "local-skill",
    name: "Local Skill",
    type: "Skill",
    domain: "customer_support",
    defaultVersion: "1.0.0",
    versions: [{
      semver: "1.0.0",
      status: "APPROVED",
      content: {},
    }],
  };
  const globalSharedSkill = {
    id: "shared-skill",
    name: "Shared Skill",
    type: "Skill",
    domain: "shared",
    defaultVersion: "1.0.0",
    versions: [{
      semver: "1.0.0",
      status: "APPROVED",
      content: {},
    }],
  };
  const globalSharedTool = {
    id: "shared-tool",
    name: "Shared Tool",
    type: "Skill",
    domain: "shared",
    defaultVersion: "1.0.0",
    versions: [{
      semver: "1.0.0",
      status: "APPROVED",
      content: { toolType: "agentcore_browser" },
    }],
  };
  const grantedShared = {
    ok: true,
    items: [{
      domainId: "operations",
      registryId: "registry-1",
      recordId: "record-1",
      resourceType: "SKILL",
      resourceId: "operations-skill",
      displayName: "Granted Operations Skill",
      granted: true,
    }],
  };
  const picks = adaptWizardPicks(
    {
      ok: true,
      entries: [localSkill, globalSharedSkill, globalSharedTool],
    },
    "customer_support",
    grantedShared,
  );
  assert.deepEqual(
    picks.skills.map(({ id }) => id),
    ["local-skill", "shared-skill", "registry-1/record-1"],
  );
  assert.deepEqual(picks.tools.map(({ id }) => id), ["shared-tool"]);
});

test("builder model catalog excludes models unavailable to the active domain", () => {
  const catalog = adaptBuilderCatalog(
    { ok: true, entries: [{type:"Model",id:"allowed-model",domain:"shared",defaultVersion:"1",versions:[{semver:"1",status:"APPROVED",content:{}}]}] },
    {
      ok: true,
      models: [{
        id: "allowed-model",
        name: "Allowed",
        accessByDomain: {
          customer_support: { status:"ALLOWED", usable: true },
        },
      }, {
        id: "denied-model",
        name: "Denied",
        accessByDomain: {
          customer_support: { usable: false },
        },
      }],
    },
    null,
    "customer_support",
  );
  assert.deepEqual(catalog.models.map(({ id }) => id), ["allowed-model"]);
});

test("bootstrapped domain keeps catalog navigation but no build choices during an access outage", () => {
  const catalog = adaptBuilderCatalog(
    {
      ok: true,
      domainResourcePolicyApplied: true,
      entries: [
        { type: "Model", id: "model-a", name: "Model A" },
        { type: "Model", id: "model-b", name: "Model B" },
      ],
    },
    { ok: false, code: "CONTROL_PLANE_UNAVAILABLE" },
    null,
    "new_domain",
  );
  assert.equal(catalog.ok, true);
  assert.deepEqual(catalog.models, []);
  assert.equal(catalog.modelAccessUnavailable, true);
});

test("platform projects cannot select unverified model access during a Gateway outage", () => {
  const catalog = adaptBuilderCatalog(
    { ok: true, entries: [{ type: "Model", id: "model-a", name: "Model A" }] },
    { ok: false, code: "MODEL_GOVERNANCE_UNAVAILABLE" },
    null,
    "platform",
  );
  assert.equal(catalog.ok, true);
  assert.deepEqual(catalog.models, []);
  assert.equal(catalog.modelAccessUnavailable, true);
});

test("the live build wizard exposes only Blueprints wired for deployment", () => {
  assert.deepEqual(
    buildableBlueprints([
      { id: "chat-assistant", deployable: true },
      { id: "concept-only", deployable: false },
      { id: "workflow-orchestrator", deployable: true },
    ]).map(({ id }) => id),
    ["chat-assistant", "workflow-orchestrator"],
  );
});

test("the live build wizard always resolves an explicit approved model", () => {
  const models = [
    { id: "model-first" },
    { id: "bedrock-claude/anthropic.claude-haiku-4-5" },
  ];
  assert.equal(
    resolveBuildModelId(models, "model-first"),
    "model-first",
  );
  assert.equal(
    resolveBuildModelId(models, ""),
    "bedrock-claude/anthropic.claude-haiku-4-5",
  );
  assert.equal(resolveBuildModelId([], ""), "");
});

test("audit metadata maps to the main timeline contract", () => {
  const result = adaptAudit({
    ok: true,
    items: [{
      id: "evt-1",
      timestamp: "2026-09-03T03:00:00.000Z",
      eventType: "REGISTRY_DECISION",
      action: "APPROVE",
      actorSubject: "operator",
      domainId: "platform",
      resourceId: "support-blueprint",
      reason: "Reviewed",
    }],
  });
  assert.equal(result.ok, true);
  assert.equal(result.total, 1);
  assert.equal(result.events[0].at, "2026-09-03T03:00:00.000Z");
  assert.equal(result.events[0].domain, "platform");
});

test('audit projects actual decider and resource instead of confusing requester identity',()=>{const r=adaptAudit({ok:true,items:[{actor:'synthetic-decider',requesterSubject:'synthetic-requester',resource:'approval/platform/synthetic',action:'approval.update',timestamp:'2026-09-14T00:00:00Z',requestId:'synthetic-request'}],cursor:null});assert.equal(r.events[0].who,'synthetic-decider');assert.equal(r.events[0].subject,'approval/platform/synthetic');assert.equal(r.events[0].type,'approval.update');});
