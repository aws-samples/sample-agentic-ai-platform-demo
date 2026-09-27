// Actual application, synthetic authenticated API fixtures. No live writes.
import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import {fixture,signIn,navigate,project} from './approved-ui-integration.mjs';
const browser=await chromium.launch({headless:true});
try{
 const f=await fixture('lead',{},browser);
 f.state.projects=[{...project('domain_a'),name:'Active support project'},{...project('domain_a'),id:'archived',name:'Archived support project',status:'ARCHIVED'},{...project('domain_b'),name:'Foreign domain project'}];
 await signIn(f);await navigate(f.page,'projects');
 await f.page.locator('#hostedcollection').getByText('Active support project').waitFor();
 assert.equal(await f.page.locator('#hostedcollection').getByText('Archived support project').count(),0);
 assert.equal(await f.page.locator('#hostedcollection').getByText('Foreign domain project').count(),0);
 await f.page.screenshot({path:'/private/tmp/project-ui-evidence/projects-active.png',fullPage:true});
 await f.page.selectOption('#project-status-filter','ARCHIVED');
 await f.page.locator('#hostedcollection').getByText('Archived support project').waitFor();
 assert.equal(await f.page.locator('[data-project-open]').count(),0);
 await f.page.selectOption('#project-status-filter','ALL');
 await f.page.locator('#hostedcollection').getByText('Active support project').waitFor();
 assert.equal(await f.page.locator('#hostedcollection').getByText('Archived support project').count(),1);
 assert.equal(await f.page.locator('#hostedcollection').getByText('Foreign domain project').count(),0);
 assert.equal(f.state.projectPosts,0);
 console.log('PASS default active, archived/all filters, domain isolation, no project writes');
 await f.context.close();
}finally{await browser.close()}
