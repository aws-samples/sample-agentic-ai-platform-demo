import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { prepareCandidate, runCli, ROLE, POLICY, STATEMENT } from './gateway-profile-read.mjs';
import { fixture } from './synthetic-fixture.mjs';

const statements = input => input.template.Resources[POLICY].Properties.PolicyDocument.Statement;
function applied() {
  const input = fixture();
  statements(input).push(structuredClone(STATEMENT));
  input.actualPolicy.PolicyDocument.Statement.push({ ...STATEMENT, Resource: input.profileArn });
  return input;
}

test('exact delta only; input, role/trust, existing statements, gateways, other resources and outputs preserved', () => {
  const input = fixture();
  const before = structuredClone(input);
  const result = prepareCandidate(input);
  assert.deepEqual(input, before);
  assert.deepEqual(result.manifest.changedResources, [POLICY]);
  assert.deepEqual(result.manifest.affectedGateways, ['LlmGateway', 'ToolsGateway']);
  assert.match(result.manifest.scope, /not LLM-exclusive/);
  assert.deepEqual(result.candidate.Resources[POLICY].Properties.PolicyDocument.Statement.at(-1), STATEMENT);
  const restored = structuredClone(result.candidate);
  restored.Resources[POLICY].Properties.PolicyDocument.Statement.pop();
  assert.deepEqual(restored, input.template);
  assert.deepEqual(prepareCandidate(input), result);
  assert.notEqual(result.manifest.templateSha256, result.manifest.candidateSha256);
});

test('already applied is unchanged no-op, not another grant or deployment acceptance', () => {
  const input = applied();
  const result = prepareCandidate(input);
  assert.equal(result.manifest.status, 'ALREADY_APPLIED');
  assert.deepEqual(result.candidate, input.template);
  assert.deepEqual(result.manifest.delta, []);
  assert.deepEqual(result.manifest.changedResources, []);
  assert.equal(result.manifest.templateSha256, result.manifest.candidateSha256);
});

const negatives = [
  ['wrong owner stack', input => { input.owner.stackId = input.owner.stackId.replace('PlatformRegistryStack', 'AgenticPlatform-ControlPlane'); }],
  ['wrong logical role', input => { input.owner.roleLogicalId = 'BuilderRole'; }],
  ['arbitrary policy target', input => { input.owner.policyLogicalId = 'OtherPolicy'; }],
  ['wrong policy attachment', input => { input.template.Resources[POLICY].Properties.Roles = [{ Ref: 'BuilderRole' }]; }],
  ['multiple attached roles', input => { input.template.Resources[POLICY].Properties.Roles.push({ Ref: 'BuilderRole' }); }],
  ['wrong LLM reference', input => { input.template.Resources.LlmGateway.Properties.RoleArn = { 'Fn::GetAtt': ['BuilderRole', 'Arn'] }; }],
  ['wrong Tools reference', input => { input.template.Resources.ToolsGateway.Properties.RoleArn = 'synthetic-other-role'; }],
  ['wrong actual Gateway role', input => { input.owner.gateways.ToolsGateway = 'synthetic-other-role'; }],
  ['missing Gateway', input => { delete input.template.Resources.ToolsGateway; }],
  ['unexpected third Gateway', input => { input.template.Resources.Third = structuredClone(input.template.Resources.ToolsGateway); }],
  ['live-only applied is drift, not reconciliation', input => { input.actualPolicy.PolicyDocument.Statement.push({ ...STATEMENT, Resource: input.profileArn }); }],
  ['template-only applied is drift', input => { statements(input).push(structuredClone(STATEMENT)); }],
  ['live extra grant drift', input => { input.actualPolicy.PolicyDocument.Statement.push({ Effect: 'Allow', Action: 's3:GetObject', Resource: '*' }); }],
  ['live removed statement drift', input => { input.actualPolicy.PolicyDocument.Statement.pop(); }],
  ['live reordered statements fail closed', input => { input.actualPolicy.PolicyDocument.Statement.reverse(); }],
  ['wrong actual policy name', input => { input.actualPolicy.PolicyName = 'OtherPolicy'; }],
  ['wrong actual physical role', input => { input.actualPolicy.RoleName = 'other'; }],
  ['role replacement', input => { input.template.Resources[ROLE].Properties.RoleName = 'replacement'; }],
  ['trust drift', input => { input.template.Resources[ROLE].Properties.AssumeRolePolicyDocument.Statement[0].Principal.Service = 'lambda.amazonaws.com'; }],
  ['wildcard profile', input => { input.profileArn += '*'; }],
  ['wrong profile', input => { input.profileArn = input.profileArn.replace('gpt-6-astra', 'gpt-5.5'); }],
  ['wrong region', input => { input.profileArn = input.profileArn.replace('us-west-2', 'us-east-1'); }],
  ['wrong account', input => { input.profileArn = input.profileArn.replace('9988', '9977'); }],
  ['wildcard statement', input => { input.proposedStatement.Resource = '*'; }],
  ['extra action', input => { input.proposedStatement.Action = ['bedrock:GetInferenceProfile', 'bedrock:InvokeModel']; }],
  ['extra condition', input => { input.proposedStatement.Condition = {}; }],
  ['extra execution switch', input => { input.execute = true; }],
  ['template transform', input => { input.template.Transform = 'SyntheticMacro'; }],
  ['unresolved policy reference', input => { statements(input)[0].Resource = { Ref: 'SomeParameter' }; }],
  ['unsupported policy intrinsic', input => { statements(input)[0].Resource = { 'Fn::If': ['Condition', '*', '*'] }; }],
  ['duplicate statement', input => {
    Object.assign(input, applied());
    statements(input).push(structuredClone(STATEMENT));
    input.actualPolicy.PolicyDocument.Statement.push({ ...STATEMENT, Resource: input.profileArn });
  }],
  ['duplicate permission different Sid', input => {
    statements(input).push({ ...STATEMENT, Sid: 'OtherSid' });
    input.actualPolicy.PolicyDocument.Statement.push({ ...STATEMENT, Sid: 'OtherSid', Resource: input.profileArn });
  }],
  ['conflicting Sid extra action', input => {
    const changed = { ...STATEMENT, Action: ['bedrock:GetInferenceProfile', 'bedrock:InvokeModel'] };
    statements(input).push(changed);
    input.actualPolicy.PolicyDocument.Statement.push({ ...changed, Resource: input.profileArn });
  }],
];
for (const [name, mutate] of negatives) {
  test(`reject ${name}`, () => {
    const input = fixture();
    mutate(input);
    assert.throws(() => prepareCandidate(input));
  });
}

