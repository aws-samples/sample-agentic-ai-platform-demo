import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const OWNER = 'PlatformRegistryStack';
export const ROLE = 'GatewayRole0A0569CA';
export const POLICY = 'GatewayRoleDefaultPolicyF4BF688C';
export const GATEWAYS = ['LlmGateway', 'ToolsGateway'];
export const STATEMENT = Object.freeze({
  Sid: 'ReadGlobalAstraInferenceProfile',
  Effect: 'Allow',
  Action: 'bedrock:GetInferenceProfile',
  Resource: Object.freeze({
    'Fn::Sub': 'arn:${AWS::Partition}:bedrock:us-west-2:${AWS::AccountId}:inference-profile/global.openai.gpt-6-astra',
  }),
});

const canonical = value => JSON.stringify(value, function (_key, item) {
  return item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item;
});
const equal = (left, right) => canonical(left) === canonical(right);
export const sha256 = value => createHash('sha256').update(canonical(value)).digest('hex');
const check = (condition, code) => { if (!condition) throw new Error(code); };
const exactKeys = (value, keys) => value && equal(Object.keys(value).sort(), [...keys].sort());

// Only the known pseudo parameters are resolved. Unknown intrinsics fail closed;
// this is deliberately not a general-purpose CloudFormation interpreter.
function resolvePolicy(value, parameters) {
  if (Array.isArray(value)) return value.map(item => resolvePolicy(item, parameters));
  if (!value || typeof value !== 'object') return value;
  if (exactKeys(value, ['Ref'])) {
    check(Object.hasOwn(parameters, value.Ref), 'UNRESOLVED_POLICY_REF');
    return parameters[value.Ref];
  }
  if (exactKeys(value, ['Fn::Sub'])) {
    check(typeof value['Fn::Sub'] === 'string', 'UNSUPPORTED_POLICY_SUB');
    return value['Fn::Sub'].replace(/\$\{([^}]+)\}/g, (_match, name) => {
      check(Object.hasOwn(parameters, name), 'UNRESOLVED_POLICY_SUB');
      return parameters[name];
    });
  }
  if (exactKeys(value, ['Fn::Join'])) {
    const args = value['Fn::Join'];
    check(Array.isArray(args) && args.length === 2 && typeof args[0] === 'string'
      && Array.isArray(args[1]), 'UNSUPPORTED_POLICY_JOIN');
    const parts = resolvePolicy(args[1], parameters);
    check(parts.every(part => typeof part === 'string'), 'UNRESOLVED_POLICY_JOIN');
    return parts.join(args[0]);
  }
  check(!Object.keys(value).some(key => key === 'Ref' || key.startsWith('Fn::')), 'UNSUPPORTED_POLICY_INTRINSIC');
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolvePolicy(item, parameters)]));
}

