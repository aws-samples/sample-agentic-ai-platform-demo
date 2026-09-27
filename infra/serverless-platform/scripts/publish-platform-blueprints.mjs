/** Publish the repository's reviewed baseline templates into an existing shared Registry.
 * New immutable versions only; never edits/deletes an existing version or approves
 * third-party submissions. Dry-run is the default. The account and Registry are
 * discovered and checked before writes, and --apply requires the saved plan hash.
 */
import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {readFile,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {STSClient,GetCallerIdentityCommand} from '@aws-sdk/client-sts';
import {AgentRegistryControlClient,ListRegistryRecordsCommand,GetRegistryRecordCommand,CreateRegistryRecordCommand,SubmitRegistryRecordForApprovalCommand,UpdateRegistryRecordStatusCommand} from '@aws-sdk/client-agent-registry-control';
// The Registry CDK package is CommonJS. Use its runtime exports instead of
// relying on Node's version-dependent synthetic named-export discovery.
const {buildSeedRecords}=createRequire(import.meta.url)('../../platform-registry/bin/app.ts');
const root=fileURLToPath(new URL('../../../',import.meta.url));
const tags={'auto-delete':'no',project:'agentic-ai-platform-demo',managedBy:'cdk'};
const hash=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const descriptor=r=>JSON.parse(r.descriptors.custom.data??r.descriptors.custom.inlineContent);
export function planBlueprintRelease(seeds,existing,{scope='shared'}={}){
 if(!['shared','platform'].includes(scope))throw new Error('Unsupported baseline scope.');
 return seeds.filter(s=>s.registryRef==='shared'&&s.recordType==='CUSTOM').flatMap(original=>{
  const seed=structuredClone(original);
  if(scope==='platform'){
   const data=descriptor(seed);
   const related=existing.filter(r=>r.recordType==='CUSTOM'&&descriptor(r).blueprintId===data.blueprintId);
   // Only repair existing repository baseline copies. Never add another
   // platform catalog or replace a user-submitted blueprint with a seed.
   if(!related.length)return [];
   const legacy=related.find(r=>r.recordVersion==='1.0.0');
   const legacyData=legacy&&descriptor(legacy);
   if(!legacyData||legacyData.git?.repo!=='github.com/aws-samples/sample-agentic-ai-platform-demo'
     ||legacyData.git?.path!==`blueprints/${data.blueprintId}`
     ||!['blueprint_'+data.blueprintId,'blueprint_'+data.blueprintId.replaceAll('-','_')].includes(legacy.name)){
    throw new Error(`Existing platform blueprint is not a recognized repository baseline: ${data.blueprintId}`);
   }
   data['x-platform']={...data['x-platform'],domainId:'platform',shared:false};
   seed.descriptors={custom:{data:JSON.stringify(data)}};
  }
  const data=descriptor(seed); const related=existing.filter(r=>r.recordType==='CUSTOM'&&descriptor(r).blueprintId===data.blueprintId);
  const names=[...new Set(related.map(r=>r.name))];
  if(names.length>1)throw new Error(`Ambiguous blueprint identity: ${data.blueprintId}`);
  // Legacy seeds used hyphens; keep their Registry/name identity so existing
  // domain allowlists and grants continue to refer to the same logical resource.
  const name=names[0]??seed.name;
  const same=related.filter(r=>r.recordVersion===seed.version);
  if(same.length>1)throw new Error(`Duplicate blueprint version: ${name}`);
  if(same.length&&(!isDeepStrictEqual(descriptor(same[0]),data)||same[0].recordType!==seed.recordType))throw new Error(`Immutable blueprint version conflict: ${name}`);
  if(same.length&&same[0].status!=='APPROVED')throw new Error(`Existing version needs its original publication workflow: ${name}`);
  return {action:same.length?'UNCHANGED':'CREATE_APPROVED_BASELINE',recordId:same[0]?.recordId??null,
   desired:{name,displayName:seed.displayName,description:seed.description,recordType:seed.recordType,recordVersion:seed.version,descriptors:seed.descriptors}};
 });
}
async function main(){
 const account=process.env.AWS_ACCOUNT_ID, region=process.env.AWS_REGION;
 if(!/^\d{12}$/.test(account||'')||region!=='us-west-2')throw new Error('Set verified AWS_ACCOUNT_ID and AWS_REGION=us-west-2.');
 const caller=await new STSClient({region}).send(new GetCallerIdentityCommand({}));
 if(caller.Account!==account||caller.Arn.endsWith(':root'))throw new Error('Deployment identity does not match the target.');
 const stackName=process.env.CONTROL_PLANE_STACK_NAME||'AgenticPlatform-ControlPlane';
 const stack=JSON.parse(execFileSync('aws',['cloudformation','describe-stacks','--stack-name',stackName,'--region',region,'--output','json'],{encoding:'utf8'})).Stacks[0];
 if(!/^(CREATE|UPDATE)_COMPLETE$/.test(stack.StackStatus)||!stack.StackId.includes(`:${account}:`))throw new Error('Control plane is not ready in this account.');
 for(const [Key,Value] of Object.entries(tags))if(!stack.Tags.some(t=>t.Key===Key&&t.Value===Value))throw new Error('Control-plane ownership tags do not match.');
 const scope=process.env.BLUEPRINT_RELEASE_SCOPE||'shared';
 if(!['shared','platform'].includes(scope))throw new Error('BLUEPRINT_RELEASE_SCOPE must be shared or platform.');
 const registryId=stack.Outputs.find(o=>o.OutputKey===(scope==='shared'?'SharedRegistryId':'RegistryPlatformId'))?.OutputValue;
 if(!/^[A-Za-z0-9]{12,16}$/.test(registryId||''))throw new Error('Target Registry output is missing.');
 const registry=new AgentRegistryControlClient({region});const summaries=[];let nextToken;const seen=new Set();
 do{const r=await registry.send(new ListRegistryRecordsCommand({registryId,nextToken}));summaries.push(...r.registryRecords);nextToken=r.nextToken;if(nextToken&&(seen.has(nextToken)||seen.size>=20))throw new Error('Registry pagination is incomplete.');seen.add(nextToken);}while(nextToken);
 const existing=[];for(const r of summaries.filter(r=>r.recordType==='CUSTOM'))existing.push(await registry.send(new GetRegistryRecordCommand({registryId,recordId:r.recordId})));
 const catalog=JSON.parse(await readFile(root+'console/catalog.json','utf8'));const seed=JSON.parse(await readFile(root+'console/registry-seed.json','utf8'));
 const records=planBlueprintRelease(buildSeedRecords(seed,catalog),existing,{scope});
 const manifest={account,region,registryId,scope,sourceCommit:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),records};
 const plan={...manifest,hash:hash(manifest)};
 const output=process.env.BLUEPRINT_RELEASE_PLAN_FILE;
 if(!output)throw new Error('BLUEPRINT_RELEASE_PLAN_FILE is required.');
 if(!process.argv.includes('--apply')){await writeFile(output,JSON.stringify(plan,null,2));console.log(`Reviewed baseline release plan: ${records.length} templates; ${records.filter(r=>r.action!=='UNCHANGED').length} new versions. Plan: ${output}`);return;}
 const reviewed=JSON.parse(await readFile(output,'utf8'));
 if(reviewed.hash!==plan.hash)throw new Error('Registry or repository changed since the plan. Regenerate and review it.');
 const evidence=[];
 for(const record of records){
  if(record.action==='UNCHANGED'){evidence.push({name:record.desired.name,recordId:record.recordId,status:'UNCHANGED'});continue;}
  const created=await registry.send(new CreateRegistryRecordCommand({registryId,...record.desired,tags,clientToken:hash({registryId,desired:record.desired})}));
  const recordId=created.recordArn?.split('/record/')[1];if(!recordId)throw new Error('Registry returned no record identity.');
  let approved=false;
  for(let attempt=0;attempt<90;attempt++){
   const current=await registry.send(new GetRegistryRecordCommand({registryId,recordId}));
   if(current.name!==record.desired.name||current.recordVersion!==record.desired.recordVersion||!isDeepStrictEqual(descriptor(current),descriptor(record.desired)))throw new Error('Created record identity/content mismatch.');
   if(current.status==='APPROVED'){approved=true;break;}
   if(current.status==='DRAFT')await registry.send(new SubmitRegistryRecordForApprovalCommand({registryId,recordId}));
   else if(current.status==='PENDING_APPROVAL')await registry.send(new UpdateRegistryRecordStatusCommand({registryId,recordId,status:'APPROVED',statusReason:`Repository baseline template release ${manifest.sourceCommit}; reviewed plan ${plan.hash}`}));
   else if(!['CREATING','UPDATING'].includes(current.status))throw new Error(`Unexpected record state: ${current.status}`);
   await new Promise(resolve=>setTimeout(resolve,2000));
  }
  if(!approved)throw new Error('Registry publication did not finish within the polling window.');
  evidence.push({name:record.desired.name,recordId,version:record.desired.recordVersion,status:'APPROVED'});
  await writeFile(output+'.result.json',JSON.stringify({account,region,registryId,planHash:plan.hash,evidence},null,2));
  console.log(`Published ${record.desired.name}@${record.desired.recordVersion}`);
 }
}
if(process.argv[1]===fileURLToPath(import.meta.url))await main();
