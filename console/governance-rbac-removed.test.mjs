import test from 'node:test';import assert from 'node:assert/strict';import vm from 'node:vm';import {readFileSync,existsSync} from 'node:fs';
const source=readFileSync(new URL('./public/modules/app.mjs',import.meta.url),'utf8');
const block=source.slice(source.indexOf('const GOV_TABS = ['),source.indexOf('function vGovernance(){'));
function ctx(platform,tab){const c=vm.createContext({S:{govTab:tab},hasCap:()=>platform});vm.runInContext(block+'\nthis.visible=govTabsVisible;this.active=activeGovTab;this.label=govTabLabel;',c);return c}
test('RBAC tab and its private renderer/module are removed, other tabs retained',()=>{const c=ctx(true,'queue');assert.deepEqual(Array.from(c.visible(),x=>x[0]),['queue','guardrails','policies','audit']);assert.equal(c.label('rbac'),'');assert.doesNotMatch(source,/govRbacTab|rbaclive|mountRbacAccess|rbac-access\.mjs|tab==='rbac'/);assert.equal(existsSync(new URL('./public/rbac-access.mjs',import.meta.url)),false)});
test('old RBAC and invalid saved states safely fall back to existing queue for every viewer',()=>{for(const platform of [true,false])for(const tab of ['rbac','unknown',undefined])assert.equal(ctx(platform,tab).active(),'queue');for(const tab of ['guardrails','policies','audit'])assert.equal(ctx(true,tab).active(),tab);
// Retired tab ids from saved state or deep links land on their new home, not a dead panel.
for(const [legacy,target] of [['requests','queue'],['exemptions','queue'],['alerts','guardrails'],['compliance','audit']])assert.equal(ctx(true,legacy).active(),target);
// Non-platform viewers only ever see the decision inbox.
for(const tab of ['guardrails','policies','audit','requests'])assert.equal(ctx(false,tab).active(),'queue')});
test('Access surfaces and server authorization hooks remain present',()=>{for(const text of ['function vHostedAccessAdmin','function loadHostedMemberships','function hostedApprovalRecordAllowed','function authHeaders','const authHeaders','function wireHostedApprovalActions']){if(text==='function authHeaders')continue;assert.ok(source.includes(text),text)}});
