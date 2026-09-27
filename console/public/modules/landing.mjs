// Public conceptual content from the accepted console. No identity or resource state.
export const GOLDEN_PATH = [
  { id:'login', label:'Login', full:'Login — identity from your IdP', own:'plat', view:null,
    story:'Every session starts at the company IdP. Role and domain are resolved server-side — the console never trusts the client.',
    plat:['SSO federation: Okta / Entra ID / Cognito', 'Server-issued session token on every API call', 'Role & domain resolved from the directory'],
    dom:['Sign in with your normal company account'] },
  { id:'blueprint', label:'Blueprint', full:'Select an approved Blueprint', own:'plat', view:'blueprints',
    story:'The paved road starts with a versioned, registry-governed template — framework and hosting are choices, not projects.',
    plat:['Curated blueprint library, versioned in the AI Registry', 'Framework × hosting compatibility matrix', 'Foundation Harness baked in: identity · memory · observability · guardrails'],
    dom:['Pick the template that fits the use case'] },
  { id:'compose', label:'Compose', full:'Compose the Domain Harness', own:'dom', view:'compose',
    story:'The domain team adds only what is theirs: a persona and approved parts. Nobody re-solves identity, memory or ops.',
    plat:['Approved skills, tools, MCP servers and models to reuse', 'Project scaffolding generated from the blueprint'],
    dom:['Persona and instructions', 'Pick domain skills, tools and knowledge', 'Own the generated code'] },
  { id:'evaluate', label:'Evaluate', full:'Evaluate — the promotion gate', own:'both', view:'fleet',
    story:'A golden-dataset eval scores the agent before anyone approves it. Evidence, not vibes.',
    plat:['Eval pipeline and scoring infrastructure', 'Results recorded as promotion evidence'],
    dom:['Author the golden dataset', 'Decide the quality bar for their agents'] },
  { id:'approve', label:'Approve', full:'Approve — governance decides', own:'plat', view:'governance',
    story:'One approval queue for every resource type. Versioned entries move DRAFT → IN_REVIEW → APPROVED with a full audit trail.',
    plat:['Approval queue, policies and audit trail', 'Automated checks bounce bad versions before a human looks'],
    dom:['Domain lead reviews own-domain requests'] },
  { id:'deploy', label:'Deploy', full:'Deploy to managed runtime', own:'dom', view:'compose',
    story:'One click to AgentCore — runtime, memory and identity provisioned together. The agent registers itself back into the platform.',
    plat:['Managed runtimes: AgentCore · EKS · Lambda · Fargate', 'GitHub graduation path for the generated repo'],
    dom:['Ship when ready — deploys are self-service'] },
  { id:'operate', label:'Agent Fleet', full:'Operate the running fleet', own:'dom', view:'fleet',
    story:'Domain teams run their own agents on a single pane of glass the platform keeps for everyone.',
    plat:['Fleet view over every deployed agent', 'Cost attribution per agent and domain'],
    dom:['Operate own-domain agents day to day', 'Act on health and spend'] },
  { id:'observe', label:'Observe', full:'Observe — scoped by role', own:'both', view:'observability',
    story:'Builders drill into their own-domain traces; the platform team sees health, cost and quality aggregates — never payloads.',
    plat:['High-level metrics, SLOs and alerting', 'Time-boxed, audited trace-access grants'],
    dom:['Own-domain traces and memory (with approval)', 'Per-agent online quality trends'] },
  { id:'improve', label:'Improve', full:'Improve — close the loop', own:'dom', view:'observability',
    story:'Online eval samples production traffic continuously. Findings feed the next compose — the loop is the product.',
    plat:['Online evaluation sampled from real invocations', 'Quality trends wired into observability'],
    dom:['Iterate on persona, skills and dataset', 'Re-run the gate and promote a new version'] },
]
export const JOURNEYS = {
  admin: { label:'Platform Admin', tag:'govern the paved road', steps:[
    { label:'Sign in', story:'SSO through the company IdP — the admin role and all-domain scope come from the directory, never from the client.', view:null },
    { label:'Governance', story:'One approval queue across every governed type, plus policies, RBAC, alert definitions and the audit trail.', view:'governance' },
    { label:'AI Registry', story:'Approve versioned entries: the default-version pointer advances while pinned consumers stay put.', view:'registry' },
    { label:'Domains', story:'Vend a new domain in one form — namespace, eval pipeline, observability scope and cost bucket, ready for its first builder.', view:'domains' },
    { label:'Agent Fleet', story:'Single pane of glass over every deployed agent, across all domains, live from the runtime.', view:'fleet' },
    { label:'Cost', story:'Per-domain chargeback against the vended token budget — spend derives from real invocations.', view:'cost' },
    { label:'Observe', story:'Aggregates only: health, cost, quality. Trace payloads need a domain-lead grant — the admin sees grant metadata, never content.', view:'monitoring' },
  ]},
  builder: { label:'Domain Builder', tag:'build on the paved road', steps:[
    { label:'Sign in', story:'Same IdP, different seat: the session resolves to a builder role scoped to one domain.', view:null },
    { label:'Blueprints', story:'Pick an approved, versioned template — framework and hosting are choices on a compatibility matrix, not projects.', view:'blueprints' },
    { label:'Compose & deploy', story:'Add a persona and approved skills, tools and MCP servers; one click deploys to a managed runtime and the agent registers back.', view:'compose' },
    { label:'Eval gate', story:'Run the golden dataset against the deployed agent — the scored run lands on the agent page as promotion evidence.', view:'fleet' },
    { label:'Agent Fleet', story:'Run your own domain’s agents day to day: health, cost, integration endpoints.', view:'fleet' },
    { label:'Observe & improve', story:'Own-domain traces (masked until a lead grants access) and the online-eval trend that feeds the next version.', view:'observability' },
  ]},
  lead: { label:'Domain Lead', tag:'approve for your domain', steps:[
    { label:'Sign in', story:'A builder’s nav with one extra duty: the domain’s approval queue.', view:null },
    { label:'Approvals', story:'Time-boxed trace-access requests from your own domain’s builders — requester and approver can never be the same person.', view:'governance' },
    { label:'AI Registry', story:'Own-domain submissions move DRAFT → IN_REVIEW → APPROVED with auto-checks running before any human review.', view:'registry' },
    { label:'Agent Fleet', story:'Watch the domain fleet: health badges, blueprint-upgrade drift, suspension states.', view:'fleet' },
    { label:'Cost', story:'Domain spend against the vended budget — the same numbers the platform admin charges back.', view:'cost' },
  ]},
  user: { label:'End User', tag:'consume what is approved', steps:[
    { label:'Sign in', story:'Sign in with your identity provider to access approved agents.', view:null },
    { label:'Pick an agent', story:'The catalog shows exactly the agents governance approved — DRAFT agents do not exist for this seat.', view:'fleet' },
    { label:'Chat', story:'A real streamed answer from the deployed runtime, greeting the signed-in user by name.', view:'fleet' },
    { label:'Behind the scenes', story:'Every message rides the Foundation Harness below — identity, guardrails, tools, memory, response.', view:null },
  ]},
}
const GP_D = 'M 80 80 H 890 Q 948 80 948 160 Q 948 240 890 240 H 96'
const GP_POS = [[80,80],[270,80],[460,80],[650,80],[840,80],[840,240],[592,240],[344,240],[96,240]]
const TF_TRACK = 'M 30 110 H 300 C 430 110 450 50 560 50 H 660 C 790 50 810 110 900 110'
const TF_BRANCH = 'M 300 110 C 430 110 450 170 560 170 H 660 C 790 170 810 110 900 110'
const TF_NODES = [
  [110,110,'End user','signed-in identity'],
  [300,110,'Agent','harness: guardrails · identity · obs'],
  [610,50,'Tools','approved skills · MCP'],
  [610,170,'Memory','session + long-term'],
  [900,110,'Response','streamed · scored by online eval'],
]
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({
  '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;',
}[char]))
const number = i => String(i + 1).padStart(2, '0')

