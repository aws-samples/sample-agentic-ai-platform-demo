import assert from "node:assert/strict";
import test from "node:test";
import {
  CONTROL_PLANE_DOMAIN_KEYS,
  DEPLOYMENT_NAME_SUFFIX_LENGTH,
  GATEWAY_BASE_NAMES,
  PROVISIONED_LAMBDA_NAME_MAX_LENGTH,
  PROVISIONED_RESOURCE_NAME_PREFIX,
  PROVISIONED_STATE_MACHINE_NAME_MAX_LENGTH,
  buildGatewayArn,
  buildGatewayInferenceUrl,
  buildGatewayMcpUrl,
  buildRegistryArn,
  deploymentNameSuffix,
  deriveGatewayName,
  provisionedLambdaName,
  provisionedStateMachineName,
  resolveControlPlaneConfig,
  resolveControlPlaneContext,
  validateProvisionedLambdaName,
  validateProvisionedNamePrefix,
  validateProvisionedStateMachineName,
} from "../lib/control-plane-config";

const REFERENCE_INPUT = {
  mode: "reference-existing",
  region: "us-west-2",
  account: "111122223333",
  sharedRegistryId: "SharedReg123456",
  domainRegistryIds: {
    platform: "PlatformReg1234",
    customer_support: "CustomerReg1234",
    operations: "OperatioReg1234",
  },
  llmGatewayId: "agentic-demo-llm-gateway-abcdefghij",
  llmGatewayRegion: "us-east-1",
  toolsGatewayId: "platform-tools-gw-klmnopqrst",
} as const;
test("reference mode validates identifiers and derives the complete AWS contract", () => {
  const config = resolveControlPlaneConfig(REFERENCE_INPUT);

  assert.equal(config.mode, "reference-existing");
  assert.equal(config.partition, "aws");
  assert.equal(
    config.sharedRegistryArn,
    "arn:aws:agent-registry:us-west-2:111122223333:registry/SharedReg123456",
  );
  assert.deepEqual(config.domainRegistryArns, {
    platform:
      "arn:aws:agent-registry:us-west-2:111122223333:registry/PlatformReg1234",
    customer_support:
      "arn:aws:agent-registry:us-west-2:111122223333:registry/CustomerReg1234",
    operations:
      "arn:aws:agent-registry:us-west-2:111122223333:registry/OperatioReg1234",
  });
  assert.equal(
    config.llmGatewayArn,
    "arn:aws:bedrock-agentcore:us-east-1:111122223333:gateway/agentic-demo-llm-gateway-abcdefghij",
  );
  assert.equal(
    config.llmGatewayUrl,
    "https://agentic-demo-llm-gateway-abcdefghij.gateway.bedrock-agentcore.us-east-1.amazonaws.com/inference/v1",
  );
  assert.equal(config.llmGatewayRegion, "us-east-1");
  assert.equal(
    config.toolsGatewayArn,
    "arn:aws:bedrock-agentcore:us-west-2:111122223333:gateway/platform-tools-gw-klmnopqrst",
  );
  assert.equal(
    config.toolsGatewayUrl,
    "https://platform-tools-gw-klmnopqrst.gateway.bedrock-agentcore.us-west-2.amazonaws.com/mcp",
  );
});

test("provision mode is self-contained and requires no existing resource ARN", () => {
  const scope = { account: "111122223333", region: "us-west-2" };
  assert.deepEqual(
    resolveControlPlaneConfig({
      mode: "provision",
      account: scope.account,
      region: scope.region,
    }),
    {
      mode: "provision",
      account: scope.account,
      region: scope.region,
      partition: "aws",
      llmGatewayName: deriveGatewayName("llm", scope),
      toolsGatewayName: deriveGatewayName("tools", scope),
    },
  );
});

