import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

function requireThat(value, message) {
  if (!value) throw Object.assign(new Error(message), { code: 'SYNTHESIZED_IAM_DRIFT' });
}
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(
    Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, stable(v)]));
  return value;
}
const equal = (a, b) => JSON.stringify(stable(a)) === JSON.stringify(stable(b));
const list = value => value === undefined ? [] : Array.isArray(value) ? value : [value];
function complete(value, key) {
  requireThat(value && !value.NextToken && !value.Marker && value.IsTruncated !== true
    && Array.isArray(value[key]), `Incomplete IAM audit inventory: ${key}.`);
  return value[key];
}
function decode(value) {
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch { value = JSON.parse(decodeURIComponent(value)); }
  }
  requireThat(value && typeof value === 'object' && !Array.isArray(value), 'Invalid IAM policy document.');
  return value;
}
function tagsMatch(actual, expected, label) {
  requireThat(Array.isArray(actual), `${label} tags are missing.`);
  const map = new Map(actual.map(({ Key, Value }) => [Key, Value]));
  requireThat(map.size === actual.length && expected.every(({ Key, Value }) => map.get(Key) === Value),
    `${label} required tags have drifted.`);
}

// Resolve only the intrinsic functions and attribute types used by the Web IAM
// contract. Unknown expressions fail closed instead of being copied or ignored.
export function templateResolver({ template, resources, exports, accountId, region }) {
  const physical = new Map(resources.map(r => [r.LogicalResourceId, r]));
  requireThat(physical.size === resources.length, 'Duplicate stack resource identifiers.');
  const pseudo = { 'AWS::Partition': 'aws', 'AWS::AccountId': accountId, 'AWS::Region': region };
  const arn = (service, resource, location = region, owner = accountId) =>
    `arn:aws:${service}:${location}:${owner}:${resource}`;
  function resource(id) {
    const found = physical.get(id);
    requireThat(found && found.ResourceType === template.Resources[id]?.Type
      && typeof found.PhysicalResourceId === 'string', `Unresolved IAM dependency: ${id}.`);
    return found;
  }
  function attribute(id, key) {
    const { ResourceType: type, PhysicalResourceId: name } = resource(id);
    if (key === 'Arn') {
      if (type === 'AWS::IAM::Role') return arn('iam', `role/${name}`, '');
      if (type === 'AWS::Logs::LogGroup') return arn('logs', `log-group:${name}:*`);
      if (type === 'AWS::DynamoDB::Table') return arn('dynamodb', `table/${name}`);
      if (type === 'AWS::Lambda::Function') return arn('lambda', `function:${name}`);
      if (type === 'AWS::Cognito::UserPool') return arn('cognito-idp', `userpool/${name}`);
      if (type === 'AWS::S3::Bucket') return arn('s3', name, '', '');
    }
    if (type === 'AWS::BedrockAgentCore::Runtime' && key === 'AgentRuntimeArn') {
      return name.startsWith('arn:') ? name : arn('bedrock-agentcore', `runtime/${name}`);
    }
    if (type === 'AWS::BedrockAgentCore::RuntimeEndpoint' && key === 'AgentRuntimeEndpointArn') {
      requireThat(name.startsWith(arn('bedrock-agentcore', 'runtime/')), `Invalid runtime endpoint: ${id}.`);
      return name;
    }
    throw new Error(`Unsupported IAM dependency attribute: ${id}.${key}.`);
  }
  function resolve(value) {
    if (Array.isArray(value)) return value.map(resolve);
    if (!value || typeof value !== 'object') return value;
    if ('Ref' in value) {
      requireThat(Object.keys(value).length === 1, 'Malformed Ref in IAM contract.');
      return pseudo[value.Ref] ?? resource(value.Ref).PhysicalResourceId;
    }
    if ('Fn::GetAtt' in value) return attribute(...list(value['Fn::GetAtt']));
    if ('Fn::Join' in value) {
      const [separator, parts] = value['Fn::Join'];
      const resolved = resolve(parts);
      requireThat(typeof separator === 'string' && Array.isArray(resolved)
        && resolved.every(v => typeof v === 'string'), 'Malformed Join in IAM contract.');
      return resolved.join(separator);
    }
    if ('Fn::ImportValue' in value) {
      const key = resolve(value['Fn::ImportValue']);
      requireThat(typeof exports[key] === 'string', `Missing IAM export: ${key}.`);
      return exports[key];
    }
    requireThat(!Object.keys(value).some(k => k.startsWith('Fn::')), 'Unsupported IAM template intrinsic.');
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolve(v)]));
  }
  return resolve;
}

