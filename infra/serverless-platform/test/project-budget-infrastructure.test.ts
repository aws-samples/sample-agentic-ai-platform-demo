import assert from 'node:assert/strict';
import test from 'node:test';
import * as cdk from 'aws-cdk-lib';
import {Template} from 'aws-cdk-lib/assertions';
import {PlatformWebStack} from '../lib/platform-web-stack';
import {PLATFORM_WEB_RUNTIME_ROLE_NAMES} from '../lib/config';

test('project budget endpoints retain JWT and exact Operations invocation grants', () => {
 const stack = new PlatformWebStack(new cdk.App(),'BudgetRouteTest',{
  env:{account:'111122223333',region:'us-west-2'},cognitoDomainPrefix:'synthetic-budget-test',
  llmGatewayId:'test-gateway-abcdefghij',llmGatewayRegion:'us-west-2',
  starterBuilderModelId:'bedrock-claude/anthropic.claude-haiku-4-5',
 });
 const t=Template.fromStack(stack);
 const routes=Object.values(t.findResources('AWS::ApiGatewayV2::Route')) as any[];
 const permissions=Object.values(t.findResources('AWS::Lambda::Permission')) as any[];
 for(const [method,path] of [['GET','operations/project-budgets'],['POST','operations/project-budgets'],['POST','operations/project-budgets/evaluate']]){
  const route=routes.find(r=>r.Properties.RouteKey===`${method} /api/${path}`);
  assert.ok(route,`missing budget route ${method} ${path}`);
  assert.equal(route.Properties.AuthorizationType,'JWT');assert.ok(route.Properties.AuthorizerId);
  assert.match(JSON.stringify(route.Properties.Target),/OperationsLambdaIntegration/);
  assert.ok(permissions.some(r=>JSON.stringify(r.Properties.SourceArn ?? null).includes(`/*/${method}/api/${path}`)
    && JSON.stringify(r.Properties.FunctionName).includes('OperationsApiFunction')));
 }
 const roles=Object.values(t.findResources('AWS::IAM::Role')) as any[];
 const ops=roles.find(r=>r.Properties.RoleName===PLATFORM_WEB_RUNTIME_ROLE_NAMES.operationsApi);
 assert.ok(ops,'Operations role exists');
 const policies=t.findResources('AWS::IAM::ManagedPolicy');
 const entry=Object.entries(policies).find(([,p]:any)=>p.Properties.ManagedPolicyName==='AgenticPlatform-Web-OperationsBoundary');
 assert.ok(entry,'dedicated Operations boundary');
 const [boundaryId,boundary]=entry as [string,any];
 assert.match(JSON.stringify(ops.Properties.PermissionsBoundary),new RegExp(boundaryId));
 const ceiling=boundary.Properties.PolicyDocument;
 assert.ok(JSON.stringify(ceiling).length<=6144);
 const ceilingActions=ceiling.Statement.flatMap((s:any)=>Array.isArray(s.Action)?s.Action:[s.Action]);
 assert.ok(!ceilingActions.some((a:string)=>/^(iam:|sts:|bedrock:)/.test(a)));
 const statements=ops.Properties.Policies.flatMap((p:any)=>p.PolicyDocument.Statement);
 for(const s of statements){
  for(const a of (Array.isArray(s.Action)?s.Action:[s.Action])) assert.ok(ceilingActions.includes(a),`boundary missing ${a}`);
 }
 for(const [id,role] of Object.entries(t.findResources('AWS::IAM::Role')) as [string,any][]){
  if(role.Properties.RoleName!==PLATFORM_WEB_RUNTIME_ROLE_NAMES.operationsApi) assert.ok(!JSON.stringify(role.Properties.PermissionsBoundary??null).includes(boundaryId),`budget ceiling leaked to ${id}`);
 }
 const budgetStatements=statements.filter((s:any)=>JSON.stringify(s.Condition??{}).includes('PROJECT_BUDGET#*'));
 const actions=budgetStatements.flatMap((s:any)=>Array.isArray(s.Action)?s.Action:[s.Action]);
 for(const action of ['dynamodb:GetItem','dynamodb:Query','dynamodb:PutItem','dynamodb:ConditionCheckItem']){
  assert.ok(actions.includes(action),`budget action missing: ${action}`);
 }
 for(const s of budgetStatements){
  assert.deepEqual(s.Condition['ForAllValues:StringLike']['dynamodb:LeadingKeys'],['PROJECT_BUDGET#*']);
  assert.ok(!JSON.stringify(s.Resource).includes('/index/'));
  assert.notEqual(s.Resource,'*');
 }
});