test("provisioned gateway names are deployment-scoped and deterministic", () => {
  const scope = { account: "111122223333", region: "us-west-2" };
  const otherAccount = { account: "444455556666", region: "us-west-2" };

  const first = resolveControlPlaneConfig({ mode: "provision", ...scope });
  const again = resolveControlPlaneConfig({ mode: "provision", ...scope });
  const other = resolveControlPlaneConfig({
    mode: "provision",
    ...otherAccount,
  });

  // Determinism: the same deployment target must always resolve to the same
  // name, otherwise every update becomes a replacement and destroy orphans
  // the old gateway.
  assert.equal(first.llmGatewayName, again.llmGatewayName);
  assert.equal(first.toolsGatewayName, again.toolsGatewayName);

  // Uniqueness: a different account must not collide in the account+region
  // global AgentCore Gateway namespace.
  assert.notEqual(first.llmGatewayName, other.llmGatewayName);
  assert.notEqual(first.toolsGatewayName, other.toolsGatewayName);

  // Names stay derived from the documented base name plus the shared suffix,
  // never a bare hardcoded literal.
  const suffix = deploymentNameSuffix(scope);
  assert.equal(
    first.llmGatewayName,
    `${GATEWAY_BASE_NAMES.llm}-${suffix}`,
  );
  assert.equal(
    first.toolsGatewayName,
    `${GATEWAY_BASE_NAMES.tools}-${suffix}`,
  );
  assert.notEqual(first.llmGatewayName, GATEWAY_BASE_NAMES.llm);
  assert.notEqual(first.toolsGatewayName, GATEWAY_BASE_NAMES.tools);

  // AgentCore builds the gateway identifier as "<name>-<10 chars>" and caps
  // the prefix at 100 characters, so the requested name must stay within it.
  assert.ok(first.llmGatewayName.length <= 100);
  assert.ok(first.toolsGatewayName.length <= 100);
});

test("provisioned resource names are deterministic, prefixed, and bounded", () => {
  const scope = { account: "111122223333", region: "us-west-2" };
  const otherAccount = { account: "444455556666", region: "us-west-2" };
  const suffix = deploymentNameSuffix(scope);

  const name = provisionedLambdaName(scope, "on-event");
  assert.equal(
    name,
    `${PROVISIONED_RESOURCE_NAME_PREFIX}-on-event-${suffix}`,
  );
  // Deterministic for the same target, distinct across accounts.
  assert.equal(name, provisionedLambdaName(scope, "on-event"));
  assert.notEqual(name, provisionedLambdaName(otherAccount, "on-event"));
  assert.match(
    name,
    new RegExp(`-[0-9a-f]{${DEPLOYMENT_NAME_SUFFIX_LENGTH}}$`),
  );

  // The state machine derivation shares the same prefix, suffix, and grammar.
  const waiterName = provisionedStateMachineName(scope, "waiter");
  assert.equal(
    waiterName,
    `${PROVISIONED_RESOURCE_NAME_PREFIX}-waiter-${suffix}`,
  );

  // Role names follow the same lowercase-hyphen grammar as gateway names.
  for (const invalid of ["Has-Upper", "trailing-", "under_score", ""]) {
    assert.throws(
      () => provisionedLambdaName(scope, invalid),
      /provisioned resource role/,
    );
    assert.throws(
      () => provisionedStateMachineName(scope, invalid),
      /provisioned resource role/,
    );
  }
});

