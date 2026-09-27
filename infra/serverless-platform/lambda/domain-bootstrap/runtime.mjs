import { createBootstrapModelGrant } from "./model-access.mjs";
import { createBootstrapResourceGrants } from "./resource-access.mjs";
import { resourcePolicyKey, readResourcePolicy, resourceGrantType } from "./resource-policy.mjs";
import { createAdministratorDirectory, administratorCandidate } from "./administrator-directory.mjs";
import { DynamoDBClient, GetItemCommand, PutItemCommand } from "@aws-sdk/client-dynamodb";
import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";
import { SFNClient, StartExecutionCommand } from "@aws-sdk/client-sfn";
import { CloudFormationClient, CreateStackCommand, DescribeStacksCommand } from "@aws-sdk/client-cloudformation";
import {
  CognitoIdentityProviderClient, AdminGetUserCommand, AdminListGroupsForUserCommand,
  AdminAddUserToGroupCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import { projectEffectiveIdentity, IdentityScopeError } from "../api/identity.mjs";
import { createPlatformState } from "../platform-admin/state.mjs";
import { createModelPolicyState } from "../model-governance/state.mjs";
import { createWorkspaceState } from "../workspace/state.mjs";
import { createBootstrapService, BootstrapError, fingerprint, resolveConfiguration, environmentRequestToken } from "./service.mjs";

const dynamo = new DynamoDBClient({});
const lambda = new LambdaClient({});
const cognito = new CognitoIdentityProviderClient({});
const cloudformation = new CloudFormationClient({});
const sfn = new SFNClient({});
const target = { accountId: process.env.PLATFORM_ACCOUNT_ID, region: process.env.AWS_REGION };
const tableName = process.env.PLATFORM_STATE_TABLE_NAME;
const userPoolId = process.env.COGNITO_USER_POOL_ID;
const state = createPlatformState({ tableName, dynamo, now: () => new Date() });
const models = createModelPolicyState({ tableName, dynamo, now: () => new Date() });
const workspace = createWorkspaceState({ tableName, dynamo, now: () => new Date() });
const key = id => ({ pk: { S: `DOMAIN_BOOTSTRAP#${id}` }, sk: { S: "STATE" } });
const functions = JSON.parse(process.env.PLATFORM_FUNCTIONS || "{}");
const groups = async username => {
  const result = [];
  let NextToken;
  for (let page = 0; page < 20; page++) {
    const response = await cognito.send(new AdminListGroupsForUserCommand({ UserPoolId: userPoolId, Username: username, NextToken }));
    result.push(...(response.Groups || []).map(group => group.GroupName));
    NextToken = response.NextToken;
    if (!NextToken) return result;
  }
  throw new BootstrapError("DIRECTORY_UNAVAILABLE", "Identity group list is incomplete.", 503);
};
async function currentActor(actor) {
  const user = await cognito.send(new AdminGetUserCommand({ UserPoolId: userPoolId, Username: actor.username }));
  const subject = user.UserAttributes?.find(attribute => attribute.Name === "sub")?.Value;
  if (!user.Enabled || subject !== actor.subject) throw new BootstrapError("FORBIDDEN", "The initiating identity is no longer active.", 403);
  return { user, groups: await groups(actor.username) };
}
async function proxy(actor, functionKey, path, body, requestId) {
  const current = await currentActor(actor);
  const route = path.split("?")[0];
  const queryStringParameters = Object.fromEntries(new URLSearchParams(path.split("?")[1] || ""));
  const event = {
    version: "2.0", headers: { ...(requestId ? { "x-request-id": requestId } : {}),
      ...(actor.activeDomain ? { "x-active-domain": actor.activeDomain } : {}) },
    queryStringParameters,
    requestContext: { requestId: requestId || `bootstrap-${Date.now()}`,
      http: { method: body === undefined ? "GET" : "POST", path: `/api${route}` },
      authorizer: { jwt: { claims: { sub: actor.subject, username: actor.username,
        token_use: "access", "cognito:groups": current.groups } } } },
    ...(body === undefined ? {} : { body: JSON.stringify(body), isBase64Encoded: false }),
  };
  const response = await lambda.send(new InvokeCommand({
    FunctionName: functions[functionKey], Payload: Buffer.from(JSON.stringify(event)),
  }));
  if (response.FunctionError) throw new BootstrapError("DEPENDENCY_UNAVAILABLE", `${functionKey} service is unavailable.`, 503);
  const envelope = JSON.parse(Buffer.from(response.Payload).toString());
  const result = JSON.parse(envelope.body);
  if (envelope.statusCode >= 400 || result.ok === false) {
    throw new BootstrapError(result.code || "DEPENDENCY_FAILED", result.message || result.error || `${functionKey} could not complete.`, envelope.statusCode);
  }
  return result;
}
const store = {
  async get(id) {
    const response = await dynamo.send(new GetItemCommand({ TableName: tableName, Key: key(id), ConsistentRead: true }));
    return response.Item ? JSON.parse(response.Item.document.S) : null;
  },
  async create(operation) {
    try {
      await dynamo.send(new PutItemCommand({ TableName: tableName, Item: {
        ...key(operation.domainId), document: { S: JSON.stringify(operation) }, version: { S: fingerprint(operation) },
      }, ConditionExpression: "attribute_not_exists(pk)" }));
    } catch (error) {
      if (error.name === "ConditionalCheckFailedException") throw new BootstrapError("DOMAIN_EXISTS", "Another bootstrap operation already owns this domain.");
      throw error;
    }
  },
  async replace(operation, previous) {
    await dynamo.send(new PutItemCommand({ TableName: tableName, Item: {
      ...key(operation.domainId), document: { S: JSON.stringify(operation) }, version: { S: fingerprint(operation) },
    }, ConditionExpression: "#version = :previous",
    ExpressionAttributeNames: { "#version": "version" },
    ExpressionAttributeValues: { ":previous": { S: fingerprint(previous) } } }));
  },
};
const administrators = createAdministratorDirectory({ cognito, userPoolId, groups });
function environmentTemplate(operation) {
  const domainId = operation.domainId;
  const suffix = fingerprint(domainId).slice(0, 16);
  const resources = {};
  const outputs = {};
  for (const environment of operation.configuration.environments) {
    const name = `${environment[0].toUpperCase()}${environment.slice(1)}`;
    const logName = `/agentic-platform/domains/${domainId}/${environment}`;
    const tags = [
      { Key: "auto-delete", Value: "no" }, { Key: "project", Value: "agentic-ai-platform-demo" },
      { Key: "managedBy", Value: "cdk" }, { Key: "domain", Value: domainId }, { Key: "environment", Value: environment },
    ];
    resources[`${name}Logs`] = {
      Type: "AWS::Logs::LogGroup", DeletionPolicy: "Retain", UpdateReplacePolicy: "Retain",
      Properties: { LogGroupName: logName, RetentionInDays: 30, Tags: tags },
    };
    resources[`${name}RuntimeRole`] = {
      Type: "AWS::IAM::Role", DeletionPolicy: "Retain", UpdateReplacePolicy: "Retain",
      Properties: {
        RoleName: `AgenticPlatform-Domain-${suffix}-${environment}`,
        PermissionsBoundary: process.env.DOMAIN_RUNTIME_BOUNDARY_ARN,
        AssumeRolePolicyDocument: { Version: "2012-10-17", Statement: [{
          Effect: "Allow", Principal: { Service: "bedrock-agentcore.amazonaws.com" }, Action: "sts:AssumeRole",
          Condition: { StringEquals: { "aws:SourceAccount": target.accountId },
            ArnLike: { "aws:SourceArn": `arn:aws:bedrock-agentcore:${target.region}:${target.accountId}:*` } },
        }] },
        Policies: [{ PolicyName: "EnvironmentTelemetry", PolicyDocument: { Version: "2012-10-17", Statement: [
          { Effect: "Allow", Action: ["logs:CreateLogStream", "logs:PutLogEvents"],
            Resource: `arn:aws:logs:${target.region}:${target.accountId}:log-group:${logName}:*` },
          { Effect: "Allow", Action: "cloudwatch:PutMetricData", Resource: "*",
            Condition: { StringEquals: { "cloudwatch:namespace": `AgenticPlatform/Domain/${domainId}` } } },
        ] } }], Tags: tags,
      },
    };
    outputs[`${name}LogGroup`] = { Value: { Ref: `${name}Logs` } };
    outputs[`${name}RuntimeRoleArn`] = { Value: { "Fn::GetAtt": [`${name}RuntimeRole`, "Arn"] } };
  }
  return { AWSTemplateFormatVersion: "2010-09-09",
    Description: `Domain environment foundation for ${domainId}; application resources are project-owned.`,
    Resources: resources, Outputs: outputs };
}
async function getEnvironmentStack(name) {
  try { return (await cloudformation.send(new DescribeStacksCommand({ StackName: name }))).Stacks?.[0]; }
  catch (error) {
    if (error.name === "ValidationError" && /does not exist/.test(error.message)) return null;
    throw error;
  }
}
const grantModel = createBootstrapModelGrant({ models, store, registry: actor => proxy(actor, "catalog", "/registry") });
const grantResources = createBootstrapResourceGrants({ workspace, registry: actor => proxy(actor, "catalog", "/registry") });
async function putResourcePolicy(operation, status) {
  const existing = await readResourcePolicy(dynamo, tableName, operation.domainId);
  if (existing && existing.operationId !== operation.operationId) throw new BootstrapError("RESOURCE_CONFLICT", "Another operation owns this domain's resource policy.");
  if (existing?.status === "ACTIVE" && status === "INITIALIZING") return;
  const resources = [...operation.applied.blueprints, ...operation.applied.models,
    ...operation.applied.resources].map(({ ref: { type, id, registryId }, registryName }) =>
    ({ type, id, registryId, ...(registryName ? { registryName } : {}) }));
  const document = { schemaVersion: 1, domainId: operation.domainId, operationId: operation.operationId, status, resources };
  await dynamo.send(new PutItemCommand({
    TableName: tableName, Item: { ...resourcePolicyKey(operation.domainId), document: { S: JSON.stringify(document) } },
    ConditionExpression: existing ? "#document = :previous" : "attribute_not_exists(pk)",
    ...(existing ? { ExpressionAttributeNames: { "#document": "document" },
      ExpressionAttributeValues: { ":previous": { S: JSON.stringify(existing) } } } : {}),
  }));
}

const actions = {
  async verifyActor(actor) {
    if (!(await currentActor(actor)).groups.includes("platform-admin")) {
      throw new BootstrapError("FORBIDDEN", "The initiating user no longer has platform administrator access.", 403);
    }
  },
  async preflight() {
    // resolveConfiguration already validates live catalog membership. Runtime
    // quotas are not a prerequisite for creating the domain's resource palette.
  },
  async domain(operation) {
    const config = operation.configuration;
    await putResourcePolicy(operation, "INITIALIZING");
    const result = await proxy(operation.actor, "admin", "/domain-create", {
      name: config.name, owner: config.owner, description: config.description,
    }, `bootstrap:${operation.domainId}:create`);
    return { domain: result.domain };
  },
  async identity(operation) {
    const Username = operation.configuration.administrator;
    const user = await cognito.send(new AdminGetUserCommand({ UserPoolId: userPoolId, Username }));
    const existing = await groups(Username);
    const selected = administratorCandidate({ ...user, Username, Attributes: user.UserAttributes }, existing);
    if (!selected.eligible || selected.subject !== operation.applied.administrator?.subject) {
      throw new BootstrapError("ADMINISTRATOR_UNAVAILABLE", "The selected administrator changed or is no longer available. Existing user roles have not been modified.");
    }
    const GroupName = operation.outputs.domain.ownerGroup;
    await cognito.send(new AdminAddUserToGroupCommand({ UserPoolId: userPoolId, Username, GroupName }));
    if (!(await groups(Username)).includes(GroupName)) throw new Error("Membership verification failed.");
    return { administrator: { username: Username, subject: selected.subject, role: selected.role, group: GroupName, status: "ASSIGNED" } };
  },
  async model(operation) {
    return { ...await grantModel(operation), ...await grantResources(operation) };
  },
  async environments(operation) {
    const StackName = `AgenticPlatform-Domain-${fingerprint(operation.domainId).slice(0, 16)}`;
    let stack = await getEnvironmentStack(StackName);
    if (stack && !stack.Tags?.some(tag => tag.Key === "bootstrap-operation" && tag.Value === operation.operationId)) {
      throw new BootstrapError("RESOURCE_CONFLICT", "The environment stack is not owned by this bootstrap operation.");
    }
    if (!stack) {
      await cloudformation.send(new CreateStackCommand({
        StackName, TemplateBody: JSON.stringify(environmentTemplate(operation)),
        RoleARN: process.env.ENVIRONMENT_EXECUTION_ROLE_ARN, EnableTerminationProtection: true,
        Capabilities: ["CAPABILITY_NAMED_IAM"],
        ClientRequestToken: environmentRequestToken(operation),
        Tags: [{ Key: "auto-delete", Value: "no" }, { Key: "project", Value: "agentic-ai-platform-demo" },
          { Key: "managedBy", Value: "cdk" }, { Key: "bootstrap-operation", Value: operation.operationId },
          { Key: "domain", Value: operation.domainId }],
      }));
    }
    // Let Step Functions wait and retry; keep the API and worker responsive.
    stack = await getEnvironmentStack(StackName);
    if (stack?.StackStatus === "CREATE_IN_PROGRESS") {
      const error = new Error("Environment stack is provisioning."); error.name = "FoundationInProgress"; throw error;
    }
    if (stack?.StackStatus !== "CREATE_COMPLETE") {
      throw new BootstrapError("ENVIRONMENT_FAILED", "The environment stack requires attention before bootstrap can continue.");
    }
    return { environmentStack: StackName, environmentOutputs: Object.fromEntries(
      (stack.Outputs || []).map(output => [output.OutputKey, output.OutputValue])),
      environments: operation.configuration.environments.map(name => ({ name, status: "READY_FOR_PROJECTS" })) };
  },
  async verify(operation) {
    resolveConfiguration(operation.configuration, await proxy(operation.actor, "catalog", "/registry"));
    const domain = await state.getDomain(operation.domainId);
    const Username = operation.configuration.administrator;
    const user = await cognito.send(new AdminGetUserCommand({ UserPoolId: userPoolId, Username }));
    const membership = await groups(Username);
    const administrator = administratorCandidate({ ...user, Username, Attributes: user.UserAttributes }, membership);
    if (!domain || domain.registryId !== operation.outputs.domain.registryId
        || !administrator.eligible || administrator.subject !== operation.applied.administrator?.subject
        || !membership.includes(domain.ownerGroup)) throw new Error("Foundation verification failed.");
    for (const entry of [...operation.applied.blueprints, ...operation.applied.resources]) {
      const grant = await workspace.getResourceGrant({ domainId: operation.domainId,
        resourceType: resourceGrantType(entry), resourceId: entry.ref.id });
      if (grant?.status !== "ACTIVE") throw new Error("Resource access verification failed.");
    }
    await putResourcePolicy(operation, "ACTIVE");
    return { readiness: "READY_FOR_PROJECTS", verifiedAt: new Date().toISOString(),
      foundation: { blueprints: operation.configuration.blueprints, models: operation.configuration.models,
        resources: operation.configuration.resources, accountId: target.accountId, region: target.region,
        identity: { userPoolId, ownerGroup: domain.ownerGroup },
        telemetry: { ...operation.outputs.environmentOutputs },
        projectBindingsRequired: ["model runtime policy and quotas", "application runtime", "selected tool adapters", "application guardrail binding", "repository CI/CD"] } };
  },
};
const service = createBootstrapService({ store, target, administrators, actions,
  registry: actor => proxy(actor, "catalog", "/registry"),
  workflows: { async start(operation) {
    try {
      await sfn.send(new StartExecutionCommand({ stateMachineArn: process.env.STATE_MACHINE_ARN,
        name: `${operation.operationId.slice(0, 65)}-${operation.attempt}`,
        input: JSON.stringify({ domainId: operation.domainId, attempt: operation.attempt }) }));
    } catch (error) { if (error.name !== "ExecutionAlreadyExists") throw error; }
  } },
});

const response = (statusCode, body) => ({ statusCode, headers: {
  "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff",
}, body: JSON.stringify(body) });
export async function handler(event) {
  if (event.worker === true && !event.requestContext) {
    if (event.step === "failure") {
      await service.failure(event.domainId, event.attempt, new Error("Workflow failed."));
      return { failed: true };
    }
    try {
      await service.execute(event.domainId, event.step, event.attempt);
      return { completed: event.step };
    } catch (error) {
      if (error.name !== "FoundationInProgress") await service.failure(event.domainId, event.attempt, error);
      throw error;
    }
  }
  try {
    const claims = event.requestContext?.authorizer?.jwt?.claims;
    if (!claims || claims.token_use !== "access" || !claims.sub || !claims.username) {
      throw new BootstrapError("NOT_AUTHENTICATED", "Sign in is required.", 401);
    }
    const actor = { subject: claims.sub, username: claims.username };
    const current = await currentActor(actor);
    const liveClaims = { ...claims, "cognito:groups": current.groups };
    const availableDomains = (await state.listDomains()).filter(domain => domain.status === "ACTIVE");
    // Existing demo roles remain usable for reads; current Cognito groups are
    // rechecked instead of accepting stale token membership for bootstrap writes.
    if (event.headers?.["x-demo-role"] && !current.groups.includes("demo-operator")) {
      throw new BootstrapError("FORBIDDEN", "Role switching is not permitted.", 403);
    }
    const projected = projectEffectiveIdentity(liveClaims, event.headers, { availableDomains, availableDemoDomains: availableDomains });
    const identity = { ...actor, role: projected.role, activeDomain: projected.domain, domainIds: projected.domains };
    const path = event.requestContext.http.path;
    const method = event.requestContext.http.method;
    if (method === "POST" && !current.groups.includes("platform-admin")) {
      throw new BootstrapError("FORBIDDEN", "Platform administrator membership is required to bootstrap a domain.", 403);
    }
    let result;
    if (method === "GET" && path === "/api/domain-bootstrap/catalog") result = await service.catalog(identity);
    else if (method === "GET" && path === "/api/domain-bootstrap") result = await service.read(identity, event.queryStringParameters?.domainId || "");
    else if (method === "POST") {
      if (typeof event.body !== "string" || Buffer.byteLength(event.body) > 32_768 || event.isBase64Encoded) throw new BootstrapError("INVALID_BODY", "Request body is invalid.", 400);
      let input;
      try { input = JSON.parse(event.body); }
      catch { throw new BootstrapError("INVALID_BODY", "Request body must be valid JSON.", 400); }
      if (!input || typeof input !== "object" || Array.isArray(input)) {
        throw new BootstrapError("INVALID_BODY", "Request body must be an object.", 400);
      }
      if (path === "/api/domain-bootstrap/preview") result = await service.review(identity, input);
      else if (path === "/api/domain-bootstrap") result = await service.start(identity, input);
      else if (path === "/api/domain-bootstrap/retry") {
        if (Object.keys(input).join(",") !== "domainId") throw new BootstrapError("INVALID_BODY", "Request body is invalid.", 400);
        result = await service.retry(identity, input.domainId);
      }
    }
    if (!result) throw new BootstrapError("NOT_FOUND", "Route not found.", 404);
    return response(200, { ok: true, ...result });
  } catch (error) {
    const known = error instanceof BootstrapError || error instanceof IdentityScopeError;
    if (!known) console.error({ event: "domain_bootstrap_error", code: error.name });
    return response(error.statusCode || 503, { ok: false, code: error.code || "BOOTSTRAP_UNAVAILABLE",
      message: known ? error.message : "Domain foundation is temporarily unavailable. Try again." });
  }
}
