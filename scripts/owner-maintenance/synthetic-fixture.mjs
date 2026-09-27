import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { OWNER, ROLE, POLICY, GATEWAYS, STATEMENT } from './gateway-profile-read.mjs';

// Synthetic identifiers only, split to avoid contaminating account-leak scanners.
export function fixture() {
  const account = '9988' + '77665544';
  const physicalRole = 'synthetic-shared-gateway-role';
  const role = {
    Type: 'AWS::IAM::Role',
    Properties: {
      Description: 'Synthetic shared Gateway role',
      AssumeRolePolicyDocument: {
        Version: '2012-10-17',
        Statement: [{ Effect: 'Allow', Principal: { Service: 'bedrock-agentcore.amazonaws.com' },
          Action: 'sts:AssumeRole', Condition: { StringEquals: { 'aws:SourceAccount': { Ref: 'AWS::AccountId' } } } }],
      },
    },
  };
  // Intentionally retain a synthetic pre-existing wildcard: the delta must not
  // rewrite, extend or endorse legacy grants, including their statement order.
  const document = { Version: '2012-10-17', Statement: [
    { Effect: 'Allow', Action: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'], Resource: '*' },
    { Sid: 'ExistingDeny', Effect: 'Deny', Action: 'bedrock:DeleteCustomModel', Resource: '*' },
  ] };
  return {
    owner: {
      stackId: `arn:aws:cloudformation:us-west-2:${account}:stack/${OWNER}/00000000-0000-0000-0000-000000000001`,
      roleLogicalId: ROLE, policyLogicalId: POLICY, rolePhysicalId: physicalRole,
      roleResource: structuredClone(role),
      gateways: Object.fromEntries(GATEWAYS.map(id => [id, `arn:aws:iam::${account}:role/${physicalRole}`])),
    },
    template: {
      AWSTemplateFormatVersion: '2010-09-09',
      Description: 'SYNTHETIC MINIMAL FIXTURE. NEVER DEPLOY.',
      Resources: {
        [ROLE]: role,
        [POLICY]: { Type: 'AWS::IAM::Policy', Properties: {
          PolicyName: POLICY, Roles: [{ Ref: ROLE }], PolicyDocument: structuredClone(document),
        } },
        ...Object.fromEntries(GATEWAYS.map(id => [id, { Type: 'AWS::BedrockAgentCore::Gateway',
          Properties: { Name: `synthetic-${id}`, RoleArn: { 'Fn::GetAtt': [ROLE, 'Arn'] } } }])),
        Unrelated: { Type: 'AWS::SSM::Parameter', Properties: { Type: 'String', Value: 'synthetic-unchanged' } },
      },
      Outputs: { Unchanged: { Value: 'synthetic-output' } },
    },
    actualPolicy: { RoleName: physicalRole, PolicyName: POLICY, PolicyDocument: document },
    profileArn: `arn:aws:bedrock:us-west-2:${account}:inference-profile/global.openai.gpt-6-astra`,
    proposedStatement: structuredClone(STATEMENT),
  };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  console.log(JSON.stringify(fixture(), null, 2));
}
