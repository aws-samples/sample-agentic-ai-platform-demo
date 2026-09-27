// Offline DOM/event regression. No browser, HTTP server, auth, or business writes.
// Supply JSDOM_MODULE when jsdom is installed outside this repository.
import nodeTest from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
let JSDOM;
try { ({JSDOM}=require(process.env.JSDOM_MODULE || 'jsdom')); }
catch(error) { if(process.env.JSDOM_MODULE || error.code!=='MODULE_NOT_FOUND')throw error; }
const test=(name,fn)=>nodeTest(name,{skip:JSDOM?false:'Requires jsdom; set JSDOM_MODULE to its installed module path'},fn);
const app=readFileSync(process.env.LANDING_APP_SOURCE || new URL('./public/modules/app.mjs',import.meta.url),'utf8');
const landing=readFileSync(new URL('./public/modules/landing.mjs',import.meta.url),'utf8');
function fn(name){const start=app.search(new RegExp(`^(?:async )?function ${name}\\(`,'m'));assert.notEqual(start,-1,name);return app.slice(start,app.indexOf('\n}',start)+2);}
function setup(url='https://synthetic.invalid/'){
  const dom=new JSDOM('<main id="main"></main><aside id="side"></aside>',{url,runScripts:'outside-only',pretendToBeVisual:true});
  const w=dom.window,frames=new Map(),signals=[];let id=0;
  w.matchMedia=()=>Object.assign(new w.EventTarget(),{matches:false});
  w.requestAnimationFrame=cb=>{frames.set(++id,cb);return id;};w.cancelAnimationFrame=n=>frames.delete(n);
  w.fetch=(_url,{signal})=>{signals.push(signal);return new Promise(()=>{});};
  w.eval(landing.replaceAll('export ','').replaceAll('import.meta.url',JSON.stringify(new URL('./public/modules/landing.mjs',import.meta.url).href))+'\nwindow.mountLanding=mountLanding;');
  w.eval(`var SESSION=null,S={view:'overview'},disposeLanding=null,cognitoLoginStatus='',renders=0,clears=0,signins=0,confirmed=true;
    const authMode=()=> 'cognito',renderTopbar=()=>{},esc=String,beginSignIn=async()=>{signins++},cognitoErrorMessage=String;
    const confirmContextChange=()=>confirmed,clearBusinessDrafts=()=>{clears++},SHELL=()=> 'admin',SHELL_HOME={admin:'overview'};
    const runSessionTask=f=>f(),ensure=async()=>{},allowedViews=()=>['overview','registry'],sidebar=()=>{},vOverview=()=>'<h1>Signed in</h1>',wire=()=>{},wireGoldenEval=()=>{},loadExportManifest=()=>{},pendingNavFocus=null;
    ${fn('vLogin')}\n${fn('renderSession')}\nfunction render(){renders++;return runSessionTask(renderSession);}
    ${app.slice(app.indexOf('const URL_VIEWS ='),app.indexOf("addEventListener('beforeunload'"))}
    render();`);
  const q=s=>w.document.querySelector(s);
  const state=()=>({role:q('[data-jtab][aria-selected="true"]')?.dataset.jtab,stage:q('[data-gstage][aria-pressed="true"]')?.dataset.gstage,pause:q('#landing-pause')?.getAttribute('aria-pressed')});
  const select=()=>{q('[data-jtab="builder"]').click();q('[data-gstage="7"]').click();q('#landing-pause').click();};
  const navigate=path=>{w.history.pushState({},'',path);w.dispatchEvent(new w.PopStateEvent('popstate'));};
  return {dom,w,q,state,select,navigate,frames,signals};
}
const settle=()=>new Promise(r=>setTimeout(r,30));
test('actual skip anchor default action emits navigation events without remounting selected paused landing',async t=>{
 const h=setup();t.after(()=>h.dom.window.close());h.select();const root=h.q('.landing'),before=h.state(),events=[];
 for(const name of ['popstate','hashchange'])h.w.addEventListener(name,()=>events.push(name));
 // jsdom implements anchor default navigation, not keyboard default activation/focus.
 h.q('.landing-skip').click();await settle();
 assert.equal(h.w.location.hash,'#landing-signin');assert.ok(events.includes('popstate'));assert.ok(events.includes('hashchange'));
 assert.deepEqual(h.state(),before);assert.equal(h.q('.landing'),root);assert.equal(h.signals.length,1);assert.equal(h.signals[0].aborted,false);assert.equal(h.frames.size,0);
});
test('fragment Back and Forward retain landing and do not clear drafts',async t=>{
 const h=setup();t.after(()=>h.dom.window.close());h.select();const before=h.state(),root=h.q('.landing');h.q('.landing-skip').click();await settle();
 h.w.history.back();await settle();assert.equal(h.w.location.hash,'');assert.deepEqual(h.state(),before);assert.equal(h.q('.landing'),root);
 h.w.history.forward();await settle();assert.equal(h.w.location.hash,'#landing-signin');assert.deepEqual(h.state(),before);assert.equal(h.w.clears,0);
});
test('real path departure aborts old mount and re-entry creates fresh default landing',t=>{
 const h=setup();t.after(()=>h.dom.window.close());h.select();const root=h.q('.landing');h.navigate('/registry');
 assert.notEqual(h.q('.landing'),root);assert.equal(h.signals[0].aborted,true);assert.deepEqual(h.state(),{role:'admin',stage:'0',pause:'false'});
 h.select();h.navigate('/');assert.deepEqual(h.state(),{role:'admin',stage:'0',pause:'false'});assert.equal(h.signals[1].aborted,true);assert.equal(h.frames.size,1);
});
test('callback query changes are not fragment-only navigation',t=>{
 const h=setup();t.after(()=>h.dom.window.close());const root=h.q('.landing');h.navigate('/?code=synthetic-code&state=synthetic-state');
 assert.notEqual(h.q('.landing'),root);assert.equal(h.signals[0].aborted,true);assert.equal(h.w.clears,1);
});
test('mounted sign-in action remains bound after anchor navigation',async t=>{
 const h=setup();t.after(()=>h.dom.window.close());h.select();h.q('.landing-skip').click();await settle();h.q('#cognitosignin').click();await settle();
 assert.equal(h.w.signins,1);assert.match(h.q('#loginstatus').textContent,/redirecting/);
});
test('authenticated render still disposes landing and removes its event listeners',async t=>{
 const h=setup();t.after(()=>h.dom.window.close());const pause=h.q('#landing-pause');h.w.SESSION={role:'admin'};await h.w.render();
 assert.equal(h.signals[0].aborted,true);assert.equal(h.frames.size,0);assert.equal(h.q('.landing'),null);assert.equal(h.q('#main').classList.contains('public-landing'),false);
 pause.click();assert.equal(h.frames.size,0);h.w.SESSION=null;await h.w.render();assert.deepEqual(h.state(),{role:'admin',stage:'0',pause:'false'});
});
test('all four tabs and nine stages remain actionable after fragment navigation',async t=>{
 const h=setup();t.after(()=>h.dom.window.close());h.q('.landing-skip').click();await settle();
 const tabs=[...h.w.document.querySelectorAll('[data-jtab]')],stages=[...h.w.document.querySelectorAll('[data-gstage]')];assert.equal(tabs.length,4);assert.equal(stages.length,9);
 for(const tab of tabs){tab.click();assert.equal(h.state().role,tab.dataset.jtab);}
 for(const stage of stages){stage.click();assert.equal(h.state().stage,stage.dataset.gstage);}
});
test('same URL popstate is not swallowed as an anchor transition',t=>{
 const h=setup();t.after(()=>h.dom.window.close());const root=h.q('.landing');h.w.dispatchEvent(new h.w.PopStateEvent('popstate'));
 assert.notEqual(h.q('.landing'),root);assert.equal(h.signals[0].aborted,true);
});
test('authenticated fragment navigation still runs the existing dirty guard',async t=>{
 const h=setup();t.after(()=>h.dom.window.close());h.w.SESSION={role:'admin'};await h.w.render();h.w.confirmed=false;
 const renders=h.w.renders;h.navigate('/#signed-in-anchor');assert.equal(h.w.renders,renders);assert.equal(h.w.clears,0);
 h.w.confirmed=true;h.navigate('/#another-anchor');assert.equal(h.w.renders,renders+1);assert.equal(h.w.clears,1);
});
test('syncUrl tracks pushed routes so real Back is not mistaken for a fragment event',t=>{
 const h=setup();t.after(()=>h.dom.window.close());h.w.S.view='registry';h.w.syncUrl();assert.equal(h.w.location.pathname,'/registry');
 const root=h.q('.landing');h.navigate('/');assert.notEqual(h.q('.landing'),root);assert.equal(h.signals[0].aborted,true);
});
