import { createHash } from "node:crypto";

const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
const sha = (value) => createHash("sha256").update(value).digest("hex");

export function governedToolCiEntry(entry) {
  if (entry.path === "gates/check-resource-bindings.mjs") {
    return {
      ...entry,
      content: '// platform-gate: v1 — selected Gateway configuration\nimport "./check-governed-tool.mjs";\n',
    };
  }
  // The shared test runner excludes generated CDK and runtime directories.
  // Preserve it verbatim so tool exports use the same Python/test dispatch.
  return entry;
}

// Generated assets are composed here, leaving the shared blueprint bytes alone.
export function governedToolAssets(snapshot, runtimePath) {
  const selected = snapshot.resources.filter((resource) =>
    resource.type === "TOOL" && resource.binding.adapter === "agentcore_gateway");
  if (!selected.length) return null;
  if (selected.length !== 1 || snapshot.blueprint.templateId !== "chatagent") {
    throw new TypeError("Governed Gateway export supports one chatagent arithmetic tool.");
  }
  if (snapshot.agent.buildOptions.identity !== true) {
    throw new TypeError("Governed Gateway export requires authenticated Runtime access.");
  }
  if (["registryId", "recordId", "version", "blueprintId"].some((key) =>
    typeof snapshot.blueprint[key] !== "string" || !snapshot.blueprint[key])) {
    throw new TypeError("Governed Gateway export requires pinned blueprint references.");
  }
  const resource = selected[0];
  const selection = {
    schemaVersion: 1,
    domainId: snapshot.agent.domainId,
    projectId: snapshot.agent.projectId,
    agentId: snapshot.agent.id,
    blueprint: {
      registryId: snapshot.blueprint.registryId,
      recordId: snapshot.blueprint.recordId,
      version: snapshot.blueprint.version,
      blueprintId: snapshot.blueprint.blueprintId,
      templateId: snapshot.blueprint.templateId,
    },
    resource: {
      type: resource.type, id: resource.id, registryId: resource.registryId,
      recordId: resource.recordId, version: resource.version,
    },
  };
  const selectionJson = json(selection);
  const pinnedGateway = resource.binding.gateway || null;
  const deploymentPath = `${runtimePath}/gateway-deployment.json`;
  const configuration = json({ selection, gateway: pinnedGateway });
  const python = String.raw`"""One approved arithmetic Gateway surface; no network or credentials at import.

gateway-deployment.json is reviewed deployment code, never invocation data.
Response classification is NOT native Policy proof. No platform revocation
guarantee survives an exported snapshot; IAM and native Policy remain authoritative.
"""
import hashlib
import http.client
import json
import logging
import re
import time
import uuid
from pathlib import Path
from urllib.parse import urlsplit

_SELECTION = json.loads(${JSON.stringify(JSON.stringify(selection))})
_PINNED_GATEWAY = json.loads(${JSON.stringify(JSON.stringify(pinnedGateway))})
_CONFIG = Path(__file__).with_name("gateway-deployment.json")
_MAX_BYTES = 65536
_TIMEOUT = 5.0
_DENIAL = "AuthorizeActionException - Tool Execution Denied: Tool call not allowed due to policy enforcement ["


class BindingError(ValueError):
    pass


def _exact(value, fields):
    return isinstance(value, dict) and set(value) == set(fields.split())


def _matches(pattern, value):
    return isinstance(value, str) and re.fullmatch(pattern, value) is not None


def _binding():
    if _CONFIG.stat().st_size > _MAX_BYTES:
        raise BindingError("Invalid deployment binding.")
    value = json.loads(_CONFIG.read_text())
    if not _exact(value, "selection gateway") or value["selection"] != _SELECTION:
        raise BindingError("Selected resource/blueprint/project binding changed.")
    g = value["gateway"]
    if g is None:
        raise BindingError("DEPLOYMENT_REQUIRED: reviewed Gateway binding is missing.")
    if _PINNED_GATEWAY is not None and g != _PINNED_GATEWAY:
        raise BindingError("Approved concrete Gateway binding changed.")
    if not _exact(g, "schemaVersion operation region gatewayArn endpoint targetId targetName qualifiedToolName protocolVersion auth policy"):
        raise BindingError("Invalid Gateway binding.")
    arn = re.fullmatch(r"arn:aws:bedrock-agentcore:([a-z]{2}-[a-z]+-\d):(\d{12}):gateway/([a-z][a-z0-9-]{0,99})", g["gatewayArn"]) if isinstance(g["gatewayArn"], str) else None
    if not arn:
        raise BindingError("Invalid Gateway ARN.")
    region, account, gateway_id = arn.groups()
    policy = g["policy"]
    if not (
        type(g["schemaVersion"]) is int and g["schemaVersion"] == 1
        and g["operation"] == "add_numbers"
        and g["region"] == region
        and g["endpoint"] == f"https://{gateway_id}.gateway.bedrock-agentcore.{region}.amazonaws.com/mcp"
        and _matches(r"[A-Za-z0-9-]{1,100}", g["targetId"])
        and _matches(r"[A-Za-z][A-Za-z0-9-]{0,99}", g["targetName"])
        and g["qualifiedToolName"] == g["targetName"] + "___add_numbers"
        and g["protocolVersion"] == "2026-07-28"
        and g["auth"] == "AWS_IAM"
        and _exact(policy, "engineArn policyId definitionSha256 enforcementMode")
        and _matches(re.escape(f"arn:aws:bedrock-agentcore:{region}:{account}:policy-engine/") + r"[A-Za-z0-9_-]{1,100}", policy["engineArn"])
        and _matches(r"[A-Za-z0-9_-]{1,100}", policy["policyId"])
        and _matches(r"[a-f0-9]{64}", policy["definitionSha256"])
        and policy["enforcementMode"] == "ENFORCE"
    ):
        raise BindingError("Unsupported Gateway binding.")
    return g


def validate_deployment():
    """Offline configuration gate; does not assert live IAM/Policy readiness."""
    _binding()


def _signed_headers(gateway, body):
    # Default SDK provider chain, deferred to invocation. Native tool IAM auth
    # is independent of the Bedrock model client. Never log signed headers.
    from botocore.auth import SigV4Auth
    from botocore.awsrequest import AWSRequest
    from botocore.session import Session
    # Botocore's signer logs the canonical request (including session-token
    # headers) at DEBUG. Disable that logger even if the host enables debug.
    logging.getLogger("botocore.auth").disabled = True
    credentials = Session().get_credentials()
    if credentials is None:
        raise BindingError("Gateway credentials unavailable.")
    request = AWSRequest(method="POST", url=gateway["endpoint"], data=body, headers={
        "Content-Type": "application/json",
        "Accept": "application/json",
        "MCP-Protocol-Version": gateway["protocolVersion"],
        "Mcp-Method": "tools/call",
        "Mcp-Name": gateway["qualifiedToolName"],
    })
    SigV4Auth(credentials.get_frozen_credentials(), "bedrock-agentcore", gateway["region"]).add_auth(request)
    return dict(request.headers)


def _post(gateway, body, headers):
    # Direct HTTPS: no redirects, proxy/env endpoint overrides, or retries.
    # A monotonic body deadline bounds slow streaming; DNS/provider resolution
    # still depends on the host/SDK and must be bounded by the Runtime operator.
    endpoint = urlsplit(gateway["endpoint"])
    connection = http.client.HTTPSConnection(endpoint.hostname, timeout=_TIMEOUT)
    deadline = time.monotonic() + _TIMEOUT
    try:
        connection.request("POST", "/mcp", body=body, headers=headers)
        response = connection.getresponse()
        chunks = []
        size = 0
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError("Gateway response timeout.")
            if connection.sock is not None:
                connection.sock.settimeout(remaining)
            chunk = response.read1(min(8192, _MAX_BYTES + 1 - size))
            size += len(chunk)
            if size > _MAX_BYTES:
                raise ValueError("Gateway response too large.")
            if not chunk:
                break
            chunks.append(chunk)
        return response.status, b"".join(chunks), response.getheader("x-amzn-requestid", "")
    finally:
        connection.close()


def _emit_evidence(classification, request_id, gateway, status=None, provider_id=""):
    # Deliberately exclude args, prompts, responses, headers and exception text.
    event = {
        "schemaVersion": 1,
        "source": "GENERATED_GATEWAY_RESPONSE",
        "nativePolicyEvidence": "UNVERIFIED",
        "principalEvidence": "UNVERIFIED",
        "selectionSha256": ${JSON.stringify(sha(selectionJson))},
        "domainId": _SELECTION["domainId"],
        "projectId": _SELECTION["projectId"],
        "agentId": _SELECTION["agentId"],
        "requestId": request_id,
        "classification": classification,
        "httpStatus": status,
        "bindingSha256": hashlib.sha256(json.dumps(gateway, sort_keys=True, separators=(",", ":")).encode()).hexdigest() if gateway else None,
    }
    if _matches(r"[A-Za-z0-9-]{1,128}", provider_id):
        event["providerRequestId"] = provider_id
    logging.getLogger("governed_gateway.evidence").info(json.dumps(event, sort_keys=True))


def _result(kind, message):
    return {"status": kind, "content": [{"text": message}]}


def _invoke(a, b):
    # bool is an int subclass; it is explicitly rejected.
    if any(type(n) is not int or not -1000 <= n <= 1000 for n in (a, b)):
        raise ValueError("a and b must be integers between -1000 and 1000.")
    request_id = str(uuid.uuid4())
    try:
        gateway = _binding()
    except (OSError, ValueError, TypeError):
        _emit_evidence("UNCONFIGURED", request_id, None)
        return _result("error", "DEPLOYMENT_REQUIRED: reviewed Gateway binding is unavailable.")
    body = json.dumps({
        "jsonrpc": "2.0", "id": request_id, "method": "tools/call",
        "params": {
            "name": gateway["qualifiedToolName"], "arguments": {"a": a, "b": b},
            "_meta": {
                "io.modelcontextprotocol/protocolVersion": gateway["protocolVersion"],
                "io.modelcontextprotocol/clientInfo": {"name": "governed-arithmetic", "version": "1.0.0"},
                "io.modelcontextprotocol/clientCapabilities": {},
            },
        },
    }, separators=(",", ":")).encode()
    status, provider_id = None, ""
    classification = "TRANSPORT_ERROR"
    answer = None
    try:
        headers = _signed_headers(gateway, body)
        status, raw, provider_id = _post(gateway, body, headers)
        if len(raw) > _MAX_BYTES:
            raise ValueError("Gateway response too large.")
        if status in (401, 403):
            classification = "AUTHORIZATION_ERROR"
        elif status == 409:
            classification = "CONFLICT"  # Not proof of temporal Policy invalidation.
        elif status != 200:
            classification = "HTTP_ERROR"  # Includes redirects; never follows them.
        else:
            classification = "PROTOCOL_ERROR"
            response = json.loads(raw)
            if isinstance(response, dict) and response.get("jsonrpc") == "2.0" and response.get("id") == request_id:
                result = response.get("result")
                if "error" in response:
                    classification = "RPC_ERROR"
                elif isinstance(result, dict):
                    content = result.get("content")
                    if result.get("isError") is True:
                        classification = "TOOL_ERROR"
                        if isinstance(content, list) and any(
                            isinstance(item, dict) and item.get("type") == "text"
                            and isinstance(item.get("text"), str) and item["text"].startswith(_DENIAL)
                            for item in content
                        ):
                            classification = "POLICY_DENIAL_SHAPED"
                    elif result.get("isError", False) is False and isinstance(content, list) and len(content) == 1:
                        item = content[0]
                        if isinstance(item, dict) and item.get("type") == "text" and _matches(r"-?\d{1,4}", item.get("text")):
                            number = int(item["text"])
                            if number == a + b:
                                classification, answer = "GATEWAY_SUCCESS", str(number)
    except Exception:
        # No exception messages escape: SDK/HTTP exceptions can contain secrets.
        classification = "TRANSPORT_ERROR"
    _emit_evidence(classification, request_id, gateway, status, provider_id)
    if classification == "GATEWAY_SUCCESS":
        return _result("success", answer)
    return _result("error", "Gateway call failed: " + classification + ". Native Policy evidence UNVERIFIED.")


def build_governed_tools():
    # Lazy decorator import allows offline config validation without installing
    # the agent stack. No endpoint/tool/session/header argument is exposed.
    from strands import tool

    @tool
    def approved_add_numbers(a: int, b: int) -> dict:
        """Call the selected approved Gateway arithmetic tool. Integers -1000..1000 only."""
        return _invoke(a, b)

    return [approved_add_numbers]
`;
  const gate = `// platform-gate: v1 — offline configuration conformance only
import { spawnSync } from "node:child_process";
import { readFileSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
rmSync("artifacts/governed-binding-check.json", { force: true });
const configuration = ${JSON.stringify(deploymentPath)};
const expected = ${JSON.stringify(selection)};
const value = JSON.parse(readFileSync(configuration, "utf8"));
const canonical = v => Array.isArray(v) ? v.map(canonical) : v && typeof v === "object"
  ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canonical(v[k])])) : v;
const same = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
if (!same(value.selection, expected)) throw new Error("Pinned selection changed.");
const harness = JSON.parse(readFileSync("domain-harness.json", "utf8"));
if (harness.domain !== expected.domainId || harness.project !== expected.projectId
  || harness.agent !== expected.agentId || harness.blueprint !== expected.blueprint.blueprintId
  || harness.blueprintVersion !== expected.blueprint.version) throw new Error("Harness identity changed.");
const selected = harness.resources.filter(r => r.id === expected.resource.id && r.type === expected.resource.type);
if (selected.length !== 1 || selected[0].version !== expected.resource.version
  || !same(selected[0].binding, ${JSON.stringify(resource.binding)})) throw new Error("Selected resource changed.");
for (const r of harness.resources) {
  if (r !== selected[0] && r.binding?.status !== "MATERIALIZED") throw new Error("Other resource DEPLOYMENT_REQUIRED.");
}
const result = spawnSync("python3", ["-c", ${JSON.stringify(`import sys; sys.path.insert(0, ${JSON.stringify(runtimePath)}); import governed_gateway; governed_gateway.validate_deployment()`)}], { encoding: "utf8" });
if (result.status !== 0) {
  console.error("DEPLOYMENT_REQUIRED: invalid or missing reviewed Gateway binding.");
  process.exit(1);
}
mkdirSync("artifacts", { recursive: true });
writeFileSync("artifacts/governed-binding-check.json", JSON.stringify({
  schemaVersion: 1, selection: expected, configurationSha256: createHash("sha256").update(readFileSync(configuration)).digest("hex"),
  configurationConformance: "PASS", liveGateway: "UNVERIFIED", nativePolicyEvidence: "UNVERIFIED",
}, null, 2) + "\\n");
console.log("Governed binding configuration PASS; live Gateway/Policy UNVERIFIED.");
`;
  const cdk = `import { CfnOutput, Stack } from 'aws-cdk-lib';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

// Validation/output only. No IAM grant, Gateway creation or live calls.
export function governedGatewayOutputs(stack: Stack): void {
  // AgentCore CLI and the vended CDK bin both run from agentcore/cdk.
  const root = resolve(process.cwd(), '../..');
  execFileSync(process.execPath, [resolve(root, 'gates/check-governed-tool.mjs')], { cwd: root });
  const raw = readFileSync(resolve(root, ${JSON.stringify(deploymentPath)}), 'utf8');
  const config = JSON.parse(raw);
  new CfnOutput(stack, 'GovernedGatewayBindingSha256', { value: createHash('sha256').update(raw).digest('hex') });
  new CfnOutput(stack, 'GovernedGatewayArn', { value: config.gateway.gatewayArn });
  new CfnOutput(stack, 'GovernedGatewayQualifiedTool', { value: config.gateway.qualifiedToolName });
  new CfnOutput(stack, 'GovernedGatewayLiveEvidence', { value: 'UNVERIFIED' });
}
`;
  const offlineTest = `"""OFFLINE_FIXTURES only: no native Policy observation or model-quality score."""
import json
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / ${JSON.stringify(runtimePath)}))
import governed_gateway as gateway


class GovernedGatewayFixtureTest(unittest.TestCase):
    def test_selected_transport_and_denial_classification(self):
        events = []
        def post(binding, body, headers):
            request = json.loads(body)
            self.assertEqual(request["params"]["name"], binding["qualifiedToolName"])
            self.assertEqual(request["params"]["arguments"], {"a": 2, "b": 3})
            return 200, json.dumps({
                "jsonrpc": "2.0", "id": request["id"],
                "result": {"isError": True, "content": [{
                    "type": "text", "text": gateway._DENIAL + "offline-fixture]",
                }]},
            }).encode(), "fixture-request"
        with patch.object(gateway, "_signed_headers", return_value={}), patch.object(gateway, "_post", side_effect=post) as transport, patch.object(gateway, "_emit_evidence", side_effect=lambda *args: events.append(args)):
            self.assertEqual(gateway._invoke(2, 3)["status"], "error")
            transport.assert_called_once()
            self.assertEqual(events[0][0], "POLICY_DENIAL_SHAPED")
        # This test never emits native observed evidence.

    def test_unsafe_arguments_never_reach_transport(self):
        with patch.object(gateway, "_post") as transport:
            for value in [True, 1001, -1001, 2.5, "2"]:
                with self.assertRaises(ValueError):
                    gateway._invoke(value, 3)
            transport.assert_not_called()
`;
  const files = [
    { path: `${runtimePath}/governed_gateway.py`, content: python },
    { path: deploymentPath, content: configuration },
    { path: "gates/check-governed-tool.mjs", content: gate },
    { path: "agentcore/cdk/lib/governed-gateway.ts", content: cdk },
    { path: "tests/test_governed_tool.py", content: offlineTest },
    { path: "GOVERNED-TOOL.md", content: `# Governed arithmetic tool

The generated chat agent consumes \`${runtimePath}/governed_gateway.py\`.
Only the selected Gateway arithmetic target is exposed; there is no generic
MCP endpoint setting. This is the generated-agent path, separate from the
hosted synchronous model-only path.

\`${deploymentPath}\` is trusted, reviewed deployment configuration.
Its selection must match the pinned registry/record/version, blueprint and
domain/project/agent. If gateway is null, deployment is blocked. An operator
must obtain independently reviewed real Gateway/target/tools-list values
and native Policy identity/definition digest in ENFORCE mode before filling
that object in a reviewed repository change. Never source it from a prompt,
invocation payload, environment URL or caller session. A concrete binding
already in the approved snapshot cannot be replaced in this file.

V1 supports AWS_IAM, commercial AWS endpoints, protocol 2026-07-28, stateless
tools/call and exactly targetName___add_numbers with integer inputs [-1000,1000].
Copy the qualified name from actual tools/list; naming convention alone is
not evidence. The target must return one text content block containing the
integer sum. The Gateway supportedVersions must include 2026-07-28.
Temporal sessions are not implemented. No untrusted policy-session header
is generated. Do not use this path to claim request/temporal-limit acceptance.

Verify the Runtime execution role's default SDK credential chain and exact
Gateway InvokeGateway authorization separately from model inference access.
The exported CDK adds validation and outputs only; it creates no Gateway,
target, policy or IAM grant. Deployment targets remain empty until reviewed.
The Python signer suppresses its SDK's sensitive canonical-header debug logs.
HTTP work has a five-second socket timeout, a body deadline and 64 KiB response cap with no redirects
or retries. Host DNS and credential-provider time limits are still operator
prerequisites; this is not a whole-process deadline.

Offline checks (no model/tool calls):

\`\`\`sh
node gates/check-resource-bindings.mjs
node gates/check-guardrails.mjs
python3 -m unittest discover -s tests -p test_governed_tool.py
node gates/run-eval.mjs --mode assert
\`\`\`

The configuration report is artifacts/governed-binding-check.json.
The unittest cases are OFFLINE_FIXTURES, never native Policy or model-quality
evidence. Eval writes eval-scorecard.md and fails until transcripts exist.
The normal test gate also installs app dependencies and checks the actual
runtime import; run it in a controlled dependency environment.

Gateway result categories include GATEWAY_SUCCESS, POLICY_DENIAL_SHAPED,
AUTHORIZATION_ERROR, RPC_ERROR, TOOL_ERROR and transport/protocol errors.
Every event retains nativePolicyEvidence=UNVERIFIED and principalEvidence=UNVERIFIED.
A 403 or documented denial-shaped body does not prove native enforcement.
Correlate the request/provider IDs with native logs, effective principal,
actual Gateway/target, policy revision/definition and no target side effect
before accepting live evidence. Exported snapshots do not inherit future
platform grant revocations. Repository/code integrity and native IAM/Policy
remain the deployment trust boundary.
` },
    { path: "agentcore/governed-tool-contract.json", content: json({
      selection, deploymentBinding: deploymentPath,
      entrypointModule: `${runtimePath}/governed_gateway.py`,
      configurationGate: "gates/check-governed-tool.mjs",
      configurationEvidence: "artifacts/governed-binding-check.json",
      nativePolicyEvidence: "UNVERIFIED",
      deploymentPrincipal: "UNVERIFIED: operator must verify Runtime execution role and exact Gateway IAM access",
      evaluation: "Existing eval gate requires real recorded transcripts; offline fixtures are not quality evidence",
    }) },
  ].map((entry) => ({ ...entry, mode: "100644" }));
  return {
    files,
    transform(entry) {
      if (entry.path.startsWith(`${runtimePath}/mcp_client/`)) return null;
      if (entry.path === `${runtimePath}/main.py`) {
        const replacements = [
          ["from mcp_client.client import get_streamable_http_mcp_client", "from governed_gateway import build_governed_tools"],
          ["mcp_clients = [get_streamable_http_mcp_client()]", "mcp_clients = []"],
          [/^# Define a simple function tool\n@tool\ndef add_numbers[\s\S]*?tools\.append\(add_numbers\)/m, "tools.extend(build_governed_tools())"],
        ];
        let content = entry.content;
        for (const [from, to] of replacements) {
          const next = content.replace(from, to);
          if (next === content) throw new TypeError("Unsupported governed chatagent template.");
          content = next;
        }
        return { ...entry, content };
      }
      if (entry.path === "agentcore/cdk/lib/cdk-stack.ts") {
        const anchor = "    // Stack-level output";
        if (!entry.content.includes(anchor)) throw new TypeError("Unsupported governed CDK template.");
        return { ...entry, content:
          "import { governedGatewayOutputs } from './governed-gateway';\n" +
          entry.content.replace(anchor, "    governedGatewayOutputs(this);\n\n" + anchor) };
      }
      return entry;
    },
  };
}
