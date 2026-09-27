import assert from "node:assert/strict";
import test from "node:test";

import {
  activeBuildProjects,
  createMainUiBuildActions,
} from "./public/main-ui-build.mjs";

function requestStub(responses) {
  const calls = [];
  return {
    calls,
    request: async (path, body, options = {}) => {
      calls.push({ path, body, options });
      const response = responses.shift();
      if (response instanceof Error) throw response;
      return structuredClone(response);
    },
  };
}

test("prepareAgent never recreates a missing explicitly selected workspace", async () => {
  const stub = requestStub([{ ok: true, items: [] }]);
  const actions = createMainUiBuildActions({
    request: stub.request,
    requestId: () => "must-not-write",
  });
  const result = await actions.prepareAgent({
    project: { domainId: "customer_support", id: "removed-project" },
    agent: { id: "agent", name:"Agent", buildConfig:{instructions:"Help the user."} },
    requireExistingProject: false,
  });
  assert.equal(result.code, "PROJECT_NOT_AVAILABLE");
  assert.deepEqual(stub.calls.map(call => call.path), ["/projects"]);
});

test("Builder choices exclude archived and unknown-status projects within the owning domain", () => {
  const records = [
    { id: "it-helpdesk", domainId: "platform", status: "ACTIVE" },
    { id: "data-analyst", domainId: "platform", status: "ARCHIVED" },
    { id: "support-desk-5", domainId: "platform", status: "ARCHIVED" },
    { id: "case-assist", domainId: "customer_support", status: "ACTIVE" },
    { id: "missing-status", domainId: "platform" },
  ];
  assert.deepEqual(activeBuildProjects(records, "platform").map(p => p.id), ["it-helpdesk"]);
  assert.deepEqual(activeBuildProjects(records).map(p => p.id), ["it-helpdesk", "case-assist"]);
});

test("Generate rejects a project archived since page load before any agent read or mutation", async () => {
  const stub = requestStub([{
    ok: true,
    items: [{ domainId: "platform", id: "data-analyst", status: "ARCHIVED" }],
  }]);
  const actions = createMainUiBuildActions({
    request: stub.request,
    requestId: () => { throw new Error("Archived projects must not mutate"); },
  });
  const result = await actions.prepareAgent({
    project: { domainId: "platform", id: "data-analyst" },
    agent: { id: "it-support-demo-test", name: "IT support", buildConfig: { instructions: "test" } },
  });
  assert.equal(result.code, "PROJECT_NOT_AVAILABLE");
  assert.match(result.message, /archived.*active project/);
  assert.deepEqual(stub.calls.map(call => call.path), ["/projects"]);
});

test("prepareAgent creates and configures an Agent only inside an existing project", async () => {
  const stub = requestStub([
    { ok: true, items: [{ domainId: "customer_support", id: "case-assist", status: "ACTIVE" }] },
    { ok: true, items: [] },
    {
      ok: true,
      agent: {
        domainId: "customer_support",
        projectId: "case-assist",
        id: "triage-agent",
        status: "DRAFT",
      },
    },
    {
      ok: true,
      agent: {
        domainId: "customer_support",
        projectId: "case-assist",
        id: "triage-agent",
        status: "READY_FOR_TEST",
      },
    },
  ]);
  let requestNumber = 0;
  const actions = createMainUiBuildActions({
    request: stub.request,
    requestId: () => `request-${++requestNumber}`,
  });
  const agent = {
    domainId: "customer_support",
    projectId: "case-assist",
    id: "triage-agent",
    name: "Triage Agent",
    description: "Triage cases",
    modelId: "allowed-model",
    toolIds: [],
    mcpServerIds: [],
    skillIds: [],
    blueprintIds: ["chat-assistant"],
    memoryIds: [],
    knowledgeBaseIds: [],
    buildConfig: {
      instructions: "Triage support cases.",
      modelParameters: { temperature: null, maxTokens: null },
      buildOptions: {
        framework: "Strands",
        deployTarget: "AgentCore Runtime",
        memory: "none",
        streaming: true,
        identity: true,
        guardrails: true,
      },
      guardrailChain: [],
    },
  };

  const result = await actions.prepareAgent({
    project: {
      domainId: "customer_support",
      id: "case-assist",
      name: "Case Assist",
      description: "Support workspace",
    },
    agent,
  });

  assert.equal(result.ok, true);
  assert.equal(result.agent.status, "READY_FOR_TEST");
  assert.deepEqual(
    stub.calls.map(({ path, options }) => [path, options.method || "GET"]),
    [
      ["/projects", "GET"],
      ["/agents", "GET"],
      ["/agents", "POST"],
      ["/agents/triage-agent", "PUT"],
    ],
  );
  assert.equal(stub.calls[2].body.projectId, "case-assist");
  assert.equal(stub.calls[2].body.modelId, "allowed-model");
});

