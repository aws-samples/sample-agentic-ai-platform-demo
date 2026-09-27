// Cache display metadata only. Each caller must first obtain fresh, authorized
// ListRegistryRecords summaries. Strict decision/authorization reads bypass this.
export function createRecordDisplayCache({now=Date.now,ttlMs=15000,maxEntries=256}={}) {
 const entries=new Map();
 return async(summary,load)=>{
  const updated=summary?.updatedAt instanceof Date?summary.updatedAt.getTime():Date.parse(summary?.updatedAt);
  const key=Number.isFinite(updated)&&summary.recordArn&&summary.status
   ?JSON.stringify([summary.registryId,summary.recordId,summary.recordArn,summary.status,summary.name,summary.recordType,summary.recordVersion,updated]):null;
  const cached=key&&entries.get(key);
  if(cached&&cached.expiresAt>now())return structuredClone(cached.record);
  if(key)entries.delete(key);
  const record=await load(); // includes detail identity/status/content validation
  const detailUpdated=record?.updatedAt instanceof Date?record.updatedAt.getTime():Date.parse(record?.updatedAt);
  if(key&&record&&detailUpdated===updated){
   for(const [k,v] of entries)if(v.expiresAt<=now())entries.delete(k);
   while(entries.size>=maxEntries)entries.delete(entries.keys().next().value);
   entries.set(key,{record:structuredClone(record),expiresAt:now()+ttlMs});
  }
  return record;
 };
}