test("Lambda name validator enforces the documented service constraints", () => {
  const scope = { account: "111122223333", region: "us-west-2" };
  const fixedLength =
    PROVISIONED_RESOURCE_NAME_PREFIX.length
    + DEPLOYMENT_NAME_SUFFIX_LENGTH
    + 2;

  // Longest fitting role yields exactly the maximum-length name.
  const longestFittingRole = "r".repeat(
    PROVISIONED_LAMBDA_NAME_MAX_LENGTH - fixedLength,
  );
  assert.equal(
    provisionedLambdaName(scope, longestFittingRole).length,
    PROVISIONED_LAMBDA_NAME_MAX_LENGTH,
  );
  // One character past the cap must throw.
  assert.throws(
    () => provisionedLambdaName(scope, `${longestFittingRole}r`),
    /at most/,
  );

  validateProvisionedLambdaName("acp-cp-prov-on-event-0123abcd");
  validateProvisionedLambdaName("Mixed_Case-Is_Legal-For-Lambda");
  assert.equal(
    validateProvisionedLambdaName(
      "a".repeat(PROVISIONED_LAMBDA_NAME_MAX_LENGTH),
    ),
    undefined,
  );
  assert.throws(
    () =>
      validateProvisionedLambdaName(
        "a".repeat(PROVISIONED_LAMBDA_NAME_MAX_LENGTH + 1),
      ),
    /at most/,
  );
  for (const invalid of ["", "has space", "dot.name", "colon:name", "star*"]) {
    assert.throws(
      () => validateProvisionedLambdaName(invalid),
      /must match/,
    );
  }
});

test("state machine name validator enforces the documented service constraints", () => {
  const scope = { account: "111122223333", region: "us-west-2" };
  const fixedLength =
    PROVISIONED_RESOURCE_NAME_PREFIX.length
    + DEPLOYMENT_NAME_SUFFIX_LENGTH
    + 2;

  // Longest fitting role yields exactly the maximum-length name.
  const longestFittingRole = "w".repeat(
    PROVISIONED_STATE_MACHINE_NAME_MAX_LENGTH - fixedLength,
  );
  assert.equal(
    provisionedStateMachineName(scope, longestFittingRole).length,
    PROVISIONED_STATE_MACHINE_NAME_MAX_LENGTH,
  );
  // One character past the cap must throw.
  assert.throws(
    () => provisionedStateMachineName(scope, `${longestFittingRole}w`),
    /at most/,
  );

  validateProvisionedStateMachineName("acp-cp-prov-waiter-0123abcd");
  assert.equal(
    validateProvisionedStateMachineName(
      "a".repeat(PROVISIONED_STATE_MACHINE_NAME_MAX_LENGTH),
    ),
    undefined,
  );
  assert.throws(
    () =>
      validateProvisionedStateMachineName(
        "a".repeat(PROVISIONED_STATE_MACHINE_NAME_MAX_LENGTH + 1),
      ),
    /at most/,
  );
  // Characters on the official blacklist (whitespace, wildcards, brackets,
  // specials) must be rejected; the tightened whitelist also rejects
  // blacklist-legal-but-excluded characters like "." and "@".
  for (const invalid of [
    "",
    "has space",
    "wild*card",
    "wild?card",
    "brackets<name>",
    "colon:name",
    "dot.name",
    "at@name",
  ]) {
    assert.throws(
      () => validateProvisionedStateMachineName(invalid),
      /must match/,
    );
  }
});

test("boundary name prefix validator rejects IAM wildcard-capable prefixes", () => {
  validateProvisionedNamePrefix(PROVISIONED_RESOURCE_NAME_PREFIX);
  validateProvisionedNamePrefix("acp-cp-prov");
  for (const invalid of [
    "",
    "acp-cp-prov-*",
    "acp?cp",
    "Has-Upper",
    "trailing-",
    "under_score",
  ]) {
    assert.throws(
      () => validateProvisionedNamePrefix(invalid),
      /provisioned name prefix/,
    );
  }
});

test("provisioned gateway names accept an explicit override", () => {
  const config = resolveControlPlaneConfig({
    mode: "provision",
    account: "111122223333",
    region: "us-west-2",
    llmGatewayName: "pinned-llm-gateway",
    toolsGatewayName: "pinned-tools-gateway",
  });

  assert.equal(config.llmGatewayName, "pinned-llm-gateway");
  assert.equal(config.toolsGatewayName, "pinned-tools-gateway");

  for (const invalid of ["Has-Upper", "trailing-", "under_score", "a".repeat(101)]) {
    assert.throws(
      () =>
        resolveControlPlaneConfig({
          mode: "provision",
          account: "111122223333",
          region: "us-west-2",
          toolsGatewayName: invalid,
        }),
      /toolsGatewayName/,
    );
  }
});

