import type { ControlPlaneConfigInput } from "../lib/control-plane-config";

function acceptsConfig(_config: ControlPlaneConfigInput): void {}

acceptsConfig({
  mode: "reference-existing",
  account: "111122223333",
  region: "us-west-2",
  sharedRegistryId: "SharedReg123456",
  domainRegistryIds: {
    platform: "PlatformReg1234",
    customer_support: "CustomerReg1234",
    operations: "OperatioReg1234",
  },
  llmGatewayId: "agentic-demo-llm-gateway-abcdefghij",
  llmGatewayRegion: "us-east-1",
  toolsGatewayId: "platform-tools-gw-klmnopqrst",
});

acceptsConfig({
  mode: "provision",
  account: "111122223333",
  region: "us-west-2",
});

// @ts-expect-error reference-existing mode statically requires existing IDs.
acceptsConfig({
  mode: "reference-existing",
  account: "111122223333",
  region: "us-west-2",
});

// @ts-expect-error provision mode statically prohibits existing IDs.
acceptsConfig({
  mode: "provision",
  account: "111122223333",
  region: "us-west-2",
  sharedRegistryId: "SharedReg123456",
});

acceptsConfig({
  mode: "provision",
  account: "111122223333",
  region: "us-west-2",
  // @ts-expect-error externally supplied runtime boundary ownership is prohibited.
  runtimePermissionsBoundaryArn:
    "arn:aws:iam::111122223333:policy/AgenticPlatform-ControlPlane-RuntimePermissionsBoundary",
});

acceptsConfig({
  ...{
    mode: "reference-existing" as const,
    account: "111122223333",
    region: "us-west-2",
    sharedRegistryId: "SharedReg123456",
    domainRegistryIds: {
      platform: "PlatformReg1234",
      customer_support: "CustomerReg1234",
      operations: "OperatioReg1234",
    },
    llmGatewayId: "agentic-demo-llm-gateway-abcdefghij",
    llmGatewayRegion: "us-east-1",
    toolsGatewayId: "platform-tools-gw-klmnopqrst",
  },
  // @ts-expect-error externally supplied runtime boundary ownership is prohibited.
  runtimePermissionsBoundaryArn:
    "arn:aws:iam::111122223333:policy/AgenticPlatform-ControlPlane-RuntimePermissionsBoundary",
});
