import {collectPagedItems} from './main-ui-compat.mjs';
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const unknown=value=>typeof value==='string'&&value.trim()?esc(value):'Unknown';
const canceled=()=>({ok:false,canceled:true});

export async function readDraftActivity({read,resourceKey,domainId,current}) {
  if(domainId!=='platform'||!/^((hitl|alert)-policy)\/platform\/[a-z][a-z0-9-]{0,63}$/.test(resourceKey))return {ok:false};
  try {
    const result=await collectPagedItems(async cursor=>{
      if(!current())return canceled();
      const r=await read('/operations/audit?limit=50'+(cursor?'&cursor='+encodeURIComponent(cursor):''));
      if(!current())return canceled();
      if(r?.ok!==true)return r;
      if(r.resource!=='audit'||r.partial===true||r.incomplete===true||r.complete===false||r.errors?.length
        ||!Array.isArray(r.items)||r.items.some(e=>!e||typeof e.resource!=='string'||!e.resource||typeof e.domainId!=='string'||!e.domainId))return {ok:false};
      return r;
    });
    if(!current())return canceled();
    if(result?.ok!==true)return result||{ok:false};
    // Preserve the authoritative audit fields, not adaptAudit fallback labels.
    return {ok:true,events:result.items.filter(e=>e.resource===resourceKey&&e.domainId===domainId)};
  } catch {
    return current()?{ok:false}:canceled();
  }
}

export function draftActivityHtml(events) {
  const note='<p>Available audit records for this draft in the current authorized scope. This is activity metadata, not a version history. Missing fields are Unknown.</p>';
  if(!events.length)return note+'<p>No activity records available for this draft. This is not proof that the draft has never changed.</p>';
  return note+'<div style="overflow-x:auto"><table><thead><tr><th>Time (recorded)</th><th>Actor</th><th>Action</th><th>Reason</th></tr></thead><tbody>'+events.map(e=>`<tr><td>${typeof e.timestamp==='string'&&Number.isFinite(Date.parse(e.timestamp))?esc(e.timestamp):'Unknown'}</td><td>${unknown(e.actor)}</td><td>${unknown(e.action)}</td><td>${unknown(e.reason)}</td></tr>`).join('')+'</tbody></table></div>';
}

export function mountDraftActivity(root,{catalog,kind,read,current,identity}) {
  if(catalog.domainId!=='platform'||!['policy','alert'].includes(kind)||!Array.isArray(catalog.policies))return;
  const context=identity();
  const valid=()=>root.isConnected&&current()&&identity()===context;
  for(const policy of catalog.policies) {
    if(policy.enabled!==false||!/^[a-z][a-z0-9-]{0,63}$/.test(policy.id))continue;
    const card=[...root.querySelectorAll(kind==='policy'?'[data-policy]':'[data-alertpol]')].find(n=>(kind==='policy'?n.dataset.policy:n.dataset.alertpol)===policy.id);
    if(!card)continue;
    const resourceKey=`${kind==='policy'?'hitl':'alert'}-policy/${catalog.domainId}/${policy.id}`;
    const container=document.createElement('section');
    container.innerHTML='<button class="ghost" data-activity-toggle aria-expanded="false">Activity</button><div data-activity-panel role="status" hidden></div>';
    card.append(container);
    const button=container.querySelector('[data-activity-toggle]'),panel=container.querySelector('[data-activity-panel]');
    let generation=0,open=false;
    const live=()=>valid()&&card.isConnected&&container.isConnected;
    async function load() {
      if(!live()||!open)return;
      const request=++generation,requestCurrent=()=>live()&&open&&generation===request;
      panel.innerHTML='<p>Loading complete available activity…</p>';
      const result=await readDraftActivity({read,resourceKey,domainId:catalog.domainId,current:requestCurrent});
      if(!requestCurrent()||result?.canceled)return;
      if(result?.ok===true){panel.innerHTML=draftActivityHtml(result.events);return;}
      const forbidden=result?.status===403||result?.code==='FORBIDDEN';
      panel.innerHTML=`<p role="alert">${forbidden?'You do not have access to activity in this scope.':'Activity is unavailable. No partial history is shown.'}</p><button class="ghost" data-activity-retry>Retry activity</button>`;
      panel.querySelector('[data-activity-retry]').onclick=()=>requestCurrent()?load():undefined;
    }
    button.onclick=async()=>{
      if(!live())return;
      open=!open;generation++;panel.hidden=!open;panel.innerHTML='';button.setAttribute('aria-expanded',String(open));
      if(open)await load();
    };
  }
}
