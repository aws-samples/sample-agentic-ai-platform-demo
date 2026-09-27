import {execFileSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {CognitoIdentityProviderClient, AdminGetUserCommand, AdminListGroupsForUserCommand} from '@aws-sdk/client-cognito-identity-provider';
import {DynamoDBClient} from '@aws-sdk/client-dynamodb';
import {createWorkspaceState} from '../lambda/workspace/state.mjs';
import {parsePrivateSelection, readPrivateStdin} from './reconcile-demo-operator.mjs';

export const DEMO_WORKSPACES = Object.freeze([
  ['customer_support','case-assist','case-resolution-agent'],
  ['customer_support','concierge','customer-concierge-agent'],
  ['customer_support','supportdesk','support-desk-agent'],
  ['operations','incident-triage','incident-triage-agent'],
  ['operations','report-runner','operations-report-agent'],
].map(([domainId,projectId,agentId])=>Object.freeze({domainId,projectId,agentId})));
const fail=()=>{throw new Error('Demo workspace initialization preflight failed. Verify enabled demo administrators and active deployment-owned starter projects/agents.');};

// Operator bootstrap only. Never called by an application request or ordinary builder.
export async function initializeDemoWorkspaces({usernames,verifyOperator,state,apply=false}) {
  if(!Array.isArray(usernames)||!usernames.length||usernames.length>100||new Set(usernames).size!==usernames.length)fail();
  const subjects=[];
  for(const username of usernames){
    const subject=await verifyOperator(username);
    if(typeof subject!=='string'||!/^[a-zA-Z0-9][a-zA-Z0-9._:@/-]{0,255}$/.test(subject)||subjects.includes(subject))fail();
    subjects.push(subject);
  }
  const plan=[];let memoryBindings=0;let knowledgeBaseBindings=0;
  for(const workspace of DEMO_WORKSPACES){
    const {domainId,projectId,agentId}=workspace;
    const project=await state.getProject({domainId,projectId});
    const agent=await state.getAgent({domainId,projectId,agentId});
    if(!project||project.domainId!==domainId||project.id!==projectId||project.status!=='ACTIVE'
      ||project.ownerSubject!=='deployment:baseline'||project.createdBySubject!=='deployment:baseline'
      ||!Array.isArray(project.memberSubjects)||!agent||agent.domainId!==domainId||agent.projectId!==projectId||agent.id!==agentId)fail();
    const missing=subjects.filter(subject=>!project.memberSubjects.includes(subject));
    if(project.memberSubjects.length+missing.length>100)fail();
    plan.push({domainId,projectId,missing});
    memoryBindings+=(agent.memoryIds||[]).length;
    knowledgeBaseBindings+=(agent.knowledgeBaseIds||[]).length;
  }
  const plannedGrants=plan.reduce((n,p)=>n+p.missing.length,0);
  let changed=0;
  // Existing state writer uses conditional updates, preserving concurrent membership edits.
  // Partial failures are retryable: existing grants are no-ops, never rolled back over others.
  if(apply){
    for(const p of plan)for(const subject of p.missing){
      const result=await state.addProjectMember({domainId:p.domainId,projectId:p.projectId,subject});
      if(result.changed)changed++;
    }
    for(const p of plan){
      const project=await state.getProject({domainId:p.domainId,projectId:p.projectId});
      if(!project||subjects.some(subject=>!project.memberSubjects.includes(subject)))fail();
    }
  }
  return {mode:apply?'applied':'plan',operators:subjects.length,projects:plan.length,agents:plan.length,plannedGrants,changed,memoryBindings,knowledgeBaseBindings};
}

export async function runCli({argv=process.argv.slice(2),env=process.env,stdin=process.stdin}={}) {
  if(argv.length>1||(argv.length===1&&argv[0]!=='--apply'))throw new Error('Usage: initialize-demo-workspaces.mjs [--apply]');
  if(!/^\d{12}$/.test(env.AWS_ACCOUNT_ID||'')||env.AWS_REGION!=='us-west-2')throw new Error('Set AWS_ACCOUNT_ID and AWS_REGION=us-west-2 for the intended deployment.');
  const selection=parsePrivateSelection(await readPrivateStdin(stdin));
  const aws=(args)=>JSON.parse(execFileSync('aws',[...args,'--region',env.AWS_REGION,'--output','json'],{encoding:'utf8',timeout:20000,maxBuffer:1024*1024,stdio:['ignore','pipe','pipe']}));
  const caller=aws(['sts','get-caller-identity']);
  if(caller.Account!==env.AWS_ACCOUNT_ID||caller.Arn.endsWith(':root'))throw new Error('AWS caller does not match the intended non-root deployment account.');
  const stackName=env.PLATFORM_WEB_STACK_NAME||'AgenticPlatform-Web';
  if(!/^[A-Za-z][A-Za-z0-9-]{0,127}$/.test(stackName))throw new Error('Invalid Web stack name.');
  const stack=aws(['cloudformation','describe-stacks','--stack-name',stackName]).Stacks?.[0];
  if(!stack||!['CREATE_COMPLETE','UPDATE_COMPLETE'].includes(stack.StackStatus)||!stack.StackId.includes(':'+env.AWS_ACCOUNT_ID+':'))throw new Error('Target Web stack is not ready.');
  const outputs=Object.fromEntries(stack.Outputs.map(x=>[x.OutputKey,x.OutputValue]));
  const pool=outputs.UserPoolId,tableName=outputs.PlatformStateTableName;
  if(!/^us-west-2_[A-Za-z0-9]+$/.test(pool||'')||!tableName)throw new Error('Web stack outputs are incomplete.');
  const config={region:env.AWS_REGION,ignoreConfiguredEndpointUrls:true};
  const cognito=new CognitoIdentityProviderClient(config),dynamo=new DynamoDBClient(config);
  const verifyOperator=async(username)=>{
    const user=await cognito.send(new AdminGetUserCommand({UserPoolId:pool,Username:username}),{abortSignal:AbortSignal.timeout(20000)});
    if(user.Username!==username||!user.Enabled||user.UserStatus!=='CONFIRMED')fail();
    const groups=new Set();let cursor;const seen=new Set();
    do{
      const page=await cognito.send(new AdminListGroupsForUserCommand({UserPoolId:pool,Username:username,...(cursor?{NextToken:cursor}:{})}),{abortSignal:AbortSignal.timeout(20000)});
      for(const g of page.Groups||[])groups.add(g.GroupName);
      cursor=page.NextToken;if(cursor&&(seen.has(cursor)||seen.size>=100))fail();if(cursor)seen.add(cursor);
    }while(cursor);
    if(!groups.has('platform-admin')||!groups.has('demo-operator')||['domain-lead','domain-builder','end-user'].some(g=>groups.has(g)))fail();
    return user.UserAttributes?.find(a=>a.Name==='sub')?.Value;
  };
  try{
    const state=createWorkspaceState({tableName,dynamo,now:()=>new Date()});
    return await initializeDemoWorkspaces({usernames:selection.usernames,verifyOperator,state,apply:argv.includes('--apply')});
  }finally{cognito.destroy();dynamo.destroy();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  runCli().then(result=>console.log(JSON.stringify(result))).catch(()=>{
    console.error('Demo workspace initialization failed. Verify target/selection and rerun the plan. Any completed grants are retained; rerunning safely completes remaining grants.');process.exitCode=1;
  });
}
