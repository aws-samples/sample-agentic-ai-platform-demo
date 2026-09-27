const esc = v => String(v ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const labels = {pending_domain:'Domain review',pending_platform:'Platform review',approved:'Approved',rejected:'Rejected',revoked:'Revoked',expired:'Expired'};

export async function mountGuardrailExceptions(box, { api, read, projects, identity, current, requestId, controls, viewer = {} }) {
  const scope = identity();
  const valid = () => current() && box.isConnected && scope === identity();
  const rows = [];
  let cursor;
  const seen = new Set();
  do {
    const result = await read('/policy-exemptions?limit=50'+(cursor?'&cursor='+encodeURIComponent(cursor):''));
    if (!valid()) return;
    if (result?.ok !== true || !Array.isArray(result.exemptions) || result.exemptions.some(r=>!r.id||!labels[r.status])) {
      box.innerHTML='<div class="status err" role="alert" data-read-state="error">Exception requests could not be loaded. <button class="ghost" data-exception-retry>Retry</button></div>';
      const retry=box.querySelector('[data-exception-retry]');
      if(retry)retry.onclick=()=>mountGuardrailExceptions(box,{api,read,projects,identity,current,requestId,controls,viewer});
      return;
    }
    rows.push(...result.exemptions);
    cursor=result.cursor;
    if(cursor && (seen.has(cursor)||seen.size>=100))throw new Error('Exception pagination failed');
    if(cursor)seen.add(cursor);
  } while(cursor);
  box.innerHTML=`<div class="console-resource-header"><div><h2>Guardrail exceptions <span class="chip">${rows.length}</span></h2>
    <p>Time-limited requests with compensating controls and independent review.</p></div>
    <button class="primary" data-exception-new>Request exception</button></div>
    <div data-exception-form></div>
    <div class="bar"><label for="exception-status" style="margin:0">Status</label><select id="exception-status" style="max-width:220px"><option value="">All statuses</option>${Object.entries(labels).map(([s,l])=>`<option value="${s}">${l}</option>`).join('')}</select>
    <input aria-label="Find an exception" data-exception-search placeholder="Find by project, guardrail or request ID" style="max-width:360px"></div>
    <div data-exception-rows></div><div data-exception-detail></div>`;
  const reload=()=>mountGuardrailExceptions(box,{api,read,projects,identity,current,requestId,controls,viewer});
  const table=box.querySelector('[data-exception-rows]');
  const draw=()=>{
    const status=box.querySelector('#exception-status').value;
    const search=box.querySelector('[data-exception-search]').value.toLowerCase();
    const filtered=rows.filter(r=>(!status||r.status===status)&&`${r.id} ${r.projectId} ${r.guardrailId}`.toLowerCase().includes(search));
    table.innerHTML=filtered.length?`<div class="console-table-wrap"><table class="console-resource-table"><thead><tr><th>Request</th><th>Project</th><th>Status</th><th>Expires</th><th></th></tr></thead><tbody>${filtered.map(r=>`<tr><td><b>${esc(controls.find(c=>c.id===r.guardrailId)?.name||r.guardrailId)}</b><div class="d">${esc(r.id)}</div></td><td>${esc(r.projectId)}<div class="d">${esc(r.domainId)}</div></td><td><span class="badge ${r.status.startsWith('pending')?'badge-orange':'badge-grey'}">${labels[r.status]}</span></td><td>${esc(r.expiresAt.slice(0,10))}</td><td><button class="ghost" data-exception-open="${esc(r.id)}">Review details</button></td></tr>`).join('')}</tbody></table></div>`
      :`<div class="empty"><b>${rows.length?'No requests match your filters':'No exception requests'}</b><p>${rows.length?'Change the status or search text.':'Request an exception for a configurable control when a project needs a time-limited change. Mandatory controls remain protected.'}</p></div>`;
    table.querySelectorAll('[data-exception-open]').forEach(button=>button.onclick=()=>detail(rows.find(r=>r.id===button.dataset.exceptionOpen)));
  };
  const detail=row=>{
    const target=box.querySelector('[data-exception-detail]');
    const canReview = ['admin','lead'].includes(viewer.role) && viewer.actor !== row.requesterSubject
      && (row.status === 'pending_domain' || (viewer.role === 'admin' && (row.status === 'approved' || (row.status === 'pending_platform' && viewer.actor !== row.domainApproverSubject))));
    target.innerHTML=`<section class="console-request-detail"><div class="console-resource-header"><h2>Request details</h2><button class="ghost" data-exception-close>Close</button></div>
      <dl><dt>Request ID</dt><dd>${esc(row.id)}</dd><dt>Project</dt><dd>${esc(row.domainId)} / ${esc(row.projectId)}</dd><dt>Requested by</dt><dd>${esc(row.requesterSubject)}</dd>
      <dt>Reason</dt><dd>${esc(row.reason)}</dd><dt>Compensating controls</dt><dd>${esc(row.compensatingControls)}</dd><dt>Expires</dt><dd>${esc(row.expiresAt)}</dd></dl>
      ${row.status==='approved'?'<p class="status info">Approved for the recorded scope and period. Apply any configuration change through the project’s governed delivery pipeline.</p>':''}
      <h3>Decision history</h3>${row.history.map(h=>`<p><b>${esc(h.action)}</b> · ${esc(h.timestamp)}<br>${esc(h.reason)}<br><span class="d">${esc(h.actor)}</span></p>`).join('')}
      ${canReview?`<label for="exception-decision-reason">Decision reason</label><textarea id="exception-decision-reason" rows="3" placeholder="Explain your decision and any conditions"></textarea>
      <div class="bar">${row.status==='approved'?'<button class="ghost" data-exception-decision="revoke">Revoke approval</button>':'<button class="primary" data-exception-decision="approve">Approve</button><button class="ghost" data-exception-decision="reject">Reject</button>'}</div>`:''}
      <p role="status" data-exception-decision-status></p></section>`;
    target.querySelector('[data-exception-close]').onclick=()=>target.replaceChildren();
    target.scrollIntoView({block:'nearest',behavior:'smooth'});
    target.querySelectorAll('[data-exception-decision]').forEach(button=>button.onclick=async()=>{
      if(!valid()||button.disabled)return;
      const reason=target.querySelector('#exception-decision-reason').value.trim();
      const status=target.querySelector('[data-exception-decision-status]');
      if(reason.length<10){status.textContent='Enter a decision reason of at least 10 characters.';return;}
      target.querySelectorAll('button').forEach(b=>b.disabled=true);
      try{
        const r=await api('/policy-exemption-decide',{domainId:row.domainId,id:row.id,decision:button.dataset.exceptionDecision,reason},{requestId:requestId()});
        if(!valid())return;
        if(r?.ok===true){await reload();return;}
        status.textContent=r?.code==='FORBIDDEN'?'A different eligible reviewer must make this decision.':'Decision was not confirmed. Refresh the request before retrying.';
      }catch{if(valid())status.textContent='Decision was not confirmed. Refresh the request before retrying.';}
      if(valid())target.querySelector('[data-exception-close]').disabled=false;
    });
  };
  box.querySelector('#exception-status').onchange=draw;
  box.querySelector('[data-exception-search]').oninput=draw;
  draw();
  box.querySelector('[data-exception-new]').onclick=async()=>{
    const target=box.querySelector('[data-exception-form]');
    target.innerHTML='<p role="status">Loading your projects…</p>';
    const result=await projects();
    if(!valid())return;
    if(result?.ok!==true||!Array.isArray(result.items)){target.innerHTML='<p role="alert">Projects could not be loaded. Try again.</p>';return;}
    if(!result.items.length){target.innerHTML='<p class="status info">Create a project in your domain before requesting an exception.</p>';return;}
    target.innerHTML=`<form class="console-request-detail"><h3>Request a guardrail exception</h3>
      <label for="exception-project">Project</label><select id="exception-project">${result.items.map(p=>`<option value="${esc(p.domainId+'/'+p.id)}">${esc(p.name||p.id)} · ${esc(p.domainId)}</option>`).join('')}</select>
      <label for="exception-control">Guardrail</label><select id="exception-control">${controls.filter(c=>!c.mandatory).map(c=>`<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('')}</select>
      <p class="d">Mandatory controls are not eligible for exceptions.</p>
      <label for="exception-reason">Business reason</label><textarea id="exception-reason" required minlength="10" maxlength="2000"></textarea>
      <label for="exception-compensation">Compensating controls</label><textarea id="exception-compensation" required minlength="10" maxlength="2000"></textarea>
      <label for="exception-expiry">Expires (within 30 days)</label><input id="exception-expiry" type="datetime-local" required>
      <div class="bar"><button class="primary" type="submit">Submit request</button><button class="ghost" type="button" data-exception-cancel>Cancel</button></div><p role="status" data-exception-status></p></form>`;
    target.querySelector('[data-exception-cancel]').onclick=()=>target.replaceChildren();
    const request=requestId();
    target.querySelector('form').onsubmit=async event=>{
      event.preventDefault();if(!valid())return;
      const [domainId,projectId]=target.querySelector('#exception-project').value.split('/');
      const expiration=new Date(target.querySelector('#exception-expiry').value);
      const status=target.querySelector('[data-exception-status]');
      if(!Number.isFinite(expiration.getTime())){status.textContent='Choose a valid expiration.';return;}
      const button=target.querySelector('[type=submit]');button.disabled=true;
      try{
        const r=await api('/policy-exemption-request',{domainId,projectId,guardrailId:target.querySelector('#exception-control').value,
          reason:target.querySelector('#exception-reason').value.trim(),compensatingControls:target.querySelector('#exception-compensation').value.trim(),expiresAt:expiration.toISOString()},{requestId:request});
        if(!valid())return;
        if(r?.ok===true){await reload();return;}
        status.textContent=r?.code==='INVALID_REQUEST'?'Check the reason, compensating controls and expiration (up to 30 days).':'Request was not confirmed. Refresh before submitting again.';
      }catch{if(valid())status.textContent='Request was not confirmed. Refresh before submitting again.';}
      if(valid())button.disabled=false;
    };
  };
}