test('resolve known Sub/Join/Ref for exact actual-policy comparison without mutating template', () => {
  const input = fixture();
  statements(input)[0].Resource = { 'Fn::Join': ['', ['arn:', { Ref: 'AWS::Partition' }, ':s3:::synthetic-bucket/*']] };
  input.actualPolicy.PolicyDocument.Statement[0].Resource = 'arn:aws:s3:::synthetic-bucket/*';
  assert.equal(prepareCandidate(input).manifest.status, 'CANDIDATE_ONLY');
});

test('CLI emits reproducible two-file candidate; refuses overwrite and rejected inputs create no output', () => {
  const root = mkdtempSync(join(tmpdir(), 'offline-owner-policy-'));
  try {
    const path = join(root, 'input.json');
    const output = join(root, 'candidate');
    const input = fixture();
    writeFileSync(path, JSON.stringify(input));
    assert.equal(runCli(['--input', path, '--output-dir', output]), 'CANDIDATE_ONLY');
    assert.deepEqual(JSON.parse(readFileSync(join(output, 'candidate-template.json'))), prepareCandidate(input).candidate);
    assert.deepEqual(JSON.parse(readFileSync(join(output, 'delta-manifest.json'))), prepareCandidate(input).manifest);
    assert.throws(() => runCli(['--input', path, '--output-dir', output]));
    assert.throws(() => runCli(['--input', path, '--output-dir', output, '--execute']));
    input.profileArn = '*';
    writeFileSync(path, JSON.stringify(input));
    const rejected = join(root, 'rejected');
    assert.throws(() => runCli(['--input', path, '--output-dir', rejected]));
    assert.equal(existsSync(rejected), false);
    writeFileSync(path, '{"private-input-marker": invalid}');
    const run = spawnSync(process.execPath, [new URL('./gateway-profile-read.mjs', import.meta.url).pathname,
      '--input', path, '--output-dir', rejected], { encoding: 'utf8' });
    assert.equal(run.status, 1);
    assert.doesNotMatch(run.stderr, /private-input-marker/);
    assert.equal(existsSync(rejected), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
