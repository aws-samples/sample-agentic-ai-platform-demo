import test from 'node:test';
import assert from 'node:assert/strict';
import {mountPublicationSubmission} from './public/publication-submission.mjs';

function node(tag='div') { return {tag,textContent:'',value:'',disabled:false,hidden:false,isConnected:true,children:[],setAttribute(){},append(...x){this.children.push(...x)},replaceChildren(...x){this.children=x}} }
globalThis.document={createElement:node};
function harness({role='admin',source='agentcore-registry',read=()=>({ok:true,resource:'approvals',items:[],cursor:null}),reply={ok:true,approval:{id:'review-1',status:'PENDING'}}}={}) {
 const button=node('button'), box=node(); let actor='admin-a'; const calls=[];let reloads=0;
 const root={isConnected:true,querySelector:s=>s==='[data-publication-check]'?button:box};
 mountPublicationSubmission(root,{row:{identity:'abcdefghijkl/mnopqrstuvwx',entry:{_source:source,type:'MCPServer',domain:'operations'},version:{semver:'1.0.0',status:'IN_REVIEW',_aws:{registryId:'abcdefghijkl',recordId:'mnopqrstuvwx'}}},access:{role,resourceDomain:'operations',activeDomain:'platform',capabilities:[]},current:()=>true,identity:()=>actor,requestId:()=> 'initiation-1',readApprovals:async()=>read(),api:async(...args)=>{calls.push(args);return reply},reload:async()=>{reloads++}});
 return {button,box,calls,actor:x=>{actor=x},reloads:()=>reloads};
}
test('admin can open review initiation without writing; reason required, explicit submit calls real route',async()=>{
 const h=harness();assert.equal(h.button.hidden,false);assert.equal(h.button.textContent,'Initiate review');await h.button.onclick();assert.equal(h.calls.length,0);
 const reason=h.box.children.find(x=>x.tag==='textarea'); const submit=h.box.children.find(x=>x.tag==='button'&&x.textContent==='Submit for independent review');assert.ok(reason);assert.ok(submit);
 await submit.onclick();assert.equal(h.calls.length,0);reason.value='Review this resource for platform admission.';await submit.onclick();assert.equal(h.calls.length,1);assert.equal(h.calls[0][0],'/governance/publication-initiations');assert.equal(h.calls[0][1].reason,reason.value);assert.equal(h.reloads(),1);
});
test('unknown approval source cannot expose a write form',async()=>{const h=harness({read:()=>({ok:false})});await h.button.onclick();assert.equal(h.calls.length,0);assert.equal(h.box.children.some(x=>x.tag==='textarea'),false)});
test('changed actor cannot use the retained submit handler',async()=>{const h=harness();await h.button.onclick();const reason=h.box.children.find(x=>x.tag==='textarea');const b=h.box.children.find(x=>x.tag==='button');reason.value='Independent review requested.';h.actor('admin-b');await b.onclick();assert.equal(h.calls.length,0)});
test('Gateway projection cannot acquire native initiation controls',()=>{const h=harness({source:'gateway'});assert.equal(h.button.hidden,true)});
test('non-admin cannot acquire admin initiation controls',()=>{const h=harness({role:'builder'});assert.equal(h.button.hidden,true)});
test('uncertain mutation is not automatically retried',async()=>{const h=harness({reply:{ok:false,code:'CONTROL_PLANE_UNAVAILABLE'}});await h.button.onclick();const reason=h.box.children.find(x=>x.tag==='textarea');const b=h.box.children.find(x=>x.tag==='button');reason.value='Independent review requested.';await b.onclick();await b.onclick();assert.equal(h.calls.length,1);assert.equal(h.reloads(),0)});
