import { PutItemCommand } from '@aws-sdk/client-dynamodb';
import { buildHitlCatalogInitialization, createHitlCatalogReader } from './hitl-policies.mjs';
import { sendCloudFormationResponse } from '../platform-admin/seed.mjs';

// Initialize configuration metadata only. Never adopt/replace policies or enable
// runtime enforcement. Existing valid catalogs and Delete events are retained.
export async function reconcileHitlCatalog(event, dynamo, now = () => new Date().toISOString(), sleep = ms => new Promise(r => setTimeout(r, ms))) {
  const p = event.ResourceProperties;
  const id = `platform-hitl-catalog:${p?.TableName}:platform`;
  if (!p || Object.keys(p).some(k => !['ServiceToken','ServiceTimeout','TableName','InitializationVersion'].includes(k))
    || !/^[A-Za-z0-9_.-]{3,255}$/.test(p.TableName || '') || ![1, "1"].includes(p.InitializationVersion)) throw Error('Invalid catalog initialization');
  if (event.RequestType !== 'Create' && event.PhysicalResourceId !== id) throw Error('Catalog initialization identity mismatch');
  if (event.RequestType === 'Delete') return {PhysicalResourceId:id};
  if (!['Create','Update'].includes(event.RequestType)) throw Error('Invalid operation');
  if (event.RequestType === 'Update' && event.OldResourceProperties?.TableName !== p.TableName) throw Error('Catalog table cannot change');
  // IAM role inline policy is in the same CFN resource; allow bounded
  // propagation lag without broadening access or replaying unchecked writes.
  const client = { async send(command) {
    for (let attempt=0;attempt<6;attempt++) {
      try { return await dynamo.send(command, {abortSignal:AbortSignal.timeout(8000)}); }
      catch(error) { if(error.name!=='AccessDeniedException'||attempt===5)throw error;await sleep(1500); }
    }
  }};
  const read = createHitlCatalogReader({tableName:p.TableName,dynamo:client});
  if (await read({domainId:'platform'}) !== null) return {PhysicalResourceId:id,Data:{Created:false}};
  const catalog={schemaVersion:1,revision:1,domainId:'platform',updatedAt:now(),policies:[]};
  try { await client.send(new PutItemCommand(buildHitlCatalogInitialization({tableName:p.TableName,catalog}))); }
  catch(error) {
    if(error.name!=='ConditionalCheckFailedException'||await read({domainId:'platform'})===null)throw error;
    return {PhysicalResourceId:id,Data:{Created:false}};
  }
  return {PhysicalResourceId:id,Data:{Created:true}};
}
export async function handleHitlCatalogSeed(event, context, dynamo, send = sendCloudFormationResponse, log = console.error) {
  let result;
  try { result=await reconcileHitlCatalog(event,dynamo); }
  catch(error) {
    // Log a safe classification, never the CFN event/response URL or SDK text.
    const category = ['Invalid catalog initialization','Catalog initialization identity mismatch','Invalid operation','Catalog table cannot change'].includes(error.message) ? 'INVALID_INITIALIZATION_CONTRACT' : error.name === 'AccessDeniedException' ? 'CATALOG_ACCESS_DENIED' : 'CATALOG_READ_OR_WRITE_FAILED';
    log(JSON.stringify({event:'hitl_catalog_initialization_failed',category,versionType:typeof event.ResourceProperties?.InitializationVersion}));
    result={PhysicalResourceId:event.PhysicalResourceId||`platform-hitl-catalog:${event.ResourceProperties?.TableName}:platform`};await send(event,context,'FAILED',result,'Approval catalog initialization failed.');return result; }
  await send(event,context,'SUCCESS',result,'Approval catalog initialized or retained.');
  return result;
}
