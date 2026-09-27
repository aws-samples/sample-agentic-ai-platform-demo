import {BedrockAgentCoreControlClient} from '@aws-sdk/client-bedrock-agentcore-control';
import {ownStringClaim,preflightEffectiveIdentity,projectEffectiveIdentity,verifyCurrentDemoOperator} from '../api/identity.mjs';
import {createRuntimePolicyReader} from './service.mjs';
const response=(statusCode,body)=>({statusCode,headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'},body:JSON.stringify(body)});
export function createPolicyInventoryHandler({read,verify=verifyCurrentDemoOperator}){
 return async(event={})=>{
  const fail=(status,code)=>response(status,{ok:false,code});
  if(event.routeKey!=='GET /api/governance/runtime-policies'||event.requestContext?.http?.method!=='GET'||event.requestContext.http.path!=='/api/governance/runtime-policies')return fail(404,'ROUTE_NOT_FOUND');
  if(event.body!=null||event.rawQueryString||Object.keys(event.queryStringParameters||{}).length)return fail(400,'INVALID_REQUEST');
  const claims=event.requestContext?.authorizer?.jwt?.claims;
  if(!ownStringClaim(claims,'sub')||ownStringClaim(claims,'token_use')!=='access')return fail(401,'NOT_AUTHENTICATED');
  try{
   const preflight=preflightEffectiveIdentity(claims,event.headers);
   // Inventory spans shared platform gateways. Never infer this authority from a UI role switch.
   if(preflight.authenticatedIdentity.role!=='admin')return fail(403,'FORBIDDEN');
   const permitted=preflight.roleHeader.present?await verify(claims):undefined;
   const identity=projectEffectiveIdentity(claims,event.headers,{demoOperatorAuthorized:permitted});
   if(identity.role!=='admin')return fail(403,'FORBIDDEN');
  }catch(e){return fail(e?.statusCode===403?403:503,e?.statusCode===403?'FORBIDDEN':'IDENTITY_UNAVAILABLE');}
  try{return response(200,await read())}catch{return fail(503,'POLICY_INVENTORY_UNAVAILABLE')}
 };
}
let production;
export async function handler(event){
 if(!production){try{production=createPolicyInventoryHandler({read:createRuntimePolicyReader({client:new BedrockAgentCoreControlClient({maxAttempts:2}),gateways:JSON.parse(process.env.POLICY_GATEWAYS_JSON||'null')})})}catch{return response(503,{ok:false,code:'POLICY_INVENTORY_NOT_CONFIGURED'})}}
 return production(event);
}
