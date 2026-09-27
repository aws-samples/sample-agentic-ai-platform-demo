import { createHash } from 'node:crypto';
import { validateAlertCatalog } from '../workspace/alert-policies.mjs';
import { capabilitiesForRole } from '../authz/capabilities.mjs';
const route = 'POST /api/governance/alert-drafts';
const exact = (v,keys) => v && typeof v==='object' && !Array.isArray(v) && Object.keys(v).length===keys.length && keys.every(k=>Object.hasOwn(v,k));
const canonical = v => Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
const positive = n => Number.isSafeInteger(n)&&n>0;
export function createAlertDraftWriter({state,validateIdentity,fail}) {
 return async input => {
  if(!exact(input,['identity','requestId','operation','expectedRevision','expectedPolicyVersion','policy','reason']))fail('INVALID_REQUEST');
  const identity=validateIdentity(input.identity),domainId=identity.activeDomain??'platform';
  if(identity.role!=='admin'||!capabilitiesForRole(identity.role).includes('manageAlertPolicies')||domainId!=='platform'||!identity.domainIds.includes(domainId))fail('FORBIDDEN');
  if(!['create','update'].includes(input.operation)||!(Number.isSafeInteger(input.expectedRevision)&&input.expectedRevision>=0)
   ||!(input.operation==='create'?input.expectedPolicyVersion===null:positive(input.expectedPolicyVersion))
   ||typeof input.requestId!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/.test(input.requestId)
   ||typeof input.reason!=='string'||input.reason!==input.reason.trim()||input.reason.length<10||input.reason.length>1024||/[\u0000-\u001f\u007f]/.test(input.reason)
   ||!exact(input.policy,['id','name','metric','threshold','severity','owner','runbook','raci']))fail('INVALID_REQUEST');
  const payload={operation:input.operation,expectedRevision:input.expectedRevision,expectedPolicyVersion:input.expectedPolicyVersion,policy:input.policy,reason:input.reason};
  const fingerprint=createHash('sha256').update(JSON.stringify(canonical(payload))).digest('hex');
  const resourceKey=`alert-policy/platform/${input.policy.id}`;
  const operation=input.operation==='create'?'CREATE':'UPDATE';
  const lookup=async()=>{
   let saved;try{saved=await state.getMutationResult({actor:identity.actor,route,requestId:input.requestId})}catch{fail('WORKSPACE_UNAVAILABLE')}
   if(saved===null)return null;
   if(saved.actor!==identity.actor||saved.requesterSubject!==identity.actor||saved.effectiveRole!==identity.role||saved.domainId!=='platform'||saved.projectId!==null||saved.route!==route||saved.requestId!==input.requestId||saved.payloadFingerprint!==fingerprint||saved.result?.entityType!=='ALERT_POLICY'||saved.result.resourceKey!==resourceKey||saved.result.operation!==operation||saved.result.status!=='SUCCEEDED'||saved.reason!==input.reason||saved.decision!=='save_draft')fail('CONFLICT');
   return saved;
  };
  const read=async()=>{try{const c=await state.readAlertPolicyCatalog();return c===null?null:validateAlertCatalog(c)}catch{fail('WORKSPACE_UNAVAILABLE')}};
  const replay=await lookup();const catalog=await read();
  if(replay)return {saved:true,replayed:true,savedRevision:input.expectedRevision+1,policyId:input.policy.id,catalog,evaluation:'NOT_CONFIGURED',delivery:'NOT_CONFIGURED'};
  if((catalog?.revision??0)!==input.expectedRevision)fail('CONFLICT');
  const index=(catalog?.policies??[]).findIndex(p=>p.id===input.policy.id),prior=catalog?.policies[index];
  if(input.operation==='create'?index!==-1:!prior||prior.enabled!==false||prior.version!==input.expectedPolicyVersion)fail('CONFLICT');
  let clock;try{clock=state.beginTransaction()}catch{fail('WORKSPACE_UNAVAILABLE')}
  const policy={...input.policy,version:prior?prior.version+1:1,enabled:false,createdAt:prior?.createdAt??clock.timestamp};
  const policies=[...(catalog?.policies??[])];if(prior)policies[index]=policy;else policies.push(policy);
  let next;try{next=validateAlertCatalog({schemaVersion:1,domainId:'platform',revision:(catalog?.revision??0)+1,updatedAt:clock.timestamp,policies},'platform')}catch{fail('INVALID_REQUEST')}
  const mutation={actor:identity.actor,requesterSubject:identity.actor,effectiveRole:identity.role,domainId:'platform',projectId:null,route,requestId:input.requestId,payloadFingerprint:fingerprint,result:{entityType:'ALERT_POLICY',resourceKey,operation,status:'SUCCEEDED'},decision:'save_draft',reason:input.reason,timestamp:clock.timestamp,createdAt:clock.timestamp};
  try{await state.replaceAlertPolicyCatalog({catalog:next,expectedCatalog:catalog,mutation,transaction:clock})}
  catch(error){if(error?.code==='MUTATION_CONFLICT'){
    if(await lookup())return {saved:true,replayed:true,savedRevision:next.revision,policyId:policy.id,catalog:await read(),evaluation:'NOT_CONFIGURED',delivery:'NOT_CONFIGURED'};
    fail('CONFLICT');
   }fail('WORKSPACE_UNAVAILABLE')}
  return {saved:true,replayed:false,savedRevision:next.revision,policyId:policy.id,catalog:next,evaluation:'NOT_CONFIGURED',delivery:'NOT_CONFIGURED'};
 };
}

export function createAlertCatalogRead({state,validateIdentity,fail}){
 return async input=>{
  if(!exact(input,['identity']))fail('INVALID_REQUEST');const identity=validateIdentity(input.identity);
  if(identity.role!=='admin'||!capabilitiesForRole(identity.role).includes('manageAlertPolicies')||(identity.activeDomain??'platform')!=='platform'||!identity.domainIds.includes('platform'))fail('FORBIDDEN');
  let catalog;try{catalog=await state.readAlertPolicyCatalog();if(catalog!==null)catalog=validateAlertCatalog(catalog)}catch{fail('WORKSPACE_UNAVAILABLE')}
  return {schemaVersion:1,domainId:'platform',source:'workspace-alert-policy-catalog',configured:catalog!==null,revision:catalog?.revision??0,updatedAt:catalog?.updatedAt??null,policies:catalog?.policies??[],cursor:null,evaluation:'NOT_CONFIGURED',delivery:'NOT_CONFIGURED'};
 };
}
