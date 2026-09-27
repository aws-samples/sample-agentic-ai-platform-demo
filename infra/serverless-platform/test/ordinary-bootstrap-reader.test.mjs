// Existing production reader exercised with synthetic Dynamo transport only; no cloud calls.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {DynamoDBClient,QueryCommand} from '@aws-sdk/client-dynamodb';
import {createApiHandler} from '../lambda/api/index.mjs';
test('ordinary /me reuses bounded projected DOMAIN Query with existing identity IAM, no membership calls',async()=>{
 const previous=process.env.PLATFORM_STATE_TABLE_NAME,send=DynamoDBClient.prototype.send;const calls=[];
 process.env.PLATFORM_STATE_TABLE_NAME='synthetic-bootstrap-table';
 DynamoDBClient.prototype.send=async function(command,options){
  assert.ok(command instanceof QueryCommand);assert.ok(options.abortSignal);calls.push(command.input);
  return {Items:['alpha','beta','foreign'].map(id=>({pk:{S:'DOMAIN'},sk:{S:'DOMAIN#'+id},entityType:{S:'DOMAIN'},id:{S:id},name:{S:'Synthetic '+id},status:{S:'ACTIVE'}}))};
 };
 try{
  const h=createApiHandler({demoOperatorVerifier:()=>assert.fail('No demo/membership IO')});
  const r=await h({requestContext:{http:{method:'GET',path:'/api/me'},authorizer:{jwt:{claims:{sub:'synthetic-lead',token_use:'access','cognito:groups':['domain-lead','domain-alpha','domain-beta']}}}}});
  assert.equal(r.statusCode,200);assert.equal(JSON.parse(r.body).scopeStatus,'selection-required');assert.deepEqual(JSON.parse(r.body).domains,['alpha','beta']);
  assert.equal(calls.length,1);assert.equal(calls[0].TableName,'synthetic-bootstrap-table');assert.equal(calls[0].Select,'SPECIFIC_ATTRIBUTES');assert.equal(calls[0].ConsistentRead,true);assert.equal(calls[0].Limit,100);
  assert.deepEqual(calls[0].ExpressionAttributeValues,{':pk':{S:'DOMAIN'}});assert.equal(calls[0].ProjectionExpression,'#pk, #sk, #entityType, #id, #name, #status');
  const source=readFileSync(new URL('../lib/platform-web-stack.ts',import.meta.url),'utf8');const role=source.slice(source.indexOf('const identityRole ='),source.indexOf('const apiFunction ='));
  assert.match(role,/actions: \["dynamodb:Query"\]/);assert.match(role,/resources: \[platformStateTable.tableArn\]/);assert.match(role,/"dynamodb:LeadingKeys": \["DOMAIN"\]/);assert.match(role,/"dynamodb:Select": "SPECIFIC_ATTRIBUTES"/);
  for(const attribute of ['pk','sk','entityType','id','name','status'])assert.ok(role.includes('"'+attribute+'"'));
  assert.doesNotMatch(role,/dynamodb:(Scan|PutItem|UpdateItem|DeleteItem)|resources: \["\*"\]/);
 }finally{DynamoDBClient.prototype.send=send;if(previous===undefined)delete process.env.PLATFORM_STATE_TABLE_NAME;else process.env.PLATFORM_STATE_TABLE_NAME=previous;}
});
