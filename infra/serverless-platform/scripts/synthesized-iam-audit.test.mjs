import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspectSynthesizedIam, templateResolver } from './synthesized-iam-audit.mjs';
import { canonicalPolicyContent } from './predeploy-security-audit.mjs';

const accountId = '123456789012', region = 'us-west-2', stackName = 'AgenticPlatform-Web';
const tags = [{ Key: 'project', Value: 'agentic-ai-platform-demo' }];
const trust = { Version: '2012-10-17', Statement: [{ Effect: 'Allow', Action: 'sts:AssumeRole', Principal: { Service: 'lambda.amazonaws.com' } }] };
const read = { Version: '2012-10-17', Statement: [{ Effect: 'Allow', Action: 'bedrock-agentcore:GetGateway', Resource: `arn:aws:bedrock-agentcore:${region}:${accountId}:gateway/tools` }] };
const iamArn = name => `arn:aws:iam::${accountId}:policy/${name}`;

function fixture(t, mutate = () => {}) {
  const dir = mkdtempSync(join(tmpdir(), 'iam-contract-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const resources = {}, inventory = [], roleDocs = new Map(), policyDocs = new Map();
  for (const [roleSuffix, boundarySuffix] of [['AgentRuntimeRole', 'BedrockConsumerBoundary'], ['BuilderApiRole', 'BedrockConsumerBoundary'], ['OperationsApiRole', 'OperationsBoundary'], ['PolicyInventoryRole', 'PolicyInventoryBoundary'], ['IdentityApiRole', 'RuntimePermissionsBoundary']]) {
    const name = `AgenticPlatform-Web-${roleSuffix}`, boundary = `AgenticPlatform-Web-${boundarySuffix}`;
    resources[boundarySuffix] = { Type: 'AWS::IAM::ManagedPolicy', Properties: { ManagedPolicyName: boundary, PolicyDocument: structuredClone(read) } };
    resources[roleSuffix] = { Type: 'AWS::IAM::Role', Properties: { RoleName: name, AssumeRolePolicyDocument: structuredClone(trust), PermissionsBoundary: { Ref: boundarySuffix }, Tags: tags, Policies: [{ PolicyName: 'Read', PolicyDocument: structuredClone(read) }] } };
    roleDocs.set(name, { RoleName: name, Arn: `arn:aws:iam::${accountId}:role/${name}`, AssumeRolePolicyDocument: structuredClone(trust), Tags: tags,
      PermissionsBoundary: { PermissionsBoundaryType: 'Policy', PermissionsBoundaryArn: iamArn(boundary) } });
    policyDocs.set(iamArn(boundary), { PolicyName: boundary, Arn: iamArn(boundary), DefaultVersionId: 'v2' });
  }
  for (const [id, r] of Object.entries(resources)) inventory.push({ LogicalResourceId: id, ResourceType: r.Type,
    PhysicalResourceId: r.Type === 'AWS::IAM::Role' ? r.Properties.RoleName : iamArn(r.Properties.ManagedPolicyName) });
  resources.PolicyTags = { Type: 'Custom::RuntimePermissionsBoundaryTags', Properties: { PolicyArn: { Ref: 'PolicyInventoryBoundary' }, RequiredTags: tags } };
  const template = { Resources: resources }, deployed = structuredClone(template);
  const requiredRoleNames = [...roleDocs.keys()];
  const context = { template, deployed, inventory, roleDocs, policyDocs, override: null };
  mutate(context);
  const templatePath = join(dir, 'PlatformWebStack.template.json'); writeFileSync(templatePath, JSON.stringify(template));
  const domainTemplatePath = context.domainTemplate ? join(dir, 'DomainBootstrapStack.template.json') : undefined;
  if (domainTemplatePath) writeFileSync(domainTemplatePath, JSON.stringify(context.domainTemplate));
  const aws = (service, op, args) => {
    const override = context.override?.(service, op, args); if (override !== undefined) return override;
    if (args[1] === 'AgenticPlatform-DomainBootstrap') {
      if (op === 'describe-stacks') return { Stacks: [{ StackStatus: 'UPDATE_COMPLETE', StackId: `arn:aws:cloudformation:${region}:${accountId}:stack/AgenticPlatform-DomainBootstrap/id` }] };
      if (op === 'get-template') return { TemplateBody: context.deployedDomain };
      if (op === 'list-stack-resources') return { StackResourceSummaries: [] };
    }
    if (op === 'describe-stacks') return { Stacks: [{ StackStatus: 'UPDATE_COMPLETE', StackId: `arn:aws:cloudformation:${region}:${accountId}:stack/${stackName}/id` }] };
    if (op === 'get-template') return { TemplateBody: deployed };
    if (op === 'list-stack-resources') return { StackResourceSummaries: inventory };
    if (op === 'list-exports') return { Exports: [] };
    if (op === 'get-role') return { Role: roleDocs.get(args[1]) };
    if (op === 'get-policy') return { Policy: policyDocs.get(args[1]) };
    if (op === 'get-policy-version') return { PolicyVersion: { IsDefaultVersion: true, VersionId: 'v2', Document: structuredClone(read) } };
    if (op === 'list-policy-tags') return { Tags: tags, IsTruncated: false };
    if (op === 'list-attached-role-policies') return { AttachedPolicies: [], IsTruncated: false };
    if (op === 'list-role-policies') return { PolicyNames: ['Read'], IsTruncated: false };
    if (op === 'get-role-policy') return { RoleName: args[1], PolicyName: args[3], PolicyDocument: structuredClone(read) };
    assert.fail(`Unexpected AWS call ${service} ${op}`);
  };
  return () => inspectSynthesizedIam({ templatePath, accountId, region, stackName, aws, canonicalPolicyContent, requiredRoleNames, domainTemplatePath });
}

test('strict IAM audit verifies four distinct source-defined boundaries and every role policy', t => {
  const result = fixture(t)();
  assert.equal(result.status, 'passed'); assert.equal(result.roles.length, 5); assert.equal(result.managedPolicies.length, 4);
  assert.equal(new Set(result.roles.map(r => r.boundaryArn)).size, 4);
  assert.match(result.templateSha256, /^[a-f0-9]{64}$/);
});

for (const [name, change, pattern] of [
  ['wrong boundary on runtime', c => { [...c.roleDocs.values()][0].PermissionsBoundary.PermissionsBoundaryArn = iamArn('AgenticPlatform-Web-RuntimePermissionsBoundary'); }, /boundary drift/],
  ['missing boundary', c => { delete [...c.roleDocs.values()][0].PermissionsBoundary; }, /boundary drift/],
  ['expanded trust', c => { [...c.roleDocs.values()][0].AssumeRolePolicyDocument.Statement[0].Principal = '*'; }, /trust drift/],
  ['missing role tag', c => { [...c.roleDocs.values()][0].Tags = []; }, /tags/],
  ['deployed template self-approval', c => { c.deployed.Resources.AgentRuntimeRole.Properties.PermissionsBoundary = { Ref: 'RuntimePermissionsBoundary' }; }, /differs from source/],
  ['omitted role in source and deployment', c => { delete c.template.Resources.PolicyInventoryRole; delete c.deployed.Resources.PolicyInventoryRole; }, /omits a required/],
  ['foreign stack', c => { c.override = (_, op) => op === 'describe-stacks' ? { Stacks: [{ StackStatus: 'UPDATE_COMPLETE', StackId: `arn:aws:cloudformation:${region}:999999999999:stack/${stackName}/id` }] } : undefined; }, /verified account/],
  ['truncated inventory', c => { c.override = (_, op) => op === 'list-stack-resources' ? { StackResourceSummaries: c.inventory, NextToken: 'more' } : undefined; }, /Incomplete/],
  ['unknown attached admin policy', c => { c.override = (_, op) => op === 'list-attached-role-policies' ? { AttachedPolicies: [{ PolicyArn: 'arn:aws:iam::aws:policy/AdministratorAccess' }] } : undefined; }, /Attached role policy drift/],
  ['unexpected inline policy', c => { c.override = (_, op) => op === 'list-role-policies' ? { PolicyNames: ['Read', 'Backdoor'] } : undefined; }, /inventory drift/],
  ['expanded boundary policy', c => { c.override = (_, op) => op === 'get-policy-version' ? { PolicyVersion: { IsDefaultVersion: true, VersionId: 'v2', Document: { ...read, Statement: [{ Effect: 'Allow', Action: '*', Resource: '*' }] } } } : undefined; }, /contents drift/],
  ['expanded inline policy', c => { c.override = (_, op, args) => op === 'get-role-policy' ? { RoleName: args[1], PolicyName: args[3], PolicyDocument: { ...read, Statement: [{ Effect: 'Allow', Action: '*', Resource: '*' }] } } : undefined; }, /contents drift/],
  ['nondefault policy version', c => { c.override = (_, op) => op === 'get-policy-version' ? { PolicyVersion: { IsDefaultVersion: false, VersionId: 'v2', Document: read } } : undefined; }, /contents drift/],
  ['truncated role policy list', c => { c.override = (_, op) => op === 'list-role-policies' ? { PolicyNames: ['Read'], IsTruncated: true } : undefined; }, /Incomplete/],
  ['required policy tags missing', c => { c.override = (_, op) => op === 'list-policy-tags' ? { Tags: [] } : undefined; }, /tags/],
]) test(`strict IAM audit rejects ${name}`, t => assert.throws(fixture(t, change), pattern));

test('resolver binds only supported physical resources and rejects unknown expressions', () => {
  const template = { Resources: { Log: { Type: 'AWS::Logs::LogGroup' }, Table: { Type: 'AWS::DynamoDB::Table' } } };
  const resources = [{ LogicalResourceId: 'Log', ResourceType: 'AWS::Logs::LogGroup', PhysicalResourceId: '/aws/lambda/test' }, { LogicalResourceId: 'Table', ResourceType: 'AWS::DynamoDB::Table', PhysicalResourceId: 'state' }];
  const resolve = templateResolver({ template, resources, exports: { Gateway: 'gateway-arn' }, accountId, region });
  assert.equal(resolve({ 'Fn::Join': ['', [{ Ref: 'AWS::AccountId' }, '/', { 'Fn::ImportValue': 'Gateway' }]] }), `${accountId}/gateway-arn`);
  assert.equal(resolve({ 'Fn::GetAtt': ['Log', 'Arn'] }), `arn:aws:logs:${region}:${accountId}:log-group:/aws/lambda/test:*`);
  assert.equal(resolve({ 'Fn::GetAtt': ['Table', 'Arn'] }), `arn:aws:dynamodb:${region}:${accountId}:table/state`);
  assert.throws(() => resolve({ 'Fn::If': ['unknown'] }), /Unsupported/);
  assert.throws(() => resolve({ 'Fn::GetAtt': ['Log', 'Secret'] }), /Unsupported/);
  assert.throws(() => resolve({ Ref: 'Missing' }), /Unresolved/);
  assert.throws(() => resolve({ 'Fn::ImportValue': 'Missing' }), /Missing/);
});

function domainGrant(c) {
  const role = 'AgenticPlatform-Web-IdentityApiRole';
  const policy = { PolicyName: 'DomainCatalogRead', Roles: [role], PolicyDocument: structuredClone(read) };
  c.domainTemplate = { Resources: { CatalogGrant: { Type: 'AWS::IAM::Policy', Properties: policy } } };
  c.deployedDomain = structuredClone(c.domainTemplate);
  c.override = (_, op, args) => {
    if (op === 'list-role-policies' && args[1] === role) return { PolicyNames: ['Read', policy.PolicyName] };
    if (op === 'get-role-policy' && args[3] === policy.PolicyName) return { RoleName: role, PolicyName: policy.PolicyName, PolicyDocument: read };
  };
}
test('cross-stack grant must match its own synthesized and deployed source contract', t => {
  const result = fixture(t, domainGrant)();
  assert.equal(result.supportingTemplates[0].stackName, 'AgenticPlatform-DomainBootstrap');
  assert.equal(result.roles.length, 5);
});
test('cross-stack source drift is rejected before accepting the live policy name', t => {
  assert.throws(fixture(t, c => {
    domainGrant(c);
    c.deployedDomain.Resources.CatalogGrant.Properties.PolicyDocument.Statement[0].Resource = '*';
  }), /DomainBootstrap IAM template differs/);
});
test('cross-stack permissions must match actual inline contents', t => {
  assert.throws(fixture(t, c => {
    domainGrant(c);
    const original = c.override;
    c.override = (service, op, args) => op === 'get-role-policy' && args[3] === 'DomainCatalogRead'
      ? { RoleName: args[1], PolicyName: args[3], PolicyDocument: { ...read, Statement: [] } }
      : original(service, op, args);
  }), /contents drift/);
});
test('missing current source template fails with an actionable synthesis instruction', () => {
  assert.throws(() => inspectSynthesizedIam({ templatePath: '/definitely-missing-platform-template.json' }), /Run cdk synth/);
});
