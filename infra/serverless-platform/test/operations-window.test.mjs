import test from 'node:test';
import assert from 'node:assert/strict';
import {createOperationsService} from '../lambda/operations/service.mjs';
import {createCloudWatchRuntimeProvider} from '../lambda/operations/runtime.mjs';
const now=Date.parse('2026-09-11T21:07:59.194Z');
const usageCalls=[];
const identity={actor:'qa-admin',role:'admin',activeDomain:null,domainIds:['operations']};
function setup(){
 const calls=[];
 class Command {constructor(input){this.input=input;}}
 const provider=createCloudWatchRuntimeProvider({GetMetricDataCommand:Command,client:{async send({input}){
  calls.push(input);
  const period=input.MetricDataQueries[0].MetricStat.Period;
  const resolution=period>=15*86400?300000:60000;
  const timestamp=new Date(Math.floor(input.StartTime.getTime()/resolution)*resolution);
  return {$metadata:{httpStatusCode:200},Messages:[],MetricDataResults:input.MetricDataQueries.map(q=>({Id:q.Id,Label:q.Label,StatusCode:'Complete',Timestamps:[timestamp],Values:[1]}))};
 }}});
 const service=createOperationsService({workspaceState:{...Object.fromEntries(['beginTransaction','getMutationResult','getProject','listIncidents','getIncident','putIncident','listAuditMetadata','listBreakGlass','getBreakGlass','putBreakGlass'].map(key=>[key,()=>{throw new Error('Unexpected workflow call: '+key);} ])),async listProjects(){return {items:[],cursor:null};}},authorizer:async()=>({ok:true}),cloudWatchProvider:provider,usageProvider:{async listInvocationUsageAggregates(input){usageCalls.push(input);return {items:[],cursor:null};},async listBudgets(){return [];}},clock:()=>now,cursorSigningKey:'test-only-window-cursor-key-at-least-32-characters'});
 return {service,calls,provider};
}
test('realistic non-aligned wall clock does not reject CloudWatch minute-rounded aggregates',async()=>{
 const {service,calls}=setup();
 const result=await service.listOperations({identity,window:'24h',limit:50});
 assert.equal(result.items[0].invocationCount,1);
 assert.equal(calls[0].StartTime.toISOString(),'2026-09-10T21:07:00.000Z');
 assert.equal(calls[0].EndTime.toISOString(),'2026-09-11T21:07:00.000Z');
});
test('30d windows use CloudWatch five-minute start rounding without rejecting valid data',async()=>{
 const {service,calls}=setup();
 const result=await service.listOperations({identity,window:'30d',limit:50});
 assert.equal(result.items[0].invocationCount,1);
 assert.equal(calls[0].StartTime.toISOString(),'2026-08-12T21:05:00.000Z');
 assert.equal(calls[0].EndTime.toISOString(),'2026-09-11T21:05:00.000Z');
});
for(const window of ['1h','7d'])test(`${window} uses a minute-aligned declared window`,async()=>{
 const {service,calls}=setup();await service.listOperations({identity,window,limit:50});
 assert.equal(calls[0].StartTime.getTime()%60000,0);
 assert.equal(calls[0].EndTime.getTime()%60000,0);
});
test('journal costs preserve exact wall-clock boundaries',async()=>{
 const {service,calls}=setup();await service.listCosts({identity,window:'24h',limit:50});
 assert.equal(usageCalls.at(-1).endTime,new Date(now).toISOString());assert.equal(calls.length,0);
});
test('provider still rejects out-of-window data; no timestamp validation relaxed',async()=>{
 const {provider}=setup();await assert.rejects(provider.listRuntimeAggregates({scope:{type:'platform',domainIds:['operations'],projectIds:[]},startTime:new Date(now-86400000).toISOString(),endTime:new Date(now).toISOString(),limit:50}),{code:'CLOUDWATCH_UNAVAILABLE'});
});