test("prepareAgent reuses an existing configured Agent without duplicate writes", async () => {
  const existing = {
    domainId: "platform",
    projectId: "design-assistant",
    id: "design-assistant",
    name: "Design Assistant",
    description: "",
    modelId: "allowed-model",
    toolIds: [],
    mcpServerIds: [],
    skillIds: [],
    blueprintIds: ["chat-assistant"],
    memoryIds: [],
    knowledgeBaseIds: [],
    buildConfig: {
      instructions: "Design governed agents.",
      modelParameters: { temperature: null, maxTokens: null },
      buildOptions: {
        framework: "Strands",
        deployTarget: "AgentCore Runtime",
        memory: "none",
        streaming: true,
        identity: true,
        guardrails: true,
      },
      guardrailChain: [],
    },
    status: "TESTED",
  };
  const stub = requestStub([
    {
      ok: true,
      items: [{ domainId: "platform", id: "design-assistant", status: "ACTIVE" }],
    },
    { ok: true, items: [existing] },
  ]);
  const actions = createMainUiBuildActions({
    request: stub.request,
    requestId: () => "unused",
  });
  const result = await actions.prepareAgent({
    project: {
      domainId: "platform",
      id: "design-assistant",
      name: "Design Assistant",
      description: "",
    },
    agent: { ...existing },
  });
  assert.equal(result.agent.status, "TESTED");
  assert.equal(stub.calls.length, 2);
});

test("prepareAgent rejects a changed configuration for an existing tested Agent", async () => {
  const existing = {
    domainId: "platform",
    projectId: "design-assistant",
    id: "design-assistant",
    name: "Design Assistant",
    description: "",
    modelId: "allowed-model",
    toolIds: [],
    mcpServerIds: [],
    skillIds: [],
    blueprintIds: ["chat-assistant"],
    memoryIds: [],
    knowledgeBaseIds: [],
    buildConfig: {
      instructions: "Original instructions.",
      modelParameters: { temperature: null, maxTokens: null },
      buildOptions: {
        framework: "Strands",
        deployTarget: "AgentCore Runtime",
        memory: "none",
        streaming: true,
        identity: true,
        guardrails: true,
      },
      guardrailChain: [],
    },
    status: "TESTED",
  };
  const stub = requestStub([
    {
      ok: true,
      items: [{ domainId: "platform", id: "design-assistant", status: "ACTIVE" }],
    },
    { ok: true, items: [existing] },
  ]);
  const actions = createMainUiBuildActions({
    request: stub.request,
    requestId: () => "unused",
  });

  const result = await actions.prepareAgent({
    project: {
      domainId: "platform",
      id: "design-assistant",
      name: "Design Assistant",
      description: "",
    },
    agent: {
      ...existing,
      buildConfig: {
        ...existing.buildConfig,
        instructions: "Changed instructions.",
      },
    },
  });

  assert.deepEqual(result, {
    ok: false,
    code: "AGENT_CONFIGURATION_LOCKED",
    message:
      "This Agent ID already has a tested or deployed configuration. "
      + "Choose a new Agent ID to build a different version.",
  });
  assert.equal(stub.calls.length, 2);
});

test("foundation preview uses the canonical journey and delivery APIs", async () => {
  const stub = requestStub([
    {
      ok: true,
      journey: {
        id: "journey-1",
        repositoryName: "support-foundation",
      },
    },
    {
      ok: true,
      delivery: {
        id: "delivery-1",
        repositoryName: "support-foundation",
      },
    },
  ]);
  let requestNumber = 0;
  const actions = createMainUiBuildActions({
    request: stub.request,
    requestId: () => `request-${++requestNumber}`,
  });
  const result = await actions.previewFoundation("support-foundation");
  assert.equal(result.delivery.id, "delivery-1");
  assert.deepEqual(stub.calls[0].body, {
    preset: "MINIMAL",
    repositoryName: "support-foundation",
  });
  assert.deepEqual(stub.calls[1].body, {
    preset: "MINIMAL",
    repositoryName: "support-foundation",
    journeyId: "journey-1",
  });
});

test("AI-assisted journey records messages and creates its contract", async () => {
  const stub = requestStub([
    {
      ok: true,
      journey: {
        id: "journey-1",
        repositoryName: "support-assistant",
        transcript: [],
      },
    },
    {
      ok: true,
      journey: {
        id: "journey-1",
        transcript: [{ role: "user", text: "Support agents use it." }],
      },
    },
    {
      ok: true,
      journey: {
        id: "journey-1",
        status: "CONTRACT_READY",
        inception: { profile: { name: "Support Assistant" } },
      },
    },
  ]);
  let requestNumber = 0;
  const actions = createMainUiBuildActions({
    request: stub.request,
    requestId: () => `request-${++requestNumber}`,
  });
  const started = await actions.startSpec("support-assistant");
  const messaged = await actions.addSpecMessage(
    started.journey.id,
    "Support agents use it.",
  );
  const contract = await actions.createSpecContract(messaged.journey.id);
  assert.equal(contract.journey.status, "CONTRACT_READY");
  assert.deepEqual(
    stub.calls.map(({ path }) => path),
    [
      "/journeys",
      "/journeys/journey-1/messages",
      "/journeys/journey-1/contract",
    ],
  );
});

