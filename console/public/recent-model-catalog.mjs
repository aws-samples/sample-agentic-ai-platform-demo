import { RECENT_MODEL_CATALOG } from './recent-model-catalog-data.mjs';
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function recentModels(catalog = RECENT_MODEL_CATALOG) {
  return catalog.models.filter(m => m.default_eligible === true && m.eligibility_status === 'eligible'
    && m.provider_verified === true && typeof m.provider === 'string' && m.provider.trim()
    && m.runtime_supported === true && m.lifecycle === 'active'
    && /^\d{4}-\d{2}-\d{2}$/.test(m.vendor_first_release_date || '')
    && m.vendor_first_release_date >= catalog.window.start && m.vendor_first_release_date <= catalog.window.end
    && m.runtime_model_id && m.aws_source_url?.startsWith('https://docs.aws.amazon.com/') && m.releaseSource?.startsWith('https://'));
}
export function recentModelDetails(m) {
  const field=(label,value)=>`<div><dt>${label}</dt><dd style="margin:4px 0 16px;overflow-wrap:anywhere">${esc(value || 'Not established')}</dd></div>`;
  return `<section class="card" aria-label="Model details"><div class="bar" style="justify-content:space-between"><h2>${esc(m.display_name)}</h2><button class="ghost" id="regdrawerclose">Close details</button></div>
    <h3>Overview</h3><dl class="grid2">${field('Provider',m.provider)}${field('Model release',m.vendor_first_release_date)}${field('AWS catalog launch',m.bedrock_launch_date)}${field('Input',m.input_modalities.join(', '))}${field('Output',m.output_modalities.join(', '))}</dl>
    ${m.releaseNote?`<p class="d">${esc(m.releaseNote)}</p>`:''}
    <p><a href="${esc(m.releaseSource)}" target="_blank" rel="noopener noreferrer">Model release source</a> · <a href="${esc(m.aws_source_url)}" target="_blank" rel="noopener noreferrer">AWS model card</a></p>
    <h3>Platform access</h3><p>Not verified for this workspace.</p><p class="d">Listed Runtime support does not grant workspace access.</p>
    <details><summary>Technical details</summary><dl>${field('Bedrock Runtime model ID',m.runtime_model_id)}${field('Global inference profile',m.runtime_global_profile_id)}${field('Documented Runtime APIs',m.runtime_api_support_confirmed.join(', '))}</dl><p class="d">AWS catalog launch is separate from model release. The first date of Runtime support is not established.</p></details></section>`;
}
export function mountRecentModelCatalog({box,drawer,state,document:doc=globalThis.document,catalog=RECENT_MODEL_CATALOG,openAccess}) {
  const models=recentModels(catalog),providers=[...new Set(models.map(m=>m.provider))].sort();
  const q=(state.registrySearch||'').trim().toLowerCase();
  const rows=models.filter(m=>(!state.registryProvider||m.provider===state.registryProvider)&&(!q||[m.display_name,m.provider,m.runtime_model_id].some(v=>v.toLowerCase().includes(q))));
  const groups=providers.map(provider=>({provider,models:rows.filter(m=>m.provider===provider)})).filter(g=>g.models.length);
  box.innerHTML=`<h2>Recent models</h2><p class="d">Model releases: ${esc(catalog.window.start)}–${esc(catalog.window.end)} · Verified catalog selection</p>
    <div class="bar model-catalog-filters"><label for="regprovider">Provider</label><select id="regprovider"><option value="">All providers</option>${providers.map(p=>`<option value="${esc(p)}" ${state.registryProvider===p?'selected':''}>${esc(p)}</option>`).join('')}</select><button class="ghost" id="regclear">Clear filters</button></div>
    <p role="status">${models.length} models · ${rows.length} matching</p>
    ${groups.map(g=>`<section class="model-provider-group" aria-label="${esc(g.provider)}"><h3>${esc(g.provider)} <span class="d">(${g.models.length})</span></h3><table><thead><tr><th>Model</th><th>Input → output</th><th>Details</th></tr></thead><tbody>${g.models.map(m=>`<tr class="regrow" data-recent-model="${esc(m.key)}"><td>${esc(m.display_name)}</td><td>${esc(m.input_modalities.join(', '))} → ${esc(m.output_modalities.join(', '))}</td><td><button class="ghost" aria-label="View details for ${esc(m.display_name)}">View details</button></td></tr>`).join('')}</tbody></table></section>`).join('')||'<p>No matching models.</p>'}`;
  const render=()=>mountRecentModelCatalog({box,drawer,state,document:doc,catalog,openAccess});
  doc.getElementById('regprovider').onchange=event=>{state.registryProvider=event.target.value;render()};
  doc.getElementById('regclear').onclick=()=>{state.registryProvider='';state.registrySearch='';const search=doc.getElementById('regsearch');if(search)search.value='';render()};
  box.querySelectorAll('[data-recent-model]').forEach(row=>row.onclick=()=>{
    const m=models.find(m=>m.key===row.dataset.recentModel);if(!m||!drawer?.isConnected)return;
    state.recentModelKey=m.key;drawer.innerHTML=recentModelDetails(m);
    if(openAccess){
      const button=doc.createElement('button');button.className='ghost';button.textContent='Check workspace access';
      const panel=doc.createElement('div');drawer.append(button,panel);
      button.onclick=async()=>{if(button.disabled)return;button.disabled=true;await openAccess(m,panel);if(button.isConnected)button.disabled=false;};
    }
    doc.getElementById('regdrawerclose').onclick=()=>{state.recentModelKey=null;drawer.innerHTML=''};
    drawer.scrollIntoView?.({behavior:'smooth',block:'start'});
  });
  if(drawer&&state.recentModelKey&&!rows.some(m=>m.key===state.recentModelKey)){drawer.innerHTML='';state.recentModelKey=null;}
}
