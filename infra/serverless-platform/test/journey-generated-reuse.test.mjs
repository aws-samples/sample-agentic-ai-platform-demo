import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { composeJourneyManifest } from "../lambda/journeys/manifest.mjs";
import { createFullBuildSnapshotResolver } from "../lambda/journeys/runtime.mjs";
import { recordToVersion } from "../../../console/registry-shape.mjs";

const REGISTRY = "FixtureReg1234";
const VERSION = "1.2.3";
const OPTIONS = {
  framework: "Strands", deployTarget: "AgentCore Runtime", memory: "none",
  streaming: true, identity: true, guardrails: true,
};

function gateway() {
  const account = "000000" + "000000";
  return {
    schemaVersion: 1, operation: "add_numbers", region: "us-west-2",
    gatewayArn: `arn:aws:bedrock-agentcore:us-west-2:${account}:gateway/fixture-math-abcdefghij`,
    endpoint: "https://fixture-math-abcdefghij.gateway.bedrock-agentcore.us-west-2.amazonaws.com/mcp",
    targetId: "fixturetarget", targetName: "fixture-math",
    qualifiedToolName: "fixture-math___add_numbers", protocolVersion: "2026-07-28",
    auth: "AWS_IAM",
    policy: {
      engineArn: `arn:aws:bedrock-agentcore:us-west-2:${account}:policy-engine/fixture-engine`,
      policyId: "fixture-policy", definitionSha256: "a".repeat(64), enforcementMode: "ENFORCE",
    },
  };
}

function fixture({ project = "fixture-first", configured = true, status = "APPROVED", grant = true } = {}) {
  const entry = (id, type, content) => ({
    id, type, domain: "shared", defaultVersion: VERSION,
    versions: [{ semver: VERSION, status, content, _aws: { registryId: REGISTRY, recordId: id } }],
  });
  const content = { toolType: "agentcore_gateway" };
  if (configured) content.gatewayBinding = gateway();
  const inventory = {
    registry: { entries: [
      entry("chat-assistant", "Blueprint", { template: { ...OPTIONS } }),
      entry("fixture-math", "Tool", content),
    ] },
    aiGateway: { models: [entry("fixture-model", "Model", { runtimeModelId: "fixture.model" })] },
  };
  const agent = {
    domainId: "fixture_domain", projectId: project, id: `${project}-agent`,
    name: "Fixture arithmetic agent", modelId: "fixture-model",
    blueprintIds: [`${REGISTRY}/chat-assistant`], toolIds: ["fixture-math"],
    mcpServerIds: [], skillIds: [], memoryIds: [], knowledgeBaseIds: [],
    buildConfig: {
      instructions: `Arithmetic for ${project}.`,
      modelParameters: { temperature: 0, maxTokens: 128 }, buildOptions: { ...OPTIONS },
    },
    lastTestEvidenceHash: "b".repeat(64),
  };
  const resolver = createFullBuildSnapshotResolver({
    inventoryProvider: async () => inventory, modelAccessResolver: async () => true,
    workspaceState: { getResourceGrant: async (input) => grant ? {
      ...input, status: "ACTIVE", revokedBySubject: null, revokedAt: null,
    } : null },
  });
  const resolve = () => resolver({
    identity: { actor: "fixture-builder", role: "builder", activeDomain: "fixture_domain" }, agent,
  });
  return { inventory, agent, resolve };
}

