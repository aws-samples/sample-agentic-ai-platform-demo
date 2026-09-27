import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {memoryKbTabHtml} from './public/workspace-tabs-view.mjs';
const source=readFileSync(new URL('./public/modules/app.mjs',import.meta.url),'utf8');
const marker="} else if(tab==='memorykb'){";
const start=source.indexOf(marker)+marker.length;
const body=source.slice(start,source.indexOf("} else if(tab==='cost'){",start));
async function render(mode,response){
 const paths=[],box={innerHTML:''};
 const context=vm.createContext({authMode:()=>mode,p:{id:'project-one',domain:'operations',name:'Project One'},body:box,current:()=>true,CANCELED_REQUEST:Symbol(),api:async path=>{paths.push(path);return typeof response==='function'?response(path):response;},memoryKbTabHtml});
 await vm.runInContext(`(async()=>{${body}})()`,context);
 return {paths,html:box.innerHTML};
}
test('hosted Memory/KB renders live project resources from main',async()=>{
 const {paths,html}=await render('cognito',{ok:true,memories:[{name:'deployed-memory',status:'ACTIVE'}],knowledgeBases:[{name:'deployed-kb',status:'ACTIVE'}]});
 assert.deepEqual(paths,['/project-memories?project=project-one']);assert.match(html,/deployed-memory/);assert.match(html,/deployed-kb/);assert.doesNotMatch(html,/declared · not provisioned/);
});
test('projects without a deployed kit retain scoped saved Agent configuration',async()=>{
 const {paths,html}=await render('cognito',path=>path.startsWith('/project-memories')?{ok:false,code:'NOT_FOUND'}:{ok:true,items:[{domainId:'operations',projectId:'project-one',memoryIds:['allowed-memory'],knowledgeBaseIds:[]},{domainId:'other',projectId:'project-one',memoryIds:['foreign-memory']}]});
 assert.deepEqual(paths,['/project-memories?project=project-one','/agents']);assert.match(html,/allowed-memory/);assert.doesNotMatch(html,/foreign-memory/);
});
test('hosted read failure is not displayed as an empty configured project',async()=>{
 const {html}=await render('cognito',{ok:false});assert.match(html,/Memory data unavailable/);assert.doesNotMatch(html,/No memory stores/);
});
test('permission failures never fall back to a different resource API',async()=>{
 const {paths,html}=await render('cognito',{ok:false,code:'FORBIDDEN'});
 assert.deepEqual(paths,['/project-memories?project=project-one']);assert.match(html,/Memory data unavailable/);
});
test('unavailable live status does not claim a configured resource was never provisioned',async()=>{
 const {html}=await render('cognito',{ok:true,memories:[{name:'configured-memory',memoryId:'memory-id',status:null}],knowledgeBases:[]});
 assert.match(html,/Status unavailable/);assert.doesNotMatch(html,/declared · not provisioned/);
});
test('local project-memory enrichment from main is preserved',async()=>{
 const {paths,html}=await render('local',{memories:[{name:'kit-memory',strategies:[],live:{status:'ACTIVE'}}],knowledgeBases:[]});
 assert.deepEqual(paths,['/project-memories?project=project-one']);assert.match(html,/kit-memory|ACTIVE/);
});
