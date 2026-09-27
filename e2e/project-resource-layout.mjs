// Actual renderer and stylesheet; synthetic catalog. No live API writes.
import {chromium} from 'playwright';
import {readFileSync,mkdirSync} from 'node:fs';
import assert from 'node:assert/strict';
const source=readFileSync(new URL('../console/public/modules/app.mjs',import.meta.url),'utf8');
const css=readFileSync(new URL('../console/public/styles/app.css',import.meta.url),'utf8');
const extract=name=>{const start=source.search(new RegExp(`^(?:async )?function ${name}\\(`,'m'));assert.ok(start>=0);return source.slice(start,source.indexOf('\n}',start)+2)};
const out='/private/tmp/project-selection-evidence';mkdirSync(out,{recursive:true});
const browser=await chromium.launch({headless:true});
try{
 for(const width of [1440,600])for(const inherited of [false,true]){
  const page=await browser.newPage({viewport:{width,height:1100}});
  await page.setContent(`<style>${css}</style><main style="padding:24px"><p>TEST FIXTURE — Project resource layout</p><div id="fixture"></div></main>`);
  await page.evaluate(({functions,steps,inherited})=>{
   window.esc=v=>String(v??'').replace(/&/g,'&amp;').replace(/</g,'&lt;');
   window.S={wiz:{step:3,hosted:true,hasDomainPolicy:!inherited,resources:['Chat Assistant','Workflow Orchestrator','Claude Agent SDK Assistant','Claude Haiku 4.5','Gemma 4 26B A4b','Long model name with version and configuration'].map((name,i)=>({name,ref:{type:i<3?'Blueprint':'Model',id:String(i)}})),data:{template:'blank',id:'sample',projectName:'Sample',description:'',resourcePolicy:{resources:[]}}}};
   window.renderWizard=box=>renderHostedProjectWizard(box);
   window.eval(steps.replace('const WIZ_STEPS=','window.WIZ_STEPS='));
   functions.forEach(code=>window.eval(code));
   renderHostedProjectWizard(document.getElementById('fixture'));
  },{inherited,steps:source.match(/^const WIZ_STEPS=.*$/m)[0],functions:['renderHostedProjectWizard','wireHostedProjectWizard','collectHostedProjectWizard','validateHostedProjectWizard'].map(extract)});
  const controls=page.locator('[data-project-resource]');assert.equal(await controls.count(),6);
  for(let i=0;i<6;i++){
   const box=await controls.nth(i).boundingBox();assert.equal(box.width,18);assert.equal(box.height,18);
   const gap=await controls.nth(i).evaluate(e=>e.nextElementSibling.getBoundingClientRect().left-e.getBoundingClientRect().right);assert.equal(gap,12);
  }
  assert.equal(await controls.first().isDisabled(),false);
  {await controls.first().check();assert.equal(await page.evaluate(()=>S.wiz.data.resourcePolicy.resources[0].id),'0');await page.getByText('Select all domain resources',{exact:true}).click();assert.equal(await page.locator('[data-project-resource]:checked').count(),6);await page.getByText('Clear selection',{exact:true}).click();assert.equal(await page.locator('[data-project-resource]:checked').count(),0);}
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),'Wizard must not overflow the viewport');
  await page.screenshot({path:`${out}/resources-${width}-${inherited?'legacy':'policy'}.png`,fullPage:true});
  await page.close();console.log(`PASS ${width}px ${inherited?'legacy':'policy'} resource controls`);
 }
}finally{await browser.close()}
