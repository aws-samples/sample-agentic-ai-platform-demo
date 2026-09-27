import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

test('HITL source route uses existing JWT Governance integration, GET only', () => {
  const source = readFileSync(new URL('../lib/platform-web-stack.ts', import.meta.url), 'utf8');
  const start = source.lastIndexOf('for (const [constructId, routeKey]', source.indexOf('"GovernanceHitlPolicyReadRoute"'));
  const end = source.indexOf('for (const [constructId, routeKey]', source.indexOf('"GovernanceHitlPolicyReadRoute"'));
  const routes = source.slice(start, end);
  assert.match(routes, /"GovernanceHitlPolicyReadRoute",\s*"GET \/api\/hitl"/);
  assert.match(routes, /authorizationType: "JWT"/);
  assert.match(routes, /authorizerId: authorizer.ref/);
  assert.match(routes, /governanceIntegration.ref/);
  assert.doesNotMatch(source, /"(?:POST|PUT|PATCH|DELETE) \/api\/hitl/);
});

test('HITL source includes exact GET invocation permission and read-only partition IAM', () => {
  const source = readFileSync(new URL('../lib/platform-web-stack.ts', import.meta.url), 'utf8');
  assert.match(source, /\["AllowGovernanceHitlPolicyReadInvoke", "GET", "hitl"\]/);
  const role = source.slice(source.indexOf('const governanceRole ='), source.indexOf('const governanceFunction ='));
  const statements = role.split('new iam.PolicyStatement(').filter(s => s.includes('HITL_POLICY#*'));
  assert.equal(statements.length, 1);
  assert.match(statements[0], /actions: \["dynamodb:GetItem"\]/);
  assert.doesNotMatch(statements[0], /PutItem|UpdateItem|DeleteItem|Scan|Query/);
});
// The ceiling admits PutItem because the deployment seed initializes the
// catalog once (Custom::PlatformHitlCatalog, condition-checked create-only).
// Runtime read-only stays enforced where it belongs: the governance role's
// identity policy above, which this file asserts has no write actions.
test('HITL boundary ceiling is scoped to the HITL partition and admits no mutation beyond create',()=>{
 const boundary=JSON.parse(readFileSync(new URL('../config/runtime-permissions-boundary.json',import.meta.url),'utf8'));
 const matches=boundary.Statement.filter(s=>JSON.stringify(s.Condition||{}).includes('HITL_POLICY#*'));
 assert.equal(matches.length,1);
 assert.deepEqual(matches[0].Action,['dynamodb:GetItem','dynamodb:PutItem']);
 assert.deepEqual(matches[0].Resource,['${PLATFORM_STATE_TABLE_ARN}']);
 assert.doesNotMatch(JSON.stringify(matches[0].Action),/UpdateItem|DeleteItem|Scan|Query/);
});