function goldenPanel(i){
  const stage=GOLDEN_PATH[i]
  return `<h3>${number(i)} · ${esc(stage.full)}</h3><p>${esc(stage.story)}</p>
    <div class="landing-ownership"><section><h4>Platform provides</h4><ul>${stage.plat.map(x=>`<li>${esc(x)}</li>`).join('')}</ul></section>
    <section><h4>Domain team owns</h4><ul>${stage.dom.map(x=>`<li>${esc(x)}</li>`).join('')}</ul></section></div>`
}
function invocationHtml(){
  return `<section id="invocation"><h3>Example invocation</h3>
    <svg class="tf-svg" viewBox="0 0 1000 220" role="img" aria-label="End user to agent, through tools and memory, to response">
      <path class="tf-path" data-motion-track d="${TF_TRACK}"/><path class="tf-path" d="${TF_BRANCH}"/>
      <path class="gp-flow" d="${TF_TRACK}"/><path class="gp-flow" d="${TF_BRANCH}"/>
      ${TF_NODES.map(([x,y,label,sub])=>`<g class="tf-node" transform="translate(${x},${y})"><rect x="-78" y="-25" width="156" height="50" rx="10"/><text y="-3" text-anchor="middle">${label}</text><text class="tsub" y="14" text-anchor="middle">${sub}</text></g>`).join('')}
      <circle class="tf-pulse" data-motion-dot r="5" cx="30" cy="110"/>
    </svg><ol class="landing-trace-list">${TF_NODES.map(([, ,label,sub])=>`<li><b>${label}</b><span>${sub}</span></li>`).join('')}</ol>
    <p>End user → Agent → Tools and Memory (parallel branches) → Response</p></section>`
}
function journeyPanel(role,step){
  const journey=JOURNEYS[role]
  const selected=journey.steps[step]
  return `<p>${esc(journey.tag)}</p><p class="landing-scroll-hint">Step ${step+1} of ${journey.steps.length} · Swipe or use arrow keys to see all steps ↔</p>
    <div class="jm-steps" role="group" aria-label="${journey.label} story steps">
      <div class="jm-line" aria-hidden="true"><div class="jm-fill"></div></div>
      ${journey.steps.map((item,i)=>`<button type="button" class="jm-node ${step===i?'sel':''}" data-jstep="${i}" aria-pressed="${step===i}" aria-controls="landing-story-detail"><span class="jm-dot">${number(i)}</span><span class="jl">${esc(item.label)}</span></button>`).join('')}
    </div><div class="landing-detail" id="landing-story-detail" aria-live="polite"><h3>${number(step)} · ${esc(selected.label)}</h3><p>${esc(selected.story)}</p></div>
    ${role==='user'?invocationHtml():''}`
}
export function landingHtml(signInHtml){
  return `<div class="landing" id="public-overview">
    <a class="landing-skip" href="#landing-signin">Skip to sign in</a>
    <div class="landing-intro"><section><p class="landing-eyebrow">Platform overview</p><h1>A shared foundation for agentic AI</h1>
      <p class="landing-lead">Central control plane · self-service domain teams</p>
      <p>blueprints, approved catalog, compose-to-deploy wizard</p><p>Approved agents, ready to use.</p>
      <nav class="landing-links" aria-label="Public overview"><a href="#goldenpath">Golden path</a><a href="#journeys">Journeys</a><a href="#maturity">Maturity</a><a href="#landing-roadmap">Full roadmap</a></nav>
    </section><section class="card landing-signin" id="landing-signin" tabindex="-1" aria-label="Sign in to your console"><h2>Sign in to your console</h2><p>Use your identity provider to access your authorized workspace.</p>${signInHtml}</section></div>
    <p class="public-note">Explore example workflows and reference architectures.</p>
    <div class="landing-motion"><span id="landing-motion-status" role="status">Animation playing</span><div><button type="button" class="ghost" id="landing-pause" aria-pressed="false">Pause animation</button></div></div>
    <section class="card" id="goldenpath"><h2>Example workflow</h2>
      <svg class="gp-svg" viewBox="0 0 1000 320" aria-hidden="true"><path class="gp-path" data-motion-track d="${GP_D}"/><path class="gp-flow" d="${GP_D}"/>
        ${GOLDEN_PATH.map((s,i)=>{const [x,y]=GP_POS[i];return `<g class="gstage ${s.own} ${i===0?'sel':''}" data-gvisual="${i}" transform="translate(${x},${y})"><circle r="17"/><text class="gnum" y="4" text-anchor="middle">${number(i)}</text><text y="40" text-anchor="middle">${esc(s.label)}</text></g>`}).join('')}
        <circle class="gp-pulse" data-motion-dot r="5" cx="80" cy="80"/>
      </svg><div class="landing-stages" role="group" aria-label="Golden path stages">${GOLDEN_PATH.map((s,i)=>`<button type="button" class="ghost" data-gstage="${i}" aria-pressed="${i===0}" aria-controls="landing-golden-detail">${number(i)} · ${esc(s.label)}</button>`).join('')}</div>
      <p class="landing-legend">Platform-provided · domain-owned · shared responsibilities</p><div class="landing-detail" id="landing-golden-detail" aria-live="polite">${goldenPanel(0)}</div></section>
    <section class="card" id="journeys"><h2>Example journeys</h2><p>Explore responsibilities for four platform roles.</p>
      <div class="landing-role-tabs" role="tablist" aria-label="Explore a role">${Object.entries(JOURNEYS).map(([id,role])=>`<button type="button" role="tab" id="landing-role-${id}" data-jtab="${id}" aria-selected="${id==='admin'}" aria-controls="landing-journey-panel" tabindex="${id==='admin'?0:-1}">${role.label}</button>`).join('')}</div>
      <div id="landing-journey-panel" role="tabpanel" aria-labelledby="landing-role-admin">${journeyPanel('admin',0)}</div>
      <p class="public-note">Token allowances and spending budgets are separate controls.</p></section>
    <section id="maturity"><h2>Maturity model</h2><p>The progression from isolated pilots to an adaptive platform. <a href="#landing-roadmap">Roadmap →</a></p>
      <div class="mat">
        <div class="mrung l1"><div class="lv">Level 01</div><div class="nm">Ad Hoc Agents</div><div class="cap">Isolated pilots, no reuse.</div></div>
        <div class="mrung l2"><div class="lv">Level 02</div><div class="nm">Platform Foundation</div><div class="cap">Shared registry, basic governance.</div></div>
        <div class="mrung l3"><div class="lv">Level 03</div><div class="nm">Self-Service Scale</div><div class="cap">Blueprints, eval gates, federated domains.</div><p>Reference architecture</p></div>
        <div class="mrung l4"><div class="lv">Level 04</div><div class="nm">Adaptive Platform</div><div class="cap">The platform as an agent — AI-assisted onboarding, self-optimization.</div><p>North star · aspirational direction</p></div>
      </div></section>
    <section id="landing-roadmap"><h2>Reference architecture roadmap</h2><div data-roadmap-slot><p role="status">Loading the public roadmap…</p><a href="/landing-roadmap.html">Open full roadmap</a></div></section>
  </div>`
}

