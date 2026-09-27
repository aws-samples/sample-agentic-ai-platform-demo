import {defaultEvaluation} from './evaluation-config.mjs';
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function evaluationSetupHtml(value=defaultEvaluation()){
 const d=value.dataset,e=value.evaluator;
 const options=(rows,selected)=>rows.map(([id,label])=>`<option value="${id}" ${id===selected?'selected':''}>${label}</option>`).join('');
 return `<section aria-label="Evaluation setup"><p>Optional for export. Configure now or edit the generated files during local development. Business evaluation has not run.</p>
 <div class="grid2"><div><label for="eval-dataset">Dataset</label><select id="eval-dataset">${options([['later','Configure later'],['blueprint','Use blueprint starter cases'],['upload','Upload my JSONL dataset'],['reference','Reference a private S3 dataset']],d.source)}</select>
 ${d.source==='upload'?`<label for="eval-upload">JSONL file · up to 200 cases / 24 KB</label><input id="eval-upload" type="file" accept=".jsonl,.json,application/json"/><p>${d.content?`${d.content.trim().split('\n').length} cases loaded. Dataset contents will be included in GitHub.`:'Each line: {"id":"case-1","input":"request","expected":"optional expected text"}'}</p>`:''}
 ${d.source==='reference'?`<label for="eval-reference">S3 URI</label><input id="eval-reference" value="${esc(d.reference)}" placeholder="s3://your-bucket/evaluation/cases.jsonl"/><p>Only the reference is exported. Fetch privately in your own execution environment.</p>`:''}
 ${d.source==='blueprint'?'<p>Uses the blueprint dataset when supplied, otherwise a platform starter case. These are examples to replace with business acceptance cases.</p>':''}</div>
 <div><label for="eval-evaluator">Evaluator</label><select id="eval-evaluator">${options([['later','Configure later'],['builtin','Expected-text check'],['python','My Python evaluator'],['agentcore','AgentCore evaluator']],e.type)}</select>
 ${e.type==='python'?`<label for="eval-code-upload">Upload evaluator.py</label><input id="eval-code-upload" type="file" accept=".py"/><label for="eval-code">Or edit evaluator source</label><textarea id="eval-code" rows="6" spellcheck="false">${esc(e.code)}</textarea><p>Interface: evaluate(case, result) → score (0–1), reason. Code is exported for execution in your runner; the platform does not execute it.</p>`:''}
 ${e.type==='agentcore'?`<label for="eval-agentcore-id">Built-in or custom evaluator ID</label><input id="eval-agentcore-id" value="${esc(e.id)}" placeholder="Builtin.Helpfulness"/><p>Exports an on-demand evaluation adapter. Requires actual Agent traces, AWS access and a configured evaluator after development. No resources are provisioned here.</p>`:''}</div></div>
 <p id="eval-error" role="alert"></p><details><summary>What evaluation files will be exported</summary><p>Configuration, dataset or private reference, Python Agent/evaluator adapters, pytest runner, CI workflow and instructions. Missing configuration remains NOT_CONFIGURED and cannot count as a passing evaluation.</p></details></section>`;
}
export function wireEvaluationSetup({document,get,set,render}){
 const el=id=>document.getElementById(id);
 const change=(section,key,value,repaint=false)=>{const next=structuredClone(get());next[section][key]=value;set(next);if(repaint)render();};
 if(el('eval-dataset'))el('eval-dataset').onchange=e=>{const next=structuredClone(get());next.dataset={source:e.target.value};set(next);render();};
 if(el('eval-evaluator'))el('eval-evaluator').onchange=e=>{const next=structuredClone(get());next.evaluator={type:e.target.value};set(next);render();};
 for(const [id,section,key] of [['eval-reference','dataset','reference'],['eval-code','evaluator','code'],['eval-agentcore-id','evaluator','id']])if(el(id))el(id).oninput=e=>change(section,key,e.target.value);
 for(const [id,section,key,limit] of [['eval-upload','dataset','content',24000],['eval-code-upload','evaluator','code',16000]])if(el(id))el(id).onchange=async e=>{const file=e.target.files?.[0];if(!file)return;const previous=get();try{if(file.size>limit)throw Error('File exceeds the upload limit.');const text=await file.text();if(previous!==get())return;change(section,key,text,true);}catch(error){if(previous===get()&&el('eval-error'))el('eval-error').textContent=error.message;}};
}
