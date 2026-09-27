import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"
import {
  buildConsoleConfigs,
  selectStackOutputs,
} from "../scripts/generate-console-config.mjs"

const here = dirname(fileURLToPath(import.meta.url))
const infraDir = resolve(here, "..")
const repoRoot = resolve(infraDir, "..", "..")

const OUTPUTS = {
  SharedRegistryId: "shared123456",
  SharedRegistryArn:
    "arn:aws:agent-registry:us-west-2:111122223333:registry/shared123456",
  RegistryPlatformId: "platform12345",
  RegistryPlatformArn:
    "arn:aws:agent-registry:us-west-2:111122223333:registry/platform12345",
  RegistryCustomerSupportId: "customers12345",
  RegistryCustomerSupportArn:
    "arn:aws:agent-registry:us-west-2:111122223333:registry/customers12345",
  RegistryOperationsId: "operation12345",
  RegistryOperationsArn:
    "arn:aws:agent-registry:us-west-2:111122223333:registry/operation12345",
  LlmGatewayId: "agentic-demo-llm-gateway-abcdefghij",
  LlmGatewayArn:
    "arn:aws:bedrock-agentcore:us-west-2:111122223333:"
    + "gateway/agentic-demo-llm-gateway-abcdefghij",
  LlmGatewayUrl:
    "https://agentic-demo-llm-gateway-abcdefghij.gateway."
    + "bedrock-agentcore.us-east-1.amazonaws.com/inference/v1",
  LlmGatewayRegion: "us-east-1",
  ToolsGatewayId: "platform-tools-gw-klmnopqrst",
  ToolsGatewayArn:
    "arn:aws:bedrock-agentcore:us-west-2:111122223333:"
    + "gateway/platform-tools-gw-klmnopqrst",
  ToolsGatewayUrl:
    "https://platform-tools-gw-klmnopqrst.gateway."
    + "bedrock-agentcore.us-west-2.amazonaws.com/mcp",
  Region: "us-west-2",
  ControlPlaneConfigParameterName:
    "/agentic-platform/control-plane/config",
}

for (const stackName of [
  "AgenticPlatform-ControlPlane",
  "AgenticPlatform-ControlPlane-Provisioned",
]) {
  test(`selects current outputs from the ${stackName} wrapper`, () => {
    assert.deepEqual(
      selectStackOutputs({ [stackName]: OUTPUTS }),
      OUTPUTS,
    )
  })
}

test("accepts a flat current output object", () => {
  assert.deepEqual(selectStackOutputs(OUTPUTS), OUTPUTS)
})

test("rejects ambiguous output wrappers unless a stack name is selected", () => {
  assert.throws(
    () =>
      selectStackOutputs({
        "AgenticPlatform-ControlPlane": OUTPUTS,
        "AgenticPlatform-ControlPlane-Provisioned": OUTPUTS,
      }),
    /Multiple control-plane output objects/,
  )
  assert.deepEqual(
    selectStackOutputs(
      {
        "AgenticPlatform-ControlPlane": OUTPUTS,
        "AgenticPlatform-ControlPlane-Provisioned": {
          ...OUTPUTS,
          Region: "different",
        },
      },
      "AgenticPlatform-ControlPlane-Provisioned",
    ).Region,
    "different",
  )
})

test("builds only the current Registry and Gateway console contract", () => {
  const { registryConfig, gatewayConfig } = buildConsoleConfigs(OUTPUTS)

  assert.deepEqual(registryConfig, {
    region: "us-west-2",
    registries: {
      shared: {
        name: "platform_shared",
        registryId: OUTPUTS.SharedRegistryId,
        registryArn: OUTPUTS.SharedRegistryArn,
      },
      domains: {
        platform: {
          name: "domain_platform",
          registryId: OUTPUTS.RegistryPlatformId,
          registryArn: OUTPUTS.RegistryPlatformArn,
        },
        "customer-support": {
          name: "domain_customer_support",
          registryId: OUTPUTS.RegistryCustomerSupportId,
          registryArn: OUTPUTS.RegistryCustomerSupportArn,
        },
        operations: {
          name: "domain_operations",
          registryId: OUTPUTS.RegistryOperationsId,
          registryArn: OUTPUTS.RegistryOperationsArn,
        },
      },
    },
    toolsGateway: {
      name: "platform-tools-gw",
      gatewayId: OUTPUTS.ToolsGatewayId,
      gatewayArn: OUTPUTS.ToolsGatewayArn,
      gatewayUrl: OUTPUTS.ToolsGatewayUrl,
    },
  })
  assert.deepEqual(gatewayConfig, {
    gateways: [
      {
        name: "agentic-demo-llm-gateway",
        gatewayId: OUTPUTS.LlmGatewayId,
        gatewayArn: OUTPUTS.LlmGatewayArn,
        gatewayUrl: OUTPUTS.LlmGatewayUrl,
        region: "us-east-1",
        description:
          "AgentCore Gateway inference target deployed by "
          + "infra/platform-registry",
      },
    ],
  })

  const serialized = JSON.stringify({ registryConfig, gatewayConfig })
  assert.doesNotMatch(serialized, /GatewayRoleArn|roleArn|platform_demo/)
  assert.doesNotMatch(serialized, /platform-mcp-gw|platform-llm-gw/)
  assert.doesNotMatch(serialized, /"targets"/)
})

test("package commands expose the focused generator contract test", () => {
  const infraPackage = JSON.parse(
    readFileSync(resolve(infraDir, "package.json"), "utf8"),
  )
  const rootPackage = JSON.parse(
    readFileSync(resolve(repoRoot, "package.json"), "utf8"),
  )

  assert.equal(
    infraPackage.scripts["test:config-generator"],
    "node --test test/generate-console-config.test.mjs",
  )
  assert.match(
    infraPackage.scripts.test,
    /test:config-generator/,
  )
  assert.equal(
    rootPackage.scripts["infra:config"],
    "npm --prefix infra/platform-registry run config",
  )
})

test("checked-in console examples match the current generated shape", () => {
  const registryExample = JSON.parse(
    readFileSync(
      resolve(repoRoot, "console", "registry-config.example.json"),
      "utf8",
    ),
  )
  const gatewayExample = JSON.parse(
    readFileSync(
      resolve(repoRoot, "console", "gateway-config.example.json"),
      "utf8",
    ),
  )
  const serialized = JSON.stringify({ registryExample, gatewayExample })

  assert.equal(registryExample.registries.shared.name, "platform_shared")
  assert.equal(
    registryExample.registries.domains["customer-support"].name,
    "domain_customer_support",
  )
  assert.equal(registryExample.toolsGateway.name, "platform-tools-gw")
  assert.equal(
    gatewayExample.gateways[0].name,
    "agentic-demo-llm-gateway",
  )
  assert.ok(gatewayExample.gateways[0].gatewayArn)
  assert.ok(gatewayExample.gateways[0].gatewayUrl)
  assert.doesNotMatch(serialized, /roleArn|platform_demo|"targets"/)
})
