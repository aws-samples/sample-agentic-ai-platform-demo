// LOCAL synthetic API / actual Chromium / NOT dev. Every request is intercepted.
// Run with Node 22: node e2e/governance-mobile-layout.mjs <output> [baseline]
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {capabilitiesForRole} from '../infra/serverless-platform/lambda/authz/capabilities.mjs';
import {fixture,signIn,navigate,poll,unexpected,errors,loaded} from './approved-ui-integration.mjs';
const output=path.resolve(process.argv[2]);await mkdir(output,{recursive:true});
const baseline=process.argv[3]==='baseline';
const browser=await chromium.launch({headless:true,chromiumSandbox:true,executablePath:process.env.GOV_CHROMIUM_EXECUTABLE||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
const results={boundary:'LOCAL synthetic API, NOT dev',baseline,runtime:process.version,browser:browser.version(),checks:[],metrics:[],dialogs:[],writes:[]};
async function shot(page,name){
 await page.evaluate(()=>{let el=document.getElementById('local-evidence');if(!el){el=document.createElement('div');el.id='local-evidence';el.textContent='LOCAL • SYNTHETIC API • NOT DEV';el.style.cssText='position:fixed;bottom:0;left:0;z-index:9999;background:#fff4cc;color:#111;padding:4px 8px;font:12px sans-serif;pointer-events:none';document.body.append(el);}});
 await page.screenshot({path:path.join(output,name+'.png'),fullPage:false});
}
async function metrics(page,label){const m=await page.evaluate(()=>{
 const bar=document.querySelector('[role=tablist]'),tab=document.querySelector('.govtab[aria-selected=true]'),panel=document.getElementById('govtabpanel');
 const b=bar.getBoundingClientRect(),t=tab.getBoundingClientRect(),p=panel.getBoundingClientRect();
 return {width:innerWidth,height:innerHeight,documentWidth:document.documentElement.scrollWidth,barHeight:b.height,barTop:b.top,panelTop:p.top,selected:tab.id,focus:document.activeElement.id,scrollLeft:bar.scrollLeft,selectedInView:t.left>=b.left&&t.right<=b.right,focusVisible:tab.matches(':focus-visible'),outlineWidth:getComputedStyle(tab).outlineWidth,tabRows:new Set([...bar.children].map(el=>Math.round(el.getBoundingClientRect().top))).size};
 });results.metrics.push({label,...m});return m;}
try{
 for(const width of [390,1440]){
 const f=await fixture('admin',{viewport:{width,height:844}},browser);f.state.canSwitch=false;
 await f.context.route('https://console.test/api/**',async route=>{if(route.request().method()!=='GET'){results.writes.push(new URL(route.request().url()).pathname);return route.abort();}if(new URL(route.request().url()).pathname==='/api/me')return route.fulfill({contentType:'application/json',body:JSON.stringify({ok:true,user:'synthetic-operator',name:'LOCAL Synthetic Admin',authenticatedRole:'admin',role:'admin',domain:null,domains:[],capabilities:capabilitiesForRole('admin'),demoRoleActive:false,canSwitchDemoRole:false,availableDemoRoles:[],availableDemoDomains:[]})});return route.fallback();});
 f.page.removeAllListeners('dialog');let accept=false;
 f.page.on('dialog',async dialog=>{results.dialogs.push({width,type:dialog.type(),message:dialog.message(),accept});await(accept?dialog.accept():dialog.dismiss());});
 await signIn(f);await navigate(f.page,'governance');await f.page.evaluate(()=>scrollTo(0,0));
 const start=await metrics(f.page,`${width}-queue-first-viewport`);await shot(f.page,`${width}-queue`);
 if(!baseline&&width===390){assert.equal(start.tabRows,1);assert.ok(start.panelTop<650,JSON.stringify(start));assert.ok(start.documentWidth<=width);
 const toggle=f.page.locator('.gov-site-nav-toggle');assert.equal(await toggle.getAttribute('aria-expanded'),'false');assert.equal(await f.page.locator('#gov-site-nav-items').isVisible(),false);
 await toggle.focus();await f.page.keyboard.press('Enter');assert.equal(await f.page.locator('#gov-site-nav-items').isVisible(),true);await shot(f.page,'390-navigation-expanded');await f.page.keyboard.press('Space');assert.equal(await f.page.locator('#gov-site-nav-items').isVisible(),false);
 results.checks.push('390: navigation disclosure Enter opens / Space closes, links retain original handlers');
 }
 await f.page.locator('#govtab-policies').click();await f.page.locator('#hpname').waitFor();
 await f.page.locator('#hpname').fill('LOCAL unsaved policy draft');
 assert.equal(await f.page.locator('#hpcreate').isDisabled(),true,'Never enable unsupported hosted writes');
 const before=results.dialogs.length;
 await f.page.locator('#govtab-requests').click();
 await poll(()=>results.dialogs.length===before+1,'Real dirty form opens browser confirm');
 const cancel=await metrics(f.page,`${width}-mouse-cancel`);
 assert.equal(await f.page.locator('#hpname').inputValue(),'LOCAL unsaved policy draft');assert.equal(cancel.selected,'govtab-policies');
 if(!baseline)assert.equal(cancel.focus,'govtab-policies');
 await f.page.locator('#govtab-policies').focus();await f.page.keyboard.press('ArrowRight');
 const keyboardCancel=await metrics(f.page,`${width}-keyboard-cancel`);assert.equal(keyboardCancel.focus,'govtab-policies');
 assert.equal(await f.page.locator('#hpname').inputValue(),'LOCAL unsaved policy draft');await shot(f.page,`${width}-dirty-cancel`);
 accept=true;await f.page.keyboard.press('ArrowRight');await poll(async()=>await f.page.locator('#govtab-guardrails').getAttribute('aria-selected')==='true','Confirm switches tab');
 const confirmed=await metrics(f.page,`${width}-confirm`);assert.equal(confirmed.focus,'govtab-guardrails');assert.equal(await f.page.locator('#hpname').count(),0);
 await f.page.keyboard.press('End');await poll(async()=>await f.page.locator('#govtab-compliance').getAttribute('aria-selected')==='true','End selects Compliance');
 const end=await metrics(f.page,`${width}-end`);if(!baseline){assert.equal(end.selectedInView,true);assert.equal(end.focusVisible,true);assert.equal(end.outlineWidth,'3px');assert.ok(end.documentWidth<=width);}await shot(f.page,`${width}-end`);
 if(!baseline&&width===1440){await f.page.setViewportSize({width:390,height:844});await poll(async()=>(await metrics(f.page,'resize-to-390')).selectedInView,'Resize reveals selected Compliance');assert.equal((await metrics(f.page,'resize-single-row')).tabRows,1);await shot(f.page,'390-resized-from-desktop');await f.page.setViewportSize({width:1440,height:844});}
 await f.page.keyboard.press('Home');await poll(async()=>await f.page.locator('#govtab-queue').getAttribute('aria-selected')==='true','Home selects Queue');
 await f.page.keyboard.press('ArrowLeft');await poll(async()=>await f.page.locator('#govtab-compliance').getAttribute('aria-selected')==='true','ArrowLeft wraps');
 await f.page.keyboard.press('ArrowRight');await poll(async()=>await f.page.locator('#govtab-queue').getAttribute('aria-selected')==='true','ArrowRight wraps');
 await f.page.locator('#govtab-policies').click();await f.page.locator('#hpname').waitFor();assert.equal(await f.page.locator('#hpname').inputValue(),'','Confirmed discarded draft is gone');
 if(!baseline){assert.equal((await metrics(f.page,`${width}-mouse-confirm-focus`)).focus,'govtab-policies');}
 results.checks.push(`${width}: actual dirty field Cancel retains content/selected; keyboard Cancel focus; Confirm switches and discards; Home/End/arrow wrap; unsupported create stays disabled`);
 if(!baseline){
 if(width===390)await f.page.locator('.gov-site-nav-toggle').click();
 await navigate(f.page,'home');assert.equal(await f.page.locator('#gov-site-nav-items,.gov-site-nav-toggle').count(),0);
 results.checks.push(`${width}: leaving Governance restores original site navigation`);
 }
 await f.context.close();
 }
 assert.deepEqual(results.writes,[]);assert.deepEqual(errors,[]);assert.deepEqual(unexpected,[]);results.status='PASS';
}catch(error){results.status='FAIL';results.error=error.stack;process.exitCode=1;console.error(error);}
finally{results.errors=errors;results.unexpected=unexpected;results.assets=Object.fromEntries(loaded);await writeFile(path.join(output,'result.json'),JSON.stringify(results,null,2));console.log(JSON.stringify(results,null,2));await browser.close();}
