const ADAPTERS = Object.freeze({
  TOOL: new Set([
    "agentcore_gateway",
    "browser",
    "codeInterpreter",
    "inline_function",
    "remote_mcp",
    "tool",
  ]),
  MCP_SERVER: new Set(["remote_mcp"]),
  SKILL: new Set(["skill"]),
  MEMORY: new Set(["memory"]),
  KNOWLEDGE_BASE: new Set(["knowledge_base"]),
});

const MATERIALIZED = new Set(["browser", "codeInterpreter"]);

function plain(value) {
  return Boolean(
    value
    && typeof value === "object"
    && !Array.isArray(value)
    && (
      Object.getPrototypeOf(value) === Object.prototype
      || Object.getPrototypeOf(value) === null
    ),
  );
}

function toolAdapter(content) {
  return new Map([
    ["agentcore_browser", "browser"],
    ["agentcore_code_interpreter", "codeInterpreter"],
    ["agentcore_gateway", "agentcore_gateway"],
    ["inline_function", "inline_function"],
    ["remote_mcp", "remote_mcp"],
  ]).get(content.toolType) || "tool";
}

function exact(value, keys) {
  return plain(value)
    && Object.keys(value).sort().join(",") === keys.sort().join(",");
}

// This is approved Registry content, never a deployment/invocation request body.
// V1 supports only a stateless IAM-authenticated arithmetic target. Its name
// must be copied from actual tools/list during independent publication review.
function validGateway(value) {
  if (!exact(value, [
    "schemaVersion", "operation", "region", "gatewayArn", "endpoint",
    "targetId", "targetName", "qualifiedToolName", "protocolVersion", "auth", "policy",
  ])) return false;
  const gateway = typeof value.gatewayArn === "string"
    && /^arn:aws:bedrock-agentcore:([a-z]{2}-[a-z]+-\d):(\d{12}):gateway\/([a-z][a-z0-9-]{0,99})$/
      .exec(value.gatewayArn);
  if (!gateway) return false;
  const [, region, account, id] = gateway;
  return value.schemaVersion === 1
    && value.operation === "add_numbers"
    && value.region === region
    && value.endpoint === `https://${id}.gateway.bedrock-agentcore.${region}.amazonaws.com/mcp`
    && typeof value.targetId === "string"
    && /^[A-Za-z0-9-]{1,100}$/.test(value.targetId)
    && typeof value.targetName === "string"
    && /^[A-Za-z][A-Za-z0-9-]{0,99}$/.test(value.targetName)
    && value.qualifiedToolName === `${value.targetName}___add_numbers`
    && value.protocolVersion === "2026-07-28"
    && value.auth === "AWS_IAM"
    && exact(value.policy, [
      "engineArn", "policyId", "definitionSha256", "enforcementMode",
    ])
    && typeof value.policy.engineArn === "string"
    && value.policy.engineArn.startsWith(
      `arn:aws:bedrock-agentcore:${region}:${account}:policy-engine/`,
    )
    && /^[A-Za-z0-9_-]{1,100}$/.test(value.policy.engineArn.split("/")[1])
    && value.policy.engineArn.split("/").length === 2
    && typeof value.policy.policyId === "string"
    && /^[A-Za-z0-9_-]{1,100}$/.test(value.policy.policyId)
    && typeof value.policy.definitionSha256 === "string"
    && /^[a-f0-9]{64}$/.test(value.policy.definitionSha256)
    && value.policy.enforcementMode === "ENFORCE";
}

export function createPortableResourceBinding(resourceType, content) {
  if (!ADAPTERS[resourceType] || !plain(content)) {
    throw new TypeError("Selected resource binding is invalid.");
  }
  const adapter = resourceType === "TOOL"
    ? toolAdapter(content)
    : [...ADAPTERS[resourceType]][0];
  if (adapter === "agentcore_gateway" && Object.hasOwn(content, "gatewayBinding")) {
    if (!validGateway(content.gatewayBinding)) {
      throw new TypeError("Approved Gateway binding is invalid.");
    }
    return {
      adapter,
      status: "MATERIALIZED",
      gateway: structuredClone(content.gatewayBinding),
    };
  }
  return {
    adapter,
    status: MATERIALIZED.has(adapter)
      ? "MATERIALIZED"
      : "DEPLOYMENT_REQUIRED",
  };
}

export function validPortableResourceBinding(resourceType, value) {
  if (
    resourceType === "TOOL"
    && exact(value, ["adapter", "status", "gateway"])
    && value.adapter === "agentcore_gateway"
  ) {
    return value.status === "MATERIALIZED" && validGateway(value.gateway);
  }
  return Boolean(
    ADAPTERS[resourceType]
    && plain(value)
    && Object.keys(value).sort().join(",") === "adapter,status"
    && ADAPTERS[resourceType].has(value.adapter)
    && value.status === (
      MATERIALIZED.has(value.adapter)
        ? "MATERIALIZED"
        : "DEPLOYMENT_REQUIRED"
    ),
  );
}