test("reference mode recovers gateway names from the gateway identifiers", () => {
  const config = resolveControlPlaneConfig(REFERENCE_INPUT);

  assert.equal(config.mode, "reference-existing");
  if (config.mode !== "reference-existing") {
    return;
  }
  // Identifiers are "<name>-<10 chars>", so the name of a referenced gateway
  // comes from the identifier rather than a hardcoded assumption.
  assert.equal(
    config.llmGatewayName,
    REFERENCE_INPUT.llmGatewayId.replace(/-[a-z0-9]{10}$/, ""),
  );
  assert.equal(
    config.toolsGatewayName,
    REFERENCE_INPUT.toolsGatewayId.replace(/-[a-z0-9]{10}$/, ""),
  );
});

test("deployment modes reject externally supplied runtime boundary ownership", () => {
  const runtimePermissionsBoundaryArn =
    "arn:aws:iam::111122223333:policy/"
    + "AgenticPlatform-ControlPlane-RuntimePermissionsBoundary";

  for (const input of [
    {
      mode: "provision",
      account: "111122223333",
      region: "us-west-2",
      runtimePermissionsBoundaryArn,
    },
    {
      ...REFERENCE_INPUT,
      runtimePermissionsBoundaryArn,
    },
  ]) {
    assert.throws(
      () => resolveControlPlaneConfig(input as any),
      /runtimePermissionsBoundaryArn is not allowed/,
    );
  }
  assert.throws(
    () =>
      resolveControlPlaneContext({
        mode: "reference-existing",
        account: "111122223333",
        region: "us-west-2",
        sharedRegistryId: REFERENCE_INPUT.sharedRegistryId,
        registryPlatformId:
          REFERENCE_INPUT.domainRegistryIds.platform,
        registryCustomerSupportId:
          REFERENCE_INPUT.domainRegistryIds.customer_support,
        registryOperationsId:
          REFERENCE_INPUT.domainRegistryIds.operations,
        llmGatewayId: REFERENCE_INPUT.llmGatewayId,
        llmGatewayRegion: REFERENCE_INPUT.llmGatewayRegion,
        toolsGatewayId: REFERENCE_INPUT.toolsGatewayId,
        runtimePermissionsBoundaryArn,
      }),
    /runtimePermissionsBoundaryArn is not allowed in reference-existing mode/,
  );
});

test("provision context rejects every existing-resource identifier", () => {
  const existingContextIds = {
    sharedRegistryId: "SharedReg123456",
    registryPlatformId: "PlatformReg1234",
    registryCustomerSupportId: "CustomerReg1234",
    registryOperationsId: "OperatioReg1234",
    llmGatewayId: "agentic-demo-llm-gateway-abcdefghij",
    llmGatewayRegion: "us-east-1",
    toolsGatewayId: "platform-tools-gw-klmnopqrst",
  };

  for (const [field, value] of Object.entries(existingContextIds)) {
    assert.throws(
      () =>
        resolveControlPlaneContext({
          mode: "provision",
          account: "111122223333",
          region: "us-west-2",
          [field]: value,
        }),
      new RegExp(`${field} is not allowed in provision mode`),
    );
  }
});

for (const [field, value] of Object.entries({
  sharedRegistryId: "SharedReg123456",
  domainRegistryIds: {
    platform: "PlatformReg1234",
    customer_support: "CustomerReg1234",
    operations: "OperatioReg1234",
  },
  llmGatewayId: "agentic-demo-llm-gateway-abcdefghij",
  llmGatewayRegion: "us-east-1",
  toolsGatewayId: "platform-tools-gw-klmnopqrst",
})) {
  test(`provision mode rejects runtime property ${field}`, () => {
    assert.throws(
      () =>
        resolveControlPlaneConfig({
          mode: "provision",
          account: "111122223333",
          region: "us-west-2",
          [field]: value,
        } as any),
      new RegExp(`${field} is not allowed in provision mode`),
    );
  });
}