export function inspectSynthesizedIam({ templatePath, accountId, region, stackName,
  aws, canonicalPolicyContent, requiredRoleNames, domainTemplatePath }) {
  let bytes;
  try { bytes = readFileSync(templatePath); } catch {
    throw new Error('Postdeployment IAM verification needs the current CDK Web template. Run cdk synth and set SECURITY_AUDIT_WEB_TEMPLATE to its PlatformWebStack.template.json.');
  }
  const template = JSON.parse(bytes);
  const expected = template.Resources;
  requireThat(expected && typeof expected === 'object', 'CDK template has no resource contract.');
  const stack = aws('cloudformation', 'describe-stacks', ['--stack-name', stackName]).Stacks;
  requireThat(stack?.length === 1 && /^(CREATE|UPDATE|IMPORT)_COMPLETE$/.test(stack[0].StackStatus)
    && stack[0].StackId?.startsWith(`arn:aws:cloudformation:${region}:${accountId}:stack/${stackName}/`),
  'IAM verification requires the completed target stack in the verified account.');
  const inventory = complete(aws('cloudformation', 'list-stack-resources', ['--stack-name', stackName]), 'StackResourceSummaries');
  const deployed = decode(aws('cloudformation', 'get-template', ['--stack-name', stackName]).TemplateBody).Resources;
  const iamEntries = source => Object.entries(source).filter(([, r]) => r.Type.startsWith('AWS::IAM::'));
  // Compare source with the deployed template before trusting any live resource
  // bindings. A modified deployed template cannot become its own expectation.
  requireThat(equal(iamEntries(expected).map(([id]) => id).sort(), iamEntries(deployed).map(([id]) => id).sort()),
    'Deployed IAM resource inventory differs from the current CDK template.');
  for (const [id, spec] of iamEntries(expected)) {
    requireThat(equal({ Type: spec.Type, Properties: spec.Properties },
      { Type: deployed[id].Type, Properties: deployed[id].Properties }), `Deployed IAM template differs from source: ${id}.`);
  }
  const exportList = complete(aws('cloudformation', 'list-exports', []), 'Exports');
  const exports = Object.fromEntries(exportList.map(({ Name, Value }) => [Name, Value]));
  requireThat(Object.keys(exports).length === exportList.length, 'Duplicate CloudFormation exports.');
  const resolve = templateResolver({ template, resources: inventory, exports, accountId, region });
  const additionalPolicies = [], supportingTemplates = [];
  if (domainTemplatePath) {
    const domainBytes = readFileSync(domainTemplatePath);
    const domainTemplate = JSON.parse(domainBytes);
    const domainStack = "AgenticPlatform-DomainBootstrap";
    const info = aws('cloudformation', 'describe-stacks', ['--stack-name', domainStack]).Stacks;
    requireThat(info?.length === 1 && /^(CREATE|UPDATE|IMPORT)_COMPLETE$/.test(info[0].StackStatus)
      && info[0].StackId?.startsWith(`arn:aws:cloudformation:${region}:${accountId}:stack/${domainStack}/`),
      'Cross-stack IAM grants require the completed DomainBootstrap stack in the verified account.');
    const deployedDomain = decode(aws('cloudformation', 'get-template', ['--stack-name', domainStack]).TemplateBody);
    const sourceIam = iamEntries(domainTemplate.Resources).map(([id, r]) => [id, { Type: r.Type, Properties: r.Properties }]);
    const deployedIam = iamEntries(deployedDomain.Resources).map(([id, r]) => [id, { Type: r.Type, Properties: r.Properties }]);
    requireThat(equal(sourceIam.sort(), deployedIam.sort()), 'DomainBootstrap IAM template differs from source.');
    const domainResources = complete(aws('cloudformation', 'list-stack-resources', ['--stack-name', domainStack]), 'StackResourceSummaries');
    const resolveDomain = templateResolver({ template: domainTemplate, resources: domainResources, exports, accountId, region });
    for (const [, r] of iamEntries(domainTemplate.Resources).filter(([, r]) => r.Type === 'AWS::IAM::Policy')) {
      additionalPolicies.push(resolveDomain(r.Properties));
    }
    supportingTemplates.push({ stackName: domainStack, templateSha256: createHash('sha256').update(domainBytes).digest('hex') });
  }
  const roles = iamEntries(expected).filter(([, r]) => r.Type === 'AWS::IAM::Role');
  const roleNames = roles.map(([, r]) => resolve(r.Properties.RoleName));
  requireThat(new Set(roleNames).size === roles.length && requiredRoleNames.every(name => roleNames.includes(name)),
    'CDK IAM contract omits a required platform role.');
  const managed = new Map();
  for (const [id, spec] of iamEntries(expected).filter(([, r]) => r.Type === 'AWS::IAM::ManagedPolicy')) {
    const props = resolve(spec.Properties);
    const arn = resolve({ Ref: id });
    requireThat(arn === `arn:aws:iam::${accountId}:policy/${props.ManagedPolicyName}`, `Wrong managed policy binding: ${id}.`);
    const policy = aws('iam', 'get-policy', ['--policy-arn', arn]).Policy;
    requireThat(policy?.Arn === arn && policy.PolicyName === props.ManagedPolicyName
      && /^v[1-9][0-9]*$/.test(policy.DefaultVersionId), `Managed policy metadata drift: ${id}.`);
    const version = aws('iam', 'get-policy-version', ['--policy-arn', arn, '--version-id', policy.DefaultVersionId]).PolicyVersion;
    requireThat(version?.IsDefaultVersion === true && version.VersionId === policy.DefaultVersionId
      && canonicalPolicyContent(decode(version.Document)) === canonicalPolicyContent(props.PolicyDocument),
    `Managed policy contents drift: ${props.ManagedPolicyName}.`);
    const tagSpecs = Object.values(expected).filter(r => r.Type === 'Custom::RuntimePermissionsBoundaryTags')
      .map(r => resolve(r.Properties)).filter(p => p.PolicyArn === arn).flatMap(p => p.RequiredTags);
    if (tagSpecs.length) tagsMatch(complete(aws('iam', 'list-policy-tags', ['--policy-arn', arn]), 'Tags'), tagSpecs, props.ManagedPolicyName);
    managed.set(arn, { name: props.ManagedPolicyName, defaultVersionId: policy.DefaultVersionId, contentMatches: true });
  }
  const results = [];
  for (const [id, spec] of roles) {
    const props = resolve(spec.Properties), name = props.RoleName;
    requireThat(resolve({ Ref: id }) === name, `Role physical binding differs from source: ${id}.`);
    const role = aws('iam', 'get-role', ['--role-name', name]).Role;
    requireThat(role?.RoleName === name && role.Arn === `arn:aws:iam::${accountId}:role/${name}`,
      `Role identity drift: ${name}.`);
    requireThat(canonicalPolicyContent(decode(role.AssumeRolePolicyDocument)) === canonicalPolicyContent(props.AssumeRolePolicyDocument),
      `Role trust drift: ${name}.`);
    tagsMatch(role.Tags, props.Tags ?? [], name);
    if (props.PermissionsBoundary) {
      requireThat(managed.has(props.PermissionsBoundary)
        && role.PermissionsBoundary?.PermissionsBoundaryType === 'Policy'
        && role.PermissionsBoundary.PermissionsBoundaryArn === props.PermissionsBoundary, `Role boundary drift: ${name}.`);
    } else {
      requireThat(name === 'AgenticPlatform-Web-HostedAcceptanceRole' && role.PermissionsBoundary === undefined,
        `Unexpected unbounded role: ${name}.`);
    }
    const attached = complete(aws('iam', 'list-attached-role-policies', ['--role-name', name]), 'AttachedPolicies').map(p => p.PolicyArn);
    const expectedAttached = list(props.ManagedPolicyArns);
    requireThat(expectedAttached.every(arn => managed.has(arn)) && equal(attached.sort(), expectedAttached.sort()),
      `Attached role policy drift: ${name}.`);
    const policies = [...(props.Policies ?? [])];
    for (const [, r] of iamEntries(expected).filter(([, r]) => r.Type === 'AWS::IAM::Policy')) {
      const p = resolve(r.Properties);
      if (list(p.Roles).includes(name)) policies.push(p);
    }
    policies.push(...additionalPolicies.filter(p => list(p.Roles).includes(name)));
    const names = policies.map(p => p.PolicyName);
    const actualNames = complete(aws('iam', 'list-role-policies', ['--role-name', name]), 'PolicyNames');
    requireThat(new Set(names).size === names.length && equal(names.sort(), actualNames.sort()), `Inline role policy inventory drift: ${name}.`);
    for (const p of policies) {
      const actual = aws('iam', 'get-role-policy', ['--role-name', name, '--policy-name', p.PolicyName]);
      requireThat(actual.RoleName === name && actual.PolicyName === p.PolicyName
        && canonicalPolicyContent(decode(actual.PolicyDocument)) === canonicalPolicyContent(p.PolicyDocument),
      `Inline role policy contents drift: ${name}/${p.PolicyName}.`);
    }
    results.push({ roleName: name, boundaryArn: props.PermissionsBoundary ?? null,
      arnMatches: true, boundaryMatches: true, trustMatches: true, tagsMatch: true, inlinePolicyMatches: true, attachedPoliciesMatch: true });
  }
  return { required: true, status: 'passed', source: 'synthesized-cdk-template',
    templateSha256: createHash('sha256').update(bytes).digest('hex'), supportingTemplates, roles: results, managedPolicies: [...managed.values()] };
}
