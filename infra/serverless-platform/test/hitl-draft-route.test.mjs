import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';
const source=readFileSync(new URL('../lib/platform-web-stack.ts',import.meta.url),'utf8');
const boundary=JSON.parse(readFileSync(new URL('../config/runtime-permissions-boundary.json',import.meta.url),'utf8'));
test('draft uses existing JWT governance route and exact POST invocation permission',()=>{
 assert.match(source,/\["GovernancePolicyDraftRoute", "POST \/api\/governance\/policy-drafts"\]/);
 assert.match(source,/\["AllowGovernancePolicyDraftInvoke", "POST", "governance\/policy-drafts"\]/);
 const routes=source.slice(source.indexOf('"GovernanceAgentPublicationRoute"'),source.indexOf('"OperationsAuditRoute"'));assert.match(routes,/authorizationType: "JWT"/);
});
test('governance role adds only exact platform HITL transactional put',()=>{
 const role=source.slice(source.indexOf('const governanceRole ='),source.indexOf('const governanceFunction ='));
 const statement=role.split('new iam.PolicyStatement(').find(s=>s.includes('"HITL_POLICY#platform"'));assert.ok(statement);assert.match(statement,/actions: \["dynamodb:PutItem"\]/);assert.match(statement,/"dynamodb:EnclosingOperation": \["TransactWriteItems"\]/);assert.doesNotMatch(statement,/HITL_POLICY#\*|DeleteItem|UpdateItem|Scan/);
 const write=boundary.Statement.find(s=>s.Sid==='WritePlatformState');assert.ok(write.Condition['ForAllValues:StringLike']['dynamodb:LeadingKeys'].includes('HITL_POLICY#platform'));assert.ok(!write.Condition['ForAllValues:StringLike']['dynamodb:LeadingKeys'].includes('HITL_POLICY#*'));
});