test("the supported domain keys are fixed and ordered", () => {
  assert.deepEqual(CONTROL_PLANE_DOMAIN_KEYS, [
    "platform",
    "customer_support",
    "operations",
  ]);
});

test("reference mode requires every existing resource identifier", () => {
  const requiredFields = [
    "sharedRegistryId",
    "domainRegistryIds",
    "llmGatewayId",
    "llmGatewayRegion",
    "toolsGatewayId",
  ] as const;

  for (const field of requiredFields) {
    const input = { ...REFERENCE_INPUT } as Record<string, unknown>;
    delete input[field];
    assert.throws(
      () => resolveControlPlaneConfig(input as any),
      new RegExp(`${field} is required`),
    );
  }
});

test("reference mode requires exactly the three known domain registries", () => {
  assert.throws(
    () =>
      resolveControlPlaneConfig({
        ...REFERENCE_INPUT,
        domainRegistryIds: {
          platform: "PlatformReg1234",
          customer_support: "CustomerReg1234",
        },
      } as any),
    /domainRegistryIds\.operations is required/,
  );

  assert.throws(
    () =>
      resolveControlPlaneConfig({
        ...REFERENCE_INPUT,
        domainRegistryIds: {
          ...REFERENCE_INPUT.domainRegistryIds,
          finance: "AbCdEfGhIjKlMnOp",
        },
      } as any),
    /Unknown domain registry key: finance/,
  );
});

test("account and region validation rejects malformed or padded values", () => {
  for (const account of [
    "",
    "12345678901",
    "1234567890123",
    "12345678901a",
    " 111122223333",
    "111122223333 ",
  ]) {
    assert.throws(
      () =>
        resolveControlPlaneConfig({
          mode: "provision",
          account,
          region: "us-west-2",
        }),
      /account must be a 12-digit AWS account ID/,
    );
  }

  for (const region of [
    "",
    "us-west",
    "US-WEST-2",
    "us_west_2",
    " us-west-2",
    "us-west-2 ",
  ]) {
    assert.throws(
      () =>
        resolveControlPlaneConfig({
          mode: "provision",
          account: "111122223333",
          region,
        }),
      /region must be us-west-2 for this implementation/,
    );
  }
});

test("only us-west-2 is supported by this implementation", () => {
  for (const region of ["zz-fake-1", "us-west-999"]) {
    assert.throws(
      () =>
        resolveControlPlaneConfig({
          mode: "provision",
          account: "111122223333",
          region,
        }),
      /region must be us-west-2 for this implementation/,
    );
  }
});

test("Agent Registry IDs accept 12 through 16 alphanumeric characters", () => {
  const validRegistryIds = [
    "AbCdEf123456",
    "AbCdEf1234567",
    "AbCdEf123456789",
    "SharedReg123456",
  ];

  for (const sharedRegistryId of validRegistryIds) {
    const config = resolveControlPlaneConfig({
      ...REFERENCE_INPUT,
      sharedRegistryId,
    });
    assert.equal(config.sharedRegistryId, sharedRegistryId);
  }
});

test("Agent Registry IDs reject values outside the 12 to 16 character range", () => {
  const invalidRegistryIds = [
    "AbCdEf12345",
    "AbCdEf12345678901",
    "arn:aws:agent-registry:us-west-2:111122223333:registry/SharedReg123456",
    "cAIhvscg2Gwj6AG/",
    "cAIhvscg2Gwj6AG ",
  ];

  for (const sharedRegistryId of invalidRegistryIds) {
    assert.throws(
      () => resolveControlPlaneConfig({ ...REFERENCE_INPUT, sharedRegistryId }),
      /sharedRegistryId must be a 12 to 16 character Agent Registry ID/,
    );
  }
});

