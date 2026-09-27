const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function mountPolicyDraftEditor(root,{catalog,api,current,identity,requestId,dirty,confirmChange,reload}) {
 if(catalog.domainId!=='platform'||!Array.isArray(catalog.policies))return;
 const actor=identity(),valid=()=>root.isConnected&&current()&&actor===identity();
 const controls=document.createElement('section');controls.innerHTML=`<h3>Disabled policy drafts</h3><p>Save configuration only. Drafts stay disabled and do not change runtime enforcement.</p><button class="ghost" data-draft-new>Create disabled draft</button><div data-draft-form></div>`;root.append(controls);
 const formBox=controls.querySelector('[data-draft-form]');
 let editorGeneration=0;
 function open(policy=null){
  if(!valid()||!confirmChange())return;
  dirty.clear('policy');const generation=++editorGeneration;
  formBox.innerHTML=`<form data-policy-draft><h4>${policy?'Edit disabled draft':'Create disabled draft'}</h4>
   <label>Policy ID<input id="hpdid" value="${esc(policy?.id)}" ${policy?'readonly':''} required pattern="[a-z][a-z0-9-]{0,63}"></label>
   <label>Name<input id="hpdname" value="${esc(policy?.name)}" required maxlength="200"></label>
   <label>Tool patterns (one per line, * wildcard)<textarea id="hpdtools" required>${esc(policy?.toolMatch.join('\n'))}</textarea></label>
   <label>Saved intent<select id="hpdmode"><option value="require_approval">Require approval intent</option><option value="notify_only">Notification intent</option></select></label>
   <label>Scope<select id="hpdkind"><option value="domain">All projects in platform domain</option><option value="project">One platform project</option></select></label>
   <label>Project ID (only for project scope)<input id="hpdproject" value="${esc(policy?.scope.projectId)}"></label>
   <label>Reason for this change<textarea id="hpdreason" required minlength="10" maxlength="1024"></textarea></label>
   <p>Catalog revision ${catalog.revision}${policy?' · policy version '+policy.version:''}. Configuration remains disabled.</p>
   <button type="submit" data-draft-save>Save disabled draft</button><button type="button" data-draft-cancel>Cancel editing</button><p role="status" data-draft-status></p></form>`;
  const form=formBox.querySelector('form'),get=id=>form.querySelector('#'+id),status=form.querySelector('[data-draft-status]'),save=form.querySelector('[data-draft-save]');
  get('hpdmode').value=policy?.mode||'require_approval';get('hpdkind').value=policy?.scope.kind||'domain';
  const nodes=[...form.querySelectorAll('input,textarea,select')];dirty.bind('policy',nodes.map(n=>[n.id,n]));
  let pending=null,busy=false,conflicted=false;
  const formCurrent=()=>valid()&&form.isConnected&&generation===editorGeneration;
  const freeze=locked=>{for(const n of nodes)n.disabled=locked;controls.querySelector('[data-draft-new]').disabled=locked;for(const b of root.querySelectorAll('[data-draft-edit]'))b.disabled=locked};
  form.querySelector('[data-draft-cancel]').onclick=()=>{if(!formCurrent()||busy||!confirmChange())return;editorGeneration++;dirty.clear('policy');formBox.innerHTML='';freeze(false)};
  form.onsubmit=async e=>{
   e.preventDefault();if(busy||conflicted||!formCurrent())return;
   if(!pending){
    const patterns=get('hpdtools').value.split('\n').map(s=>s.trim()).filter(Boolean),kind=get('hpdkind').value;
    const body={operation:policy?'update':'create',expectedRevision:catalog.revision,expectedPolicyVersion:policy?.version??null,policy:{id:get('hpdid').value.trim(),name:get('hpdname').value.trim(),toolMatch:patterns,mode:get('hpdmode').value,scope:kind==='project'?{kind,projectId:get('hpdproject').value.trim()}:{kind}},reason:get('hpdreason').value.trim()};
    if(!/^[a-z][a-z0-9-]{0,63}$/.test(body.policy.id)||!body.policy.name||patterns.length<1||patterns.length>50||patterns.some(p=>p.length>200)||body.reason.length<10||body.reason.length>1024||(kind==='project'&&!/^[a-z][a-z0-9-]{0,63}$/.test(body.policy.scope.projectId))){status.textContent='Enter a valid policy ID, name, patterns, scope and a reason of 10–1024 characters.';return}
    pending={body,id:requestId()};
   }
   busy=true;save.disabled=true;freeze(true);status.textContent='Saving disabled configuration…';
   try{
    const r=await api('/governance/policy-drafts',pending.body,{requestId:pending.id});if(!formCurrent())return;
    if(r?.ok===true&&r.saved===true&&r.enforcement==='NOT_CONFIGURED'){
     dirty.clear('policy');pending=null;await reload();return;
    }
    if(r?.code==='CONFLICT'){
     conflicted=true;status.textContent='Catalog or policy changed. No overwrite was made. Keep your text and refresh to review the latest revision before saving again.';pending=null;freeze(false);save.disabled=true;return;
    }
    if(['FORBIDDEN','INVALID_REQUEST','INVALID_BODY','HITL_POLICY_NOT_CONFIGURED'].includes(r?.code)){
     status.textContent=r.code==='FORBIDDEN'?'You cannot save drafts in this scope.':'Draft was not saved. Check the fields and current catalog.';pending=null;freeze(false);return;
    }
    status.textContent='Save result is unknown. Retry this exact request to check completion; do not create a second request.';save.textContent='Retry same draft save';
   }catch{
    if(formCurrent()){status.textContent='Save result is unknown. Retry this exact request to check completion; do not create a second request.';save.textContent='Retry same draft save'}
   }finally{busy=false;if(formCurrent()&&!conflicted)save.disabled=false}
  };
 }
 controls.querySelector('[data-draft-new]').onclick=()=>open();
 for(const policy of catalog.policies){if(policy.enabled!==false)continue;const article=[...root.querySelectorAll('[data-policy]')].find(e=>e.dataset.policy===policy.id);if(!article)continue;const b=document.createElement('button');b.className='ghost';b.textContent='Edit disabled draft';b.dataset.draftEdit=policy.id;b.onclick=()=>open(policy);article.append(b)}
}