async function materialize(options, run) {
  const snapshot = await fixture(options).resolve();
  const manifest = composeJourneyManifest({
    preset: "FULL", repositoryName: snapshot.agent.projectId, source: { snapshot },
  });
  const directory = mkdtempSync(join(tmpdir(), "governed-reuse-"));
  try {
    for (const entry of manifest.entries) {
      const output = join(directory, entry.path);
      mkdirSync(dirname(output), { recursive: true });
      writeFileSync(output, entry.content);
    }
    await run({ directory, manifest, snapshot });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function execute(directory, command, args, expected = 0) {
  const result = spawnSync(command, args, {
    cwd: directory, encoding: "utf8", timeout: 30_000,
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
  });
  assert.equal(result.status, expected, `${result.error || ""}\n${result.stdout}\n${result.stderr}`);
  return result;
}

test("existing resolver pins approved selection, version, blueprint and copies binding", async () => {
  const f = fixture();
  const snapshot = await f.resolve();
  assert.equal(snapshot.blueprint.registryId, REGISTRY);
  assert.equal(snapshot.blueprint.version, VERSION);
  assert.deepEqual(snapshot.resources[0], {
    type: "TOOL", id: "fixture-math", registryId: REGISTRY, recordId: "fixture-math",
    version: VERSION, binding: { adapter: "agentcore_gateway", status: "MATERIALIZED", gateway: gateway() },
  });
  f.inventory.registry.entries[1].versions[0].content.gatewayBinding.targetId = "mutated";
  assert.equal(snapshot.resources[0].binding.gateway.targetId, "fixturetarget");
  for (const options of [{ status: "DRAFT" }, { status: "REJECTED" }, { grant: false }]) {
    await assert.rejects(fixture(options).resolve, /unavailable|blueprint|granted/);
  }
  const unselected = fixture();
  unselected.agent.toolIds = ["unselected"];
  await assert.rejects(unselected.resolve, /unavailable/);
  const nondefault = fixture();
  nondefault.inventory.registry.entries[1].defaultVersion = "9.0.0";
  await assert.rejects(nondefault.resolve, /unavailable/);
  const malicious = fixture();
  malicious.inventory.registry.entries[1].versions[0].content.gatewayBinding.headers = { token: "fixture-only" };
  await assert.rejects(malicious.resolve, /Gateway binding/);
});

test("existing legacy Skill tool projection requires reviewed deployment binding without parser changes", async () => {
  // A pre-existing Registry Skill tool projection is accepted by the resolver.
  // This fixture is not a new governance publication or independent approval.
  const mapped = recordToVersion({
    registryId: REGISTRY, recordId: "fixture-math", name: "fixture-math",
    recordType: "SKILL", recordVersion: VERSION, status: "APPROVED",
    descriptors: { agentSkillsDefinition: { data: JSON.stringify({
      "x-platform": { id: "fixture-math", toolType: "agentcore_gateway", domain: "shared" },
    }) } },
  });
  const f = fixture({ configured: false });
  f.inventory.registry.entries[1] = {
    ...mapped.entry, defaultVersion: VERSION, versions: [mapped.version],
  };
  const snapshot = await f.resolve();
  assert.equal(snapshot.resources[0].type, "TOOL");
  assert.equal(snapshot.resources[0].binding.status, "DEPLOYMENT_REQUIRED");
  const result = composeJourneyManifest({
    preset: "FULL", repositoryName: "legacy-tool-fixture", source: { snapshot },
  });
  const config = JSON.parse(result.entries.find(({ path }) =>
    path === "app/chat_agent/gateway-deployment.json").content);
  assert.equal(config.gateway, null);
  assert.equal(config.selection.resource.recordId, "fixture-math");
});

test("same blueprint generates deterministic but isolated project configurations", async () => {
  const first = await fixture().resolve();
  const second = await fixture({ project: "fixture-second" }).resolve();
  const manifest = (snapshot) => composeJourneyManifest({
    preset: "FULL", repositoryName: snapshot.agent.projectId, source: { snapshot },
  });
  const a = manifest(first);
  const b = manifest(second);
  assert.deepEqual(a, manifest(structuredClone(first)));
  assert.deepEqual(first.blueprint, second.blueprint);
  assert.notEqual(a.fingerprint, b.fingerprint);
  assert.ok(!JSON.stringify(b).includes("fixture-first"));
  for (const result of [a, b]) {
    const files = new Map(result.entries.map((entry) => [entry.path, entry.content]));
    const config = JSON.parse(files.get("app/chat_agent/gateway-deployment.json"));
    assert.equal(config.selection.blueprint.version, VERSION);
    assert.equal(config.selection.resource.recordId, "fixture-math");
    assert.equal(JSON.parse(files.get("agentcore/agentcore.json")).runtimes[0].authorizerType, "AWS_IAM");
    assert.equal(JSON.parse(files.get("gates/platform-gates.json")).telemetryBucket, null);
    assert.match(files.get("app/chat_agent/main.py"), /from governed_gateway import build_governed_tools/);
    assert.match(files.get("app/chat_agent/main.py"), /tools.extend\(build_governed_tools\(\)\)/);
    assert.doesNotMatch(files.get("app/chat_agent/main.py"), /def add_numbers/);
    assert.doesNotMatch([...files.values()].join("\n"), /MCP_SERVER_URL|get_streamable_http_mcp_client/);
    assert.match(files.get("agentcore/cdk/lib/cdk-stack.ts"), /governedGatewayOutputs\(this\)/);
    for (const path of [
      ".github/workflows/tests.yml", ".github/workflows/eval.yml",
      ".github/workflows/deploy-dev.yml", ".github/workflows/promote.yml",
      "gates/run-tests.mjs", "gates/run-eval.mjs", "gates/platform-gates.json",
      "agentcore/cdk/lib/governed-gateway.ts", "agentcore/datasets/golden.jsonl",
    ]) assert.ok(files.has(path), path);
  }
});

test("generated Python compiles, main imports without network, selected Strands wrapper calls exact transport", async () => {
  await materialize({}, ({ directory }) => {
    // Dependency doubles are explicitly offline fixtures; not a real SDK/model run.
    const script = String.raw`
import ast, importlib, json, logging, pathlib, socket, sys, types
root = pathlib.Path("app/chat_agent")
for path in root.rglob("*.py"):
    compile(path.read_text(), str(path), "exec")
sys.path.insert(0, str(root))
def forbidden(*a, **k):
    raise AssertionError("network forbidden in offline fixture")
socket.socket.connect = forbidden
socket.socket.connect_ex = forbidden
socket.create_connection = forbidden
socket.getaddrinfo = forbidden
def module(name, **values):
    m = types.ModuleType(name)
    m.__dict__.update(values)
    sys.modules[name] = m
    return m
class FakeApp:
    logger = logging.getLogger("offline-main")
    def entrypoint(self, fn): return fn
class FixtureTool:
    def __init__(self, fn): self.fn = fn
    def __call__(self, *args, **kw): return self.fn(*args, **kw)
module("strands", Agent=forbidden, tool=FixtureTool)
module("strands.agent.conversation_manager.null_conversation_manager", NullConversationManager=object)
module("strands.vended_plugins.skills", AgentSkills=object)
module("bedrock_agentcore.runtime", BedrockAgentCoreApp=FakeApp)
module("model.load", load_model=forbidden)
module("memory.session", get_memory_session_manager=forbidden)
module("identity.profile", profile_from_context=forbidden, personalize=forbidden)
module("telemetry", setup_langfuse=forbidden)
module("metrics", AgentMetrics=forbidden)
main = importlib.import_module("main")
g = importlib.import_module("governed_gateway")
assert len(main.tools) == 1 and isinstance(main.tools[0], FixtureTool)
events, calls = [], []
class Capture(logging.Handler):
    def emit(self, record): events.append(json.loads(record.getMessage()))
logger = logging.getLogger("governed_gateway.evidence")
logger.setLevel(logging.INFO)
logger.addHandler(Capture())
def sign(gateway, body):
    assert gateway["auth"] == "AWS_IAM"
    return {"fixture": "offline-not-credentials"}
g._signed_headers = sign
mode = "success"
def post(gateway, body, headers):
    request = json.loads(body)
    calls.append(request)
    assert gateway["endpoint"] == "https://fixture-math-abcdefghij.gateway.bedrock-agentcore.us-west-2.amazonaws.com/mcp"
    assert request["method"] == "tools/call"
    assert request["params"]["name"] == "fixture-math___add_numbers"
    assert request["params"]["arguments"] == {"a": 2, "b": 3}
    assert request["params"]["_meta"]["io.modelcontextprotocol/protocolVersion"] == "2026-07-28"
    assert "io.modelcontextprotocol/clientInfo" in request["params"]["_meta"]
    assert request["params"]["_meta"]["io.modelcontextprotocol/clientCapabilities"] == {}
    result = {"content": [{"type": "text", "text": "5"}]}
    status = 200
    if mode in ("denial", "403"):
        result = {"isError": True, "content": [{"type": "text", "text": g._DENIAL + "fixture-only]"}]}
    if mode == "tool": result = {"isError": True, "content": [{"type": "text", "text": "hidden response"}]}
    if mode == "wrong": result = {"content": [{"type": "text", "text": "6"}]}
    if mode in ("403", "302", "409"): status = int(mode)
    if mode == "oversized": return 200, b"x" * 65537, ""
    if mode == "timeout": raise TimeoutError("hidden transport/headers")
    response = {"jsonrpc": "2.0", "id": request["id"], "result": result}
    if mode == "rpc": response = {"jsonrpc": "2.0", "id": request["id"], "error": {"message": "hidden"}}
    if mode == "mismatch": response["id"] = "another-request"
    return status, json.dumps(response).encode(), "fixture-request"
g._post = post
for mode, classification in [
    ("success", "GATEWAY_SUCCESS"), ("denial", "POLICY_DENIAL_SHAPED"),
    ("403", "AUTHORIZATION_ERROR"), ("302", "HTTP_ERROR"), ("409", "CONFLICT"),
    ("tool", "TOOL_ERROR"), ("wrong", "PROTOCOL_ERROR"), ("mismatch", "PROTOCOL_ERROR"),
    ("rpc", "RPC_ERROR"), ("oversized", "TRANSPORT_ERROR"), ("timeout", "TRANSPORT_ERROR"),
]:
    before = len(calls)
    result = main.tools[0](2, 3)
    assert len(calls) == before + 1  # no retry
    assert result["status"] == ("success" if mode == "success" else "error")
    assert events[-1]["classification"] == classification
    assert events[-1]["nativePolicyEvidence"] == "UNVERIFIED"
for args in [(True, 3), (1001, 3), (2.0, 3), ("2", 3)]:
    try: main.tools[0](*args); raise AssertionError("accepted unsafe arguments")
    except ValueError: pass
for override in ["endpoint", "qualifiedToolName", "gateway", "sessionId", "headers"]:
    try: main.tools[0](2, 3, **{override: "unselected"}); raise AssertionError("accepted override")
    except TypeError: pass
assert "hidden" not in json.dumps(events)
assert "arguments" not in json.dumps(events)
print("OFFLINE_FIXTURE: compiled runtime; main consumed selected wrapper; 11 response classes; no cloud")
`;
    const result = execute(directory, "python3", ["-c", script]);
    assert.match(result.stdout, /OFFLINE_FIXTURE/);
  });
});

test("generated configuration gates fail closed on missing, changed and mismatched bindings", async () => {
  await materialize({ configured: false }, ({ directory }) => {
    const path = join(directory, "app/chat_agent/gateway-deployment.json");
    const original = JSON.parse(readFileSync(path, "utf8"));
    execute(directory, process.execPath, ["gates/check-resource-bindings.mjs"], 1);
    execute(directory, "python3", ["-c", String.raw`
import sys
sys.path.insert(0, "app/chat_agent")
import governed_gateway as g
def forbidden(*args): raise AssertionError("unconfigured binding reached credentials or transport")
g._signed_headers = forbidden
g._post = forbidden
result = g._invoke(2, 3)
assert result["status"] == "error"
assert "DEPLOYMENT_REQUIRED" in result["content"][0]["text"]
`]);
    const reviewedFixture = { ...original, gateway: gateway() };
    writeFileSync(path, JSON.stringify(reviewedFixture));
    execute(directory, process.execPath, ["gates/check-resource-bindings.mjs"]);
    const evidence = JSON.parse(readFileSync(join(directory, "artifacts/governed-binding-check.json")));
    assert.equal(evidence.nativePolicyEvidence, "UNVERIFIED");
    assert.equal(evidence.configurationConformance, "PASS");
    for (const mutate of [
      (v) => { v.selection.resource.version = "9.9.9"; },
      (v) => { v.selection.resource.recordId = "another-tool"; },
      (v) => { v.selection.blueprint.version = "9.9.9"; },
      (v) => { v.selection.projectId = "fixture-second"; },
      (v) => { v.gateway.endpoint = "https://attacker.invalid/mcp"; },
      (v) => { v.gateway.qualifiedToolName = "other___add_numbers"; },
      (v) => { v.gateway.policy.enforcementMode = "LOG_ONLY"; },
      (v) => { v.gateway.auth = "NONE"; },
    ]) {
      const bad = structuredClone(reviewedFixture);
      mutate(bad);
      writeFileSync(path, JSON.stringify(bad));
      execute(directory, process.execPath, ["gates/check-resource-bindings.mjs"], 1);
    }
  });
  await materialize({}, ({ directory }) => {
    execute(directory, process.execPath, ["gates/check-resource-bindings.mjs"]);
    execute(directory, process.execPath, ["gates/check-guardrails.mjs"]);
    execute(directory, "python3", ["-m", "unittest", "discover", "-s", "tests", "-p", "test_governed_tool.py"]);
    const path = join(directory, "app/chat_agent/gateway-deployment.json");
    const value = JSON.parse(readFileSync(path, "utf8"));
    value.gateway.targetId = "other-target";
    writeFileSync(path, JSON.stringify(value));
    execute(directory, process.execPath, ["gates/check-resource-bindings.mjs"], 1);
  });
});

test("generated eval gate reports missing transcripts without claiming offline quality", async () => {
  await materialize({}, ({ directory }) => {
    const result = execute(directory, process.execPath, ["gates/run-eval.mjs", "--mode", "assert"], 1);
    assert.match(result.stderr, /NO recorded transcript/);
    const scorecard = readFileSync(join(directory, "eval-scorecard.md"), "utf8");
    assert.match(scorecard, /Eval gate scorecard — FAIL/);
    assert.match(scorecard, /missing transcript/);
  });
});

test("generated test gate ignores compiled CDK Jest output before Python dependency setup", async () => {
  await materialize({}, ({ directory }) => {
    const compiled = join(directory, "agentcore/cdk/dist/test/cdk.test.js");
    mkdirSync(dirname(compiled), { recursive: true });
    writeFileSync(compiled, 'throw new Error("compiled Jest is not a Node test");\n');
    const bin = join(directory, ".venv/bin");
    mkdirSync(bin, { recursive: true });
    // Deliberately unavailable fixture installer: no network/package changes,
    // and this dispatch check never pretends the Python suite passed.
    writeFileSync(join(bin, "python"),
      '#!/bin/sh\nif [ "$1" = "-m" ] && [ "$2" = "pip" ]; then\necho OFFLINE_FIXTURE_DEPENDENCY_MISSING\nexit 23\nfi\nexit 24\n', { mode: 0o755 });
    const result = spawnSync(process.execPath, ["gates/run-tests.mjs"], {
      cwd: directory, encoding: "utf8", timeout: 30_000,
      env: { ...process.env, PATH: `${dirname(process.execPath)}:${process.env.PATH}` },
    });
    assert.equal(result.status, 1);
    assert.match(result.stdout, /OFFLINE_FIXTURE_DEPENDENCY_MISSING/);
    assert.doesNotMatch(result.stdout, /compiled Jest is not a Node test/);
  });
});

test("generated transport bounds response bytes, timeout and closes once without redirects or retries", async () => {
  await materialize({}, ({ directory }) => {
    execute(directory, "python3", ["-c", String.raw`
import sys
sys.path.insert(0, "app/chat_agent")
import governed_gateway as g
calls = []
class Response:
    status = 302
    def read1(self, size): return b""
    def getheader(self, name, default): return "fixture-id"
class Connection:
    sock = None
    def __init__(self, host, timeout):
        assert host.endswith(".amazonaws.com") and timeout == 5
    def request(self, method, path, body, headers): calls.append((method, path))
    def getresponse(self): return Response()
    def close(self): calls.append("closed")
g.http.client.HTTPSConnection = Connection
assert g._post(g._binding(), b"{}", {})[0] == 302
assert calls == [("POST", "/mcp"), "closed"]
Response.read1 = lambda self, size: b"x" * size
try: g._post(g._binding(), b"{}", {}); raise AssertionError("unbounded body")
except ValueError: pass
assert calls[-1] == "closed"
times = iter([0, 6])
g.time.monotonic = lambda: next(times)
try: g._post(g._binding(), b"{}", {}); raise AssertionError("unbounded time")
except TimeoutError: pass
assert calls[-1] == "closed"
print("OFFLINE_FIXTURE: HTTPS transport bounded; closed; no redirects/retries")
`]);
  });
});

test("this slice rejects multiple Gateway tools and unauthenticated Runtime export", async () => {
  const snapshot = await fixture().resolve();
  const compose = () => composeJourneyManifest({
    preset: "FULL", repositoryName: "fixture", source: { snapshot },
  });
  snapshot.resources.push(structuredClone(snapshot.resources[0]));
  assert.throws(compose, /one chatagent arithmetic tool/);
  snapshot.resources.pop();
  snapshot.agent.buildOptions.identity = false;
  snapshot.blueprint.template.identity = false;
  assert.throws(compose, /authenticated Runtime/);
});