// Original Mermaid definitions stay in the source asset; render local semantic
// diagrams as well, without a CDN dependency or script execution.
function renderRoadmapDiagrams(root){
  const edges=[
    ['Build Time → Golden Path CI → CD (non-prod) → Offline Eval → CD (prod) → Online Eval → Feedback & Continuous Improvement → Build Time', 'Offline Eval → Build Time: fail: back to build', 'Feedback & Continuous Improvement → Build Time: signals + actions'],
    ['Reuse → Quality → Speed → Data → Insights → Evolution → Reuse', 'Reuse → Each new agent: stands on', 'Each new agent → Data: leaves behind', 'Each new agent → Quality: published to'],
  ]
  root.querySelectorAll('pre.mermaid').forEach((pre,index)=>{
    const labels=[...pre.innerHTML.matchAll(/\["([^"\]]+)"\]/g)].map(match=>match[1].replace(/<br\s*\/?>/gi,' '))
    const diagram=document.createElement('div')
    diagram.className='landing-offline-diagram'
    diagram.innerHTML=`<ol>${labels.map(label=>`<li>${label}</li>`).join('')}</ol><ul>${edges[index].map(edge=>`<li>${esc(edge)}</li>`).join('')}</ul>`
    const details=document.createElement('details')
    details.innerHTML='<summary>Diagram source</summary>'
    pre.before(diagram,details)
    details.append(pre)
  })
}
export function mountLanding(main,signInHtml){
  main.innerHTML=landingHtml(signInHtml)
  main.classList.add('public-landing')
  const root=main.querySelector('.landing')
  const query=selector=>root.querySelector(selector)
  let role='admin',step=0,paused=false,frame=0,elapsed=0,last=null,disposed=false
  const reduced=window.matchMedia('(prefers-reduced-motion: reduce)')
  const controller=new AbortController()
  const on=(node,event,handler)=>node.addEventListener(event,handler,{signal:controller.signal})
  function reveal(button){
    const strip=button.parentElement
    const left=button.offsetLeft-strip.offsetLeft
    if(left<strip.scrollLeft)strip.scrollLeft=left
    else if(left+button.offsetWidth>strip.scrollLeft+strip.clientWidth)strip.scrollLeft=left+button.offsetWidth-strip.clientWidth
  }
  function keyboardGroup(event,selector){
    const buttons=[...root.querySelectorAll(selector)]
    const index=buttons.indexOf(event.target)
    if(index<0||!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return
    event.preventDefault()
    const next=event.key==='Home'?0:event.key==='End'?buttons.length-1:(index+(event.key==='ArrowRight'?1:-1)+buttons.length)%buttons.length
    buttons[next].focus({preventScroll:true});buttons[next].click();reveal(buttons[next])
  }
  function selectStep(next){
    step=next
    query('#landing-journey-panel').innerHTML=journeyPanel(role,step)
  }
  on(root,'click',event=>{
    const tab=event.target.closest('[data-jtab]')
    if(tab){
      role=tab.dataset.jtab;selectStep(0)
      root.querySelectorAll('[data-jtab]').forEach(button=>{const active=button===tab;button.setAttribute('aria-selected',String(active));button.tabIndex=active?0:-1})
      query('#landing-journey-panel').setAttribute('aria-labelledby',tab.id)
    }
    const node=event.target.closest('[data-jstep]')
    if(node){const focused=document.activeElement===node;const scroll=node.parentElement.scrollLeft;selectStep(Number(node.dataset.jstep));const current=query(`[data-jstep="${step}"]`);current.parentElement.scrollLeft=scroll;if(focused)current.focus({preventScroll:true});reveal(current)}
    const stage=event.target.closest('[data-gstage], [data-gvisual]')
    if(stage){const index=Number(stage.dataset.gstage??stage.dataset.gvisual);root.querySelectorAll('[data-gstage]').forEach(button=>button.setAttribute('aria-pressed',String(Number(button.dataset.gstage)===index)));root.querySelectorAll('[data-gvisual]').forEach(node=>node.classList.toggle('sel',Number(node.dataset.gvisual)===index));query('#landing-golden-detail').innerHTML=goldenPanel(index)}
  })
  on(root,'keydown',event=>keyboardGroup(event,event.target.matches('[data-jtab]')?'[data-jtab]':event.target.matches('[data-jstep]')?'[data-jstep]':'[data-gstage]'))
  function tick(now){
    if(disposed||!root.isConnected)return
    if(last!==null)elapsed+=now-last
    last=now
    root.querySelectorAll('svg').forEach(svg=>{const track=svg.querySelector('[data-motion-track]'),dot=svg.querySelector('[data-motion-dot]');if(!track||!dot)return;const point=track.getPointAtLength((elapsed%14000)/14000*track.getTotalLength());dot.setAttribute('cx',point.x);dot.setAttribute('cy',point.y)})
    const nodes=[...root.querySelectorAll('[data-jstep]')]
    const index=Math.floor(elapsed/1700)%nodes.length
    nodes.forEach((node,i)=>node.classList.toggle('live',i===index))
    const fill=query('.jm-fill');if(fill)fill.style.width=`${index/(nodes.length-1)*100}%`
    frame=requestAnimationFrame(tick)
  }
  function updateMotion(){
    cancelAnimationFrame(frame);last=null
    const moving=!paused&&!reduced.matches&&!document.hidden
    root.classList.toggle('moving',moving)
    query('#landing-pause').textContent=paused?'Resume animation':'Pause animation'
    query('#landing-pause').setAttribute('aria-pressed',String(paused))
    query('#landing-motion-status').textContent=reduced.matches?'Reduced motion: static diagrams':paused?'Animation paused':document.hidden?'Animation paused while hidden':'Animation playing'
    if(moving)frame=requestAnimationFrame(tick)
  }
  on(query('#landing-pause'),'click',()=>{paused=!paused;updateMotion()})
  on(document,'visibilitychange',updateMotion)
  on(reduced,'change',updateMotion)
  updateMotion()
  fetch(new URL('../landing-roadmap.html',import.meta.url),{signal:controller.signal}).then(response=>{
    if(!response.ok)throw new Error('Roadmap unavailable')
    return response.text()
  }).then(text=>{
    if(disposed)return
    const content=new DOMParser().parseFromString(text,'text/html').querySelector('[data-roadmap-content]')
    if(!content)throw new Error('Roadmap unavailable')
    const section=document.createElement('div');section.className='landing-roadmap';section.innerHTML=content.innerHTML
    query('[data-roadmap-slot]').replaceChildren(section)
    renderRoadmapDiagrams(section)
  }).catch(()=>{if(!disposed)query('[data-roadmap-slot]').innerHTML='<p role="status">The roadmap could not be loaded. <a href="/landing-roadmap.html">Open the full roadmap</a>.</p>'})
  return ()=>{disposed=true;controller.abort();cancelAnimationFrame(frame);main.classList.remove('public-landing')}
}
