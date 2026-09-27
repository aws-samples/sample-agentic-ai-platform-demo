import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {activeBuildProjects} from './public/main-ui-build.mjs';
const source=readFileSync(new URL('./public/modules/app.mjs',import.meta.url),'utf8');
function load(name,context){const start=source.indexOf('function '+name+'(');assert.ok(start>=0);vm.runInContext(source.slice(start,source.indexOf('\n}\n',start)+2),context);}
for(const door of ['blueprint','plato','scratch'])test(`${door} resolves project and resources from the owning workspace`,()=>{
 const project={id:'chosen',domainId:'platform',status:'ACTIVE',resourcePolicy:{resources:[{type:'Model',id:'allowed'}]}};
 const context=vm.createContext({activeBuildProjects,S:{door,mainBuildProjectId:'chosen',mainBuildProjects:[project,{id:'chosen',domainId:'other',status:'ACTIVE'}],catalog:{models:[{id:'allowed'},{id:'denied'}]}},authMode:()=> 'cognito',mainBuildDomainId:()=> 'platform',projectAllowsResource:(p,type,id)=>p.resourcePolicy.resources.some(r=>r.type===type&&r.id===id)});
 for(const name of ['currentMainBuildProject','mainProjectAllows','mainProjectCatalog'])load(name,context);
 assert.equal(context.currentMainBuildProject(),project);
 assert.deepEqual(Array.from(context.mainProjectCatalog().models,m=>m.id),['allowed']);
 project.status='ARCHIVED';assert.equal(context.currentMainBuildProject(),null);assert.equal(context.mainProjectCatalog().models.length,0);
 context.S.mainBuildProjectId='absent';assert.equal(context.currentMainBuildProject(),null);assert.equal(context.mainProjectCatalog().models.length,0);
});
