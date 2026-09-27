const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function mountAlertDraftEditor(root,{catalog,api,current,identity,requestId,dirty,confirmChange,reload}) {
 if(catalog.domainId!=='platform'||!Array.isArray(catalog.policies))return;
 const actor=identity(),valid=()=>root.isConnected&&current()&&actor===identity();
 const controls=document.createElement('section');controls.innerHTML=`<h3>Disabled alert drafts</h3><p>Save configuration only. Drafts stay disabled. Metrics and thresholds are descriptions, not evaluated alarms. RACI notes do not assign directory roles or notification recipients.</p><button class="ghost" data-draft-new>Create disabled alert draft</button><div data-draft-form></div>`;root.append(controls);
 const formBox=controls.querySelector('[data-draft-form]');
 let editorGeneration=0;
 function open(policy=null){
  if(!valid()||!confirmChange())return;
  dirty.clear('alertPolicy');const generation=++editorGeneration;
  formBox.innerHTML=`<form data-policy-draft><h4>${policy?'Edit disabled alert draft':'Create disabled alert draft'}</h4>
   <label>Alert ID<input id="apdid" value="${esc(policy?.id)}" ${policy?'readonly':''} required pattern="[a-z][a-z0-9-]{0,63}"></label>
   <label>Name<input id="apdname" value="${esc(policy?.name)}" required maxlength="200"></label>
   <label>Metric description<input id="apdmetric" value="${esc(policy?.metric)}" required maxlength="200"></label>
   <label>Threshold description<input id="apdthreshold" value="${esc(policy?.threshold)}" required maxlength="500"></label>
   <label>Severity intent<select id="apdseverity"><option>SEV1</option><option>SEV2</option><option>SEV3</option></select></label>
   <label>Owner note (optional)<input id="apdowner" value="${esc(policy?.owner)}" maxlength="200"></label>
   <label>Runbook reference (optional, not fetched)<input id="apdrunbook" value="${esc(policy?.runbook)}" maxlength="500"></label>
   ${['responsible','accountable','consulted','informed'].map(key=>`<label>${key[0].toUpperCase()+key.slice(1)} note (optional)<input id="apd${key}" value="${esc(policy?.raci?.[key])}" maxlength="200"></label>`).join('')}
   <label>Reason for this change<textarea id="apdreason" required minlength="10" maxlength="1024"></textarea></label>
   <p>Catalog revision ${catalog.revision}${policy?' · policy version '+policy.version:''}. Configuration remains disabled.</p>
   <button type="submit" data-draft-save>Save disabled alert draft</button><button type="button" data-draft-cancel>Cancel editing</button><p role="status" data-draft-status></p></form>`;
  const form=formBox.querySelector('form'),get=id=>form.querySelector('#'+id),status=form.querySelector('[data-draft-status]'),save=form.querySelector('[data-draft-save]');
  get('apdseverity').value=policy?.severity||'SEV3';
  const nodes=[...form.querySelectorAll('input,textarea,select')];dirty.bind('alertPolicy',nodes.map(n=>[n.id,n]));
  let pending=null,busy=false,conflicted=false;
  const formCurrent=()=>valid()&&form.isConnected&&generation===editorGeneration;
  const freeze=locked=>{for(const n of nodes)n.disabled=locked;controls.querySelector('[data-draft-new]').disabled=locked;for(const b of root.querySelectorAll('[data-draft-edit]'))b.disabled=locked};
  form.querySelector('[data-draft-cancel]').onclick=()=>{if(!formCurrent()||busy||!confirmChange())return;editorGeneration++;dirty.clear('alertPolicy');formBox.innerHTML='';freeze(false)};
  form.onsubmit=async e=>{
   e.preventDefault();if(busy||conflicted||!formCurrent())return;
   if(!pending){
    const body={operation:policy?'update':'create',expectedRevision:catalog.revision,expectedPolicyVersion:policy?.version??null,policy:{id:get('apdid').value.trim(),name:get('apdname').value.trim(),metric:get('apdmetric').value.trim(),threshold:get('apdthreshold').value.trim(),severity:get('apdseverity').value,owner:get('apdowner').value.trim(),runbook:get('apdrunbook').value.trim(),raci:Object.fromEntries(['responsible','accountable','consulted','informed'].map(key=>[key,get('apd'+key).value.trim()]))},reason:get('apdreason').value.trim()};
    if(!/^[a-z][a-z0-9-]{0,63}$/.test(body.policy.id)||!body.policy.name||!body.policy.metric||!body.policy.threshold||body.reason.length<10||body.reason.length>1024){status.textContent='Enter a valid alert ID, name, metric, threshold and a reason of 10–1024 characters.';return}
    pending={body,id:requestId()};
   }
   busy=true;save.disabled=true;freeze(true);status.textContent='Saving disabled configuration…';
   try{
    const r=await api('/governance/alert-drafts',pending.body,{requestId:pending.id});if(!formCurrent())return;
    if(r?.ok===true&&r.saved===true&&r.evaluation==='NOT_CONFIGURED'&&r.delivery==='NOT_CONFIGURED'){
     dirty.clear('alertPolicy');pending=null;await reload();return;
    }
    if(r?.code==='CONFLICT'){
     conflicted=true;status.textContent='Catalog or policy changed. No overwrite was made. Keep your text and refresh to review the latest revision before saving again.';pending=null;freeze(false);save.disabled=true;return;
    }
    if(['FORBIDDEN','INVALID_REQUEST','INVALID_BODY'].includes(r?.code)){
     status.textContent=r.code==='FORBIDDEN'?'You cannot save drafts in this scope.':'Draft was not saved. Check the fields and current catalog.';pending=null;freeze(false);return;
    }
    status.textContent='Save result is unknown. Retry this exact request to check completion; do not create a second request.';save.textContent='Retry same draft save';
   }catch{
    if(formCurrent()){status.textContent='Save result is unknown. Retry this exact request to check completion; do not create a second request.';save.textContent='Retry same draft save'}
   }finally{busy=false;if(formCurrent()&&!conflicted)save.disabled=false}
  };
 }
 controls.querySelector('[data-draft-new]').onclick=()=>open();
 for(const policy of catalog.policies){if(policy.enabled!==false)continue;const article=[...root.querySelectorAll('[data-alertpol]')].find(e=>e.dataset.alertpol===policy.id);if(!article)continue;const b=document.createElement('button');b.className='ghost';b.textContent='Edit disabled alert draft';b.dataset.draftEdit=policy.id;b.onclick=()=>open(policy);article.append(b)}
}
export function validAlertCatalogResponse(r){
 return r?.ok===true&&r.schemaVersion===1&&r.domainId==='platform'&&r.source==='workspace-alert-policy-catalog'&&typeof r.configured==='boolean'&&Number.isSafeInteger(r.revision)&&(r.configured?r.revision>0:r.revision===0)&&(r.configured?typeof r.updatedAt==='string'&&Number.isFinite(Date.parse(r.updatedAt)):r.updatedAt===null)&&r.cursor===null&&r.evaluation==='NOT_CONFIGURED'&&r.delivery==='NOT_CONFIGURED'&&!r.partial&&!r.incomplete&&r.complete!==false&&!r.errors?.length&&Array.isArray(r.policies)&&r.policies.length<=100&&(!r.configured?r.policies.length===0:r.policies.every(p=>p&&typeof p.id==='string'&&typeof p.name==='string'&&Number.isSafeInteger(p.version)&&p.version>0&&typeof p.enabled==='boolean'&&['SEV1','SEV2','SEV3'].includes(p.severity)&&['metric','threshold','severity','owner','runbook','createdAt'].every(k=>typeof p[k]==='string')&&p.raci&&['responsible','accountable','consulted','informed'].every(k=>typeof p.raci[k]==='string')))&&new Set(r.policies.map(p=>p.id)).size===r.policies.length;
}
export function alertCatalogHtml(r){
 const value=x=>esc(x||'Not specified');
 return `<p>Platform configuration · ${r.configured?'Catalog revision '+r.revision:'No catalog configured yet'}. Evaluation: Not configured. Notification delivery: Not configured.</p><button class="ghost" data-alert-refresh>Refresh alert configuration</button>`+(r.policies.map(p=>`<article class="item" data-alertpol="${esc(p.id)}"><h4>${esc(p.name)}</h4><p>Configuration ${p.enabled?'enabled':'disabled'} · ${esc(p.severity)} intent · version ${p.version}</p><dl><dt>Metric description</dt><dd>${esc(p.metric)}</dd><dt>Threshold description</dt><dd>${esc(p.threshold)}</dd><dt>Owner note</dt><dd>${value(p.owner)}</dd><dt>Runbook reference</dt><dd>${value(p.runbook)}</dd></dl></article>`).join('')||'<p>No saved alert drafts. Create explicitly to initialize this platform catalog.</p>');
}
export function alertRaciHtml(r){
 return '<p>Draft responsibility notes only. These do not assign access, contact recipients or prove notification delivery.</p>'+r.policies.map(p=>`<article data-raci="${esc(p.id)}"><h4>${esc(p.name)}</h4><dl>${['responsible','accountable','consulted','informed'].map(k=>`<dt>${k}</dt><dd>${esc(p.raci[k]||'Not specified')}</dd>`).join('')}</dl></article>`).join('');
}