/** Trusted owner-read snapshots in; candidate objects out. No AWS or network I/O. */
export function prepareCandidate(input) {
  check(exactKeys(input, ['owner', 'template', 'actualPolicy', 'profileArn', 'proposedStatement']), 'INVALID_INPUT');
  const { owner, template, actualPolicy, profileArn, proposedStatement } = input;
  check(exactKeys(owner, ['stackId', 'roleLogicalId', 'policyLogicalId', 'rolePhysicalId', 'roleResource', 'gateways']), 'INVALID_OWNER');
  const stack = /^arn:aws:cloudformation:us-west-2:(\d{12}):stack\/PlatformRegistryStack\/[a-f0-9-]+$/.exec(owner.stackId);
  check(stack && owner.roleLogicalId === ROLE && owner.policyLogicalId === POLICY, 'WRONG_OWNER');
  check(typeof owner.rolePhysicalId === 'string' && /^[\w+=,.@-]{1,64}$/.test(owner.rolePhysicalId), 'INVALID_ROLE_NAME');
  const account = stack[1];
  const parameters = { 'AWS::Partition': 'aws', 'AWS::AccountId': account, 'AWS::Region': 'us-west-2' };
  check(profileArn === `arn:aws:bedrock:us-west-2:${account}:inference-profile/global.openai.gpt-6-astra`, 'INVALID_EXACT_PROFILE');
  check(equal(proposedStatement, STATEMENT), 'INVALID_STATEMENT');
  check(template && typeof template === 'object' && !Array.isArray(template), 'INVALID_TEMPLATE');
  check(!template.Transform, 'TEMPLATE_TRANSFORM_NOT_SUPPORTED');
  const resources = template.Resources;
  const role = resources?.[ROLE];
  const policy = resources?.[POLICY];
  check(role?.Type === 'AWS::IAM::Role' && equal(role, owner.roleResource), 'ROLE_REPLACEMENT_OR_DRIFT');
  check(role.Properties && !role.Condition && !role.Properties.Policies?.length, 'UNSUPPORTED_ROLE_ATTACHMENT');
  check(!role.Properties.RoleName || role.Properties.RoleName === owner.rolePhysicalId, 'WRONG_PHYSICAL_ROLE');
  check(policy?.Type === 'AWS::IAM::Policy' && !policy.Condition, 'WRONG_POLICY');
  const properties = policy.Properties;
  check(properties?.PolicyName === POLICY && equal(properties.Roles, [{ Ref: ROLE }])
    && !properties.Users && !properties.Groups, 'WRONG_POLICY_ATTACHMENT');
  check(exactKeys(owner.gateways, GATEWAYS), 'WRONG_GATEWAY_SNAPSHOT');
  for (const gateway of GATEWAYS) {
    check(resources[gateway]?.Type === 'AWS::BedrockAgentCore::Gateway'
      && !resources[gateway].Condition
      && equal(resources[gateway].Properties?.RoleArn, { 'Fn::GetAtt': [ROLE, 'Arn'] })
      && owner.gateways[gateway] === `arn:aws:iam::${account}:role/${owner.rolePhysicalId}`, 'WRONG_GATEWAY_ROLE');
  }
  const gatewayIds = Object.entries(resources).filter(([, resource]) => resource.Type === 'AWS::BedrockAgentCore::Gateway').map(([id]) => id).sort();
  check(equal(gatewayIds, [...GATEWAYS].sort()), 'UNEXPECTED_GATEWAY_SCOPE');
  check(actualPolicy?.RoleName === owner.rolePhysicalId && actualPolicy?.PolicyName === POLICY, 'WRONG_ACTUAL_POLICY');
  const document = properties.PolicyDocument;
  check(document?.Version === '2012-10-17' && Array.isArray(document.Statement), 'INVALID_POLICY_DOCUMENT');
  const resolved = resolvePolicy(document, parameters);
  // Deliberately strict: statement/array order or scalar/list differences also
  // require owner review, never silently normalized into a deployable template.
  check(equal(resolved, actualPolicy.PolicyDocument), 'LIVE_POLICY_DRIFT');
  const expected = resolvePolicy(STATEMENT, parameters);
  const sameSid = resolved.Statement.filter(statement => statement.Sid === STATEMENT.Sid);
  const sameGrant = resolved.Statement.filter(statement => {
    const actions = Array.isArray(statement.Action) ? statement.Action : [statement.Action];
    const targets = Array.isArray(statement.Resource) ? statement.Resource : [statement.Resource];
    return statement.Effect === 'Allow' && actions.includes(STATEMENT.Action) && targets.includes(profileArn);
  });
  check(sameSid.length <= 1 && sameGrant.length <= 1, 'DUPLICATE_STATEMENT');
  check(!sameSid.length || equal(sameSid[0], expected), 'CONFLICTING_STATEMENT');
  check(!sameGrant.length || (sameSid.length === 1 && equal(sameGrant[0], expected)), 'DUPLICATE_PERMISSION');
  const alreadyApplied = sameSid.length === 1;
  const candidate = structuredClone(template);
  if (!alreadyApplied) candidate.Resources[POLICY].Properties.PolicyDocument.Statement.push(structuredClone(STATEMENT));
  // A complete before/after comparison, not just an IAM-resource filter.
  const restored = structuredClone(candidate);
  if (!alreadyApplied) restored.Resources[POLICY].Properties.PolicyDocument.Statement.pop();
  check(equal(restored, template), 'OUT_OF_SCOPE_DELTA');
  return {
    candidate,
    manifest: {
      schemaVersion: 1,
      status: alreadyApplied ? 'ALREADY_APPLIED' : 'CANDIDATE_ONLY',
      ownerStackName: OWNER,
      roleLogicalId: ROLE,
      policyLogicalId: POLICY,
      affectedGateways: GATEWAYS,
      scope: 'Shared role: both LLM and Tools Gateway receive exact profile read; not LLM-exclusive.',
      changedResources: alreadyApplied ? [] : [POLICY],
      delta: alreadyApplied ? [] : [{ op: 'add', path: `/Resources/${POLICY}/Properties/PolicyDocument/Statement/-`, value: STATEMENT }],
      templateSha256: sha256(template),
      candidateSha256: sha256(candidate),
      actualPolicySha256: sha256(actualPolicy.PolicyDocument),
      ownerSnapshotSha256: sha256(owner),
      profileArnSha256: sha256(profileArn),
      authorization: 'Offline review only. No permission to create/execute a change set, mutate IAM, create a target, or invoke a model.',
    },
  };
}

export function runCli(args) {
  check(args.length === 4 && args[0] === '--input' && args[2] === '--output-dir', 'USAGE: --input bundle.json --output-dir NEW_DIRECTORY');
  const result = prepareCandidate(JSON.parse(readFileSync(args[1], 'utf8')));
  // New private directory only: never overwrite an input, prior evidence, or output.
  mkdirSync(args[3], { mode: 0o700 });
  for (const [name, value] of [['candidate-template.json', result.candidate], ['delta-manifest.json', result.manifest]]) {
    writeFileSync(resolve(args[3], name), `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  }
  return result.manifest.status;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { console.log(runCli(process.argv.slice(2))); }
  catch (error) {
    // Never echo parse snippets, filenames, raw policy documents or identifiers.
    console.error(/^[A-Z_ :.-]+$/.test(error.message) ? error.message : 'INPUT_OR_OUTPUT_REJECTED');
    process.exitCode = 1;
  }
}
