import {GetItemCommand} from '@aws-sdk/client-dynamodb';
const exact=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
const text=(v,max,optional=false)=>typeof v==='string'&&v.length<=max&&(optional||v.length>0)&&v===v.trim()&&!/[\u0000-\u001f\u007f]/.test(v);
const time=v=>typeof v==='string'&&Number.isFinite(Date.parse(v))&&new Date(v).toISOString()===v;
const positive=v=>Number.isSafeInteger(v)&&v>0;
export function validateAlertCatalog(v){
 const bad=()=>{throw new TypeError('Invalid alert configuration catalog')};
 if(!exact(v,['schemaVersion','revision','domainId','updatedAt','policies'])||v.schemaVersion!==1||!positive(v.revision)||v.domainId!=='platform'||!time(v.updatedAt)||!Array.isArray(v.policies)||v.policies.length>100)bad();
 const ids=new Set();
 for(const p of v.policies){
  if(!exact(p,['id','name','metric','threshold','severity','owner','runbook','raci','version','enabled','createdAt'])||!text(p.id,64)||!/^[a-z][a-z0-9-]{0,63}$/.test(p.id)||ids.has(p.id)||!text(p.name,200)||!text(p.metric,200)||!text(p.threshold,500)||!['SEV1','SEV2','SEV3'].includes(p.severity)||!text(p.owner,200,true)||!text(p.runbook,500,true)||!exact(p.raci,['responsible','accountable','consulted','informed'])||Object.values(p.raci).some(x=>!text(x,200,true))||!positive(p.version)||typeof p.enabled!=='boolean'||!time(p.createdAt)||p.createdAt>v.updatedAt)bad();ids.add(p.id);
 }
 const encoded=JSON.stringify(v);if(Buffer.byteLength(encoded)>128*1024)bad();return JSON.parse(encoded);
}
export function buildAlertCatalogItem(v){const c=validateAlertCatalog(v);return {pk:{S:'ALERT_POLICY#platform'},sk:{S:'CATALOG'},entityType:{S:'ALERT_POLICY_CATALOG'},document:{S:JSON.stringify(c)}}}
export function createAlertCatalogReader({tableName,dynamo}){
 return async()=>{const r=await dynamo.send(new GetItemCommand({TableName:tableName,Key:{pk:{S:'ALERT_POLICY#platform'},sk:{S:'CATALOG'}},ConsistentRead:true}));if(!r||typeof r!=='object'||Array.isArray(r))throw Error('Invalid read');if(r.Item===undefined)return null;
 const i=r.Item;if(!exact(i,['pk','sk','entityType','document'])||!['pk','sk','entityType','document'].every(k=>exact(i[k],['S']))||i.pk?.S!=='ALERT_POLICY#platform'||i.sk?.S!=='CATALOG'||i.entityType?.S!=='ALERT_POLICY_CATALOG'||typeof i.document?.S!=='string'||Buffer.byteLength(i.document.S)>128*1024)throw Error('Invalid stored catalog');return validateAlertCatalog(JSON.parse(i.document.S));};
}
