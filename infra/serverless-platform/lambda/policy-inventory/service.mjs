import {GetGatewayCommand,GetPolicyEngineCommand,ListPoliciesCommand} from '@aws-sdk/client-bedrock-agentcore-control';
const str=v=>typeof v==='string'&&v.length>0;
const date=v=>v instanceof Date?v.toISOString():typeof v==='string'?v:null;
const code=e=>e?.name==='AccessDeniedException'?'ACCESS_DENIED':e?.name==='ThrottlingException'?'THROTTLED':['AbortError','TimeoutError'].includes(e?.name)?'TIMEOUT':'SOURCE_UNAVAILABLE';
export function createRuntimePolicyReader({client,gateways,now=()=>new Date()}){
 if(!client?.send||!Array.isArray(gateways)||!gateways.length||gateways.length>10)throw new Error('Invalid policy inventory configuration');
 const configured=gateways.map(g=>{const m=/^arn:(aws(?:-cn|-us-gov)?):bedrock-agentcore:([a-z0-9-]+):(\d{12}):gateway\/([A-Za-z0-9-]+)$/.exec(g.arn||'');if(!m||!str(g.label))throw new Error('Invalid gateway binding');return {...g,id:m[4],enginePrefix:`arn:${m[1]}:bedrock-agentcore:${m[2]}:${m[3]}:policy-engine/`}});
 return async()=>{
  const rows=[];
  // Leave time for a partial response before the API Gateway/Lambda deadline.
  const abortSignal=AbortSignal.timeout(22000);
  const send=command=>client.send(command,{abortSignal});
  // Bounded sequential reads avoid one page burst exhausting the control-plane quota.
  for(const gateway of configured){
   const row={id:gateway.id,label:gateway.label,arn:gateway.arn,status:'UNKNOWN',authorizerType:null,binding:'UNKNOWN',mode:null,engine:null,policies:[],complete:false,error:null};rows.push(row);
   try{
    const g=await send(new GetGatewayCommand({gatewayIdentifier:gateway.id}));
    if(g.gatewayArn!==gateway.arn||g.gatewayId!==gateway.id||!str(g.status))throw new Error('Gateway identity mismatch');
    row.status=g.status;row.authorizerType=g.authorizerType||null;
    if(g.policyEngineConfiguration===undefined){row.binding='NOT_ATTACHED';row.complete=true;continue;}
    const binding=g.policyEngineConfiguration;
    if(!str(binding?.arn)||!binding.arn.startsWith(gateway.enginePrefix)||!['LOG_ONLY','ENFORCE'].includes(binding.mode))throw new Error('Invalid policy engine binding');
    const engineId=binding.arn.slice(gateway.enginePrefix.length);
    if(!/^[A-Za-z][A-Za-z0-9_]*-[a-z0-9_]{10}$/.test(engineId))throw new Error('Invalid engine identity');
    row.binding='ATTACHED';row.mode=binding.mode;
    const e=await send(new GetPolicyEngineCommand({policyEngineId:engineId}));
    if(e.policyEngineId!==engineId||e.policyEngineArn!==binding.arn||!str(e.status))throw new Error('Engine identity mismatch');
    row.engine={id:engineId,arn:e.policyEngineArn,name:e.name,status:e.status,updatedAt:date(e.updatedAt)};
    const seen=new Set(),ids=new Set();let nextToken;
    for(let page=0;page<5;page++){
     const result=await send(new ListPoliciesCommand({policyEngineId:engineId,maxResults:20,...(nextToken?{nextToken}:{})}));
     if(!Array.isArray(result.policies))throw new Error('Malformed policy list');
     for(const p of result.policies){
      if(!str(p.policyId)||ids.has(p.policyId)||p.policyEngineId!==engineId||!str(p.name)||!str(p.status)||p.policyArn!==`${binding.arn}/policy/${p.policyId}`)throw new Error('Malformed policy identity');
      ids.add(p.policyId);
      const statement=p.definition?.cedar?.statement;
      row.policies.push({id:p.policyId,name:p.name,arn:p.policyArn,status:p.status,enforcementMode:p.enforcementMode||null,description:typeof p.description==='string'?p.description.slice(0,4096):null,statement:typeof statement==='string'?statement.slice(0,16384):null,statementTruncated:typeof statement==='string'&&statement.length>16384,updatedAt:date(p.updatedAt)});
     }
     if(result.nextToken===undefined||result.nextToken===null){row.complete=true;break;}
     if(!str(result.nextToken)||seen.has(result.nextToken))throw new Error('Invalid policy pagination');
     seen.add(result.nextToken);nextToken=result.nextToken;
    }
    if(!row.complete)row.error='PAGE_LIMIT';
   }catch(e){row.error=code(e);}
  }
  return {ok:true,schemaVersion:1,source:'agentcore-policy',scope:'shared-platform-gateways',checkedAt:now().toISOString(),complete:rows.every(r=>r.complete),gateways:rows};
 };
}