test("Gateway IDs accept the current live resource identifiers", () => {
  for (const gatewayId of [
    "agentic-demo-llm-gateway-abcdefghij",
    "platform-tools-gw-klmnopqrst",
  ]) {
    assert.match(
      buildGatewayArn(
        {
          partition: "aws",
          account: "111122223333",
          region: "us-west-2",
        },
        gatewayId,
      ),
      new RegExp(`:gateway/${gatewayId}$`),
    );
  }
});

test("Gateway IDs accept a 100-character prefix", () => {
  const gatewayId = `${"a".repeat(100)}-abcdefghij`;

  assert.equal(
    buildGatewayArn(
      {
        partition: "aws",
        account: "111122223333",
        region: "us-west-2",
      },
      gatewayId,
    ),
    `arn:aws:bedrock-agentcore:us-west-2:111122223333:gateway/${gatewayId}`,
  );
});

test("Gateway IDs reject a 101-character prefix", () => {
  const gatewayId = `${"a".repeat(101)}-abcdefghij`;

  assert.throws(
    () =>
      buildGatewayArn(
        {
          partition: "aws",
          account: "111122223333",
          region: "us-west-2",
        },
        gatewayId,
      ),
    /gatewayId must be an AgentCore Gateway ID with a lowercase prefix of at most 100 characters and 10-character suffix/,
  );
});

test("Gateway IDs reject malformed names and suffixes", () => {
  const invalidGatewayIds = [
    "Agentic-demo-llm-gateway-j5bhipqorh",
    "agentic-demo-llm-gateway-J5BHIPQORH",
    "platform-tools-gw-fxo7j9jkh",
    "platform--tools-gw-fxo7j9jkha",
    "platform-tools-gw--fxo7j9jkha",
    "platform-tools-gw-klmnopqrst-",
    "platform-tools-gw",
    "fxo7j9jkha",
  ];

  for (const llmGatewayId of invalidGatewayIds) {
    assert.throws(
      () => resolveControlPlaneConfig({ ...REFERENCE_INPUT, llmGatewayId }),
      /llmGatewayId must be an AgentCore Gateway ID with a lowercase prefix of at most 100 characters and 10-character suffix/,
    );
  }
});

test("builders validate inputs and build the supported-region resources", () => {
  const scope = {
    partition: "aws",
    account: "111122223333",
    region: "us-west-2",
  } as const;
  const registryId = "AbCdEfGhIjKlMnOp";
  const gatewayId = "platform-tools-gw-abc123def0";

  assert.equal(
    buildRegistryArn(scope, registryId),
    "arn:aws:agent-registry:us-west-2:111122223333:registry/AbCdEfGhIjKlMnOp",
  );
  assert.equal(
    buildGatewayArn(scope, gatewayId),
    "arn:aws:bedrock-agentcore:us-west-2:111122223333:gateway/platform-tools-gw-abc123def0",
  );
  assert.equal(
    buildGatewayInferenceUrl("us-west-2", gatewayId),
    "https://platform-tools-gw-abc123def0.gateway.bedrock-agentcore.us-west-2.amazonaws.com/inference/v1",
  );
  assert.equal(
    buildGatewayMcpUrl("us-west-2", gatewayId),
    "https://platform-tools-gw-abc123def0.gateway.bedrock-agentcore.us-west-2.amazonaws.com/mcp",
  );

  assert.throws(
    () =>
      buildGatewayArn(
        { partition: "aws", account: "not-an-account", region: "us-west-2" },
        gatewayId,
      ),
    /account must be a 12-digit AWS account ID/,
  );
});

test("an explicit partition must match the region", () => {
  assert.throws(
    () =>
      resolveControlPlaneConfig({
        mode: "provision",
        partition: "aws-cn",
        account: "111122223333",
        region: "us-west-2",
      }),
    /partition aws-cn does not match region us-west-2/,
  );
});
