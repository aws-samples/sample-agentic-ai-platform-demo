import test from 'node:test';
import assert from 'node:assert/strict';
import {initializeDemoWorkspaces,DEMO_WORKSPACES} from '../scripts/initialize-demo-workspaces.mjs';
function fixture(){
 const projects=new Map(DEMO_WORKSPACES.map(w=>[w.projectId,{id:w.projectId,domainId:w.domainId,status:'ACTIVE',ownerSubject:'deployment:baseline',createdBySubject:'deployment:baseline',memberSubjects:['existing-builder']}]));
 const agents=new Map(DEMO_WORKSPACES.map(w=>[w.agentId,{id:w.agentId,domainId:w.domainId,projectId:w.projectId,memoryIds:[],knowledgeBaseIds:[]}]));
 let writes=0,failAt=0;
 const state={getProject:async({projectId})=>projects.get(projectId),getAgent:async({agentId})=>agents.get(agentId),addProjectMember:async({projectId,subject})=>{writes++;if(writes===failAt)throw Error('conflict');const p=projects.get(projectId);if(p.memberSubjects.includes(subject))return {changed:false};p.memberSubjects.push(subject);return {changed:true};}};
 return {projects,agents,state,get writes(){return writes},set failAt(n){failAt=n},input:{usernames:['operator'],verifyOperator:async()=> 'operator-sub',state}};
}
test('plan verifies five domain projects without granting access',async()=>{const f=fixture();const r=await initializeDemoWorkspaces(f.input);assert.equal(r.plannedGrants,5);assert.equal(f.writes,0);assert.equal(r.memoryBindings,0);assert.equal(r.knowledgeBaseBindings,0);});
test('apply preserves existing users and rerun makes no writes',async()=>{const f=fixture();assert.equal((await initializeDemoWorkspaces({...f.input,apply:true})).changed,5);for(const p of f.projects.values())assert.deepEqual(p.memberSubjects,['existing-builder','operator-sub']);assert.equal((await initializeDemoWorkspaces({...f.input,apply:true})).plannedGrants,0);assert.equal(f.writes,5);});
test('all projects preflight before any write',async()=>{const f=fixture();f.projects.get('report-runner').ownerSubject='real-owner';await assert.rejects(initializeDemoWorkspaces({...f.input,apply:true}));assert.equal(f.writes,0);});
test('missing agent or archived project does not grant partial access',async()=>{for(const kind of ['agent','project']){const f=fixture();if(kind==='agent')f.agents.clear();else f.projects.get('report-runner').status='ARCHIVED';await assert.rejects(initializeDemoWorkspaces({...f.input,apply:true}));assert.equal(f.writes,0);}});
test('unauthorized operator stops before writes',async()=>{const f=fixture();await assert.rejects(initializeDemoWorkspaces({...f.input,apply:true,verifyOperator:async()=>{throw Error('not demo operator')}}));assert.equal(f.writes,0);});
test('partial provider failure remains safely resumable',async()=>{const f=fixture();f.failAt=3;await assert.rejects(initializeDemoWorkspaces({...f.input,apply:true}));assert.equal(f.projects.get('case-assist').memberSubjects.length,2);const r=await initializeDemoWorkspaces({...f.input,apply:true});assert.equal(r.changed,3);for(const p of f.projects.values())assert.equal(p.memberSubjects.filter(s=>s==='operator-sub').length,1);});
test('membership capacity checked before any writes',async()=>{const f=fixture();f.projects.get('report-runner').memberSubjects=Array.from({length:100},(_,i)=>'member-'+i);await assert.rejects(initializeDemoWorkspaces({...f.input,apply:true}));assert.equal(f.writes,0);});
