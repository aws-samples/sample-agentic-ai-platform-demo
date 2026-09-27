#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs"
import { dirname, resolve, join } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const infraDir = resolve(here, "..")
const repoRoot = resolve(infraDir, "..", "..")

const REQUIRED_OUTPUTS = [
  "SharedRegistryId",
  "SharedRegistryArn",
  "RegistryPlatformId",
  "RegistryPlatformArn",
  "RegistryCustomerSupportId",
  "RegistryCustomerSupportArn",
  "RegistryOperationsId",
  "RegistryOperationsArn",
  "LlmGatewayId",
  "LlmGatewayArn",
  "LlmGatewayUrl",
  "LlmGatewayRegion",
  "ToolsGatewayId",
  "ToolsGatewayArn",
  "ToolsGatewayUrl",
  "Region",
]

const isOutputObject = value =>
  value !== null
  && typeof value === "object"
  && !Array.isArray(value)
  && Object.hasOwn(value, "SharedRegistryId")

export function selectStackOutputs(outputsDocument, requestedStackName) {
  if (isOutputObject(outputsDocument)) return outputsDocument

  if (requestedStackName) {
    const selected = outputsDocument?.[requestedStackName]
    if (!isOutputObject(selected)) {
      throw new Error(
        `No current control-plane outputs found for stack ${requestedStackName}`,
      )
    }
    return selected
  }

  const candidates = Object.entries(outputsDocument || {})
    .filter(([, value]) => isOutputObject(value))
  if (candidates.length === 1) return candidates[0][1]
  if (candidates.length > 1) {
    throw new Error(
      "Multiple control-plane output objects found; set CDK_STACK_NAME "
      + "to AgenticPlatform-ControlPlane or "
      + "AgenticPlatform-ControlPlane-Provisioned",
    )
  }
  throw new Error("No current Agentic Platform control-plane outputs found")
}

export function buildConsoleConfigs(outputs) {
  for (const key of REQUIRED_OUTPUTS) {
    if (!outputs[key]) throw new Error(`Missing CDK output ${key}`)
  }

  const registryConfig = {
    region: outputs.Region,
    registries: {
      shared: {
        name: "platform_shared",
        registryId: outputs.SharedRegistryId,
        registryArn: outputs.SharedRegistryArn,
      },
      domains: {
        platform: {
          name: "domain_platform",
          registryId: outputs.RegistryPlatformId,
          registryArn: outputs.RegistryPlatformArn,
        },
        "customer-support": {
          name: "domain_customer_support",
          registryId: outputs.RegistryCustomerSupportId,
          registryArn: outputs.RegistryCustomerSupportArn,
        },
        operations: {
          name: "domain_operations",
          registryId: outputs.RegistryOperationsId,
          registryArn: outputs.RegistryOperationsArn,
        },
      },
    },
    toolsGateway: {
      name: "platform-tools-gw",
      gatewayId: outputs.ToolsGatewayId,
      gatewayArn: outputs.ToolsGatewayArn,
      gatewayUrl: outputs.ToolsGatewayUrl,
    },
  }

  const gatewayConfig = {
    gateways: [
      {
        name: "agentic-demo-llm-gateway",
        gatewayId: outputs.LlmGatewayId,
        gatewayArn: outputs.LlmGatewayArn,
        gatewayUrl: outputs.LlmGatewayUrl,
        region: outputs.LlmGatewayRegion,
        description:
          "AgentCore Gateway inference target deployed by "
          + "infra/platform-registry",
      },
    ],
  }

  return { registryConfig, gatewayConfig }
}

export function generateConsoleConfig({
  outputsPath,
  consoleDir,
  stackName,
}) {
  const outputsDocument = JSON.parse(readFileSync(outputsPath, "utf8"))
  const outputs = selectStackOutputs(outputsDocument, stackName)
  const { registryConfig, gatewayConfig } = buildConsoleConfigs(outputs)

  writeFileSync(
    join(consoleDir, "registry-config.json"),
    JSON.stringify(registryConfig, null, 2) + "\n",
  )
  writeFileSync(
    join(consoleDir, "gateway-config.json"),
    JSON.stringify(gatewayConfig, null, 2) + "\n",
  )

  return {
    registryPath: join(consoleDir, "registry-config.json"),
    gatewayPath: join(consoleDir, "gateway-config.json"),
  }
}

const isMain =
  process.argv[1]
  && fileURLToPath(import.meta.url) === resolve(process.argv[1])

if (isMain) {
  const outputsPath = resolve(
    process.argv[2] || join(infraDir, "outputs.json"),
  )
  const consoleDir = resolve(
    process.env.CONSOLE_DIR || join(repoRoot, "console"),
  )
  const generated = generateConsoleConfig({
    outputsPath,
    consoleDir,
    stackName: process.env.CDK_STACK_NAME,
  })
  console.log(`Wrote ${generated.registryPath}`)
  console.log(`Wrote ${generated.gatewayPath}`)
}