test("tested Agents can be published and previewed through canonical APIs", async () => {
  const stub = requestStub([
    {
      ok: true,
      agent: {
        domainId: "customer_support",
        projectId: "case-assist",
        id: "triage-agent",
        status: "TESTED",
      },
      test: { output: "Ready" },
    },
    { ok: true, record: { status: "PENDING_APPROVAL" } },
    {
      ok: true,
      delivery: {
        id: "delivery-1",
        repositoryName: "triage-agent",
      },
    },
  ]);
  let requestNumber = 0;
  const actions = createMainUiBuildActions({
    request: stub.request,
    requestId: () => `request-${++requestNumber}`,
  });
  const ref = {
    domainId: "customer_support",
    projectId: "case-assist",
    agentId: "triage-agent",
  };
  const tested = await actions.testAgent(ref, "Confirm readiness.");
  const published = await actions.publishAgent(ref);
  const previewed = await actions.previewFull(ref, "triage-agent");
  assert.equal(tested.agent.status, "TESTED");
  assert.equal(published.record.status, "PENDING_APPROVAL");
  assert.equal(previewed.delivery.id, "delivery-1");
});

test("tested Agents use deterministic bounded sandbox and production deployment IDs", async () => {
  const stub = requestStub([
    {
      ok: true,
      agent: {
        domainId: "customer_support",
        projectId: "case-assist",
        id: "a".repeat(64),
        status: "SANDBOX_DEPLOYED",
      },
    },
    {
      ok: true,
      agent: {
        domainId: "customer_support",
        projectId: "case-assist",
        id: "a".repeat(64),
        status: "PRODUCTION_PENDING",
      },
      approval: { id: "approval-1", status: "PENDING" },
    },
  ]);
  let requestNumber = 0;
  const actions = createMainUiBuildActions({
    request: stub.request,
    requestId: () => `request-${++requestNumber}`,
  });
  const ref = {
    domainId: "customer_support",
    projectId: "case-assist",
    agentId: "a".repeat(64),
  };

  const sandbox = await actions.deploySandbox(ref);
  const production = await actions.submitProduction(ref);

  assert.equal(sandbox.agent.status, "SANDBOX_DEPLOYED");
  assert.equal(production.agent.status, "PRODUCTION_PENDING");
  assert.deepEqual(stub.calls[0], {
    path: "/deployments/sandbox",
    body: {
      ...ref,
      deploymentId: `${"a".repeat(55)}-sandbox`,
    },
    options: {
      method: "POST",
      requestId: "request-1",
    },
  });
  assert.deepEqual(stub.calls[1], {
    path: "/deployments/production",
    body: {
      ...ref,
      deploymentId: `${"a".repeat(52)}-production`,
      approvalId: `${"a".repeat(43)}-production-approval`,
    },
    options: {
      method: "POST",
      requestId: "request-2",
    },
  });
  assert.ok(stub.calls[0].body.deploymentId.length <= 63);
  assert.ok(stub.calls[1].body.deploymentId.length <= 63);
  assert.ok(stub.calls[1].body.approvalId.length <= 63);
});

test('prepareAgent reads later inventory pages without creating a workspace', async () => {
  const stub=requestStub([
    {ok:true,items:[],cursor:'next'},
    {ok:true,items:[{domainId:'platform',id:'existing',status:'ACTIVE'}]},
    {ok:true,items:[{domainId:'platform',projectId:'existing',id:'agent',name:'Agent',status:'READY_FOR_TEST',buildConfig:{instructions:'Help'}}]},
  ]);
  const actions=createMainUiBuildActions({request:stub.request,requestId:()=>{throw Error('No write expected')}});
  const result=await actions.prepareAgent({project:{domainId:'platform',id:'existing'},agent:{domainId:'platform',projectId:'existing',id:'agent',name:'Agent',buildConfig:{instructions:'Help'}}});
  assert.equal(result.ok,true);
  assert.deepEqual(stub.calls.map(c=>c.path),['/projects','/projects?cursor=next','/agents']);
});

test('incomplete inventory never triggers creation', async () => {
  const stub=requestStub([{ok:true,items:[],cursor:'loop'},{ok:true,items:[],cursor:'loop'}]);
  const actions=createMainUiBuildActions({request:stub.request,requestId:()=>{throw Error('No write expected')}});
  const result=await actions.prepareAgent({project:{domainId:'platform',id:'existing'},agent:{name:'Agent',buildConfig:{instructions:'Help'}}});
  assert.equal(result.code,'INVALID_INVENTORY');
  assert.equal(stub.calls.length,2);
});
