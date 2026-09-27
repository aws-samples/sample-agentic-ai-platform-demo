import {defaultEvaluation,validateEvaluation} from '../evaluation-config.mjs'
import {repositoryHandoff,agentRepositoryName} from '../repository-handoff.mjs'
import {evaluationSetupHtml,wireEvaluationSetup} from '../evaluation-setup.mjs'
import { foundationCatalog } from "../domain-foundation-catalog.mjs"
import { projectAllowsResource } from "../project-resource-policy.mjs"
import { mountDraftActivity } from '../draft-activity.mjs'
import { mountDomains, mountDomainFoundation } from '../domain-bootstrap-view.mjs'
import { mountAlertDraftEditor, validAlertCatalogResponse, alertCatalogHtml, alertRaciHtml } from '../alert-drafts.mjs'
import { mountPolicyDraftEditor } from '../policy-drafts.mjs'
import { guardrailCatalogView, approvalCatalogView, runtimePolicyView } from "../governance-policy-view.mjs"
import { mountGuardrailExceptions } from "../guardrail-exceptions-view.mjs"
import { repositoryArchive } from "../repository-download.mjs"
import { createApprovalDecisionRetries } from "../approval-decision-retries.mjs"
import {
  authMode,
  beginSignIn,
  clearAuthentication,
  completeSignIn,
  getAccessToken,
  signOut as cognitoSignOut,
} from "../auth-client.mjs"
import {
  GUARDRAIL_ACTIONS,
  GUARDRAIL_CATALOG,
  GUARDRAIL_RUN_MODES,
  defaultGuardrailChain,
  validateGuardrailChain,
} from "../guardrail-chain.mjs"
import {
  adaptAudit,
  adaptBlueprints,
  adaptBuilderCatalog,
  adaptCosts,
  adaptDomains,
  adaptFleet,
  adaptObsScopes,
  adaptProjects,
  adaptWizardPicks,
  buildableBlueprints,
  collectPagedItems,
  normalizeSelectedResourceIds,
  resolveBuildModelId,
} from "../main-ui-compat.mjs"
import {
  createMainUiBuildActions,
  activeBuildProjects,
} from "../main-ui-build.mjs"

import { hostedCostHtml, projectCostHtml, loadHostedCostPages, scopedCostPage } from "../cost-view.mjs"
import { validatePlatformBilling, platformBillingHtml, platformCostReportCsv } from "../platform-billing-view.mjs"
import { platformCostRollup, platformCostRollupHtml } from "../platform-cost-rollup.mjs"
import { platformMonitoringHtml } from "../platform-monitoring-view.mjs"
import { projectAgents, loadOperationsPages, operationsHtml, loadWorkspaceProjectPages, WorkspaceProjectReadError, rememberWorkspaceSelection, restoreWorkspaceSelection } from "./workspace-scope.mjs"
import { mountProjectBudget } from "./project-budget.mjs"
import { mountLanding } from "./landing.mjs"
import { createDirtyTracker } from "../dirty-state.mjs"
import { createFormDirtyGuard } from "../form-dirty-guard.mjs"
import { createApprovalReasonDrafts, wireApprovalReasonInputs } from "../approval-reason-drafts.mjs"
import { registryDecisionAllowed, sameRegistryDecisionRecord } from "../registry-decision-target.mjs"
import { mountPublicationSubmission } from "../publication-submission.mjs"
import { hostedApprovalRequest } from "../hosted-approval-request.mjs"
import { mountReleaseDelivery } from "../release-delivery-view.mjs"
import { MODEL_PROVIDER_FACTS } from "../model-provider-facts.mjs"
import { isRegistryModelProjection, registryModelIdentity, registryModelStatus } from "../registry-model-status.mjs"
import { fleetEmptyHtml, memoryKbTabHtml, obsProjectUnavailableHtml } from "../workspace-tabs-view.mjs"

import { projectPendingWork } from '../pending-work.mjs'

const businessForms=createFormDirtyGuard()
const wizardDirty=createDirtyTracker()
const composeDirty=createDirtyTracker()
let projectBudgetDirty=()=>false
let domainBootstrapDirty=()=>false
let disposeDomains=null
// Approval review-reason drafts, isolated per actor+domain+approvalId. Filter
// changes and tab navigation keep drafts on Cancel and discard the active
// actor+domain scope on Confirm; other identities' drafts are never touched.
const approvalReasonDrafts=createApprovalReasonDrafts()
function approvalReasonScope(){
  return {actor:SESSION?.actor||SESSION?.user||'',domain:activeDomain()||undefined}
}
// Explicit persisted-input inventory, excluding all search/filter/navigation controls.
const BUSINESS_FORM_FIELDS={
  gateway:'#hgrequestsPerMinute,#hgtokensPerMinute,#hgconnectionsPerSecond,[data-model-domain],#hostedgatewayreason',
  access:'#haccessdomainusername,#haccessdomainreason,#haccessprojectusername,#haccessprojectreason',
  build:'#hbproject,#hbid,#hbname,#hbdescription,#hbmodel,#hbblueprint,#hbmemory,#hbkb,#hbinstructions,#hbtemperature,#hbmaxtokens,#hbgrepo,#hbprompt,[data-hbresource],[data-hbguardrail-enabled],[data-hbguardrail-action],[data-hbguardrail-run-mode],[data-hbguardrail-message],#hminimalrepo,#hspecmessage,#hspecrepo,#hspecproject,#hspecmodel,#hspecblueprint',
  wizard:'#wid,#wname,#wdesc,#wmember,#wmemberreason,#wreviewbudget,#wbp,#wmodel,#wpersona,#wbudget,[data-wmember]',
  domainPolicy:'.dpguard',
  domain:'#dname,#downer,#dgroup,#dbudget,#ddesc',
  publication:'#hgdomain,#hgtype,#hgid,#hgname,#hgversion,#hgshared,#hgdescription,#hgspecification',
  incident:'#hiproject,#hiseverity,#hititle,#hidescription,#hireason',
  breakglass:'#hbgproject,#hbgduration,#hbgresource,#hbgaction,#hbgreason',
  registry:'#rwname,#rwalias,#rwdomain,#rwrisk,#rwdata,#rwauto,#regchangelog,#regbump,#regcontent',
  policy:'#hpname,#hptools,#hpmode,#hpscope,#hpdid,#hpdname,#hpdtools,#hpdmode,#hpdkind,#hpdproject,#hpdreason',
  alertPolicy:'#apname,#apmetric,#apthresh,#apsev,#apowner,#aprunbook,#apdid,#apdname,#apdmetric,#apdthreshold,#apdseverity,#apdowner,#apdrunbook,#apdresponsible,#apdaccountable,#apdconsulted,#apdinformed,#apdreason',
  blueprint:'#bsid,#bsname,#bsusecase,#bsbase,#bsfw,#bsdt,#bsproto,#bsmem,#bsjson,#bbid,#bbname,#bbusecase,#bbbase,#bbfw,#bbdt,#bbproto,#bbmem',
  compose:'#pname,#persona,#model,#mp-temp,#mp-maxtok,#framework,#deployTarget,#protocol,#opt-streaming,#opt-identity,#opt-guardrails,#opt-memory,#acyaml,#scname,#scghrepo,#prepo,#pmsg,#ghrepo,#pghrepo,[data-gtoggle],[data-gaction],[data-grunmode],[data-gmsg]',
  experiencePrompt:'#hexperienceprompt',
  experienceFeedback:'#hexperiencerating,#hexperiencecomment',
  experienceIssue:'#hexperienceissue',
  experienceAccess:'[data-requestable-reason]',
  traceAccess:'.areq-why,.areq-dur',
  dataset:'#gepaste,#ges3',
  projectMembers:'#memadd,#memaddbundle,.membundle',
  profileCreate:'.profname',
}
function composeDraft(){
  return Object.fromEntries(['skills','tools','builtin','mcp','a2a'].map(key=>[key,[...(S[key]||[])].sort()]))
}
function bindBusinessForms(){
  for(const [scope,selector] of Object.entries(BUSINESS_FORM_FIELDS)){
    const nodes=[...document.querySelectorAll(selector)]
    businessForms.bind(scope,nodes.map((node,index)=>[node.id||JSON.stringify([node.dataset,index]),node]))
  }
}
function clearBusinessDrafts(){
  businessForms.clear();wizardDirty.clear('wizard');composeDirty.clear('compose');projectBudgetDirty=()=>false;approvalReasonDrafts.discard(approvalReasonScope())
}
// Async render/read-back installs controls before capturing their clean baseline.
// No baseline is recaptured merely because a failed save rerenders its form.
const businessFormObserver=new MutationObserver(bindBusinessForms)
businessFormObserver.observe(document.getElementById('main'),{childList:true,subtree:true})
let disposeLanding=null
let pendingNavFocus=null

const DEMO_CONTEXT=authMode()==='cognito'?await import("../demo-context.mjs"):null
const HOSTED_PERSONA=authMode()==='cognito'?await import("../hosted-persona.mjs"):null
const DEMO_ASSIST=authMode()==='cognito'?await import("../demo-assist.mjs"):null
const getDemoContext=()=>DEMO_CONTEXT?.getDemoContext()||null
const setDemoContext=(context,options)=>DEMO_CONTEXT?.setDemoContext(context,options)
const clearDemoContext=()=>DEMO_CONTEXT?.clearDemoContext()
const demoContextHeaders=()=>DEMO_CONTEXT?.demoContextHeaders()||{}
const availableDemoRoleOptions=profile=>DEMO_CONTEXT?.availableDemoRoleOptions(profile)||[]
const clearDemoAssist=()=>DEMO_ASSIST?.clearDemoAssist()
const clearActiveDemoJourney=()=>DEMO_ASSIST?.clearActiveDemoJourney()
// Retire stored assistance as well as tours. Authorized role context is separate.
clearDemoAssist()
const enabledHostedSurfaces=capabilities=>HOSTED_PERSONA?.enabledHostedSurfaces(capabilities)||[]
const hostedActionEnabled=(action,capabilities)=>HOSTED_PERSONA?.hostedActionEnabled(action,capabilities)===true
const hostedApprovalActionEnabled=(kind,capabilities,options)=>HOSTED_PERSONA?.hostedApprovalActionEnabled(kind,capabilities,options)===true
const hostedResourceKey=resource=>HOSTED_PERSONA?.hostedResourceKey(resource)||null
const hostedBuildRegistryEntriesForDomain=(entries,domainId)=>
  HOSTED_PERSONA?.hostedBuildRegistryEntriesForDomain(entries,domainId)||[]
const normalizeHostedBuildSelections=(resources,form,selected)=>
  HOSTED_PERSONA?.normalizeHostedBuildSelections(resources,form,selected)||{
    toolIds:[],
    skillIds:[],
    mcpServerIds:[],
    blueprintId:'',
    blueprintIds:[],
  }
const hostedBuildPublicationCanSubmit=(agentStatus,registryStatus)=>
  HOSTED_PERSONA?.hostedBuildPublicationCanSubmit(agentStatus,registryStatus)===true

// Mock mode persists the POST /api/login session; Cognito mode keeps only the
// backend-projected /api/me profile in memory and sends the Cognito access token.
const SESSION_KEY='console.session'
let ordinaryDomainSwitching=false
let cognitoBootstrapError=''
let SESSION=null
if(authMode()==='mock')try{SESSION=JSON.parse(localStorage.getItem(SESSION_KEY))}catch{}
function applyDemoAssistToHostedView(){
  // Business inputs stay manual, including when old assist storage is present.
}
function requestDemoChoice(action,message,defaultValue=''){
  return Promise.resolve(prompt(message,defaultValue))
}
function setSession(s){
  SESSION=s
  if(authMode()!=='mock')return
  try{if(s)localStorage.setItem(SESSION_KEY,JSON.stringify(s));else localStorage.removeItem(SESSION_KEY)}catch{}
}
const authHeaders = ()=>{
  const mode=authMode()
  const credential=mode==='cognito'?getAccessToken():SESSION?.token
  if(!credential)return {}
  const scopedHeaders=mode==='cognito'
    ? (SESSION&&!SESSION.canSwitchDemoRole?{}:demoContextHeaders())
    : (activeDomain()?{'x-active-domain':activeDomain()}:{})
  // Ordinary identities have no demo role context; propagate only their server-projected domain.
  if(mode==='cognito'&&!scopedHeaders['x-demo-role']&&!scopedHeaders['x-active-domain']
    &&['lead','builder'].includes(SESSION?.role)&&activeDomain()){
    scopedHeaders['x-active-domain']=activeDomain()
  }
  return {
    authorization:'Bearer '+credential,
    ...scopedHeaders,
  }
}
const apiBaseUrl = ()=>window.__RUNTIME_CONFIG__?.apiBaseUrl||'/api'
const apiUrl = p=>String(apiBaseUrl()).replace(/\/+$/,'')+(p.startsWith('/')?p:'/'+p)
let sessionEpoch=0
let hostedRegistryReadCache=null
let registryModelLoadGeneration=0
let hostedGatewayLoadGeneration=0
const activeSessionRequests=new Set()
const activeSessionTimeouts=new Set()
const activeSessionIntervals=new Set()
// Actor/role/domain/approval-scoped identity survives a reload. No tokens or
// reasons are persisted; scope invalidation clears only local in-flight flags.
const pendingHostedApprovalDecisions=createApprovalDecisionRetries({
  getItem:key=>sessionStorage.getItem(key),setItem:(key,value)=>sessionStorage.setItem(key,value),removeItem:key=>sessionStorage.removeItem(key),
})
const CANCELED_REQUEST=Symbol('canceled request')
function apiErrorMessage(response,fallback){
  const bounded=value=>{
    const text=typeof value==='string'?value.trim():''
    return text.length>240?`${text.slice(0,237)}...`:text
  }
  for(const value of [response?.message,response?.code,response?.error]){
    const text=bounded(value)
    if(text)return text
  }
  return bounded(fallback)
}
function createRequestId(){
  const requestId=crypto.randomUUID()
  if(!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestId)){
    throw new Error('Could not create a valid request ID.')
  }
  return requestId
}
function runSessionTask(task){
  return Promise.resolve().then(task).catch(error=>{
    if(error===CANCELED_REQUEST)return
    queueMicrotask(()=>{throw error})
  })
}
const sessionTaskHandler=task=>(...args)=>runSessionTask(()=>task(...args))
function beginSessionRequest(){
  const request={epoch:sessionEpoch,controller:new AbortController()}
  activeSessionRequests.add(request)
  return request
}
const sessionRequestIsCurrent = request=>request.epoch===sessionEpoch
const sessionEpochIsCurrent = epoch=>epoch===sessionEpoch
const finishSessionRequest = request=>activeSessionRequests.delete(request)
function sessionTimeout(callback,delay){
  const epoch=sessionEpoch
  const timer=setTimeout(()=>{
    activeSessionTimeouts.delete(timer)
    if(sessionEpochIsCurrent(epoch))runSessionTask(callback)
  },delay)
  activeSessionTimeouts.add(timer)
  return timer
}
function clearSessionTimeout(timer){
  clearTimeout(timer)
  activeSessionTimeouts.delete(timer)
}
function sessionInterval(callback,delay){
  const epoch=sessionEpoch
  const timer=setInterval(()=>{
    if(sessionEpochIsCurrent(epoch))runSessionTask(callback)
  },delay)
  activeSessionIntervals.add(timer)
  return timer
}
function clearSessionInterval(timer){
  clearInterval(timer)
  activeSessionIntervals.delete(timer)
}
function invalidateSessionWork(){
  pendingHostedApprovalDecisions.clear()
  sessionEpoch++
  clearHostedRegistryReadCache()
  for(const request of activeSessionRequests)request.controller.abort()
  activeSessionRequests.clear()
  for(const timer of activeSessionTimeouts)clearTimeout(timer)
  activeSessionTimeouts.clear()
  for(const timer of activeSessionIntervals)clearInterval(timer)
  activeSessionIntervals.clear()
}
const rawApi = async (p, body, {settleOnUnauthorized=false,requestId,method,ordinaryDomain}={}) => {
  if((cognitoBootstrapError||SESSION?.profileType==='authenticated-unscoped')&&p!=='/me')throw CANCELED_REQUEST
  const request=beginSessionRequest()
  const requestMethod=method||(body===undefined?'GET':'POST')
  if(requestMethod!=='GET')clearHostedRegistryReadCache()
  try{
    const options=requestMethod==='GET'
      ? {method:requestMethod,headers:authHeaders(),signal:request.controller.signal}
      : {method:requestMethod,headers:{'content-type':'application/json',...authHeaders(),...(requestId?{'x-request-id':requestId}:{})},body:JSON.stringify(body),signal:request.controller.signal}
    if(p==='/me'&&ordinaryDomain!==undefined){
      options.headers={authorization:'Bearer '+getAccessToken(),...(ordinaryDomain?{'x-active-domain':ordinaryDomain}:{})}
    }
    const r=await fetch(apiUrl(p),options)
    if(!sessionRequestIsCurrent(request))throw CANCELED_REQUEST
    if(r.status===401 && p!=='/login'){
      handleUnauthorized()
      if(settleOnUnauthorized)return {ok:false,error:'Not signed in.'}
      throw CANCELED_REQUEST
    }
    const text=await r.text()
    if(!sessionRequestIsCurrent(request))throw CANCELED_REQUEST
    const projectRead=requestMethod==='GET'&&p.split('?')[0]==='/projects'
    if(!text)return projectRead?{ok:r.ok,status:r.status}:{ok:r.ok}
    let result
    try{result=JSON.parse(text)}catch{return {ok:false,error:`Request failed (${r.status}).`,...(projectRead?{status:r.status}:{})}}
    if(r.status===403&&p!=='/me'&&authMode()==='cognito'
      &&!SESSION?.canSwitchDemoRole&&['lead','builder'].includes(SESSION?.role)
      &&['DEMO_DOMAIN_REQUIRED','DEMO_DOMAIN_NOT_ALLOWED','DOMAIN_REQUIRED','DOMAIN_NOT_ALLOWED'].includes(result?.code)){
      await recoverOrdinaryScope()
      throw CANCELED_REQUEST
    }
    return projectRead?{...result,ok:r.ok&&result?.ok===true,status:r.status}:result
  }catch(error){
    if(error===CANCELED_REQUEST)throw error
    if(error?.name==='AbortError'||!sessionRequestIsCurrent(request))throw CANCELED_REQUEST
    throw error
  }finally{
    if(requestMethod!=='GET')clearHostedRegistryReadCache()
    finishSessionRequest(request)
  }
}
function clearHostedRegistryReadCache(){
  hostedRegistryReadCache=null
}
function hostedModelReadContext(){
  const headers=authMode()==='cognito'?demoContextHeaders():{}
  return JSON.stringify([sessionEpoch,SESSION?.actor||SESSION?.user,SESSION?.role,activeDomain(),
    headers['x-demo-role'],headers['x-active-domain'],[...hostedCaps()].sort()])
}
async function readHostedRegistry(options){
  const context=hostedModelReadContext()
  const cache=hostedRegistryReadCache?.context===context
    && (hostedRegistryReadCache.pending||hostedRegistryReadCache.expiresAt>Date.now())
    ?hostedRegistryReadCache
    :{context,pending:true,expiresAt:0,promise:rawApi('/registry',undefined,options)}
  hostedRegistryReadCache=cache
  try{
    const result=await cache.promise
    if(context!==hostedModelReadContext())throw CANCELED_REQUEST
    if(hostedRegistryReadCache===cache){
      if(result?.ok===true){if(cache.pending)cache.expiresAt=Date.now()+5000;cache.pending=false}
      else clearHostedRegistryReadCache()
    }
    return result
  }catch(error){
    if(hostedRegistryReadCache===cache)clearHostedRegistryReadCache()
    throw error
  }
}
async function readHostedCollection(resource,options){
  return collectPagedItems(async cursor=>{
    const suffix=cursor?`&cursor=${encodeURIComponent(cursor)}`:''
    const result=await rawApi(`/${resource}?limit=50${suffix}`,undefined,options)
    if(result?.resource!==resource){
      return {
        ok:false,
        code:'PAGINATION_INVALID',
        message:'The hosted collection pagination response is invalid.',
      }
    }
    return result
  })
}
const mainBuildActions=createMainUiBuildActions({
  request:(path,body,options)=>{
    const resource=body===undefined&&['/projects','/agents'].includes(path)
      ?path.slice(1)
      :null
    return resource
      ?readHostedCollection(resource,options)
      :rawApi(path,body,options)
  },
  requestId:createRequestId,
})
async function mainCompatApi(p,body,options){
  const requestMethod=options?.method||(body===undefined?'GET':'POST')
  if(requestMethod!=='GET')return rawApi(p,body,options)
  if(p==='/registry')return readHostedRegistry(options)
  if(p==='/domains'){
    const [domains,agents]=await Promise.all([
      rawApi('/domains',undefined,options),
      readHostedCollection('agents',options),
    ])
    return adaptDomains(domains,agents)
  }
  if(p==='/projects'||p==='/my-projects'){
    const [projects,agents]=await Promise.all([
      readHostedCollection('projects',options),
      readHostedCollection('agents',options),
    ])
    return adaptProjects(projects,agents)
  }
  if(p==='/fleet'){
    const [agents,deployments,approvals]=await Promise.all([
      readHostedCollection('agents',options),
      readHostedCollection('deployments',options),
      readHostedCollection('approvals',options),
    ])
    return adaptFleet(agents,deployments,approvals)
  }
  if(p==='/costs'||p.startsWith('/costs?')){
    const first=await rawApi(p,undefined,options)
    if(first?.ok!==true)return first
    try{
      const result=await loadHostedCostPages(first,cursor=>{
        const [path,query='']=p.split('?')
        const params=new URLSearchParams(query)
        params.set('cursor',cursor)
        return rawApi(path+'?'+params.toString(),undefined,options)
      })
      return adaptCosts(result,S.domains||[])
    }catch(error){
      if(error===CANCELED_REQUEST)throw error
      return {ok:false,code:'COST_DATA_INVALID',message:'Cost data is unavailable.'}
    }
  }
  if(p==='/obs-scopes'){
    const [domains,agents]=await Promise.all([
      rawApi('/domains',undefined,options),
      readHostedCollection('agents',options),
    ])
    return adaptObsScopes(domains,agents)
  }
  if(p==='/integrations-audit-export'||p.startsWith('/integrations-audit-export?')){
    const query=p.includes('?')?'?'+p.split('?')[1]:''
    const r=await mainCompatApi('/audit-trail'+query,undefined,options)
    return r?.ok===true?{ok:true,events:r.events,count:r.events.length,scope:activeDomain()||'all-authorized',source:'workspace-audit-metadata'}:r
  }
  if(p==='/audit-trail'||p.startsWith('/audit-trail?')){
    const result=await collectPagedItems(async cursor=>{
      const r=await rawApi('/operations/audit?limit=50'+(cursor?'&cursor='+encodeURIComponent(cursor):''),undefined,options)
      if(r?.ok!==true)return r
      if(r.resource!=='audit'||r.partial===true||r.complete===false||r.incomplete===true||r.errors?.length||!Array.isArray(r.items)||r.items.some(e=>!e||['resource','timestamp','requestId','actor','action'].some(k=>typeof e[k]!=='string'||!e[k])))return {ok:false,code:'INVALID_AUDIT_RESPONSE'}
      return r
    })
    if(result?.ok!==true)return result
    const mapped=adaptAudit(result),params=new URLSearchParams(p.split('?')[1]||'')
    mapped.events=mapped.events.filter(e=>(!params.get('type')||e.type===params.get('type'))&&(!params.get('domain')||e.domain===params.get('domain')))
    return {...mapped,total:mapped.events.length}
  }
  if(p==='/blueprints'){
    return adaptBlueprints(
      await readHostedRegistry(options),
      activeDomain(),
    )
  }
  if(p==='/wizard-picks'){
    const [registry,sharedResources]=await Promise.all([
      readHostedRegistry(options),
      rawApi('/governance/shared-resources?limit=50',undefined,options),
    ])
    return adaptWizardPicks(
      registry,
      mainBuildDomainId(),
      sharedResources,
    )
  }
  if(p==='/catalog'){
    const [registry,gateway,github,sharedResources]=await Promise.all([
      readHostedRegistry(options),
      rawApi('/ai-gateway',undefined,options),
      rawApi('/delivery/github',undefined,options),
      rawApi('/governance/shared-resources?limit=50',undefined,options),
    ])
    return adaptBuilderCatalog(
      registry,
      gateway,
      github,
      mainBuildDomainId(),
      sharedResources,
    )
  }
  if(p==='/guardrail-catalog'){
    return {ok:true,catalog:GUARDRAIL_CATALOG}
  }
  return rawApi(p,body,options)
}
const api=(p,body,options={})=>authMode()==='cognito'
  ? mainCompatApi(p,body,options)
  : rawApi(p,body,options)
let cognitoLoginStatus=''
let mockLoginAttempt=null
const el = (h)=>{const t=document.createElement('template');t.innerHTML=h.trim();return t.content.firstChild}
// Escape server/LLM-derived text that lands in innerHTML OUTSIDE of md():
// CLI output, eval explanations, Langfuse trace fields — all attacker-influencable.
const esc = s => String(s??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')
// Mock (real:false) orgs sort first so the export dropdown never defaults to a live personal account (P0-1).
const sortedGhOrgs = orgs => [...orgs].sort((a,b)=>(a.real?1:0)-(b.real?1:0))
// Escape HTML, then render a safe subset of markdown (bold, italic, inline code,
// code fences, headings, bullet/numbered lists, paragraphs). Chat text is model
// output, so we escape FIRST to prevent HTML/script injection.
// Structure before inline (G11): each line is classified (heading / bullet /
// numbered / paragraph) BEFORE bold/italic run, so a leading "* " is a bullet
// (never <em>) and markers can't emit tags spanning lines. Blank lines between
// numbered items do NOT close the list -- models emit "1.\n\n2.\n\n3." and the
// numbering must stay sequential (was rendering "1 1 1 1"); any non-list line
// closes it. Inline _ / * only format when delimited by whitespace/punctuation,
// so snake_case identifiers keep their underscores and spacing intact.
const FENCE='\uE000', CODESPAN='\uE001'
function mdInline(s){
  const codes=[]
  s=s.replace(/`([^`\n]+)`/g,(_,c)=>{codes.push(c);return CODESPAN+(codes.length-1)+CODESPAN})
  s=s.replace(/\*\*([^\n]+?)\*\*/g,'<strong>$1</strong>')
  // X2.4: intraword *em* is valid (word*bold*word) — only `_` needs the
  // whitespace boundary, so snake_case identifiers keep their underscores.
  s=s.replace(/\*(\S(?:[^*\n]*?\S)?)\*/g,'<em>$1</em>')
  s=s.replace(/(^|[\s(])_(\S(?:[^_\n]*?\S)?)_(?=$|[\s).,;:!?])/g,'$1<em>$2</em>')
  return s.replace(new RegExp(CODESPAN+'(\\d+)'+CODESPAN,'g'),(_,i)=>`<code>${codes[i]}</code>`)
}
function md(src){
  if(!src) return ''
  let s=String(src).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
  const fences=[]
  s=s.replace(/```(\w*)\n?([\s\S]*?)```/g,(_,lang,code)=>{fences.push(code.replace(/\n$/,''));return FENCE+(fences.length-1)+FENCE})
  const lines=s.split('\n'), out=[]; let list=null
  const closeList=()=>{if(list){out.push('</'+list+'>');list=null}}
  for(const ln of lines){
    let m
    if(m=ln.match(/^\s*#{1,4}\s+(.*)$/)){closeList();out.push(`<div class="mdh">${mdInline(m[1])}</div>`);continue}
    if(m=ln.match(/^\s*[-*]\s+(.*)$/)){if(list!=='ul'){closeList();list='ul';out.push('<ul>')}out.push(`<li>${mdInline(m[1])}</li>`);continue}
    if(m=ln.match(/^\s*(\d+)\.\s+(.*)$/)){if(list!=='ol'){closeList();list='ol';out.push(`<ol start="${m[1]}">`)}out.push(`<li>${mdInline(m[2])}</li>`);continue}
    if(!ln.trim())continue
    closeList()
    out.push(new RegExp('^'+FENCE+'\\d+'+FENCE+'$').test(ln.trim())?ln.trim():`<div>${mdInline(ln)}</div>`)
  }
  closeList()
  return out.join('').replace(new RegExp(FENCE+'(\\d+)'+FENCE,'g'),(_,i)=>`<pre><code>${fences[i]}</code></pre>`)
}
// Chat message body: invoke failures render as a visible error row instead of
// being swallowed (the panel used to keep spinning / show nothing on ok:false).
const chatBody = m => m.err ? `<div class="status err" style="margin:0">⚠ ${esc(m.text)}</div>` : md(m.text)
// Inline feedback row rendered under each completed agent message.
// stored state: m.feedbackSubmitted={rating,comment}, m.feedbackComment (draft)
function chatFeedbackHtml(m, idx){
  if(m.role!=='agent'||m.err||!m.text)return ''
  if(m.feedbackSubmitted)return `<div class="chat-fb-done" data-fbidx="${idx}" style="font-size:.72rem;color:var(--muted);margin-top:4px">✓ feedback recorded</div>`
  return `<div class="chat-fb" data-fbidx="${idx}" style="display:flex;gap:6px;align-items:center;margin-top:6px;flex-wrap:wrap">
  <button class="ghost fb-up" data-fbidx="${idx}" style="padding:2px 8px;font-size:.8rem" title="Helpful">👍</button>
  <button class="ghost fb-dn" data-fbidx="${idx}" style="padding:2px 8px;font-size:.8rem" title="Not helpful">👎</button>
  <input class="fb-comment" data-fbidx="${idx}" type="text" maxlength="2048" placeholder="Optional comment…" style="flex:1;min-width:80px;padding:2px 6px;font-size:.78rem;background:var(--surface,#111);color:inherit;border:1px solid var(--border,#333);border-radius:3px">
</div>`
}

// ---------- SVG chart primitives (dependency-free) ----------
// Small inline-SVG helpers for the Observability view. Dark-theme aware; no libs.
// sparkline: tiny trend line for stat cards. area: labeled time-series with a
// filled gradient. bars: horizontal ranking for per-domain comparison.
function svgSpark(points, color='var(--accent)', w=120, h=32){
  if(!points||!points.length) return ''
  const mn=Math.min(...points), mx=Math.max(...points), rng=(mx-mn)||1
  const step=w/(points.length-1||1)
  const pts=points.map((v,i)=>`${(i*step).toFixed(1)},${(h-4-((v-mn)/rng)*(h-8)).toFixed(1)}`).join(' ')
  return `<svg viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" preserveAspectRatio="none" style="display:block">
    <polyline points="${pts}" fill="none" stroke="${color}" stroke-width="1.5" stroke-linejoin="round"/></svg>`
}
function svgArea(series, color='var(--accent)', h=150){
  const pts=series.points||[]; if(!pts.length) return ''
  const w=560, pad=4, mn=Math.min(...pts), mx=Math.max(...pts), rng=(mx-mn)||1
  const step=(w-pad*2)/(pts.length-1||1)
  const xy=pts.map((v,i)=>[pad+i*step, h-16-((v-mn)/rng)*(h-30)])
  const line=xy.map(([x,y],i)=>`${i?'L':'M'}${x.toFixed(1)} ${y.toFixed(1)}`).join(' ')
  const fill=`${line} L${xy[xy.length-1][0].toFixed(1)} ${h-16} L${pad} ${h-16} Z`
  const gid='g'+Math.abs(pts[0]*1000|0)+pts.length
  return `<svg viewBox="0 0 ${w} ${h}" width="100%" height="${h}" preserveAspectRatio="none" style="display:block">
    <defs><linearGradient id="${gid}" x1="0" x2="0" y1="0" y2="1">
      <stop offset="0%" stop-color="${color}" stop-opacity="0.28"/><stop offset="100%" stop-color="${color}" stop-opacity="0"/></linearGradient></defs>
    <path d="${fill}" fill="url(#${gid})"/><path d="${line}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round"/></svg>`
}
// Two-series variant of svgArea: draws a filled area for the primary series
// (e.g. P50) plus a lighter dashed line for a secondary series (e.g. P95),
// sharing one y-scale computed across both series so they're comparable.
function svgArea2(series, series2, color='var(--accent)', color2=color, h=150){
  const pts=series.points||[], pts2=series2.points||[]
  if(!pts.length) return ''
  const w=560, pad=4
  const all=pts.concat(pts2)
  const mn=Math.min(...all), mx=Math.max(...all), rng=(mx-mn)||1
  const step=(w-pad*2)/(pts.length-1||1)
  const toXY=arr=>arr.map((v,i)=>[pad+i*step, h-16-((v-mn)/rng)*(h-30)])
  const xy=toXY(pts), xy2=toXY(pts2)
  const line=xy.map(([x,y],i)=>`${i?'L':'M'}${x.toFixed(1)} ${y.toFixed(1)}`).join(' ')
  const line2=xy2.map(([x,y],i)=>`${i?'L':'M'}${x.toFixed(1)} ${y.toFixed(1)}`).join(' ')
  const fill=`${line} L${xy[xy.length-1][0].toFixed(1)} ${h-16} L${pad} ${h-16} Z`
  const gid='g'+Math.abs(pts[0]*1000|0)+pts.length
  return `<svg viewBox="0 0 ${w} ${h}" width="100%" height="${h}" preserveAspectRatio="none" style="display:block">
    <defs><linearGradient id="${gid}" x1="0" x2="0" y1="0" y2="1">
      <stop offset="0%" stop-color="${color}" stop-opacity="0.28"/><stop offset="100%" stop-color="${color}" stop-opacity="0"/></linearGradient></defs>
    <path d="${fill}" fill="url(#${gid})"/><path d="${line}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round"/>
    <path d="${line2}" fill="none" stroke="${color2}" stroke-width="1.5" stroke-dasharray="4 3" stroke-linejoin="round" opacity="0.7"/></svg>`
}
function svgBars(rows, color='var(--accent)'){
  if(!rows||!rows.length) return ''
  const mx=Math.max(...rows.map(r=>r.value))||1
  return `<div style="display:flex;flex-direction:column;gap:8px">${rows.map(r=>`
    <div style="display:flex;align-items:center;gap:10px;font-size:.78rem">
      <div style="width:130px;color:var(--dim);flex-shrink:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(r.label)}</div>
      <div style="flex:1;background:var(--surface2);border-radius:5px;height:18px;overflow:hidden"><div style="width:${(r.value/mx*100).toFixed(1)}%;height:100%;background:${r.color||color};border-radius:5px"></div></div>
      <div style="width:82px;text-align:right;color:var(--text);font-weight:600">${esc(r.display!=null?r.display:r.value)}</div>
    </div>`).join('')}</div>`
}

function createUserState(){
  return {
  // TLP-B2 (spec §1 role-based landing): fresh page load with an existing
  // session lands on the role's home view (builder/lead -> project
  // workspace, platform admin -> Platform Console) instead of always
  // defaulting to Overview. Explicit login clicks set S.view the same way
  // (see the usertile handler below).
  // TLP-B2.3 hybrid landing: a builder boots into 'myprojects', whose loader
  // resumes the last-used project's workspace (autoResume) or shows the
  // My Projects cards page when there is none (spec v2.3 §1).
  view: (SESSION && SESSION.role==='admin') ? 'platformconsole' : (SESSION && SESSION.role==='lead') ? 'domainconsole' : (SESSION && SESSION.role && SESSION.role!=='user') ? 'myprojects' : 'overview',
  autoResume: true,
  blueprints: [], catalog: null, fleet: null,
  // compose wizard; door = which builder journey is open (null = three-door landing)
  door: null,
  step: 1, bp: null, project:'', persona:'', model:'', skills:new Set(), tools:new Set(), mcp:new Set(), a2a:new Set(), builtin:new Set(), mpTemp:'', mpMaxTok:'', gen:null, session:null, chat:[],
  // config-as-code: an imported agent-config.yaml. acYaml is the raw file (sent
  // to /generate so the SERVER re-validates, never the parsed object); acConfig
  // is the server's normalized view, which populates the form and the preview.
  acOpen:false, acYaml:'', acConfig:null, acWarn:[], acErr:[], acPrompt:null, acPath:'',
  // Plato inception chat (spec-first door) — server keeps the transcript per session
  platoChat: [], platoRepositoryName:'', platoAgent:null,
  // governance-gated pick lists for the wizard, resolved from the AI Registry (APPROVED only)
  approvedSkills: null, approvedTools: null, approvedMcp: null, approvedA2a: null,
  // observability: drill-down scope; elevated trace access lives on the SERVER session
  obsScope: { type:'fleet', id:'all', label:'Entire platform' }, obsScopes: null,
  traceAgent: '',
  // login flow: which IdP tile was picked (step 1 of the SSO showcase)
  loginIdp: null,
  navClosed: {},
  registryDrawerId: null,
  registryDrawerVersion: null,
  registryDecisionStatus: null,
  hostedGatewayCatalog: null,
  hostedGatewaySelectedModelId: '',
  hostedGatewayMessage: null,
  hostedAccessTab: 'domain',
  hostedAccessDomains: [],
  hostedAccessDomainId: '',
  hostedAccessProjects: [],
  hostedAccessProjectKey: '',
  hostedAccessDomainMembers: [],
  hostedAccessDomainMembersCursor: null,
  hostedAccessProjectMembers: [],
  hostedAccessProjectMembersCursor: null,
  hostedAccessMessage: null,
  hostedBuildJourney: null,
  hostedBuildJourneyDraft: null,
  hostedSpecAgentForm: null,
  hostedBuildReturnFromProjects: false,
  hostedBuildDelivery: null,
  hostedBuildGitHub: null,
  hostedBuildDeliveryResult: null,
  hostedBuildLoaded: false,
  hostedBuildMutationRequests: {},
  hostedBuildAgentRegistryEntries: [],
  hostedBuildApprovals: [],
  hostedBuildRegistryPublications: {},
  mainBuildMessage: null,
  pendingDomainCreate: null,
  }
}
const S=createUserState()
let scratchPrevTimer=null
// Active console persona — derived from the SERVER session role, never set
// client-side. Domain Leads share the builder nav.
Object.defineProperty(S,'who',{get(){
  const role=SESSION&&SESSION.role
  return role==='admin'?'admin':role==='user'?'user':'builder'
}})
// G6: capability flags resolved SERVER-side (sessionView) — UI affordances
// key off these instead of role-string masks. Display gating only; every
// write is re-checked by can() on the server.
const authoritativeCapabilities = profile => Array.isArray(profile?.capabilities)?profile.capabilities:[]
const hasCap = c => authoritativeCapabilities(SESSION).includes(c)
function userPicker(){
  return `<label style="margin-top:0">Signed in as (identity forwarded to the agent)</label>
    <div style="font-size:.85rem;color:var(--text);max-width:260px;padding:6px 0">${esc(SESSION?SESSION.name:'—')}</div>`
}
// T04: domain affordances. Roster comes from /api/domains (cached in ensure()).
// `SESSION.domain` is the active scope; `SESSION.domains` is the server-returned
// allowlist the user may switch between.
const activeDomain = () => SESSION?.domain || null
const allowedDomains = () => hasCap('viewAllDomains') && Array.isArray(S.domainDirectory) && S.domainDirectory.length
  ? S.domainDirectory.map(d=>d.id)
  : Array.isArray(SESSION?.domains) ? SESSION.domains : (SESSION?.domain ? [SESSION.domain] : [])
const hasDomainScope = () => !!(SESSION && activeDomain() && hasCap('viewDomainOperations'))
const domainLabel = id => ((S.domains||[]).find(d=>d.id===id)||(S.domainDirectory||[]).find(d=>d.id===id)||{}).name || id
// Domain identity is a resource tag, not a status — neutral grey chip like
// AWS console resource tags (recolor round 2, audit item 2).
const domChip = id => id && id!=='shared'
  ? `<span class="chip">${esc(domainLabel(id))}</span>`
  : id==='shared'
  ? `<span class="chip" style="color:var(--muted)">shared</span>`
  // G18: null/absent domain is UNATTRIBUTED (fail-closed), never "shared".
  : `<span class="chip" style="color:var(--lock);border-color:var(--lock-bd)">unattributed</span>`
// One-line scope indicator for active-domain sessions: every list on the page is
// server-filtered to that domain — say so visibly.
const scopeNote = () => hasDomainScope()
  ? `<p class="d" style="color:var(--muted);font-size:.76rem;margin:-16px 0 18px">${hasCap('viewAllDomains')?'Scoped to active domain':'Scoped to your domain'} — <b style="color:var(--dom)">${esc(domainLabel(activeDomain()))}</b></p>`
  : hasCap('viewAllDomains')
  ? `<p class="d" style="color:var(--muted);font-size:.76rem;margin:-16px 0 18px">Scoped to <b style="color:var(--plat)">all domains</b></p>`
  : ''
const defaultObsScope = () => activeDomain()
  ? { type:'domain', id:activeDomain(), label:domainLabel(activeDomain()) }
  : { type:'fleet', id:'all', label:'Entire platform' }
// G14: Domain › Project › Agent breadcrumb — the object hierarchy made visible
// on every drill-down page. Domain is the governance boundary; Project is the
// delivery unit inside exactly one domain; Agent runs inside a project. A part
// links only when this persona's nav can open the target view (display-only —
// every target re-checks scope server-side).
// Projects left the top-level nav (IA restructure): the detail renders as a
// drill-down under Domains, so the project crumb stays linkable whenever the
// persona can reach Domains.
const crumbLinkable = go => allowedViews().includes(go) || (go==='projects' && allowedViews().includes('domains'))
function crumbTrail(parts){
  const seg=parts.filter(Boolean).map(p=>p.go&&crumbLinkable(p.go)
    ?`<a class="crumb" data-goview="${esc(p.go)}"${p.domain?` data-domain="${esc(p.domain)}"`:''}${p.project?` data-project="${esc(p.project)}"`:''} style="color:var(--accent);text-decoration:none;cursor:pointer">${esc(p.label)}</a>`
    :`<span style="color:var(--dim)">${esc(p.label)}</span>`)
  return `<div class="crumbs" style="font-size:.74rem;color:var(--muted);margin:0 0 10px;display:flex;gap:6px;align-items:center;flex-wrap:wrap">${seg.join('<span>›</span>')}</div>`
}
function wireCrumbs(){
  document.querySelectorAll('.crumb').forEach(a=>a.onclick=()=>{
    if(!confirmContextChange())return
    clearBusinessDrafts();S.wiz=null
    if(a.dataset.goview==='domains'){ S.view='domains'; S.domainDetail=a.dataset.domain||null; S.projectDetail=null; S.fleetAgent=null }
    else if(a.dataset.goview==='projects'){ S.view='projects'; S.projectDetail=a.dataset.project||null; S.fleetAgent=null }
    render()
  })
}
function resetScopedCaches(){
  S.catalog=null; S.obsScopes=null; S.fleet=null; S.domains=null; S.domainDirectory=null; S.domainDetail=null; S.projectDetail=null
  S.mainBuildProjects=[];S.mainBuildProjectId='';S.mainBuildProjectsError=''
  S.projectDetailDomain=null
  S.approvedSkills=S.approvedTools=S.approvedMcp=S.approvedA2a=null
  S.registryEntries=null; S.fleetAgent=null; S.traceAgent=''; S.lfAgent=''
  S.reqFType=S.reqFStatus=S.reqFDomain=''
  S.audFType=S.audFDomain=''; S.auditTypes=null
  S.obsScope=defaultObsScope()
}
function replaceSession(session){
  clearBusinessDrafts()
  invalidateSessionWork()
  mockLoginAttempt=null
  setSession(session)
  for(const key of Object.keys(S))delete S[key]
  Object.assign(S,createUserState())
  scratchPrevTimer=null
}
function resetSignedOutState(){cognitoBootstrapError='';replaceSession(null)}
function handleUnauthorized(){
  if(authMode()==='cognito'){
    try{clearAuthentication()}catch{}
    try{clearDemoAssist()}catch{}
  }
  resetSignedOutState()
  queueMicrotask(render)
}
function cognitoErrorMessage(error,fallback){
  const message=String(error?.message||error||fallback).trim()||fallback
  return message.length>180?message.slice(0,177)+'...':message
}
const usableDomainId = value => typeof value==='string'
  && /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/.test(value)
  && value.length<=64
function usableCognitoProfile(profile){
  const valid=!!(profile&&profile.ok===true
    && typeof profile.user==='string'&&profile.user.trim()
    && typeof profile.name==='string'&&profile.name.trim()
    && ['admin','lead','user','builder'].includes(profile.role)
    && Array.isArray(profile.capabilities)
    && profile.capabilities.every(capability=>typeof capability==='string'&&capability.trim())
    && (profile.domain===null||usableDomainId(profile.domain))
    && Array.isArray(profile.domains)
    && profile.domains.every(usableDomainId)
    && ['admin','lead','user','builder'].includes(profile.authenticatedRole)
    && typeof profile.demoRoleActive==='boolean'
    && typeof profile.canSwitchDemoRole==='boolean'
    && Array.isArray(profile.availableDemoRoles)
    && profile.availableDemoRoles.every(role=>['admin','lead','builder','user'].includes(role))
    && Array.isArray(profile.availableDemoDomains)
    && profile.availableDemoDomains.every(domain=>domain
      && usableDomainId(domain.id)
      && typeof domain.name==='string'
      && domain.name.trim()))
  if(!valid)return false
  if(profile.profileType==='authenticated-unscoped')return usableOrdinaryBootstrap(profile)
  if(profile.profileType!==undefined&&profile.profileType!=='scoped')return false
  if(profile.profileType==='scoped'&&(profile.scopeStatus!=='ready'
    ||!['lead','builder'].includes(profile.role)||profile.canSwitchDemoRole||profile.demoRoleActive
    ||!Array.isArray(profile.availableDomains)
    ||!profile.availableDomains.every(d=>d&&usableDomainId(d.id)&&typeof d.name==='string'&&d.name.trim())
    ||new Set(profile.availableDomains.map(d=>d.id)).size!==profile.availableDomains.length
    ||new Set(profile.domains).size!==profile.domains.length
    ||profile.availableDomains.length!==profile.domains.length
    ||!profile.domains.every(id=>profile.availableDomains.some(d=>d.id===id))))return false
  if(profile.canSwitchDemoRole&&profile.authenticatedRole!=='admin')return false
  if(profile.demoRoleActive){
    if(!profile.canSwitchDemoRole||!profile.availableDemoRoles.includes(profile.role))return false
  }else if(profile.role!==profile.authenticatedRole)return false
  if(profile.role==='user')return profile.domain===null&&profile.domains.length===0
  if(['lead','builder'].includes(profile.role)){
    return usableDomainId(profile.domain)
      && profile.domains.includes(profile.domain)
      && (!profile.demoRoleActive||(profile.domains.length===1
        && profile.availableDemoDomains.some(domain=>domain.id===profile.domain)))
  }
  return !profile.demoRoleActive||profile.domain===null||profile.domains.includes(profile.domain)
}
function usableOrdinaryBootstrap(profile){
  const choices=profile?.availableDomains
  return profile?.ok===true&&profile.profileType==='authenticated-unscoped'
    &&profile.identityProvider==='cognito'&&['lead','builder'].includes(profile.role)
    &&profile.role===profile.authenticatedRole&&profile.domain===null
    &&profile.demoRoleActive===false&&profile.canSwitchDemoRole===false
    &&Array.isArray(profile.capabilities)&&Array.isArray(profile.availableDemoRoles)&&Array.isArray(profile.availableDemoDomains)
    &&profile.capabilities.length===0&&profile.availableDemoRoles.length===0&&profile.availableDemoDomains.length===0
    &&Array.isArray(choices)&&choices.every(d=>d&&usableDomainId(d.id)&&typeof d.name==='string'&&d.name.trim())
    &&new Set(choices.map(d=>d.id)).size===choices.length
    &&Array.isArray(profile.domains)&&new Set(profile.domains).size===profile.domains.length
    &&profile.domains.length===choices.length&&profile.domains.every(id=>choices.some(d=>d.id===id))
    &&(profile.scopeStatus==='selection-required'?choices.length>0:profile.scopeStatus==='no-access'&&choices.length===0)
}
function renderOrdinaryDomainControl(){
  if(authMode()!=='cognito'||SESSION?.canSwitchDemoRole||!['lead','builder'].includes(SESSION?.role))return ''
  const choices=SESSION.availableDomains
  if(!Array.isArray(choices)||!choices.length)return ''
  return `<label class="tb-demo-field"><span>Working domain</span><select id="ordinarydomain" aria-label="Working domain" ${ordinaryDomainSwitching?'disabled':''}>
    <option value="" ${!SESSION.domain?'selected':''} disabled>Choose a domain</option>
    ${choices.map(d=>`<option value="${esc(d.id)}" ${SESSION.domain===d.id?'selected':''}>${esc(d.name)}</option>`).join('')}
  </select></label>`
}
function wireOrdinaryDomainControl(){
  const control=document.getElementById('ordinarydomain')
  if(control)control.onchange=sessionTaskHandler(()=>switchOrdinaryDomain(control.value))
}
function renderOrdinaryBootstrap(){
  renderTopbar()
  const side=document.getElementById('side');side.innerHTML='';side.style.display='none'
  const noAccess=SESSION?.scopeStatus==='no-access'
  document.getElementById('main').innerHTML=`<section style="max-width:560px;margin:12vh auto 0">
    <h1>${cognitoBootstrapError?'Domains unavailable':noAccess?'No domain access':'Choose your working domain'}</h1>
    <p role="status">${cognitoBootstrapError?esc(cognitoBootstrapError):noAccess?'Ask your administrator for domain access, then try again.':'Select an available domain to continue.'}</p>
    <button id="retrydomains">Try again</button><button id="bootstrap-signout">Sign out</button>
  </section>`
  document.getElementById('retrydomains').onclick=sessionTaskHandler(async()=>{renderCognitoHydration();await hydrateCognitoSession();render()})
  document.getElementById('bootstrap-signout').onclick=signOutCurrentSession
}
async function recoverOrdinaryScope(){
  // A denied scope invalidates data immediately, but is not a token failure.
  replaceSession(null)
  cognitoBootstrapError='Your domain access changed. Choose a domain to continue.'
  renderOrdinaryBootstrap()
  await hydrateCognitoSession({requireSelection:true})
  render()
}
async function switchOrdinaryDomain(domain){
  if(authMode()!=='cognito'||ordinaryDomainSwitching||SESSION?.canSwitchDemoRole
    ||!['lead','builder'].includes(SESSION?.role)||!SESSION.availableDomains?.some(d=>d.id===domain))return
  if(domain===SESSION.domain)return
  if(!confirmContextChange()){renderTopbar();return}
  const previous=SESSION
  invalidateSessionWork()
  const epoch=sessionEpoch
  ordinaryDomainSwitching=true
  renderTopbar()
  try{
    const profile=await api('/me',undefined,{settleOnUnauthorized:true,ordinaryDomain:domain})
    if(!sessionEpochIsCurrent(epoch))return
    if(demoContextWasRejected(profile)){await recoverOrdinaryScope();return}
    if(!usableCognitoProfile(profile)||profile.profileType!=='scoped'||profile.scopeStatus!=='ready'
      ||!sameAuthenticatedIdentity(profile,previous)||profile.role!==previous.role||profile.domain!==domain
      ||profile.canSwitchDemoRole||profile.demoRoleActive)throw new Error('Domain selection could not be completed. Try again.')
    clearDemoContext()
    replaceSession(profile)
    cognitoBootstrapError=''
    S.view=mainHomeView()
    render()
  }catch(error){
    if(error===CANCELED_REQUEST||!sessionEpochIsCurrent(epoch))return
    alert('Domain selection could not be completed. Try again.')
  }finally{
    ordinaryDomainSwitching=false
    renderTopbar()
  }
}
function sameAuthenticatedIdentity(profile,current){
  return !!(profile&&current
    && profile.user===current.user
    && profile.name===current.name
    && profile.authenticatedRole===current.authenticatedRole)
}
function demoContextWasRejected(profile){
  return [
    'DEMO_ROLE_NOT_ALLOWED',
    'DEMO_DOMAIN_REQUIRED',
    'DEMO_DOMAIN_NOT_ALLOWED',
  ].includes(profile?.code)
}
function authoritativeDemoContext(profile){
  if(!profile?.demoRoleActive)return null
  return {role:profile.role,domain:profile.domain||null}
}
function restoreDemoContext(context){
  if(!DEMO_CONTEXT)return
  if(!context){clearDemoContext();return}
  setDemoContext(context,{
    allowAdminDomain:context.role==='admin'&&!!context.domain,
  })
}
function failClosedCognitoSession(){
  try{clearAuthentication()}catch{}
  try{clearDemoContext()}catch{}
  try{clearDemoAssist()}catch{}
  resetSignedOutState()
  render()
}
function hostedBuildReturnState(delivery){
  if(!delivery||typeof delivery!=='object')return null
  const journey={
    MINIMAL:'scratch',
    SPEC:'plato',
    FULL:'blueprint',
  }[delivery.preset]
  const repositoryName=typeof delivery.repositoryName==='string'
    ?delivery.repositoryName
    :''
  if(!journey||!/^[a-z0-9][a-z0-9._-]{0,99}$/.test(repositoryName))return null
  if(delivery.preset==='FULL')return {
    journey,
    journeyId:null,
    draft:null,
  }
  const journeyId=delivery.source?.journeyId
  if(typeof journeyId!=='string'||!/^[a-z0-9][a-z0-9-]{0,63}$/.test(journeyId))return null
  if(delivery.preset==='MINIMAL')return {
    journey,
    journeyId,
    draft:{
      id:journeyId,
      preset:'MINIMAL',
      repositoryName,
      status:'DRAFT',
    },
  }
  const inception=delivery.source?.inception
  if(!inception||typeof inception!=='object'||Array.isArray(inception))return null
  return {
    journey,
    journeyId,
    draft:{
      id:journeyId,
      preset:'SPEC',
      repositoryName,
      status:'CONTRACT_READY',
      transcript:[],
      inception:structuredClone(inception),
    },
  }
}
function readHostedGitHubCallback(){
  const params=new URLSearchParams(window.location.search)
  const deliveryId=params.get('github_delivery')||''
  const error=params.get('github_error')||''
  const warning=params.get('github_warning')||''
  if(!deliveryId&&!error&&!warning)return null
  if(warning!=='revocation_failed'&&warning!=='')return {deliveryId:'',error:'invalid_callback'}
  if(warning&&!deliveryId)return {deliveryId:'',error:'invalid_callback'}
  if(error&&!new Set(['authorization_cancelled','authorization_expired','delivery_failed','revocation_failed']).has(error)){
    return {deliveryId:'',error:'invalid_callback'}
  }
  if(deliveryId&&!/^[a-z0-9][a-z0-9-]{0,63}$/.test(deliveryId)){
    return {deliveryId:'',error:'invalid_callback'}
  }
  return {deliveryId,error,warning}
}
function clearHostedGitHubCallback(){
  window.history.replaceState({},document.title,`${window.location.pathname}${window.location.hash}`)
}
async function completeHostedGitHubAuthorization(callback){
  if(!callback.deliveryId&&callback.error)return {
    ok:false,
    text:callback.error==='authorization_cancelled'
      ?'GitHub authorization was cancelled. Review the repository approval and try again.'
      :callback.error==='authorization_expired'
        ?'GitHub authorization expired. Start the repository approval again.'
        :'GitHub could not create the private repository. Start the repository approval again.',
  }
  if(!callback.deliveryId)return {
    ok:false,
    text:'GitHub did not return a delivery reference. Start the repository approval again.',
  }
  if(!getAccessToken())return {
    ok:false,
    text:'Your platform session expired before GitHub returned. Sign in and start the repository approval again.',
  }
  const result=await api('/delivery/'+encodeURIComponent(callback.deliveryId))
  const delivery=result?.delivery||(result?.id?result:null)
  if(callback.error)return {
    ok:false,
    delivery:result?.ok===true&&delivery?delivery:null,
    text:callback.warning==='revocation_failed'
      ?'Repository delivery did not finish, and the temporary GitHub token could not be revoked. Revoke Agentic AI Platform Demo in GitHub settings, then resume this delivery.'
      :'Repository delivery did not finish. Review the persisted checkpoint and resume with a fresh GitHub authorization.',
  }
  return result?.ok===true&&delivery
    ?callback.warning==='revocation_failed'
      ?{
          ok:false,
          delivery,
          text:'Private repository delivery completed, but the temporary GitHub authorization could not be revoked. Revoke Agentic AI Platform Demo in GitHub settings before continuing.',
        }
      :{ok:true,delivery}
    :{ok:false,text:apiErrorMessage(result,'GitHub could not create the private repository. Review the approval and try again.')}
}
async function hydrateCognitoSession({requireSelection=false}={}){
  if(authMode()!=='cognito')return
  resetSignedOutState()
  let epoch=sessionEpoch
  cognitoLoginStatus=''
  try{
    const githubCallback=readHostedGitHubCallback()
    let githubAuthorization=null
    await completeSignIn()
    if(!sessionEpochIsCurrent(epoch))return
    if(!getAccessToken()){clearDemoAssist();return}
    const storedContext=getDemoContext()
    let profile=await api('/me',undefined,{settleOnUnauthorized:true})
    if(!sessionEpochIsCurrent(epoch))return
    if(storedContext&&demoContextWasRejected(profile)){
      clearDemoContext()
      profile=await api('/me',undefined,{settleOnUnauthorized:true})
      if(!sessionEpochIsCurrent(epoch))return
    }
    if(!usableCognitoProfile(profile)){
      resetSignedOutState()
      cognitoBootstrapError='Your domains could not be loaded. Try again.'
      return
    }
    if(requireSelection&&profile.profileType==='scoped'&&!profile.canSwitchDemoRole){
      profile={...profile,profileType:'authenticated-unscoped',scopeStatus:'selection-required',domain:null,capabilities:[]}
    }
    if(storedContext)restoreDemoContext(authoritativeDemoContext(profile))
    replaceSession(profile)
    epoch=sessionEpoch
    clearActiveDemoJourney()
    if(profile.profileType==='authenticated-unscoped')return
    if(githubCallback){
      try{
        githubAuthorization=await completeHostedGitHubAuthorization(githubCallback)
        if(!sessionEpochIsCurrent(epoch))return
      }catch(error){
        if(error===CANCELED_REQUEST||!sessionEpochIsCurrent(epoch))return
        githubAuthorization={
          ok:false,
          delivery:null,
          text:'GitHub returned to the platform, but delivery status could not be loaded. Refresh and try again.',
        }
      }finally{
        clearHostedGitHubCallback()
      }
    }
    if(githubAuthorization){
      const buildReturn=hostedBuildReturnState(githubAuthorization.delivery)
      S.hostedBuildDelivery=githubAuthorization.delivery||null
      S.hostedBuildDeliveryResult={
        ok:githubAuthorization.ok,
        text:githubAuthorization.text||(githubAuthorization.delivery?.status==='COMPLETED'
          ?'Private repository delivery completed.'
          :'GitHub authorization completed. Repository delivery is continuing.'),
      }
      if(buildReturn){
        S.hostedBuildJourney=buildReturn.journey
        S.hostedBuildJourneyDraft=buildReturn.draft
        if(buildReturn.journeyId){
          try{
            const restored=await api('/journeys/'+encodeURIComponent(buildReturn.journeyId))
            if(!sessionEpochIsCurrent(epoch))return
            if(restored?.ok===true&&restored.journey){
              S.hostedBuildJourneyDraft=restored.journey
            }else{
              S.hostedBuildDeliveryResult={
                ok:false,
                text:'GitHub returned successfully, but the full journey could not be refreshed. The delivery details remain available.',
              }
            }
          }catch(error){
            if(error===CANCELED_REQUEST||!sessionEpochIsCurrent(epoch))return
            S.hostedBuildDeliveryResult={
              ok:false,
              text:'GitHub returned successfully, but the full journey could not be refreshed. The delivery details remain available.',
            }
          }
        }
      }
      S.view='compose'
    }else{
      S.view=mainHomeView()
    }
  }catch(error){
    if(error===CANCELED_REQUEST||!sessionEpochIsCurrent(epoch))return
    resetSignedOutState()
    if(getAccessToken())cognitoBootstrapError='Your domains could not be loaded. Try again.'
    else cognitoLoginStatus='Sign-in could not be completed.'
  }
}
async function signOutCurrentSession(){
  if(!confirmContextChange())return
  if(authMode()==='cognito'){
    clearDemoAssist()
    resetSignedOutState()
    cognitoLoginStatus=''
    render()
    try{cognitoSignOut()}catch(error){
      cognitoLoginStatus=cognitoErrorMessage(error,'Sign-out could not be completed.')
      render()
    }
    return
  }
  const logout=fetch(apiUrl('/logout'),{
    method:'POST',
    headers:{'content-type':'application/json',...authHeaders()},
    body:'{}',
  }).catch(()=>{})
  resetSignedOutState()
  render()
  await logout
}

// Per-page story strip
// The "You are / You own" strip was
// explainer chrome — cut. The Next cross-link stays: it is a real navigation
// path, limited to the views currently shown in the demo.
function storyLine(own, nextView, nextLabel){
  const ok = nextView && allowedViews().includes(nextView==='requests'?'governance':nextView)
  if(!ok) return ''
  return `<div class="story" id="storyline"><a class="storynext" data-goview="${nextView}">${esc(nextLabel)} →</a></div>`
}

// Personas: nav scoping per role. Identity itself lives in the server session.
const PERSONAS = {
  admin:   { label:'Platform Admin' },
  builder: { label:'Domain Builder' },
  user:    { label:'End User' },
}
// Login page config: IdP tiles are an interchangeability showcase — every tile
// lands on the same demo directory. End User tile issues a session silently.
const LOGIN_IDPS = [
  { id:'okta',    label:'Okta',                mark:'○', hint:'SAML / OIDC' },
  { id:'entra',   label:'Microsoft Entra ID',  mark:'▦', hint:'OIDC' },
  { id:'cognito', label:'Amazon Cognito',      mark:'◆', hint:'User pool' },
]
const LOGIN_USERS = []
// The console is the persona's entire UI, so the shell remains role-aware.
// no cross-persona shared sidebar. Each role gets its own shell:
//   builder  -> Build Workspace (project-scoped tabs, spec §1.2)
//   lead     -> Domain Console  (Dashboard/Projects/Users & Access/Governance & Approvals, spec §6)
//   admin    -> Platform Console (Home/AI Registry/Governance/Platform Approvals/Blueprints/Platform Projects, spec §7 + TLP-B4)
//   user     -> approved-agents view only
// A nav item carries the routing target: view (+ optional workspace/console
// tab). Old global entries (Overview/Blueprints/My Domain/Agent Fleet/AI
// Gateway/Memory/Cost/…) are retired as top-level nav — their capabilities are
// absorbed into the shells (spec §1/§6/§7 mapping).
const SHELL = () => {
  const role = SESSION && SESSION.role
  return role==='admin' ? 'admin' : role==='lead' ? 'lead' : role==='user' ? 'user' : 'builder'
}
const SHELL_HOME = {admin:'platformconsole',lead:'domainconsole',builder:'workspace',user:'overview'}
// Inline linear SVG icon set (16px render, 24 viewBox, stroke=currentColor) —
// zero-dependency replacement for the emoji UI icons (design proposal §2.4).
const svgi = d => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`
const ICONS = {
  home: svgi('<path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V21h14V9.5"/><path d="M10 21v-6h4v6"/>'),
  console: svgi('<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 9l3 3-3 3"/><path d="M12.5 15H17"/>'),
  registry: svgi('<ellipse cx="12" cy="5.5" rx="8" ry="2.5"/><path d="M4 5.5V12c0 1.4 3.6 2.5 8 2.5s8-1.1 8-2.5V5.5"/><path d="M4 12v6.5C4 19.9 7.6 21 12 21s8-1.1 8-2.5V12"/>'),
  shield: svgi('<path d="M12 3l7 3v5c0 4.5-3 8.5-7 10-4-1.5-7-5.5-7-10V6l7-3z"/><path d="M9.5 12l2 2 3.5-4"/>'),
  tag: svgi('<path d="M3 3h8l10 10-8 8L3 11V3z"/><circle cx="8" cy="8" r="1.6"/>'),
  fleet: svgi('<rect x="4" y="8" width="16" height="10" rx="2"/><circle cx="9" cy="13" r="1.2"/><circle cx="15" cy="13" r="1.2"/><path d="M12 8V5"/><circle cx="12" cy="4" r="1"/>'),
  cost: svgi('<circle cx="12" cy="12" r="9"/><path d="M12 6.5v11"/><path d="M15 8.8c-.6-1-1.7-1.5-3-1.5-1.8 0-3 .9-3 2.3 0 3.2 6 1.7 6 4.8 0 1.4-1.2 2.3-3 2.3-1.3 0-2.4-.5-3-1.5"/>'),
  memory: svgi('<rect x="6" y="6" width="12" height="12" rx="2"/><path d="M9 6V3M15 6V3M9 21v-3M15 21v-3M6 9H3M6 15H3M21 9h-3M21 15h-3"/>'),
  chart: svgi('<path d="M4 4v16h16"/><path d="M8 16v-5"/><path d="M12 16V8"/><path d="M16 16v-3"/>'),
  blueprint: svgi('<rect x="3" y="3" width="8" height="8" rx="1.5"/><rect x="13" y="3" width="8" height="8" rx="1.5"/><rect x="3" y="13" width="8" height="8" rx="1.5"/><path d="M17 14v6M14 17h6"/>'),
  compose: svgi('<path d="M12 4.5 5 8v8l7 3.5L19 16V8l-7-3.5z"/><path d="M5 8l7 3.5L19 8"/><path d="M12 11.5V19"/>'),
  folder: svgi('<path d="M3 6a2 2 0 0 1 2-2h4l2 2.5h8a2 2 0 0 1 2 2V18a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6z"/>'),
  audit: svgi('<path d="M6 3h9l4 4v14H6V3z"/><path d="M15 3v4h4"/><path d="M9 12h6M9 16h6"/>'),
  agents: svgi('<rect x="5" y="9" width="14" height="9" rx="2"/><circle cx="10" cy="13.5" r="1.2"/><circle cx="14" cy="13.5" r="1.2"/><path d="M12 9V6"/><circle cx="12" cy="5" r="1"/>'),
  users: svgi('<circle cx="9" cy="8" r="3.5"/><path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6"/><circle cx="17" cy="9" r="2.5"/><path d="M17 14.5c2.5.4 4 2.4 4 5"/>'),
  building: svgi('<rect x="5" y="3" width="14" height="18"/><path d="M9 7h2M13 7h2M9 11h2M13 11h2M9 15h2M13 15h2"/><path d="M10 21v-3h4v3"/>'),
  idcard: svgi('<rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="8.5" cy="11" r="2"/><path d="M5.5 16c.5-1.4 1.6-2.2 3-2.2s2.5.8 3 2.2"/><path d="M14 9.5h5M14 13h5"/>'),
  bell: svgi('<path d="M6 9.5a6 6 0 0 1 12 0c0 5 2 6 2 6H4s2-1 2-6z"/><path d="M10.5 19a1.7 1.7 0 0 0 3 0"/>'),
  lock: svgi('<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V7.5a4 4 0 0 1 8 0V11"/>'),
  unlock: svgi('<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V7.5a4 4 0 0 1 7.7-1.5"/>'),
  compass: svgi('<circle cx="12" cy="12" r="9"/><path d="M15.5 8.5 13.8 13.8 8.5 15.5l1.7-5.3 5.3-1.7z"/>'),
  clipboard: svgi('<rect x="5" y="4" width="14" height="17" rx="2"/><path d="M9 4a3 3 0 0 1 6 0"/><path d="M9 10h6M9 14h6"/>'),
  packagebox: svgi('<path d="M12 3 4 7v10l8 4 8-4V7l-8-4z"/><path d="M4 7l8 4 8-4"/><path d="M12 11v10"/><path d="M8 5l8 4"/>'),
  key: svgi('<circle cx="8" cy="15" r="4"/><path d="M11 12 20 3"/><path d="M17 6l2.5 2.5M14.5 8.5 17 11"/>'),
  chat: svgi('<path d="M21 12a8 8 0 0 1-8 8H4l2-3.2A8 8 0 1 1 21 12z"/><path d="M8.5 11h7M8.5 14h4.5"/>'),
  wrench: svgi('<path d="M14.5 6.5a4.5 4.5 0 0 0-6 6L3 18l3 3 5.5-5.5a4.5 4.5 0 0 0 6-6L14 13l-3-3 3.5-3.5z"/>'),
  ruler: svgi('<rect x="2.5" y="8.5" width="19" height="7" rx="1.5" transform="rotate(-45 12 12)"/><path d="M9 12.5l1.5 1.5M12 9.5l1.5 1.5M15 6.5 16.5 8"/>'),
  book: svgi('<path d="M4 5a2 2 0 0 1 2-2h14v18H6a2 2 0 0 0-2 2V5z"/><path d="M20 17H6a2 2 0 0 0-2 2"/>'),
  plug: svgi('<path d="M9 3v5M15 3v5"/><path d="M6 8h12v3a6 6 0 0 1-6 6 6 6 0 0 1-6-6V8z"/><path d="M12 17v4"/>'),
  handshake: svgi('<path d="M3 8l4-2 5 2 5-2 4 2v7l-4 2-5-2-5 2-4-2V8z"/><path d="M12 8v9"/>'),
  hand: svgi('<path d="M8 12V5.5a1.5 1.5 0 0 1 3 0V11"/><path d="M11 11V4.5a1.5 1.5 0 0 1 3 0V11"/><path d="M14 11V6a1.5 1.5 0 0 1 3 0v7a6 6 0 0 1-6 6h-.5a6 6 0 0 1-5-2.7L3.6 14a1.4 1.4 0 0 1 2.2-1.7L8 14.5"/>'),
  hourglass: svgi('<path d="M6 3h12"/><path d="M6 21h12"/><path d="M7 3v3.5c0 2 2.2 3.2 5 5.5-2.8 2.3-5 3.5-5 5.5V21"/><path d="M17 3v3.5c0 2-2.2 3.2-5 5.5 2.8 2.3 5 3.5 5 5.5V21"/>'),
  chevron: svgi('<path d="M6 9l6 6 6-6"/>'),
}
const ic2 = i => `<span class="ic2">${i}</span>`
// Shorthands for icons injected inline in template strings (replacing emoji).
const LOCK_IC=ic2(ICONS.lock), UNLOCK_IC=ic2(ICONS.unlock), BELL_IC=ic2(ICONS.bell), MEM_IC=ic2(ICONS.memory),
  FOLDER_IC=ic2(ICONS.folder), AGENT_IC=ic2(ICONS.agents), TAG_IC=ic2(ICONS.tag), SHIELD_IC=ic2(ICONS.shield),
  PLUG_IC=ic2(ICONS.plug), A2A_IC=ic2(ICONS.handshake), BOOK_IC=ic2(ICONS.book), COMPASS_IC=ic2(ICONS.compass),
  KEY_IC=ic2(ICONS.key), BP_IC=ic2(ICONS.blueprint), CHAT_IC=ic2(ICONS.chat), WRENCH_IC=ic2(ICONS.wrench),
  RULER_IC=ic2(ICONS.ruler), CLIP_IC=ic2(ICONS.clipboard), PKG_IC=ic2(ICONS.packagebox), HAND_IC=ic2(ICONS.hand),
  HG_IC=ic2(ICONS.hourglass), IDCARD_IC=ic2(ICONS.idcard)
// [navId, label, icon, view, tabKey, tabValue]
const SHELL_NAV = {
  // Builder nav IS the project workspace's tab bar. Monitoring and
  // Observability are hidden for this demo; inspect telemetry in CloudWatch.
  // Every entry stays inside the active project's scope.
  builder: [
    ['fleet','Fleet',ICONS.fleet,'workspace','wsTab','fleet'],
    ['build','Build Agent +',ICONS.compose,'compose',null,null],
    ['memorykb','Memory & KB',ICONS.memory,'workspace','wsTab','memorykb'],
    ['cost','Cost',ICONS.cost,'workspace','wsTab','cost'],
    // Registry renders zero write affordances without manageRegistryEntries.
    ['registry','AI Registry',ICONS.registry,'registry',null,null],
    // NO Governance entry — request-access is an inline action where it's
    // needed (Memory & KB, registry detail), never a nav destination (spec §1.2 ⑦).
  ],
  lead: [
    ['dashboard','Dashboard',ICONS.home,'domainconsole','dcTab','dashboard'],
    ['projects','Projects',ICONS.folder,'domainconsole','dcTab','projects'],
    ['users','Users & Access',ICONS.users,'domainconsole','dcTab','users'],
    // the lead-variant Governance view IS the domain approval inbox
    ['governance','Governance & Approvals',ICONS.shield,'governance',null,null],
  ],
  // TLP-B9 (spec v2.5 §0/§2 — platform is itself a domain; every console is a
  // governance section + that domain's OWN build workspace, isomorphic with
  // the builder nav). Shared by admin AND lead so the two sections render
  // identically in shape — only the data scope differs (spec §6 nav
  // isomorphism assertion).
  buildworkspace: [
    ['bwfleet','Fleet',ICONS.fleet,'workspace','wsTab','fleet'],
    ['bwbuild','Build Agent +',ICONS.compose,'compose',null,null],
    ['bwmemorykb','Memory & KB',ICONS.memory,'workspace','wsTab','memorykb'],
    ['bwcost','Cost',ICONS.cost,'workspace','wsTab','cost'],
    ['bwregistry','AI Registry',ICONS.registry,'registry',null,null],
  ],
  // The platform shell is a full left
  // sidebar — the operations drill-downs left the Home button wall and became
  // sections; Domains and Memory & KB are top-level. 'Platform Approvals'
  // folded into Governance & Approvals (a platform-only tab); 'Platform
  // Projects' is superseded by Build (the builder-workspace reuse picker).
  admin: [
    ['home','Dashboard',ICONS.home,'platformconsole',null,null],
    ['domains','Domains',ICONS.tag,'domains',null,null],
    ['blueprints','Blueprints',ICONS.blueprint,'blueprints',null,null],
    ['registry','AI Registry (org)',ICONS.registry,'registry',null,null],
    ['governance','Governance & Approvals',ICONS.shield,'governance',null,null],
    ['cost','Cost Management',ICONS.cost,'cost',null,null],
  ],
  user: [
    ['overview','Overview',ICONS.home,'overview',null,null],
    ['fleet','Agents',ICONS.agents,'fleet',null,null],
  ],
}
const activeShellNav = () => SHELL_NAV
// Routable views per shell: the nav targets plus drill-downs reached from
// content (agent detail, project detail, the wizard, inline governance
// links). Display gating only — every API re-checks server-side. Anything
// else falls back to the shell home. NOT nav: the sidebar renders SHELL_NAV
// alone, so a drill-down view never shows up as a menu item.
const SHELL_VIEWS = {
  builder: ['workspace','myprojects','compose','fleet','registry','projects','governance'],
  lead:    ['domainconsole','governance','projects','fleet','compose','workspace','registry'],
  admin:   ['platformconsole','registry','governance','blueprints','workspace','projects','domains','fleet','compose','cost','audit'],
  user:    ['overview','fleet'],
}
const allowedViews = () => SHELL_VIEWS[SHELL()]
const mainHomeView = () => SHELL_HOME[SHELL()]
// The shell's group heading: names the application the persona walked into.
const SHELL_TITLE = { builder:'Build Workspace', lead:'Domain Console', admin:'Platform Console', user:'' }
const shellHeading = () => SHELL_TITLE[SHELL()] ? `<div class="journey">${SHELL_TITLE[SHELL()]}</div>` : ''
// TLP-B9 (spec v2.5 §2): which shells get the second, persistent BUILD
// WORKSPACE section in the sidebar. platform (admin) and domain lead both do
// — every domain (platform included, per §0) gets a governance section PLUS
// its own build workspace. Builder IS a build workspace already (no second
// section); enduser has neither.
const HAS_BUILD_SECTION = { admin:true, lead:true, builder:false, user:false }
const navActive = ([id,,,view,tabKey,tabValue]) => {
  if (S.view !== view)
    // builder Fleet stays lit on the agent drill-down out of the fleet tab
    return SHELL()==='builder' && id==='fleet' && S.view==='fleet'
  if (!tabKey) return true
  const cur = S[tabKey] || (tabKey==='dcTab'?'dashboard':'fleet')
  return cur === tabValue
}

// TLP-B7 scope 4: AWS-console-style top bar — inline SVG brand mark (no
// external assets) left, persona/session controls right. Renders on every
// page including login (brand only when signed out).
const BRAND_MARK = `<svg width="26" height="26" viewBox="0 0 26 26" aria-hidden="true">
  <rect x="1" y="1" width="24" height="24" rx="4" fill="#0f141a" stroke="#424650" stroke-width="1.4"/>
  <path d="M7 17.5 13 6.5 19 17.5" fill="none" stroke="#ffffff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
  <path d="M9.6 13.9h6.8" stroke="#ffffff" stroke-width="2" stroke-linecap="round"/>
</svg>`
let demoContextSwitching=false
function renderDemoControls(){
  if(authMode()!=='cognito'||!SESSION?.canSwitchDemoRole)return ''
  const roleOptions=availableDemoRoleOptions(SESSION)
  const availableDomains=Array.isArray(SESSION.availableDemoDomains)
    ? SESSION.availableDemoDomains
    : []
  const domains=availableDomains
  const domainControl=['lead','builder'].includes(SESSION.role)
    ? `<label class="tb-demo-field"><span>Working domain</span><select id="tbdomain" aria-label="Authorized working domain" ${demoContextSwitching?'disabled':''}>
        ${domains.map(domain=>`<option value="${esc(domain.id)}" ${SESSION.domain===domain.id?'selected':''}>${esc(domain.name)}</option>`).join('')}
      </select></label>`
    : ''
  return `<div class="tb-demo-controls" aria-busy="${demoContextSwitching?'true':'false'}">
    <label class="tb-demo-field"><span>Working role</span><select id="tbrole" aria-label="Authorized working role" ${demoContextSwitching?'disabled':''}>
      ${roleOptions.map(({id,label})=>`<option value="${id}" ${SESSION.role===id?'selected':''}>${label}</option>`).join('')}
    </select></label>
    ${domainControl}
  </div>`
}
function setDemoControlsDisabled(disabled){
  for(const id of ['tbrole','tbdomain']){
    const control=document.getElementById(id)
    if(control)control.disabled=disabled
  }
  document.querySelector('.tb-demo-controls')?.setAttribute('aria-busy',disabled?'true':'false')
}
// Only explicitly registered business drafts protect a context change.
function hasUnsavedContextChanges(){
  return domainBootstrapDirty()||projectBudgetDirty()||businessForms.isDirty()
    ||!!(S.wiz&&wizardDirty.isDirty('wizard',S.wiz.data))
    ||composeDirty.isDirty('compose',composeDraft())
    ||approvalReasonDrafts.isDirty(approvalReasonScope())
}
function confirmContextChange(){
  if(hasUnsavedContextChanges()&&!confirm('Discard unsaved changes and leave this working context?'))return false
  return true
}
function confirmApprovalReasonDiscard(){
  if(!approvalReasonDrafts.isDirty(approvalReasonScope()))return true
  if(!confirm('Discard unsaved approval review reasons?'))return false
  approvalReasonDrafts.discard(approvalReasonScope())
  return true
}
async function switchDemoContext(requested){
  if(authMode()!=='cognito'||!SESSION?.canSwitchDemoRole||demoContextSwitching)return
  if(!confirmContextChange()){renderTopbar();return}
  const previousContext=getDemoContext()
  const previousProfile=SESSION
  const previousView=S.view
  invalidateSessionWork()
  const epoch=sessionEpoch
  demoContextSwitching=true
  setDemoControlsDisabled(true)
  const main=globalThis.document?.getElementById?.('main')
  if(main)main.innerHTML='<div class="empty"><span class="spin">⟳</span> switching working context…</div>'
  try{
    setDemoContext(requested,{
      allowAdminDomain:false,
    })
    const profile=await api('/me',undefined,{settleOnUnauthorized:true})
    if(!sessionEpochIsCurrent(epoch))return
    if(!usableCognitoProfile(profile)
      || !sameAuthenticatedIdentity(profile,previousProfile)
      || profile.demoRoleActive!==true
      || profile.role!==requested.role
      || (['lead','builder'].includes(requested.role)&&profile.domain!==requested.domain)){
      throw new Error('The requested working role could not be activated.')
    }
    restoreDemoContext(authoritativeDemoContext(profile))
    replaceSession(profile)
    clearActiveDemoJourney()
    S.view=mainHomeView()
    render()
  }catch(error){
    if(!sessionEpochIsCurrent(epoch))return
    const sessionWasInvalidated=SESSION!==previousProfile
    let stillAuthenticated=false
    if(!sessionWasInvalidated)try{stillAuthenticated=!!getAccessToken()}catch{}
    if(sessionWasInvalidated||!stillAuthenticated){
      failClosedCognitoSession()
      return
    }
    try{restoreDemoContext(previousContext)}catch{
      failClosedCognitoSession()
      return
    }
    replaceSession(previousProfile)
    S.view=previousView
    render()
    alert(cognitoErrorMessage(error,'Could not switch working role.'))
  }finally{
    demoContextSwitching=false
    setDemoControlsDisabled(false)
  }
}
function closeProfileMenuOnDocumentClick(event){
  const menu=document.getElementById('tbprofilemenu')
  const profile=document.querySelector('.tb-profile')
  if(!menu?.classList.contains('open'))return
  if(profile?.contains(event.target))return
  menu.classList.remove('open')
  document.getElementById('tbprofile')?.setAttribute('aria-expanded','false')
}
document.addEventListener('click',closeProfileMenuOnDocumentClick)
function renderTopbar(){
  const bar=document.getElementById('topbar'); if(!bar)return
  const brand=`<div class="tb-brand">${BRAND_MARK}<span>Agentic AI Platform</span></div>`
  if(!SESSION){ bar.innerHTML=brand+`<div class="tb-right">${cognitoBootstrapError&&getAccessToken()?'Signed in':'Sign in with your identity provider'}</div>`; return }
  const roleLabel = SESSION.role==='lead' ? 'Domain Lead' : (PERSONAS[S.who]||{}).label||SESSION.role
  bar.innerHTML=brand+`<div class="tb-right">
    <span class="tb-role">Working as ${esc(roleLabel)}</span>
    ${renderDemoControls()}
    ${renderOrdinaryDomainControl()}
    <div class="tb-profile">
      <button class="tb-profile-trigger" id="tbprofile" aria-expanded="false" aria-controls="tbprofilemenu"><span class="tb-identity-label">Signed-in identity</span><b>${esc(SESSION.name)}</b> <span aria-hidden="true">▾</span></button>
      <div class="tb-profile-menu" id="tbprofilemenu">
        <p class="tb-authenticated-role">Authenticated role: ${esc(SESSION.authenticatedRole||SESSION.role)}</p>
        <button id="tbswitchuser">Switch user</button>
        <button id="tbsignout">Sign out</button>
      </div>
    </div>
  </div>`
  document.getElementById('tbprofile').onclick=(e)=>{
    e.stopPropagation()
    const open=document.getElementById('tbprofilemenu').classList.toggle('open')
    e.currentTarget.setAttribute('aria-expanded',String(open))
  }
  document.getElementById('tbswitchuser').onclick=signOutCurrentSession
  document.getElementById('tbsignout').onclick=signOutCurrentSession
  wireOrdinaryDomainControl()
  const roleSelect=document.getElementById('tbrole')
  if(roleSelect)roleSelect.onchange=sessionTaskHandler(async()=>{
    const role=roleSelect.value
    const domains=SESSION.availableDemoDomains||[]
    const currentAllowed=domains.some(domain=>domain.id===SESSION.domain)
    const domain=role==='admin'
      ? null
      : ['lead','builder'].includes(role)
      ? (currentAllowed?SESSION.domain:domains[0]?.id||null)
      : null
    if(['lead','builder'].includes(role)&&!domain){
      roleSelect.value=SESSION.role
      alert('No authorized domain is available for that role.')
      return
    }
    await switchDemoContext({role,domain})
  })
  const domainSelect=document.getElementById('tbdomain')
  if(domainSelect)domainSelect.onchange=sessionTaskHandler(
    ()=>switchDemoContext({role:SESSION.role,domain:domainSelect.value}),
  )
}

// TLP-B9 (spec v2.5 §2/§6): render sidebar sections. platform/lead get a
// governance section (their own SHELL_NAV list) + a persistent BUILD
// WORKSPACE section (SHELL_NAV.buildworkspace, isomorphic with the builder
// nav — the nav-isomorphism assertion checks these two arrays for structural
// equality). Builder/user get their single section as before.
function navItemVisible(item){
  if(authMode()!=='cognito')return true
  const [,,,view,,tabValue]=item
  const surfaces=new Set(enabledHostedSurfaces(authoritativeCapabilities(SESSION)).map(surface=>surface.id))
  const surface=view==='workspace'?(tabValue==='cost'?'cost':'projects')
    :view==='domainconsole'?(tabValue==='users'?'domainaccess':'projects')
    :view==='compose'?'build':view==='blueprints'?'registry'
    :view==='platformconsole'?'dashboard':view==='monitoring'||view==='observability'?'operations'
    :view==='governance'?'approvals':view==='fleet'?'approvedagents':view
  return surfaces.has(surface)
}
function navSections(){
  const cls = S.who==='admin'?'plat':S.who==='user'?'':'dom'
  const renderItems = items => items.filter(navItemVisible).map(it=>{
    const [id,label,,view]=it
    return `<button type="button" class="nav ${cls} ${navActive(it)?'active':''}" data-shellnav="${id}" data-view="${esc(view)}"${navActive(it)?' aria-current="page"':''}>${esc(label)}</button>`
  }).join('')
  const nav=activeShellNav()
  const group=(id,label,items)=>{
    const visible=items.filter(navItemVisible)
    if(!visible.length)return ''
    const current=visible.find(navActive)
    return `<details class="nav-group" data-nav-group="${id}" ${S.navClosed?.[id]?'':'open'}><summary>${label}</summary>${current?`<p class="nav-current">Current: ${esc(current[1])}</p>`:''}<div class="nav-items">${renderItems(visible)}</div></details>`
  }
  if(!HAS_BUILD_SECTION[SHELL()]){
    return SHELL()==='builder'?group('workspace','Build Workspace',nav.builder):renderItems(nav.user)
  }
  // The org registry already provides the admin's Registry destination.
  const bwItems = SHELL()==='admin' ? nav.buildworkspace.filter(it=>it[0]!=='bwregistry') : nav.buildworkspace
  return group('governance',SHELL()==='admin'?'Platform':'Domain',nav[SHELL()])+group('workspace','Build Workspace',bwItems)
}

function sidebar(){
  const side=document.getElementById('side')
  const access = allowedDomains()
  const domainControl = authMode()==='mock' && (access.length > 1 || hasCap('viewAllDomains'))
    ? `<div style="padding:4px 6px 0">
        <label style="margin:0 0 4px;font-size:.64rem;color:var(--muted);text-transform:uppercase;letter-spacing:.04em">Active domain</label>
        <select id="domainselect" style="width:100%;padding:5px 8px;font-size:.74rem">
          ${hasCap('viewAllDomains')?`<option value="" ${!activeDomain()?'selected':''}>all domains</option>`:''}
          ${access.map(id=>`<option value="${esc(id)}" ${activeDomain()===id?'selected':''}>${esc(domainLabel(id))}</option>`).join('')}
        </select>
      </div>`
    : ''
  side.style.display=''
  side.innerHTML = domainControl + shellHeading() + navSections()
  side.querySelectorAll('[data-shellnav]').forEach(n=>n.onclick=()=>{
    const nav=activeShellNav()
    const items=(nav[SHELL()]||[]).concat(nav.buildworkspace||[])
    const it=items.find(x=>x[0]===n.dataset.shellnav); if(!it||!navItemVisible(it))return
    if(!confirmContextChange())return
    clearBusinessDrafts();S.wiz=null
    pendingNavFocus=n.dataset.shellnav
    const [id,,,view,tabKey,tabValue]=it
    S.view=view
    if(tabKey)S[tabKey]=tabValue
    // B14: Platform Monitoring (aggregate view) and the build workspace's
    // Observability (content view) are separate routes — each nav entry
    // resets its own default scope + tab.
    if(view==='monitoring'){ S.obsScope={type:'fleet',id:'all',label:'Entire platform'}; S.obsTab='metrics' }
    else if(view==='observability'){ const dom=activeDomain()||'platform'; S.obsScope={type:'domain',id:dom,label:domainLabel(dom)}; S.obsTab='metrics' }
    // leaving a drill-down: clear stale detail state so the nav target renders
    S.fleetAgent=null; S.domainDetail=null; S.projectDetail=null
    render()
  })
  side.querySelectorAll('[data-nav-group]').forEach(group=>group.ontoggle=()=>{
    S.navClosed ||= {}
    S.navClosed[group.dataset.navGroup]=!group.open
  })
  const dsel=document.getElementById('domainselect')
  if(dsel)dsel.onchange=sessionTaskHandler(async()=>{
    if(!confirmContextChange()){dsel.value=activeDomain()||'';return}
    dsel.disabled=true
    const r=await api('/session-domain',{domain:dsel.value||null})
    if(!r.ok){ alert(r.error||'Could not switch domain.'); dsel.disabled=false; return }
    setSession(r); resetScopedCaches(); render()
  })
}

// ---------- Login (mock SSO showcase) ----------
// Step 1: pick an identity provider (Okta / Entra ID / Cognito — interchangeable,
// same directory behind all three). Step 2: pick a demo user, or enter as End
// User (tile silently issues a session — end users have identity too).
function renderCognitoHydration(){
  renderTopbar()
  const side=document.getElementById('side'); side.innerHTML=''; side.style.display='none'
  document.getElementById('main').innerHTML=`<div style="max-width:560px;margin:12vh auto 0">
    <h1>Signing in</h1>
    <div class="card">
      <div class="status info" role="status" aria-live="polite"><span class="spin">⟳</span> authenticating…</div>
    </div>
  </div>`
}
async function vLogin(){
  const main=document.getElementById('main')
  renderTopbar()
  // TLP-B7 reskin: the brand lives in the top bar — signed-out pages carry no sidebar
  const side=document.getElementById('side'); side.innerHTML=''; side.style.display='none'
  if(authMode()==='cognito'){
    disposeLanding?.()
    disposeLanding=mountLanding(main,`<button class="primary" id="cognitosignin">Sign in with Cognito</button>
      <div id="loginstatus" role="status" aria-live="polite">${cognitoLoginStatus?`<div class="status err">${esc(cognitoLoginStatus)}</div>`:''}</div>`)
    document.getElementById('cognitosignin').onclick=async()=>{
      const st=document.getElementById('loginstatus')
      st.innerHTML='<div class="status info"><span class="spin">⟳</span> redirecting to sign in…</div>'
      try{
        await beginSignIn()
      }catch(error){
        cognitoLoginStatus=cognitoErrorMessage(error,'Sign-in could not be started.')
        st.innerHTML=`<div class="status err">${esc(cognitoLoginStatus)}</div>`
      }
    }
    return
  }
  // T12: the directory includes accounts vended with a domain (server-defined,
  // like everything identity — the tile only carries the user id).
  if(!S.loginUsers){
    try{ S.loginUsers=((await (await fetch(apiUrl('/login-users'))).json()).users)||[] }catch{ S.loginUsers=[] }
  }
  const tiles=[...LOGIN_USERS,...S.loginUsers.map(u=>({id:u.id,name:u.name,title:u.title}))]
  const idpStep=`
    <div class="sec-h" style="margin-top:0">1 · Sign in with your identity provider</div>
    <div class="grid3">
      ${LOGIN_IDPS.map(i=>`<div class="item pick idptile ${S.loginIdp===i.id?'sel':''}" data-idp="${i.id}">
        <h4><span style="margin-right:8px">${i.mark}</span>${i.label}</h4>
        <div class="d">${i.hint} · single sign-on</div>
      </div>`).join('')}
    </div>`
  const userStep=!S.loginIdp?'':`
    <div class="sec-h">2 · Choose your account</div>
    <div class="grid2">
      ${tiles.map(u=>`<div class="item pick usertile" data-loginuser="${esc(u.id)}">
        <h4>${esc(u.name)}</h4><div class="d">${esc(u.title)}</div>
      </div>`).join('')}
    </div>
    <div class="sec-h">or</div>
    <div class="item pick usertile" data-loginuser="enduser" style="max-width:420px">
      <h4>Continue as End User</h4><div class="d">Find approved agents and chat with them.</div>
    </div>
    <div id="loginstatus">${mockLoginAttempt?'<div class="status info"><span class="spin">⟳</span> signing in…</div>':''}</div>`
  main.innerHTML=`<div style="max-width:760px;margin:8vh auto 0">
    <h1>Sign in</h1>
    <p class="subtitle">Sign in with your company identity provider · single sign-on.</p>
    <div class="card">${idpStep}${userStep}</div>
    <div style="text-align:center;padding:28px 0 8px;color:var(--muted);font-size:.72rem">${BRAND_MARK}<div style="margin-top:6px">Agentic AI Platform</div></div>
  </div>`
  main.querySelectorAll('.idptile').forEach(t=>t.onclick=()=>{S.loginIdp=t.dataset.idp;render()})
  const setMockLoginTilesDisabled=disabled=>main.querySelectorAll('.usertile').forEach(tile=>{
    if(disabled)tile.setAttribute('aria-disabled','true');else tile.removeAttribute('aria-disabled')
  })
  setMockLoginTilesDisabled(!!mockLoginAttempt)
  main.querySelectorAll('.usertile').forEach(t=>t.onclick=()=>{
    if(mockLoginAttempt)return
    const attempt={user:t.dataset.loginuser,idp:S.loginIdp}
    mockLoginAttempt=attempt
    setMockLoginTilesDisabled(true)
    runSessionTask(async()=>{
      const st=document.getElementById('loginstatus')
      if(st)st.innerHTML='<div class="status info"><span class="spin">⟳</span> signing in…</div>'
      try{
        const r=await api('/login',{user:attempt.user,idp:attempt.idp})
        if(!r.ok){
          if(mockLoginAttempt===attempt)mockLoginAttempt=null
          const currentStatus=document.getElementById('loginstatus')
          if(currentStatus)currentStatus.innerHTML=`<div class="status err">${esc(r.error||'login failed')}</div>`
          setMockLoginTilesDisabled(false)
          return
        }
        replaceSession(r)
        // TLP-B2 role-based landing (spec §1.1/§6.1/§7.1); builder is HYBRID
        // (v2.3 §1): 'myprojects' resumes the last-used workspace or shows cards.
        S.view = r.role==='admin' ? 'platformconsole' : r.role==='lead' ? 'domainconsole' : (r.role==='user' ? 'overview' : 'myprojects')
        render()
      }catch(error){
        if(mockLoginAttempt===attempt)mockLoginAttempt=null
        setMockLoginTilesDisabled(false)
        throw error
      }
    })
  })
}

async function ensure(){
  if(authMode()==='cognito'&&SESSION?.role==='user')return
  if(!S.blueprints.length){ const r=await api('/blueprints'); if(Array.isArray(r)) S.blueprints=r }
  if(!S.catalog){ const r=await api('/catalog'); if(r && !r.error && r.ok!==false){ S.catalog=r; if(!S.ghOrg){ const mockDefault=(sortedGhOrgs(r.githubOrgs||[])[0]||{}).id; if(mockDefault) S.ghOrg=mockDefault } } }
  if(authMode()==='cognito'&&!S.hostedBuildGitHub){
    const r=await rawApi('/delivery/github')
    S.hostedBuildGitHub={configured:r?.github?.configured===true,tokenSupported:r?.github?.tokenSupported===true}
  }
  if(!S.domains){
    try{
      const r=await api('/domains')
      if(r && Array.isArray(r.domains)){ S.domains=r.domains; S.domainDirectory=r.directory||r.domains }
      else if(authMode()==='cognito'){ S.domains=[]; S.domainDirectory=[] }
    }catch(error){
      if(error===CANCELED_REQUEST)throw error
      if(authMode()==='cognito'){ S.domains=[]; S.domainDirectory=[] }
      else throw error
    }
  }
}

// Overview (end-user landing) = the maturity journey (L1→L4).
function vOverview(){
  const persona=S.who
  const framing = persona==='builder'
    ? `<b style="color:var(--dom)">${esc(domainLabel(activeDomain()))}</b> · blueprints, approved catalog, compose-to-deploy wizard`
    : persona==='user'
    ? 'Approved agents, ready to use.'
    : activeDomain()
    ? `Active scope: <b style="color:var(--dom)">${esc(domainLabel(activeDomain()))}</b>`
    : 'Central control plane · self-service domain teams'
  const story = persona==='builder'
    ? storyLine('','compose','Build an Agent')
    : persona==='user'
    ? storyLine('','fleet','Agents')
    : storyLine('','governance','Governance')
  // B18: recommendation cards — the enduser lands on entitled agents from
  // the canonical hosted experience catalog, not the builder fleet API.
  const userRecs = persona==='user' ? `
  <div class="card"><div class="sec-h" style="margin-top:0">Recommended for you</div>
    <div id="ovrecs"><div class="empty"><span class="spin">⟳</span> loading agents…</div></div>
    <div class="bar" style="margin-top:12px"><button class="primary" id="ovquickstart">Browse all agents</button></div>
  </div>` : ''
  return `<h1>${persona==='builder'?`Agentic AI Platform · ${esc(domainLabel(activeDomain()))}`:'Agentic AI Platform'}</h1>
  <p class="subtitle">${framing}</p>
  ${story}
  ${userRecs}`
}
// B18: enduser Overview recommendation cards — live from /api/fleet with the
// exact APPROVED-only filter the Agents page applies; each card opens the
// agent's chat page directly (same navigation as a fleet row click).
async function loadOverviewRecs(){
  const box=document.getElementById('ovrecs'); if(!box)return
  const hosted=authMode()==='cognito'
  const unavailable=()=>{
    box.innerHTML='<div class="empty" role="status">The approved agent catalog is temporarily unavailable. <button class="ghost" id="ovrecsretry">Retry</button></div>'
    box.querySelector('#ovrecsretry').onclick=()=>runSessionTask(loadOverviewRecs)
  }
  let result
  try{
    result=await api(hosted?'/experience/agents':'/fleet')
  }catch(error){
    if(error===CANCELED_REQUEST)return
    unavailable()
    return
  }
  const agents=hosted
    ?(result?.ok===true&&Array.isArray(result.items)?result.items:null)
    :(Array.isArray(result?.agents)
      ?result.agents
        .filter(agent=>agent.project&&agent.approval==='APPROVED')
        .map(agent=>({
          id:agent.project,
          name:agent.name,
          description:((S.domains||[]).find(domain=>domain.id===agent.domain)||{}).description,
        }))
      :null)
  if(!agents){
    unavailable()
    return
  }
  if(!agents.length){ box.innerHTML='<div class="empty">No agents published for you yet.</div>'; return }
  box.innerHTML=`<div class="grid3">${agents.map(a=>`<div class="card bp ovreccard" data-recagent="${esc(a.id)}" data-recname="${esc(a.name)}" style="cursor:pointer">
    <h4>${ic2(ICONS.chat)}${esc(a.name)}</h4>
    <div class="meta" style="margin:4px 0">${regStatusBadge('APPROVED')}</div>
    <p class="d" style="font-size:.78rem;color:var(--dim);margin:4px 0 6px">${esc(a.description||'Reviewed and approved — ready to use.')}</p>
    <div class="bar" style="margin-top:8px"><button class="ghost ovrecchat" style="padding:4px 14px;font-size:.75rem">${ic2(ICONS.chat)}Chat →</button></div>
  </div>`).join('')}</div>`
  box.querySelectorAll('.ovreccard').forEach(card=>card.onclick=()=>{
    S.view='fleet'
    if(hosted){
      S.hostedSelectedAgentId=card.dataset.recagent
      S.hostedExperienceResult=null
      S.hostedExperienceMessage=null
    }else{
      S.fleetAgent={project:card.dataset.recagent,name:card.dataset.recname}
      S.detail=null
      S.fleetChat=[]
      S.fleetSession=null
    }
    render()
  })
}

// Status badge shared by the Governance resource rows and Operate approval column.
// Cloudscape badge variants (solid fill, white text).
const MCP_STATUS_BADGE = {
  APPROVED:'badge-green', IN_REVIEW:'badge-blue', DRAFT:'badge-grey', REJECTED:'badge-red',
}
const mcpBadge = s=>`<span class="badge ${MCP_STATUS_BADGE[s]||'badge-grey'}">${esc(s||'DRAFT')}</span>`
// neutral 'illustrative' chip for simulated surfaces — provenance metadata, not a warning
const simChip = t=>`<span class="chip">${t}</span>`
// F5: the demo-only lifecycle advance buttons are off unless the server was
// started with SHOW_SIM=1 (surfaced as _showSim on /api/catalog). Falls back to
// hidden while the catalog is still loading, which is the default we want.
const showSim = ()=>!!(S.catalog&&S.catalog._showSim)
// Data-source honesty badges (KeyStone pattern): every dashboard, table and
// card says where its numbers come from. Provenance is metadata, not a status
// — neutral grey outlined chips (recolor round 2, audit items 3/6).
const SRC_BADGE = {
  otel:       ['Real OTel data','Derived from real OpenTelemetry spans recorded by deployed agents'],
  cloudwatch: ['Real CloudWatch','Read live from the CloudWatch metrics backend'],
  ledger:     ['Real usage ledger','Metered from real console invocations (chat, streaming chat, eval runs)'],
  fixture:    ['Fixture','Demo fixture data — replace with a live API in production'],
  projection: ['Projection','Modeled estimate, not a measurement'],
}
const srcBadge = k=>{ const [label,title]=SRC_BADGE[k]||SRC_BADGE.fixture
  return `<span class="chip srcbadge" data-src="${esc(k)}" title="${title}" style="font-size:.66rem;vertical-align:1px">${label}</span>` }
// ---------- AI Registry (T18 — unified registry view, replaces Catalog+MCP+A2A) ----------
// Table over the T16/T17 API: type filter chips, governance/status badges,
// row-click drawer with version history + diff + persona-gated actions.
const REG_TYPE_ICON = { Agent:ic2(ICONS.agents), Skill:ic2(ICONS.book), MCPServer:ic2(ICONS.plug), A2AAgent:ic2(ICONS.handshake), Model:ic2(ICONS.memory), Blueprint:ic2(ICONS.blueprint), GuardrailPack:ic2(ICONS.shield) }
const REG_STATUS_BADGE = {
  APPROVED:'badge-green', PENDING_APPROVAL:'badge-blue', IN_REVIEW:'badge-blue', DRAFT:'badge-grey', REJECTED:'badge-red', DEPRECATED:'badge-grey',
}
// Human-readable status wording — the store keeps the enum, the page reads like
// a review queue instead of a database dump. The raw enum stays in the tooltip
// so an admin cross-referencing /api/registry sees the same vocabulary.
const REG_STATUS_LABEL = {
  APPROVED:'Approved', PENDING_APPROVAL:'Pending approval', IN_REVIEW:'Pending review', DRAFT:'Draft', REJECTED:'Rejected', DEPRECATED:'Deprecated',
}
const regStatusBadge = s=>`<span class="badge ${REG_STATUS_BADGE[s]||'badge-grey'}" title="${esc(s||'DRAFT')}" style="white-space:nowrap">${esc(REG_STATUS_LABEL[s]||s||'Draft')}</span>`
// Who signed off on the version a row resolves to, and when. An undecided
// version renders an em dash rather than a guess — this column is the audit
// answer to "who let this in", so an empty cell must mean nobody has yet.
function regApprover(e){
  const v = e.resolved || [...(e.versions||[])].sort((a,b)=>a.semver.localeCompare(b.semver,undefined,{numeric:true})).pop()
  return { by:(v&&v.decidedBy)||null, at:(v&&v.decidedAt)||null }
}
const govModeBadge = m=>`<span class="chip" style="${m==='owned'?'color:var(--dom);border-color:var(--dom-bd)':'color:var(--plat);border-color:var(--plat-bd)'}">${esc(m)}</span>`

const HOSTED_COLLECTION_META = {
  projects:{title:'Projects',description:'Projects visible in the current authorized scope.',icon:ICONS.folder},
  agents:{title:'Agents',description:'Agent drafts and governed lifecycle state visible in the current authorized scope.',icon:ICONS.agents},
  deployments:{title:'Deployments',description:'Sandbox and production deployments visible in the current authorized scope.',icon:ICONS.fleet},
  approvals:{title:'Approvals',description:'Deployment approvals and requests visible in the current authorized scope.',icon:ICONS.shield},
}
const hostedCaps=()=>authoritativeCapabilities(SESSION)
function rememberHostedBuildAgent(agent){
  const key=hostedResourceKey(agent)
  if(!key)return
  S.hostedBuildAgents=[
    ...(S.hostedBuildAgents||[]).filter(candidate=>
      hostedResourceKey(candidate)!==key),
    agent,
  ]
  S.hostedBuildAgentKey=key
}
function hostedRetryState(box,label,retry){
  box.innerHTML=`<div class="empty" role="status">${esc(label)} is temporarily unavailable. <button class="ghost hostedretry">Retry</button></div>`
  box.querySelector('.hostedretry').onclick=()=>{
    box.innerHTML=`<div class="empty"><span class="spin">⟳</span> loading ${esc(label.toLowerCase())}…</div>`
    runSessionTask(retry)
  }
}
function hostedEmpty(label){
  return `<div class="empty">No ${esc(label.toLowerCase())} are available in this scope yet.</div>`
}
function hostedStatus(value){
  const status=String(value||'UNKNOWN')
  const cls=/DEPLOYED|APPROVED|ACTIVE|TESTED|READY/.test(status)
    ?'badge-green'
    :/REJECTED|FAILED|SUSPENDED/.test(status)
    ?'badge-red'
    :/PENDING|REQUESTED|DEPLOYING|IN_REVIEW/.test(status)
    ?'badge-blue'
    :'badge-grey'
  return `<span class="badge ${cls}">${esc(status)}</span>`
}
function hostedCollectionRow(resource,item){
  if(resource==='projects')return {
    title:item.name||item.id,
    meta:[item.domainId,item.id],
    detail:item.description||'No description provided.',
    status:item.status,
  }
  if(resource==='agents')return {
    title:item.name||item.id,
    meta:[item.domainId,item.projectId,item.modelId],
    detail:item.description||'No description provided.',
    status:item.status,
  }
  if(resource==='deployments')return {
    title:item.id,
    meta:[item.domainId,item.projectId,item.agentId,item.environment],
    detail:item.runtimeStatus?`Runtime ${item.runtimeStatus}`:'Runtime provisioning has not completed.',
    status:item.status,
  }
  // Approvals: title says what is being asked (kind + resource type) in plain
  // words; identifiers stay available in the meta chips and detail panel.
  // Self-contained on purpose — several test harnesses extract this function
  // alone into a VM context.
  const APPROVAL_KIND_LABEL={
    RESOURCE_PUBLICATION:'Publication review',
    RESOURCE_ACCESS:'Access request',
    PRODUCTION_DEPLOYMENT:'Production deployment',
  }
  const TYPE_LABEL={MCP_SERVER:'MCP server',KNOWLEDGE_BASE:'knowledge base'}
  const typeLabel=TYPE_LABEL[item.resourceType]||String(item.resourceType||'resource').toLowerCase().replace(/_/g,' ')
  const recordName=String(item.resourceId||'').split('/').pop()||item.resourceId
  const requested=(value=>{
    const t=Date.parse(value); if(!Number.isFinite(t))return null
    const mins=Math.round((Date.now()-t)/60000)
    if(mins<1)return 'just now'
    if(mins<60)return `${mins} min ago`
    const hours=Math.round(mins/60); if(hours<24)return `${hours} h ago`
    return `${Math.round(hours/24)} d ago`
  })(item.requestedAt)
  return {
    title:`${APPROVAL_KIND_LABEL[item.kind]||item.kind} · ${typeLabel}`,
    meta:[item.id,item.domainId,item.projectId,recordName&&`record ${recordName}`,requested&&`requested ${requested}`].filter(Boolean),
    detail:item.initiationReason||item.reason||`${APPROVAL_KIND_LABEL[item.kind]||'Request'} awaiting a reviewer decision.`,
    status:item.status,
  }
}
function hostedCollectionItems(resource,items,{approvalActions=false,compact=false}={}){
  if(!items.length)return hostedEmpty(HOSTED_COLLECTION_META[resource].title)
  return items.map(item=>{
    const row=hostedCollectionRow(resource,item)
    const canDecide=approvalActions&&hostedApprovalRecordAllowed(item)
    // Publications get the visibility choice alongside Approve — the platform
    // team decides in the same 4-eyes action which domains may DISCOVER the
    // record (open to all / selected domains / publisher-only by default).
    const visibilityChoice=canDecide&&item.kind==='RESOURCE_PUBLICATION'&&SESSION?.role==='admin'
      ? `<label style="margin-top:6px">Catalog visibility after approval
          <select class="approval-visibility" data-visibility-for="${esc(item.id)}">
            <option value="">Publisher domain only (decide later)</option>
            <option value="open">Open to all domains</option>
            <option value="restricted">Selected domains…</option>
          </select></label>
        <input class="approval-visibility-domains" data-visibility-domains-for="${esc(item.id)}" placeholder="domain ids, comma-separated (e.g. customer_support, operations)" style="display:none;margin-top:4px"/>`
      :''
    const actions=canDecide
      ? `<div class="bar" style="margin-top:10px">
          <button class="ghost hostedapproval" data-kind="${esc(item.kind)}" data-resource-type="${esc(item.resourceType||'')}" data-decision="APPROVE" data-domain="${esc(item.domainId)}" data-project="${esc(item.projectId||'')}" data-resource="${esc(item.resourceId)}" data-approval="${esc(item.id)}">Approve</button>
          <button class="ghost hostedapproval" data-kind="${esc(item.kind)}" data-resource-type="${esc(item.resourceType||'')}" data-decision="REJECT" data-domain="${esc(item.domainId)}" data-project="${esc(item.projectId||'')}" data-resource="${esc(item.resourceId)}" data-approval="${esc(item.id)}">Reject</button>
        </div>`
      :''
    const ownRequest=approvalActions&&!canDecide
      ?`<p class="d" style="margin-top:8px;color:var(--muted)">${esc(hostedApprovalReadOnlyReason(item))}</p>`
      :''
    return `<article class="item" style="margin-bottom:8px">
      <h4>${esc(row.title)} ${hostedStatus(row.status)}</h4>
      <div class="meta">${row.meta.filter(Boolean).map(value=>`<span class="chip">${esc(value)}</span>`).join('')}</div>
      <p class="d" style="margin-top:8px">${esc(row.detail)}</p>
      ${resource==='approvals'?`<details class="approval-details"><summary>Request details</summary><dl>
        <dt>Initiator / applicant</dt><dd>${esc(item.requesterSubject||'Not provided')}</dd>
        ${item.ownerSubject?`<dt>Resource owner</dt><dd>${esc(item.ownerSubject)}</dd><dt>Record version</dt><dd>${esc(item.recordVersion)}</dd><dt>Initiation reason</dt><dd>${esc(item.initiationReason)}</dd>`:''}
        <dt>Resource</dt><dd>${esc(item.resourceId||'Not provided')}</dd>
        <dt>Domain</dt><dd>${esc(item.domainId||'Not provided')}</dd>
        <dt>Project</dt><dd>${esc(item.projectId||'Not provided')}</dd>
        <dt>Requested</dt><dd>${esc(item.requestedAt||'Not provided')}</dd>
        <dt>Type</dt><dd>${esc(item.kind)} / ${esc(item.resourceType)}</dd>
        <dt>Required reviewer role</dt><dd>${esc(item.kind==='RESOURCE_PUBLICATION'||item.kind==='PRODUCTION_DEPLOYMENT'?(item.domainId==='platform'||item.domainId==='shared'?'Platform administrator':'Domain lead'):item.kind==='RESOURCE_ACCESS'?'Domain lead':'Not provided')}</dd>
        <dt>Status</dt><dd>${esc(item.status)}</dd>
        ${['APPROVED','REJECTED','CANCELLED'].includes(item.status)?`<dt>Reviewed by</dt><dd>${esc(item.approverSubject||'Not provided')}</dd>`:item.approverSubject?`<dt>Reviewed by</dt><dd>${esc(item.approverSubject)}</dd>`:''}
        ${item.decidedAt?`<dt>Reviewed</dt><dd>${esc(item.decidedAt)}</dd>`:''}
      </dl></details>`:''}
      ${ownRequest}
      ${compact&&canDecide?'<details class="approval-review"><summary>Review request</summary>':''}
      ${canDecide?`<label>Review reason <input class="approval-reason" data-reason-for="${esc(item.id)}" data-reason-domain="${esc(item.domainId)}" maxlength="1024" placeholder="Reason for your decision"></label>`:''}
      ${visibilityChoice}
      ${actions}
      ${compact&&canDecide?'</details>':''}
      ${resource==='projects'?`<details><summary>Project resource access</summary>${item.resourcePolicy===null||item.resourcePolicy===undefined?'<p>Inherits the current domain catalog.</p>':`<ul>${item.resourcePolicy.resources.map(ref=>`<li>${esc(ref.type)} · ${esc(ref.id)}</li>`).join('')||'<li>No resources selected.</li>'}</ul>`}</details>`:''}
      ${resource==='projects'&&item.status==='ACTIVE'?`<button class="ghost" data-project-open="${esc(item.id)}" data-domain="${esc(item.domainId)}">Open workspace</button><button class="ghost" data-project-budget-open data-domain="${esc(item.domainId)}" data-project="${esc(item.id)}">Cost &amp; Budget</button>`:''}
    </article>`
  }).join('')
}
async function hostedCollectionRequest(resource){
  const result=await readHostedCollection(resource)
  if(result?.ok!==true||result.resource!==resource||!Array.isArray(result.items)){
    throw new Error(apiErrorMessage(result,`${HOSTED_COLLECTION_META[resource].title} could not be loaded.`))
  }
  return result.items
}
function hostedProjectCreateAllowed(){
  return hostedActionEnabled('createProject',hostedCaps())
    ||(SESSION?.role==='builder'&&!!activeDomain())
}
function vHostedCollection(resource){
  const meta=HOSTED_COLLECTION_META[resource]
  return `<h2>${esc(meta.title)}</h2>
  <p class="subtitle">${esc(meta.description)}</p>
  ${resource==='projects'&&hostedProjectCreateAllowed()?'<button class="primary" id="dcprojgo">Create project</button>':''}
  ${resource==='projects'?'<div id="dcwizard"></div><div id="hostedbudgetdetail"></div><div class="project-list-toolbar"><label for="project-status-filter">Status <select id="project-status-filter"><option value="ACTIVE">Active projects</option><option value="ARCHIVED">Archived projects</option><option value="ALL">All projects</option></select></label><span id="project-list-count" role="status"></span></div>':''}
  <div class="card" id="hostedcollection" data-resource="${resource}">
    <div class="empty"><span class="spin">⟳</span> loading ${esc(meta.title.toLowerCase())}…</div>
  </div>`
}
async function loadHostedCollection(resource){
  const box=document.getElementById('hostedcollection');if(!box)return
  const epoch=sessionEpoch
  const current=()=>sessionEpochIsCurrent(epoch)&&document.getElementById('hostedcollection')===box
  try{
    const items=resource==='projects'?await readWorkspaceProjects():await hostedCollectionRequest(resource)
    if(!current())return
    const statusFilter=resource==='projects'?document.getElementById('project-status-filter'):null
    if(statusFilter)statusFilter.onchange=sessionTaskHandler(()=>loadHostedCollection(resource))
    const visibleItems=resource==='projects'?items.filter(item=>statusFilter?.value==='ALL'||item.status===(statusFilter?.value||'ACTIVE')):items
    const count=resource==='projects'?document.getElementById('project-list-count'):null
    if(count)count.textContent=`${visibleItems.length} shown · ${items.filter(item=>item.status==='ACTIVE').length} active · ${items.filter(item=>item.status==='ARCHIVED').length} archived`
    box.innerHTML=hostedCollectionItems(resource,visibleItems,{
      approvalActions:resource==='approvals',
    })
    if(resource==='approvals')wireHostedApprovalActions(box,undefined,items)
    if(resource==='projects'){
      wireHostedProjectCreate()
      box.querySelectorAll('[data-project-open]').forEach(button=>button.onclick=()=>{
        const project=items.find(p=>p.id===button.dataset.projectOpen&&p.domainId===button.dataset.domain)
        if(project)selectWorkspaceProject({...project,domain:project.domainId},{view:['domainconsole','myprojects'].includes(S.view)?'workspace':S.view,tab:S.view==='domainconsole'?'fleet':S.wsTab})
      })
      box.querySelectorAll('[data-project-budget-open]').forEach(button=>button.onclick=sessionTaskHandler(()=>
        loadHostedProjectBudget(document.getElementById('hostedbudgetdetail'),{
          domainId:button.dataset.domain,projectId:button.dataset.project,
        })))
    }
  }catch(error){
    if(error===CANCELED_REQUEST||!current())return
    box.innerHTML=`<div class="empty" role="status">${esc(error.message||'Project list is unavailable.')} <button class="ghost" data-project-retry>Retry</button></div>`
    box.querySelector('[data-project-retry]').onclick=sessionTaskHandler(()=>loadHostedCollection(resource))
  }
}
function wireHostedProjectCreate(){
  const go=document.getElementById('dcprojgo')
  if(!go||!hostedProjectCreateAllowed())return
  go.onclick=sessionTaskHandler(async()=>{
    if(!confirmContextChange())return
    await wizOpen()
    renderWizard(document.getElementById('dcwizard'))
  })
}
async function loadHostedProjectSetup(box){
  if(!box)return
  box.innerHTML=`${S.view==='domainconsole'?'':'<button class="ghost" data-project-setup-back>Back to workspace</button>'}${vHostedCollection('projects')}`
  const back=box.querySelector('[data-project-setup-back]')
  if(back)back.onclick=()=>{if(confirmContextChange()){businessForms.clear('wizard');wizardDirty.clear('wizard');S.wiz=null;render()}}
  await loadHostedCollection('projects')
  if(S.wiz?.hosted)renderWizard(document.getElementById('dcwizard'))
}
function hostedApprovalRecordAllowed(record){
  const actor=SESSION?.actor||SESSION?.user
  if(typeof actor!=='string'||!actor
    ||record?.status!=='PENDING'
    ||typeof record.requesterSubject!=='string'||!record.requesterSubject
    ||record.requesterSubject===actor||record.ownerSubject===actor
    ||typeof record.resourceId!=='string'||!record.resourceId
    ||!hostedApprovalRequest({
      kind:record.kind,resourceType:record.resourceType,approval:record.id,
      domain:record.domainId,project:record.projectId,resource:record.resourceId,
    },'APPROVE','Review'))return false
  if(record.resourceType==='MODEL'){
    return record.kind==='RESOURCE_ACCESS'
      &&record.projectId===null
      &&/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/.test(record.resourceId)
      &&SESSION?.role==='lead'
      &&!!activeDomain()&&record.domainId===activeDomain()
      &&hostedActionEnabled('decideModelAccess',hostedCaps())
  }
  return hostedApprovalActionEnabled(record.kind,hostedCaps(),{
    recordDomainId:record.domainId,activeDomainId:activeDomain(),
  })
}
// AP-02: a single, non-actionable explanation for a read-only approval row.
// Ordering: terminal decision → missing/invalid record → self-review →
// unsupported type → role/domain mismatch → dynamic eligibility unknown.
// Admin visibility ≠ canDecide: never imply a control this actor lacks.
function hostedApprovalReadOnlyReason(record){
  const actor=SESSION?.actor||SESSION?.user
  if(['APPROVED','REJECTED','CANCELLED'].includes(record?.status))return 'This request has already been decided.'
  if(!record||record.status!=='PENDING'
    ||typeof record.requesterSubject!=='string'||!record.requesterSubject
    ||typeof record.resourceId!=='string'||!record.resourceId)return 'This record is incomplete and cannot be reviewed here.'
  if(record.requesterSubject===actor||record.ownerSubject===actor)return 'A different eligible reviewer must decide this request.'
  if(!hostedApprovalRequest({
    kind:record.kind,resourceType:record.resourceType,approval:record.id,
    domain:record.domainId,project:record.projectId,resource:record.resourceId,
  },'APPROVE','Review'))return `This request type (${record.kind} / ${record.resourceType||'—'}) is not decided from this console.`
  if(record.resourceType==='MODEL'
    &&(SESSION?.role!=='lead'||!activeDomain()||record.domainId!==activeDomain()
      ||!hostedActionEnabled('decideModelAccess',hostedCaps())))return 'Review is handled by the requesting domain’s lead.'
  if(record.resourceType!=='MODEL'&&!hostedApprovalActionEnabled(record.kind,hostedCaps(),{
    recordDomainId:record.domainId,activeDomainId:activeDomain(),
  }))return record.domainId==='platform'||record.domainId==='shared'
    ?'Review is handled by a platform administrator.'
    :'Review is handled by the requesting domain’s lead.'
  return 'Eligibility to decide this request is not currently confirmed.'
}
function sameHostedApprovalRecord(expected,record){
  return !!record&&Object.keys(expected).every(key=>expected[key]===record[key])
}
async function revalidateHostedApproval(expected,current,detailed=false){
  if(!current())return detailed?{state:'unavailable'}:null
  const result=await readHostedCollection('approvals')
  if(!current()||result?.ok!==true||result.resource!=='approvals'||!Array.isArray(result.items))return detailed?{state:'unavailable'}:null
  const matches=result.items.filter(row=>row?.id===expected.id&&row.domainId===expected.domainId)
  const record=matches.length===1?matches[0]:null
  if(detailed&&['APPROVED','REJECTED','CANCELLED'].includes(record?.status))return {state:'terminal'}
  if(!sameHostedApprovalRecord(expected,record)||!hostedApprovalRecordAllowed(record))return detailed?{state:'ineligible'}:null
  if(record.resourceType==='MODEL'){
    const catalog=await api('/ai-gateway')
    if(!current()||!validHostedGatewayCatalog(catalog)||catalog.domainId!==record.domainId)return detailed?{state:'unavailable'}:null
    // Lead's catalog redacts raw policies. Exact id + current requestable access
    // is the policy-backed projection; never use a label or a selected fallback.
    const model=catalog.models.find(model=>model.id===record.resourceId)
    const access=model?.access
    if(access?.requestable!==true||access.usable!==false||access.status!=='PENDING'
      ||!access.limits||access.rateLimit?.status!=='ACTIVE'
      ||access.latestRequest?.id!==record.id
      ||access.latestRequest.status!=='PENDING'
      ||access.latestRequest.requestedAt!==record.requestedAt)return detailed?{state:'ineligible'}:null
  }
  return current()&&hostedApprovalRecordAllowed(record)
    ?(detailed?{state:'ready',record}:record):(detailed?{state:'ineligible'}:null)
}
function wireHostedApprovalActions(box,reload=()=>loadHostedCollection('approvals'),records=[]){
  const epoch=sessionEpoch
  const actor=SESSION?.actor||SESSION?.user,role=SESSION?.role,domain=activeDomain()
  // Restore per-row reason drafts after every rerender and keep saving edits.
  // Row failure paths rerender via reload; drafts survive because they live in
  // the actor+domain+approvalId store, not in the replaced DOM. typeof-guarded
  // so extracted-function test harnesses without the module scope stay valid.
  const reasonDrafts=typeof approvalReasonDrafts==='object'?approvalReasonDrafts:null
  if(reasonDrafts&&typeof wireApprovalReasonInputs==='function')wireApprovalReasonInputs(reasonDrafts,box,{actor,domain})
  // Visibility select: "Selected domains…" reveals the domain list input.
  box.querySelectorAll('.approval-visibility').forEach(select=>{
    select.onchange=()=>{
      const domains=box.querySelector(`[data-visibility-domains-for="${select.dataset.visibilityFor}"]`)
      if(domains)domains.style.display=select.value==='restricted'?'':'none'
    }
  })
  const scopeCurrent=()=>sessionEpochIsCurrent(epoch)&&box.isConnected
    &&actor===(SESSION?.actor||SESSION?.user)&&role===SESSION?.role&&domain===activeDomain()
  box.querySelectorAll('.hostedapproval').forEach(button=>{
    const matches=records.filter(row=>row.id===button.dataset.approval&&row.domainId===button.dataset.domain)
    const expected=matches.length===1?{...matches[0]}:null
    const decision=button.dataset.decision
    const current=()=>scopeCurrent()&&button.isConnected&&box.contains(button)&&!button.approvalReadOnly
      &&expected&&hostedApprovalRecordAllowed(expected)
      &&button.dataset.approval===expected.id&&button.dataset.kind===expected.kind
      &&button.dataset.resourceType===expected.resourceType&&button.dataset.domain===expected.domainId
      &&button.dataset.resource===expected.resourceId&&button.dataset.project===(expected.projectId||'')
      &&button.dataset.decision===decision
    const key=JSON.stringify([actor,role,domain,expected?.domainId,expected?.id])
    const showUnknown=()=>{
      if(!scopeCurrent()||!box.contains(button))return
      const row=button.closest('article')
      if(!row||!box.contains(row))return
      let notice=row.querySelector('[data-approval-read-status]')
      if(!notice){notice=document.createElement('div');notice.dataset.approvalReadStatus='';row.append(notice)}
      notice.innerHTML='<p role="status">We could not confirm this request’s status. Decisions are read-only. <button class="ghost" data-approval-retry>Retry read</button></p>'
      const retry=notice.querySelector('[data-approval-retry]')
      retry.onclick=sessionTaskHandler(async()=>{
        if(!scopeCurrent()||!box.contains(retry)||retry.disabled)return
        retry.disabled=true
        try{await reload()}catch(error){if(error!==CANCELED_REQUEST&&scopeCurrent())alert('Approval state is still unknown. Retry read.')}
        finally{if(scopeCurrent()&&box.contains(retry))retry.disabled=false}
      })
    }
    const retire=async(readFailed=false)=>{
      // Invalidate both handlers before any asynchronous reload, including saved
      // handler references. A reload failure must never resurrect old actions.
      for(const action of box.querySelectorAll('.hostedapproval')){
        if(action.dataset.approval===expected.id&&action.dataset.domain===expected.domainId){
          action.approvalReadOnly=true;action.disabled=true;action.onclick=null
        }
      }
      if(!readFailed&&scopeCurrent()){
        try{await reload()}catch(error){if(error===CANCELED_REQUEST)return}
      }
      showUnknown()
    }
    const reasonRow=()=>typeof button.closest==='function'?button.closest('article'):null
    const showReasonRequired=()=>{
      if(!scopeCurrent()||!box.contains(button))return
      const row=reasonRow()
      if(!row||!box.contains(row))return
      let notice=row.querySelector('[data-approval-reason-status]')
      if(!notice){notice=document.createElement('div');notice.dataset.approvalReasonStatus='';row.append(notice)}
      notice.innerHTML='<p role="status">Enter a review reason (at least 3 characters) to record this decision.</p>'
    }
    button.onclick=sessionTaskHandler(async()=>{
    if(button.disabled||!current())return
    // A decision requires the reviewer's own reason. A missing reason input,
    // blank or too-short text never defaults to a canned approval reason and
    // never opens a fallback prompt: the row shows an inline notice and no
    // revalidation or API call happens until a valid reason is entered.
    const reasonInput=box.querySelector?.(`[data-reason-for="${CSS.escape(expected.id)}"][data-reason-domain="${CSS.escape(expected.domainId)}"]`)
    const reason=typeof reasonInput?.value==='string'?reasonInput.value.trim():''
    if(reason.length<3){showReasonRequired();return}
    const staleReasonNotice=reasonRow()?.querySelector?.('[data-approval-reason-status]')
    if(staleReasonNotice)staleReasonNotice.innerHTML=''
    button.disabled=true
    let pending,validated=false
    try{
      const validation=await revalidateHostedApproval(expected,current,true)
      if(!current())return
      if(validation.state!=='ready'){
        if(validation.state==='terminal')pendingHostedApprovalDecisions.delete(key)
        await retire(validation.state==='unavailable');return
      }
      validated=true
      const record=validation.record
      const request=hostedApprovalRequest({
        kind:record.kind,resourceType:record.resourceType,approval:record.id,
        domain:record.domainId,project:record.projectId,resource:record.resourceId,
      },decision,reason)
      if(!request)return
      const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify([request.path,request.body,record.resourceId,record.recordVersion??null,record.requesterSubject,record.requestedAt])))
      if(!current())return
      const fingerprint=Array.from(new Uint8Array(digest),byte=>byte.toString(16).padStart(2,'0')).join('')
      const previous=pendingHostedApprovalDecisions.get(key)
      if(previous&&(previous.fingerprint!==fingerprint||previous.inFlight)){
        alert('A decision is unresolved. Retry the same decision and exact reason after the current request completes.');return
      }
      pending=previous||{fingerprint,requestId:createRequestId(),inFlight:false}
      pending.inFlight=true
      pendingHostedApprovalDecisions.set(key,pending)
      const result=await api(request.path,request.body,{requestId:pending.requestId})
      if(!current())return
      if(result?.ok===true){
        pendingHostedApprovalDecisions.delete(key)
        reasonDrafts?.discard({actor,domain:expected.domainId,approvalId:expected.id})
        // The visibility decision rides the same approve action. Best-effort:
        // a failure leaves the honest default (publisher-domain only) and
        // reports it, never blocks the completed approval.
        if(decision==='APPROVE'&&record.kind==='RESOURCE_PUBLICATION'){
          const select=box.querySelector(`[data-visibility-for="${record.id}"]`)
          const mode=select?.value||''
          if(mode==='open'||mode==='restricted'){
            const domainsInput=box.querySelector(`[data-visibility-domains-for="${record.id}"]`)
            const allowedDomainIds=mode==='restricted'
              ?String(domainsInput?.value||'').split(',').map(value=>value.trim()).filter(Boolean)
              :[]
            const [registryId,recordId]=String(record.resourceId||'').split('/')
            const visibility=await api('/governance/catalog-visibility',{
              registryId,recordId,mode,allowedDomainIds,
              reason:reason||'Visibility set with the publication approval.',
            },{requestId:createRequestId()})
            if(!current())return
            if(visibility?.ok!==true)alert(apiErrorMessage(visibility,'Approved, but the visibility decision was not saved. Set it again from the queue.'))
          }
        }
        await retire();return
      }
      alert(apiErrorMessage(result,'The approval decision could not be completed.'))
    }catch(error){
      if(error===CANCELED_REQUEST||!current())return
      if(!validated){await retire(true);return}
      alert(apiErrorMessage(error,'The approval decision could not be completed.'))
    }finally{
      if(pending)pending.inFlight=false
      if(current())button.disabled=false
    }
    })
  })
}
function validHostedGatewayCatalog(value){
  const record=item=>!!(item&&typeof item==='object'&&!Array.isArray(item))
  const text=item=>typeof item==='string'&&item.length>0
  const cleanText=item=>text(item)&&item.trim()===item
  const gatewayId=item=>typeof item==='string'
    &&/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(item)
  const domainId=item=>typeof item==='string'
    &&/^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/.test(item)
  const modelId=item=>typeof item==='string'
    &&/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/.test(item)
  const subject=item=>typeof item==='string'
    &&/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/.test(item)
  const timestamp=item=>{
    if(typeof item!=='string')return false
    const parsed=Date.parse(item)
    return Number.isFinite(parsed)&&new Date(parsed).toISOString()===item
  }
  const orderedTimestamps=(left,right)=>
    timestamp(left)&&timestamp(right)&&Date.parse(left)<=Date.parse(right)
  const exact=(item,keys)=>record(item)
    &&Object.keys(item).length===keys.length
    &&Object.keys(item).every(key=>keys.includes(key))
  const awsRegion=item=>typeof item==='string'
    &&/^[a-z]{2}(?:-gov)?-[a-z0-9-]+-\d+$/.test(item)
  const gatewayUrl=item=>{
    if(typeof item!=='string'||item.length>2048)return false
    try{
      const parsed=new URL(item)
      return parsed.protocol==='https:'
        &&!parsed.username
        &&!parsed.password
        &&!parsed.search
        &&!parsed.hash
        &&parsed.pathname==='/inference/v1'
    }catch{return false}
  }
  const pricing=item=>item===null||(
    exact(item,['inputPer1k','outputPer1k'])
    &&['inputPer1k','outputPer1k'].every(key=>
      typeof item[key]==='number'
      &&Number.isFinite(item[key])
      &&item[key]>=0)
  )
  const limits=item=>exact(item,[
    'requestsPerMinute','tokensPerMinute','connectionsPerSecond',
  ])
    &&['requestsPerMinute','tokensPerMinute','connectionsPerSecond'].every(key=>
      item[key]===null||(Number.isSafeInteger(item[key])&&item[key]>0))
    &&['requestsPerMinute','tokensPerMinute','connectionsPerSecond'].some(key=>
      item[key]!==null)
  const rateLimit=item=>item===null||(
    exact(item,['id','status','reason','reconciledAt'])
    &&(item.id===null||text(item.id))
    &&['ACTIVE','RECONCILIATION_FAILED'].includes(item.status)
    &&(item.reason===null||typeof item.reason==='string')
    &&timestamp(item.reconciledAt)
  )
  const request=(item,{domain,model})=>{
    if(item===null)return true
    if(!exact(item,[
      'domainId','id','kind','resourceType','resourceId','projectId','status',
      'requesterSubject','approverSubject','reason','requestedAt','decidedAt',
    ]))return false
    const pending=item.status==='PENDING'
    const cancelled=item.status==='CANCELLED'
    const decided=item.status==='APPROVED'||item.status==='REJECTED'
    return item.domainId===domain
      &&/^[a-z][a-z0-9-]{0,63}$/.test(item.id)
      &&item.kind==='RESOURCE_ACCESS'
      &&item.resourceType==='MODEL'
      &&item.resourceId===model
      &&item.projectId===null
      &&subject(item.requesterSubject)
      &&timestamp(item.requestedAt)
      &&(pending
        ? item.approverSubject===null
          &&item.reason===null
          &&item.decidedAt===null
        : cancelled
          ? item.approverSubject===null
            &&cleanText(item.reason)
            &&orderedTimestamps(item.requestedAt,item.decidedAt)
          : decided
            &&subject(item.approverSubject)
            &&item.approverSubject!==item.requesterSubject
            &&cleanText(item.reason)
            &&orderedTimestamps(item.requestedAt,item.decidedAt))
  }
  const grant=(item,{domain,model})=>{
    if(item===null)return true
    if(!exact(item,[
      'domainId','resourceType','resourceId','status','grantedBySubject',
      'grantedAt','revokedBySubject','revokedAt',
    ]))return false
    return item.domainId===domain
      &&item.resourceType==='MODEL'
      &&item.resourceId===model
      &&item.status==='ACTIVE'
      &&subject(item.grantedBySubject)
      &&timestamp(item.grantedAt)
      &&item.revokedBySubject===null
      &&item.revokedAt===null
  }
  const sameLimits=(left,right)=>left===null||right===null
    ? left===right
    : ['requestsPerMinute','tokensPerMinute','connectionsPerSecond']
      .every(key=>left[key]===right[key])
  const sameRateLimit=(left,right)=>left===null||right===null
    ? left===right
    : ['id','status','reason','reconciledAt']
      .every(key=>left[key]===right[key])
  const access=(item,{domain,model,policy})=>{
    if(!exact(item,[
      'status','usable','requestable','latestRequest','grant','limits','rateLimit',
    ])
      ||!request(item.latestRequest,{domain,model})
      ||!grant(item.grant,{domain,model})
      ||!(item.limits===null||limits(item.limits))
      ||!rateLimit(item.rateLimit)
    )return false
    const policyActive=policy?.applicationStatus==='ACTIVE'
    const directlyAllowed=domain==='platform'
      ||Boolean(policyActive&&policy.allowedDomains.includes(domain))
    const requestable=Boolean(
      policyActive&&policy.requestableDomains.includes(domain),
    )
    const usable=directlyAllowed||item.grant!==null
    const status=directlyAllowed
      ?'ALLOWED'
      :item.grant!==null
        ?'GRANTED'
        :item.latestRequest?.status==='PENDING'
          ?'PENDING'
          :requestable
            ?item.latestRequest?.status==='REJECTED'
              ?'REJECTED'
              :'REQUESTABLE'
            :'DENIED'
    return item.status===status
      &&item.usable===usable
      &&item.requestable===requestable
      &&sameLimits(item.limits,policy?.limits??null)
      &&sameRateLimit(item.rateLimit,policy?.rateLimit??null)
  }
  const publicRateLimit=item=>item===null||(
    exact(item,['status','reason','reconciledAt'])
    &&['ACTIVE','RECONCILIATION_FAILED'].includes(item.status)
    &&timestamp(item.reconciledAt)
    &&(item.status==='ACTIVE'
      ?item.reason===null
      :cleanText(item.reason))
  )
  const publicRequest=item=>item===null||(
    exact(item,['id','status','requestedAt'])
    &&/^[a-z][a-z0-9-]{0,63}$/.test(item.id)
    &&['PENDING','APPROVED','REJECTED','CANCELLED'].includes(item.status)
    &&timestamp(item.requestedAt)
  )
  const publicGrant=item=>item===null||(
    exact(item,['status','grantedAt'])
    &&item.status==='ACTIVE'
    &&timestamp(item.grantedAt)
  )
  const publicAccess=item=>{
    if(!exact(item,[
      'status','usable','requestable','latestRequest','grant','limits','rateLimit',
    ])
      ||!['ALLOWED','GRANTED','PENDING','REJECTED','REQUESTABLE']
        .includes(item.status)
      ||!publicRequest(item.latestRequest)
      ||!publicGrant(item.grant)
      ||!(item.limits===null||limits(item.limits))
      ||!publicRateLimit(item.rateLimit)
    )return false
    if(item.usable!==(item.status==='ALLOWED'||item.status==='GRANTED')){
      return false
    }
    if(item.status==='PENDING'){
      return item.requestable===true
        &&item.latestRequest?.status==='PENDING'
        &&item.grant===null
    }
    if(item.status==='REJECTED'){
      return item.requestable===true
        &&item.latestRequest?.status==='REJECTED'
        &&item.grant===null
    }
    if(item.status==='REQUESTABLE'){
      return item.requestable===true
        &&item.grant===null
        &&!['PENDING','REJECTED'].includes(item.latestRequest?.status)
    }
    return item.status!=='GRANTED'||item.grant!==null
  }
  const policy=(item,model)=>item===null||(exact(item,[
    'modelId','allowedDomains','requestableDomains','limits',
    'applicationStatus','rateLimit','updatedBySubject','updatedAt','revision',
  ])
    &&item.modelId===model
    &&Array.isArray(item.allowedDomains)
    &&item.allowedDomains.every(domainId)
    &&new Set(item.allowedDomains).size===item.allowedDomains.length
    &&Array.isArray(item.requestableDomains)
    &&item.requestableDomains.every(domainId)
    &&new Set(item.requestableDomains).size===item.requestableDomains.length
    &&!item.allowedDomains.some(domain=>item.requestableDomains.includes(domain))
    &&limits(item.limits)
    &&['PENDING','ACTIVE','RECONCILIATION_FAILED']
      .includes(item.applicationStatus)
    &&(item.applicationStatus==='PENDING'
      ?item.rateLimit===null
      :rateLimit(item.rateLimit)
        &&item.rateLimit.status===item.applicationStatus
        &&(item.applicationStatus==='ACTIVE'
          ?item.rateLimit.id!==null&&item.rateLimit.reason===null
          :item.rateLimit.id===null&&cleanText(item.rateLimit.reason)))
    &&subject(item.updatedBySubject)
    &&timestamp(item.updatedAt)
    &&Number.isSafeInteger(item.revision)
    &&item.revision>=1)
  const gatewayVersion=(item,model,llmGateway)=>{
    if(!exact(item,[
      'semver','status','content','changelog','createdBy','createdAt',
      'decidedBy','decidedAt','autoChecks',
    ]))return false
    const content=item.content
    return item.semver===model.defaultVersion
      &&['APPROVED','IN_REVIEW'].includes(item.status)
      &&exact(content,[
        'gateway','gatewayId','gatewayUrl','gatewayModelId','region',
        'runtimeModelId','source','ownedBy','object','pricing',
      ])
      &&content.gateway===llmGateway.name
      &&content.gatewayId===llmGateway.gatewayId
      &&content.gatewayUrl===llmGateway.gatewayUrl
      &&content.gatewayModelId===model.id
      &&content.region===llmGateway.region
      &&text(content.runtimeModelId)
      &&content.source==='agentcore-gateway'
      &&text(content.ownedBy)
      &&text(content.object)
      &&pricing(content.pricing)
      &&typeof item.changelog==='string'
      &&item.createdBy==='gateway'
      &&timestamp(item.createdAt)
      &&(item.status==='APPROVED'
        ? item.decidedBy==='gateway'
          &&orderedTimestamps(item.createdAt,item.decidedAt)
        : item.decidedBy===null&&item.decidedAt===null)
      &&Array.isArray(item.autoChecks)
      &&item.autoChecks.length===0
  }
  const base=record(value)
    &&value.ok===true
    &&value.source==='aws'
    &&Array.isArray(value.models)
  if(!base)return false
  if(Object.hasOwn(value,'domainId')){
    return exact(value,['ok','source','domainId','models'])
      &&domainId(value.domainId)
      &&value.models.every(model=>exact(model,[
        'id','name','description','provider','access',
      ])
      &&modelId(model.id)
      &&text(model.name)
      &&typeof model.description==='string'
      &&text(model.provider)
      &&publicAccess(model.access))
      &&new Set(value.models.map(model=>model.id)).size===value.models.length
  }
  if(
    !exact(value,['ok','source','llmGateway','models'])
    ||!exact(value.llmGateway,[
      'gatewayId','name','region','gatewayUrl','modelCount',
    ])
    ||!gatewayId(value.llmGateway.gatewayId)
    ||!cleanText(value.llmGateway.name)
    ||!text(value.llmGateway.region)
    ||!awsRegion(value.llmGateway.region)
    ||!gatewayUrl(value.llmGateway.gatewayUrl)
    ||!Number.isSafeInteger(value.llmGateway.modelCount)
    ||value.llmGateway.modelCount!==value.models.length
  )return false
  return new Set(value.models.map(model=>model.id)).size===value.models.length
    &&value.models.every(model=>exact(model,[
    'id','type','name','description','governanceMode','domainOwner','domain',
    'defaultVersion','versions','_source','_gateway','_catalogMatch',
    'policy','accessByDomain',
  ])
    &&modelId(model.id)
    &&text(model.name)
    &&typeof model.description==='string'
    &&model.type==='Model'
    &&model.governanceMode==='federated'
    &&model.domainOwner===null
    &&model.domain==='shared'
    &&text(model.defaultVersion)
    &&Array.isArray(model.versions)
    &&model.versions.length===1
    &&gatewayVersion(model.versions[0],model,value.llmGateway)
    &&model._source==='gateway'
    &&model._gateway===value.llmGateway.name
    &&typeof model._catalogMatch==='boolean'
    &&policy(model.policy,model.id)
    &&record(model.accessByDomain)
    &&Object.entries(model.accessByDomain).every(([domain,projection])=>
      domainId(domain)
      &&access(projection,{
        domain,
        model:model.id,
        policy:model.policy,
      })))
}
function hostedGatewayProvider(model){
  return model?.provider
    ||model?.vendor
    ||model?.versions?.[0]?.content?.ownedBy
    ||'Bedrock'
}
function hostedGatewayAccess(model){
  if(model?.access&&typeof model.access==='object')return model.access
  const domainId=activeDomain()
  if(domainId&&model?.accessByDomain&&typeof model.accessByDomain==='object'){
    return model.accessByDomain[domainId]||null
  }
  return null
}
function hostedGatewaySelectedModel(){
  const models=S.hostedGatewayCatalog?.models||[]
  return models.find(model=>model.id===S.hostedGatewaySelectedModelId)||models[0]||null
}
function hostedGatewayLimits(limits,{editable=false}={}){
  const values=limits||{}
  const fields=[
    ['requestsPerMinute','Requests / minute','gatewayRequestsPerMinute'],
    ['tokensPerMinute','Tokens / minute','gatewayTokensPerMinute'],
    ['connectionsPerSecond','Connections / second','gatewayConnectionsPerSecond'],
  ]
  if(editable){
    const defaults={requestsPerMinute:60,tokensPerMinute:120000,connectionsPerSecond:4}
    return `<div class="gateway-limit-grid">${fields.map(([key,label,field])=>`<label>${esc(label)}<input id="hg${key}" data-demo-assist-field="${field}" type="number" min="1" step="1" value="${esc(String(values[key]||defaults[key]))}"/></label>`).join('')}</div>`
  }
  return fields.some(([key])=>Number.isFinite(values[key]))
    ?`<div class="gateway-limit-grid">${fields.map(([key,label])=>`<div><b>${Number.isFinite(values[key])?esc(values[key].toLocaleString()):'Not configured'}</b><div class="d">${esc(label)}</div></div>`).join('')}</div>`
    :'<div class="d">No model-specific limits are configured.</div>'
}
function hostedGatewayRateLimit(policy,access){
  const rateLimit=policy?.rateLimit||access?.rateLimit||null
  const applicationStatus=policy?.applicationStatus||rateLimit?.status||'NOT_CONFIGURED'
  return `<div class="sec-h">Native reconciliation</div>
    <div class="meta">${hostedStatus(applicationStatus)}${rateLimit?.status?hostedStatus(rateLimit.status):''}</div>
    <p class="d" style="margin-top:8px">${rateLimit?.reconciledAt?`Last reconciled ${esc(hostedSessionTime(rateLimit.reconciledAt))}.`:'No native Gateway reconciliation has been recorded.'}${rateLimit?.reason?` ${esc(rateLimit.reason)}`:''}</p>`
}
function hostedGatewayPolicyEditor(model){
  if(!hostedActionEnabled('updateModelPolicy',hostedCaps()))return ''
  const policy=model.policy||{}
  const allowed=new Set(Array.isArray(policy.allowedDomains)?policy.allowedDomains:[])
  const requestable=new Set(Array.isArray(policy.requestableDomains)?policy.requestableDomains:[])
  const domains=Object.keys(model.accessByDomain||{}).sort()
  return `<div class="sec-h">Domain access policy</div>
    ${domains.length?domains.map(domainId=>{
      const value=allowed.has(domainId)?'allowed':requestable.has(domainId)?'requestable':'denied'
      return `<label class="gateway-domain-row"><span><b>${esc(domainId)}</b></span><select data-model-domain="${esc(domainId)}" aria-label="Access for ${esc(domainId)}">
        <option value="denied" ${value==='denied'?'selected':''}>Denied</option>
        <option value="requestable" ${value==='requestable'?'selected':''}>Requestable</option>
        <option value="allowed" ${value==='allowed'?'selected':''}>Allowed</option>
      </select></label>`
    }).join(''):'<div class="d">No active domains are available for policy assignment.</div>'}
    <div class="sec-h">Rate limits</div>
    ${hostedGatewayLimits(policy.limits,{editable:true})}
    <button class="primary" id="hostedgatewaypolicy" data-model="${esc(model.id)}" style="margin-top:12px">Apply policy</button>`
}
function hostedGatewayAccessActions(model,access){
  if(!access)return ''
  const canRequest=hostedActionEnabled('requestModelAccess',hostedCaps())
    && access.requestable===true
    && access.usable!==true
    && access.latestRequest?.status!=='PENDING'
  const canDecide=hostedActionEnabled('decideModelAccess',hostedCaps())
    &&SESSION?.role==='lead'
    &&S.hostedGatewayCatalog?.domainId===activeDomain()
    &&access.requestable===true&&access.usable===false
    && access.latestRequest?.status==='PENDING'
  return `${canRequest?`<button class="primary" id="hostedgatewayrequest" data-model="${esc(model.id)}" style="margin-top:12px">Request model access</button>`:''}
    ${canDecide?`<div class="sec-h">Domain approval</div>
      <label style="margin-top:0">Decision reason</label><input id="hostedgatewayreason" data-demo-assist-field="gatewayDecisionReason" maxlength="1024" placeholder="Reason for the domain decision"/>
      <div class="bar" style="margin-top:10px">
        <button class="primary hostedgatewaydecision" data-model="${esc(model.id)}" data-approval="${esc(access.latestRequest.id)}" data-decision="APPROVE">Approve</button>
        <button class="ghost hostedgatewaydecision" data-model="${esc(model.id)}" data-approval="${esc(access.latestRequest.id)}" data-decision="REJECT">Reject</button>
      </div>`:''}`
}
function hostedGatewayDomainCoverage(model){
  const rows=Object.entries(model.accessByDomain||{}).sort(([left],[right])=>left.localeCompare(right))
  if(!rows.length)return '<div class="d">No active domains are available.</div>'
  return rows.map(([domainId,access])=>`<div class="gateway-domain-row">
    <span><b>${esc(domainId)}</b></span>
    <span>${hostedStatus(access.status)}${access.limits?` <span class="chip">${esc(Number(access.limits.requestsPerMinute||0).toLocaleString())} req/min</span>`:''}</span>
  </div>`).join('')
}
function hostedGatewayDetail(model){
  if(!model)return ''
  const canManagePolicy=hostedActionEnabled('updateModelPolicy',hostedCaps())
  const access=hostedGatewayAccess(model)
  const policy=canManagePolicy?model.policy||null:null
  return `<aside class="gateway-detail" id="hostedgatewaydetail" role="dialog" aria-label="Model details">
    <div class="bar" style="margin:0 0 8px;justify-content:space-between">
      <div><h2 style="font-size:1.05rem">${esc(model.name||model.id)}</h2><div class="d">${esc(hostedGatewayProvider(model))}</div></div>
      <button class="ghost" id="hostedgatewayclose" aria-label="Close model details" title="Close" style="padding:3px 10px">×</button>
    </div>
    <p class="d">${esc(model.description||'No description provided.')}</p>
    <div class="meta"><span class="chip"><code>${esc(model.id)}</code></span>${access?hostedStatus(access.status):policy?hostedStatus(policy.applicationStatus):hostedStatus('UNCONFIGURED')}</div>
    ${canManagePolicy?`<div class="sec-h">Policy coverage</div>${hostedGatewayDomainCoverage(model)}`:''}
    ${access?`<div class="sec-h">Selected-domain access</div>
      <div class="meta">${hostedStatus(access.status)}${access.usable?'<span class="badge badge-green">USABLE</span>':''}${access.requestable?'<span class="chip">Requestable</span>':''}</div>
      ${access.latestRequest?`<p class="d" style="margin-top:8px">Latest request: ${esc(access.latestRequest.status||'UNKNOWN')}${access.latestRequest.requestedAt?` · ${esc(hostedSessionTime(access.latestRequest.requestedAt))}`:''}</p>`:''}
      ${access.grant?`<p class="d" style="margin-top:8px">Grant: ${esc(access.grant.status||'UNKNOWN')}${access.grant.grantedAt?` · ${esc(hostedSessionTime(access.grant.grantedAt))}`:''}</p>`:''}
      <div class="sec-h">Effective limits</div>${hostedGatewayLimits(access.limits)}
      ${hostedGatewayAccessActions(model,access)}`:''}
    ${hostedGatewayRateLimit(policy,access)}
    ${hostedGatewayPolicyEditor(model)}
  </aside>`
}
function renderHostedGateway(){
  const box=document.getElementById('hostedgateway');if(!box)return
  const catalog=S.hostedGatewayCatalog
  const models=Array.isArray(catalog?.models)?catalog.models:[]
  if(!models.length){
    box.innerHTML='<div class="empty">No inference targets are available in this scope.</div>'
    return
  }
  const canManagePolicy=hostedActionEnabled('updateModelPolicy',hostedCaps())
  const selected=hostedGatewaySelectedModel()
  const configured=models.filter(model=>model.policy).length
  const active=models.filter(model=>model.policy?.applicationStatus==='ACTIVE').length
  const issues=models.filter(model=>model.policy&&model.policy.applicationStatus!=='ACTIVE').length
  box.innerHTML=`${S.hostedGatewayMessage?`<div class="status ${S.hostedGatewayMessage.ok?'ok':'err'}">${esc(S.hostedGatewayMessage.text)}</div>`:''}
    ${canManagePolicy?`<div class="gateway-summary">
      <div><b>${models.length}</b><span class="d">registered models</span></div>
      <div><b>${configured}</b><span class="d">policies configured</span></div>
      <div><b>${active}</b><span class="d">policies active</span></div>
      <div><b>${issues}</b><span class="d">reconciliation issues</span></div>
    </div>
    <div class="status info">LLM Gateway: ${esc(catalog.llmGateway?.name||catalog.llmGateway?.gatewayId||'Connected')}</div>`:''}
    <div class="gateway-layout">
      <section aria-label="Available models">
        <div class="sec-h" style="margin-top:0">${canManagePolicy?'All inference targets':'Selected-domain model catalog'}</div>
        ${models.map(model=>{
          const access=hostedGatewayAccess(model)
          const status=access?.status||model.policy?.applicationStatus||'UNCONFIGURED'
          return `<article class="item gateway-model" tabindex="0" data-gateway-model="${esc(model.id)}" data-model-access="${esc(status)}" aria-current="${model.id===selected?.id?'true':'false'}">
            <h4>${esc(model.name||model.id)}</h4>
            <div class="meta"><span class="chip">${esc(hostedGatewayProvider(model))}</span>${hostedStatus(status)}${access?.usable?'<span class="badge badge-green">USABLE</span>':''}</div>
            <p class="d" style="margin-top:8px">${esc(model.description||model.id)}</p>
          </article>`
        }).join('')}
      </section>
      ${hostedGatewayDetail(selected)}
    </div>`
  wireHostedGateway()
  applyDemoAssistToHostedView()
}
async function loadHostedGateway(){
  const box=document.getElementById('hostedgateway');if(!box)return
  const context=hostedModelReadContext(),view=S.view,generation=++hostedGatewayLoadGeneration
  const panel=document.getElementById('registrygatewaypanel')
  const requested=panel?.dataset.model
  const current=()=>context===hostedModelReadContext()&&view===S.view
    &&generation===hostedGatewayLoadGeneration&&box.isConnected
    &&document.getElementById('hostedgateway')===box
    &&document.getElementById('registrygatewaypanel')===panel&&panel?.dataset.model===requested
  S.hostedGatewayCatalog=null
  box.innerHTML='<div class="empty" role="status">Checking current-domain model access…</div>'
  try{
    const result=await api('/ai-gateway')
    if(!current())return
    if(result?.code==='FORBIDDEN'){
      S.hostedGatewayCatalog=null
      box.innerHTML='<div class="empty" role="status">AI Gateway access is not available for this role.</div>'
      return
    }
    if(!validHostedGatewayCatalog(result)
      ||(SESSION?.role!=='admin'&&result.domainId!==activeDomain())){
      hostedRetryState(box,'AI Gateway',loadHostedGateway)
      return
    }
    if(requested&&!result.models.some(model=>model.id===requested)){
      S.hostedGatewayCatalog=null
      box.innerHTML='<p role="status">This model is not present in the current authorized Gateway catalog. Ask the platform owner to reconcile its model identity; no other model has been selected.</p>'
      return
    }
    S.hostedGatewayCatalog=result
    if(requested){
      S.hostedGatewaySelectedModelId=requested
    }else if(!result.models.some(model=>model.id===S.hostedGatewaySelectedModelId)){
      S.hostedGatewaySelectedModelId=result.models[0]?.id||''
    }
    renderHostedGateway()
  }catch(error){
    if(error===CANCELED_REQUEST||!current())return
    hostedRetryState(box,'AI Gateway',loadHostedGateway)
  }
}
function wireHostedGateway(){
  const box=document.getElementById('hostedgateway');if(!box)return
  box.querySelectorAll('[data-gateway-model]').forEach(item=>{
    const select=()=>{
      if(!confirmContextChange())return
      businessForms.clear('gateway')
      S.hostedGatewaySelectedModelId=item.dataset.gatewayModel
      renderHostedGateway()
    }
    item.onclick=select
    item.onkeydown=event=>{
      if(event.key==='Enter'||event.key===' '){event.preventDefault();select()}
    }
  })
  const close=document.getElementById('hostedgatewayclose')
  if(close)close.onclick=()=>{
    if(!confirmContextChange())return
    businessForms.clear('gateway')
    S.hostedGatewaySelectedModelId=''
    const detail=document.getElementById('hostedgatewaydetail')
    if(detail)detail.remove()
  }
  const policyButton=document.getElementById('hostedgatewaypolicy')
  if(policyButton)policyButton.onclick=sessionTaskHandler(async()=>{
    if(!hostedActionEnabled('updateModelPolicy',hostedCaps()))return
    const modelId=policyButton.dataset.model
    const allowedDomains=[]
    const requestableDomains=[]
    box.querySelectorAll('[data-model-domain]').forEach(control=>{
      if(control.value==='allowed')allowedDomains.push(control.dataset.modelDomain)
      if(control.value==='requestable')requestableDomains.push(control.dataset.modelDomain)
    })
    const limits={
      requestsPerMinute:Number(document.getElementById('hgrequestsPerMinute')?.value),
      tokensPerMinute:Number(document.getElementById('hgtokensPerMinute')?.value),
      connectionsPerSecond:Number(document.getElementById('hgconnectionsPerSecond')?.value),
    }
    if(Object.values(limits).some(value=>!Number.isSafeInteger(value)||value<1)){
      S.hostedGatewayMessage={ok:false,text:'Enter positive whole-number limits before applying the policy.'}
      renderHostedGateway()
      return
    }
    policyButton.disabled=true
    let result
    try{
      result=await api('/ai-gateway/model-policies',{
        modelId,
        allowedDomains,
        requestableDomains,
        limits,
      },{requestId:createRequestId()})
    }catch(error){
      if(error===CANCELED_REQUEST)return
      S.hostedGatewayMessage={ok:false,text:apiErrorMessage(error,'The model policy could not be applied.')}
      renderHostedGateway()
      return
    }
    S.hostedGatewayMessage=result?.ok===true
      ?{ok:true,text:'Model access policy and native rate limits were applied.'}
      :{ok:false,text:apiErrorMessage(result,'The model policy could not be applied.')}
    if(result?.ok===true){businessForms.clear('gateway');await loadHostedGateway()}
    else renderHostedGateway()
  })
  const requestButton=document.getElementById('hostedgatewayrequest')
  if(requestButton)requestButton.onclick=sessionTaskHandler(async()=>{
    if(!hostedActionEnabled('requestModelAccess',hostedCaps()))return
    const approvalId=hostedMutationSlug('model-access')
    const modelId=requestButton.dataset.model
    requestButton.disabled=true
    let result
    try{
      result=await api('/ai-gateway/model-access-requests',{
        approvalId,
        modelId,
      },{requestId:createRequestId()})
    }catch(error){
      if(error===CANCELED_REQUEST)return
      S.hostedGatewayMessage={ok:false,text:apiErrorMessage(error,'Model access could not be requested.')}
      renderHostedGateway()
      return
    }
    S.hostedGatewayMessage=result?.ok===true
      ?{ok:true,text:'Model access was submitted for domain approval.'}
      :{ok:false,text:apiErrorMessage(result,'Model access could not be requested.')}
    if(result?.ok===true){businessForms.clear('gateway');await loadHostedGateway()}
    else renderHostedGateway()
  })
  const epoch=sessionEpoch,actor=SESSION?.actor||SESSION?.user,domain=activeDomain()
  const catalog=S.hostedGatewayCatalog,modelId=S.hostedGatewaySelectedModelId
  const model=catalog?.models?.find(model=>model.id===modelId)
  box.querySelectorAll('.hostedgatewaydecision').forEach(button=>{
    const latest=model?.access?.latestRequest
    const expected=latest?{
      id:latest.id,status:latest.status,requestedAt:latest.requestedAt,
      kind:'RESOURCE_ACCESS',resourceType:'MODEL',resourceId:modelId,projectId:null,domainId:domain,
    }:null
    const decision=button.dataset.decision
    const current=()=>sessionEpochIsCurrent(epoch)&&document.getElementById('hostedgateway')===box
      &&box.isConnected&&button.isConnected&&box.contains(button)
      &&!!actor&&actor===(SESSION?.actor||SESSION?.user)&&SESSION?.role==='lead'
      &&!!domain&&domain===activeDomain()&&catalog===S.hostedGatewayCatalog
      &&catalog?.domainId===domain&&modelId===S.hostedGatewaySelectedModelId
      &&expected?.status==='PENDING'&&button.dataset.model===modelId
      &&button.dataset.approval===expected.id&&button.dataset.decision===decision
      &&hostedActionEnabled('decideModelAccess',hostedCaps())
    button.onclick=sessionTaskHandler(async()=>{
    if(button.disabled||!current())return
    const reason=document.getElementById('hostedgatewayreason')?.value.trim()||''
    if(!reason){
      S.hostedGatewayMessage={ok:false,text:'Enter a decision reason before approving or rejecting access.'}
      renderHostedGateway()
      return
    }
    button.disabled=true
    let result
    try{
      const record=await revalidateHostedApproval(expected,current)
      if(!current())return
      if(!record){alert('This approval is stale, read-only, or no longer authorized. Refresh the model.');return}
      const request=hostedApprovalRequest({
        kind:record.kind,resourceType:record.resourceType,approval:record.id,
      },decision,reason)
      if(!request)return
      result=await api(request.path,request.body,{requestId:createRequestId()})
    }catch(error){
      if(error===CANCELED_REQUEST||!current())return
      alert(apiErrorMessage(error,'The model access decision could not be completed.'))
      return
    }finally{
      if(current())button.disabled=false
    }
    if(!current())return
    if(result?.ok!==true){alert(apiErrorMessage(result,'The model access decision could not be completed.'));return}
    S.hostedGatewayMessage={ok:true,text:decision==='APPROVE'?'Model access was approved.':'Model access was rejected.'}
    businessForms.clear('gateway')
    await loadHostedGateway()
    })
  })
}
function hostedWindowControl(id,value){
  return `<label class="tb-demo-field" style="max-width:150px"><span>Window</span><select id="${id}" aria-label="Reporting window">
    ${['1h','24h','7d','30d'].map(window=>`<option value="${window}" ${value===window?'selected':''}>${window}</option>`).join('')}
  </select></label>`
}
function hostedScopeText(item){
  if(item.scopeType==='platform')return 'Entire platform'
  if(item.scopeType==='domain')return item.domainId
  return [item.domainId,item.projectId].filter(Boolean).join(' / ')
}
function vHostedOperations(){
  const window=S.hostedOperationsWindow||'24h'
  // Alert definitions and response ownership (RACI) live with Monitoring —
  // they are operational configuration, not approvals. Moved here from the
  // retired Governance "Alerts & RACI" tab; same loader and renderer.
  const alertSections=SESSION?.role==='admin'&&hasCap('manageAlertPolicies')
    ?govAlertsTab()
    :''
  return `<div class="bar" style="align-items:end"><div><h1>Platform Monitoring</h1><p class="subtitle">Aggregate runtime health, request volume, errors and latency. Content-level traces stay in their project workspace.</p></div>${hostedWindowControl('hostedopswindow',window)}</div>
  ${scopeNote()}
  <div id="hostedoperations"><div class="empty"><span class="spin">⟳</span> loading operational telemetry…</div></div>
  ${alertSections}`
}
async function loadHostedOperations(){
  const box=document.getElementById('hostedoperations');if(!box)return
  const epoch=sessionEpoch
  const request=(box.operationsRequest||0)+1;box.operationsRequest=request
  const current=()=>sessionEpochIsCurrent(epoch)&&box.isConnected&&box.operationsRequest===request
  const window=S.hostedOperationsWindow||'24h'
  const select=document.getElementById('hostedopswindow')
  if(select)select.onchange=()=>{
    S.hostedOperationsWindow=select.value
    box.innerHTML='<div class="empty"><span class="spin">⟳</span> loading operational telemetry…</div>'
    runSessionTask(loadHostedOperations)
  }
  try{
    if(SESSION?.role==='admin'){
      // Admin platform view: platform aggregate (headline KPIs) + groupBy=project
      // breakdown (domain/project table, structure visible even with zero traffic).
      // Per-agent traces are deliberately excluded — they belong to the project
      // observability workspace.
      const[result,breakdown]=await Promise.all([
        loadOperationsPages(api,window),
        loadOperationsPages(api,window,{groupBy:'project'}).catch(()=>null),
      ])
      if(!current())return
      box.innerHTML=platformMonitoringHtml(result,breakdown)
    }else{
      const result=await loadOperationsPages(api,window)
      if(!current())return
      // Non-admin (lead / builder in cognito mode): keep scoped aggregate view.
      const domainId=activeDomain()
      box.innerHTML=operationsHtml(result,domainId?{domainId}:{})
        +'<section class="card"><h2>Domain &amp; project health</h2><p>Separate domain/project health totals are unavailable when the service supplies only an aggregate. No trace payloads are loaded here.</p><div data-monitoring-projects>Loading authorized project inventory…</div></section>'
      const inventory=await readHostedCollection('projects')
      if(!current())return
      const links=box.querySelector('[data-monitoring-projects]')
      if(links){
        if(inventory?.ok!==true){links.textContent='Project inventory is unavailable.';return}
        const projects=inventory.items.filter(p=>p.domainId===domainId)
        const domains=[...new Set(projects.map(p=>p.domainId))]
        links.innerHTML=`<p>${domains.length} domains · ${projects.length} projects in the authorized inventory.</p>
          <table><thead><tr><th>Domain</th><th>Projects</th><th>Active projects</th><th>Runtime health</th></tr></thead><tbody>
          ${domains.map(id=>`<tr><td>${esc(id)}</td><td>${projects.filter(p=>p.domainId===id).length}</td><td>${projects.filter(p=>p.domainId===id&&p.status==='ACTIVE').length}</td><td>Unavailable per domain/project</td></tr>`).join('')}</tbody></table>
          ${projects.filter(p=>p.domainId===domainId).map(p=>`<button class="ghost" data-monitoring-project="${esc(p.id)}" data-domain="${esc(p.domainId)}">${esc(p.domainId)} / ${esc(p.name)} · Observability</button>`).join('')}`
        links.querySelectorAll('[data-monitoring-project]').forEach(button=>button.onclick=()=>{
          const project=projects.find(p=>p.id===button.dataset.monitoringProject&&p.domainId===button.dataset.domain&&p.domainId===domainId)
          if(!project)return
          selectWorkspaceProject({...project,domain:project.domainId},{view:'observability',tab:'obs'})
        })
      }
    }
  }catch(error){
    if(error===CANCELED_REQUEST||!current())return
    hostedRetryState(box,'Operations',loadHostedOperations)
  }
}
async function loadScopedHostedCost(box,scope={}){
  if(!box)return
  const epoch=sessionEpoch
  const request=(box.costRequest||0)+1;box.costRequest=request
  const current=()=>sessionEpochIsCurrent(epoch)&&box.isConnected&&box.costRequest===request
  const window=scope.projectId?(S.workspaceCostWindow||'24h'):(S.hostedCostWindow||'24h')
  try{
    const result=await api('/costs?window='+encodeURIComponent(window)+'&limit=50&groupBy=project')
    if(!current())return
    if(result?.ok!==true)throw new Error('Cost data is unavailable.')
    const scoped=scopedCostPage(result,scope)
    box.innerHTML=scope.projectId?projectCostHtml(scoped):hostedCostHtml(scoped)
    wireHostedCostBudgets(box)
  }catch(error){
    if(error===CANCELED_REQUEST||!current())return
    box.innerHTML='<div class="empty">Cost data is unavailable for this scope and window.</div>'
  }
}
function wireHostedCostBudgets(box){
  box.querySelectorAll('[data-project-budget-open]').forEach(button=>button.onclick=sessionTaskHandler(()=>
    loadHostedProjectBudget(box.querySelector('[data-cost-detail]'),{
      domainId:button.dataset.domain,projectId:button.dataset.project,
    })))
}
async function loadHostedProjectBudget(box,scope,{postCreate=false}={}){
  if(!box)return
  const epoch=sessionEpoch
  // When called from the workspace tab (projectName present) the workspace
  // chrome already provides an h1 with project name and domain chip — suppress
  // the redundant h2 heading. Other call sites (post-create wizard, domain
  // drill-down) still need the h2 for standalone context. Either way the
  // scope note keeps this page clearly project-only, never platform-level.
  const headingHtml = scope.projectName
    ? ''
    : `<h2>Project cost &middot; ${esc(scope.domainId)} / ${esc(scope.projectId)}</h2>`
  box.innerHTML=`${headingHtml}
    <p class="d" style="color:var(--dim);font-size:.8rem;margin:0 0 10px">Model and agent cost for this project only. Platform-level costs and the AWS account bill are not shown here.</p>
    ${postCreate?'<p>Step 2: review and set the project budget.</p><button data-budget-continue class="ghost">Continue to Build (budget may be pending)</button>':''}
    ${hostedWindowControl('projectcostwindow',S.workspaceCostWindow||'24h')}
    <div data-budget-cost></div><div data-budget-editor></div><section class="card"><div class="sec-h">Project agents</div><div data-budget-agents>Loading agents…</div></section>`
  const editor=box.querySelector('[data-budget-editor]')
  const costs=box.querySelector('[data-budget-cost]')
  const agents=box.querySelector('[data-budget-agents]')
  const windowControl=box.querySelector('#projectcostwindow')
  if(windowControl)windowControl.onchange=()=>{
    S.workspaceCostWindow=windowControl.value
    costs.innerHTML='<div class="empty">Loading project cost…</div>'
    runSessionTask(()=>loadScopedHostedCost(costs,scope))
  }
  const current=()=>sessionEpochIsCurrent(epoch)&&box.isConnected&&box.querySelector('[data-budget-editor]')===editor
  const next=box.querySelector('[data-budget-continue]')
  if(next)next.onclick=()=>{
    S.hostedBuildReturnFromProjects=false
    S.hostedBuildLoaded=false
    S.view='compose'
    render()
  }
  await Promise.all([
    mountProjectBudget(editor,{scope,postCreate,request:rawApi,requestId:createRequestId,isCurrent:current,
      registerDirtyGuard:guard=>{projectBudgetDirty=guard},
      onSaved:()=>runSessionTask(()=>loadScopedHostedCost(costs,scope)),
    }),
    loadScopedHostedCost(costs,scope),
    (async()=>{
      try{
        const result=await readHostedCollection('agents')
        if(!current())return
        if(result?.ok!==true)throw new Error('Agent list unavailable')
        const rows=result.items.filter(agent=>agent.domainId===scope.domainId&&agent.projectId===scope.projectId)
        agents.innerHTML=rows.length?`<p>Per-agent run, usage and cost contributions are unavailable from the project cost contract.</p><table><thead><tr><th>Agent</th><th>Status</th><th>Runs</th><th>Usage</th><th>Cost contribution</th></tr></thead><tbody>${rows.map(agent=>`<tr><td>${esc(agent.name||agent.id)}</td><td>${esc(agent.status)}</td><td>Unavailable</td><td>Unavailable</td><td>Unavailable</td></tr>`).join('')}</tbody></table>`:'No agents in this project.'
      }catch(error){
        if(error===CANCELED_REQUEST||!current())return
        agents.textContent='Project agent list is unavailable.'
      }
    })(),
  ])
}
function vHostedCost(){
  const window=S.hostedCostWindow||'24h'
  const admin=SHELL()==='admin'
  return `<div class="bar" style="align-items:end"><div><h1>Platform Cost</h1><p class="subtitle">${admin?'Consolidated platform report: the real AWS account bill next to journal-attributed domain, project and agent model estimates.':'Disjoint domain and project model estimates. Shared costs and full platform spend remain unavailable where not measured.'}</p></div>${admin?'<button type="button" class="ghost" id="hostedcostcsv" disabled>Export CSV report</button>':''}${hostedWindowControl('hostedcostwindow',window)}</div>
  ${scopeNote()}
  ${admin?'<div id="platformbilling"><div class="empty"><span class="spin">⟳</span> loading AWS bill…</div></div>':''}
  <div id="hostedcost"><div class="empty"><span class="spin">⟳</span> loading cost data…</div></div>`
}
// The AWS bill and the attributed estimates load independently: Cost Explorer
// being slow or denied must never block the journal table, and vice versa.
async function loadPlatformBilling(){
  const box=document.getElementById('platformbilling');if(!box)return
  const epoch=sessionEpoch
  const current=()=>sessionEpochIsCurrent(epoch)&&box.isConnected
  try{
    const result=await api('/platform-costs')
    if(!current())return
    S.platformBilling=validatePlatformBilling(result)
    box.innerHTML=platformBillingHtml(S.platformBilling)
    wirePlatformCostCsv()
  }catch(error){
    if(error===CANCELED_REQUEST||!current())return
    S.platformBilling=null
    hostedRetryState(box,'AWS bill',loadPlatformBilling)
  }
}
function wirePlatformCostCsv(){
  const button=document.getElementById('hostedcostcsv')
  if(!button||!S.platformBilling)return
  button.disabled=false
  button.onclick=()=>{
    const csv=platformCostReportCsv(S.platformBilling,S.hostedCostPage||null)
    const link=document.createElement('a')
    link.href=URL.createObjectURL(new Blob([csv],{type:'text/csv'}))
    link.download='platform-cost-report.csv'
    link.click()
    URL.revokeObjectURL(link.href)
  }
}
async function loadHostedCost(){
  const box=document.getElementById('hostedcost');if(!box)return
  const epoch=sessionEpoch
  const request=(box.costRequest||0)+1;box.costRequest=request
  const current=()=>sessionEpochIsCurrent(epoch)&&box.isConnected&&box.costRequest===request
  const window=S.hostedCostWindow||'24h'
  if(SHELL()==='admin')runSessionTask(loadPlatformBilling)
  try{
    const result=await api('/costs?window='+encodeURIComponent(window)+'&limit=50&groupBy=project')
    if(!current())return
    if(result?.ok!==true||result.resource!=='costs'||!Array.isArray(result.items)){
      throw new Error('Cost data could not be loaded.')
    }
    S.hostedCostPage=result
    // Admins get the domain/project rollup as the primary view; the detailed
    // provenance table stays available underneath for auditing.
    if(SHELL()==='admin'&&result.cursor===null){
      box.innerHTML=platformCostRollupHtml(platformCostRollup(result))
        +`<details class="cv-method"><summary>Detailed provenance table (per-row coverage &amp; pricing metadata)</summary>${hostedCostHtml(result)}</details>`
    }else{
      box.innerHTML=hostedCostHtml(result)
    }
    wireHostedCostBudgets(box)
    wirePlatformCostCsv()
  }catch(error){
    if(error===CANCELED_REQUEST||!current())return
    hostedRetryState(box,'Cost',loadHostedCost)
  }
  const select=document.getElementById('hostedcostwindow')
  if(select)select.onchange=()=>{
    S.hostedCostWindow=select.value
    box.innerHTML='<div class="empty"><span class="spin">⟳</span> loading cost data…</div>'
    runSessionTask(loadHostedCost)
  }
}
function vHostedAudit(){
  return `<h1>Audit</h1>
  <p class="subtitle">Immutable operational and governance metadata for the authorized platform or domain scope.</p>
  ${scopeNote()}
  <div id="hostedaudit"><div class="empty"><span class="spin">⟳</span> loading audit records…</div></div>`
}
async function loadHostedAudit(){
  const box=document.getElementById('hostedaudit');if(!box)return
  try{
    const result=await api('/operations/audit?limit=50')
    if(result?.ok!==true||!Array.isArray(result.items)){
      throw new Error('Audit records could not be loaded.')
    }
    box.innerHTML=result.items.length?`<div>${result.items.map(item=>`<article class="item" style="margin-bottom:8px">
      <h4>${ic2(ICONS.audit)}${esc(item.action||'Audit event')} ${hostedStatus(item.decision||'RECORDED')}</h4>
      <div class="meta"><span class="chip">${esc(item.effectiveRole||'')}</span>${item.domainId?`<span class="chip">${esc(item.domainId)}</span>`:''}${item.projectId?`<span class="chip">${esc(item.projectId)}</span>`:''}</div>
      <p class="d" style="margin-top:8px"><code>${esc(item.resource||'')}</code></p>
      <p class="d" style="margin-top:5px">${esc(item.reason||'No reason recorded.')} · ${esc(hostedSessionTime(item.timestamp))}</p>
    </article>`).join('')}</div>`:'<div class="empty">No audit records are available in this scope.</div>'
  }catch(error){
    if(error===CANCELED_REQUEST)return
    hostedRetryState(box,'Audit',loadHostedAudit)
  }
}
function hostedIncidentProjects(){
  return Array.isArray(S.hostedIncidentProjects)?S.hostedIncidentProjects:[]
}
function vHostedIncidents(){
  return `<h1>Incidents</h1>
  <p class="subtitle">Operational incidents scoped to the platform, selected domain, or owned projects.</p>
  ${scopeNote()}
  <div id="hostedincidents"><div class="empty"><span class="spin">⟳</span> loading incidents…</div></div>`
}
function renderHostedIncidents(){
  const box=document.getElementById('hostedincidents');if(!box)return
  const items=S.hostedIncidents||[]
  const projects=hostedIncidentProjects()
  const canCreate=hostedActionEnabled('createIncident',hostedCaps())
  const canAct=hostedActionEnabled('actOnIncident',hostedCaps())
  box.innerHTML=`${S.hostedIncidentMessage?`<div class="status ${S.hostedIncidentMessage.ok?'ok':'err'}">${esc(S.hostedIncidentMessage.text)}</div>`:''}
  ${canCreate?`<section class="card"><div class="sec-h" style="margin-top:0">Create incident</div>
    ${projects.length?`<div class="grid2">
      <div><label style="margin-top:0">Project</label><select id="hiproject">${projects.map(project=>`<option value="${esc(project.domainId+'/'+project.id)}">${esc(project.name||project.id)} · ${esc(project.domainId)}</option>`).join('')}</select></div>
      <div><label style="margin-top:0">Severity</label><select id="hiseverity" data-demo-assist-field="severity">${['CRITICAL','HIGH','MEDIUM','LOW'].map(value=>`<option>${value}</option>`).join('')}</select></div>
    </div>
    <label>Title</label><input id="hititle" data-demo-assist-field="incidentTitle" maxlength="160"/>
    <label>Description</label><textarea id="hidescription" data-demo-assist-field="incidentDescription" maxlength="4096"></textarea>
    <label>Initial response note</label><input id="hireason" data-demo-assist-field="incidentReason" maxlength="1024"/>
    <button class="primary" id="hicreate">Create incident</button>`:'<div class="empty">No project is available for incident creation.</div>'}
  </section>`:''}
  <section class="card"><div class="sec-h" style="margin-top:0">Incident queue</div>
    ${items.length?items.map(item=>{
      const next=item.status==='OPEN'?'acknowledge':item.status==='ACKNOWLEDGED'?'resolve':item.status==='RESOLVED'?'reopen':null
      return `<article class="item" style="margin-bottom:8px">
        <h4>${ic2(ICONS.bell)}${esc(item.title||item.id)} ${hostedStatus(item.status)}</h4>
        <div class="meta"><span class="chip">${esc(item.severity||'')}</span><span class="chip">${esc(item.domainId||'')}</span><span class="chip">${esc(item.projectId||'')}</span></div>
        <p class="d" style="margin-top:8px">${esc(item.description||'')}</p>
        <p class="d" style="margin-top:5px">${esc(item.lastActionReason||'No action note recorded.')}</p>
        ${canAct&&next?`<button class="ghost hiincidentaction" data-id="${esc(item.id)}" data-action="${next}" style="margin-top:8px">${esc(next[0].toUpperCase()+next.slice(1))}</button>`:''}
      </article>`
    }).join(''):'<div class="empty">No incidents are available in this scope.</div>'}
  </section>`
  wireHostedIncidents()
  applyDemoAssistToHostedView()
}
async function loadHostedIncidents(){
  const box=document.getElementById('hostedincidents');if(!box)return
  try{
    const canCreate=hostedActionEnabled('createIncident',hostedCaps())
    const [result,projects]=await Promise.all([
      api('/incidents?limit=50'),
      canCreate?hostedCollectionRequest('projects'):Promise.resolve([]),
    ])
    if(result?.ok!==true||!Array.isArray(result.items)){
      throw new Error('Incidents could not be loaded.')
    }
    S.hostedIncidents=result.items
    S.hostedIncidentProjects=projects
    renderHostedIncidents()
  }catch(error){
    if(error===CANCELED_REQUEST)return
    hostedRetryState(box,'Incidents',loadHostedIncidents)
  }
}
function wireHostedIncidents(){
  const create=document.getElementById('hicreate')
  if(create)create.onclick=sessionTaskHandler(async()=>{
    if(!hostedActionEnabled('createIncident',hostedCaps()))return
    const [domainId,projectId]=(document.getElementById('hiproject')?.value||'').split('/')
    const title=document.getElementById('hititle')?.value.trim()||''
    const description=document.getElementById('hidescription')?.value.trim()||''
    const reason=document.getElementById('hireason')?.value.trim()||''
    if(!domainId||!projectId||!title||!description||!reason){
      S.hostedIncidentMessage={ok:false,text:'Complete the project, title, description, and response note.'}
      renderHostedIncidents()
      return
    }
    create.disabled=true
    const result=await api('/incidents',{
      domainId,
      projectId,
      id:hostedMutationSlug('incident'),
      title,
      description,
      severity:document.getElementById('hiseverity')?.value||'HIGH',
      reason,
    },{requestId:createRequestId()})
    S.hostedIncidentMessage=result?.ok===true
      ?{ok:true,text:'Incident created.'}
      :{ok:false,text:apiErrorMessage(result,'The incident could not be created.')}
    if(result?.ok===true)businessForms.clear('incident')
    await loadHostedIncidents()
  })
  document.querySelectorAll('.hiincidentaction').forEach(button=>button.onclick=sessionTaskHandler(async()=>{
    if(!hostedActionEnabled('actOnIncident',hostedCaps()))return
    const reason=(await requestDemoChoice(
      'incidentAction',
      `Reason to ${button.dataset.action} this incident?`,
    ))?.trim()||''
    if(!reason)return
    button.disabled=true
    const result=await api('/incidents/'+encodeURIComponent(button.dataset.id)+'/actions',{
      action:button.dataset.action,
      reason,
    },{requestId:createRequestId()})
    S.hostedIncidentMessage=result?.ok===true
      ?{ok:true,text:'Incident state updated.'}
      :{ok:false,text:apiErrorMessage(result,'The incident action could not be completed.')}
    if(result?.ok===true)businessForms.clear('incident')
    await loadHostedIncidents()
  }))
}
function vHostedBreakGlass(){
  return `<h1>Break-glass</h1>
  <p class="subtitle">Time-bound, resource-specific emergency access with peer decision, requester activation, and revocation.</p>
  <div id="hostedbreakglass"><div class="empty"><span class="spin">⟳</span> loading break-glass records…</div></div>`
}
function renderHostedBreakGlass(){
  const box=document.getElementById('hostedbreakglass');if(!box)return
  const items=S.hostedBreakGlass||[]
  const projects=S.hostedBreakGlassProjects||[]
  const canRequest=hostedActionEnabled('requestBreakGlass',hostedCaps())
  const canDecide=hostedActionEnabled('decideBreakGlass',hostedCaps())
  const canActivate=hostedActionEnabled('activateBreakGlass',hostedCaps())
  const canRevoke=hostedActionEnabled('revokeBreakGlass',hostedCaps())
  box.innerHTML=`${S.hostedBreakGlassMessage?`<div class="status ${S.hostedBreakGlassMessage.ok?'ok':'err'}">${esc(S.hostedBreakGlassMessage.text)}</div>`:''}
  ${canRequest?`<section class="card"><div class="sec-h" style="margin-top:0">Request emergency access</div>
    ${projects.length?`<div class="grid2">
      <div><label style="margin-top:0">Project</label><select id="hbgproject">${projects.map(project=>`<option value="${esc(project.domainId+'/'+project.id)}">${esc(project.name||project.id)} · ${esc(project.domainId)}</option>`).join('')}</select></div>
      <div><label style="margin-top:0">Duration</label><select id="hbgduration" data-demo-assist-field="duration">${[15,30,45,60].map(value=>`<option value="${value}">${value} minutes</option>`).join('')}</select></div>
      <div><label>Protected resource</label><input id="hbgresource" data-demo-assist-field="breakGlassResource" maxlength="512" placeholder="trace/domain/project/trace-id"/></div>
      <div><label>Action</label><input id="hbgaction" data-demo-assist-field="breakGlassAction" maxlength="128" placeholder="trace:read-content"/></div>
    </div>
    <label>Reason</label><textarea id="hbgreason" data-demo-assist-field="breakGlassReason" maxlength="1024"></textarea>
    <button class="primary" id="hbgrequest">Request access</button>`:'<div class="empty">No project is available for a break-glass request.</div>'}
  </section>`:''}
  <section class="card"><div class="sec-h" style="margin-top:0">Emergency access lifecycle</div>
    ${items.length?items.map(item=>{
      const effectiveStatus=item.effectiveStatus||item.status
      const isRequester=item.requesterSubject===SESSION?.actor
      return `<article class="item" style="margin-bottom:8px">
      <h4>${ic2(ICONS.shield)}${esc(item.id)} ${hostedStatus(effectiveStatus)}</h4>
      <div class="meta"><span class="chip">${esc(item.domainId||'')}</span>${item.projectId?`<span class="chip">${esc(item.projectId)}</span>`:''}<span class="chip">${esc(item.action||'')}</span></div>
      <p class="d" style="margin-top:8px"><code>${esc(item.resource||'')}</code></p>
      <p class="d" style="margin-top:5px">${esc(item.reason||'No reason recorded.')} · expires ${esc(hostedSessionTime(item.expiresAt))}</p>
      <div class="bar" style="margin-top:8px">
        ${effectiveStatus==='REQUESTED'&&canDecide&&!isRequester?`<button class="ghost hbgdecision" data-id="${esc(item.id)}" data-decision="APPROVE">Approve</button><button class="ghost hbgdecision" data-id="${esc(item.id)}" data-decision="REJECT">Reject</button>`:''}
        ${effectiveStatus==='APPROVED'&&canActivate&&isRequester?`<button class="ghost hbgactivate" data-id="${esc(item.id)}">Activate</button>`:''}
        ${effectiveStatus==='ACTIVE'&&canRevoke?`<button class="ghost hbgrevoke" data-id="${esc(item.id)}">Revoke</button>`:''}
      </div>
    </article>`}).join(''):'<div class="empty">No break-glass records are available.</div>'}
  </section>`
  wireHostedBreakGlass()
  applyDemoAssistToHostedView()
}
async function loadHostedBreakGlass(){
  const box=document.getElementById('hostedbreakglass');if(!box)return
  try{
    const canRequest=hostedActionEnabled('requestBreakGlass',hostedCaps())
    const [result,projects]=await Promise.all([
      api('/break-glass?limit=50'),
      canRequest?hostedCollectionRequest('projects'):Promise.resolve([]),
    ])
    if(result?.ok!==true||!Array.isArray(result.items)){
      throw new Error('Break-glass records could not be loaded.')
    }
    S.hostedBreakGlass=result.items
    S.hostedBreakGlassProjects=projects
    renderHostedBreakGlass()
  }catch(error){
    if(error===CANCELED_REQUEST)return
    hostedRetryState(box,'Break-glass',loadHostedBreakGlass)
  }
}
function wireHostedBreakGlass(){
  const request=document.getElementById('hbgrequest')
  if(request)request.onclick=sessionTaskHandler(async()=>{
    if(!hostedActionEnabled('requestBreakGlass',hostedCaps()))return
    const [domainId,projectId]=(document.getElementById('hbgproject')?.value||'').split('/')
    const resource=document.getElementById('hbgresource')?.value.trim()||''
    const action=document.getElementById('hbgaction')?.value.trim()||''
    const reason=document.getElementById('hbgreason')?.value.trim()||''
    if(!domainId||!projectId||!resource||!action||!reason){
      S.hostedBreakGlassMessage={ok:false,text:'Complete the project, protected resource, action, and reason.'}
      renderHostedBreakGlass()
      return
    }
    request.disabled=true
    const result=await api('/break-glass/requests',{
      id:hostedMutationSlug('break-glass'),
      domainId,
      projectId,
      resource,
      action,
      reason,
      durationMinutes:Number(document.getElementById('hbgduration')?.value||15),
    },{requestId:createRequestId()})
    S.hostedBreakGlassMessage=result?.ok===true
      ?{ok:true,text:'Break-glass access requested. A different administrator must decide it.'}
      :{ok:false,text:apiErrorMessage(result,'Break-glass access could not be requested.')}
    if(result?.ok===true)businessForms.clear('breakglass')
    await loadHostedBreakGlass()
  })
  document.querySelectorAll('.hbgdecision').forEach(button=>button.onclick=sessionTaskHandler(async()=>{
    if(!hostedActionEnabled('decideBreakGlass',hostedCaps()))return
    const reason=(await requestDemoChoice(
      'breakGlassDecision',
      `Reason to ${button.dataset.decision.toLowerCase()} this request?`,
    ))?.trim()||''
    if(!reason)return
    button.disabled=true
    const result=await api('/break-glass/decisions',{
      id:button.dataset.id,
      decision:button.dataset.decision.toLowerCase(),
      reason,
    },{requestId:createRequestId()})
    S.hostedBreakGlassMessage=result?.ok===true
      ?{ok:true,text:'Break-glass decision recorded.'}
      :{ok:false,text:apiErrorMessage(result,'The break-glass decision could not be recorded.')}
    if(result?.ok===true)businessForms.clear('breakglass')
    await loadHostedBreakGlass()
  }))
  document.querySelectorAll('.hbgactivate').forEach(button=>button.onclick=sessionTaskHandler(async()=>{
    if(!hostedActionEnabled('activateBreakGlass',hostedCaps()))return
    const reason=(await requestDemoChoice(
      'breakGlassActivation',
      'Reason to activate this approved access?',
    ))?.trim()||''
    if(!reason)return
    button.disabled=true
    const result=await api('/break-glass/activations',{
      id:button.dataset.id,
      reason,
    },{requestId:createRequestId()})
    S.hostedBreakGlassMessage=result?.ok===true
      ?{ok:true,text:'Break-glass access activated.'}
      :{ok:false,text:apiErrorMessage(result,'Break-glass access could not be activated.')}
    if(result?.ok===true)businessForms.clear('breakglass')
    await loadHostedBreakGlass()
  }))
  document.querySelectorAll('.hbgrevoke').forEach(button=>button.onclick=sessionTaskHandler(async()=>{
    if(!hostedActionEnabled('revokeBreakGlass',hostedCaps()))return
    const reason=(await requestDemoChoice(
      'breakGlassRevocation',
      'Reason to revoke this emergency access?',
    ))?.trim()||''
    if(!reason)return
    button.disabled=true
    const result=await api('/break-glass/revocations',{
      id:button.dataset.id,
      reason,
    },{requestId:createRequestId()})
    S.hostedBreakGlassMessage=result?.ok===true
      ?{ok:true,text:'Break-glass access revoked.'}
      :{ok:false,text:apiErrorMessage(result,'Break-glass access could not be revoked.')}
    if(result?.ok===true)businessForms.clear('breakglass')
    await loadHostedBreakGlass()
  }))
}
function hostedMutationSlug(prefix){
  return `${prefix}-${crypto.randomUUID().replaceAll('-','').slice(0,24)}`
}
function vHostedPublications(){
  return `<h1>Resource Governance</h1>
  <p class="subtitle">Register domain resources, submit publication requests, discover shared resources, and manage domain grants through the hosted governance APIs.</p>
  ${scopeNote()}
  <div id="hostedpublications"><div class="empty"><span class="spin">⟳</span> loading resource governance…</div></div>`
}
function hostedGovernanceDomains(){
  return Array.isArray(S.hostedGovernanceDomains)?S.hostedGovernanceDomains:[]
}
function renderHostedPublications(){
  const box=document.getElementById('hostedpublications');if(!box)return
  const canRegister=hostedActionEnabled('registerResourceDraft',hostedCaps())
  const canSubmit=hostedActionEnabled('submitResourcePublication',hostedCaps())
  const canRequest=hostedActionEnabled('requestSharedResourceAccess',hostedCaps())&&!!activeDomain()
  const canRevoke=hostedActionEnabled('revokeSharedResourceAccess',hostedCaps())&&!!activeDomain()
  const domains=hostedGovernanceDomains()
  const shared=S.hostedSharedResources||[]
  const draft=S.hostedGovernanceDraft
  box.innerHTML=`${S.hostedGovernanceMessage?`<div class="status ${S.hostedGovernanceMessage.ok?'ok':'err'}">${esc(S.hostedGovernanceMessage.text)}</div>`:''}
  ${canRegister?`<section class="card"><div class="sec-h" style="margin-top:0">Register a draft</div>
    <div class="grid2">
      <div><label style="margin-top:0">Domain</label><select id="hgdomain">${domains.map(domain=>`<option value="${esc(domain.id)}" ${domain.id===activeDomain()?'selected':''}>${esc(domain.name||domain.id)}</option>`).join('')}</select></div>
      <div><label style="margin-top:0">Resource type</label><select id="hgtype">${['TOOL','MCP_SERVER','SKILL','BLUEPRINT','AGENT'].map(type=>`<option>${type}</option>`).join('')}</select></div>
      <div><label>Resource ID</label><input id="hgid" data-demo-assist-field="resourceId" maxlength="128" placeholder="approved-resource-id"/></div>
      <div><label>Display name</label><input id="hgname" data-demo-assist-field="governanceName" maxlength="128" placeholder="Approved Resource"/></div>
      <div><label>Version</label><input id="hgversion" data-demo-assist-field="governanceVersion" value="1.0.0"/></div>
      <div><label><input id="hgshared" type="checkbox"/> Discoverable by other domains</label></div>
    </div>
    <label>Description</label><input id="hgdescription" data-demo-assist-field="governanceDescription" maxlength="2048" placeholder="What this resource provides"/>
    <label>Specification (JSON)</label><textarea id="hgspecification" data-demo-assist-field="governanceSpecification" style="min-height:90px">{}</textarea>
    <div class="bar"><button class="primary" id="hgregister">Register draft</button>${draft&&canSubmit?'<button class="ghost" id="hgpublish">Submit publication</button>':''}</div>
    ${draft?`<div class="status info">Draft ${esc(draft.displayName||draft.resourceId)} · ${esc(draft.status)} · <code>${esc(draft.registryId+'/'+draft.recordId)}</code></div>`:''}
  </section>`:''}
  <section class="card"><div class="sec-h" style="margin-top:0">Shared resources</div>
    ${shared.length?`<div class="grid2">${shared.map(resource=>`<article class="item">
      <h4>${esc(resource.displayName||resource.resourceId)} ${hostedStatus(resource.status)}</h4>
      <div class="meta"><span class="chip">${esc(resource.resourceType)}</span><span class="chip">${esc(resource.domainId)}</span><span class="chip">v${esc(resource.version)}</span>${resource.granted===true?'<span class="chip" style="color:var(--ok);border-color:var(--ok-bd)">access granted</span>':'<span class="chip">access required</span>'}</div>
      <p class="d" style="margin-top:8px">${esc(resource.description||'')}</p>
      <div class="bar" style="margin-top:10px">
        ${resource.granted!==true&&canRequest?`<button class="ghost hgaccessrequest" data-domain="${esc(resource.domainId)}" data-registry="${esc(resource.registryId)}" data-record="${esc(resource.recordId)}">Request access</button>`:''}
        ${resource.granted===true&&canRevoke?`<button class="ghost hgaccessrevoke" data-type="${esc(resource.resourceType)}" data-reference="${esc(resource.registryId+'/'+resource.recordId)}">Revoke access</button>`:''}
      </div>
    </article>`).join('')}</div>`:'<div class="empty">No shared resources are discoverable from other domains.</div>'}
  </section>`
  wireHostedPublications()
  applyDemoAssistToHostedView()
}
async function loadHostedPublications(){
  const box=document.getElementById('hostedpublications');if(!box)return
  try{
    const [shared,domains]=await Promise.all([
      hostedActionEnabled('discoverSharedResources',hostedCaps())
        ? api('/governance/shared-resources?limit=50')
        : Promise.resolve({ok:true,items:[]}),
      api('/domains'),
    ])
    if(shared?.ok!==true||!Array.isArray(shared.items)||!Array.isArray(domains?.domains)){
      throw new Error('Resource governance could not be loaded.')
    }
    S.hostedSharedResources=shared.items
    S.hostedGovernanceDomains=domains.domains
    renderHostedPublications()
  }catch(error){
    if(error===CANCELED_REQUEST)return
    hostedRetryState(box,'Resource governance',loadHostedPublications)
  }
}
function wireHostedPublications(){
  const register=document.getElementById('hgregister')
  if(register)register.onclick=sessionTaskHandler(async()=>{
    if(!hostedActionEnabled('registerResourceDraft',hostedCaps()))return
    const value=id=>document.getElementById(id)?.value||''
    let specification
    try{specification=JSON.parse(value('hgspecification'))}catch{
      S.hostedGovernanceMessage={ok:false,text:'Specification must be valid JSON.'}
      renderHostedPublications()
      return
    }
    register.disabled=true
    const result=await api('/governance/resources',{
      domainId:value('hgdomain'),
      resourceType:value('hgtype'),
      resourceId:value('hgid').trim(),
      displayName:value('hgname').trim(),
      description:value('hgdescription').trim(),
      version:value('hgversion').trim(),
      shared:document.getElementById('hgshared')?.checked===true,
      specification,
    },{requestId:createRequestId()})
    if(result?.ok===true){
      businessForms.clear('publication')
      S.hostedGovernanceDraft=result
      S.hostedGovernanceMessage={ok:true,text:'Draft registered in the domain Agent Registry.'}
    }else{
      S.hostedGovernanceMessage={ok:false,text:apiErrorMessage(result,'The draft could not be registered.')}
    }
    renderHostedPublications()
  })
  const publish=document.getElementById('hgpublish')
  if(publish)publish.onclick=sessionTaskHandler(async()=>{
    if(!hostedActionEnabled('submitResourcePublication',hostedCaps())||!S.hostedGovernanceDraft)return
    publish.disabled=true
    const result=await api('/governance/publications',{
      approvalId:hostedMutationSlug('publication'),
      registryId:S.hostedGovernanceDraft.registryId,
      recordId:S.hostedGovernanceDraft.recordId,
    },{requestId:createRequestId()})
    S.hostedGovernanceMessage=result?.ok===true
      ?{ok:true,text:'Publication submitted for domain approval.'}
      :{ok:false,text:apiErrorMessage(result,'Publication could not be submitted.')}
    renderHostedPublications()
  })
  document.querySelectorAll('.hgaccessrequest').forEach(button=>button.onclick=sessionTaskHandler(async()=>{
    if(!hostedActionEnabled('requestSharedResourceAccess',hostedCaps()))return
    button.disabled=true
    const result=await api('/governance/access-requests',{
      approvalId:hostedMutationSlug('access'),
      sourceDomainId:button.dataset.domain,
      registryId:button.dataset.registry,
      recordId:button.dataset.record,
    },{requestId:createRequestId()})
    S.hostedGovernanceMessage=result?.ok===true
      ?{ok:true,text:'Shared-resource access submitted for domain approval.'}
      :{ok:false,text:apiErrorMessage(result,'Access could not be requested.')}
    await loadHostedPublications()
  }))
  document.querySelectorAll('.hgaccessrevoke').forEach(button=>button.onclick=sessionTaskHandler(async()=>{
    if(!hostedActionEnabled('revokeSharedResourceAccess',hostedCaps()))return
    button.disabled=true
    const result=await api('/governance/access-revocations',{
      resourceType:button.dataset.type,
      resourceId:button.dataset.reference,
      reason:'Revoked by the domain lead from Resource Governance.',
    },{requestId:createRequestId()})
    S.hostedGovernanceMessage=result?.ok===true
      ?{ok:true,text:'Shared-resource access revoked.'}
      :{ok:false,text:apiErrorMessage(result,'Access could not be revoked.')}
    await loadHostedPublications()
  }))
}
function vHostedAccessAdmin(){
  return `<h1>Users &amp; Access</h1>
  <p class="subtitle">Manage domain membership and project assignments in your authorized scope.</p>
  ${scopeNote()}
  <div id="hostedaccessadmin"><div class="empty"><span class="spin">⟳</span> loading access records…</div></div>`
}
function hostedAccessDomainId(){
  const domains=S.hostedAccessDomains||[]
  const active=activeDomain()
  if(active&&domains.some(domain=>domain.id===active))return active
  if(domains.some(domain=>domain.id===S.hostedAccessDomainId)){
    return S.hostedAccessDomainId
  }
  return domains.find(domain=>domain.id==='platform')?.id||domains[0]?.id||''
}
function hostedAccessDomainProjects(){
  const domainId=hostedAccessDomainId()
  return (S.hostedAccessProjects||[]).filter(project=>
    project&&project.domainId===domainId
  )
}
function hostedAccessSelectedProject(){
  const projects=hostedAccessDomainProjects()
  return projects.find(project=>
    `${project.domainId}/${project.id}`===S.hostedAccessProjectKey
  )||(!S.hostedAccessProjectKey&&projects.length===1?projects[0]:null)
}
function hostedAccessMemberRows(items,scope){
  const canRevoke=hostedActionEnabled(
    scope==='domain'?'revokeDomainMembership':'revokeProjectMembership',
    hostedCaps(),
  )
  if(!items.length)return '<div class="empty">No members are assigned in this scope.</div>'
  return `<table><thead><tr><th>Username</th><th>Directory status</th><th></th></tr></thead><tbody>${items.map(member=>`<tr data-${scope}-member="${esc(member.username)}">
    <td><b>${esc(member.username)}</b></td>
    <td><span class="chip">${esc(member.userStatus)}</span>${member.enabled?'':' <span class="chip" style="color:var(--err);border-color:var(--err-bd)">disabled</span>'}</td>
    <td style="text-align:right"><button class="ghost" data-${scope}-revoke="${esc(member.username)}" ${canRevoke?'':'disabled'}>Revoke</button></td>
  </tr>`).join('')}</tbody></table>`
}
function hostedAccessDomainPanel(){
  const domainId=hostedAccessDomainId()
  const members=S.hostedAccessDomainMembers||[]
  const canGrant=hostedActionEnabled('grantDomainMembership',hostedCaps())
  const state=hostedAccessMemberState('Domain')
  if(state)return state
  return `<section>
    <div class="sec-h">Domain members</div>
    <p class="d">Membership is stored in the Cognito group for <code>${esc(domainId)}</code>. Project assignment is managed separately.</p>
    ${hostedAccessMemberRows(members,'domain')}
    ${S.hostedAccessDomainMembersCursor?'<button class="ghost" data-access-more="domain">Load more domain members</button>':''}
    <div class="grid2" style="margin-top:16px">
      <div><label style="margin-top:0">Cognito username</label><input id="haccessdomainusername" maxlength="128" placeholder="username"/></div>
      <div><label style="margin-top:0">Reason</label><input id="haccessdomainreason" data-demo-assist-field="domainAccessReason" maxlength="1024" placeholder="Why this domain access is required"/></div>
    </div>
    <div class="bar" style="margin-top:10px"><button class="primary" id="haccessdomaingrant" ${canGrant?'':'disabled'}>Add domain member</button></div>
  </section>`
}
function hostedAccessProjectPanel(){
  const projects=hostedAccessDomainProjects()
  const selected=hostedAccessSelectedProject()
  const canGrant=hostedActionEnabled('grantProjectMembership',hostedCaps())
  const chooser=`<label style="max-width:420px">Project</label>
    <select id="haccessproject"><option value="" ${selected?'':'selected'}>Choose an available project</option>${projects.map(project=>{
      const key=`${project.domainId}/${project.id}`
      return `<option value="${esc(key)}" ${selected&&key===`${selected.domainId}/${selected.id}`?'selected':''}>${esc(project.name||project.id)}</option>`
    }).join('')}</select>`
  if(!selected)return `<section>${chooser}<div class="empty">${S.hostedAccessProjectKey?'The selected project is unavailable. Choose a project to continue.':projects.length?'Choose a project to manage membership.':'No active projects are available in this domain.'}</div></section>`
  const state=hostedAccessMemberState('Project')
  if(state)return `<section>${chooser}${state}</section>`
  return `<section>
    <div class="sec-h">Project members</div>
    ${chooser}
    ${hostedAccessMemberRows(S.hostedAccessProjectMembers||[],'project')}
    ${S.hostedAccessProjectMembersCursor?'<button class="ghost" data-access-more="project">Load more project members</button>':''}
    <div class="grid2" style="margin-top:16px">
      <div><label style="margin-top:0">Cognito username</label><input id="haccessprojectusername" maxlength="128" placeholder="username"/></div>
      <div><label style="margin-top:0">Reason</label><input id="haccessprojectreason" data-demo-assist-field="projectAccessReason" maxlength="1024" placeholder="Why this project access is required"/></div>
    </div>
    <div class="bar" style="margin-top:10px"><button class="primary" id="haccessprojectgrant" ${canGrant?'':'disabled'}>Add project member</button></div>
  </section>`
}
function renderHostedAccessAdmin(){
  const box=document.getElementById('hostedaccessadmin');if(!box)return
  const domainId=hostedAccessDomainId()
  if(!domainId){
    box.innerHTML='<div class="empty">No active domains are available in this scope.</div>'
    return
  }
  const tab=S.hostedAccessTab==='project'?'project':'domain'
  const panel=tab==='project'
    ?hostedAccessProjectPanel()
    :hostedAccessDomainPanel()
  box.innerHTML=`${S.hostedAccessMessage?`<div class="status ${S.hostedAccessMessage.ok?'ok':'err'}">${esc(S.hostedAccessMessage.text)}</div>`:''}
  <div class="tabs">
    <button data-access-tab="domain" class="${tab==='domain'?'on':''}">Domain members</button>
    <button data-access-tab="project" class="${tab==='project'?'on':''}">Project members</button>
  </div>
  ${panel}`
  wireHostedAccessAdmin()
  applyDemoAssistToHostedView()
}
async function loadHostedMemberPage(path,{domainId,projectId}={}){
  const page=await api(path)
  if(page?.ok!==true)throw new Error(apiErrorMessage(page,'Membership access is unavailable.'))
  if(page.domainId!==domainId||(projectId&&page.projectId!==projectId)||!Array.isArray(page.items)
    ||(page.cursor!==null&&(typeof page.cursor!=='string'||!/^[A-Za-z0-9._~+/=-]{1,2048}$/.test(page.cursor)))
    ||page.items.some(member=>!member||typeof member.username!=='string'||typeof member.subject!=='string'
      ||typeof member.userStatus!=='string'||typeof member.enabled!=='boolean')
    ||new Set(page.items.map(member=>member.username)).size!==page.items.length){
    throw new Error('Membership response is invalid or belongs to another scope.')
  }
  return page
}
function hostedAccessMemberState(kind){
  const key='hostedAccess'+kind+'Members'
  const selected=kind==='Project'?hostedAccessSelectedProject():null
  const scope=kind==='Domain'?hostedAccessDomainId():selected?`${selected.domainId}/${selected.id}`:''
  if(S[key+'Loading'])return '<p role="status">Loading membership…</p>'
  if(S[key+'Error'])return `<p role="status">${esc(S[key+'Error'])}</p><button class="ghost" data-access-retry>Retry membership</button>`
  if(S[key+'Scope']!==scope)return '<p role="status">Membership has not been loaded for this scope.</p>'
  return null
}
async function loadHostedMemberships({render=true,more=null}={}){
  const box=document.getElementById('hostedaccessadmin');if(!box)return
  const epoch=sessionEpoch, domainId=hostedAccessDomainId()
  const project=hostedAccessSelectedProject(), projectId=project?.id||''
  if(!domainId)return
  const load=async(kind)=>{
    const key='hostedAccess'+kind+'Members', isProject=kind==='Project'
    const scope=isProject?(project?`${domainId}/${projectId}`:''):domainId
    const cursor=more?S[key+'Cursor']:null
    if(more&&(!cursor||S[key+'Scope']!==scope))return
    const previous=cursor?(S[key]||[]):[]
    const request=(box[key+'Request']||0)+1;box[key+'Request']=request
    const current=()=>sessionEpochIsCurrent(epoch)&&document.getElementById('hostedaccessadmin')===box
      &&box[key+'Request']===request&&hostedAccessDomainId()===domainId
      &&(!isProject||(hostedAccessSelectedProject()?.id||'')===projectId)
    S[key]=[];S[key+'Cursor']=null;S[key+'Scope']=scope
    S[key+'Loading']=true;S[key+'Error']=null
    if(render)renderHostedAccessAdmin()
    try{
      const page=isProject&&!projectId?{items:[],cursor:null}:await loadHostedMemberPage(
        '/access/'+(isProject?'project':'domain')+'-members?domainId='+encodeURIComponent(domainId)
        +(isProject?'&projectId='+encodeURIComponent(projectId):'')+'&limit=50'
        +(cursor?'&cursor='+encodeURIComponent(cursor):''),{domainId,...(isProject?{projectId}:{})})
      if(!current())return
      const items=[...previous,...page.items]
      if((cursor&&page.cursor===cursor)||new Set(items.map(member=>member.username)).size!==items.length)throw new Error('Membership pagination is invalid.')
      S[key]=items;S[key+'Cursor']=page.cursor
    }catch(error){
      if(error===CANCELED_REQUEST||!current())return
      S[key]=[];S[key+'Cursor']=null
      S[key+'Error']=error.message||'Membership inventory is unavailable.'
    }finally{
      if(current()){
        S[key+'Loading']=false
        if(render)renderHostedAccessAdmin()
      }
    }
  }
  await Promise.all((more?[more==='domain'?'Domain':'Project']:['Domain','Project']).map(load))
}
async function loadHostedAccessAdmin(){
  const box=document.getElementById('hostedaccessadmin');if(!box)return
  const epoch=sessionEpoch, request=(box.accessRequest||0)+1;box.accessRequest=request
  const domain=activeDomain()
  const current=()=>sessionEpochIsCurrent(epoch)&&activeDomain()===domain&&document.getElementById('hostedaccessadmin')===box&&box.accessRequest===request
  for(const kind of ['Domain','Project']){
    const key='hostedAccess'+kind+'Members'
    box[key+'Request']=(box[key+'Request']||0)+1
    S[key]=[];S[key+'Cursor']=null;S[key+'Scope']=null
    S[key+'Loading']=true;S[key+'Error']=null
  }
  renderHostedAccessAdmin()
  try{
    const [domains,projects]=await Promise.all([
      api('/domains'),
      loadWorkspaceProjectPages(rawApi),
    ])
    if(!current())return
    if(domains?.ok!==true||!Array.isArray(domains.domains))throw new Error('Access inventory could not be loaded.')
    S.hostedAccessDomains=domains.domains.filter(domain=>
      domain&&typeof domain.id==='string'&&domain.id&&(SESSION?.role==='admin'||domain.id===activeDomain())
    )
    S.hostedAccessDomainId=hostedAccessDomainId()
    S.hostedAccessProjects=projects.filter(project=>project.status==='ACTIVE'
      &&S.hostedAccessDomains.some(domain=>domain.id===project.domainId))
    const selectedProject=hostedAccessSelectedProject()
    if(selectedProject)S.hostedAccessProjectKey=`${selectedProject.domainId}/${selectedProject.id}`
    await loadHostedMemberships()
    if(current())renderHostedAccessAdmin()
  }catch(error){
    if(error===CANCELED_REQUEST||!current())return
    hostedRetryState(box,'Users & Access',loadHostedAccessAdmin)
  }
}

function hostedMembershipInput(scope,username){
  const domainId=hostedAccessDomainId()
  const project=hostedAccessSelectedProject()
  const inputId=scope==='domain'?'haccessdomainusername':'haccessprojectusername'
  const reasonId=scope==='domain'?'haccessdomainreason':'haccessprojectreason'
  const resolvedUsername=username||document.getElementById(inputId)?.value.trim()||''
  const reason=document.getElementById(reasonId)?.value.trim()||''
  if(
    !domainId
    ||!/^[A-Za-z0-9][A-Za-z0-9._@+-]{0,127}$/.test(resolvedUsername)
    ||reason.length<3
    ||(scope==='project'&&!project)
  ){
    return null
  }
  return {
    domainId,
    ...(scope==='project'?{projectId:project.id}:{}),
    username:resolvedUsername,
    reason,
  }
}
async function mutateHostedDomainMembership(operation,username){
  const body=hostedMembershipInput('domain',username)
  if(!body){
    S.hostedAccessMessage={ok:false,text:'Enter a valid Cognito username and reason.'}
    renderHostedAccessAdmin()
    return
  }
  const path=operation==='grant'
    ?'/access/domain-memberships'
    :'/access/domain-membership-revocations'
  const result=await api(path,body,{requestId:createRequestId()})
  if(result?.ok===true)businessForms.clear('access')
  S.hostedAccessMessage=result?.ok===true
    ?{ok:true,text:operation==='grant'?'Domain member added.':'Domain membership revoked.'}
    :{ok:false,text:apiErrorMessage(result,'Domain membership could not be changed.')}
  if(result?.ok===true)await loadHostedMemberships()
  else renderHostedAccessAdmin()
}
async function mutateHostedProjectMembership(operation,username){
  const body=hostedMembershipInput('project',username)
  if(!body){
    S.hostedAccessMessage={ok:false,text:'Choose a project and enter a valid Cognito username and reason.'}
    renderHostedAccessAdmin()
    return
  }
  const path=operation==='grant'
    ?'/access/project-memberships'
    :'/access/project-membership-revocations'
  const result=await api(path,body,{requestId:createRequestId()})
  if(result?.ok===true)businessForms.clear('access')
  S.hostedAccessMessage=result?.ok===true
    ?{ok:true,text:operation==='grant'?'Project member added.':'Project membership revoked.'}
    :{ok:false,text:apiErrorMessage(result,'Project membership could not be changed.')}
  if(result?.ok===true)await loadHostedMemberships()
  else renderHostedAccessAdmin()
}
function wireHostedAccessAdmin(){
  const box=document.getElementById('hostedaccessadmin');if(!box)return
  box.querySelectorAll('[data-access-more]').forEach(button=>button.onclick=sessionTaskHandler(()=>loadHostedMemberships({more:button.dataset.accessMore})))
  const retry=box.querySelector('[data-access-retry]')
  if(retry)retry.onclick=sessionTaskHandler(()=>loadHostedMemberships())
  box.querySelectorAll('[data-access-tab]').forEach(button=>{
    button.onclick=()=>{
      if(!confirmContextChange())return
      businessForms.clear('access')
      S.hostedAccessTab=button.dataset.accessTab
      S.hostedAccessMessage=null
      renderHostedAccessAdmin()
    }
  })
  const project=document.getElementById('haccessproject')
  if(project)project.onchange=()=>runSessionTask(async()=>{
    if(!confirmContextChange()){project.value=S.hostedAccessProjectKey;return}
    businessForms.clear('access')
    S.hostedAccessProjectKey=project.value
    S.hostedAccessMessage=null
    await loadHostedMemberships()
  })
  const domainGrant=document.getElementById('haccessdomaingrant')
  if(domainGrant)domainGrant.onclick=sessionTaskHandler(async()=>{
    if(!hostedActionEnabled('grantDomainMembership',hostedCaps()))return
    domainGrant.disabled=true
    await mutateHostedDomainMembership('grant')
  })
  box.querySelectorAll('[data-domain-revoke]').forEach(button=>{
    button.onclick=sessionTaskHandler(async()=>{
      if(!hostedActionEnabled('revokeDomainMembership',hostedCaps()))return
      button.disabled=true
      await mutateHostedDomainMembership('revoke',button.dataset.domainRevoke)
    })
  })
  const projectGrant=document.getElementById('haccessprojectgrant')
  if(projectGrant)projectGrant.onclick=sessionTaskHandler(async()=>{
    if(!hostedActionEnabled('grantProjectMembership',hostedCaps()))return
    projectGrant.disabled=true
    await mutateHostedProjectMembership('grant')
  })
  box.querySelectorAll('[data-project-revoke]').forEach(button=>{
    button.onclick=sessionTaskHandler(async()=>{
      if(!hostedActionEnabled('revokeProjectMembership',hostedCaps()))return
      button.disabled=true
      await mutateHostedProjectMembership('revoke',button.dataset.projectRevoke)
    })
  })
}
function approvedHostedEntries(entries,type){
  return entries.filter(entry=>{
    const versions=Array.isArray(entry.versions)?entry.versions:[]
    return entry.type===type
      && versions.some(version=>
        version.status==='APPROVED'
        && version.semver===entry.defaultVersion)
  })
}
function hostedCsv(value){
  return String(value||'').split(',').map(item=>item.trim()).filter(Boolean)
}
function hostedIdList(value){
  return Array.isArray(value)
    ? value.filter(item=>typeof item==='string'&&item)
    : hostedCsv(value)
}
const HOSTED_BUILD_RESOURCE_FIELDS = {
  TOOL:'toolIds',
  MCP_SERVER:'mcpServerIds',
  SKILL:'skillIds',
  BLUEPRINT:'blueprintIds',
}
const HOSTED_RUNNABLE_BLUEPRINT_IDS = new Set([
  'chat-assistant',
  'workflow-orchestrator',
])
function hostedBuildLanding(){
  return `<div class="card"><span class="roletag dom">choose your journey</span>
    <p class="d" style="color:var(--dim);font-size:.85rem;margin-bottom:12px">Domain Builders can start any of these three journeys in their authorized domain. Every journey ships through the same CI/CD + eval gate - the platform's product is the gate, not the code.</p>
    <div class="grid3">${DOORS.map(door=>`<button class="card bp" data-hosted-journey="${door.id}" style="text-align:left">
      <h4>${door.ic} ${door.title}</h4>
      <div class="d" style="font-size:.8rem;color:var(--dim);margin:6px 0 8px">${door.d}</div>
      <span class="chip type">${door.preset}</span>
    </button>`).join('')}</div>
  </div>`
}
function hostedBlueprintVersion(blueprintId){
  const last=String(blueprintId||'').split('/').pop()
  const ids=new Set([blueprintId,last,last?.replace(/^blueprint_/,'')].filter(Boolean))
  const entry=(S.hostedBuildRegistryEntries||[]).find(candidate=>
    ids.has(candidate.id)||ids.has(candidate.recordId))
  if(!entry)return null
  const version=entry.resolved
    ||(entry.versions||[]).find(candidate=>
      candidate.semver===entry.defaultVersion&&candidate.status==='APPROVED')
  return version?.content?.template?{entry,version}:null
}
function hostedRegistryResourceType(entry){
  if(entry.type==='MCPServer')return 'MCP_SERVER'
  if(entry.type==='Blueprint')return 'BLUEPRINT'
  if(entry.type==='Skill'){
    const resolved=entry.resolved
      ||(entry.versions||[]).find(version=>version.semver===entry.defaultVersion)
      ||{}
    return resolved.content?.toolType?'TOOL':'SKILL'
  }
  return null
}
function hostedBuildGovernedResources(domainId,projectId){
  const local=hostedBuildRegistryEntriesForDomain(
    S.hostedBuildRegistryEntries||[],
    domainId,
  ).flatMap(entry=>{
    const resourceType=hostedRegistryResourceType(entry)
    if(entry.domain==='shared'&&resourceType!=='BLUEPRINT'&&!S.hostedBuildCatalogPolicyApplied)return []
    if(resourceType==='BLUEPRINT'&&!HOSTED_RUNNABLE_BLUEPRINT_IDS.has(entry.id))return []
    const field=HOSTED_BUILD_RESOURCE_FIELDS[resourceType]
    if(!field||!entry.id)return []
    return [{
      field,
      id:entry.id,
      label:entry.name||entry.id,
      resourceType,
      source:entry.domain==='shared'?'Platform Registry':'Scoped Registry',
    }]
  })
  const shared=(S.hostedBuildCatalogPolicyApplied?[]:S.hostedBuildSharedResources||[])
    .filter(resource=>resource.granted===true)
    .flatMap(resource=>{
      if(resource.resourceType==='BLUEPRINT')return []
      const field=HOSTED_BUILD_RESOURCE_FIELDS[resource.resourceType]
      const id=resource.registryId&&resource.recordId
        ? `${resource.registryId}/${resource.recordId}`
        :''
      if(!field||!id)return []
      return [{
        field,
        id,
        label:resource.displayName||resource.resourceId||id,
        resourceType:resource.resourceType,
        source:`Shared from ${resource.domainId}`,
      }]
    })
  const unique=new Map()
  for(const resource of [...local,...shared]){
    unique.set(`${resource.field}\0${resource.id}`,resource)
  }
  const project=(S.hostedBuildProjects||[]).find(item=>item.domainId===domainId&&item.id===projectId)
  return [...unique.values()].filter(resource=>projectAllowsResource(project,
    {BLUEPRINT:'Blueprint',TOOL:'Skill',SKILL:'Skill',MCP_SERVER:'MCPServer'}[resource.resourceType],resource.id))
    .sort((left,right)=>left.label.localeCompare(right.label))
}
function hostedBuildResourcePicker(resources,field,label,selectedIds){
  const available=resources.filter(resource=>resource.field===field)
  const selected=new Set(hostedIdList(selectedIds))
  return `<fieldset style="border:1px solid var(--border);padding:10px 12px">
    <legend style="padding:0 5px;font-size:.76rem;font-weight:600">${esc(label)}</legend>
    ${available.length?available.map(resource=>`<label style="display:flex;gap:8px;align-items:flex-start;margin:6px 0">
      <input type="checkbox" data-hbresource="${esc(resource.resourceType)}" data-field="${esc(field)}" value="${esc(resource.id)}" ${selected.has(resource.id)?'checked':''}/>
      <span><b>${esc(resource.label)}</b><span class="d" style="display:block">${esc(resource.source)} · <code>${esc(resource.id)}</code></span></span>
    </label>`).join(''):'<div class="d">No approved or granted resources are available.</div>'}
  </fieldset>`
}
function hostedDeploymentId(agentId,suffix){
  return `${agentId.slice(0,Math.max(1,63-suffix.length-1))}-${suffix}`
}
function hostedBuildOptions(blueprintId,fallback){
  const template=hostedBlueprintVersion(blueprintId)?.version?.content?.template
  const options=template||fallback
  if(!options)return null
  const exact={
    framework:options.framework,
    deployTarget:options.deployTarget,
    memory:options.memory,
    streaming:options.streaming,
    identity:options.identity,
    guardrails:options.guardrails,
  }
  return exact.framework&&exact.deployTarget&&exact.memory
    &&['streaming','identity','guardrails'].every(key=>typeof exact[key]==='boolean')
    ?exact
    :null
}
// Project the governed agent record onto the detail panel's shape. Hosted
// deployments expose no /agent-detail route, and nothing here is inferred:
// absent configuration stays absent so the panel reports it as unset.
function hostedAgentDetail(record){
  if(!record)return null
  const options=record.buildConfig?.buildOptions||null
  const params=record.buildConfig?.modelParameters||null
  return {
    domain:record.domain||record.domainId,
    owningProject:record.projectId,
    runtime:options?.deployTarget||'not configured',
    protocol:options?.streaming?'streaming':'request/response',
    identity:options?.identity?'Cognito CUSTOM_JWT':'none',
    memory:null,
    memoryMode:options?.memory||null,
    observability:record.status==='READY'?'CloudWatch + OTEL':'not deployed yet',
    model:record.model||record.modelId||null,
    modelParams:params||null,
    persona:record.buildConfig?.instructions||'',
    skills:(record.skillIds||[]).map(id=>({id})),
    tools:(record.toolIds||[]).map(id=>({id,type:'tool'}))
      .concat((record.mcpServerIds||[]).map(id=>({id,type:'MCP'}))),
    builtinTools:[],
    deployedArn:null,
    integration:null,
  }
}
const HOSTED_GUARDRAIL_CATALOG=GUARDRAIL_CATALOG
const HOSTED_GUARDRAIL_ACTIONS=GUARDRAIL_ACTIONS
const HOSTED_GUARDRAIL_RUN_MODES=GUARDRAIL_RUN_MODES
function hostedGuardrailChain(value){
  if(value==null)return defaultGuardrailChain()
  return validateGuardrailChain(value)
}
function hostedGuardrailChainHtml(chain){
  return `<div class="item" style="margin-top:12px">
    <b>Guardrail chain</b>
    <p class="d" style="margin:5px 0 10px">This ordered contract is stored with the Agent and exported for runtime binding. Platform baseline controls are locked on.</p>
    ${chain.map((entry,index)=>{
      const catalog=HOSTED_GUARDRAIL_CATALOG.find(item=>item.id===entry.id)
      return `<div class="item" data-hbguardrail="${esc(entry.id)}" style="margin:7px 0;padding:10px">
        <div class="bar" style="justify-content:space-between;margin:0">
          <label style="display:flex;align-items:center;gap:7px;margin:0">
            <input type="checkbox" data-hbguardrail-enabled ${entry.enabled?'checked':''} ${catalog?.mandatory?'disabled':''} style="width:auto"/>
            <b>${esc(catalog?.name||entry.id)}</b>
            ${catalog?.mandatory?'<span class="chip">platform baseline</span>':''}
          </label>
          <span class="bar" style="margin:0">
            <button class="ghost" type="button" data-hbguardrail-up ${index===0?'disabled':''} title="Move guardrail earlier">↑</button>
            <button class="ghost" type="button" data-hbguardrail-down ${index===chain.length-1?'disabled':''} title="Move guardrail later">↓</button>
          </span>
        </div>
        <div class="grid2">
          <div><label>Action</label><select data-hbguardrail-action>${HOSTED_GUARDRAIL_ACTIONS.map(action=>`<option ${entry.action===action?'selected':''}>${action}</option>`).join('')}</select></div>
          <div><label>Execution phase</label><select data-hbguardrail-run-mode>${HOSTED_GUARDRAIL_RUN_MODES.map(mode=>`<option ${entry.runMode===mode?'selected':''}>${mode}</option>`).join('')}</select></div>
        </div>
        <label>Custom message</label>
        <input data-hbguardrail-message data-demo-assist-field="guardrailMessage" maxlength="500" value="${esc(entry.message)}" placeholder="Optional message shown when this control blocks or flags"/>
      </div>`
    }).join('')}
  </div>`
}
function hostedReadGuardrailChain(){
  return [...document.querySelectorAll('[data-hbguardrail]')].map((row,priority)=>({
    id:row.dataset.hbguardrail,
    enabled:row.querySelector('[data-hbguardrail-enabled]')?.checked===true,
    action:row.querySelector('[data-hbguardrail-action]')?.value||'Block',
    runMode:row.querySelector('[data-hbguardrail-run-mode]')?.value||'Pre-Agent Execution',
    message:(row.querySelector('[data-hbguardrail-message]')?.value||'').trim(),
    priority,
  }))
}
function hostedNullableNumber(value,{integer=false}={}){
  const text=String(value??'').trim()
  if(!text)return null
  const number=Number(text)
  return Number.isFinite(number)&&(!integer||Number.isSafeInteger(number))
    ?number
    :NaN
}
function hostedBuildModelsForDomain(domainId,projectId){
  const project=(S.hostedBuildProjects||[]).find(item=>item.domainId===domainId&&item.id===projectId)
  return (S.hostedBuildModels||[]).filter(model=>{
    const access=model.accessByDomain&&typeof model.accessByDomain==='object'
      ?model.accessByDomain[domainId]
      :model.access
    const catalogAllowed=S.hostedBuildCatalogModelIds?.includes(model.id)
      &&access?.usable===true&&['ALLOWED','GRANTED'].includes(access.status)
    return catalogAllowed&&projectAllowsResource(project,'Model',model.id)
  })
}
function hostedBuildForm(){
  const form=S.hostedBuildForm||{}
  const selected=(S.hostedBuildAgents||[]).find(agent=>hostedResourceKey(agent)===S.hostedBuildAgentKey)
  const projects=S.hostedBuildProjects||[]
  const requestedKey=Object.hasOwn(form,'projectKey')?form.projectKey
    :selected?`${selected.domainId}/${selected.projectId}`
    :S.workspaceDomain&&S.workspaceProject?`${S.workspaceDomain}/${S.workspaceProject}`:''
  const project=projects.find(item=>`${item.domainId}/${item.id}`===requestedKey)
    ||(!requestedKey&&!Object.hasOwn(form,'projectKey')&&projects.length===1?projects[0]:null)
  const resources=hostedBuildGovernedResources(project?.domainId,project?.id)
  const selections=normalizeHostedBuildSelections(resources,form,selected)
  const modelIds=hostedBuildModelsForDomain(project?.domainId,project?.id).map(model=>model.id)
  const hasFormModel=Object.hasOwn(form,'modelId')
  const requestedModelId=hasFormModel?form.modelId:(selected?.modelId||'')
  const modelId=modelIds.includes(requestedModelId)
    ?requestedModelId
    :!hasFormModel&&!selected?.modelId
      ?modelIds[0]||''
      :''
  const blueprintId=selections.blueprintId
  const selectedParameters=selected?.buildConfig?.modelParameters||{}
  return {
    projectKey:project?`${project.domainId}/${project.id}`:requestedKey,
    domainId:project?.domainId||'',
    projectId:project?.id||'',
    id:form.id||selected?.id||'',
    name:form.name||selected?.name||'',
    description:form.description??selected?.description??'',
    modelId,
    toolIds:selections.toolIds,
    mcpServerIds:selections.mcpServerIds,
    skillIds:selections.skillIds,
    blueprintId,
    blueprintIds:selections.blueprintIds,
    memoryIds:form.memoryIds??(selected?.memoryIds||[]).join(', '),
    knowledgeBaseIds:form.knowledgeBaseIds??(selected?.knowledgeBaseIds||[]).join(', '),
    instructions:form.instructions??selected?.buildConfig?.instructions??'',
    temperature:Object.hasOwn(form,'temperature')
      ?form.temperature
      :selectedParameters.temperature??null,
    maxTokens:Object.hasOwn(form,'maxTokens')
      ?form.maxTokens
      :selectedParameters.maxTokens??null,
    buildOptions:hostedBuildOptions(
      blueprintId,
      form.buildOptions||selected?.buildConfig?.buildOptions,
    ),
    guardrailChain:hostedGuardrailChain(
      form.guardrailChain||selected?.buildConfig?.guardrailChain,
    ),
    repositoryName:form.repositoryName||selected?.id||form.id||'',
    prompt:form.prompt||'Confirm the agent is ready for its governed workflow.',
  }
}
function hostedBuildPublicationKey(agent){
  return hostedResourceKey(agent)
}
function hostedBuildRegistryPublication(agent){
  const key=hostedBuildPublicationKey(agent)
  if(!key)return null
  const remembered=S.hostedBuildRegistryPublications?.[key]
  const resourceId=`${agent.projectId}/${agent.id}`
  const entry=(S.hostedBuildAgentRegistryEntries||[]).find(candidate=>
    candidate.domain===agent.domainId
    &&candidate.id===resourceId)
  if(!entry)return remembered||null
  const versions=Array.isArray(entry.versions)?entry.versions:[]
  const version=versions.find(candidate=>
    candidate.semver===entry.defaultVersion)
    ||versions.at(-1)
  const aws=version?._aws
  if(!aws?.registryId||!aws?.recordId)return remembered||null
  const reference=`${aws.registryId}/${aws.recordId}`
  const approval=(S.hostedBuildApprovals||[]).find(candidate=>
    candidate.kind==='RESOURCE_PUBLICATION'
    &&candidate.domainId===agent.domainId
    &&candidate.projectId===agent.projectId
    &&candidate.resourceType==='AGENT'
    &&candidate.resourceId===reference)
  return {
    record:{
      domainId:agent.domainId,
      resourceId:entry.id,
      registryId:aws.registryId,
    recordId:aws.recordId,
    status:aws.awsStatus||version?.status||'UNKNOWN',
  },
    approval:approval||remembered?.approval||null,
    entryId:entry.id,
  }
}
function vHostedBuild(){
  return `<h1>Build Agent</h1>
  <p class="subtitle">Choose one of the same three governed build journeys, then hand the immutable repository preview to GitHub.</p>
  ${scopeNote()}
  <div id="hostedbuild"><div class="empty"><span class="spin">⟳</span> loading the build workspace…</div></div>`
}
function hostedMinimalJourney(){
  const draft=S.hostedBuildJourneyDraft
  return `<div class="bar" style="margin-bottom:4px"><button class="ghost" data-hosted-journey-back>← All journeys</button></div>
  <div class="card">
    <span class="roletag dom">journey · foundation start</span>
    <h3 style="margin-top:8px">${WRENCH_IC}Foundation start</h3>
    <p class="d" style="color:var(--dim);font-size:.85rem">Repository foundation only: the mandatory organization CI, governance, observability and evaluation gates. This journey creates no Agent record.</p>
    <label>Repository name</label>
    <input id="hminimalrepo" data-demo-assist-field="repositoryName" maxlength="100" value="${esc(draft?.repositoryName||'')}" placeholder="release-coordinator"/>
    <div class="bar"><button class="primary" id="hminimalpreview">Preview foundation repository</button></div>
  </div>
  ${hostedDeliveryCard()}`
}
function hostedSpecAgentForm(journey){
  const saved=S.hostedSpecAgentForm||{}
  const project=(S.hostedBuildProjects||[]).find(item=>
    `${item.domainId}/${item.id}`===saved.projectKey)
    ||(S.hostedBuildProjects||[])[0]
  const models=hostedBuildModelsForDomain(project?.domainId,project?.id)
  const model=models.some(item=>item.id===saved.modelId)
    ?saved.modelId
    :models[0]?.id||''
  const blueprints=hostedBuildGovernedResources(project?.domainId,project?.id)
    .filter(resource=>resource.field==='blueprintIds')
  const blueprint=blueprints.some(item=>item.id===saved.blueprintId)
    ?saved.blueprintId
    :blueprints[0]?.id||''
  const profile=journey?.inception?.profile||{}
  const base=String(journey?.repositoryName||'agent')
    .toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'')
  const suffix=String(journey?.id||'journey').replace(/[^a-z0-9]/gi,'').slice(-6).toLowerCase()
  const id=`${/^[a-z]/.test(base)?base:'agent-'+base}`.slice(0,Math.max(1,41-suffix.length))
    .replace(/-+$/,'')+'-'+suffix
  const capabilities=Array.isArray(profile.capabilities)?profile.capabilities:[]
  const compliance=Array.isArray(profile.compliance)?profile.compliance:[]
  const instructions=[
    profile.summary||`Implement the approved specification for ${journey.repositoryName}.`,
    capabilities.length?`Required capabilities:\n- ${capabilities.join('\n- ')}`:'',
    profile.performsActions===false?'The Agent must remain read-only.':'',
    compliance.length?`Compliance requirements:\n- ${compliance.join('\n- ')}`:'',
  ].filter(Boolean).join('\n\n')
  return {
    projectKey:project?`${project.domainId}/${project.id}`:'',
    domainId:project?.domainId||'',
    projectId:project?.id||'',
    id,
    name:String(profile.name||journey.repositoryName||'Specification Agent').slice(0,128),
    description:String(profile.summary||'Agent generated from an approved specification contract.').slice(0,4096),
    modelId:model,
    blueprintId:blueprint,
    buildOptions:hostedBuildOptions(blueprint),
    guardrailChain:hostedGuardrailChain(),
    instructions,
  }
}
function hostedSpecJourney(){
  const journey=S.hostedBuildJourneyDraft
  const transcript=journey?.transcript||[]
  const userTurns=transcript.filter(turn=>turn.role==='user').length
  const contractReady=journey?.status==='CONTRACT_READY'
  const form=contractReady?hostedSpecAgentForm(journey):null
  const projects=S.hostedBuildProjects||[]
  const models=form?hostedBuildModelsForDomain(form.domainId,form.projectId):[]
  const blueprints=hostedBuildGovernedResources(form?.domainId,form?.projectId)
    .filter(resource=>resource.field==='blueprintIds')
  const selected=(S.hostedBuildAgents||[]).find(agent=>
    hostedResourceKey(agent)===S.hostedBuildAgentKey)
  return `<div class="bar" style="margin-bottom:4px"><button class="ghost" data-hosted-journey-back>← All journeys</button></div>
  <div class="card">
    <span class="roletag dom">journey · spec-first</span>
    <h3 style="margin-top:8px">${CHAT_IC}AI-assisted design</h3>
    <p class="d" style="color:var(--dim);font-size:.85rem">Powered by Agent Design Assistant · Platform service. It asks focused discovery questions, the platform composes the contract, then creates a governed domain Agent ready for explicit testing.</p>
    ${journey?`<div class="chat" style="margin-top:12px">${transcript.map(turn=>`<div class="msg"><div class="role">${esc(turn.role)}</div><div class="body">${md(turn.text)}</div></div>`).join('')}</div>
      ${contractReady?'':`<label>Discovery response</label><textarea id="hspecmessage" data-demo-assist-field="specDiscoveryResponse" maxlength="8000" style="min-height:90px"></textarea>
      <div class="bar"><button class="ghost" id="hspecsend">Send response</button><span class="d">${userTurns} of 2 required responses recorded</span></div>`}
      <div class="bar">
        ${contractReady?'':`<button class="ghost" id="hspeccontract" ${userTurns>=2?'':'disabled'}>Create specification contract</button>`}
      </div>`
      :`<label>Repository name</label>
      <input id="hspecrepo" data-demo-assist-field="repositoryName" maxlength="100" placeholder="release-coordinator"/>
      <div class="bar"><button class="primary" id="hspecstart">Start discovery</button></div>`}
    ${contractReady&&!S.hostedBuildLoaded?'<div class="status info">Loading authorized projects and governed resources…</div>':''}
    ${contractReady&&S.hostedBuildLoaded&&!projects.length?'<div class="status info">Create an authorized project before creating this Agent.<div class="bar"><button class="primary" data-hosted-project-create>Create project</button></div></div>':''}
    ${contractReady&&S.hostedBuildLoaded&&projects.length?`<div class="sec-h">Governed Agent</div>
      <div class="grid2">
        <div><label style="margin-top:0">Project</label><select id="hspecproject">${projects.map(project=>`<option value="${esc(project.domainId+'/'+project.id)}" ${form.projectKey===project.domainId+'/'+project.id?'selected':''}>${esc(project.name||project.id)} · ${esc(project.domainId)}</option>`).join('')}</select></div>
        <div><label style="margin-top:0">Approved model</label><select id="hspecmodel"><option value="">Select an approved model</option>${models.map(model=>`<option value="${esc(model.id)}" ${form.modelId===model.id?'selected':''}>${esc(model.name||model.id)}</option>`).join('')}</select></div>
        <div><label>Approved Blueprint</label><select id="hspecblueprint"><option value="">Select one approved Blueprint</option>${blueprints.map(resource=>`<option value="${esc(resource.id)}" ${form.blueprintId===resource.id?'selected':''}>${esc(resource.label)}</option>`).join('')}</select></div>
        <div class="item"><div class="d">Agent</div><b>${esc(form.name)}</b><div class="d"><code>${esc(form.id)}</code></div></div>
      </div>
      ${selected?`<div class="status ok">Governed Agent ${esc(selected.name||selected.id)} is ${esc(selected.status)}.</div>`:''}
      ${models.length&&blueprints.length
        ?`<div class="bar"><button class="primary" id="hspecagent">Create governed Agent and preview repository</button>${selected?'<button class="ghost" id="hspeccontinue">Continue to test Agent</button>':''}</div>`
        :'<div class="status info">An approved model and supported Blueprint are required.</div>'}`:''}
  </div>
  ${hostedDeliveryCard()}`
}
async function previewHostedFullJourney(){
  const form=readHostedBuildForm()
  S.hostedBuildForm=form
  const repositoryName=form.repositoryName
  const selected=(S.hostedBuildAgents||[]).find(agent=>
    hostedResourceKey(agent)===S.hostedBuildAgentKey)
  if(!selected||!['TESTED','SANDBOX_DEPLOYED','PRODUCTION_PENDING','PRODUCTION_APPROVED','PRODUCTION_DEPLOYED','REJECTED'].includes(selected.status)){
    S.hostedBuildMessage={ok:false,text:'Run a successful hosted Agent test before previewing the repository.'}
    renderHostedBuild()
    return
  }
  const result=await hostedJourneyMutation('preview-FULL','/delivery/previews',{
    preset:'FULL',
    repositoryName,
    projectId:form.projectId,
    agentId:form.id,
  })
  if(result?.ok===true&&result.delivery){
    S.hostedBuildDelivery=result.delivery
    S.hostedBuildDeliveryResult=null
    S.hostedBuildMessage={ok:true,text:'Repository preview is ready. Review the files, then export to GitHub.'}
  }else{
    S.hostedBuildMessage={ok:false,text:apiErrorMessage(result,'The repository preview could not be created.')}
  }
  renderHostedBuild()
}
async function createHostedJourneyPreview(preset,repositoryName,journeyId,binding={}){
  const operation=preset==='MINIMAL'?'preview-MINIMAL':'preview-SPEC'
  const result=await hostedJourneyMutation(operation,'/delivery/previews',{
    preset,
    repositoryName,
    journeyId,
    ...(preset==='SPEC'?binding:{}),
  })
  if(result?.ok!==true||!result.delivery){
    S.hostedBuildMessage={ok:false,text:apiErrorMessage(result,'The repository preview could not be created.')}
    return false
  }
  S.hostedBuildDelivery=result.delivery
  S.hostedBuildDeliveryResult=null
  S.hostedBuildMessage={ok:true,text:`${preset} repository preview is ready for approval.`}
  return true
}
async function runHostedMinimalJourney(){
  const repositoryName=(document.getElementById('hminimalrepo')?.value||'').trim()
  if(!/^[a-z0-9][a-z0-9._-]{0,99}$/.test(repositoryName)){
    S.hostedBuildMessage={ok:false,text:'Enter a valid repository name.'}
    renderHostedBuild()
    return
  }
  let journey=S.hostedBuildJourneyDraft
  if(!journey){
    const result=await hostedJourneyMutation(
      'minimal-create',
      '/journeys',
      {preset:'MINIMAL',repositoryName},
    )
    if(result?.ok!==true||!result.journey){
      S.hostedBuildMessage={ok:false,text:apiErrorMessage(result,'The foundation journey could not be created.')}
      renderHostedBuild()
      return
    }
    journey=result.journey
    S.hostedBuildJourneyDraft=journey
  }
  await createHostedJourneyPreview('MINIMAL',repositoryName,journey.id)
  renderHostedBuild()
}
async function runHostedSpecAction(action){
  let journey=S.hostedBuildJourneyDraft
  if(action==='start'){
    const repositoryName=(document.getElementById('hspecrepo')?.value||'').trim()
    if(!/^[a-z0-9][a-z0-9._-]{0,99}$/.test(repositoryName)){
      S.hostedBuildMessage={ok:false,text:'Enter a valid repository name.'}
      renderHostedBuild()
      return
    }
    const result=await hostedJourneyMutation(
      'spec-create',
      '/journeys',
      {preset:'SPEC',repositoryName},
    )
    if(result?.ok!==true||!result.journey){
      S.hostedBuildMessage={ok:false,text:apiErrorMessage(result,'The specification journey could not be created.')}
    }else{
      S.hostedBuildJourneyDraft=result.journey
      S.hostedBuildMessage=null
    }
    renderHostedBuild()
    return
  }
  if(!journey)return
  let result
  if(action==='message'){
    const text=(document.getElementById('hspecmessage')?.value||'').trim()
    if(!text)return
    result=await hostedJourneyMutation(
      'spec-message',
      '/journeys/'+encodeURIComponent(journey.id)+'/messages',
      {text},
    )
  }else if(action==='contract'){
    result=await hostedJourneyMutation(
      'spec-contract',
      '/journeys/'+encodeURIComponent(journey.id)+'/contract',
      {},
    )
  }else if(action==='agent'){
    const form=hostedSpecAgentForm(journey)
    const payload={
      domainId:form.domainId,
      projectId:form.projectId,
      id:form.id,
      name:form.name,
      description:form.description,
      modelId:form.modelId,
      toolIds:[],
      mcpServerIds:[],
      skillIds:[],
      blueprintIds:form.blueprintId?[form.blueprintId]:[],
      memoryIds:[],
      knowledgeBaseIds:[],
      buildConfig:{
        instructions:form.instructions,
        modelParameters:{temperature:null,maxTokens:null},
        buildOptions:{...form.buildOptions},
        guardrailChain:form.guardrailChain.map(entry=>({...entry})),
      },
    }
    if(!form.projectId||!form.modelId||!form.blueprintId||!form.buildOptions){
      S.hostedBuildMessage={ok:false,text:'Select an authorized project, approved model, and supported Blueprint.'}
      renderHostedBuild()
      return
    }
    let agent=(S.hostedBuildAgents||[]).find(candidate=>
      candidate.domainId===form.domainId
      &&candidate.projectId===form.projectId
      &&candidate.id===form.id)
    if(!agent){
      result=await hostedBuildApiMutation(
        'spec-agent-create',
        '/agents',
        payload,
      )
      if(result?.ok!==true||!result.agent){
        S.hostedBuildMessage={ok:false,text:apiErrorMessage(result,'The governed Agent could not be created.')}
        renderHostedBuild()
        return
      }
      agent=result.agent
      rememberHostedBuildAgent(agent)
    }
    if(agent.status==='DRAFT'){
      result=await hostedBuildApiMutation(
        'spec-agent-configure',
        '/agents/'+encodeURIComponent(form.id),
        payload,
        {method:'PUT'},
      )
      if(result?.ok!==true||!result.agent){
        S.hostedBuildMessage={ok:false,text:apiErrorMessage(result,'The governed Agent could not be configured.')}
        renderHostedBuild()
        return
      }
      agent=result.agent
      rememberHostedBuildAgent(agent)
    }
    if(agent.status!=='READY_FOR_TEST'){
      S.hostedBuildMessage={ok:false,text:'The governed Agent is not ready for the next step.'}
      renderHostedBuild()
      return
    }
    await createHostedJourneyPreview('SPEC',journey.repositoryName,journey.id,{
      projectId:form.projectId,
      agentId:form.id,
    })
    renderHostedBuild()
    return
  }else{
    return
  }
  if(result?.ok===true&&result.journey){
    S.hostedBuildJourneyDraft=result.journey
    S.hostedBuildMessage=null
  }else{
    S.hostedBuildMessage={ok:false,text:apiErrorMessage(result,'The specification journey action could not be completed.')}
  }
  renderHostedBuild()
}
function hostedBuildMutationRequestId(operation,payload){
  const serialized=JSON.stringify(payload)
  const pending=S.hostedBuildMutationRequests[operation]
  if(pending?.payload===serialized)return pending.requestId
  const requestId=createRequestId()
  S.hostedBuildMutationRequests[operation]={payload:serialized,requestId}
  return requestId
}
function settleHostedBuildMutation(operation){
  delete S.hostedBuildMutationRequests[operation]
}
async function hostedJourneyMutation(operation,path,payload,options={}){
  const requestId=hostedBuildMutationRequestId(operation,payload)
  const result=await api(path,payload,{...options,requestId})
  settleHostedBuildMutation(operation)
  return result
}
async function hostedBuildApiMutation(operation,path,payload,options={}){
  const requestId=hostedBuildMutationRequestId(operation,payload)
  const result=await api(path,payload,{...options,requestId})
  if(result?.ok===true||result?.retryable!==true)settleHostedBuildMutation(operation)
  return result
}
function hostedDeliveryCard(){
  const delivery=S.hostedBuildDelivery
  const result=S.hostedBuildDeliveryResult
  if(!delivery)return result
    ?`<div class="status ${result.ok?'ok':'err'}">${esc(result.text)}</div>`
    :''
  const repositoryName=delivery.repositoryName
  const visibility=delivery.visibility
  const fingerprint=delivery.fingerprint||delivery.manifest?.fingerprint||''
  const previewExpiresAt=delivery.previewExpiresAt
  const previewExpiryMs=Date.parse(previewExpiresAt)
  const previewExpired=delivery.status==='PREVIEWED'
    &&Number.isFinite(previewExpiryMs)
    &&previewExpiryMs<=Date.now()
  const fileCount=delivery.manifest.summary.fileCount
  const workflowCount=delivery.manifest.summary.workflowCount
  const github=S.hostedBuildGitHub
  const expected=repositoryName
  const checkpoints=Array.isArray(delivery.checkpoints)?delivery.checkpoints:[]
  const repositoryCheckpoint=checkpoints.find(checkpoint=>checkpoint.status==='REPOSITORY_CREATED')
  const repositoryUrl=repositoryHandoff(repositoryCheckpoint?.github?.htmlUrl)?.url||''
  const completed=delivery.status==='COMPLETED'
  const recovering=delivery.status!=='PREVIEWED'&&!completed
  const latestCheckpoint=checkpoints.at(-1)?.status||delivery.status
  return `<div class="card" data-delivery-card>
    <div class="sec-h" style="margin-top:0">Your development repository</div>
    ${result&&!previewExpired?`<div class="status ${result.ok?'ok':'err'}">${esc(result.text)}</div>`:''}
    <div class="grid2">
      <div class="item"><div class="d">Repository</div><b>${esc(repositoryName)}</b></div>
      <div class="item"><div class="d">Visibility</div><b>${esc(visibility)}</b></div>
      <div class="item"><div class="d">Contents</div><b>${fileCount} files · ${workflowCount} workflows</b></div>
    </div>
    <details style="margin-top:12px"><summary>Export details</summary>
      <label>Manifest fingerprint</label><code style="word-break:break-all">${esc(fingerprint)}</code>
      <div class="d" style="margin-top:8px">Preview expires ${esc(previewExpiresAt)}</div>
    </details>
    ${previewExpired
      ?`<div class="status err">Repository preview expired. Create a fresh preview before authorizing GitHub.</div>`
      :completed
      ?`<div class="status ok">Repository created. Your development files are ready on main.</div>
        <div class="bar">
          ${repositoryUrl?`<a class="btn primary" href="${esc(repositoryUrl)}" target="_blank" rel="noopener noreferrer">Open repository</a>`:'<span class="d">Repository link unavailable.</span>'}
        </div>
        ${repositoryHandoff(repositoryUrl)?`<pre class="yaml">${esc(repositoryHandoff(repositoryUrl).commands)}</pre>
        <a href="${esc(repositoryHandoff(repositoryUrl).actionsUrl)}" target="_blank" rel="noopener noreferrer">View GitHub Actions</a>`:''}
        <ol><li>Open the checkout in your coding agent and read <code>AGENTS.md</code>.</li>
        <li>Implement the Domain Harness and connect the local Agent adapter.</li>
        <li>Add your dataset and evaluator if deferred, then run the exported tests and evaluation workflow.</li>
        <li>Configure your deployment targets and continue through dev, preprod and human approval for production.</li></ol>
        <p class="d">Repository creation does not deploy an Agent. Deferred evaluation remains unconfigured until you supply the required assets.</p>`
      :github?.configured===true||github?.tokenSupported===true
      ?`<h3>Export to GitHub</h3><p>Create a private repository in your GitHub account using the reviewed files.</p>
        ${github.configured?'<p class="d">Continue to GitHub to authorize this export. The temporary OAuth token is revoked after delivery.</p>':
        '<label for="delivery-token">GitHub access token</label><input id="delivery-token" data-delivery-token type="password" autocomplete="off" spellcheck="false" placeholder="Classic token with repo and workflow permissions"/><p class="d">Used for this export only; never saved or included in files. Repo and workflow permissions allow access to your repositories. <a href="https://github.com/settings/tokens/new?scopes=repo,workflow" target="_blank" rel="noopener noreferrer">Create a GitHub token</a>. Revoke it in GitHub when no longer needed.</p>'}
        <label>Type <code>${esc(expected)}</code> to confirm</label>
        <input data-delivery-confirmation data-demo-assist-field="deliveryConfirmation" data-demo-assist-explicit-choice="${esc(expected)}" data-demo-assist-placeholder="Select the exact repository name to approve" value="" autocomplete="off"/>
        <label style="display:flex;gap:8px;align-items:flex-start"><input type="checkbox" data-delivery-private-ack style="width:auto"/> I acknowledge this creates a private GitHub repository.</label>
        ${recovering?`<div class="status info">Delivery is incomplete at ${esc(latestCheckpoint)}. Resume will continue from the persisted checkpoints.</div>`:''}
        <button class="primary" data-delivery-approve disabled>Export to GitHub</button>`
      :`<p class="d">GitHub export is unavailable. Ask your platform administrator to enable a GitHub connection.</p>`}
    ${!previewExpired?`<details style="margin-top:16px"><summary>Alternative: download a copy</summary><div class="bar"><button class="ghost" data-delivery-download>Download project (.zip)</button></div><p role="status" data-delivery-download-status></p></details>`:''}
  </div>`
}
function renderHostedBuild(){
  const box=document.getElementById('hostedbuild');if(!box)return
  if(!S.hostedBuildJourney){
    box.innerHTML=`${hostedBuildLanding()}${hostedDeliveryCard()}`
    wireHostedBuild()
    applyDemoAssistToHostedView()
    return
  }
  if(S.hostedBuildJourney==='scratch'){
    box.innerHTML=`${S.hostedBuildMessage?`<div class="status ${S.hostedBuildMessage.ok?'ok':'err'}">${esc(S.hostedBuildMessage.text)}</div>`:''}${hostedMinimalJourney()}`
    wireHostedBuild()
    applyDemoAssistToHostedView()
    return
  }
  if(S.hostedBuildJourney==='plato'){
    box.innerHTML=`${S.hostedBuildMessage?`<div class="status ${S.hostedBuildMessage.ok?'ok':'err'}">${esc(S.hostedBuildMessage.text)}</div>`:''}${hostedSpecJourney()}`
    wireHostedBuild()
    applyDemoAssistToHostedView()
    return
  }
  if(!S.hostedBuildLoaded){
    box.innerHTML='<div class="empty"><span class="spin">⟳</span> loading the governed Agent workspace…</div>'
    return
  }
  const projects=S.hostedBuildProjects||[]
  const agents=S.hostedBuildAgents||[]
  const pendingShared=(S.hostedBuildSharedResources||[])
    .filter(resource=>resource.granted!==true).length
  if(!projects.length){
    box.innerHTML='<div class="empty">No project is available in this authorized scope.<div class="bar" style="justify-content:center"><button class="primary" data-hosted-project-create>Create project</button></div></div>'
    wireHostedBuild()
    applyDemoAssistToHostedView()
    return
  }
  let form
  try{
    form=hostedBuildForm()
    // Bind even an untouched initial default to its original project.
    S.hostedBuildForm={...(S.hostedBuildForm||{}),projectKey:form.projectKey}
  }catch{
    box.innerHTML='<div class="status err">The saved Agent guardrail configuration is invalid. It was not reset. Ask a platform administrator to repair the Agent record.</div>'
    return
  }
  const resources=hostedBuildGovernedResources(form.domainId,form.projectId)
  const models=hostedBuildModelsForDomain(form.domainId,form.projectId)
  const selected=agents.find(agent=>hostedResourceKey(agent)===S.hostedBuildAgentKey)
  const canCreate=hostedActionEnabled('createAgent',hostedCaps())
  const canConfigure=hostedActionEnabled('configureAgent',hostedCaps())
  const canTest=hostedActionEnabled('testAgent',hostedCaps())
  const canSandbox=hostedActionEnabled('deploySandbox',hostedCaps())
  const canProduction=hostedActionEnabled('submitProductionDeployment',hostedCaps())
  const canPublish=hostedActionEnabled('publishAgent',hostedCaps())
  const canConfigureSelected=selected?.status==='DRAFT'
  const canTestSelected=['READY_FOR_TEST','TEST_FAILED'].includes(selected?.status)
  const canSandboxSelected=['TESTED','SANDBOX_DEPLOYED'].includes(selected?.status)
  const canProductionSelected=['TESTED','SANDBOX_DEPLOYED','PRODUCTION_PENDING'].includes(selected?.status)
  const canPreviewSelected=['TESTED','SANDBOX_DEPLOYED','PRODUCTION_PENDING','PRODUCTION_APPROVED','PRODUCTION_DEPLOYED','REJECTED'].includes(selected?.status)
  const publication=hostedBuildRegistryPublication(selected)
  const registryStatus=publication?.record?.status||'NOT_SUBMITTED'
  const approvalStatus=publication?.approval?.status||'NOT_REQUESTED'
  const canPublishSelected=hostedBuildPublicationCanSubmit(
    selected?.status,
    registryStatus,
  )
  const publicationHint=!selected
    ?'Create and select an Agent to begin the Registry publication lifecycle.'
    :!canPublishSelected&&registryStatus==='NOT_SUBMITTED'
    ?'Run a successful test before submitting this Agent to AI Registry.'
    :registryStatus==='DRAFT'
    ?'This Agent has a Registry draft and can now be submitted for domain approval.'
    :registryStatus==='PENDING_APPROVAL'||approvalStatus==='PENDING'
    ?'Domain approval is pending. Open AI Registry or Approvals to track it.'
    :'The Registry lifecycle is shown here and remains enforced server-side.'
  const blueprintResources=resources.filter(resource=>resource.field==='blueprintIds')
  const options=form.buildOptions
    box.innerHTML=`${S.hostedBuildMessage?`<div class="status ${S.hostedBuildMessage.ok?'ok':'err'}">${esc(S.hostedBuildMessage.text)}</div>`:''}
  <div class="bar" style="margin-bottom:4px"><button class="ghost" data-hosted-journey-back>← All journeys</button></div>
  <div class="card"><div class="sec-h" style="margin-top:0">Agent workspace</div>
    <p class="d">FULL preset: create, configure and test a real hosted Agent before producing runnable AgentCore source.</p>
    <div class="meta" style="margin-bottom:12px">
      <span class="chip">1 Create draft</span>
      <span class="chip">2 Save configuration</span>
      <span class="chip">3 Run test</span>
      <span class="chip">4 Submit to AI Registry</span>
    </div>
    <div class="grid2">
      <div><label style="margin-top:0">Existing agent</label><select id="hbexisting"><option value="">New agent</option>${agents.map(agent=>`<option value="${esc(hostedResourceKey(agent)||'')}" ${hostedResourceKey(selected)===hostedResourceKey(agent)?'selected':''}>${esc(agent.name||agent.id)} · ${esc(agent.projectId)} · ${esc(agent.status)}</option>`).join('')}</select></div>
      <div><label style="margin-top:0">Project</label><select id="hbproject"><option value="${form.projectId?'':esc(form.projectKey)}" ${form.projectId?'':'selected'}>${form.projectKey&&!form.projectId?'Previous project unavailable — choose a project':'Choose a project'}</option>${projects.map(project=>`<option value="${esc(project.domainId+'/'+project.id)}" ${form.projectKey===project.domainId+'/'+project.id?'selected':''}>${esc(project.name||project.id)} · ${esc(project.domainId)}</option>`).join('')}</select></div>
      <div><label>Agent ID</label><input id="hbid" data-demo-assist-field="agentId" maxlength="48" value="${esc(form.id)}" placeholder="case-triage-agent"/></div>
      <div><label>Name</label><input id="hbname" data-demo-assist-field="agentName" maxlength="128" value="${esc(form.name)}" placeholder="Case Triage Agent"/></div>
    </div>
    <label>Description</label><input id="hbdescription" data-demo-assist-field="agentDescription" maxlength="4096" value="${esc(form.description)}" placeholder="What this agent does"/>
    <label>Project model</label><select id="hbmodel"><option value="">Select a project model</option>${models.map(model=>`<option value="${esc(model.id)}" ${form.modelId===model.id?'selected':''}>${esc(model.name||model.id)}</option>`).join('')}</select>
    <label>Approved Blueprint</label><select id="hbblueprint"><option value="">Select one approved Blueprint</option>${blueprintResources.map(resource=>`<option value="${esc(resource.id)}" ${form.blueprintId===resource.id?'selected':''}>${esc(resource.label)}</option>`).join('')}</select>
    ${models.length?'':'<div class="status info">No model is enabled for this project.</div>'}
    ${form.modelId&&!(models.find(model=>model.id===form.modelId)?.accessByDomain?.[form.domainId]||models.find(model=>model.id===form.modelId)?.access)?.usable?'<p class="status info">This model is selected for development. Runtime access and quotas must be configured before testing or deployment.</p>':''}
    ${S.hostedBuildSharedUnavailable?'<div class="status info">Shared resource discovery is temporarily unavailable. You can still build with resources already approved for this domain.</div>':''}
    <div class="grid2">
      ${hostedBuildResourcePicker(resources,'toolIds','Tools',form.toolIds)}
      ${hostedBuildResourcePicker(resources,'mcpServerIds','MCP servers',form.mcpServerIds)}
      ${hostedBuildResourcePicker(resources,'skillIds','Skills',form.skillIds)}
      <div><label>Memory IDs</label><input id="hbmemory" data-demo-assist-field="memoryIds" value="${esc(form.memoryIds)}" placeholder="comma-separated approved IDs"/></div>
      <div><label>Knowledge base IDs</label><input id="hbkb" data-demo-assist-field="knowledgeBaseIds" value="${esc(form.knowledgeBaseIds)}" placeholder="comma-separated approved IDs"/></div>
    </div>
    <label>Agent instructions</label><textarea id="hbinstructions" data-demo-assist-field="agentInstructions" maxlength="16384" style="min-height:110px">${esc(form.instructions)}</textarea>
    <div class="grid2">
      <div><label>Temperature (optional)</label><input id="hbtemperature" data-demo-assist-field="modelTemperature" type="number" min="0" max="1" step="0.1" value="${form.temperature===null?'':esc(form.temperature)}"/></div>
      <div><label>Max output tokens (optional)</label><input id="hbmaxtokens" data-demo-assist-field="modelMaxTokens" type="number" min="1" max="4096" step="1" value="${form.maxTokens===null?'':esc(form.maxTokens)}"/></div>
    </div>
    ${options?`<div class="item" style="margin-top:12px"><b>Blueprint build options</b><div class="meta" style="margin-top:8px">
      <span class="chip">${esc(options.framework)}</span><span class="chip">${esc(options.deployTarget)}</span><span class="chip">${esc(options.memory)}</span>
      <span class="chip">streaming ${options.streaming?'on':'off'}</span><span class="chip">identity ${options.identity?'on':'off'}</span><span class="chip">guardrails ${options.guardrails?'on':'off'}</span>
    </div></div>${hostedGuardrailChainHtml(form.guardrailChain)}`:'<div class="status info">Select a supported approved Blueprint to load its exact build options.</div>'}
    ${pendingShared?`<div class="status info">${pendingShared} shared ${pendingShared===1?'resource requires':'resources require'} approval before selection. Use Resource Governance to request access.</div>`:''}
    <div class="bar" style="margin-top:12px">
      ${canCreate?`<button class="primary" id="hbcreate" ${form.projectId?'':'disabled'}>Create draft</button>`:''}
      ${canConfigure?`<button class="ghost" id="hbconfigure" ${canConfigureSelected&&form.projectId?'':'disabled'}>Save configuration</button>`:''}
    </div>
  </div>
  <div class="card"><div class="sec-h" style="margin-top:0">Test and hand off</div>
    <label style="margin-top:0">Test prompt</label><textarea id="hbprompt" data-demo-assist-field="agentPrompt" style="min-height:90px">${esc(form.prompt)}</textarea>
    <div class="bar" style="margin-top:12px">
      ${canTest?`<button class="ghost" id="hbtest" ${canTestSelected?'':'disabled'}>Run test</button>`:''}
      ${canSandbox?`<button class="ghost" id="hbsandbox" ${canSandboxSelected?'':'disabled'}>Deploy sandbox</button>`:''}
      ${canProduction?`<button class="ghost" id="hbproduction" ${canProductionSelected?'':'disabled'}>Submit production</button>`:''}
    </div>
    <div class="item" style="margin-top:12px">
      <b>AI Registry publication</b>
      <div class="grid3" style="margin-top:10px">
        <div><div class="d">Target domain</div><b>${esc(selected?.domainId||form.domainId||'Not selected')}</b></div>
        <div><div class="d">Registry status</div>${hostedStatus(registryStatus)}</div>
        <div><div class="d">Approval status</div>${hostedStatus(approvalStatus)}</div>
      </div>
      <p class="d" style="margin-top:10px">${esc(publicationHint)}</p>
      <div class="bar" style="margin-top:10px">
        ${canPublish?`<button class="primary" id="hbpublish" ${canPublishSelected?'':'disabled'}>Submit to AI Registry</button>`:''}
        ${publication?'<button class="ghost" data-hosted-registry-open>Open AI Registry</button>':''}
      </div>
    </div>
    <label>Repository name</label><input id="hbgrepo" data-demo-assist-field="repositoryName" maxlength="100" value="${esc(form.repositoryName)}" placeholder="release-coordinator"/>
    <div class="bar"><button class="primary" id="hbpreview" ${canPreviewSelected?'':'disabled'}>Preview runnable repository</button></div>
  </div>
  ${hostedDeliveryCard()}`
  wireHostedBuild()
  applyDemoAssistToHostedView()
}
async function loadHostedGitHubConfiguration(){
  if(S.hostedBuildGitHub)return
  try{
    const result=await api('/delivery/github')
    S.hostedBuildGitHub={configured:result?.github?.configured===true,tokenSupported:result?.github?.tokenSupported===true}
  }catch(error){
    if(error===CANCELED_REQUEST)return
    S.hostedBuildGitHub={configured:false}
  }
  renderHostedBuild()
}
async function loadHostedBuild(){
  const box=document.getElementById('hostedbuild');if(!box)return
  await loadHostedGitHubConfiguration()
  try{
    const [projects,agents,gateway,registry,approvals]=await Promise.all([
      hostedCollectionRequest('projects'),
      hostedCollectionRequest('agents'),
      api('/ai-gateway'),
      api('/registry'),
      hostedCollectionRequest('approvals'),
    ])
    if(gateway?.ok!==true||gateway?.source!=='aws'||!Array.isArray(gateway.models)){
      throw new Error('AI Gateway model catalog could not be loaded.')
    }
    if(registry?.ok!==true||registry?.source!=='aws'||!Array.isArray(registry.entries)){
      throw new Error('Registry inventory could not be loaded.')
    }
    const platformOnly=hostedCaps().includes('usePlatformBuilderWorkspace')
      && !hostedCaps().includes('useDomainBuilderWorkspace')
    S.hostedBuildProjects=activeBuildProjects(projects,platformOnly?'platform':undefined)
    S.hostedBuildAgents=platformOnly
      ? agents.filter(agent=>agent.domainId==='platform')
      : agents
    S.hostedBuildModels=gateway.models
    S.hostedBuildCatalogDomain=activeDomain()
    S.hostedBuildCatalogPolicyApplied=registry.domainResourcePolicyApplied===true
    S.hostedBuildCatalogModelIds=foundationCatalog(registry,{displayOnly:true}).models.map(entry=>entry.ref.id)
    S.hostedBuildRegistryEntries=registry.entries.filter(entry=>
      ['Skill','MCPServer','Blueprint'].includes(entry.type)
      && approvedHostedEntries(registry.entries,entry.type).includes(entry))
    S.hostedBuildAgentRegistryEntries=registry.entries.filter(entry=>
      ['Agent','A2AAgent'].includes(entry.type))
    S.hostedBuildApprovals=approvals
    S.hostedBuildSharedResources=[]
    S.hostedBuildSharedUnavailable=false
    S.hostedBuildLoaded=true
    if(S.hostedBuildAgentKey&&!S.hostedBuildAgents.some(agent=>hostedResourceKey(agent)===S.hostedBuildAgentKey)){
      S.hostedBuildAgentKey=''
    }
    renderHostedBuild()
    if(!hostedActionEnabled('discoverSharedResources',hostedCaps()))return
    const shared=await api('/governance/shared-resources?limit=50')
    if(shared===CANCELED_REQUEST)return
    if(shared?.ok!==true||!Array.isArray(shared.items)){
      S.hostedBuildSharedUnavailable=true
      renderHostedBuild()
      return
    }
    S.hostedBuildSharedResources=shared.items
    renderHostedBuild()
  }catch(error){
    if(error===CANCELED_REQUEST)return
    S.hostedBuildLoaded=false
    hostedRetryState(box,'Build workspace',loadHostedBuild)
  }
}
function readHostedBuildForm(){
  const value=id=>document.getElementById(id)?.value||''
  const selected=field=>[...document.querySelectorAll(`[data-hbresource][data-field="${field}"]:checked`)]
    .map(control=>control.value)
  const projectKey=value('hbproject')
  const project=(S.hostedBuildProjects||[]).find(item=>`${item.domainId}/${item.id}`===projectKey)
  return {
    projectKey,
    domainId:project?.domainId||'',
    projectId:project?.id||'',
    id:value('hbid').trim(),
    name:value('hbname').trim(),
    description:value('hbdescription').trim(),
    modelId:value('hbmodel'),
    toolIds:selected('toolIds'),
    mcpServerIds:selected('mcpServerIds'),
    skillIds:selected('skillIds'),
    blueprintId:value('hbblueprint'),
    blueprintIds:value('hbblueprint')?[value('hbblueprint')]:[],
    memoryIds:value('hbmemory'),
    knowledgeBaseIds:value('hbkb'),
    instructions:value('hbinstructions').trim(),
    temperature:hostedNullableNumber(value('hbtemperature')),
    maxTokens:hostedNullableNumber(value('hbmaxtokens'),{integer:true}),
    buildOptions:hostedBuildOptions(value('hbblueprint')),
    guardrailChain:hostedReadGuardrailChain(),
    repositoryName:value('hbgrepo').trim(),
    prompt:value('hbprompt').trim(),
    // Unavailable controls cannot erase the retained draft configuration.
    ...(!project?Object.fromEntries(['modelId','toolIds','mcpServerIds','skillIds','blueprintId','blueprintIds','buildOptions','guardrailChain']
      .filter(key=>Object.hasOwn(S.hostedBuildForm||{},key))
      .map(key=>[key,S.hostedBuildForm[key]])):{}),
  }
}
function hostedBuildPayload(form){
  return {
    domainId:form.domainId,
    projectId:form.projectId,
    id:form.id,
    name:form.name,
    description:form.description,
    modelId:form.modelId,
    toolIds:hostedIdList(form.toolIds),
    mcpServerIds:hostedIdList(form.mcpServerIds),
    skillIds:hostedIdList(form.skillIds),
    blueprintIds:hostedIdList(form.blueprintIds),
    memoryIds:hostedCsv(form.memoryIds),
    knowledgeBaseIds:hostedCsv(form.knowledgeBaseIds),
    buildConfig:{
      instructions:form.instructions,
      modelParameters:{temperature:form.temperature,maxTokens:form.maxTokens},
      buildOptions:{...form.buildOptions},
      guardrailChain:form.guardrailChain.map(entry=>({...entry})),
    },
  }
}
async function runHostedBuildAction(action){
  if(action==='publishAgent'){
    const selected=(S.hostedBuildAgents||[]).find(agent=>
      hostedResourceKey(agent)===S.hostedBuildAgentKey)
    if(!selected||!hostedActionEnabled('publishAgent',hostedCaps())){
      S.hostedBuildMessage={ok:false,text:'Select a tested Agent before submitting it to AI Registry.'}
      renderHostedBuild()
      return
    }
    const result=await api('/governance/agent-publications',{
      domainId:selected.domainId,
      projectId:selected.projectId,
      agentId:selected.id,
    },{requestId:createRequestId()})
    if(result?.ok===true){
      const key=hostedBuildPublicationKey(selected)
      S.hostedBuildRegistryPublications[key]={
        record:result.record,
        approval:result.approval,
        entryId:result.record?.resourceId,
      }
      S.hostedBuildMessage={
        ok:true,
        text:'The tested Agent was submitted to AI Registry for domain approval.',
      }
      await loadHostedBuild()
      return
    }
    S.hostedBuildMessage={ok:false,text:apiErrorMessage(result,'The Agent could not be submitted to AI Registry.')}
    renderHostedBuild()
    return
  }
  const form=readHostedBuildForm()
  S.hostedBuildForm=form
  if(!form.domainId||!form.projectId){
    S.hostedBuildMessage={ok:false,text:'The draft project is unavailable. Explicitly choose an available project before submitting.'}
    renderHostedBuild()
    return
  }
  const payload=hostedBuildPayload(form)
  const approvedModel=hostedBuildModelsForDomain(form.domainId,form.projectId)
    .some(model=>model.id===form.modelId)
  if(!/^[a-z][a-z0-9-]{0,47}$/.test(form.id)||!form.name||!approvedModel
    ||form.blueprintIds.length!==1||!form.instructions||!form.buildOptions
    ||Number.isNaN(form.temperature)||Number.isNaN(form.maxTokens)){
    S.hostedBuildMessage={ok:false,text:'Enter a valid Agent, instructions, approved model, and one supported Blueprint.'}
    renderHostedBuild()
    return
  }
  let result
  if(action==='createAgent'&&hostedActionEnabled('createAgent',hostedCaps())){
    result=await api('/agents',payload,{requestId:createRequestId()})
  }else if(action==='configureAgent'&&hostedActionEnabled('configureAgent',hostedCaps())){
    result=await api('/agents/'+encodeURIComponent(form.id),payload,{requestId:createRequestId(),method:'PUT'})
  }else if(action==='testAgent'&&hostedActionEnabled('testAgent',hostedCaps())){
    result=await api('/agents/'+encodeURIComponent(form.id)+'/test',{
      // 128 = the bounded-Converse ceiling; above it the test is rejected.
      domainId:form.domainId,projectId:form.projectId,prompt:form.prompt,maxTokens:128,
    },{requestId:createRequestId()})
  }else if(action==='deploySandbox'&&hostedActionEnabled('deploySandbox',hostedCaps())){
    result=await api('/deployments/sandbox',{
      domainId:form.domainId,projectId:form.projectId,agentId:form.id,
      deploymentId:hostedDeploymentId(form.id,'sandbox'),
    },{requestId:createRequestId()})
  }else if(action==='submitProductionDeployment'&&hostedActionEnabled('submitProductionDeployment',hostedCaps())){
    result=await api('/deployments/production',{
      domainId:form.domainId,projectId:form.projectId,agentId:form.id,
      deploymentId:hostedDeploymentId(form.id,'production'),
      approvalId:hostedDeploymentId(form.id,'production-approval'),
    },{requestId:createRequestId()})
  }else{
    return
  }
  if(result?.ok===true){
    if(['createAgent','configureAgent'].includes(action)&&result.agent?.domainId===form.domainId&&result.agent?.projectId===form.projectId&&result.agent?.id===form.id)businessForms.clear('build')
    S.hostedBuildAgentKey=hostedResourceKey({
      domainId:result.agent?.domainId||form.domainId,
      projectId:result.agent?.projectId||form.projectId,
      id:result.agent?.id||form.id,
    })
    S.hostedBuildMessage={ok:true,text:action==='submitProductionDeployment'
      ?'Production deployment submitted for domain approval.'
      :'The hosted Agent action completed successfully.'}
    await loadHostedBuild()
    return
  }
  S.hostedBuildMessage={ok:false,text:apiErrorMessage(result,'The hosted workflow action could not be completed.')}
  renderHostedBuild()
}
function wireHostedDeliveryApproval(){
  const delivery=S.hostedBuildDelivery
  const downloadScope=hostedModelReadContext()
  const download=document.querySelector('[data-delivery-download]')
  if(delivery&&download)download.onclick=sessionTaskHandler(async()=>{
    if(download.disabled)return
    download.disabled=true
    const status=document.querySelector('[data-delivery-download-status]')
    try{
      const response=await api('/delivery/'+encodeURIComponent(delivery.id))
      const fresh=response.delivery
      if(response.ok!==true||!fresh?.manifest||fresh.manifest.fingerprint!==delivery.manifest.fingerprint
        ||Date.parse(fresh.previewExpiresAt)<=Date.now())throw new Error('Refresh the repository preview before downloading.')
      const bytes=await repositoryArchive(fresh.manifest)
      if(downloadScope!==hostedModelReadContext()||!download.isConnected)return
      const url=URL.createObjectURL(new Blob([bytes],{type:'application/zip'}))
      const a=document.createElement('a');a.href=url;a.download=delivery.repositoryName+'.zip';a.click()
      setTimeout(()=>URL.revokeObjectURL(url),1000)
      status.textContent='Downloaded the verified project. Start with AGENTS.md and README.md.'
    }catch(error){if(error===CANCELED_REQUEST)throw error;status.textContent=error.message||'Download failed.'}
    finally{if(download.isConnected)download.disabled=false}
  })
  const confirmation=document.querySelector('[data-delivery-confirmation]')
  const acknowledgement=document.querySelector('[data-delivery-private-ack]')
  const button=document.querySelector('[data-delivery-approve]')
  const tokenInput=document.querySelector('[data-delivery-token]')
  if(!delivery||!confirmation||!acknowledgement||!button)return
  const expected=delivery.repositoryName
  const reconcile=()=>{
    button.disabled=!(
      confirmation.value.trim()===expected
      &&acknowledgement.checked===true
      &&(!tokenInput||tokenInput.value.trim().length>=20)
    )
  }
  confirmation.oninput=reconcile
  confirmation.onchange=reconcile
  acknowledgement.onchange=reconcile
  if(tokenInput)tokenInput.oninput=reconcile
  reconcile()
  button.onclick=sessionTaskHandler(async()=>{
    if(button.disabled)return
    button.disabled=true
    button.textContent='Exporting to GitHub…'
    const payload={
      previewId:delivery.id,
      fingerprint:delivery.manifest.fingerprint,
      confirmation:expected,
      acknowledgePrivateRepository:true,
    }
    // Never put user credentials in the draft/retry mutation store.
    let result
    try{
      if(tokenInput){
        const accessToken=tokenInput.value.trim()
        tokenInput.value=''
        result=await api('/delivery/github/authorizations',{...payload,accessToken},{requestId:createRequestId()})
      }else result=await hostedJourneyMutation(
        'github-authorization',
        '/delivery/github/authorizations',
        payload,
      )
    }catch(error){
      if(error===CANCELED_REQUEST)throw error
      // Do not surface transport errors that may contain request details.
      result={ok:false,message:'GitHub export could not be confirmed. Retry this preview to recover the delivery.'}
    }
    if(S.hostedBuildDelivery?.id!==delivery.id)return
    if(result?.ok===true&&result.authorization?.delivery){
      const completed=result.authorization.delivery
      S.hostedBuildDelivery=completed.manifest?.fingerprint===delivery.manifest?.fingerprint
        ?{...completed,manifest:{...completed.manifest,entries:delivery.manifest.entries}}
        :completed
      S.hostedBuildDeliveryResult={ok:true,text:'Exported to GitHub. Clone the repository to continue development.'}
      if(S.view==='compose')render()
      else renderHostedBuild()
    }else if(result?.ok===true&&result.authorization?.url){
      window.location.assign(result.authorization.url)
    }else{
      S.hostedBuildDeliveryResult={ok:false,text:apiErrorMessage(result,'GitHub authorization could not be started. Review the approval and try again.')}
      if(S.view==='compose')render()
      else renderHostedBuild()
    }
  })
}
function wireHostedBuild(){
  document.querySelectorAll('[data-hosted-project-create]').forEach(button=>{
    button.onclick=()=>{
      S.hostedBuildReturnFromProjects=true
      S.view='hostedprojects'
      render()
    }
  })
  document.querySelectorAll('[data-hosted-journey]').forEach(button=>{
    button.onclick=()=>{
      if(!confirmContextChange())return
      businessForms.clear('build')
      S.hostedBuildJourney=button.dataset.hostedJourney
      S.hostedBuildJourneyDraft=null
      S.hostedSpecAgentForm=null
      S.hostedBuildDelivery=null
      S.hostedBuildDeliveryResult=null
      S.hostedBuildMessage=null
      S.hostedBuildLoaded=false
      S.hostedBuildMutationRequests={}
      if(S.hostedBuildJourney==='blueprint'||S.hostedBuildJourney==='plato')runSessionTask(loadHostedBuild)
      else{
        renderHostedBuild()
        runSessionTask(loadHostedGitHubConfiguration)
      }
    }
  })
  document.querySelectorAll('[data-hosted-journey-back]').forEach(button=>{
    button.onclick=()=>{
      if(!confirmContextChange())return
      businessForms.clear('build')
      S.hostedBuildJourney=null
      S.hostedBuildJourneyDraft=null
      S.hostedSpecAgentForm=null
      S.hostedBuildDelivery=null
      S.hostedBuildDeliveryResult=null
      S.hostedBuildMessage=null
      S.hostedBuildMutationRequests={}
      renderHostedBuild()
    }
  })
  const formIds=['hbproject','hbid','hbname','hbdescription','hbmodel','hbblueprint','hbmemory','hbkb','hbinstructions','hbtemperature','hbmaxtokens','hbgrepo','hbprompt']
  for(const id of formIds){
    const control=document.getElementById(id)
    if(control)control.onchange=()=>{
      S.hostedBuildForm=readHostedBuildForm()
      if(id==='hbproject'||id==='hbblueprint')renderHostedBuild()
    }
  }
  document.querySelectorAll('[data-hbresource]').forEach(control=>{
    control.onchange=()=>{S.hostedBuildForm=readHostedBuildForm()}
  })
  document.querySelectorAll('[data-hbguardrail-enabled],[data-hbguardrail-action],[data-hbguardrail-run-mode],[data-hbguardrail-message]').forEach(control=>{
    const save=()=>{S.hostedBuildForm=readHostedBuildForm()}
    control.onchange=save
    if(control.matches('[data-hbguardrail-message]'))control.oninput=save
  })
  document.querySelectorAll('[data-hbguardrail-up],[data-hbguardrail-down]').forEach(button=>{
    button.onclick=()=>{
      const row=button.closest('[data-hbguardrail]')
      const chain=hostedReadGuardrailChain()
      const index=chain.findIndex(entry=>entry.id===row?.dataset.hbguardrail)
      const target=button.matches('[data-hbguardrail-up]')?index-1:index+1
      if(index<0||target<0||target>=chain.length)return
      ;[chain[index],chain[target]]=[chain[target],chain[index]]
      S.hostedBuildForm={
        ...readHostedBuildForm(),
        guardrailChain:chain.map((entry,priority)=>({...entry,priority})),
      }
      renderHostedBuild()
    }
  })
  const existing=document.getElementById('hbexisting')
  if(existing)existing.onchange=()=>{
    if(!confirmContextChange()){existing.value=S.hostedBuildAgentKey;return}
    businessForms.clear('build')
    S.hostedBuildAgentKey=existing.value
    S.hostedBuildForm=null
    renderHostedBuild()
  }
  const actions=[
    ['hbcreate','createAgent'],
    ['hbconfigure','configureAgent'],
    ['hbtest','testAgent'],
    ['hbsandbox','deploySandbox'],
    ['hbproduction','submitProductionDeployment'],
    ['hbpublish','publishAgent'],
  ]
  for(const [id,action] of actions){
    const button=document.getElementById(id)
    if(button)button.onclick=sessionTaskHandler(async()=>{
      button.disabled=true
      await runHostedBuildAction(action)
    })
  }
  const fullPreview=document.getElementById('hbpreview')
  if(fullPreview)fullPreview.onclick=sessionTaskHandler(previewHostedFullJourney)
  const openRegistry=document.querySelector('[data-hosted-registry-open]')
  if(openRegistry)openRegistry.onclick=()=>{
    const selected=(S.hostedBuildAgents||[]).find(agent=>
      hostedResourceKey(agent)===S.hostedBuildAgentKey)
    const publication=hostedBuildRegistryPublication(selected)
    S.registrySearch=publication?.entryId||selected?.id||''
    S.registryFilterType='All'
    S.registryPage=0
    S.registryDrawerId=publication?.entryId||null
    S.view='registry'
    render()
  }
  const minimalPreview=document.getElementById('hminimalpreview')
  if(minimalPreview)minimalPreview.onclick=sessionTaskHandler(runHostedMinimalJourney)
  for(const [id,action] of [
    ['hspecstart','start'],
    ['hspecsend','message'],
    ['hspeccontract','contract'],
    ['hspecagent','agent'],
  ]){
    const button=document.getElementById(id)
    if(button)button.onclick=sessionTaskHandler(()=>runHostedSpecAction(action))
  }
  for(const id of ['hspecproject','hspecmodel','hspecblueprint']){
    const control=document.getElementById(id)
    if(control)control.onchange=()=>{
      const value=control.value
      const saved=S.hostedSpecAgentForm||{}
      if(id==='hspecproject')S.hostedSpecAgentForm={...saved,projectKey:value,modelId:''}
      if(id==='hspecmodel')S.hostedSpecAgentForm={...saved,modelId:value}
      if(id==='hspecblueprint')S.hostedSpecAgentForm={...saved,blueprintId:value}
      renderHostedBuild()
    }
  }
  const specContinue=document.getElementById('hspeccontinue')
  if(specContinue)specContinue.onclick=()=>{
    S.hostedBuildJourney='blueprint'
    S.hostedBuildForm=null
    S.hostedBuildDelivery=null
    renderHostedBuild()
  }
  wireHostedDeliveryApproval()
}
function vHostedOverview(){
  return `<h1>Experience overview</h1>
  <p class="subtitle">Your entitled agents, recent sessions, and access requests from the hosted platform.</p>
  <div id="hostedoverview"><div class="empty"><span class="spin">⟳</span> loading your experience…</div></div>`
}
async function loadHostedOverview(){
  const box=document.getElementById('hostedoverview');if(!box)return
  try{
    const [agents,sessions,requests]=await Promise.all([
      api('/experience/agents'),
      api('/experience/sessions'),
      api('/experience/access-requests'),
    ])
    if(
      agents?.ok!==true||!Array.isArray(agents.items)
      ||sessions?.ok!==true||!Array.isArray(sessions.items)
      ||requests?.ok!==true||!Array.isArray(requests.items)
    ){
      throw new Error('Experience overview could not be loaded.')
    }
    const pending=requests.items.filter(item=>item.status==='PENDING').length
    const completed=sessions.items.filter(item=>item.status==='COMPLETED').length
    box.innerHTML=`<div class="grid3">
      <article class="item"><h4>${ic2(ICONS.agents)}Approved agents available</h4><div style="font-size:2rem;font-weight:600">${agents.items.length}</div><p class="d">Agents you can invoke now.</p></article>
      <article class="item"><h4>${ic2(ICONS.chat)}Sessions</h4><div style="font-size:2rem;font-weight:600">${sessions.items.length}</div><p class="d">${completed} completed session${completed===1?'':'s'}.</p></article>
      <article class="item"><h4>${ic2(ICONS.clipboard)}Access requests</h4><div style="font-size:2rem;font-weight:600">${requests.items.length}</div><p class="d">${pending} awaiting domain approval.</p></article>
    </div>`
  }catch(error){
    if(error===CANCELED_REQUEST)return
    hostedRetryState(box,'Experience overview',loadHostedOverview)
  }
}
function vApprovedAgents(){
  return `<h1>Approved agents</h1>
  <p class="subtitle">Discover entitled agents, invoke them, continue a session, and submit feedback or support requests through the hosted experience APIs.</p>
  <div id="approvedagents"><div class="empty"><span class="spin">⟳</span> loading approved agents…</div></div>`
}
function renderApprovedAgentsUnavailable(box){
  box.innerHTML='<div class="empty" role="status">The approved agent catalog is temporarily unavailable. <button class="ghost" id="approvedagentsretry">Retry</button></div>'
  const retry=box.querySelector('#approvedagentsretry')
  if(retry)retry.onclick=()=>{
    box.innerHTML='<div class="empty"><span class="spin">⟳</span> loading approved agents…</div>'
    runSessionTask(loadApprovedAgents)
  }
}
async function loadApprovedAgents(){
  const box=document.getElementById('approvedagents');if(!box)return
  try{
    const result=await api('/experience/agents')
    if(
      result?.ok!==true
      ||!Array.isArray(result.items)
      ||!Array.isArray(result.requestableItems)
    ){
      renderApprovedAgentsUnavailable(box)
      return
    }
    S.hostedExperienceAgents=result.items
    S.hostedRequestableAgents=result.requestableItems
    if(!result.items.some(agent=>agent.id===S.hostedSelectedAgentId)){
      S.hostedSelectedAgentId=result.items[0]?.id||''
      S.hostedExperienceResult=null
    }
    renderApprovedAgents()
  }catch(error){
    if(error===CANCELED_REQUEST)return
    renderApprovedAgentsUnavailable(box)
  }
}
function renderApprovedAgents(){
  const box=document.getElementById('approvedagents');if(!box)return
  const agents=S.hostedExperienceAgents||[]
  const selected=agents.find(agent=>agent.id===S.hostedSelectedAgentId)||agents[0]
  const result=S.hostedExperienceResult
  const canInvoke=hostedActionEnabled('invokeEntitledAgent',hostedCaps())
  const canFeedback=hostedActionEnabled('submitAgentFeedback',hostedCaps())
  const canIssue=hostedActionEnabled('reportAgentIssue',hostedCaps())
  const canRequest=hostedActionEnabled('requestAgentAccess',hostedCaps())
  const requestable=S.hostedRequestableAgents||[]
  box.innerHTML=`${S.hostedExperienceMessage?`<div class="status ${S.hostedExperienceMessage.ok?'ok':'err'}">${esc(S.hostedExperienceMessage.text)}</div>`:''}
  ${agents.length?`<div class="grid3">${agents.map(agent=>`<article class="item approvedagent">
    <h4>${ic2(ICONS.agents)}${esc(agent.name||agent.id)}</h4>
    <div class="meta">${regStatusBadge('APPROVED')}</div>
    <p class="d" style="margin-top:8px">${esc(agent.description||'Approved for use through the platform.')}</p>
    <button class="${agent.id===selected?.id?'primary':'ghost'} hostedagentselect" data-agent="${esc(agent.id)}" style="margin-top:10px">${agent.id===selected?.id?'Selected':'Use agent'}</button>
  </article>`).join('')}</div>`:'<div class="empty">No entitled agents are available yet.</div>'}
  ${selected?`<section class="card"><div class="sec-h" style="margin-top:0">Invoke ${esc(selected.name||selected.id)}</div>
    <label style="margin-top:0">Prompt</label><textarea id="hexperienceprompt" data-demo-assist-field="experiencePrompt" maxlength="16384" style="min-height:110px">${esc(S.hostedExperiencePrompt||'')}</textarea>
    <div class="bar"><button class="primary" id="hexperienceinvoke" ${canInvoke?'':'disabled'}>${ic2(ICONS.chat)}Invoke agent</button></div>
    ${result&&result.agentId===selected.id?`<div class="status ${result.ok?'ok':'err'}">${result.ok?`<b>Response</b><div style="margin-top:8px;white-space:pre-wrap">${esc(result.output)}</div><div class="d" style="margin-top:8px">Session <code>${esc(result.sessionId)}</code></div>`:esc(result.error)}</div>`:''}
  </section>`:''}
  ${result?.ok&&result.agentId===selected?.id?`<div class="grid2">
    <section class="card"><div class="sec-h" style="margin-top:0">Feedback</div>
      <label style="margin-top:0">Rating</label><select id="hexperiencerating">${[5,4,3,2,1].map(value=>`<option value="${value}">${value}</option>`).join('')}</select>
      <label>Comment</label><textarea id="hexperiencecomment" data-demo-assist-field="experienceFeedbackComment" maxlength="2048"></textarea>
      <button class="ghost" id="hexperiencefeedback" ${canFeedback?'':'disabled'}>Submit feedback</button>
    </section>
    <section class="card"><div class="sec-h" style="margin-top:0">Report an issue</div>
      <label style="margin-top:0">Description</label><textarea id="hexperienceissue" data-demo-assist-field="experienceIssueDescription" maxlength="4096"></textarea>
      <button class="ghost" id="hexperienceissuebutton" ${canIssue?'':'disabled'}>Report issue</button>
    </section>
  </div>`:''}
  ${canRequest?`<section class="card"><div class="sec-h" style="margin-top:0">Request agent access</div>
    <p class="d">Choose an approved production agent. The request goes directly to its owning domain for approval.</p>
    ${requestable.length?`<div class="grid3">${requestable.map(agent=>`<article class="item">
      <h4>${ic2(ICONS.agents)}${esc(agent.name||agent.id)}</h4>
      <div class="meta"><span class="chip">${esc(agent.domainId)}</span>${regStatusBadge('APPROVED')}</div>
      <p class="d" style="margin-top:8px">${esc(agent.description||'Approved production agent')}</p>
      <label>Reason</label><input data-requestable-reason="${esc(agent.id)}" data-demo-assist-field="requestableAgentReason" maxlength="2048" placeholder="Why access is required"/>
      <button class="ghost hostedrequestableagent" data-requestable-agent="${esc(agent.id)}" style="margin-top:10px">Request access</button>
    </article>`).join('')}</div>`:'<div class="empty">No additional approved agents are available to request.</div>'}
  </section>`:''}`
  wireApprovedAgents()
  applyDemoAssistToHostedView()
}
async function invokeApprovedAgent(){
  if(!hostedActionEnabled('invokeEntitledAgent',hostedCaps()))return
  const agent=(S.hostedExperienceAgents||[]).find(item=>item.id===S.hostedSelectedAgentId)
  const promptText=document.getElementById('hexperienceprompt')?.value.trim()||''
  if(!agent||!promptText){
    S.hostedExperienceMessage={ok:false,text:'Select an agent and enter a prompt.'}
    renderApprovedAgents()
    return
  }
  S.hostedExperiencePrompt=promptText
  const body={agentId:agent.id,prompt:promptText}
  if(S.hostedExperienceResult?.ok&&S.hostedExperienceResult.agentId===agent.id){
    body.sessionId=S.hostedExperienceResult.sessionId
  }
  const result=await api('/experience/invocations',body,{requestId:createRequestId()})
  S.hostedExperienceResult=result?.ok===true
    ?{...result,agentId:agent.id}
    :{ok:false,agentId:agent.id,error:apiErrorMessage(result,'The agent invocation failed.')}
  S.hostedExperienceMessage=null
  if(result?.ok===true)businessForms.clear('experiencePrompt')
  renderApprovedAgents()
}
async function submitApprovedAgentFeedback(){
  if(!hostedActionEnabled('submitAgentFeedback',hostedCaps())||!S.hostedExperienceResult?.ok)return
  const result=await api('/experience/feedback',{
    agentId:S.hostedExperienceResult.agentId,
    sessionId:S.hostedExperienceResult.sessionId,
    rating:Number(document.getElementById('hexperiencerating')?.value||5),
    comment:document.getElementById('hexperiencecomment')?.value.trim()||'',
  },{requestId:createRequestId()})
  S.hostedExperienceMessage=result?.ok===true
    ?{ok:true,text:'Feedback recorded.'}
    :{ok:false,text:apiErrorMessage(result,'Feedback could not be recorded.')}
  if(result?.ok===true)businessForms.clear('experienceFeedback')
  renderApprovedAgents()
}
async function reportApprovedAgentIssue(){
  if(!hostedActionEnabled('reportAgentIssue',hostedCaps())||!S.hostedExperienceResult?.ok)return
  const description=document.getElementById('hexperienceissue')?.value.trim()||''
  if(!description){
    S.hostedExperienceMessage={ok:false,text:'Describe the issue before submitting it.'}
    renderApprovedAgents()
    return
  }
  const result=await api('/experience/issues',{
    agentId:S.hostedExperienceResult.agentId,
    sessionId:S.hostedExperienceResult.sessionId,
    description,
  },{requestId:createRequestId()})
  S.hostedExperienceMessage=result?.ok===true
    ?{ok:true,text:'Issue recorded for follow-up.'}
    :{ok:false,text:apiErrorMessage(result,'The issue could not be recorded.')}
  if(result?.ok===true)businessForms.clear('experienceIssue')
  renderApprovedAgents()
}
async function requestApprovedAgentAccess(button){
  if(!hostedActionEnabled('requestAgentAccess',hostedCaps()))return
  const agent=(S.hostedRequestableAgents||[]).find(item=>item.id===button.dataset.requestableAgent)
  const reason=document.querySelector(`[data-requestable-reason="${CSS.escape(button.dataset.requestableAgent||'')}"]`)?.value.trim()||''
  if(!agent||!reason){
    S.hostedExperienceMessage={ok:false,text:'Choose an approved agent and enter an access reason.'}
    renderApprovedAgents()
    return
  }
  const result=await api('/experience/access-requests',{
    domainId:agent.domainId,
    agentId:agent.id,
    reason,
  },{requestId:createRequestId()})
  S.hostedExperienceMessage=result?.ok===true
    ?{ok:true,text:'Agent access request submitted.'}
    :{ok:false,text:apiErrorMessage(result,'Access could not be requested.')}
  if(result?.ok===true)businessForms.clear('experienceAccess')
  renderApprovedAgents()
}
function wireApprovedAgents(){
  document.querySelectorAll('.hostedagentselect').forEach(button=>{
    button.onclick=()=>{
      S.hostedSelectedAgentId=button.dataset.agent
      S.hostedExperienceResult=null
      S.hostedExperienceMessage=null
      renderApprovedAgents()
    }
  })
  const invoke=document.getElementById('hexperienceinvoke')
  if(invoke)invoke.onclick=sessionTaskHandler(async()=>{
    invoke.disabled=true
    await invokeApprovedAgent()
  })
  const feedback=document.getElementById('hexperiencefeedback')
  if(feedback)feedback.onclick=sessionTaskHandler(async()=>{
    feedback.disabled=true
    await submitApprovedAgentFeedback()
  })
  const issue=document.getElementById('hexperienceissuebutton')
  if(issue)issue.onclick=sessionTaskHandler(async()=>{
    issue.disabled=true
    await reportApprovedAgentIssue()
  })
  document.querySelectorAll('.hostedrequestableagent').forEach(button=>{
    button.onclick=sessionTaskHandler(async()=>{
      button.disabled=true
      await requestApprovedAgentAccess(button)
    })
  })
}
function vHostedSessions(){
  return `<h1>Sessions</h1>
  <p class="subtitle">Your hosted agent sessions and their latest invocation status.</p>
  <div id="hostedsessions"><div class="empty"><span class="spin">⟳</span> loading sessions…</div></div>`
}
function hostedSessionTime(value){
  const time=Date.parse(value)
  return Number.isFinite(time)?new Date(time).toLocaleString():String(value||'—')
}
async function loadHostedSessions(){
  const box=document.getElementById('hostedsessions');if(!box)return
  try{
    const result=await api('/experience/sessions')
    if(result?.ok!==true||!Array.isArray(result.items)){
      throw new Error('Sessions could not be loaded.')
    }
    box.innerHTML=result.items.length?`<div class="grid2">${result.items.map(session=>`<article class="item">
      <h4>${ic2(ICONS.chat)}${esc(session.id)} ${hostedStatus(session.status)}</h4>
      <div class="meta"><span class="chip">${esc(session.agentId)}</span>${hostedStatus(session.lastInvocationStatus)}</div>
      <p class="d" style="margin-top:8px">Updated ${esc(hostedSessionTime(session.updatedAt))}</p>
    </article>`).join('')}</div>`:'<div class="empty">No agent sessions have been created yet.</div>'
  }catch(error){
    if(error===CANCELED_REQUEST)return
    hostedRetryState(box,'Sessions',loadHostedSessions)
  }
}
function vHostedAccessRequests(){
  return `<h1>Access requests</h1>
  <p class="subtitle">Track requests sent to an agent's owning domain for approval.</p>
  <div id="hostedaccessrequests"><div class="empty"><span class="spin">⟳</span> loading access requests…</div></div>`
}
async function loadHostedAccessRequests(){
  const box=document.getElementById('hostedaccessrequests');if(!box)return
  try{
    const result=await api('/experience/access-requests')
    if(result?.ok!==true||!Array.isArray(result.items)){
      throw new Error('Access requests could not be loaded.')
    }
    box.innerHTML=result.items.length?result.items.map(request=>`<article class="item" style="margin-bottom:8px">
      <h4>${ic2(ICONS.clipboard)}${esc(request.agentId)} ${hostedStatus(request.status)}</h4>
      <div class="meta"><span class="chip">${esc(request.domainId)}</span><span class="chip">${esc(request.id)}</span></div>
      <p class="d" style="margin-top:8px">${esc(request.reason)}</p>
      <p class="d">Requested ${esc(hostedSessionTime(request.requestedAt))}${request.decidedAt?` · decided ${esc(hostedSessionTime(request.decidedAt))}`:''}</p>
    </article>`).join(''):'<div class="empty">No agent access requests have been submitted yet.</div>'
  }catch(error){
    if(error===CANCELED_REQUEST)return
    hostedRetryState(box,'Access requests',loadHostedAccessRequests)
  }
}
function vRegistry(){
  const hosted=authMode()==='cognito'
  const platformRegistry=hosted
    ? hostedCaps().includes('viewPlatformInventory')
    : hasCap('viewAllDomains')
  const canRegister=!hosted&&hasCap('manageRegistryEntries')
  const registryScopeTag=hosted&&!platformRegistry
    ? '<span class="roletag dom">Domain team · scoped catalog</span>'
    : '<span class="roletag plat">Platform team · control plane</span>'
  const hostedScopedCopy='<span>Discover and share agents, MCP servers, skills, and blueprints across your organization.</span>'
  const hostedScopedStory=storyLine('registry records')
  S.registryFilterType = S.registryFilterType || 'All'
  const modelOnly=S.registryFilterType==='Model'
  return `${modelOnly?'<h1>Amazon Bedrock models</h1>':`${registryScopeTag}<h1>AI Registry</h1>`}
  ${modelOnly?'':`<p class="subtitle">${platformRegistry
    ? 'Discover, publish, and govern agents, MCP servers, skills, and blueprints. Only approved records are discoverable by consumers.'
    : hosted
    ? hostedScopedCopy
    : '<span>Approved and proposed entries, read-only.</span>'}</p>
  ${platformRegistry
    ? storyLine('','governance','Decide in Governance')
    : hosted
    ? hostedScopedStory
    : storyLine('','compose','Use approved parts')}
  ${scopeNote()}`}
  ${!hosted&&S.regWizOpen?`<div id="regwizwrap">${vRegisterWizard()}</div>`:`
  ${!hosted&&S.regWizMsg?`<div class="status ok" style="margin:0 0 14px">${S.regWizMsg}</div>`:''}
  <div class="bar" style="margin:0 0 14px;gap:8px;flex-wrap:wrap;align-items:center" id="regchips">
    ${['All','Agent','A2AAgent','MCPServer','Skill','Blueprint','Model'].map(t=>`<button type="button" class="chip regchip ${S.registryFilterType===t?'type':''}" data-regtype="${t}" aria-pressed="${S.registryFilterType===t}">${t==='All'?'All':(REG_TYPE_ICON[t]?REG_TYPE_ICON[t]+' ':'')+t}</button>`).join('')}
    <select id="regstatusfilter" aria-label="Status filter" style="margin-left:8px;padding:4px 8px;font-size:.78rem">
      ${[['','All statuses'],['DRAFT','Draft'],['PENDING_APPROVAL','Pending approval'],['IN_REVIEW','Pending review'],['APPROVED','Approved'],['REJECTED','Rejected'],['DEPRECATED','Deprecated']].map(([value,label])=>`<option value="${esc(value)}" ${(S.registryStatusFilter||'')===value?'selected':''}>${label}</option>`).join('')}
    </select>
    <input id="regsearch" aria-label="Search registry" placeholder="Search name or description…" value="${esc(S.registrySearch||'')}" style="padding:5px 10px;font-size:.82rem;min-width:200px">
    ${hasCap('manageRegistryEntries')?`<button class="primary" id="regcreatebtn" style="margin-left:auto;padding:6px 16px;font-size:.78rem">Create record</button>`:'<span style="flex:1"></span>'}
  </div>
  <div class="card" id="regbox"><div class="empty"><span class="spin">⟳</span> loading registry…</div></div>
  <div id="regdrawerwrap"></div>
  <div style="margin-top:8px;font-size:.78rem" id="regstore"></div>`}`
}
// 3-step registration wizard: Details → Governance profile → Review & submit.
// Human-initiated only — a Platform Admin fills in the agent's details by
// hand. Client-side only; production posts the record to the registry as a
// DRAFT agent entry.
function vRegisterWizard(){
  S.regWiz = S.regWiz || { step:1, name:'', alias:'', domain:'', risk:'3', dataClass:'Internal', autonomy:'human_in_loop' }
  const w=S.regWiz
  const stepChip=(n,l)=>`<div style="display:flex;align-items:center;gap:8px;padding:6px 0;${w.step===n?'font-weight:700':'color:var(--muted)'}">
    <span class="badge ${w.step>n?'badge-green':w.step===n?'badge-blue':'badge-grey'}" style="min-width:20px;text-align:center">${w.step>n?'✓':n}</span> ${l}</div>`
  const domOpts=(S.domainDirectory||[]).map(x=>`<option value="${esc(x.id)}" ${w.domain===x.id?'selected':''}>${esc(x.name)}</option>`).join('')
  return `<div class="card" id="regwiz"><div class="sec-h" style="margin-top:0">Register agent</div>
  <div style="display:flex;gap:24px">
    <div style="min-width:210px;border-right:1px solid var(--border);padding-right:16px">
      ${stepChip(1,'Details')}${stepChip(2,'Governance profile')}${stepChip(3,'Review & submit')}
    </div>
    <div style="flex:1">
    ${w.step===1?`
      <div class="grid2">
        <div><label style="margin-top:0">Agent name</label><input id="rwname" value="${esc(w.name)}" placeholder="e.g. invoice-parser"/></div>
        <div><label style="margin-top:0">Alias (display name)</label><input id="rwalias" value="${esc(w.alias)}" placeholder="e.g. Invoice Parser"/></div>
      </div>
      <div class="grid2">
        <div><label>Domain</label><select id="rwdomain"><option value="">— select owning domain —</option>${domOpts}</select></div>
        <div></div>
      </div>`
    :w.step===2?`
      <div class="grid2">
        <div><label style="margin-top:0">Risk tier</label><select id="rwrisk">${[1,2,3,4,5].map(n=>`<option value="${n}" ${w.risk==String(n)?'selected':''}>${n} — ${['minimal','low','moderate','high','critical'][n-1]}</option>`).join('')}</select></div>
        <div><label style="margin-top:0">Data classification</label><select id="rwdata">${['Public','Internal','Confidential','Restricted'].map(c=>`<option ${w.dataClass===c?'selected':''}>${c}</option>`).join('')}</select></div>
      </div>
      <div class="grid2">
        <div><label>Autonomy level</label><select id="rwauto">${[['human_in_loop','human_in_loop — a person approves sensitive actions'],['supervised','supervised — humans review after the fact'],['autonomous','autonomous — no routine human gate']].map(([v,l])=>`<option value="${v}" ${w.autonomy===v?'selected':''}>${l}</option>`).join('')}</select></div>
        <div><label>Guardrail profile</label><input value="platform-default-v1 (mandated by risk tier)" disabled/></div>
      </div>`
    :`
      <p class="d" style="color:var(--dim);font-size:.8rem">The record below registers as a <b>DRAFT</b> agent entry — it reaches End Users only after Governance approves it.</p>
      <table style="font-size:.82rem"><tbody>
        <tr><td style="color:var(--muted);padding-right:14px">Name / Alias</td><td><code>${esc(w.name||'—')}</code> · ${esc(w.alias||'—')}</td></tr>
        <tr><td style="color:var(--muted)">Domain</td><td>${w.domain?domChip(w.domain):'—'}</td></tr>
        <tr><td style="color:var(--muted)">Risk tier</td><td><span class="badge ${w.risk>='4'?'badge-red':w.risk==='3'?'badge-blue':'badge-green'}">Risk ${esc(w.risk)}</span></td></tr>
        <tr><td style="color:var(--muted)">Data classification</td><td>${esc(w.dataClass)}</td></tr>
        <tr><td style="color:var(--muted)">Autonomy</td><td><code>${esc(w.autonomy)}</code></td></tr>
      </tbody></table>`}
    <div class="bar" style="margin-top:16px">
      <button class="ghost" id="rwcancel" style="padding:6px 14px;font-size:.78rem">Cancel</button>
      ${w.step>1?'<button class="ghost" id="rwback" style="padding:6px 14px;font-size:.78rem">Previous</button>':''}
      ${w.step<3?'<button class="primary" id="rwnext" style="padding:6px 18px;font-size:.78rem">Next</button>'
                :'<button class="primary" id="rwsubmit" style="padding:6px 18px;font-size:.78rem">Register agent</button>'}
    </div>
    <div id="rwstatus"></div>
    </div></div></div>`
}
function wireRegisterWizard(){
  const wiz=document.getElementById('regwiz')
  if(!wiz)return
  const w=S.regWiz
  const rerender=()=>{
    const box=document.getElementById('regwizwrap')
    if(!box){ render(); return }
    box.innerHTML=vRegisterWizard(); wireRegisterWizard()
  }
  const grab=()=>{
    const g=id=>document.getElementById(id)
    if(g('rwname'))w.name=g('rwname').value.trim()
    if(g('rwalias'))w.alias=g('rwalias').value.trim()
    if(g('rwdomain'))w.domain=g('rwdomain').value
    if(g('rwrisk'))w.risk=g('rwrisk').value
    if(g('rwdata'))w.dataClass=g('rwdata').value
    if(g('rwauto'))w.autonomy=g('rwauto').value
  }
  document.getElementById('rwcancel').onclick=()=>{ if(!confirmContextChange())return;businessForms.clear('registry');S.regWizOpen=false; S.regWiz=null; render() }
  const back=document.getElementById('rwback')
  if(back)back.onclick=()=>{ grab(); w.step--; rerender() }
  const next=document.getElementById('rwnext')
  if(next)next.onclick=()=>{
    grab()
    if(w.step===1&&!w.name){ document.getElementById('rwstatus').innerHTML='<div class="status err">Give the agent a name — the registry entry needs one.</div>'; return }
    if(w.step===1&&!w.domain){ document.getElementById('rwstatus').innerHTML='<div class="status err">Pick the owning domain — an agent without an owner is the problem this registry solves.</div>'; return }
    w.step++; rerender()
  }
  const submit=document.getElementById('rwsubmit')
  if(submit)submit.onclick=()=>{
    S.regWizMsg=`✓ <code>${esc(w.name)}</code> registered as a DRAFT agent entry, owned by ${esc(w.domain)}. Governance approval makes it visible to End Users.`
    S.regWizOpen=false; S.regWiz=null
    render()
  }
}

// TLP-B19 (B-J2 step 2): "Use in Build" on APPROVED Skill / MCP Server rows —
// jumps to the Build wizard with that entry pre-selected (S.skills / S.mcp),
// so a builder goes from browsing the registry to composing with the part in
// one click instead of remembering the name. APPROVED-only: the wizard only
// ever offers APPROVED entries, so the shortcut renders under the same gate.
const REG_USE_SET = { Skill:'skills', MCPServer:'mcp' }
function regUseButton(e){
  if(authMode()==='cognito') return ''
  const status = (e.resolved||{}).status
  if(status!=='APPROVED' || !REG_USE_SET[e.type] || !hasCap('useBuilderSurfaces')) return ''
  return ` <button class="ghost regusebuild" data-usetype="${esc(e.type)}" data-useid="${esc(e.id)}" style="padding:2px 10px;font-size:.7rem;white-space:nowrap">Use in Build →</button>`
}
const REG_PAGE_SIZE = 50   // T14 (S1): the registry stays legible at 100+ entries
function renderRegistryUnavailable(box,storeEl){
  S.registryEntries=[]
  if(storeEl)storeEl.innerHTML='<p role="alert">Registry is unavailable. No local data was substituted.</p>'
  box.innerHTML=`<div class="empty" role="alert"><b>Could not load ${S.registryFilterType==='Model'?'models':'Registry inventory'}</b><p>Try refreshing.</p><button class="ghost" id="regretry">Refresh</button></div>`
  const retry=document.getElementById('regretry');if(retry)retry.onclick=()=>runSessionTask(loadRegistry)
}
function wireRegistryPartialRetry(storeEl,current){
  const button=storeEl.querySelector('[data-registry-partial-retry]');if(!button)return
  button.onclick=sessionTaskHandler(async()=>{
    if(button.disabled||!button.isConnected||!current()||!confirmContextChange())return
    button.disabled=true
    clearHostedRegistryReadCache()
    try{await loadRegistry()}finally{if(button.isConnected&&current())button.disabled=false}
  })
}
function registrySourceTitle(entry,hosted){
  if(entry?._source==='agentcore-registry'){
    return hosted
      ?'Registry loaded'
      :`Loaded from AgentCore registry ${entry._registryId||''}`
  }
  if(entry?._source==='gateway'){
    return `Discovered from AgentCore Gateway: ${entry._gateway||''}`
  }
  return ''
}
// Official exact-ID facts describe a model, never platform routing or access.
function registryModelMetadata(entry){
  const current=(entry.versions||[]).filter(v=>v.semver===entry.defaultVersion)
  const content=current.length===1?current[0].content||{}:{}
  const gateway=entry._source==='gateway'&&content.source==='agentcore-gateway'&&content.gatewayModelId===entry.id
  const fact=gateway&&Object.hasOwn(MODEL_PROVIDER_FACTS,entry.id)?MODEL_PROVIDER_FACTS[entry.id]:null
  return {provider:fact?.provider||null,providerSource:fact?.url||null,
    modelId:gateway?content.gatewayModelId:null,runtimeId:gateway?content.runtimeModelId:null,
    source:fact?'AWS official model card · exact endpoint/model ID':'No exact official model-card match',
    input:fact?.input?.join(', ')||null,output:fact?.output?.join(', ')||null,version:null,
    mantle:gateway&&content.gatewayModelId.startsWith('bedrock-mantle/'),name:fact?.name||entry.name}
}
function registryModelGroupsHtml(rows){
  const groups=new Map()
  for(const entry of rows){
    const m=registryModelMetadata(entry),key=m.provider||'Unidentified provider'
    if(!groups.has(key))groups.set(key,[])
    groups.get(key).push(entry)
  }
  return [...groups].sort(([a],[b])=>a.localeCompare(b)).map(([group,entries])=>{
    return `<section class="model-provider-group" aria-label="${esc(group)}"><h3>${esc(group)} <span class="d">(${entries.length})</span></h3>
      <table aria-label="${esc(group)} models"><thead><tr><th scope="col">Model</th><th scope="col">Input → output</th><th scope="col">Details</th></tr></thead><tbody>${entries.map(e=>{
        const m=registryModelMetadata(e)
        return `<tr class="regrow" data-regid="${esc(e.id)}"><td>${esc(m.name)}</td><td>${m.input||m.output?`${esc(m.input||'Unknown input')} → ${esc(m.output||'Unknown output')}`:'Not provided'}</td><td><button class="ghost" aria-label="View details for ${esc(m.name)}">View details</button></td></tr>`
      }).join('')}</tbody></table></section>`
  }).join('')
}
function registryModelDetailsHtml(e){
  const m=registryModelMetadata(e)
  const snapshot=S.registryModelAccess
  const admin=SESSION?.role==='admin'&&snapshot?.context===hostedModelReadContext()&&snapshot.state==='ready'&&!Object.hasOwn(snapshot.catalog||{},'domainId')
  const matches=admin&&registryModelIdentity(e,S.registryEntries)?snapshot.catalog?.models?.filter(row=>row.id===e.id):[]
  const policyModel=matches?.length===1?matches[0]:null
  const policyHtml=policyModel?`<div class="item"><h4>Current platform policy</h4><p>${policyModel.policy===null?'No policy configured. Open model access to configure a policy.':`Application: ${esc(policyModel.policy?.applicationStatus||'Not provided')}`}</p><p>Allowed domains: ${esc(policyModel.policy?.allowedDomains?.join(', ')||'None')}</p><p>Requestable domains: ${esc(policyModel.policy?.requestableDomains?.join(', ')||'None')}</p><p>Domain access: ${esc(Object.entries(policyModel.accessByDomain||{}).map(([id,access])=>id+': '+access.status).join('; ')||'Not provided')}</p></div>`:''
  const view=isRegistryModelProjection(e)?registryModelView(e):null,access=view?.access
  const accessHtml=access?`<p>Domain: ${esc(activeDomain())} · Access: ${esc(access.status)}</p><p>Requestable: ${access.requestable===true?'Yes':'No'}</p>${access.latestRequest?`<p>Latest access request: ${esc(access.latestRequest.status)}</p>`:''}<h4>Effective model limits</h4>${hostedGatewayLimits(access.limits)}${access.rateLimit?.status==='RECONCILIATION_FAILED'?'<p role="status">Limits could not be applied. Open model access to review.</p>':''}`
    :policyHtml?'':`<p role="status">${snapshot?.state==='loading'?'Loading access…':snapshot?.state==='unavailable'?'Could not load access. Open model access to retry.':!activeDomain()?'Select a domain to view its access.':'Access information is not available. Open model access for options.'}</p>`
  const field=(label,value)=>`<div><dt class="d">${label}</dt><dd style="margin:4px 0 16px;overflow-wrap:anywhere">${esc(value||'Not provided')}</dd></div>`
  return `<section class="card" aria-label="Model details" style="border-left:3px solid var(--accent)">
    <div class="bar" style="justify-content:space-between"><h2>${esc(m.name)}</h2><button class="ghost" id="regdrawerclose">Close details</button></div>
    <section aria-labelledby="modeloverview"><h3 id="modeloverview">Overview</h3>
      <dl class="grid2">${field('Provider',m.provider)}${field('Input modalities',m.input)}${field('Output modalities',m.output)}${m.providerSource?`<div><dt class="d">Model information</dt><dd><a href="${esc(m.providerSource)}" target="_blank" rel="noopener noreferrer">AWS model card: exact ID match</a></dd></div>`:''}</dl>
    </section>
    <section aria-labelledby="modelaccess"><h3 id="modelaccess">Access</h3>
      ${accessHtml}${policyHtml}
      ${authMode()==='cognito'?'<button class="ghost" id="registrygatewayopen">Open model access</button><div id="registrygatewaypanel"></div>':''}
    </section>
    <details><summary id="modelconnection">Technical details</summary>
      <dl>${field('Gateway model ID',m.modelId)}${field('Runtime adapter alias',m.runtimeId)}</dl>
    </details>
  </section>`
}

function registryModelView(entry){
  const snapshot=S.registryModelAccess
  const current=snapshot?.context===hostedModelReadContext()
  return registryModelStatus(entry,{entries:S.registryEntries||[],domainId:activeDomain(),role:SESSION?.role,
    catalog:current?snapshot.catalog:null,state:current?snapshot.state:'unverified'})
}
function registryModelStatusHtml(entry){
  const model=registryModelView(entry)
  if(!model)return ''
  const current=(entry.versions||[]).find(version=>version.semver===entry.defaultVersion)
  if(current?.status!=='APPROVED')return '<span class="badge badge-grey">REGISTERED</span><span class="chip">Selectable for domain setup · runtime policy not configured</span>'
  // AUD-003: a platform admin viewing "All inventory" (no domain selected)
  // has a real, additive platformAdmission read (see registry-model-status.mjs).
  // That is "no domain chosen yet", not "nobody knows" — it must not render as
  // the same "Access unverified" chip as an actual unresolved/failed read, and
  // an ACTIVE platform application is only ever labeled "Policy active", never
  // as approval/verification of scoped access.
  // AUD-003: platform admin with no domain selected — show AI Gateway policy state.
  // No DISCOVERED badge: models only appear when platform-onboarded (APPROVED).
  if(!model.access&&model.platformAdmission){
    const pa=model.platformAdmission
    // AUD-003 follow-up: report the real validated policy state, not just
    // ACTIVE-or-nothing. PENDING/RECONCILIATION_FAILED come from the real
    // model-governance contract (infra/serverless-platform tests); "No
    // policy configured" is only ever shown when policy is confirmed null;
    // anything else unrecognized is Unknown, never silently Approved/Verified.
    const policyLabel=pa.applicationStatus==='ACTIVE'?'Policy active'
      :pa.applicationStatus==='PENDING'?'Policy pending'
      :pa.applicationStatus==='RECONCILIATION_FAILED'?'Policy reconciliation failed'
      :pa.policyConfirmedNull?'No policy configured'
      :'Unknown'
    return `<span class="badge badge-green">APPROVED</span>
    <span class="chip" title="Select a domain to view scoped AI Gateway access for this model.">Select a domain to view access</span><span class="chip" title="Platform application policy state. This is not domain approval and not a verified access grant.">${esc(policyLabel)}</span>${pa.grantedDomains.length?`<span class="chip" title="AI Gateway currently reports ALLOWED access in these domains">Granted in: ${esc(pa.grantedDomains.join(', '))}</span>`:''}${pa.requestableDomains.length?`<span class="chip" title="Access can be requested in these domains">Requestable in: ${esc(pa.requestableDomains.join(', '))}</span>`:''}`
  }
  // Governed status: APPROVED (onboarded models only). Show AI Gateway domain access where available.
  return `<span class="badge badge-green">APPROVED</span>
    ${model.access?`${hostedStatus(model.access.status)}${model.available?'<span class="badge badge-green">USABLE</span>':'<span class="chip">Not usable</span>'}${model.pending?'<span class="chip">Access request PENDING</span>':''}`
      :`<span class="chip" title="${esc(model.message)}">Access unverified</span>`}`
}
async function openRecentModelAccess(model,panel){
  const epoch=sessionEpoch,context=hostedModelReadContext()
  panel.textContent='Checking workspace access…'
  const result=await api('/ai-gateway').catch(()=>null)
  if(!sessionEpochIsCurrent(epoch)||context!==hostedModelReadContext()||!panel.isConnected)return
  if(!validHostedGatewayCatalog(result)){panel.textContent='Could not load workspace access. Try again.';return}
  const matches=result.models.filter(row=>row.versions?.some(v=>v.content?.runtimeModelId===model.runtime_model_id||v.content?.runtimeModelId===model.runtime_global_profile_id))
  if(matches.length!==1){panel.textContent='This model has no verified workspace connection. Contact your platform administrator to configure access.';return}
  if(!confirmContextChange())return
  businessForms.clear('gateway');S.hostedGatewaySelectedModelId=matches[0].id
  panel.innerHTML='<div id="hostedgateway"></div>'
  await loadHostedGateway()
}
function wireRegistryControls(){
  const sf=document.getElementById('regstatusfilter')
  if(sf)sf.onchange=()=>{S.registryStatusFilter=sf.value;S.registryPage=0;runSessionTask(loadRegistry)}
  const regsearch=document.getElementById('regsearch')
  if(regsearch)regsearch.oninput=()=>{S.registrySearch=regsearch.value;S.registryPage=0;runSessionTask(loadRegistry)}
  const createBtn=document.getElementById('regcreatebtn')
  if(createBtn)createBtn.onclick=()=>openRegistryCreatePanel()
  document.getElementById('regbox')?.querySelectorAll('.regrow').forEach(tr=>tr.onclick=()=>{
    if(!confirmContextChange())return
    businessForms.clear('gateway');businessForms.clear('registry')
    S.registryDrawerId=tr.dataset.regid
    S.registryDrawerVersion=null
    S.registryDecisionStatus=null
    renderRegistryDrawer()
    document.getElementById('regdrawerclose')?.focus?.()
    document.getElementById('regdrawerwrap')?.scrollIntoView?.({block:'start'})
  })
  document.getElementById('regbox')?.querySelectorAll('.regusebuild').forEach(btn=>btn.onclick=e=>{
    e.stopPropagation()
    const entry=(S.registryEntries||[]).find(x=>x.id===btn.dataset.useid)
    const key = btn.dataset.usetype==='Skill' && (entry?.resolved?.content||{}).toolType ? 'tools' : REG_USE_SET[btn.dataset.usetype]
    if(S[key]) S[key].add(btn.dataset.useid)
    S.view='compose'; S.door='blueprint'; S.step=S.bp?2:1
    render()
  })
  if(document.getElementById('regprev'))document.getElementById('regprev').onclick=()=>{S.registryPage--;runSessionTask(loadRegistry)}
  if(document.getElementById('regnext'))document.getElementById('regnext').onclick=()=>{S.registryPage++;runSessionTask(loadRegistry)}
}
function openRegistryCreatePanel(){
  const existing=document.getElementById('regcreatepanel')
  if(existing){existing.remove();return}
  const panel=document.createElement('div')
  panel.id='regcreatepanel'
  panel.className='card'
  panel.style.cssText='position:fixed;top:60px;right:24px;width:520px;max-height:80vh;overflow-y:auto;z-index:200;border-left:3px solid var(--accent);box-shadow:0 4px 24px rgba(0,0,0,.18)'
  S.regCreate=S.regCreate||{type:'A2AAgent',name:'',displayName:'',description:'',version:'1.0',content:'',transport:'streamable_http',endpoint:''}
  panel.innerHTML=vRegistryCreateForm()
  document.body.appendChild(panel)
  wireRegistryCreateForm()
}
function vRegistryCreateForm(){
  const f=S.regCreate||{}
  const typeOpts=[['A2AAgent','A2A Agent'],['MCPServer','MCP Server'],['Skill','Skill'],['CUSTOM','Custom']].map(([v,l])=>`<option value="${v}" ${f.type===v?'selected':''}>${l}</option>`).join('')
  const typeFields=f.type==='A2AAgent'?`
    <div><label>Agent card JSON <span style="color:var(--lock)">*</span><br><small>Must include <code>name</code> and <code>url</code> or <code>serviceEndpoint</code></small></label>
    <textarea id="rcc-content" rows="6" style="width:100%;font-size:.78rem;font-family:monospace">${esc(f.content||'')}</textarea></div>
    <div><label>Schema version</label><input value="0.3" disabled style="width:100px"></div>`
  :f.type==='MCPServer'?`
    <div><label>Endpoint URL <span style="color:var(--lock)">*</span> (https)</label><input id="rcc-endpoint" value="${esc(f.endpoint||'')}" placeholder="https://my-mcp.example.com/mcp"></div>
    <div><label>Transport</label><select id="rcc-transport"><option value="streamable_http" ${f.transport==='streamable_http'?'selected':''}>streamable_http</option><option value="sse" ${f.transport==='sse'?'selected':''}>sse</option></select></div>
    <div><label>Tools JSON (optional)</label><textarea id="rcc-content" rows="4" style="width:100%;font-size:.78rem;font-family:monospace" placeholder='[{"name":"my_tool","description":"..."}]'>${esc(f.content||'')}</textarea></div>`
  :f.type==='Skill'?`
    <div><label>Documentation (markdown) <span style="color:var(--lock)">*</span></label>
    <textarea id="rcc-content" rows="6" style="width:100%;font-size:.78rem;font-family:monospace" placeholder="## Skill Name&#10;Describe what the skill does…">${esc(f.content||'')}</textarea></div>
    <div><label>Structured definition JSON (optional)</label><textarea id="rcc-structdef" rows="3" style="width:100%;font-size:.78rem;font-family:monospace">${esc(f.structDef||'')}</textarea></div>`
  :`<div><label>Descriptor JSON <span style="color:var(--lock)">*</span></label>
    <textarea id="rcc-content" rows="6" style="width:100%;font-size:.78rem;font-family:monospace">${esc(f.content||'')}</textarea></div>`
  return `<div class="sec-h" style="margin-top:0;display:flex;justify-content:space-between;align-items:center">Create registry record <button class="ghost" id="rcc-close" style="padding:2px 8px;font-size:.75rem">✕</button></div>
  <div id="rcc-status"></div>
  <div style="display:flex;flex-direction:column;gap:10px;margin-top:8px">
    <div><label>Record type <span style="color:var(--lock)">*</span></label><select id="rcc-type">${typeOpts}</select></div>
    <div class="grid2">
      <div><label>Name (id) <span style="color:var(--lock)">*</span><br><small>[a-z0-9_-] only</small></label><input id="rcc-name" value="${esc(f.name||'')}" placeholder="my-agent"></div>
      <div><label>Display name</label><input id="rcc-displayname" value="${esc(f.displayName||'')}" placeholder="My Agent"></div>
    </div>
    <div><label>Description</label><input id="rcc-desc" value="${esc(f.description||'')}" placeholder="Short description"></div>
    <div><label>Version</label><input id="rcc-version" value="${esc(f.version||'1.0')}" style="width:120px"></div>
    ${typeFields}
    <div class="bar" style="gap:8px;margin-top:4px">
      <button class="ghost" id="rcc-cancel" style="padding:6px 14px;font-size:.78rem">Cancel</button>
      <button class="primary" id="rcc-draft" style="padding:6px 16px;font-size:.78rem">Create draft</button>
      ${hasCap('approveRegistryVersion')?`<button class="primary" id="rcc-approve" style="padding:6px 16px;font-size:.78rem;background:var(--badge-green,#00802f)">Create &amp; approve</button>`:''}
    </div>
  </div>`
}
function wireRegistryCreateForm(){
  const panel=document.getElementById('regcreatepanel')
  if(!panel)return
  const g=id=>panel.querySelector('#'+id)
  const rerender=()=>{const p=document.getElementById('regcreatepanel');if(p){p.innerHTML=vRegistryCreateForm();wireRegistryCreateForm()}}
  g('rcc-close').onclick=()=>{panel.remove();S.regCreate=null}
  g('rcc-cancel').onclick=()=>{panel.remove();S.regCreate=null}
  g('rcc-type').onchange=()=>{S.regCreate={...S.regCreate,type:g('rcc-type').value};rerender()}
  const grabFields=()=>{
    const f=S.regCreate||{}
    f.name=(g('rcc-name')?.value||'').trim()
    f.displayName=(g('rcc-displayname')?.value||'').trim()
    f.description=(g('rcc-desc')?.value||'').trim()
    f.version=(g('rcc-version')?.value||'1.0').trim()
    f.content=g('rcc-content')?.value||''
    f.endpoint=g('rcc-endpoint')?.value?.trim()||''
    f.transport=g('rcc-transport')?.value||'streamable_http'
    f.structDef=g('rcc-structdef')?.value||''
    S.regCreate=f
  }
  const doSubmit=async(andApprove)=>{
    grabFields()
    const f=S.regCreate||{}
    const status=g('rcc-status')
    const nameRe=/^[a-z0-9_-]+$/
    if(!nameRe.test(f.name)){status.innerHTML='<div class="status err">Name must match [a-z0-9_-].</div>';return}
    if(!f.content.trim()&&f.type!=='MCPServer'){status.innerHTML='<div class="status err">Content is required.</div>';return}
    if(f.type==='A2AAgent'){try{const j=JSON.parse(f.content);if(!j.name||(!'url' in j&&!j.serviceEndpoint)){status.innerHTML='<div class="status err">Agent card must include name and url or serviceEndpoint.</div>';return}}catch{status.innerHTML='<div class="status err">Agent card must be valid JSON.</div>';return}}
    if(f.type==='MCPServer'&&(!f.endpoint||!f.endpoint.startsWith('https://'))){status.innerHTML='<div class="status err">Endpoint must be an https URL.</div>';return}
    if(f.content.length>65536){status.innerHTML='<div class="status err">Content exceeds 64KB limit.</div>';return}
    status.innerHTML='<div class="status">Creating…</div>'
    try{
      const body={type:f.type,name:f.name,displayName:f.displayName,description:f.description,version:f.version,content:f.content,endpoint:f.endpoint,transport:f.transport,structDef:f.structDef,andApprove:!!andApprove}
      const r=await api('/registry-create',body,{requestId:createRequestId()})
      if(!r.ok){status.innerHTML=`<div class="status err">${esc(r.error||r.message||'Create failed.')}</div>`;return}
      panel.remove();S.regCreate=null
      S.regWizMsg=`✓ Record <code>${esc(f.name)}</code> created${andApprove?' and approved':' as DRAFT'}.`
      runSessionTask(loadRegistry)
    }catch(e){status.innerHTML=`<div class="status err">${esc(String(e))}</div>`}
  }
  g('rcc-draft').onclick=()=>doSubmit(false)
  const approveBtn=g('rcc-approve')
  if(approveBtn)approveBtn.onclick=()=>doSubmit(true)
}
async function loadRegistry(){
  const box=document.getElementById('regbox'); if(!box)return
  const hosted=authMode()==='cognito'
  const context=hostedModelReadContext(),view=S.view,generation=++registryModelLoadGeneration
  const current=()=>context===hostedModelReadContext()&&view===S.view
    &&generation===registryModelLoadGeneration&&box.isConnected&&document.getElementById('regbox')===box
  S.registryModelAccess={context,catalog:null,state:'loading'}
  box.innerHTML='<div class="empty" role="status">Loading…</div>'
  renderRegistryDrawer()
  // Hosted Registry exposes one canonical inventory; type is a UI filter.
  const type = hosted||S.registryFilterType==='All' ? '' : `?type=${S.registryFilterType}`
  const storeEl=document.getElementById('regstore')
  let r,approvals=[]
  try{
    const [registryResult,approvalResult,gatewayResult]=await Promise.all([
      api('/registry'+type),
      hosted
        ?readHostedCollection('approvals').catch(error=>{
          if(error===CANCELED_REQUEST)throw error
          return {ok:false,items:[]}
        })
        :Promise.resolve({ok:true,items:[]}),
      hosted&&['All','Model'].includes(S.registryFilterType)
        ?api('/ai-gateway').catch(error=>{
          if(error===CANCELED_REQUEST)throw error
          return null
        })
        :Promise.resolve(null),
    ])
    if(!current())return
    r=registryResult
    if(approvalResult?.ok===true)approvals=approvalResult.items||[]
    const valid=validHostedGatewayCatalog(gatewayResult)
      &&(SESSION?.role==='admin'||gatewayResult.domainId===activeDomain())
    S.registryModelAccess={context,catalog:valid?gatewayResult:null,state:valid?'ready':'unavailable'}
  }catch(error){
    if(!current())return
    if(error===CANCELED_REQUEST)throw error
    if(authMode()!=='cognito')throw error
    renderRegistryUnavailable(box,storeEl)
    return
  }
  const awsUnavailable = r.ok===false || !!r.code || (authMode()==='cognito' && r.source!=='aws')
  if(awsUnavailable){
    renderRegistryUnavailable(box,storeEl)
    return
  }
  if(storeEl && (r.incomplete===true || r.partial===true || r.complete===false || r.errors?.length)){
    storeEl.innerHTML = '<p role="alert">Registry is incomplete. Some records could not be read; pending totals are unknown.</p>'
      + (Array.isArray(r.errors)?r.errors.map(id=>`<p class="error">Record ${esc(typeof id==='string'?id:'unavailable')}: invalid descriptor. Review actions are unavailable for this record.</p>`).join(''):'')
      + '<button class="ghost" data-registry-partial-retry>Retry Registry read</button>'
    wireRegistryPartialRetry(storeEl,current)
  } else if(storeEl) {
    storeEl.innerHTML = ''
  }
  S.registryEntries = (r.entries||[]).map(entry=>({
    ...entry,
    versions:(entry.versions||[]).map(version=>{
      if(entry.type!=='Agent'&&version._governed!==true)return version
      const aws=version._aws
      if(!aws?.registryId||!aws?.recordId)return version
      const approval=approvals.find(approval=>
        approval.kind==='RESOURCE_PUBLICATION'
        &&approval.resourceType===({Agent:'AGENT',A2AAgent:'AGENT',Skill:'SKILL',MCPServer:'MCP_SERVER',Blueprint:'BLUEPRINT'})[entry.type]
        &&approval.resourceId===`${aws.registryId}/${aws.recordId}`)
      return approval?{...version,_approval:approval}:version
    }),
  }))
  if(hosted&&S.registryFilterType==='Model'){
    const inventory=S.registryEntries.filter(entry=>entry.type==='Model')
    const providers=[...new Set(inventory.map(entry=>registryModelMetadata(entry).provider||'__missing__'))].sort()
    const q=(S.registrySearch||'').trim().toLowerCase()
    const rows=inventory.filter(entry=>{
      const meta=registryModelMetadata(entry)
      return (!S.registryProvider||(meta.provider||'__missing__')===S.registryProvider)
        &&(!q||[meta.name,entry.name,entry.id,meta.provider].join(' ').toLowerCase().includes(q))
    })
    box.innerHTML=`<h2>Models (${inventory.length})</h2><p class="d">Registered models. Open a model to inspect its domain access; registration alone does not grant access.</p>
      <div class="bar model-catalog-filters"><label for="regprovider">Provider</label><select id="regprovider"><option value="">All providers</option>${providers.map(provider=>`<option value="${esc(provider)}" ${S.registryProvider===provider?'selected':''}>${esc(provider==='__missing__'?'Unidentified provider':provider)}</option>`).join('')}</select><button class="ghost" id="regclear">Clear filters</button></div>
      <p role="status">${inventory.length} total models · ${rows.length} matching model${rows.length===1?'':'s'}</p>
      ${rows.length?registryModelGroupsHtml(rows):`<div class="empty">${inventory.length?'No matching models':'No models discovered'}</div>`}`
    renderRegistryDrawer();wireRegistryControls()
    const provider=document.getElementById('regprovider')
    provider.onchange=()=>{S.registryProvider=provider.value;runSessionTask(loadRegistry)}
    document.getElementById('regclear').onclick=()=>{S.registryProvider='';S.registrySearch='';const search=document.getElementById('regsearch');if(search)search.value='';runSessionTask(loadRegistry)}
    return
  }
  const q=(S.registrySearch||'').trim().toLowerCase()
  const statusFilter=S.registryStatusFilter||''
  // Discovery and platform policy readiness are separate. The server projects
  // active policies as APPROVED; discovered models still need configuration.
  const inventory=S.registryEntries
  const searched = q ? inventory.filter(e=>
    (e.name||'').toLowerCase().includes(q) || (e.description||'').toLowerCase().includes(q) || (e.id||'').toLowerCase().includes(q)) : inventory
  const typeFiltered = S.registryFilterType&&S.registryFilterType!=='All' ? searched.filter(e=>e.type===S.registryFilterType) : searched
  const filtered = statusFilter ? typeFiltered.filter(e=>{
    const resolved=(e.resolved||{})
    const latest=[...(e.versions||[])].sort((a,b)=>a.semver.localeCompare(b.semver,undefined,{numeric:true})).pop()
    const status=resolved.status||latest?.status||'DRAFT'
    return status===statusFilter
  }) : typeFiltered
  const pages = Math.max(1, Math.ceil(filtered.length/REG_PAGE_SIZE))
  S.registryPage = Math.min(S.registryPage||0, pages-1)
  const rows = filtered.slice(S.registryPage*REG_PAGE_SIZE, (S.registryPage+1)*REG_PAGE_SIZE)
  renderRegistryDrawer()
  if(!rows.length){box.innerHTML=`<div class="empty">No registry entries${q?` matching "${esc(q)}"`:statusFilter?` with status ${esc(statusFilter)}`:''}.</div>
    <div class="bar" style="margin-top:8px"><p class="d" style="color:var(--muted);font-size:.72rem;margin:0">${inventory.length} total entries</p></div>`;wireRegistryControls();return}
  box.innerHTML = `<table><thead><tr><th>Name</th><th>Type</th><th>Status</th><th>Version</th><th>Domain</th><th>Updated</th></tr></thead><tbody>
    ${rows.map(e=>{
      const resolved = e.resolved || {}
      const latest = [...(e.versions||[])].sort((a,b)=>a.semver.localeCompare(b.semver,undefined,{numeric:true})).pop()
      const appr = regApprover(e)
      const updatedAt = appr.at || latest?.createdAt || null
      return `<tr class="regrow" data-regid="${esc(e.id)}" style="cursor:pointer">
        <td><div style="display:flex;align-items:center;gap:8px">${REG_TYPE_ICON[e.type]||''}<div><div style="font-weight:500">${esc(e.name)}</div>${e.description?`<div style="color:var(--muted);font-size:.7rem;margin-top:2px">${esc(e.description.slice(0,80)+(e.description.length>80?'…':''))}</div>`:''}</div></div></td>
        <td><span class="chip type">${esc(e.type)}</span></td>
        <td>${e.type==='Model'?'<span class="chip">Model catalog</span>':regStatusBadge(resolved.status || latest?.status)}${e.drift?`<span class="chip" style="color:var(--lock);border-color:var(--lock-bd);margin-left:4px" title="upstream drift detected ${esc(e.drift.detectedAt||'')}">drifted</span>`:''}${regUseButton(e)}</td>
        <td><code>${esc(e.type==='Model'?(registryModelMetadata(e).version||'—'):(e.defaultVersion||'—'))}</code></td>
        <td>${domChip(e.domain)}</td>
        <td class="d" style="color:var(--muted);font-size:.76rem;white-space:nowrap">${updatedAt?new Date(updatedAt).toLocaleDateString():'—'}</td>
      </tr>`
    }).join('')}
  </tbody></table>
  <div class="bar" style="margin-top:8px;gap:10px;align-items:center">
    <p class="d" style="color:var(--muted);font-size:.72rem;margin:0">${filtered.length} entr${filtered.length===1?'y':'ies'}${q?` matching "${esc(q)}"`:''}  of ${inventory.length} total${pages>1?` · page ${S.registryPage+1}/${pages}`:''}</p>
    ${pages>1?`<span style="margin-left:auto;display:flex;gap:6px">
      <button class="ghost" id="regprev" ${S.registryPage===0?'disabled':''} style="padding:3px 12px;font-size:.75rem">‹ Prev</button>
      <button class="ghost" id="regnext" ${S.registryPage>=pages-1?'disabled':''} style="padding:3px 12px;font-size:.75rem">Next ›</button>
    </span>`:''}
  </div>`
  wireRegistryControls()
}

// Simple line-diff of JSON-stringified content vs the previous APPROVED
// version, reusing the existing code-block (<pre>) styling. A straightforward
// line-by-line added/removed/unchanged pass — enough to make a demo diff
// legible without pulling in a diff dependency.
function lineDiff(oldStr, newStr){
  const a=(oldStr||'').split('\n'), b=(newStr||'').split('\n')
  const setA=new Map(); a.forEach(l=>{if(!setA.has(l))setA.set(l,0);setA.set(l,setA.get(l)+1)})
  const out=[]
  for(const line of b){
    if(setA.get(line)>0){ setA.set(line,setA.get(line)-1); out.push({t:' ',l:line}) }
    else out.push({t:'+',l:line})
  }
  for(const [line,count] of setA){ for(let i=0;i<count;i++) out.push({t:'-',l:line}) }
  return out
}
function diffHtml(oldContent, newContent){
  const rows = lineDiff(JSON.stringify(oldContent,null,2), JSON.stringify(newContent,null,2))
  return `<pre style="max-height:260px">${rows.map(r=>{
    const color = r.t==='+' ? 'color:var(--ok)' : r.t==='-' ? 'color:var(--err)' : 'color:var(--dim)'
    return `<div style="${color}">${r.t} ${esc(r.l)}</div>`
  }).join('')}</pre>`
}

// WS-E: ML Platform provenance for a Model entry — the lineage chain
// (training job -> registry entry -> consuming agents). Lineage comes from the
// entry's version content; consumers are server-derived from each project's
// effective model, so this list and the cost page always agree.
function modelLineageHtml(e){
  const lin=(e.resolved||{}).content?.lineage
  const consumers=e.consumers||[]
  const consumerChips = consumers.length
    ? consumers.map(c=>`<span class="chip">${AGENT_IC}${esc(c.project)}${c.domain?` · ${esc(c.domain)}`:''}</span>`).join(' ')
    : '<span class="chip" style="color:var(--muted)">no deployed agent runs this model yet</span>'
  if(!lin) return `<div class="sec-h">Used by</div><div class="meta">${consumerChips}</div>`
  const row=(k,v)=>v?`<tr><td style="color:var(--muted);white-space:nowrap;padding-right:12px">${k}</td><td style="word-break:break-all">${v}</td></tr>`:''
  return `<div class="sec-h">ML Platform lineage</div>
  <div class="item">
    <div class="meta" style="margin-bottom:8px">
      <span class="chip" style="color:var(--plat);border-color:var(--plat-bd)">source: ${esc(lin.source||'ML Platform')}</span>
      <span class="chip">training job → registry → agent</span>
    </div>
    <table style="font-size:.8rem"><tbody>
      ${row('Base model', `<code>${esc(lin.baseModel||'')}</code>`)}
      ${row('Method', esc(lin.method||''))}
      ${row('Training job', `<code style="font-size:.72rem">${esc(lin.trainingJob||'')}</code>`)}
      ${row('Dataset', esc(lin.dataset||''))}
      ${row('Eval report', esc(lin.evalReport||''))}
      ${row('Imported via', esc(lin.importedVia||''))}
      ${row('Registered', esc(lin.registeredAt||''))}
    </tbody></table>
  </div>
  <div class="sec-h">Used by</div><div class="meta">${consumerChips}</div>`
}

function domainListHtml(list){
  if(!list||!list.length)return '<span class="chip" style="color:var(--muted)">none</span>'
  if(list.includes('*'))return '<span class="chip" style="color:var(--accent);border-color:var(--accent-bd)">all domains</span>'
  return list.map(d=>domChip(d)).join(' ')
}
// Batch 1: ListFoundationModels metadata on gateway-discovered Model entries —
// provider / modalities / streaming / lifecycle as key-value chips (drawer
// detail; the roster table is already at the 7-core-column density cap).
function modelLfmHtml(e){
  const m=e._lfm
  if(!m) return ''
  return `<div class="sec-h">Model metadata <span class="chip" style="text-transform:none;letter-spacing:0">bedrock:ListFoundationModels</span></div>
  <div class="meta">
    ${m.provider?`<span class="chip">provider: ${esc(m.provider)}</span>`:''}
    ${(m.inputModalities||[]).length?`<span class="chip">in: ${esc(m.inputModalities.join('+'))}</span>`:''}
    ${(m.outputModalities||[]).length?`<span class="chip">out: ${esc(m.outputModalities.join('+'))}</span>`:''}
    <span class="chip">streaming: ${m.streaming?'yes':'no'}</span>
    ${m.lifecycle?`<span class="chip" style="${m.lifecycle==='ACTIVE'?'color:var(--ok);border-color:var(--ok)':'color:var(--lock);border-color:var(--lock-bd)'}">${esc(m.lifecycle)}</span>`:''}
  </div>`
}
function modelAccessHtml(e){
  if(isRegistryModelProjection(e)){
    const model=registryModelView(e),access=model.access
    return `<div class="sec-h">Current-domain model access${activeDomain()?` · ${esc(activeDomain())}`:''}</div>
      <div class="meta">${registryModelStatusHtml(e)}</div>
      ${model.message?`<p class="d" role="status">${esc(model.message)}</p>`:''}
      ${model.identity?`<p class="d">Gateway model: <code>${esc(model.identity.gatewayModelId)}</code><br>Runtime alias: <code>${esc(model.identity.runtimeModelId)}</code></p>`:''}
      ${access?`<p class="d">Requestable: ${access.requestable===true?'Yes':'No'}.
        ${access.latestRequest?`Latest access request: ${esc(access.latestRequest.status)} · ${esc(access.latestRequest.id)} · ${esc(access.latestRequest.requestedAt)}.`:'No current model access request returned.'}</p>
        <p class="d">Application: ${esc(model.applicationStatus||'Not returned')}. Reconciliation: ${esc(access.rateLimit?.status||'Not configured')}${access.rateLimit?.reconciledAt?` · ${esc(access.rateLimit.reconciledAt)}`:''}${access.rateLimit?.reason?` · ${esc(access.rateLimit.reason)}`:''}.</p>
        <div class="sec-h">Effective model limits</div>
        ${hostedGatewayLimits(access.limits)}`:''}`
  }
  const hosted=authMode()==='cognito'
  const a=e.modelAccess||{}
  const p=a.policy||{}
  const statusColor=a.allowed?'var(--ok)':a.status==='pending'?'var(--info)':a.requestable?'var(--lock)':'var(--muted)'
  const statusLabel=a.status==='platform'?'platform override'
    :a.status==='grant-approved'?'approved by access grant'
    :a.status==='allowed'?'allowed for this domain'
    :a.status==='pending'?'access request pending'
    :a.status==='rejected'?'last request rejected'
    :a.status==='expired'?'last grant expired'
    :a.requestable?'requestable by this domain'
    :'not visible to this domain'
  const req=a.request
  const grant=a.grant
  const rows=(a.rateLimitPlan?.entries||[]).map(x=>`<tr>
    <td><code>${esc(x.name)}</code></td>
    <td>${(x.dimensionKeys||[]).map(k=>`<span class="chip">${esc(k)}</span>`).join(' ')}</td>
    <td>${x.requestLimit?`${esc(x.requestLimit.rate)}/${esc(x.requestLimit.interval)}`:'-'}</td>
    <td>${x.tokenLimit?`${esc(x.tokenLimit.rate)}/${esc(x.tokenLimit.interval)}`:'-'}</td>
    <td>${x.connectionLimit?`${esc(x.connectionLimit.rate)}/${esc(x.connectionLimit.interval)}`:'-'}</td>
  </tr>`).join('')
  return `<div class="sec-h">Model access policy</div>
  <div class="item">
    <div class="meta">
      <span class="chip" style="color:${statusColor};border-color:${statusColor}">${esc(statusLabel)}</span>
      <span class="chip">policy: ${esc(p.id||'default')}</span>
      <span class="chip">matched: <code>${esc(p.modelId||p.modelPattern||'*')}</code></span>
    </div>
    ${p.description?`<p class="d" style="color:var(--dim);font-size:.78rem;margin-top:8px">${esc(p.description)}</p>`:''}
    <div class="grid2" style="margin-top:10px">
      <div><div class="sec-h" style="margin:0 0 6px">Allowed domains</div><div class="meta">${domainListHtml(p.allowedDomains)}</div></div>
      <div><div class="sec-h" style="margin:0 0 6px">Can request access</div><div class="meta">${domainListHtml(p.requestableDomains)}</div></div>
    </div>
    ${grant?`<div class="status ok">Temporary domain grant active until ${esc(String(grant.expiresAt||'').replace('T',' ').slice(0,19))}.</div>`:''}
    ${req?`<div class="status ${req.status==='pending'?'info':req.status==='rejected'?'err':'ok'}">Latest request: ${esc(req.status)}${!hosted&&req.decidedBy?` by ${esc(req.decidedBy)}`:''}${req.expiresAt?` · expires ${esc(String(req.expiresAt).replace('T',' ').slice(0,19))}`:''}</div>`:''}
    ${authMode()!=='cognito'&&a.requestable&&hasCap('requestModelAccess')?`<div class="bar"><button class="primary" id="modelaccessrequest">Request model access</button></div><div id="modelaccessstatus"></div>`:''}
  </div>
  <div class="sec-h">Rate-limit plan <span class="chip" style="text-transform:none;letter-spacing:0">AgentCore Gateway</span></div>
  <div class="item">
    ${rows?`<table><thead><tr><th>Name</th><th>Dimensions</th><th>Requests</th><th>Tokens</th><th>Connections</th></tr></thead><tbody>${rows}</tbody></table>`:'<div class="empty">No rate-limit profile attached to this policy.</div>'}
    <details style="margin-top:10px;font-size:.8rem"><summary style="cursor:pointer;color:var(--dim)">Resolved rate-limit dimensions</summary><pre>${esc(JSON.stringify(a.rateLimitPlan||{},null,2))}</pre></details>
  </div>`
}

function authoritativeRegistryVersion(id,semver){
  const entry=(S.registryEntries||[]).find(candidate=>candidate.id===id)
  return (entry?.versions||[]).find(version=>version.semver===semver)||null
}

function applyRegistryDecisionResult(result){
  const version=result&&authoritativeRegistryVersion(result.id,result.semver)
  if(!version||!['APPROVED','REJECTED'].includes(result?.status))return null
  version.status=result.status
  if(typeof result.statusReason==='string')version.statusReason=result.statusReason
  return version
}

function canDecideRegistryRecord(entry,version){
  if(authMode()==='cognito'&&(entry?.type==='Agent'||version?._governed===true)){
    return version?._approval?.domainId===entry.domain&&hostedApprovalActionEnabled('RESOURCE_PUBLICATION',hostedCaps(),{
      recordDomainId:entry.domain,activeDomainId:activeDomain(),
    })
  }
  return hasCap('approveRegistryVersion')
}
async function revalidateRegistryDecision(entry,version,approvalId=''){
  const hosted=authMode()==='cognito'
  const options={hosted,canDecide:canDecideRegistryRecord(entry,version),actor:SESSION?.actor||SESSION?.user,approvalId}
  if(!registryDecisionAllowed(entry,version,options))return false
  if(!hosted)return true
  const result=await rawApi('/registry')
  if(result?.ok!==true||result.source!=='aws'||!Array.isArray(result.entries))return false
  const entries=result.entries.filter(row=>row?.id===entry.id)
  if(entries.length!==1)return false
  const currentEntry=entries[0]
  if(!Array.isArray(currentEntry.versions))return false
  const versions=currentEntry.versions.filter(row=>row?.semver===version.semver)
  if(versions.length!==1)return false
  let currentVersion=versions[0]
  if(approvalId){
    const approvals=await readHostedCollection('approvals')
    const matches=(approvals?.ok===true&&Array.isArray(approvals.items)?approvals.items:[]).filter(row=>row?.id===approvalId)
    if(matches.length!==1)return false
    currentVersion={...currentVersion,_approval:matches[0]}
  }
  return sameRegistryDecisionRecord(entry,version,currentEntry,currentVersion,hosted)
    &&registryDecisionAllowed(currentEntry,currentVersion,{...options,canDecide:canDecideRegistryRecord(currentEntry,currentVersion)})
}
function renderRegistryDrawer(){
  const wrap=document.getElementById('regdrawerwrap'); if(!wrap)return
  const id=S.registryDrawerId
  if(!id){wrap.innerHTML='';return}
  const e=(S.registryEntries||[]).find(x=>x.id===id)
  if(!e){wrap.innerHTML='';return}
  const hosted=authMode()==='cognito'
  const projection=isRegistryModelProjection(e)
  const versions=[...(e.versions||[])].sort((a,b)=>b.semver.localeCompare(a.semver,undefined,{numeric:true}))
  const approvedVersions=projection?[]:versions.filter(v=>v.status==='APPROVED').sort((a,b)=>a.semver.localeCompare(b.semver,undefined,{numeric:true}))
  // TLP-B2 (spec §1.2/§7.2): write actions are capability-gated, not
  // persona-string-gated — this is what makes builder/lead Registry truly
  // read-only (buttons don't render at all, not just server-403'd).
  const canPropose = !projection && !hosted && hasCap('manageRegistryEntries')
  const canDecide = hasCap('approveRegistryVersion')
  wrap.innerHTML = e.type==='Model'?registryModelDetailsHtml(e):`<div class="card" style="border-left:3px solid var(--accent)">
    <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px">
      <div><div class="sec-h" style="margin-top:0">${REG_TYPE_ICON[e.type]||''} ${esc(e.name)} <span class="chip type">${esc(e.type)}</span> ${govModeBadge(e.governanceMode)}</div>
        <div class="d" style="font-size:.84rem;color:var(--dim)">${esc(e.description||'')}</div>
        <div class="meta" style="margin-top:6px"><span class="chip">id: ${esc(e.id)}</span>${domChip(e.domain)}${e.domainOwner?`<span class="chip">owner: ${esc(e.domainOwner)}</span>`:''}<span class="chip">default: <code>${esc(e.defaultVersion||'—')}</code></span>${e.drift?`<span class="chip" style="color:var(--lock);border-color:var(--lock-bd)">drifted dependency</span>`:''}</div>
      </div>
      <button class="ghost" id="regdrawerclose" style="padding:4px 10px;font-size:.75rem">Close ✕</button>
    </div>

    ${e.type==='Model' ? modelLfmHtml(e) + modelAccessHtml(e) + modelLineageHtml(e) : ''}
    ${hosted&&e.type==='Model'?'<button class="ghost" id="registrygatewayopen">Open AI Gateway model access</button><div id="registrygatewaypanel"></div>':''}

    <div class="sec-h">Version history</div>
    ${versions.map(v=>{
      const prevApproved = approvedVersions.filter(a=>a.semver!==v.semver && a.semver.localeCompare(v.semver,undefined,{numeric:true})<0).pop()
      const selected=S.registryDrawerVersion===v.semver
      const approval=v._approval||null
      const publicationDecision=hosted&&e.type==='Agent'
        &&approval?.status==='PENDING'
      const ownPublication=publicationDecision
        &&approval.requesterSubject===SESSION?.actor
      const canDecideVersion=!projection&&registryDecisionAllowed(e,v,{hosted,canDecide:canDecideRegistryRecord(e,v),actor:SESSION?.actor||SESSION?.user,approvalId:approval?.id||''})
      const decisionStatus=selected&&!projection
        ? (S.registryDecisionStatus?.id===e.id&&S.registryDecisionStatus?.semver===v.semver
          ? S.registryDecisionStatus.status
          : v.status)
        : null
      return `<div class="item" data-regversion="${esc(v.semver)}" data-selected="${selected?'true':'false'}" style="margin-bottom:10px">
        <div style="display:flex;justify-content:space-between;align-items:center;gap:10px">
          <div><code>v${esc(v.semver)}</code> ${regStatusBadge(v.status)} ${v.semver===e.defaultVersion?'<span class="chip" style="color:var(--accent);border-color:var(--accent-bd)">default</span>':''}</div>
          ${canDecideVersion ? `<div style="display:flex;gap:6px">
            <button class="primary regapprove" data-id="${esc(e.id)}" data-semver="${esc(v.semver)}" data-approval="${esc(approval?.id||'')}" style="padding:4px 10px;font-size:.75rem">Approve</button>
            <button class="ghost regreject" data-id="${esc(e.id)}" data-semver="${esc(v.semver)}" data-approval="${esc(approval?.id||'')}" style="padding:4px 10px;font-size:.75rem;color:var(--err);border-color:var(--err)">Reject</button>
          </div>` : ''}
        </div>
        ${ownPublication?'<div class="d" style="font-size:.74rem;color:var(--muted);margin-top:6px">You requested this publication. A different eligible reviewer must decide it.</div>':''}
        <div class="d" style="font-size:.78rem;margin-top:6px"><span style="color:var(--muted)">Changelog</span> ${esc(v.changelog||'—')}</div>
        ${!projection&&!hosted&&v.createdBy?`<div class="meta" style="margin-top:4px"><span class="chip">by ${esc(v.createdBy)}</span>${v.decidedBy?`<span class="chip">decided by ${esc(v.decidedBy)}</span>`:''}</div>`:''}
        ${decisionStatus?`<div class="status ok" style="margin-top:8px">Authoritative status: ${regStatusBadge(decisionStatus)}</div>`:''}
        ${(v.autoChecks||[]).length ? `<details style="margin-top:8px;font-size:.8rem"><summary style="cursor:pointer;color:var(--dim)">Auto-check results (${v.autoChecks.length})</summary>
          ${v.autoChecks.map(c=>`<div style="margin:6px 0;padding:6px 8px;border-left:2px solid ${c.pass?'var(--ok)':'var(--err)'}"><b style="color:${c.pass?'var(--ok)':'var(--err)'}">${c.pass?'✓':'✗'} ${esc(c.name)}</b><div style="color:var(--muted);font-size:.74rem">${esc(c.detail||'')}</div></div>`).join('')}
        </details>` : ''}
        ${prevApproved ? `<details style="margin-top:8px;font-size:.8rem"><summary style="cursor:pointer;color:var(--dim)">Diff vs previous APPROVED (v${esc(prevApproved.semver)})</summary>${diffHtml(prevApproved.content,v.content)}</details>` : ''}
      </div>`
    }).join('')}

    ${canPropose ? `<div class="sec-h">Propose new version</div>
    <div id="regproposeform">
      <label style="margin-top:0">Changelog ${versions.length?'(required)':''}</label>
      <input id="regchangelog" placeholder="What changed and why?"/>
      <div class="grid2">
        <div><label>Version bump</label><select id="regbump"><option value="minor">Minor (additive)</option><option value="patch">Patch (no behavior change)</option><option value="major">Major (breaking)</option></select></div>
        <div><label>Content (JSON)</label><input id="regcontent" placeholder='{"key":"value"}' value='${esc(JSON.stringify((versions[0]||{}).content||{}))}'/></div>
      </div>
      <div class="bar"><button class="primary" id="regpropose">Propose</button>${canDecide?`<button class="ghost" id="regsubmit">Propose &amp; submit for review</button>`:''}</div>
      <div id="regproposestatus"></div>
    </div>` : ''}

    ${!projection && !hosted && canDecide && e.governanceMode==='federated' ? `<div class="sec-h">Federated</div>
      <div class="bar"><button class="ghost" id="regdrift" data-id="${esc(e.id)}" title="Demotes the APPROVED version to IN_REVIEW to model upstream drift (spec §4.1.1)">Demo an upstream change</button></div>
      <div id="regdriftstatus"></div>` : ''}
  </div>`

  if(hosted&&!projection&&e._source==='agentcore-registry'){
    const epoch=sessionEpoch
    for(const version of versions.filter(v=>['DRAFT','IN_REVIEW','REJECTED'].includes(v.status)&&v._aws?.registryId&&v._aws?.recordId)){
      const article=document.createElement('section');article.className='item'
      article.innerHTML=`<h4>Publication · v${esc(version.semver)}</h4><button class="ghost" data-publication-check>Check submission eligibility</button><div data-publication-context></div>`
      wrap.append(article)
      mountPublicationSubmission(article,{row:{entry:e,version,identity:`${version._aws.registryId}/${version._aws.recordId}`},api,
        access:{role:SESSION?.role,resourceDomain:e.domain,activeDomain:activeDomain(),capabilities:hostedCaps()},
        readApprovals:()=>readHostedCollection('approvals'),
        current:()=>sessionEpochIsCurrent(epoch)&&wrap.isConnected&&S.registryDrawerId===id&&article.isConnected,
        identity:()=>`${sessionEpoch}:${SESSION?.actor||SESSION?.user}:${SESSION?.role}:${activeDomain()}:${hostedCaps().join(',')}`,
        requestId:createRequestId,reload:async()=>{await loadRegistry();renderRegistryDrawer()}})
    }
  }
  const gatewayOpen=document.getElementById('registrygatewayopen')
  if(gatewayOpen)gatewayOpen.onclick=sessionTaskHandler(async()=>{
    if(!confirmContextChange())return
    const identity=registryModelIdentity(e,S.registryEntries)
    if(projection&&!identity){
      document.getElementById('registrygatewaypanel').innerHTML='<p role="status">Access unverified: reconcile the exact Gateway model identity before opening model access.</p>'
      return
    }
    businessForms.clear('gateway')
    S.hostedGatewaySelectedModelId=identity?.gatewayModelId||e.id
    document.getElementById('registrygatewaypanel').dataset.model=S.hostedGatewaySelectedModelId
    document.getElementById('registrygatewaypanel').innerHTML='<div id="hostedgateway"></div>'
    await loadHostedGateway()
  })
  document.getElementById('regdrawerclose').onclick=()=>{
    if(!confirmContextChange())return
    businessForms.clear('gateway');businessForms.clear('registry')
    S.registryDrawerId=null
    S.registryDrawerVersion=null
    S.registryDecisionStatus=null
    renderRegistryDrawer()
  }
  wrap.querySelectorAll('[data-regversion]').forEach(item=>item.onclick=event=>{
    if(event.target.closest('button,details,summary,input,select,textarea'))return
    if(!confirmContextChange())return
    businessForms.clear('gateway');businessForms.clear('registry')
    S.registryDrawerVersion=item.dataset.regversion
    S.registryDecisionStatus=null
    renderRegistryDrawer()
  })
  wrap.querySelectorAll('.regapprove,.regreject').forEach(btn=>btn.onclick=sessionTaskHandler(async()=>{
    btn.disabled=true
    const decision = btn.classList.contains('regapprove') ? 'approve' : 'reject'
    const reason = decision==='reject'
      ? (await requestDemoChoice('approvalRejection','Reason for rejection?')||'')
      : ''
    const version=versions.find(row=>row.semver===btn.dataset.semver)
    if(btn.dataset.id!==e.id||!await revalidateRegistryDecision(e,version,btn.dataset.approval||'')){
      btn.disabled=false;alert('This record is stale, read-only, or no longer authorized. Refresh the Registry and use its supported access workflow.');return
    }
    S.registryDrawerId=btn.dataset.id
    S.registryDrawerVersion=btn.dataset.semver
    S.registryDecisionStatus=null
    const requestId=createRequestId()
    const payload={id:btn.dataset.id,semver:btn.dataset.semver,decision,reason,
      ...(hosted?{registryId:version._aws.registryId,recordId:version._aws.recordId}:{})}
    const r=btn.dataset.approval
      ?await api('/governance/publication-decisions',{
        approvalId:btn.dataset.approval,
        decision:decision.toUpperCase(),
        reason:reason||'Approved after governance review.',
      },{requestId})
      :await api('/registry-decide',payload,{requestId})
    if(r.ok){
      await loadRegistry()
      if(btn.dataset.approval){
        renderRegistryDrawer()
        wrap.querySelector('[data-selected="true"]')?.scrollIntoView({block:'nearest'})
        return
      }
      const version=applyRegistryDecisionResult(r.version)
      if(!version){
        btn.disabled=false
        alert('The authoritative Registry version could not be refreshed.')
        return
      }
      S.registryDecisionStatus={
        id:btn.dataset.id,
        semver:btn.dataset.semver,
        status:version.status,
      }
      renderRegistryDrawer()
      wrap.querySelector('[data-selected="true"]')?.scrollIntoView({block:'nearest'})
    } else {
      btn.disabled=false
      alert(apiErrorMessage(r,'decision failed'))
    }
  }))
  const proposeBtn=document.getElementById('regpropose')
  if(proposeBtn)proposeBtn.onclick=()=>runSessionTask(()=>doRegistryPropose(e,false))
  const submitBtn=document.getElementById('regsubmit')
  if(submitBtn)submitBtn.onclick=()=>runSessionTask(()=>doRegistryPropose(e,true))
  const driftBtn=document.getElementById('regdrift')
  if(driftBtn)driftBtn.onclick=sessionTaskHandler(async()=>{
    driftBtn.disabled=true
    const r=await api('/registry-drift',{id:driftBtn.dataset.id})
    if(r.ok){
      await loadRegistry();renderRegistryDrawer()
      const st2=document.getElementById('regdriftstatus')
      if(st2)st2.innerHTML='<div class="status ok">✓ Upstream drift detected — demoted to IN_REVIEW.</div>'
    } else {
      const st=document.getElementById('regdriftstatus')
      driftBtn.disabled=false;st.innerHTML=`<div class="status err">${esc(r.error||'drift failed')}</div>`
    }
  })
  const modelReq=document.getElementById('modelaccessrequest')
  if(modelReq)modelReq.onclick=sessionTaskHandler(async()=>{
    const st=document.getElementById('modelaccessstatus')
    const purpose=await requestDemoChoice(
      'modelAccess',
      'Why does your domain need access to this model?',
    )
    if(!purpose)return
    modelReq.disabled=true
    st.innerHTML='<div class="status info"><span class="spin">⟳</span> submitting model access request…</div>'
    const r=await api('/grant-request',{resourceType:'model',resourceId:e.id,purpose,durationS:86400})
    if(r.ok){
      st.innerHTML='<div class="status ok">Model access request submitted to the platform team.</div>'
      await loadRegistry(); renderRegistryDrawer()
    }else{
      modelReq.disabled=false
      st.innerHTML=`<div class="status err">${esc(r.error||'request failed')}</div>`
    }
  })
}
async function doRegistryPropose(e, andSubmit){
  const st=document.getElementById('regproposestatus')
  let content
  try{ content=JSON.parse(document.getElementById('regcontent').value||'{}') }
  catch{ st.innerHTML='<div class="status err">Content must be valid JSON.</div>'; return }
  const body={
    type:e.type, id:e.id, name:e.name,
    changelog:document.getElementById('regchangelog').value.trim(),
    suggestedBump:document.getElementById('regbump').value,
    content,
  }
  st.innerHTML='<div class="status info"><span class="spin">⟳</span> proposing…</div>'
  const r=await api('/registry-propose',body)
  if(!r.ok){st.innerHTML=`<div class="status err">${esc(r.error||'propose failed')}</div>`;return}
  let msg
  if(andSubmit){
    const sr=await api('/registry-submit',{id:e.id,semver:r.version.semver})
    msg = sr.passed
      ? `<div class="status ok">✓ Proposed v${esc(r.version.semver)} and submitted — now IN_REVIEW.</div>`
      : `<div class="status err">Auto-checks failed, bounced back to DRAFT: ${esc((sr.reasons||[]).join('; '))}</div>`
  } else {
    msg = `<div class="status ok">✓ Proposed v${esc(r.version.semver)} as DRAFT.</div>`
  }
  // renderRegistryDrawer() below rebuilds #regproposestatus fresh (it's part of
  // the drawer markup), which would wipe this message before it's ever seen —
  // re-set it after the drawer refresh so both the message and the refreshed
  // version list/approve buttons are visible at once.
  await loadRegistry(); renderRegistryDrawer()
  const st2=document.getElementById('regproposestatus')
  if(st2)st2.innerHTML=msg
}
function wireRegistry(){
  const openBtn=document.getElementById('regwizopen')
  if(openBtn)openBtn.onclick=()=>{ S.regWizOpen=true; S.regWiz=null; S.regWizMsg=null; S.registryDrawerId=null; render() }
  if(authMode()!=='cognito'&&S.regWizOpen){ wireRegisterWizard(); return }
  document.querySelectorAll('[data-regtype]').forEach(chip=>chip.onclick=()=>{
    if(!confirmContextChange())return
    businessForms.clear('gateway');businessForms.clear('registry')
    if(!['All','Model'].includes(chip.dataset.regtype))S.registryModelFilter='all'
    S.registryFilterType=chip.dataset.regtype; S.registryDrawerId=null; S.recentModelKey=null; S.registryPage=0; render()
  })
  const search=document.getElementById('regsearch')
  if(search)search.oninput=()=>{S.registrySearch=search.value; S.registryPage=0; runSessionTask(loadRegistry)}
  const modelView=document.getElementById('regmodelview')
  if(modelView)modelView.onchange=()=>{
    if(!confirmContextChange())return
    S.registryModelFilter=modelView.value;S.registryPage=0;runSessionTask(loadRegistry)
  }
}

// ---------- Governance / Agent Registry (Loom-informed) ----------
// One workflow over every governed resource: deployed agents (auto-registered
// as DRAFT when they appear in the fleet), MCP servers, A2A agents. Approval
// gates End-User visibility and what the Build wizard offers. Backing store is
// SIMULATED (JSON files on the server) and labeled as such.
// ---------- Governance (T13A: six sub-modules per CONTROL-PLANE-REDESIGN §7) ----------
// Rules and approvals live here; what's-running stays in Operate/Observability.
// The old top-level HITL Approvals view is absorbed as the "Approval policies" tab.
// The 'queue' tab (registry/blueprint approvals) and the 'requests' tab
// (access-grant requests, ex the standalone Requests inbox) are DIFFERENT
// kinds of approvals — two adjacent tabs, never one blended list.
// Governance IA: one decision inbox instead of three approval tabs. The
// 'queue' tab now carries every approval type in sections — registry
// publications + production deploys, resource-access requests, and the
// platform 4-eyes queues (guardrail exemptions + blueprint submissions).
// Guardrails keep a dedicated tab (org pack + strengthen-only overrides is
// a core governance story). Policies stays for HITL/AgentCore policy.
// Audit absorbs Compliance (both are after-the-fact traceability).
// Alerts & RACI moved out of Governance — alert definitions and response
// ownership are operational configuration and belong with Monitoring.
const GOV_TABS = [
  ['queue','Approval requests'],
  ['guardrails','Guardrails'],
  ['policies','Policies'],
  ['audit','Audit'],
]
// Legacy tab ids from saved state or deep links map onto the new IA instead
// of silently falling back to the first tab.
const GOV_TAB_ALIASES = { requests:'queue', exemptions:'queue', alerts:'guardrails', compliance:'audit' }
// Domain reviewers get only the decision inbox. Platform policy,
// configuration, and audit tabs remain restricted to Platform Admin.
const govTabsVisible = () => hasCap('viewAllDomains')
  ? GOV_TABS
  : GOV_TABS.filter(([id])=>id==='queue')
const activeGovTab = () => {
  const tabs=govTabsVisible()
  const requested=GOV_TAB_ALIASES[S.govTab]||S.govTab
  return tabs.some(([id])=>id===requested) ? requested : tabs[0][0]
}
const govTabLabel = id => ((GOV_TABS.find(([tid])=>tid===id)||[])[1]) || ''
function vGovernance(){
  const tab = activeGovTab()
  const plat = hasCap('viewAllDomains')
  const isDecider = hasCap('decideAccessRequests')
  const tabBtn=(id,label)=>`<button type="button" class="ghost govtab" role="tab" id="govtab-${id}" aria-selected="${tab===id}" aria-controls="govtabpanel" tabindex="${tab===id?'0':'-1'}" data-tab="${id}"${id==='queue'&&plat?' title="Only APPROVED resources reach End Users and the Build wizard."':''} style="padding:7px 14px;font-size:.78rem">${label}</button>`
  return `<span class="roletag ${plat?'plat':'dom'}">${plat?'Platform team · control plane':'Domain team · application plane'}</span><h1>Governance <span class="d" style="font-weight:400;color:var(--muted)">/ ${esc(govTabLabel(tab))}</span></h1>
  <p class="subtitle">${plat
    ?'Approvals, policies and audit.'
    :isDecider
    ?'Agent publication, production and access requests in your domain. You decide; you never self-approve.'
    :'Agent publication, production and access requests in your domain. A different eligible reviewer decides.'}</p>
  ${plat
    ?storyLine('','fleet','See what runs in Agent Fleet')
    :storyLine('','observability','See the content views')}
  ${scopeNote()}
  <div class="bar govtabs" role="tablist" aria-label="Governance sections">${govTabsVisible().map(([id,l])=>tabBtn(id,l)).join('')}</div>
  <div id="govtabpanel" role="tabpanel" aria-labelledby="govtab-${tab}" tabindex="0">
  ${tab==='queue'?`
  <nav class="console-queue-nav" aria-label="Request types">${[['publication-requests','Publications & deployments'],...(authMode()==='cognito'?[['agent-releases','Agent releases']]:[]),['access-requests','Resource access'],['exception-requests','Guardrail exceptions'],...(plat?[['blueprint-requests','Blueprint submissions']]:[])].map(([id,label])=>`<button class="ghost" data-queue-section="${id}" aria-controls="${id}" aria-pressed="${(S.approvalSection||'publication-requests')===id}">${esc(label)}</button>`).join('')}</nav>
  <div class="card" id="publication-requests"><div class="console-resource-header"><div><h2>Publications &amp; deployments</h2><p>Review the resource, requested change and supporting evidence before deciding.</p></div></div>
    <div id="govqueue"><div class="empty"><span class="spin">⟳</span> loading queue…</div></div>
    <div id="govmembacklog"></div>
    <p class="d" style="color:var(--muted);font-size:.72rem;margin-top:8px"><span id="govstoremode">${authMode()==='cognito'?'Authenticated Registry and approval records · source availability shown above':'DRAFT → IN_REVIEW → APPROVED/REJECTED <span class="chip">console-local store</span>'}</span></p></div>
  ${authMode()==='cognito'?'<section class="card" id="agent-releases"><div class="console-resource-header"><div><h2>Governed Agent releases</h2><p>GitHub delivery, environment verification and production decisions.</p></div><button class="ghost" id="release-refresh">Refresh releases</button></div><div id="governed-release-delivery"></div></section>':''}
  <section id="access-requests"><div class="sec-h">Resource access requests</div>
  ${govRequestsTab()}</section>
  ${govExemptionsTab()}
  ${authMode()==='cognito'?`
  <div class="story" style="margin:16px 0 20px"><span class="st-k">Deployed agents, MCP servers and A2A agents</span><span class="st-sep">·</span><a class="storynext" data-goview="registry">Open AI Registry →</a><a class="storynext" data-goview="fleet">Open Agent Fleet →</a></div>`:`
  <div class="card"><div class="sec-h" style="margin-top:0">Deployed agents <span class="chip">auto-registered as DRAFT</span></div>
    <div id="govagents"><div class="empty"><span class="spin">⟳</span> loading deployed agents…</div></div></div>
  <div class="card"><div class="sec-h" style="margin-top:0">MCP servers</div>
    <div id="govmcp"><div class="empty"><span class="spin">⟳</span> loading…</div></div></div>
  <div class="card"><div class="sec-h" style="margin-top:0">A2A agents</div>
    <div id="gova2a"><div class="empty"><span class="spin">⟳</span> loading…</div></div></div>`}`
  :tab==='policies'?govPoliciesTab()
  :tab==='guardrails'?govGuardrailsTab()
  :`
  <div class="card">
    <div class="sec-h" style="margin-top:0">Audit trail <span class="chip">metadata only</span></div>
    <div style="display:flex;gap:10px;margin-bottom:10px">
      <select id="audftype" style="max-width:200px"><option value="">all types</option>${(S.auditTypes||[]).map(t=>`<option ${S.audFType===t?'selected':''}>${t}</option>`).join('')}</select>
      ${hasCap('viewAllDomains')?`<select id="audfdomain" style="max-width:200px"><option value="">all domains</option>${(S.domainDirectory||[]).map(d=>`<option value="${esc(d.id)}" ${S.audFDomain===d.id?'selected':''}>${esc(d.name)}</option>`).join('')}</select>`:''}
    </div>
    <div id="audlist"><div class="empty"><span class="spin">⟳</span> loading audit trail…</div></div>
  </div>
  <div class="card">
    <div class="sec-h" style="margin-top:0">Decision log</div>
    <div style="display:flex;gap:10px;margin-bottom:10px">
      <select id="haagent" style="max-width:220px"><option value="">All agents</option></select>
      <select id="hastatus" style="max-width:180px"><option value="">All statuses</option><option>pending</option><option>approved</option><option>rejected</option><option>notified</option><option>firing</option><option>suspended</option><option>resolved</option></select>
    </div>
    <div id="hitlaudit"><div class="empty"><span class="spin">⟳</span> loading…</div></div>
  </div>
  <div class="card"><div class="sec-h" style="margin-top:0">${IDCARD_IC}Audit metadata export</div>
    <p id="audexportscope" role="status"></p>
    <div class="bar" style="margin-top:4px"><button class="ghost" id="siemexport" style="padding:6px 12px;font-size:.76rem">Export audit stream (SIEM)</button></div>
    <div id="siemstatus"></div>
  </div>
  <div class="card"><div class="sec-h" style="margin-top:0">Compliance reporting</div>
    <div id="gcompliance"><div class="empty"><span class="spin">⟳</span> loading…</div></div></div>`}
  </div>`
}
// Hosted policy controls distinguish Registry access, native Gateway policy and
// approval intent. Pending human decisions remain in the Approval requests tab.
function govPoliciesTab(){
  if(authMode()==='cognito')return `<div class="policy-center">
    <div class="bar"><div><h2>Policy controls</h2><p class="d">Policy scope: ${esc(activeDomain()||'platform')} · Platform → domain → project → runtime</p></div><button class="ghost" data-policy-queue>View approval queue</button></div>
    <p>Define what teams can use, what agents may do, and where a human decision is required. Domain and project settings inherit the platform's controls.</p>
    <div class="grid3 policy-layers">
      <article class="card"><h3>Resource access</h3><p>Platform approves Registry resources. Domain administrators allocate models, templates, tools and skills to projects.</p><span class="chip">Checked by platform APIs</span><div class="bar"><button class="ghost" data-policy-nav="domains">Domain access</button><button class="ghost" data-policy-nav="registry">AI Registry</button></div></article>
      <article class="card"><h3>Agent actions</h3><p>AgentCore Policy evaluates tool calls at a Gateway. Bedrock Guardrails handle content controls where attached.</p><span class="chip">Binding and mode determine enforcement</span><div class="bar"><a href="#runtimepolicies">Inspect Gateway policies ↓</a><button class="ghost" data-policy-nav="governance" data-policy-tab="guardrails">Guardrails</button></div></article>
      <article class="card"><h3>Human decisions</h3><p>Publication, resource access and release requests need an authorized reviewer. Requesters cannot approve their own requests.</p><span class="chip">Decisions recorded in Approval requests</span><div class="bar"><button class="ghost" data-policy-nav="governance" data-policy-tab="queue">Approval requests</button></div></article>
    </div>
    <section class="card" aria-labelledby="runtime-policy-title"><div class="bar"><div><h3 id="runtime-policy-title">AgentCore Policy · Gateway tool access</h3><p class="d">Live configuration of shared platform Gateways</p></div><a href="https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/policy.html" target="_blank" rel="noopener noreferrer">AWS documentation ↗</a></div>
      <p>A Policy Engine evaluates Cedar rules against the caller, tool, Gateway and input. ENFORCE applies default-deny and forbid-wins; LOG_ONLY records decisions without blocking calls. Engine attachment alone does not prove every project uses that Gateway.</p>
      <div id="runtimepolicies" role="status">Loading Gateway policy bindings…</div>
      <details class="policy-guidance"><summary>Configure and promote a runtime policy</summary><ol><li>Bind the project's trusted identity and tools to the intended Gateway; inspect its tool schema.</li><li>Author and validate Cedar rules in a Policy Engine. Test allowed and denied calls in development; use LOG_ONLY to observe candidate rules.</li><li>Review the policy change, then deploy the approved configuration in ENFORCE mode through controlled delivery. Record the engine, Gateway, policy revision and test evidence.</li></ol><p>Session-aware AgentCore policies can use prior events and guardrail signals. An external approval workflow must still establish a trusted human decision; a client-supplied approval flag is insufficient.</p></details>
    </section>
    <section class="card"><h3>Release and approval controls</h3><div class="policy-table"><table><thead><tr><th>Control</th><th>Where it applies</th><th>Current platform behavior</th></tr></thead><tbody><tr><td>Registry publication / resource access</td><td>Platform and domain APIs</td><td>Scope, resource state and reviewer separation are checked when submitting and deciding requests.</td></tr><tr><td>Production promotion</td><td>Project CI/CD → target environment</td><td>Review connected pipelines in Governed Agent releases. Production requires the pipeline's human approval for the exact commit, artifact and target. Unconnected repositories need delivery configuration.</td></tr><tr><td>Tool-call approval</td><td>Agent / tool execution workflow</td><td>Tool-approval runtime enforcement is not active. The catalog below stores draft intent; no agent pause/resume integration is configured.</td></tr></tbody></table></div></section>
    <details class="card policy-drafts"><summary>Tool approval drafts · configuration only</summary><p>Use these drafts to specify which tool actions should request approval. Saving a draft does not attach an AgentCore Policy Engine or activate a runtime workflow.</p><div id="hitlpolicies" role="status">Loading approval drafts…</div></details>
  </div>`
  return `<div class="card" id="govpolicyengines-card"><div class="sec-h" style="margin-top:0">Cedar Policy Engines</div>
    <div id="govpolicyengines"><div class="empty"><span class="spin">⟳</span> loading policy engines…</div></div></div>
  <div class="card"><div class="sec-h" style="margin-top:0">Approval policies</div>
    <p class="d" style="color:var(--muted);font-size:.76rem">${authMode()==='cognito'?'Read-only, versioned policy configuration. Hosted tool-interrupt enforcement is not configured.':'Matching tool calls pause in the Approval queue.'}</p>
    <div id="hitlpolicies"><div class="empty"><span class="spin">⟳</span> loading…</div></div></div>
  <div class="card">
    <div class="sec-h" style="margin-top:0">Create a policy</div>
    <div class="grid2">
      <div><label style="margin-top:0">Policy name</label><input id="hpname" placeholder="e.g. Sensitive writes"/></div>
      <div><label style="margin-top:0">Tool match patterns (comma-separated, * wildcard)</label><input id="hptools" placeholder="e.g. delete_*, refund_*"/></div>
    </div>
    <div class="grid2">
      <div><label>Mode</label><select id="hpmode"><option value="require_approval">Require approval (pause the call)</option><option value="notify_only">Notify only (log and continue)</option></select></div>
      <div><label>Agent scope</label><select id="hpscope"><option value="all">All agents</option></select></div>
    </div>
    <div class="bar"><button class="primary" id="hpcreate" ${authMode()==='cognito'?'disabled title="Hosted policy creation is not implemented"':''}>Create policy</button></div>
    <div id="hpstatus">${authMode()==='cognito'?'<p class="d">Policy creation and tool-interrupt enforcement are not configured. Catalog reads do not activate policies. The Approval queue remains available for supported workflows.</p>':''}</div>
  </div>`
}
async function loadGovPolicyEngines(){
  const box=document.getElementById('govpolicyengines');if(!box)return
  const current=adminReadStart(box,'Policy Engines')
  const r=await adminRead('/governance/policy-engines')
  if(!current())return
  if(!r?.ok||!Array.isArray(r.engines)){
    box.innerHTML=`<div class="empty" role="status">Policy engine data unavailable.${r?.error?` ${esc(r.error)}`:''}</div>`
    return
  }
  if(!r.engines.length){box.innerHTML='<div class="empty">No policy engines found.</div>';return}
  box.innerHTML=`<table><thead><tr><th>Engine</th><th>Project</th><th>Status</th><th>Created</th></tr></thead><tbody>
    ${r.engines.map(e=>`<tr>
      <td><b>${esc(e.name)}</b><div class="d" style="color:var(--muted);font-size:.72rem"><code>${esc(e.id)}</code></div></td>
      <td><span class="chip type">${esc(e.project||'platform')}</span></td>
      <td><span class="badge ${e.status==='ACTIVE'?'badge-green':'badge-grey'}">${esc(e.status)}</span></td>
      <td style="font-size:.76rem;color:var(--dim)">${e.createdAt?esc(e.createdAt.slice(0,10)):'—'}</td>
    </tr>`).join('')}
  </tbody></table>${r.source?`<p class="d" style="font-size:.72rem;color:var(--dim);margin-top:6px">Source: ${esc(r.source)}</p>`:''}`
}
async function loadRuntimePolicies(){
  const box=document.getElementById('runtimepolicies');if(!box)return
  const current=adminReadStart(box,'AgentCore Policy')
  const r=await adminRead('/governance/runtime-policies')
  if(!current())return
  if(adminReadFailure(box,r,['gateways'],'AgentCore Policy',loadRuntimePolicies))return
  try{box.innerHTML=runtimePolicyView(r)}catch{adminReadFailure(box,{ok:false,code:'INVALID_RESPONSE'},[],'AgentCore Policy',loadRuntimePolicies);return}
  box.querySelector('[data-runtime-policy-refresh]')?.addEventListener('click',sessionTaskHandler(async()=>{if(!current())return;await loadRuntimePolicies()}))
}
function wirePolicyNavigation(){
  document.querySelectorAll('[data-policy-nav]').forEach(button=>button.onclick=()=>{if(!confirmContextChange())return;S.view=button.dataset.policyNav;if(button.dataset.policyTab)S.govTab=button.dataset.policyTab;render()})
}
// Blueprint declarations are not evidence of runtime attachment or enforcement.
function govGuardrailsTab(){
  return `<div class="card"><div id="guardrailsettings" role="status">Loading guardrails…</div></div>`
}
// The guardrail policy is a versioned document shipped with the console
// (guardrails-policy.json) — the same source the local server enforces from.
// It renders on every deployment, hosted or local, without a backend read;
// a missing or malformed document fails closed to an explicit error state.
async function loadGovGuardrails(){
  const box=document.getElementById('guardrailsettings');if(!box)return
  const current=adminReadStart(box,'guardrails')
  const r=authMode()==='cognito'?await adminRead('/governance/guardrails'):await api('/guardrail-catalog')
  if(!current())return
  const result={...r,controls:r.controls||(Array.isArray(r.catalog)?r.catalog.map(c=>({
    ...c,mandatory:GUARDRAIL_CATALOG.find(control=>control.id===c.id)?.mandatory===true,
    action:c.action||c.defaultAction,runMode:c.runMode||c.defaultRunMode,
  })):undefined)}
  if(adminReadFailure(box,result,['controls'],'guardrails',loadGovGuardrails))return
  try{box.innerHTML=guardrailCatalogView(result.controls)}
  catch{adminReadFailure(box,{ok:false,code:'INVALID_RESPONSE'},[],'guardrails',loadGovGuardrails);return}
  box.querySelectorAll('[data-guardrail-refresh]').forEach(button=>button.onclick=sessionTaskHandler(async()=>{if(button.disabled||!current())return;button.disabled=true;await loadGovGuardrails()}))
}
// Alert policy + RACI definition (§8.3/§8.4): the DEFINITION lives here in
// Governance; the runtime firing feed lives in Observability › Alerts — same
// policy-vs-enforcement split as guardrails. An alert rule is a governed
// policy artifact, not a free console knob.
const SEV_BADGE = { SEV1:'badge-red', SEV2:'badge-orange', SEV3:'badge-blue' }
const sevBadge = s=>`<span class="badge ${SEV_BADGE[s]||'badge-grey'}">${esc(s)}</span>`
// Alert definitions + RACI panel. Rendered inside Monitoring (hosted admin
// sections in vHostedOperations; local Alerts tab below) — moved out of the
// retired Governance "Alerts & RACI" tab because alert configuration and
// response ownership are operational concerns, not approvals.
function govAlertsTab(){
  if(authMode()==='cognito')return `<div class="card"><div class="sec-h">Alert policies</div><p>Alert definitions and response responsibilities. Configuration does not verify notification delivery.</p><div id="alertpolicies" role="status">Loading…</div></div><div class="card"><div class="sec-h">Response responsibilities (RACI)</div><div id="alertraci" role="status">Loading…</div></div>`
  return `<div class="card"><div class="sec-h" style="margin-top:0">Alert policy</div>
    <div id="alertpolicies"><div class="empty"><span class="spin">⟳</span> loading…</div></div></div>
  <div class="card"><div class="sec-h" style="margin-top:0">Alert-handling RACI</div>
    <div id="alertraci"><div class="empty"><span class="spin">⟳</span> loading…</div></div></div>
  <div class="card"><div class="sec-h" style="margin-top:0">Create an alert policy</div>
    <div class="grid2">
      <div><label style="margin-top:0">Alert name</label><input id="apname" placeholder="e.g. Token spend spike"/></div>
      <div><label style="margin-top:0">Metric</label><input id="apmetric" placeholder="e.g. Token cost per agent"/></div>
    </div>
    <div class="grid2">
      <div><label>Threshold</label><input id="apthresh" placeholder="e.g. >2x 7-day baseline"/></div>
      <div><label>Severity</label><select id="apsev"><option>SEV2</option><option>SEV1</option><option>SEV3</option></select></div>
    </div>
    <div class="grid2">
      <div><label>Owner</label><input id="apowner" placeholder="e.g. Domain Builder (agent owner)"/></div>
      <div><label>Runbook link</label><input id="aprunbook" placeholder="runbooks/…md (defaults from the name)"/></div>
    </div>
    <div class="bar"><button class="primary" id="apcreate" ${authMode()==='cognito'?'disabled title="Hosted alert-policy creation is not implemented"':''}>Create alert policy</button></div>
    <div id="apstatus">${authMode()==='cognito'?'<p class="d">Hosted alert-policy storage and creation are not implemented. Monitoring remains available for supported operational data.</p>':''}</div>
  </div>`
}
// P1-B/C: isolated metadata-read boundary. Preserve HTTP failures without
// changing Registry/model transport or interpreting a 404 as an empty list.
async function adminRead(path){
  if(authMode()!=='cognito'){
    try{return await api(path)}catch(error){if(error===CANCELED_REQUEST)throw error;return {ok:false,code:'NETWORK_ERROR'}}
  }
  const request=beginSessionRequest()
  try{
    const response=await fetch(apiUrl(path),{method:'GET',headers:authHeaders(),signal:request.controller.signal})
    if(!sessionRequestIsCurrent(request))throw CANCELED_REQUEST
    if(response.status===401){handleUnauthorized();throw CANCELED_REQUEST}
    const text=await response.text()
    if(!sessionRequestIsCurrent(request))throw CANCELED_REQUEST
    let data
    try{data=JSON.parse(text)}catch{return {ok:false,status:response.status,code:'INVALID_RESPONSE'}}
    if(!data||typeof data!=='object'||Array.isArray(data))return {ok:false,status:response.status,code:'INVALID_RESPONSE'}
    return {...data,ok:response.ok&&data.ok===true,status:response.status}
  }catch(error){
    if(error===CANCELED_REQUEST||error?.name==='AbortError'||!sessionRequestIsCurrent(request))throw CANCELED_REQUEST
    return {ok:false,code:'NETWORK_ERROR'}
  }finally{finishSessionRequest(request)}
}
function adminReadState(result,fields,source=''){
  const code=result?.code||''
  if(result?.status===403||code==='FORBIDDEN'||code.startsWith('DEMO_DOMAIN_')||code==='DEMO_ROLE_NOT_ALLOWED')return 'forbidden'
  if(code==='NOT_CONFIGURED'||code.endsWith('_NOT_CONFIGURED'))return 'unconfigured'
  const success=result?.ok===true||(authMode()!=='cognito'&&result?.ok===undefined&&!result?.error)
  if(!success||result?.status>=400||result?.partial===true||result?.complete===false||result?.error||result?.code||result?.cursor)return 'error'
  for(const field of fields){
    const rows=result[field]
    if(!Array.isArray(rows)||rows.some(row=>!row||typeof row!=='object'||Array.isArray(row)||typeof row.id!=='string'||!row.id))return 'error'
    if(field==='policies'&&rows.some(row=>typeof row.name!=='string'||typeof row.enabled!=='boolean'||(row.toolMatch!==undefined&&(!Array.isArray(row.toolMatch)||row.toolMatch.some(t=>typeof t!=='string')))))return 'error'
    if(field==='policies'&&source.startsWith('/api/hitl')&&rows.some(row=>!Array.isArray(row.toolMatch)||!row.toolMatch.length||row.toolMatch.some(t=>typeof t!=='string'||!t.trim())||!['notify_only','require_approval'].includes(row.mode)||typeof row.agentScope!=='string'||!row.agentScope.trim()))return 'error'
    if(field==='policies'&&source.startsWith('/api/alerts')&&rows.some(row=>['metric','threshold'].some(key=>typeof row[key]!=='string'||!row[key].trim())||['owner','runbook'].some(key=>typeof row[key]!=='string'||(result.source!=='workspace-alert-policy-catalog'&&!row[key].trim()))||!['SEV1','SEV2','SEV3'].includes(row.severity)))return 'error'
    if(field==='memories'&&rows.some(row=>typeof row.name!=='string'||typeof row.agent!=='string'))return 'error'
    if(field==='docs'&&rows.some(row=>typeof row.name!=='string'||typeof row.project!=='string'))return 'error'
  }
  return 'ready'
}
function adminReadHtml(state,source){
  const message=state==='loading'?'Loading…':state==='forbidden'?'You do not have access in this scope.':state==='unconfigured'?'Not configured.':source.startsWith('/api/alerts')?'Alert policies and response responsibilities are currently unavailable.':'We could not load this data. Its status is unknown.'
  return `<div class="empty" role="status" data-read-state="${state}" data-source="${esc(source)}">${message}${state==='error'?'<button class="ghost" data-admin-retry>Retry read</button>':''}</div>`
}
function adminReadStart(box,source){
  const request=Symbol('admin-read'),epoch=sessionEpoch,domain=activeDomain(),actor=SESSION?.actor||SESSION?.user
  box.adminReadRequest=request
  box.innerHTML=adminReadHtml('loading',source)
  return ()=>sessionEpochIsCurrent(epoch)&&box.isConnected&&box.adminReadRequest===request&&domain===activeDomain()&&actor===(SESSION?.actor||SESSION?.user)
}
function adminReadFailure(box,result,fields,source,reload){
  const state=adminReadState(result,fields,source)
  if(state==='ready')return false
  box.innerHTML=adminReadHtml(state,source)
  const epoch=sessionEpoch,domain=activeDomain(),actor=SESSION?.actor||SESSION?.user,request=box.adminReadRequest
  box.querySelectorAll('[data-admin-retry]').forEach(button=>button.onclick=sessionTaskHandler(async()=>{
    if(button.disabled||!button.isConnected||!box.isConnected||!sessionEpochIsCurrent(epoch)||domain!==activeDomain()||actor!==(SESSION?.actor||SESSION?.user)||request!==box.adminReadRequest)return
    button.disabled=true;await reload()
  }))
  return true
}
async function loadAdminApprovalQueue(box,kind,resourceType,reload){
  const source='/api/approvals · items.kind/resourceType/status/domainId'
  const current=adminReadStart(box,source)
  const result=await collectPagedItems(async cursor=>{
    const r=await adminRead('/approvals?limit=50'+(cursor?'&cursor='+encodeURIComponent(cursor):''))
    if(r?.ok!==true)return r
    // Validate each page before aggregation; later-page failure flags must not
    // disappear behind the first page's successful envelope.
    return r.resource==='approvals'&&!r.partial&&r.complete!==false
      &&(!r.completeness||r.completeness==='complete')&&!r.error&&!r.code
      ?r:{ok:false,code:'INVALID_RESPONSE'}
  })
  if(!current())return
  const valid=result?.resource==='approvals'&&result.cursor===null&&Array.isArray(result.items)&&result.items.every(r=>r&&typeof r.id==='string'&&typeof r.domainId==='string'&&typeof r.resourceId==='string'&&typeof r.requesterSubject==='string'&&['PENDING','APPROVED','REJECTED','CANCELLED'].includes(r.status)&&['RESOURCE_ACCESS','RESOURCE_PUBLICATION','PRODUCTION_DEPLOYMENT'].includes(r.kind)&&typeof r.resourceType==='string')
  if(adminReadFailure(box,result?.ok===true&&!valid?{ok:false,code:'INVALID_RESPONSE'}:result,['items'],source,reload))return
  const scoped=result.items.filter(r=>r.kind===kind&&(!resourceType||r.resourceType===resourceType))
    .filter(r=>kind!=='RESOURCE_PUBLICATION'||resourceType!=='BLUEPRINT'||['platform','shared'].includes(r.domainId))
  const filtered=kind==='RESOURCE_ACCESS'&&(S.reqFType||S.reqFStatus||S.reqFDomain)
  const rows=scoped.filter(r=>kind!=='RESOURCE_ACCESS'||(!S.reqFType||r.resourceType===S.reqFType)&&(!S.reqFStatus||r.status===S.reqFStatus)&&(!S.reqFDomain||r.domainId===S.reqFDomain))
  // The read succeeded (adminReadFailure already returned on any failure): an
  // empty list here is a real empty scope, not an error. Distinguish a fully
  // empty scope from a no-match-under-filters state so filters can be cleared.
  const empty=filtered
    ?'<div class="empty" data-read-state="empty">No requests match these filters.<div class="bar" style="margin-top:8px"><button class="ghost" data-req-clear-filters style="padding:4px 12px;font-size:.75rem">Clear filters</button></div></div>'
    :kind==='RESOURCE_ACCESS'?'<div class="empty" data-read-state="empty">No access requests in this scope.</div>'
    :kind==='RESOURCE_PUBLICATION'&&resourceType==='BLUEPRINT'?'<div class="empty" data-read-state="empty">No platform blueprint submissions.</div>'
    :'<div class="empty" data-read-state="empty">No approval records in this scope.</div>'
  box.innerHTML=rows.length?hostedCollectionItems('approvals',rows,{approvalActions:true,compact:true}):empty
  const clear=box.querySelector?.('[data-req-clear-filters]')
  if(clear)clear.onclick=()=>{if(!confirmContextChange())return;S.reqFType='';S.reqFStatus='';S.reqFDomain='';runSessionTask(reload)}
  wireHostedApprovalActions(box,reload,rows)
}

async function loadGovAlerts(){
  const box=document.getElementById('alertpolicies'); if(!box)return
  const current=adminReadStart(box,'/api/alerts · policies/escalation')
  const raciBox=document.getElementById('alertraci');if(raciBox)adminReadStart(raciBox,'/api/alerts · response responsibilities')
  const r=await adminRead('/alerts')
  if(!current())return
  if(adminReadFailure(box,r,['policies'],'/api/alerts · policies',loadGovAlerts)){
    if(raciBox)adminReadFailure(raciBox,r,['policies'],'/api/alerts · response responsibilities',loadGovAlerts)
    return
  }
  if(authMode()==='cognito'){
    if(!validAlertCatalogResponse(r)){
      adminReadFailure(box,{ok:false},[],'alert configuration',loadGovAlerts)
      if(raciBox)adminReadFailure(raciBox,{ok:false},[],'response responsibilities',loadGovAlerts)
      return
    }
    box.innerHTML=alertCatalogHtml(r);if(raciBox)raciBox.innerHTML=alertRaciHtml(r)
    mountDraftActivity(box,{catalog:r,kind:'alert',read:path=>rawApi(path),current,identity:hostedModelReadContext})
    box.querySelector('[data-alert-refresh]').onclick=sessionTaskHandler(async()=>{if(!current()||!confirmContextChange())return;await loadGovAlerts()})
    if(SESSION?.role==='admin'&&hasCap('manageAlertPolicies'))mountAlertDraftEditor(box,{
      catalog:r,api,current,identity:hostedModelReadContext,requestId:createRequestId,dirty:businessForms,confirmChange:confirmContextChange,
      reload:async()=>{const identity=hostedModelReadContext();await loadGovAlerts();if(identity===hostedModelReadContext()){const target=document.getElementById('alertpolicies');if(target){const p=document.createElement('p');p.setAttribute('role','status');p.textContent='Disabled alert draft save confirmed. Review the refreshed configuration; no notification was sent.';target.prepend(p)}}},
    })
    return
  }
  const pols=r.policies
  box.innerHTML=`<table><thead><tr><th>Alert</th><th>Metric</th><th>Threshold</th><th>Severity</th><th>Owner</th><th>Runbook</th><th></th></tr></thead><tbody>
    ${pols.map(p=>`<tr data-alertpol="${esc(p.id)}" ${p.enabled?'':'style="opacity:.5"'}>
      <td><b>${esc(p.name)}</b>${p.enabled?'':' <span class="chip" style="color:var(--muted)">disabled</span>'}</td>
      <td style="font-size:.78rem">${esc(p.metric)}</td>
      <td style="font-size:.78rem"><code>${esc(p.threshold)}</code></td>
      <td>${sevBadge(p.severity)}</td>
      <td style="font-size:.76rem">${esc(p.owner)}</td>
      <td style="font-size:.72rem;color:var(--muted)"><code>${esc(p.runbook)}</code></td>
      ${authMode()==='cognito'?'':`<td style="text-align:right;white-space:nowrap">
        <button class="ghost aptoggle" data-id="${esc(p.id)}" data-en="${p.enabled?'0':'1'}" style="padding:3px 9px;font-size:.72rem">${p.enabled?'Disable':'Enable'}</button>
        <button class="ghost apdel" data-id="${esc(p.id)}" data-name="${esc(p.name)}" style="padding:3px 9px;font-size:.72rem;color:var(--err)">Remove</button></td>`}</tr>`).join('')}
  </tbody></table>
  <p class="d" style="color:var(--muted);font-size:.72rem;margin-top:8px">${pols.length} alert polic${pols.length===1?'y':'ies'}</p>`
  ;(authMode()==='cognito'?[]:box.querySelectorAll('.aptoggle')).forEach(btn=>btn.onclick=sessionTaskHandler(async()=>{
    btn.disabled=true
    const rr=await api('/alert-policy-update',{id:btn.dataset.id,enabled:btn.dataset.en==='1'})
    if(rr.ok)runSessionTask(loadGovAlerts); else {btn.disabled=false;alert(rr.error||'update failed')}
  }))
  ;(authMode()==='cognito'?[]:box.querySelectorAll('.apdel')).forEach(btn=>btn.onclick=sessionTaskHandler(async()=>{
    if(!confirm(`Remove alert policy "${btn.dataset.name}"?`))return
    btn.disabled=true
    const rr=await api('/alert-policy-remove',{id:btn.dataset.id})
    if(rr.ok)runSessionTask(loadGovAlerts); else {btn.disabled=false;alert(rr.error||'remove failed')}
  }))
  const raci=document.getElementById('alertraci')
  if(raci)raci.innerHTML=`<table><thead><tr><th>Alert class</th><th>Responsible</th><th>Accountable</th><th>Consulted</th><th>Informed</th></tr></thead><tbody>
    ${pols.map(p=>`<tr data-raci="${esc(p.id)}"><td style="font-size:.8rem"><b>${esc(p.name)}</b> ${sevBadge(p.severity)}</td>
      <td style="font-size:.78rem">${esc(p.raci?.responsible||'—')}</td><td style="font-size:.78rem">${esc(p.raci?.accountable||'—')}</td>
      <td style="font-size:.78rem;color:var(--dim)">${esc(p.raci?.consulted||'—')}</td><td style="font-size:.78rem;color:var(--dim)">${esc(p.raci?.informed||'—')}</td></tr>`).join('')}
  </tbody></table>
  <div class="d" style="color:var(--muted);font-size:.72rem;margin-top:8px">Escalation <span class="chip" style="color:var(--muted)">display-only</span>: ${Object.entries(r.escalation||{}).map(([s,t])=>`<div style="padding:2px 0">${sevBadge(s)} ${esc(t)}</div>`).join('')}</div>`
}
function wireGovAlerts(){
  if(authMode()==='cognito')return
  const create=document.getElementById('apcreate'); if(!create)return
  create.onclick=sessionTaskHandler(async()=>{
    const st=document.getElementById('apstatus')
    st.innerHTML='<div class="status info"><span class="spin">⟳</span> creating…</div>'
    const r=await api('/alert-policy-create',{
      name:document.getElementById('apname').value.trim(),
      metric:document.getElementById('apmetric').value.trim(),
      threshold:document.getElementById('apthresh').value.trim(),
      severity:document.getElementById('apsev').value,
      owner:document.getElementById('apowner').value.trim(),
      runbook:document.getElementById('aprunbook').value.trim(),
    })
    if(r.ok){st.innerHTML=`<div class="status ok">✓ Alert policy <b>${esc(r.policy.name)}</b> created (${esc(r.policy.severity)}).</div>`
      businessForms.clear('alertPolicy')
      document.getElementById('apname').value='';document.getElementById('apmetric').value='';document.getElementById('apthresh').value='';runSessionTask(loadGovAlerts)}
    else st.innerHTML=`<div class="status err">${esc(r.error||'create failed')}</div>`
  })
}
// Approve/Reject buttons for one governed row. `ep` = the update endpoint.
// Cloudscape button semantics: Approve = primary (solid blue), Reject =
// normal-destructive (white bg, red border+text), Back to draft = normal.
function govActions(id, status, ep){
  const btn=(label,to,cls,style)=>status===to?'':`<button class="${cls} govact" data-ep="${ep}" data-id="${esc(id)}" data-to="${to}" style="padding:4px 10px;font-size:.75rem${style||''}">${label}</button>`
  return `<div style="display:flex;gap:6px;flex-shrink:0">${btn('Approve','APPROVED','primary')}${btn('Reject','REJECTED','ghost',';color:var(--err);border-color:var(--err)')}${status!=='DRAFT'?btn('Back to draft','DRAFT','ghost'):''}</div>`
}
function wireGovernance(){
  const releaseRefresh=document.getElementById('release-refresh');
  if(releaseRefresh)releaseRefresh.onclick=()=>runSessionTask(()=>mountReleaseDelivery(document.getElementById('governed-release-delivery'),rawApi));
  const sectionButtons=[...document.querySelectorAll('[data-queue-section]')];
  const showSection=id=>{
    if(!sectionButtons.some(button=>button.dataset.queueSection===id))id='publication-requests';
    S.approvalSection=id;
    for(const button of sectionButtons){
      const selected=button.dataset.queueSection===id;
      button.setAttribute('aria-pressed',String(selected));
      const section=document.getElementById(button.dataset.queueSection);if(section)section.hidden=!selected;
    }
  };
  if(sectionButtons.length)showSection(S.approvalSection||'publication-requests');
  sectionButtons.forEach(button=>button.onclick=()=>showSection(button.dataset.queueSection));
  const tabs=()=>Array.from(document.querySelectorAll('.govtab'))
  // Only this view gets a compact mobile site-navigation disclosure. Move
  // the existing nodes so their authorization and click handlers are retained.
  const side=document.getElementById('side')
  if(side){
    const items=document.createElement('div');items.id='gov-site-nav-items'
    while(side.firstChild)items.append(side.firstChild)
    const toggle=document.createElement('button')
    toggle.type='button';toggle.className='ghost gov-site-nav-toggle'
    toggle.textContent='Navigation · Governance'
    toggle.setAttribute('aria-controls',items.id);toggle.setAttribute('aria-expanded','false')
    toggle.onclick=()=>toggle.setAttribute('aria-expanded',String(toggle.getAttribute('aria-expanded')!=='true'))
    side.append(toggle,items)
  }
  // Scroll just the tab strip, not the page. Insets preserve the focus ring.
  const bar=document.querySelector?.('.govtabs')
  const revealSelected=()=>{
    const tab=bar?.querySelector('[aria-selected="true"]')
    if(!tab)return
    const b=bar.getBoundingClientRect(),t=tab.getBoundingClientRect(),inset=6
    if(t.left<b.left+inset)bar.scrollLeft+=t.left-b.left-inset
    else if(t.right>b.right-inset)bar.scrollLeft+=t.right-b.right+inset
  }
  revealSelected()
  if(bar){
    const observer=new ResizeObserver(()=>{
      if(!bar.isConnected){observer.disconnect();return}
      revealSelected()
    })
    observer.observe(bar)
  }
  // Render replaces the old buttons. Re-query before focusing on success;
  // Cancel restores the selected tab (a pointer click focused the target).
  const goTab=async(id)=>{
    const selected=tabs().find(b=>b.getAttribute('aria-selected')==='true')
    if(id===selected?.dataset.tab)return
    if(!confirmContextChange()){selected?.focus();revealSelected();return}
    clearBusinessDrafts();S.govTab=id
    await render()
    document.getElementById(`govtab-${id}`)?.focus()
  }
  tabs().forEach((b,i)=>{
    b.onclick=()=>goTab(b.dataset.tab)
    b.onkeydown=e=>{
      if(e.key!=='ArrowRight'&&e.key!=='ArrowLeft'&&e.key!=='Home'&&e.key!=='End')return
      e.preventDefault()
      const list=tabs()
      const next = e.key==='Home'?0 : e.key==='End'?list.length-1
        : e.key==='ArrowRight'?(i+1)%list.length : (i-1+list.length)%list.length
      goTab(list[next].dataset.tab)
    }
  })
  // The compact hosted Registry/Fleet links reuse the shared `.storynext`
  // click wiring (wire(), module scope) but ship as bare <a data-goview>
  // with no href — not natively focusable/keyboard-activatable. Scope the
  // keyboard fix to this Governance-rendered pair rather than the shared
  // storyLine()/crumb helper used elsewhere (out of scope for this fix).
  document.querySelectorAll('#govtabpanel > .story > a.storynext[data-goview]').forEach(a=>{
    a.tabIndex=0
    a.setAttribute('role','link')
    a.onkeydown=e=>{ if(e.key==='Enter'||e.key===' '){ e.preventDefault(); a.click() } }
  })
}
// SIEM export: timeline filters and authorized paginated reads are shared.
function auditFilterQuery(){
  const params=new URLSearchParams()
  if(S.audFType)params.set('type',S.audFType)
  if(S.audFDomain)params.set('domain',S.audFDomain)
  return params.toString()
}
function auditExportScopeLabel(){
  return `Current timeline filters: type ${S.audFType||'all types'} · domain ${S.audFDomain||'all authorized domains'}. Authorization still limits every read.`
}
function syncAuditExportScope(){
  const label=document.getElementById('audexportscope');if(label)label.textContent=auditExportScopeLabel()
}
function wireGovSiemExport(){
  const siem=document.getElementById('siemexport'); if(!siem)return
  syncAuditExportScope()
  siem.onclick=sessionTaskHandler(async()=>{
    if(siem.disabled)return
    const st=document.getElementById('siemstatus');if(!st)return
    const epoch=sessionEpoch,context=hostedModelReadContext(),query=auditFilterQuery(),revision=st.filterRevision||0,scope=auditExportScopeLabel()
    const attached=()=>st.isConnected&&document.getElementById('siemstatus')===st&&document.getElementById('siemexport')===siem
    const sessionCurrent=()=>sessionEpochIsCurrent(epoch)&&context===hostedModelReadContext()
    const current=()=>attached()&&sessionCurrent()&&query===auditFilterQuery()&&revision===(st.filterRevision||0)
    siem.disabled=true
    st.innerHTML='<div class="status info"><span class="spin">⟳</span> collecting filtered audit metadata…</div>'
    try{
      const x=await api('/integrations-audit-export'+(query?'?'+query:''))
      if(!current())return
      if(x?.ok!==true||!Array.isArray(x.events)){st.innerHTML=`<div class="status err">${esc(x?.error||'Audit export unavailable')}</div>`;return}
      // Also enforce captured filters for local/mock transports which may return a wider stream.
      const filters=new URLSearchParams(query)
      const events=x.events.filter(e=>(!filters.get('type')||e.type===filters.get('type'))&&(!filters.get('domain')||e.domain===filters.get('domain')))
      const blob=new Blob([JSON.stringify(events,null,2)],{type:'application/json'})
      const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download='platform-audit-export.json'
      try{a.click()}finally{URL.revokeObjectURL(a.href)}
      st.innerHTML=`<div class="status ok">Exported <b>${events.length}</b> audit metadata events as JSON. ${esc(scope)} No transcript content or notification delivery evidence is included.</div>`
    }catch(error){
      if(current()&&error!==CANCELED_REQUEST)st.innerHTML='<p role="alert">Audit export failed. Retry the read.</p>'
    }finally{
      if(attached())siem.disabled=false
      if(attached()&&sessionCurrent()&&!current())st.innerHTML='<p role="status">Filters changed. Export cancelled; retry for the current timeline.</p>'
    }
  })
}
async function loadGovernance(){
  const tab=activeGovTab()
  // The decision inbox loads every approval type it renders: registry/deploy
  // queue, resource-access requests, and (platform) the 4-eyes queues.
  if(tab==='queue'){
    if(authMode()==='cognito')runSessionTask(()=>mountReleaseDelivery(document.getElementById('governed-release-delivery'),rawApi))
    runSessionTask(loadGovQueue); if(authMode()!=='cognito')runSessionTask(loadGovResources)
    wireRequests(); runSessionTask(loadRequests); runSessionTask(loadDomainEscalations); runSessionTask(loadDomainPolicy)
    runSessionTask(loadApprovals)
    if(hasCap('viewAllDomains'))runSessionTask(loadBlueprintSubmissions)
  }
  else if(tab==='policies'){ wireHitl(); runSessionTask(loadHitl); if(authMode()==='cognito'){runSessionTask(loadRuntimePolicies);wirePolicyNavigation()}else{runSessionTask(loadGovPolicyEngines)};const b=document.querySelector('[data-policy-queue]');if(b)b.onclick=()=>{if(!confirmContextChange())return;S.govTab='queue';render()} }
  else if(tab==='guardrails')runSessionTask(loadGovGuardrails)
  else if(tab==='audit'){ wireAudit(); runSessionTask(loadAudit); runSessionTask(loadGovAuditTab); wireGovSiemExport(); runSessionTask(loadGovCompliance) }
}
// All pending consumers use the same sources, validation and identity rules.
async function readGovPendingWork(){
  const hosted=authMode()==='cognito'
  const read=async task=>{
    try{return await task()}catch(error){
      if(error===CANCELED_REQUEST)throw error
      return {ok:false}
    }
  }
  const [reg,approvalResult,hitl]=await Promise.all([
    read(()=>api('/registry')),
    hosted?read(()=>readHostedCollection('approvals')):Promise.resolve({ok:true,items:[]}),
    hosted?Promise.resolve(null):read(()=>api('/hitl')),
  ])
  return {reg,approvals:approvalResult,projection:projectPendingWork({registry:reg,approvals:approvalResult,hitl,hosted})}
}
function pendingWorkSummaryHtml(projection){
  return `<p role="status" data-pending-count="${projection.count??'unknown'}">${projection.complete
    ?`${projection.count} pending decision${projection.count===1?'':'s'}`
    :`${projection.knownCount} pending${projection.problems&&projection.problems.length?` · ${projection.problems.map(p=>p.replace(' pending work is unavailable or incomplete.','')).join(', ')} data unavailable`:''}`}</p>`
}
async function loadGovQueue(){
  const box=document.getElementById('govqueue'); if(!box)return
  const hosted=authMode()==='cognito'
  const epoch=sessionEpoch, context=hostedModelReadContext(), request=(box.queueRequest||0)+1;box.queueRequest=request
  const current=()=>sessionEpochIsCurrent(epoch)&&context===hostedModelReadContext()&&box.isConnected&&document.getElementById('govqueue')===box&&box.queueRequest===request
  const {reg,projection}=await readGovPendingWork()
  if(!current())return
  const unavailable=projection.problems
  const pendingApprovals=projection.rows.filter(row=>row.kind==='approval').map(row=>row.approval)
  const canDecideRegistry=hasCap('approveRegistryVersion')
  const items=[]
  for(const row of projection.rows.filter(row=>row.kind==='registry')){
    const {entry:e,version:v}=row
    if(hosted&&!registryDecisionAllowed(e,v,{hosted,canDecide:canDecideRegistry}))continue
    items.push({when:row.at,html:`<div class="item" style="margin-bottom:8px;display:flex;justify-content:space-between;align-items:center;gap:10px" data-queue="reg-${esc(e.id)}-${esc(v.semver)}">
        <div><h4>${REG_TYPE_ICON[e.type]||ic2(ICONS.registry)} ${esc(e.name)} <code>v${esc(v.semver)}</code> ${regStatusBadge('IN_REVIEW')}</h4>
          <div class="meta"><span class="chip type">${esc(e.type)}</span><span class="chip">by ${esc(v.createdBy||'—')}</span><span class="chip">${row.at?esc(row.at.slice(0,19).replace('T',' ')):'Submission date unknown'}</span><span class="chip" style="color:var(--dim)">${esc(v.changelog||'')}</span></div></div>
        ${registryDecisionAllowed(e,v,{hosted,canDecide:canDecideRegistry})?`<div style="display:flex;gap:6px;flex-shrink:0">
          <button class="primary qreg" data-id="${esc(e.id)}" data-semver="${esc(v.semver)}" data-d="approve" style="padding:4px 10px;font-size:.75rem">Approve</button>
          <button class="ghost qreg" data-id="${esc(e.id)}" data-semver="${esc(v.semver)}" data-d="reject" style="padding:4px 10px;font-size:.75rem;color:var(--err);border-color:var(--err)">Reject</button>
        </div>`:hosted?'<p>Read-only here. Open this native resource in AI Registry for its supported publication workflow.</p>':''}</div>`})
  }
  for(const row of projection.rows.filter(row=>row.kind==='hitl')){
    const p=row.pending
    items.push({when:row.at,html:`<div class="item" style="margin-bottom:8px;display:flex;justify-content:space-between;align-items:center;gap:10px" data-queue="hitl-${esc(p.requestId)}" data-pending="${esc(p.requestId)}">
      <div><h4>${HAND_IC}<code>${esc(p.toolName)}</code> from <b>${esc(p.project)}</b> ${hitlBadge('pending')}</h4>
        <div class="meta"><span class="chip">policy: ${esc(p.policyName)}</span><span class="chip">${esc((p.requestedAt||'').slice(0,19).replace('T',' '))}</span>${p.toolInputSummary?`<span class="chip" style="color:var(--dim)">${esc(p.toolInputSummary)}</span>`:''}</div></div>
      <div style="display:flex;gap:6px;flex-shrink:0">
        <button class="primary hdec" data-id="${esc(p.requestId)}" data-d="approved" style="padding:4px 10px;font-size:.75rem">Approve</button>
        <button class="ghost hdec" data-id="${esc(p.requestId)}" data-d="rejected" style="padding:4px 10px;font-size:.75rem;color:var(--err);border-color:var(--err)">Reject</button>
      </div></div>`})
  }
  for(const approval of pendingApprovals){
    items.push({
      when:projection.rows.find(row=>row.approval===approval).at,
      html:hostedCollectionItems('approvals',[approval],{compact:true,
        approvalActions:true,
      })+(!['RESOURCE_PUBLICATION','PRODUCTION_DEPLOYMENT','RESOURCE_ACCESS'].includes(approval.kind)
        ?'<p class="d">This approval kind is read-only here; a decision workflow is unavailable.</p>':''),
    })
  }
  items.sort((a,b)=>String(a.when||'z').localeCompare(String(b.when||'z')))
  box.innerHTML=pendingWorkSummaryHtml(projection)+(unavailable.length
    ?`<p role="status">${unavailable.join(' ')} Queue is incomplete. <button class="ghost" data-queue-retry>Retry</button></p>`
    :'')+(items.map(x=>x.html).join('')||((hosted?projection.sources?.approvals.complete!==true:unavailable.length)
      ?'<div class="empty">Request status unavailable. Retry to check for existing requests.</div>'
      :'<div class="empty">No formal approval requests in this scope.</div>'))
  if(hosted){
    const resourceRows=projection.rows.filter(row=>row.kind==='registry'&&!registryDecisionAllowed(row.entry,row.version,{hosted,canDecide:canDecideRegistry}))
    if(resourceRows.length){
      const section=document.createElement('section')
      // These records are pending in the Registry but have no formal review
      // request yet — the 4-eyes step nobody could see. Say what the reviewer
      // is looking at and what happens next, instead of raw registry ids.
      section.innerHTML=`<h3>Awaiting review initiation (${resourceRows.length})</h3>
        <p class="d" style="color:var(--muted);font-size:.76rem;margin:2px 0 8px">These resources are pending in the AI Registry but no formal review request exists yet. ${SESSION?.role==='admin'?'Initiate the review to file the request — a <b>different</b> platform admin then approves or rejects it in this queue (4-eyes).':'The resource owner or a platform admin files the review request; it then appears here for decision.'}</p>`
      for(const row of resourceRows){
        const article=document.createElement('article');article.className='item'
        const meta=row.version?.content?.card||{}
        article.innerHTML=`<h4>${esc(row.entry.name||row.entry.id)} · v${esc(row.version.semver)} ${regStatusBadge('IN_REVIEW')}</h4>
          <div class="meta" style="margin:4px 0"><span class="chip type">${esc(row.entry.type)}</span><span class="chip">${esc(row.entry.domain==='shared'?'shared catalog':row.entry.domain||'domain unknown')}</span>${row.entry.domainOwner?`<span class="chip">owner: ${esc(row.entry.domainOwner)}</span>`:''}</div>
          ${row.entry.description?`<p class="d" style="font-size:.78rem;color:var(--dim);margin:2px 0 6px">${esc(row.entry.description)}</p>`:''}
          <details><summary style="font-size:.76rem;cursor:pointer">Reviewer details</summary><dl>
            ${meta.url||meta.documentationUrl?`<dt>Endpoint</dt><dd>${esc(meta.url||meta.documentationUrl)}</dd>`:''}
            <dt>Registry record</dt><dd><code style="font-size:.72rem">${esc(row.identity)}</code></dd>
            <dt>Status</dt><dd>${row.requestLinkage==='absent'?(SESSION?.role==='admin'?'Pending in Registry · review request not yet filed':'Pending in Registry · request not visible in this scope'):'Request status unavailable'}</dd>
          </dl></details>
          ${row.requestLinkage==='absent'?'<button class="primary" data-publication-check style="padding:5px 14px;font-size:.78rem">Initiate review</button>':'<p>Retry to check for an existing request.</p><button class="ghost" data-queue-retry>Retry</button>'}<div data-publication-context></div>`
        section.append(article)
        if(row.requestLinkage==='absent')mountPublicationSubmission(article,{row,api,readApprovals:()=>readHostedCollection('approvals'),current,
          access:{role:SESSION?.role,resourceDomain:row.entry.domain,activeDomain:activeDomain(),capabilities:hostedCaps()},
          identity:()=>`${sessionEpoch}:${SESSION?.actor||SESSION?.user}:${SESSION?.role}:${activeDomain()}:${hostedCaps().join(',')}`,
          requestId:createRequestId,reload:loadGovQueue})
      }
      box.append(section)
    }
  }
  box.querySelectorAll('[data-queue-retry]').forEach(button=>button.onclick=()=>{
    if(current())runSessionTask(loadGovQueue)
  })
  box.querySelectorAll('.qreg').forEach(btn=>btn.onclick=sessionTaskHandler(async()=>{
    if(!current())return
    btn.disabled=true
    const reason=btn.dataset.d==='reject'
      ?(await requestDemoChoice('approvalRejection','Reason for rejection?')||'')
      :''
    if(!current())return
    const requestId=createRequestId()
    const candidates=(reg.entries||[]).filter(row=>row.id===btn.dataset.id)
    const entry=candidates.length===1?candidates[0]:null
    const matches=(entry?.versions||[]).filter(row=>row.semver===btn.dataset.semver)
    if(matches.length!==1||!await revalidateRegistryDecision(entry,matches[0])){
      if(!current())return
      btn.disabled=false;alert('This record is stale, read-only, or no longer authorized. Refresh the approval queue.');return
    }
    if(!current())return
    const payload={id:btn.dataset.id,semver:btn.dataset.semver,decision:btn.dataset.d,reason,
      ...(hosted?{registryId:matches[0]._aws.registryId,recordId:matches[0]._aws.recordId}:{})}
    const r=await api('/registry-decide',payload,{requestId})
    if(!current())return
    if(r.ok)runSessionTask(loadGovQueue); else {btn.disabled=false;alert(apiErrorMessage(r,'decision failed'))}
  }))
  box.querySelectorAll('.hdec').forEach(btn=>btn.onclick=sessionTaskHandler(async()=>{
    btn.disabled=true
    const reason=btn.dataset.d==='rejected'
      ?(await requestDemoChoice('approvalRejection','Reason for rejection (optional)')||'')
      :''
    const r=await api('/hitl-decide',{requestId:btn.dataset.id,decision:btn.dataset.d,reason})
    if(r.ok)runSessionTask(loadGovQueue); else {btn.disabled=false;alert(r.error||'decide failed')}
  }))
  if(hosted)wireHostedApprovalActions(box,loadGovQueue,pendingApprovals)
  runSessionTask(loadGovMemBacklog)
}
// Promotion approvals (Scene 8, domain-level): prod-
// promote CI runs frozen on the S3-brokered hitl-gate render in the DOMAIN
// detail view — the domain owner reviews promotions of her domain's projects;
// the builder who requested never approves. Approve/Deny writes the decision
// object the gate job is polling for; canDecide comes server-resolved
// (the decide POST re-checks RBAC regardless).
async function loadDomainPromotions(domainId){
  const box=document.getElementById('dompromos'); if(!box)return
  if(authMode()==='cognito')return loadHostedPromotionRecords(box,{domainId})
  const r=await api('/hitl-promotions?domain='+encodeURIComponent(domainId))
  const pending=r.pending||[]
  const actions=p=>r.canDecide?`<div style="display:flex;gap:6px;flex-shrink:0">
      <button class="primary pdec" data-id="${esc(p.run_id)}" data-d="approve" style="padding:4px 10px;font-size:.75rem">Approve</button>
      <button class="ghost pdec" data-id="${esc(p.run_id)}" data-d="deny" style="padding:4px 10px;font-size:.75rem;color:var(--err);border-color:var(--err)">Deny</button>
    </div>`:`<span class="chip" style="color:var(--lock);border-color:var(--lock-bd);flex-shrink:0">${ic2(ICONS.lock)}decided by the domain owner</span>`
  box.innerHTML=pending.map(p=>`<div class="item" style="margin-bottom:8px;display:flex;justify-content:space-between;align-items:center;gap:10px" data-promo="${esc(p.run_id)}">
    <div><h4>${HAND_IC}Promote to <b>${esc(p.environment)}</b> ${hitlBadge('pending')}</h4>
      <div class="meta"><span class="chip">${esc(p.repo)}</span><span class="chip">run ${esc(p.run_id)}</span><span class="chip"><code>${esc((p.sha||'').slice(0,12))}</code></span><span class="chip">by ${esc(p.requester||'—')}</span><span class="chip">${esc((p.requested_at||'').slice(0,19).replace('T',' '))}</span>${p.project?'':'<span class="chip" style="color:var(--muted)">external repo — unmapped, platform inbox</span>'}</div></div>
    ${actions(p)}</div>`).join('')||'<div class="empty">No CI run is waiting on a promotion approval.</div>'
  box.querySelectorAll('.pdec').forEach(btn=>btn.onclick=sessionTaskHandler(async()=>{
    btn.disabled=true
    const reason=btn.dataset.d==='deny'
      ?(await requestDemoChoice('approvalRejection','Reason for denial (optional)')||'')
      :''
    const rr=await api('/hitl-promotion-decide',{run_id:btn.dataset.id,decision:btn.dataset.d,reason})
    if(rr.ok)runSessionTask(()=>loadDomainPromotions(domainId)); else {btn.disabled=false;alert(rr.error||'decide failed')}
  }))
}
// Builder side of the same gate: the WORKSPACE shows a read-only "CD frozen"
// strip while a promotion of this project awaits the domain owner. No
// buttons by design — requester ≠ approver, the builder watches, the owner
// decides in the Domain view.
async function loadWorkspacePromoStrip(p){
  const box=document.getElementById('wspromostrip'); if(!box)return
  if(authMode()==='cognito')return loadHostedPromotionRecords(box,{domainId:p.domain,projectId:p.id})
  const r=await api('/hitl-promotions?domain='+encodeURIComponent(p.domain))
  const mine=(r.pending||[]).filter(x=>x.project===p.id||(p.agents||[]).includes(x.project))
  box.innerHTML=mine.map(x=>`<div class="card" data-promowait="${esc(x.run_id)}" style="border-left:3px solid var(--lock);margin-bottom:12px;padding:10px 14px">
    <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
      <b style="font-size:.85rem">${ic2(ICONS.lock)}Promote to ${esc(x.environment)} — waiting for domain approval</b>
      <span class="chip" style="color:var(--lock);border-color:var(--lock-bd)">CD frozen</span>
      <span class="chip">requested ${esc((x.requested_at||'').slice(0,19).replace('T',' '))}</span>
      <span class="chip">run ${esc(x.run_id)}</span>
      <span class="chip"><code>${esc((x.sha||'').slice(0,12))}</code></span>
    </div>
    <div class="d" style="color:var(--dim);font-size:.74rem;margin-top:4px">The ${esc(domainLabel(x.domain))} domain owner reviews this in the Domain view — the pipeline resumes on approval.</div>
  </div>`).join('')
}
async function loadHostedPromotionRecords(box,{domainId,projectId}){
  const epoch=sessionEpoch
  const current=()=>sessionEpochIsCurrent(epoch)&&box.isConnected
  try{
    const result=await readHostedCollection('approvals')
    if(!current())return
    if(result?.ok!==true||!Array.isArray(result.items)){
      box.innerHTML='<div class="empty">Production approval status is unavailable.</div>';return
    }
    const rows=result.items.filter(row=>row.kind==='PRODUCTION_DEPLOYMENT'
      &&row.resourceType==='DEPLOYMENT'&&row.domainId===domainId
      &&(!projectId||row.projectId===projectId)&&row.status==='PENDING')
    box.innerHTML=rows.length
      ?`<div class="card"><h3>Pending production approval</h3>${hostedCollectionItems('approvals',rows,{approvalActions:false,compact:true})}</div>`
      :projectId?'':'<div class="empty">No pending production approval requests in this domain.</div>'
  }catch(error){
    if(error===CANCELED_REQUEST||!current())return
    box.innerHTML='<div class="empty">Production approval status is unavailable.</div>'
  }
}
// R-015 backlog badge: unattributed (domain:null) stores are a GOVERNANCE
// task — count them here. B23: the platform Memory Stores page (and its
// Attribute owner UI) is removed; attribution runs through the platform API
// (POST /api/memory-attribute), which stays live and audited.
async function loadGovMemBacklog(){
  // Hosted memory bindings are scoped to agent workspaces; there is no
  // organization-wide memory attribution endpoint in the hosted service.
  if(authMode()==='cognito')return
  const box=document.getElementById('govmembacklog'); if(!box||!hasCap('attributeMemoryStores'))return
  const r=await api('/memories')
  const n=(r.memories||[]).filter(m=>m.domain==null).length
  box.innerHTML = n ? `<div class="item" style="margin-top:8px" data-membacklog="${n}">
    <div><h4>${MEM_IC}<span class="chip" style="color:var(--lock);border-color:var(--lock-bd);font-weight:600">${n} store${n===1?'':'s'} need${n===1?'s':''} an owner</span></h4>
      <div class="d" style="font-size:.76rem;color:var(--dim);margin-top:4px">Unattributed memory stores are content-locked for everyone until a domain claims them.</div></div>
  </div>` : ''
}
// Audit-trail tab: the HITL + registry decision log with its per-agent filter.
async function loadGovAuditTab(){
  if(authMode()==='cognito'){
    const box=document.getElementById('hitlaudit');if(box)box.innerHTML='<p>Tool-interrupt decision history is not configured. Publication and access decisions appear in the audit timeline above.</p>'
    for(const id of ['haagent','hastatus']){const el=document.getElementById(id);if(el)el.disabled=true}
    const exportButton=document.getElementById('siemexport');if(exportButton){exportButton.disabled=false;exportButton.textContent='Export audit metadata (JSON)'}
    return
  }
  const fleet=await api('/fleet')
  const projects=[...new Set((fleet.agents||[]).map(a=>a.project||a.name))]
  const filt=document.getElementById('haagent')
  if(filt){const cur=filt.value;filt.innerHTML='<option value="">All agents</option>'+projects.map(p=>`<option value="${esc(p)}">${esc(p)}</option>`).join('');filt.value=cur}
  const f1=document.getElementById('haagent'),f2=document.getElementById('hastatus')
  if(f1)f1.onchange=sessionTaskHandler(loadHitlAudit)
  if(f2)f2.onchange=sessionTaskHandler(loadHitlAudit)
  runSessionTask(loadHitlAudit)
}
// Compliance reporting (§7.6): derived counts, no new store — enough to answer
// "is the platform in a governable state", not a BI tool.
async function loadGovCompliance(){
  const box=document.getElementById('gcompliance'); if(!box)return
  const epoch=sessionEpoch,context=hostedModelReadContext(),request=(box.pendingRequest||0)+1;box.pendingRequest=request
  const current=()=>sessionEpochIsCurrent(epoch)&&context===hostedModelReadContext()&&box.isConnected&&document.getElementById('gcompliance')===box&&box.pendingRequest===request
  const optionalRead=path=>api(path).catch(error=>{if(error===CANCELED_REQUEST)throw error;return {ok:false}})
  const [{projection,approvals},localSubs]=await Promise.all([readGovPendingWork(),authMode()==='cognito'?Promise.resolve(null):optionalRead('/blueprint-submissions')])
  const subs=authMode()==='cognito'?(approvals?.ok===true&&Array.isArray(approvals.items)&&approvals.cursor===null&&!projection.problems.some(p=>p.startsWith('Hosted approvals'))?{ok:true,submissions:approvals.items.filter(a=>a.kind==='RESOURCE_PUBLICATION'&&a.resourceType==='BLUEPRINT'&&a.domainId==='platform').map(a=>({...a,status:a.status==='PENDING'?'pending_approval':a.status.toLowerCase()}))}:{ok:false}):localSubs
  if(!current())return
  const entries=projection.entries
  // entries come from the projection, so "did the registry read succeed" is the
  // projection's own Registry problem signal — not the raw read envelope.
  const entriesAvailable=!projection.problems.some(problem=>problem.startsWith('Registry'))
  const submissionsAvailable=subs?.ok===true&&Array.isArray(subs.submissions)
  const submissions=submissionsAvailable?subs.submissions:[]
  const statuses=['DRAFT','IN_REVIEW','APPROVED','REJECTED','DEPRECATED']
  const types=[...new Set(entries.map(e=>e.type))]
  const cell=(t,s)=>entries.filter(e=>e.type===t).reduce((n,e)=>n+(e.versions||[]).filter(v=>v.status===s).length,0)
  const stChip=(s,n)=>`<span class="chip" style="${s==='APPROVED'?'color:var(--ok);border-color:var(--ok-bd)':s==='IN_REVIEW'?'color:var(--lock);border-color:var(--lock-bd)':s==='REJECTED'?'color:var(--err);border-color:var(--err-bd)':'color:var(--muted)'}">${n} ${s}</span>`
  // per-type lifecycle count cards + the per-status table render from the
  // same cell() closure, so the two never disagree with each other or the API.
  const typeCards=`<div class="grid3" style="margin-bottom:10px">${types.map(t=>{
    const total=statuses.reduce((n,s)=>n+cell(t,s),0)
    return `<div class="item" data-compcard="${esc(t)}"><h4>${REG_TYPE_ICON[t]||''} ${esc(t)}</h4>
      <div style="font-size:1.5rem;font-weight:600;margin:2px 0" data-compcard-total="${total}">${total}</div>
      <div class="meta">${statuses.map(s=>{const n=cell(t,s);return n?stChip(s,n):''}).join('')||'<span class="chip" style="color:var(--muted)">no versions</span>'}</div></div>`
  }).join('')}</div>`
  const lifecycle=`<table><thead><tr><th>Type</th>${statuses.map(s=>`<th>${s}</th>`).join('')}</tr></thead><tbody>
    ${types.map(t=>`<tr data-comp="${esc(t)}"><td>${REG_TYPE_ICON[t]||''} <b>${esc(t)}</b></td>${statuses.map(s=>{const n=cell(t,s);return `<td style="${n?'':'color:var(--muted)'}">${n||'—'}</td>`}).join('')}</tr>`).join('')}
  </tbody></table>`
  const pendingDetails=projection.rows.filter(row=>row.kind==='approval').map(({approval:a,at})=>`<tr data-compliance-request="${esc(a.id)}"><td><b>${esc(a.id)}</b><div class="d">${esc(({RESOURCE_ACCESS:'Resource access',RESOURCE_PUBLICATION:'Resource publication',PRODUCTION_DEPLOYMENT:'Production deployment',DEPLOYMENT:'Deployment'})[a.kind]||a.kind)}</div></td><td>${esc(a.domainId)}${a.projectId?' / '+esc(a.projectId):''}</td><td>${esc(a.resourceType)}<br><code>${esc(a.resourceId)}</code></td><td>${esc(a.requesterSubject)}</td><td>${at?esc(at.slice(0,19).replace('T',' ')):'Submission date unknown'}</td></tr>`).join('')
  const pendingTable=`<div class="sec-h">Pending approval details</div>${pendingDetails?`<div style="overflow-x:auto"><table><thead><tr><th>Request / type</th><th>Domain / project</th><th>Resource</th><th>Requested by</th><th>Submitted</th></tr></thead><tbody>${pendingDetails}</tbody></table></div>`:projection.sources.approvals.complete?'<p>No pending approval requests in this scope.</p>':'<p>Approval requests are unavailable. Refresh to retrieve their details.</p>'}`
  const reviewDetails=projection.rows.filter(row=>row.kind==='registry').map(row=>`<li><b>${esc(row.label)}</b> · ${esc(row.entry.type)} · ${esc(row.entry.domain)} · <code>${esc(row.identity)}</code></li>`).join('')
  const reviewTable=reviewDetails?`<details><summary>Registry versions awaiting review initiation (${projection.resourceReviewCount})</summary><p>These versions have no linked pending publication request in the readable approval records.</p><ul>${reviewDetails}</ul></details>`:''
  const oldest=projection.oldest
  const ageDays=oldest?Math.floor((Date.now()-Date.parse(oldest.at))/86400000):null
  const pendingSubs=submissions.filter(s=>s.status==='pending_approval').length
  box.innerHTML=`<p>Operational governance snapshot, not a compliance certification. Approval visibility does not grant decision authority.</p><button class="ghost" id="gcomprefresh">Refresh governance snapshot</button>${pendingWorkSummaryHtml(projection)}${projection.problems.length?`<p role="status">${esc(projection.problems.join(" "))}</p>`:""}${entriesAvailable||entries.length?`${!entriesAvailable?'<p role="status">Readable registry entries only; lifecycle counts below are partial.</p>':''}${typeCards}`:''}${pendingTable}${reviewTable}
  <div class="sec-h">Version lifecycle per registry type</div>${entriesAvailable||entries.length?lifecycle:'<p>Registry inventory is incomplete; lifecycle totals are unknown.</p>'}
  <div class="grid3" style="margin-top:14px">
    <div class="item" id="gcompsla" data-sla-days="${ageDays??''}">
      <h4>${HG_IC}Oldest known unreviewed submission ${ageDays===null?'':`<span class="chip">${ageDays}d elapsed</span>`}</h4>
      <p>No review SLA is configured here; elapsed time is not a breach or compliance result.</p>
      <div class="d" style="font-size:.82rem;margin-top:4px">${oldest?`<b>${esc(oldest.label)}</b> — waiting since ${esc((oldest.at||'').slice(0,19).replace('T',' '))}`:projection.complete&&!projection.rows.length?'Nothing is waiting for review.':'Oldest submission unknown.'}</div>
      ${projection.unknownDates?`<p>${projection.unknownDates} pending submission date(s) unknown.</p>`:''}
      ${!projection.complete?'<p>Oldest overall unknown: pending sources are incomplete.</p>':''}
      ${oldest?`<div class="bar" style="margin-top:8px"><button class="ghost" id="gcomp2queue" style="padding:4px 12px;font-size:.75rem">Review in Approval queue →</button></div>`:''}</div>
    <div class="item" id="gcompwiring" data-wired-pct=""><h4>${SHIELD_IC}Runtime guardrail evidence</h4><p>Not verified. Blueprint settings and project membership do not prove runtime binding or enforcement.</p></div>
    <div class="item" data-gcsubs="${submissionsAvailable?pendingSubs:'unknown'}"><h4>${FOLDER_IC}Platform blueprint submissions</h4>
      <div style="font-size:1.5rem;font-weight:600;margin:2px 0">${submissionsAvailable?pendingSubs:'Unknown'}</div>
      <div class="d" style="font-size:.78rem;color:var(--dim)">pending approval · ${submissionsAvailable?submissions.filter(s=>s.status==='approved').length:'unknown'} approved · ${submissionsAvailable?submissions.filter(s=>s.status==='rejected').length:'unknown'} rejected — decided under Platform approvals${submissionsAvailable?'':' · Source unavailable; counts unknown'}</div><button class="ghost" id="gcomp2platform">Open Platform approvals →</button></div>
  </div>
  <div class="bar" style="margin-top:12px">
    <button class="ghost" id="gcomp2audit" style="padding:5px 14px;font-size:.76rem">Open audit trail →</button>
    <button class="ghost" id="gcomp2queue2" style="padding:5px 14px;font-size:.76rem">Open Approval queue →</button>
  </div>
  <p class="d" style="color:var(--muted);font-size:.72rem;margin-top:10px">${entriesAvailable?`${entries.length} registry entr${entries.length===1?'y':'ies'}`:'registry entries unknown'} · ${submissionsAvailable?`${submissions.length} blueprint submission${submissions.length===1?'':'s'}`:'blueprint submissions unknown'}</p>`
  const go=t=>()=>{ if(!confirmContextChange())return;S.govTab=t; render() }
  document.getElementById('gcomprefresh')?.addEventListener('click',async()=>{if(!current()||!confirmContextChange())return;const button=document.getElementById('gcomprefresh');if(button.disabled)return;button.disabled=true;try{clearHostedRegistryReadCache();await loadGovCompliance()}finally{if(button.isConnected)button.disabled=false}})
  document.getElementById('gcomp2platform')?.addEventListener('click',go('exemptions'))
  document.getElementById('gcomp2queue')?.addEventListener('click',go('queue'))
  document.getElementById('gcomp2queue2')?.addEventListener('click',go('queue'))
  document.getElementById('gcomp2audit')?.addEventListener('click',go('audit'))
}
async function loadGovResources(){
  const box=document.getElementById('govagents'); if(!box)return
  if(authMode()==='cognito'){
    for(const id of ['govagents','govmcp','gova2a']){
      const target=document.getElementById(id)
      if(target)target.innerHTML='<div class="empty">This hosted inventory is unavailable here. Open AI Registry to review its resource records and supported workflows.</div>'
    }
    return
  }
  const g=await api('/governance')
  const modeEl=document.getElementById('govstoremode')
  if(modeEl&&g.source==='aws')modeEl.innerHTML='Registry-backed resources persist in AgentCore <span class="chip" style="color:var(--accent);border-color:var(--accent-bd)">live AWS</span>; gateway resources are discovered from their live gateways.'
  const row=(icon,title,meta,status,actions)=>`<div class="item" style="margin-bottom:8px;display:flex;justify-content:space-between;align-items:center;gap:10px" data-gov="${esc(title)}">
    <div><h4>${icon} ${esc(title)} ${mcpBadge(status)}</h4><div class="meta">${meta}</div></div>${actions}</div>`
  box.innerHTML=(g.agents||[]).map(a=>row(ic2(ICONS.agents),a.name,
    `<span class="chip">runtime: ${esc(a.status)}</span>${a.project?`<span class="chip">project: ${esc(a.project)}</span>`:'<span class="chip">no local source</span>'}`,
    a.approval,govActions(a.name,a.approval,'/agent-status'))).join('')
    ||'<div class="empty">No deployed agents on the platform.</div>'
  // MCP/A2A rows read from the unified AI Registry: the status shown is the
  // resolved default version's. Lifecycle changes go through the registry
  // workflow — propose/submit in AI Registry, decide in the Approval queue —
  // so these rows carry no direct approve/reject buttons.
  const regNote='<span class="chip" style="color:var(--muted)">lifecycle: AI Registry → Approval queue</span>'
  const mbox=document.getElementById('govmcp')
  if(mbox)mbox.innerHTML=(g.mcp||[]).map(s=>row(ic2(ICONS.plug),s.name,
    `<span class="chip">${esc(s.url||'')}</span><span class="chip">owner: ${esc(s.owner||'—')}</span>${s.semver?`<span class="chip">v${esc(s.semver)}</span>`:''}${regNote}`,
    s.status,'')).join('')||'<div class="empty">No MCP servers registered.</div>'
  const abox=document.getElementById('gova2a')
  if(abox)abox.innerHTML=(g.a2a||[]).map(a=>row(ic2(ICONS.handshake),a.name,
    `<span class="chip">${esc(a.baseUrl||'')}</span><span class="chip">owner: ${esc(a.owner||'—')}</span>${a.semver?`<span class="chip">v${esc(a.semver)}</span>`:''}${regNote}`,
    a.status,'')).join('')||'<div class="empty">No A2A agents registered.</div>'
  document.querySelectorAll('.govact').forEach(btn=>btn.onclick=sessionTaskHandler(async()=>{
    btn.disabled=true
    const r=await api(btn.dataset.ep,{id:btn.dataset.id,status:btn.dataset.to})
    if(r.ok)runSessionTask(loadGovResources); else {btn.disabled=false;alert(r.error||'update failed')}
  }))
}

// ---------- Domains (T12: WS-A2 vending — the L3 scale proof) ----------
// Hosted creation provisions a real Agent Registry and persists the domain
// metadata. Cognito group membership is a separate onboarding action.
function vDomains(){
  const canCreate=authMode()==='cognito'
    ? hostedActionEnabled('createDomain',hostedCaps())
    : hasCap('createDomain')
  // F1: drill-down — a selected domain renders the detail page instead of the roster.
  if(authMode()!=='cognito'&&S.domainDetail) return vDomainDetail()
  if(S.who==='builder') return `<span class="roletag dom">Domain team · application plane</span><h1>My Domain</h1>
  <p class="subtitle">Members, access grants, token budget and projects for your domain.</p>
  ${storyLine('','fleet','Your Agent Fleet')}
  ${scopeNote()}
  <div class="card"><div class="sec-h" style="margin-top:0">Your domain</div>
    <div id="domroster"><div class="empty"><span class="spin">⟳</span> loading domains…</div></div></div>
  <div class="card"><div class="sec-h" style="margin-top:0">Other domains <span class="chip">directory only</span></div>
    <div id="domdirectory"></div></div>`
  return `<span class="roletag plat">Platform team · control plane</span><h1>Domains</h1>
  <p class="subtitle">Governance boundaries — members, grants, quotas and data isolation are enforced per domain.</p>
  ${storyLine('','cost','Watch their budget in Cost')}
  <div class="card"><div class="sec-h" style="margin-top:0">Domain roster</div>
    <div id="domroster"><div class="empty"><span class="spin">⟳</span> loading domains…</div></div></div>
  ${canCreate?`<div class="card"><div class="sec-h" style="margin-top:0">Create a domain</div>
    <div class="grid2">
      <div><label style="margin-top:0">Domain name</label><input id="dname" data-demo-assist-field="domainName" placeholder="e.g. Finance"/></div>
      <div><label style="margin-top:0">Owner</label><input id="downer" placeholder="e.g. Finance domain team"/></div>
      <div><label>Cognito group</label><input id="dgroup" placeholder="domain-finance"/></div>
      <div><label>Monthly token budget (optional)</label><input id="dbudget" data-demo-assist-field="domainMonthlyTokenBudget" placeholder="e.g. 500000"/></div>
    </div>
    <label>Description</label><input id="ddesc" data-demo-assist-field="domainDescription" placeholder="What does this domain's team build?"/>
    <div style="margin-top:12px"><button id="dcreate">Create domain</button></div>
    <div id="domstatus"></div></div>`:''}`
}
async function loadDomainRoster(){
  const box=document.getElementById('domroster'); if(!box)return
  let r
  try{
    r=await api('/domains')
  }catch(error){
    if(error===CANCELED_REQUEST)return
    if(authMode()!=='cognito')throw error
    renderDomainRosterUnavailable(box)
    return
  }
  if(!Array.isArray(r.domains)){
    if(authMode()==='cognito')renderDomainRosterUnavailable(box)
    else box.innerHTML='<div class="empty">Could not load domains.</div>'
    return
  }
  const hosted=authMode()==='cognito'
  S.domains=r.domains
  S.domainDirectory=r.directory||r.domains
  // F1: domain cards are clickable — click opens the domain detail drill-down.
  // F3: each card names its owning team (Platform team vs domain team).
  box.innerHTML=r.domains.map(d=>{
    const memberChips=hosted?'':(d.users||[]).map(u=>`<span class="chip" style="color:var(--dom);border-color:var(--dom-bd)">${esc(u.name)} · ${u.role==='lead'?'Domain Lead':'Builder'}</span>`).join('')
    const tokenBudget=Number(d.tokenBudget)
    return `<div class="item${hosted?'':' pick'}" style="margin-bottom:8px" ${hosted?'':`data-domain="${esc(d.id)}"`}>
    <h4>${TAG_IC}${esc(d.name)} <span class="chip">${esc(d.id)}</span>${d.id==='platform'?'<span class="chip" style="color:var(--plat);border-color:var(--plat-bd)">platform-owned</span>':''}${d.vendedAt?'<span class="chip" style="color:var(--dom);border-color:var(--dom-bd)">self-service vended</span>':''}</h4>
    <div class="meta"><span class="chip">owner: ${esc(d.owner||'—')}</span><span class="chip" style="${d.id==='platform'?'color:var(--plat);border-color:var(--plat-bd)':'color:var(--dom);border-color:var(--dom-bd)'}">${d.id==='platform'?'Platform team':esc(d.name)+' team'}</span><span class="chip">${esc(d.ownerGroup||'—')}</span>
      <span class="chip">${pluralize((d.agents||[]).length,'agent')}</span>
      <span class="chip">${Number.isFinite(tokenBudget)&&tokenBudget>0?esc(tokenBudget.toLocaleString())+' token budget':'no token budget'}</span>
      ${memberChips}</div>
    <div class="d" style="margin-top:4px">${esc(d.description||'')}</div>
    ${hosted?'':`<div class="d" style="margin-top:6px;color:var(--accent);font-size:.76rem">Open domain →</div>`}
  </div>`
  }).join('')
  if(!hosted){
    box.querySelectorAll('[data-domain]').forEach(card=>card.onclick=()=>{ S.domainDetail=card.dataset.domain; render() })
  }
  // F3 (builder): the read-only directory of the other domains — opening one
  // hits the same drill-down and lands on the server's access-denied state.
  const dir=document.getElementById('domdirectory')
  if(dir){
    const mine=new Set(r.domains.map(d=>d.id))
    const others=(r.directory||[]).filter(d=>!mine.has(d.id))
    dir.innerHTML=others.length?others.map(d=>`<div class="item pick" style="margin-bottom:8px" data-domaindir="${esc(d.id)}">
      <h4>${TAG_IC}${esc(d.name)}</h4>
      <div class="meta"><span class="chip">owner: ${esc(d.owner||'—')}</span><span class="chip">${esc(d.ownerGroup||'—')}</span></div>
    </div>`).join(''):'<div class="empty" style="padding:8px 0">No other domains.</div>'
    dir.querySelectorAll('[data-domaindir]').forEach(card=>card.onclick=()=>{ S.domainDetail=card.dataset.domaindir; render() })
  }
}
function renderDomainRosterUnavailable(box){
  box.innerHTML='<div class="empty" role="status">The domain roster is temporarily unavailable. <button class="ghost" id="domretry">Retry</button></div>'
  const retry=box.querySelector('#domretry')
  if(retry)retry.onclick=()=>{
    box.innerHTML='<div class="empty"><span class="spin">⟳</span> loading domains…</div>'
    runSessionTask(loadDomainRoster)
  }
}
// ---------- F1: Domain detail (drill-down) ----------
function vDomainDetail(){
  const id=S.domainDetail
  return `<div class="bar" style="margin:0 0 10px"><button class="ghost" id="domback">← ${S.who==='builder'?'My Domain':'Domains'}</button></div>
  <div id="domdetail"><div class="empty"><span class="spin">⟳</span> loading domain ${esc(id)}…</div></div>`
}
async function loadDomainDetail(){
  const box=document.getElementById('domdetail'); if(!box)return
  const r=await api('/domain-detail?id='+encodeURIComponent(S.domainDetail))
  if(r.accessDenied){
    // RBAC: a builder opening a foreign domain gets an explicit denied state.
    box.innerHTML=`<div class="card" id="domdenied" style="border-left:3px solid var(--lock);text-align:center;padding:36px 20px">
      <div class="icbig">${ICONS.lock}</div>
      <div class="sec-h" style="color:var(--lock);justify-content:center;margin:8px 0 6px">Access denied — not your domain</div>
      <div class="d" style="color:var(--dim);font-size:.85rem;max-width:560px;margin:0 auto">${esc(r.error||'This domain belongs to another team.')}</div>
    </div>`
    return
  }
  if(!r.ok){ box.innerHTML=`<div class="empty">${esc(r.error||'Could not load domain.')}</div>`; return }
  const d=r.domain, u=r.usage
  const isPlat=d.id==='platform'
  const teamChip=`<span class="chip" style="${isPlat?'color:var(--plat);border-color:var(--plat-bd)':'color:var(--dom);border-color:var(--dom-bd)'}">${isPlat?'Platform team':esc(d.name)+' team'}</span>`
  const healthBadge=a=>a.health==null?'<span class="chip" style="color:var(--muted)">not deployed</span>'
    :a.health==='healthy'?`<span class="chip" style="color:var(--ok);border-color:var(--ok-bd)">● healthy</span>`
    :`<span class="chip" style="color:var(--err);border-color:var(--err-bd)">● ${esc(a.health)}</span>`
  const pct=u.budgetPct, w=pct==null?0:Math.min(100,pct)
  const barColor=u.alert==='over'?'var(--err)':u.alert==='warn'?'var(--lock)':'var(--ok)'
  box.innerHTML=`
  <span class="roletag ${isPlat?'plat':'dom'}">${isPlat?'Platform team · control plane':'Domain team · application plane'}</span><h1>${esc(d.name)}</h1>
  <p class="subtitle">${esc(d.description||'')}</p>
  <div class="card"><div class="sec-h" style="margin-top:0">Ownership</div>
    <div class="meta"><span class="chip">owner: ${esc(d.owner||'—')}</span>${teamChip}<span class="chip">${esc(d.ownerGroup||'—')}</span>
    ${(d.users||[]).map(x=>`<span class="chip" style="color:var(--dom);border-color:var(--dom-bd)">${esc(x.name)} · ${x.role==='lead'?'Domain Lead':'Builder'}</span>`).join('')}</div>
  </div>
  <div class="card"><div class="sec-h" style="margin-top:0">Agents (${r.agents.length}) ${isPlat?'<button class="ghost" id="domallfleet" style="padding:2px 10px;font-size:.68rem;margin-left:8px">Open full fleet view →</button>':''}</div>
    ${r.agents.length?`<table><thead><tr><th>Agent</th><th>Status</th><th>Approval</th><th>Health</th><th>Version</th><th>Cost</th></tr></thead><tbody>
      ${r.agents.map(a=>`<tr data-domagent="${esc(a.id)}" style="cursor:pointer">
        <td><b>${esc(a.id)}</b></td>
        <td>${a.deployed?`<span class="st ${esc(a.status)}"></span>${esc(a.status)}`:'<span style="color:var(--muted)">—</span>'}</td>
        <td>${a.approval?mcpBadge(a.approval):'<span style="color:var(--muted)">—</span>'}</td>
        <td>${healthBadge(a)}</td>
        <td style="font-size:.72rem;color:var(--muted);max-width:200px" title="${esc(a.version||'')}">${esc((a.version||'—').length>30?(a.version.slice(0,30)+'…'):(a.version||'—'))}</td>
        <td>${a.cost?`${usd(a.cost.costUsd)} · ${a.cost.invocations} inv`:'<span style="color:var(--muted)">—</span>'}</td>
      </tr>`).join('')}
    </tbody></table>`:'<div class="empty">No agents in this domain yet.</div>'}
  </div>
  <div class="card"><div class="sec-h" style="margin-top:0">Projects <span class="chip">delivery units</span></div>
    <div id="projroster"><div class="empty"><span class="spin">⟳</span> loading projects…</div></div>
  </div>
  <div class="card"><div class="sec-h" style="margin-top:0">Promotion approvals <span class="chip">S3-brokered · CI run frozen until decided</span><span class="chip" style="color:var(--dom);border-color:var(--dom-bd)">domain-owner review</span></div>
    <div id="dompromos"><div class="empty"><span class="spin">⟳</span> loading pending promotions…</div></div></div>
  ${hasCap('useBuilderSurfaces')&&(activeDomain()||'platform')===d.id?`<div class="card"><div class="sec-h" style="margin-top:0">Start a project from a profile</div>
    <div id="profilecards"><div class="empty"><span class="spin">⟳</span> loading profiles…</div></div></div>`:''}
  <div class="card"><div class="sec-h" style="margin-top:0">Memory stores (${r.memories.length}) <span class="chip">content grant-gated</span></div>
    ${r.memories.length?`<table><thead><tr><th>Store</th><th>Agent</th><th>PII</th><th>Retention</th><th>Events</th><th>Records</th><th>Strategies</th></tr></thead><tbody>
      ${r.memories.map(m=>`<tr data-dommem="${esc(m.id)}">
        <td><b>${esc(m.name)}</b>${m.simulated?' '+simChip('illustrative'):''}</td>
        <td><code style="font-size:.72rem">${esc(m.agent||'—')}</code></td>
        <td>${m.piiFlagged?'<span class="chip" style="color:var(--err);border-color:var(--err-bd);font-weight:600">⚠ PII</span>':'<span class="chip" style="color:var(--ok);border-color:var(--ok-bd)">no PII</span>'}</td>
        <td style="font-size:.78rem">${m.retentionDays?m.retentionDays+'d':'—'}</td>
        <td style="font-size:.78rem">${(m.eventCount||0).toLocaleString()}${m.countsSimulated?' '+simChip('illustrative'):''}</td>
        <td style="font-size:.78rem">${(m.recordCount||0).toLocaleString()}</td>
        <td>${(m.strategies||[]).map(s=>`<span class="chip" style="color:var(--plat);border-color:var(--plat-bd)">${esc(s)}</span>`).join(' ')||'—'}</td>
      </tr>`).join('')}
    </tbody></table>`:'<div class="empty">No memory stores attributed to this domain.</div>'}
  </div>
  <div class="card" id="dombudget"><div class="sec-h" style="margin-top:0">Token budget &amp; usage <span class="chip">same ledger as Cost</span></div>
    <div class="meta"><span class="chip">${u.tokensUsed.toLocaleString()} tokens used</span><span class="chip">${usd(u.costUsd)}</span>
      ${u.tokenBudget?`<span class="chip">budget ${u.tokenBudget.toLocaleString()}</span>`:'<span class="chip" style="color:var(--muted)">no budget set</span>'}
      ${u.alert==='over'?'<span class="chip" style="color:var(--err);border-color:var(--err-bd)">⚠ over budget</span>':u.alert==='warn'?'<span class="chip" style="color:var(--lock);border-color:var(--lock-bd)">⚠ 80% of budget</span>':''}</div>
    ${u.tokenBudget?`<div style="margin-top:8px;height:8px;border-radius:4px;background:var(--surface2);overflow:hidden"><div class="budgetbar" style="height:100%;width:${w}%;background:${barColor}"></div></div>
    <div class="d" style="margin-top:4px;color:var(--muted);font-size:.72rem">${pct}% of token budget consumed</div>`:''}
  </div>`
  // Obs link-out — B14: the admin has no single-agent monitoring entry (the
  // aggregate boundary), so the link lands on Platform Monitoring scoped to
  // the owning DOMAIN; builders/leads keep the agent-scoped content view.
  box.querySelectorAll('[data-obsagent]').forEach(btn=>btn.onclick=e=>{
    e.stopPropagation()
    const proj=btn.dataset.obsagent
    if(S.who==='admin'){
      S.obsScope={type:'domain',id:d.id,label:domainLabel(d.id)}
      S.obsScopes=null; S.obsTab='metrics'
      S.view='monitoring'; render()
    } else {
      S.obsScope={type:'agent',id:proj,label:proj}
      S.obsScopes=null; S.traceAgent=proj
      S.view='observability'; render()
    }
  })
  // R-B10-04: All Agents left the admin nav; the fleet/agent-detail view is
  // still reachable by drilling into a domain's agent row (fleet stays a
  // routable admin view, just not a top-level nav entry).
  // R-B10-04: All Agents left the admin nav; the fleet/agent-detail view is
  // still reachable by drilling into a domain's agent row (fleet stays a
  // routable admin view, just not a top-level nav entry). The Platform
  // domain's Agents card also links straight to the unscoped Fleet table.
  if(document.getElementById('domallfleet')) document.getElementById('domallfleet').onclick=e=>{
    e.stopPropagation(); S.fleetAgent=null; S.view='fleet'; render()
  }
  box.querySelectorAll('[data-domagent]').forEach(tr=>tr.onclick=e=>{
    if(e.target.closest('[data-obsagent]'))return
    const proj=tr.dataset.domagent
    S.fleetAgent={project:proj,name:proj}; S.detail=null; S.fleetChat=[]; S.fleetSession=null; S.view='fleet'; render()
  })
  // IA restructure: the domain's projects render here (Projects left the nav).
  runSessionTask(()=>loadProjects(d.id))
  runSessionTask(loadProfiles)
  runSessionTask(()=>loadDomainPromotions(d.id))
}
function wireDomains(){
  const btn=document.getElementById('dcreate'); if(!btn)return
  btn.onclick=sessionTaskHandler(async()=>{
    const st=document.getElementById('domstatus')
    const pending=S.pendingDomainCreate
    const name=document.getElementById('dname').value.trim()
    if(!pending&&!name){ st.innerHTML='<div class="status err">Domain name is required.</div>'; return }
    btn.disabled=true
    st.innerHTML='<div class="status info"><span class="spin">⟳</span> vending domain…</div>'
    const requestId=pending?.requestId||createRequestId()
    const payload=pending?.payload||{
      name, owner:document.getElementById('downer').value.trim(),
      ownerGroup:document.getElementById('dgroup').value.trim(),
      tokenBudget:document.getElementById('dbudget').value.trim(),
      description:document.getElementById('ddesc').value.trim(),
    }
    S.pendingDomainCreate={requestId,payload}
    let r
    for(let attempt=0;attempt<3;attempt++){
      r=await api('/domain-create',payload,{requestId})
      if(r.ok||r.code!=='DOMAIN_PROVISIONING_FAILED'||r.retryable!==true)break
      st.innerHTML='<div class="status info"><span class="spin">⟳</span> Agent Registry is still provisioning…</div>'
    }
    btn.disabled=false
    if(!r.ok){
      if(r.code==='DOMAIN_PROVISIONING_FAILED'&&r.retryable===true){
        st.innerHTML='<div class="status info">Agent Registry is still provisioning. Select Create domain again to continue the same request.</div>'
        return
      }
      S.pendingDomainCreate=null
      st.innerHTML=`<div class="status err">${esc(apiErrorMessage(r,'create failed'))}</div>`
      return
    }
    S.pendingDomainCreate=null
    st.innerHTML=`<div class="status ok">Domain <b>${esc(r.domain.name)}</b> is active with Agent Registry <code>${esc(r.domain.registryId)}</code>. Assign Cognito group <code>${esc(r.domain.ownerGroup)}</code> to onboard builders.</div>`
    businessForms.clear('domain')
    ;['dname','downer','dgroup','dbudget','ddesc'].forEach(id=>document.getElementById(id).value='')
    runSessionTask(loadDomainRoster)
  })
}

// ---------- G6: Projects & Members (decision 1 + 4 — durable workspaces) ----------
// A project is the durable multi-agent workspace: agents + members-with-bundles
// under one domain. The members page is UI over the G5 store; every write goes
// through the capability-gated server APIs (manageProjectMembers) — the UI only
// ---------- TLP-B2.3: My Projects cards landing (hybrid, spec v2.3 §1) ----------
// The builder's landing decision: a last-used project resumes straight into
// that workspace; none -> this cards page (one card per membership, listed by
// /api/my-projects which is server-filtered to the session user — independent review E7: a
// builder never receives another builder's project metadata). Minimal landing
// shell: brand sidebar + header + cards + log out, NO global nav — workspace
// tabs only exist inside a chosen project (persona-exclusive shell principle).
function vMyProjects(){
  return `<div id="myprojectsroot"><div class="empty"><span class="spin">⟳</span> loading your projects…</div></div>`
}
async function loadMyProjects(){
  const box=document.getElementById('myprojectsroot'); if(!box)return
  let mine, r={}
  try{
    if(authMode()==='cognito')mine=await ensureWorkspaceProjects()
    else{r=await api('/my-projects');if(r?.ok!==true||!Array.isArray(r.projects))throw new Error('Project list is unavailable.');mine=r.projects}
  }catch(error){
    if(error===CANCELED_REQUEST)return
    box.innerHTML=`<h1>My Projects</h1><p role="status">${esc(error.message)}</p>`;return
  }
  if(!box.isConnected)return
  if(S.autoResume){
    S.autoResume=false
    // returning visit: land directly in the last-used project's workspace
    if(r.lastProject&&mine.some(p=>p.id===r.lastProject)){ S.workspaceProject=r.lastProject; S.wsTab='fleet'; S.view='workspace'; render(); return }
    // no memberships yet: the workspace shell owns the "No project yet" empty state
    if(!mine.length){ S.view='workspace'; render(); return }
  }
  box.innerHTML=`<div style="max-width:980px;margin:6vh auto 0">
    <div style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap">
      <h1 style="margin:0">My Projects</h1>
    </div>
    <p class="subtitle">Choose a project to enter its workspace.</p>
    <p class="d" data-workspace-scope style="color:var(--dim);font-size:.8rem">${esc(workspaceScopeText())}</p>
    ${authMode()==='cognito'&&SHELL()!=='builder'?'<button class="primary" data-project-setup>Create project &amp; review USD budget</button>':''}
    <div class="grid3">${mine.map(p=>`<div class="card bp projcard" data-project="${esc(p.id)}" data-domain="${esc(p.domain)}" style="cursor:pointer">
      <h4>${FOLDER_IC}${esc(p.name)}</h4>
      <div class="meta">
        <span class="chip" style="color:var(--dom);border-color:var(--dom-bd)">${esc(domainLabel(p.domain))}</span>
        <span class="chip" ${p.status==='active'?'style="color:var(--ok);border-color:var(--ok-bd)"':'style="color:var(--muted)"'}>${esc(p.status||'active')}</span>
        <span class="chip">${Array.isArray(p.agents)?pluralize(p.agents.length,'agent'):'Agent count unavailable'}</span>
      </div>
      <div class="d" style="font-size:.76rem;color:var(--dim);margin-top:6px">Open workspace →</div>
    </div>`).join('')}</div>
  </div>`
  box.querySelectorAll('.projcard').forEach(c=>c.onclick=()=>selectWorkspaceProject(mine.find(p=>p.id===c.dataset.project&&p.domain===c.dataset.domain),{view:'workspace',tab:S.wsTab||'fleet'}))
  const setup=box.querySelector('[data-project-setup]')
  if(setup)setup.onclick=sessionTaskHandler(()=>loadHostedProjectSetup(box))
}

// ---------- TLP-B2: Builder Project Workspace (spec §1.2, seven tabs) ----------
// Builder landing is HYBRID (v2.3 §1): last-used project -> directly here;
// otherwise the My Projects cards page above picks one. Project switching
// happens in the top switcher dropdown (search + "View all projects" row,
// which returns to the cards page). No projects -> empty state pointing at
// the domain lead.
// The workspace TABS are the builder's sidebar nav (SHELL_NAV.builder) — the
// shell IS the workspace, there is no second in-page tab bar.
function workspaceSelectionStorage(){
  try{return globalThis.sessionStorage}catch{return undefined}
}
function workspaceProjectMatches(project){
  return project.id===S.workspaceProject&&project.domain===S.workspaceDomain
}
function selectWorkspaceProject(project,{view=S.view,tab=S.wsTab}={}){
  if(!project||!confirmContextChange())return
  clearBusinessDrafts();S.wiz=null
  invalidateSessionWork()
  S.view=view; S.wsTab=tab
  S.workspaceProject=project.id
  S.workspaceDomain=project.domain
  if(authMode()==='cognito')rememberWorkspaceSelection(workspaceSelectionStorage(),SESSION,project)
  S.workspaceSelectionChecked=true;S.workspaceSelectionRequired=false
  S.workspaceProjects=null
  S.traceAgent=''; S.obsScopes=null; S.obsScope={type:'project',id:project.id,domainId:project.domain}
  S.revealed=new Set(); S.lfAgent=''; S.fleetAgent=null; S.detail=null
  S.fleet=null; S.fleetChat=[]; S.fleetSession=null; S.projectDetail=null
  render()
}
async function readWorkspaceProjects(){
  const role=SHELL(), domain=role==='admin'?'platform':activeDomain()
  const items=await loadWorkspaceProjectPages(rawApi)
  return items.filter(project=>project.domainId===domain)
}
async function ensureWorkspaceProjects(){
  if(S.workspaceProjects)return S.workspaceProjects
  const epoch=sessionEpoch
  const request=(S.workspaceProjectsRequest||0)+1;S.workspaceProjectsRequest=request
  const role=SHELL()
  let mine
  if(authMode()==='cognito'){
    const items=await readWorkspaceProjects()
    mine=items.filter(project=>project.status==='ACTIVE').map(project=>({...project,domain:project.domainId}))
  }else{
    const r=await api(role==='admin'||role==='lead'?'/projects':'/my-projects')
    if(r?.ok!==true||!Array.isArray(r.projects))throw new Error('Project list is unavailable.')
    const ownDomain=role==='admin'?'platform':activeDomain()
    mine=role==='admin'||role==='lead'?r.projects.filter(p=>p.domain===ownDomain):r.projects
  }
  if(!sessionEpochIsCurrent(epoch)||S.workspaceProjectsRequest!==request)throw CANCELED_REQUEST
  S.workspaceProjects=mine
  return mine
}
function workspaceFunction(){
  const tab=S.view==='observability'?'obs':S.wsTab||'fleet'
  return ({fleet:['Fleet','Manage agents and their lifecycle in a project.'],
    memorykb:['Memory & KB','Review project memory and knowledge access.'],
    cost:['Cost & Budget','Review project model cost, coverage, runs and the USD budget.'],
    obs:['Observability','Inspect project agents and supported runtime metrics.'],
    build:['Build Agent +','Configure an agent in a project.']})[tab]||['Workspace','Choose a project to continue.']
}
function workspaceScopeText(){
  if(SHELL()==='admin')return 'Workspace scope: Platform domain projects only; business-domain projects stay in their domain workspaces.'
  if(SHELL()==='builder')return `Workspace scope: projects assigned to you in ${domainLabel(activeDomain())}.`
  return `Workspace scope: all projects in ${domainLabel(activeDomain())}.`
}
// Groups an array of project objects by their .domain field, preserving insertion order.
// Returns [{domain, projects}] pairs. Pure function — no state reads.
function groupProjectsByDomain(projects){
  const order=[],map={}
  for(const p of projects){
    if(!map[p.domain]){map[p.domain]=[];order.push(p.domain)}
    map[p.domain].push(p)
  }
  return order.map(d=>({domain:d,projects:map[d]}))
}
function workspaceProjectState(box,{message,empty=false,mine=[]}={}){
  const [title,description]=workspaceFunction()
  S.traceAgent='';S.obsScopes=null;S.detail=null;S.fleetAgent=null;S.revealed=new Set()
  // Group cards by domain when the list spans more than one domain (builder across domains).
  const groups=groupProjectsByDomain(mine)
  const multiDomain=groups.length>1
  const statusChip=p=>(p.status==='active'||p.status==='ACTIVE')?'style="color:var(--ok);border-color:var(--ok-bd)"':'style="color:var(--muted)"'
  const cardHtml=p=>`<div class="card bp projcard" data-workspace-pick="${esc(p.id)}" data-domain="${esc(p.domain)}" style="cursor:pointer">
    <h4>${FOLDER_IC}${esc(p.name)}</h4>
    <div class="meta">
      <span class="chip" style="color:var(--dom);border-color:var(--dom-bd)">${esc(domainLabel(p.domain))}</span>
      <span class="chip" ${statusChip(p)}>${esc(p.status||'active')}</span>
      ${Array.isArray(p.agents)?`<span class="chip">${pluralize(p.agents.length,'agent')}</span>`:''}${p.owner?` <span class="chip">${esc(p.owner)}</span>`:''}
    </div>
    <div class="d" style="font-size:.76rem;color:var(--dim);margin-top:6px">Open workspace →</div>
  </div>`
  const groupHtml=g=>`<div style="margin-bottom:16px"><div class="sec-h" style="margin-top:0;margin-bottom:8px;font-size:.82rem;color:var(--dim)">${esc(domainLabel(g.domain))}</div><div class="grid3">${g.projects.map(cardHtml).join('')}</div></div>`
  const gridHtml=multiDomain?groups.map(groupHtml).join(''):`<div class="grid3">${mine.map(cardHtml).join('')}</div>`
  box.innerHTML=`<h1>${esc(title)}</h1><p class="subtitle">${esc(description)}</p>
    <section data-workspace-state="${empty?'empty':mine.length?'choose':'error'}" role="status">
      <p class="d" data-workspace-scope style="color:var(--dim);font-size:.8rem;margin:0 0 12px">${esc(workspaceScopeText())}</p>
      <p class="d" style="margin:0 0 12px">${esc(message)}</p>
      ${mine.length?gridHtml:''}
      ${empty?(authMode()==='cognito'&&SHELL()!=='builder'?'<button class="primary" data-project-setup>Choose or create a project</button>':'<p>You are not a member of any project yet. Ask your Domain Lead to add you to a project — memberships appear here automatically.</p>'):(!mine.length?'<button class="ghost" data-workspace-retry>Retry project list</button>':'')}
    </section>`
  box.querySelectorAll('[data-workspace-pick]').forEach(button=>button.onclick=()=>selectWorkspaceProject(mine.find(p=>p.id===button.dataset.workspacePick&&p.domain===button.dataset.domain)))
  const setup=box.querySelector('[data-project-setup]')
  if(setup)setup.onclick=sessionTaskHandler(()=>{if(confirmContextChange())return loadHostedProjectSetup(box)})
  const retry=box.querySelector('[data-workspace-retry]')
  if(retry)retry.onclick=sessionTaskHandler(()=>{S.workspaceProjects=null;return loadWorkspace()})
}
function vWorkspace(){
  return `<div id="wsroot"><div class="empty"><span class="spin">⟳</span> loading your project workspace…</div></div>`
}
async function loadWorkspace(){
  const box=document.getElementById('wsroot'); if(!box)return
  const epoch=sessionEpoch
  let mine
  try{mine=await ensureWorkspaceProjects()}catch(error){
    if(error===CANCELED_REQUEST||document.getElementById('wsroot')!==box)return
    if(!sessionEpochIsCurrent(epoch))return
    const accessDenied=error instanceof WorkspaceProjectReadError&&error.accessDenied
    if(authMode()==='cognito'&&accessDenied)rememberWorkspaceSelection(workspaceSelectionStorage(),SESSION,null)
    // An unverified directory cannot activate any scope. Keep only the UI preference
    // on transient/unknown failures, and revalidate it after a successful retry.
    S.workspaceProject=null;S.workspaceDomain=null;S.workspaceProjects=null;S.workspaceSelectionChecked=false
    S.obsScope=null;S.lfAgent='';S.fleet=null;S.fleetChat=[];S.fleetSession=null;S.projectDetail=null;S.projectDetailDomain=null
    workspaceProjectState(box,{message:error.message||'Project list is unavailable.'})
    return
  }
  if(!sessionEpochIsCurrent(epoch)||document.getElementById('wsroot')!==box)return
  let staleSelection=false
  if(authMode()==='cognito'&&!S.workspaceSelectionChecked){
    S.workspaceSelectionChecked=true
    const storage=workspaceSelectionStorage()
    const restored=storage?restoreWorkspaceSelection(storage,SESSION,mine):{project:null,stale:false}
    staleSelection=restored.stale
    S.workspaceSelectionRequired=restored.stale
    if(!S.workspaceProject&&restored.project){
      S.workspaceProject=restored.project.id;S.workspaceDomain=restored.project.domain
    }
  }
  if(!mine.length){
    if(authMode()==='cognito')rememberWorkspaceSelection(workspaceSelectionStorage(),SESSION,null)
    S.workspaceProject=null;S.workspaceDomain=null
    workspaceProjectState(box,{empty:true,message:'No active projects in this authorized workspace. Choose or create a project to continue.'})
    return
  }
  const legacyMatches=!S.workspaceDomain?mine.filter(p=>p.id===S.workspaceProject):[]
  if(staleSelection||S.workspaceSelectionRequired||(S.workspaceProject&&!mine.some(workspaceProjectMatches)&&legacyMatches.length!==1)){
    if(authMode()==='cognito')rememberWorkspaceSelection(workspaceSelectionStorage(),SESSION,null)
    workspaceProjectState(box,{mine,message:'The selected project is unavailable or ambiguous. Choose an authorized project to continue.'})
    return
  }
  if(!S.workspaceProject&&mine.length>1){
    workspaceProjectState(box,{mine,message:'Choose a project to continue.'})
    return
  }
  const p = mine.find(workspaceProjectMatches) || (legacyMatches.length===1?legacyMatches[0]:mine[0])
  S.workspaceProject = p.id
  S.workspaceDomain = p.domain
  S.wsTab = S.wsTab || 'fleet'
  // TLP-B2.3: remember this workspace as the builder's last-used project so a
  // returning visit lands here directly. Server-validated membership;
  // fire-and-forget (landing still works if it fails).
  if(SHELL()==='builder'&&authMode()!=='cognito')runSessionTask(()=>api('/last-project',{project:p.id}))
  // Every current workspace role already has these destinations in its sidebar.
  const tabLabel = ({fleet:'Fleet',build:'Build Agent +',memorykb:'Memory & KB',cost:'Cost & Budget',obs:'Observability',registry:'AI Registry'})[S.wsTab]||''
  // Project switcher (spec §1.1): a TOP dropdown — search box, the builder's
  // projects, and a reserved "View all projects →" row (placeholder, no list
  // page exists). Rendered even with one project so switching is always here.
  // B17/B1: the function name is the visual title — three workspace pages used
  // to share one project-name H1 and read identically. The project stays in
  // the H1 as a dimmed context span (tests and users anchor on it).
  const fnTitle = tabLabel || p.name
  box.innerHTML = `<span class="roletag dom">Domain team · application plane</span>
  <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin:4px 0 2px">
    <h1 style="margin:0;display:inline-flex;align-items:baseline;gap:8px">${esc(fnTitle)} <span style="font-size:.62em;font-weight:400;color:var(--dim)">${esc(p.name)}</span> <span class="chip">${esc(domainLabel(p.domain))}</span></h1>
    <div id="wsswitchwrap" style="position:relative">
      <button class="ghost" id="wsswitchbtn" style="display:none">Switch project <span class="ic2" style="margin-right:0">${ICONS.chevron}</span></button>
      <div id="wsswitchpanel" style="display:none;position:absolute;left:0;top:calc(100% + 6px);z-index:40;min-width:280px;background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:8px;box-shadow:rgba(23,23,23,.06) 0 3px 6px">
        <input id="wsswitchsearch" placeholder="Search projects…" style="width:100%;margin:0 0 6px;padding:6px 10px;font-size:.78rem"/>
        <div id="wsswitchlist" style="max-height:220px;overflow:auto">
          ${mine.map(m=>`<div class="item pick wsswitchitem" data-project="${esc(m.id)}" data-domain="${esc(m.domain)}" data-name="${esc(m.name.toLowerCase())}" style="padding:7px 10px;margin-bottom:4px;${m.id===p.id&&m.domain===p.domain?'border-color:var(--accent-bd)':''}">
            <b style="font-size:.8rem">${FOLDER_IC}${esc(m.name)}</b> <span class="chip">${Array.isArray(m.agents)?pluralize(m.agents.length,'agent'):'Agent count unavailable'}</span>${m.id===p.id&&m.domain===p.domain?' <span class="chip" style="color:var(--accent)">current</span>':''}
          </div>`).join('')}
        </div>
        <div id="wsswitchall" class="pick" style="padding:7px 10px;font-size:.76rem;color:var(--accent);border-top:1px solid var(--border);margin-top:4px;cursor:pointer" title="Choose a project for this page">View all projects →</div>
      </div>
    </div>
  </div>
  <p class="subtitle" title="Per spec §1.2.">Scoped to the <b>${esc(p.name)}</b> project.</p>
  <p class="d" data-workspace-scope style="color:var(--dim);font-size:.8rem;margin:-12px 0 10px">${esc(workspaceScopeText())}</p>
  <div id="wscontext" style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:6px 10px;margin:4px 0 10px;background:var(--surface2,#f5f5f5);border-radius:8px;font-size:.78rem;color:var(--dim)">
    <span>${esc(domainLabel(p.domain))} / <b>${esc(p.name)}</b>${p.owner?` · owner <b>${esc(p.owner)}</b>`:''}</span>
    <button class="ghost" id="wscontextswitchbtn" style="padding:2px 8px;font-size:.75rem;margin-left:4px">Switch project</button>
  </div>
  <div id="wsbody"><div class="empty"><span class="spin">⟳</span> loading…</div></div>`
  const btn=document.getElementById('wsswitchbtn'), panel=document.getElementById('wsswitchpanel')
  btn.onclick=()=>{ panel.style.display = panel.style.display==='none' ? 'block' : 'none'; if(panel.style.display==='block') document.getElementById('wsswitchsearch').focus() }
  // Context strip Switch project button delegates to the main switch dropdown.
  const ctxSwitch=document.getElementById('wscontextswitchbtn')
  if(ctxSwitch)ctxSwitch.onclick=()=>btn.click()
  document.getElementById('wsswitchsearch').oninput=e=>{
    const q=e.target.value.toLowerCase()
    box.querySelectorAll('.wsswitchitem').forEach(it=>{ it.style.display = it.dataset.name.includes(q)?'':'none' })
  }
  box.querySelectorAll('.wsswitchitem').forEach(it=>it.onclick=()=>selectWorkspaceProject(mine.find(p=>p.id===it.dataset.project&&p.domain===it.dataset.domain)))
  // The chooser keeps the current functional destination, including Observability.
  document.getElementById('wsswitchall').onclick=sessionTaskHandler(()=>{
    if(!confirmContextChange())return
    if(authMode()==='cognito')return loadHostedProjectSetup(box)
    invalidateSessionWork();S.workspaceProjects=null;S.workspaceProject=null;S.workspaceDomain=null
    S.traceAgent='';S.obsScopes=null;S.detail=null;S.revealed=new Set()
    if(SHELL()==='builder'){S.view='myprojects';S.autoResume=false}
    else if(SHELL()==='lead'){S.view='domainconsole';S.dcTab='projects'}
    render()
  })
  const setup=box.querySelector('[data-project-setup]')
  if(setup)setup.onclick=sessionTaskHandler(()=>{if(confirmContextChange())return loadHostedProjectSetup(box)})
  await loadWorkspaceTab(p)
}
async function loadWorkspaceTab(p){
  const body=document.getElementById('wsbody'); if(!body)return
  const tab=S.wsTab
  const epoch=sessionEpoch
  const current=()=>sessionEpochIsCurrent(epoch)&&document.getElementById('wsbody')===body
  if(tab==='fleet'){
    // B17: agent cards instead of bare status tiles — lifecycle + approval
    // badges, health, 7-day cost/invocations from the same /api/costs ledger
    // the Cost tab renders, and the three entry points a builder reaches for
    // daily (agent page, chat, traces). Pure recomposition of existing data.
    let f,c
    try{[f,c]=await Promise.all([api('/fleet'),api(authMode()==='cognito'?'/costs?window=7d&limit=50&groupBy=project':'/costs')])}
    catch(error){
      if(error===CANCELED_REQUEST||!current())return
      body.innerHTML='<div class="empty">Project fleet is unavailable.</div>';return
    }
    if(!current())return
    if(f?.ok!==true){body.innerHTML='<div class="empty">Project fleet is unavailable.</div>';return}
    const agents = (f.agents||[]).filter(a=>authMode()==='cognito'?a.domain===p.domain&&a.projectId===p.id:(p.agents||[]).includes(a.project))
    const costBy = {}; if(authMode()!=='cognito')for(const r of (c.perAgent||[])) costBy[r.project]=r
    const weekCost = a=>{ const r=costBy[a.project]; return r?(r.costTrend||[]).slice(-7).reduce((s,v)=>s+(v||0),0):0 }
    const deployedN = agents.filter(a=>a.status==='READY').length
    const weekTotal = agents.reduce((s,a)=>s+weekCost(a),0)
    const lcChip = a=>{ const stage = a.approval==='APPROVED'
      ?'registered'
      :a.status==='READY'?'deployed':'in_development'
      return `<span class="chip" data-lcbadge="${stage}" style="color:var(--dom);border-color:var(--dom-bd)">${LIFECYCLE_LABELS[stage]}</span>` }
    const healthChip = a=>a.health==='suspended'
      ? `<span class="chip" style="background:var(--err-bg);color:var(--err);border-color:var(--err-bd);font-weight:600">■ suspended</span>`
      : a.health==='degraded'
      ? `<span class="chip" style="color:var(--err);border-color:var(--err-bd)" title="errorRate last day">● degraded · ${a.errorRate??'—'}% err</span>`
      : a.health==='unknown'
      ? `<span class="chip" style="color:var(--muted);border-color:var(--border2)">● health unknown</span>`
      : `<span class="chip" style="color:var(--ok);border-color:var(--ok-bd)" title="errorRate last day">● healthy · ${a.errorRate??'—'}% err</span>`
    // R2-4 / de-text round 2: APPROVED and REJECTED keep a short follow-up
    // line; IN_REVIEW is a badge + date chip (the process explainer was prose).
    const approvalNote = a=>{ const d=(a.lastDeploy||a.updated||'').slice(0,10)
      return a.approval==='APPROVED' ? `Approved by the platform team. End users can pick it from the catalog.`
      : a.approval==='REJECTED' ? `Rejected by the platform team. Ask your Domain Lead for the review notes, then redeploy to resubmit.`
      : a.approval==='NOT_SUBMITTED' ? 'Production approval has not been submitted.'
      : `<span class="chip" style="color:var(--lock);border-color:var(--lock-bd)" title="Decided by the platform team — the result lands here on its own, no resubmission needed.">In review</span>${d?` <span class="chip">since ${d}</span>`:''}` }
    // F4 (bootstrap): a project a Domain Lead provisioned FOR this builder
    // opens with the terms they were given — budget burn-down against the same
    // /costs ledger read above, and the blueprint palette they may build from.
    const provCard = provisioningCardHtml(p, authMode()==='cognito'?(c.items||[]).filter(row=>row.scopeType==='project'&&row.domainId===p.domain&&row.projectId===p.id):agents.map(a=>costBy[a.project]).filter(Boolean))
    body.innerHTML = provCard + (agents.length ? `<div id="wspromostrip"></div>
    <div class="meta" id="wsfleetsummary" style="margin-bottom:12px">
      <span class="chip">${pluralize(agents.length,'agent')}</span>
      <span class="chip">${deployedN} deployed</span>
      <span class="chip">${authMode()==='cognito'?'Seven-day agent cost unavailable':usd(weekTotal)+' last 7 days'}</span>
    </div>
    <div class="grid3">${agents.map(a=>{ const cr=costBy[a.project]||null; return `<div class="card bp wsfleetcard" data-agentcard="${esc(a.name)}">
      <h4>${AGENT_IC}${esc(a.name)}</h4>
      <div class="meta" style="margin:4px 0">${lcChip(a)}${mcpBadge(a.approval)}${healthChip(a)}</div>
      <p class="d wsapprovalnote" style="font-size:.72rem;color:var(--muted);margin:4px 0 6px">${approvalNote(a)}</p>
      <div class="meta" style="font-size:.74rem;color:var(--dim)">
        <span class="chip">${authMode()==='cognito'?'N/A':cr?cr.invocations:0} invocations</span>
        <span class="chip">${authMode()==='cognito'?'Agent cost unavailable; see Project Cost':usd(weekCost(a))+' last 7 days'}${cr?.estimated?' ~':''}</span>
        <span class="chip" title="last deployment" style="white-space:nowrap">${a.lastDeploy?`deployed ${esc(a.lastDeploy.slice(0,10))}`:'not deployed'}</span>
      </div>
      <div class="bar" style="margin-top:10px;gap:6px">
        <button class="ghost wsopenagent" data-agent="${esc(a.project)}" style="padding:4px 12px;font-size:.75rem">Open →</button>
        <button class="ghost wschatagent" data-agent="${esc(a.project)}" style="padding:4px 12px;font-size:.75rem">${ic2(ICONS.chat||'')}Chat</button>
      </div>
    </div>`}).join('')}
      <div class="card bp" data-wstab="build" style="cursor:pointer;border:1px dashed var(--border2);background:transparent;display:flex;justify-content:center;align-items:center;text-align:center;align-self:start;padding:14px 20px" id="wsnewagent"><h4 style="color:var(--accent);margin:0">+ New Agent</h4></div>
    </div>` : fleetEmptyHtml(p.name))
    // Hosted mode has no /agent-detail route, so carry the fleet record the
    // list already read; without it every metadata row renders blank.
    const openAgent = proj=>{ const rec=agents.find(a=>a.project===proj)||null
      S.fleetAgent={project:proj,name:rec?.name||proj,record:rec}; S.detail=null; S.fleetChat=[]; S.fleetSession=null; S.view='fleet'; render() }
    body.querySelectorAll('.wsopenagent').forEach(btn=>btn.onclick=()=>openAgent(btn.dataset.agent))
    body.querySelectorAll('.wschatagent').forEach(btn=>btn.onclick=()=>{
      openAgent(btn.dataset.agent)
      // agent detail renders async — nudge the chat input into view once it lands
      sessionTimeout(()=>{ const m=document.getElementById('fmsg'); if(m){ m.scrollIntoView({block:'center'}); m.focus() } },700)
    })
    body.querySelectorAll('.wstraceagent').forEach(btn=>btn.onclick=()=>{
      const proj=btn.dataset.agent
      S.obsScope={type:'agent',id:proj,label:proj}; S.obsScopes=null; S.obsTab='traces'; S.traceAgent=proj
      S.view='observability'; render()
    })
    document.getElementById('wsnewagent')?.addEventListener('click',()=>{ S.view='compose'; S.door='blueprint'; S.step=S.step||1; render() })
    document.getElementById('wsnewagent2')?.addEventListener('click',()=>{ S.view='compose'; S.door='blueprint'; S.step=S.step||1; render() })
    runSessionTask(()=>loadWorkspacePromoStrip(p))
  } else if(tab==='build'){
    body.innerHTML = `<div class="card"><div class="sec-h" style="margin-top:0">Build a new agent</div>
      <button class="primary" id="wsbuildgo">Open Build wizard →</button></div>`
    document.getElementById('wsbuildgo').onclick=()=>{ S.view='compose'; S.door='blueprint'; S.step=S.step||1; render() }
  } else if(tab==='memorykb'){
    // Memory & KB: fetch kit-declared memories + KBs with live status enrichment
    // from /api/project-memories (reads agentcore.json + live AWS state).
    let memData
    const hosted=authMode()==='cognito'
    body.innerHTML='<div class="empty"><span class="spin">⟳</span> loading memory configuration…</div>'
    try{
      memData=await api(`/project-memories?project=${encodeURIComponent(p.id)}`)
      if(hosted&&memData?.code==='NOT_FOUND'){
        // Projects without a deployed kit still expose their saved Agent config.
        // Permission and service failures must not become an empty resource list.
        memData=await api('/agents')
        if(memData?.ok!==true||!Array.isArray(memData.items))throw new Error('Agent configuration unavailable')
        memData=memData.items.filter(a=>a.domainId===p.domain&&a.projectId===p.id)
      }else if(hosted&&(memData?.ok!==true||!Array.isArray(memData.memories)||!Array.isArray(memData.knowledgeBases))){
        throw new Error('Project memory configuration unavailable')
      }
    }catch(error){
      if(error===CANCELED_REQUEST||!current())return
      body.innerHTML='<div class="empty">Memory data unavailable.</div>';return
    }
    if(!current())return
    body.innerHTML=memoryKbTabHtml(memData,p.name)
  } else if(tab==='cost'){
    if(authMode()==='cognito'){
      await loadHostedProjectBudget(body,{domainId:p.domain,projectId:p.id,projectName:p.name})
      return
    }
    // B20-USD: per-agent detail rows + per-project USD budget card.
    // Fetches /api/costs only (budget embedded in projectBudgets map — no
    // separate round-trip, no /api/domains call, no domain-level token budget).
    const c = await api('/costs')
    if(!current())return
    const rows = (c.perAgent||[]).filter(a=>(p.agents||[]).includes(a.project))
    const total = +rows.reduce((s,a)=>s+a.costUsd,0).toFixed(6)
    // Resource breakdown from components (LLM, memory, KB, gateway) if present.
    const compTotals = {llm:0,memory:0,kb:0,gateway:0}
    for(const a of rows){ if(!a.components)continue; for(const k of Object.keys(compTotals)){ if(typeof a.components[k]?.costUsd==='number')compTotals[k]+=a.components[k].costUsd } }
    const hasComponents = Object.values(compTotals).some(v=>v>0)
    const compLabels = {llm:'LLM inference',memory:'Memory',kb:'Knowledge Base',gateway:'Gateway'}
    // Per-project USD budget from the response's projectBudgets map.
    const budget = (c.projectBudgets||{})[p.id] || null
    const budgetPct = budget ? Math.round(total/budget.monthlyLimitUsd*100) : null
    const budgetBarColor = budgetPct==null?'var(--ok)':budgetPct>=100?'var(--err)':budgetPct>=80?'var(--warn)':'var(--ok)'
    const canManageBudget = hasCap('manageProjectMembers')
    body.innerHTML = `<div class="card"><div class="sec-h" style="margin-top:0">Project cost (this month) <b style="margin-left:6px" data-costtotal="${total}">${usd(total)}</b></div>
      ${rows.length ? `<table><thead><tr><th>Agent</th><th>Invocations</th><th>Tokens</th><th>Cost</th></tr></thead><tbody>
        ${rows.map(a=>`<tr data-agentcost="${esc(a.project)}" data-invocations="${a.invocations}" data-cost="${a.costUsd}"><td><b>${esc(a.project)}</b></td><td>${a.invocations}</td><td>${((a.inputTokens||0)+(a.outputTokens||0)).toLocaleString()}</td><td>${usd(a.costUsd)}${a.estimated?' <span class="chip">estimated</span>':' <span class="chip">metered</span>'}</td></tr>`).join('')}
      </tbody></table>` : '<div class="empty">No cost data for this project yet.</div>'}
    </div>
    ${hasComponents?`<div class="card"><div class="sec-h" style="margin-top:0">Resource breakdown</div>
      <table><thead><tr><th>Resource</th><th>Cost</th></tr></thead><tbody>
        ${Object.entries(compTotals).filter(([,v])=>v>0).map(([k,v])=>`<tr><td>${esc(compLabels[k]||k)}</td><td>${usd(v)}</td></tr>`).join('')}
      </tbody></table>
    </div>`:''}
    <div class="card" id="wscostbudget">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:8px">
        <div class="sec-h" style="margin-top:0">Project budget</div>
        ${canManageBudget?`<button class="ghost" id="editbudgetbtn" style="padding:4px 10px;font-size:.76rem">Edit budget</button>`:''}
      </div>
      ${budget?`<div class="meta"><span class="chip" data-budgetpct="${budgetPct}" style="${budgetPct>=100?'color:var(--err);border-color:var(--err-bd)':budgetPct>=80?'color:var(--lock);border-color:var(--lock-bd)':'color:var(--ok);border-color:var(--ok-bd)'}">
          ${budgetPct}% of ${usd(budget.monthlyLimitUsd)} monthly budget</span></div>
        <div style="height:8px;border-radius:4px;background:var(--surface2);margin-top:8px;overflow:hidden">
          <div data-budgetbar style="height:100%;width:${Math.min(100,budgetPct)}%;background:${budgetBarColor}"></div></div>
        ${budgetPct>100?`<div class="d" style="margin-top:4px;color:var(--err);font-size:.72rem">Over budget by ${usd(+(total-budget.monthlyLimitUsd).toFixed(4))}</div>`:''}
        <div class="d" style="margin-top:6px;color:var(--muted);font-size:.72rem">Budget set by ${esc(budget.setBy||'—')} on ${esc(budget.setAt?new Date(budget.setAt).toLocaleDateString():'—')}</div>`
      :`<div class="d" style="color:var(--muted);font-size:.8rem">No budget configured for this project.</div>`}
      ${canManageBudget?`<div id="editbudgetform" style="display:none;margin-top:12px">
        <label style="font-size:.8rem">Monthly budget (USD)</label>
        <div style="display:flex;gap:8px;margin-top:4px;align-items:center">
          <input id="budgetinput" type="number" min="0.01" max="1000000000" step="0.01" value="${esc(String(budget?.monthlyLimitUsd||''))}" placeholder="e.g. 500" style="width:140px;padding:6px 10px"/>
          <button class="primary" id="savebudgetbtn" style="padding:6px 14px;font-size:.8rem">Save</button>
          <button class="ghost" id="cancelbudgetbtn" style="padding:6px 14px;font-size:.8rem">Cancel</button>
          <button class="ghost" id="clearbudgetbtn" style="padding:6px 14px;font-size:.8rem;color:var(--muted)">Clear</button>
        </div>
        <div id="budgeterror" style="color:var(--err);font-size:.76rem;margin-top:4px"></div>
      </div>`:''}
    </div>`
    if(canManageBudget){
      const editBtn=body.querySelector('#editbudgetbtn'), editForm=body.querySelector('#editbudgetform')
      const saveBtn=body.querySelector('#savebudgetbtn'), cancelBtn=body.querySelector('#cancelbudgetbtn')
      const clearBtn=body.querySelector('#clearbudgetbtn'), errDiv=body.querySelector('#budgeterror')
      if(editBtn&&editForm){
        editBtn.onclick=()=>{editForm.style.display='';editBtn.style.display='none'}
        if(cancelBtn)cancelBtn.onclick=()=>{editForm.style.display='none';editBtn.style.display='';errDiv.textContent=''}
        if(saveBtn)saveBtn.onclick=async()=>{
          const v=body.querySelector('#budgetinput')?.value?.trim()
          const n=v?Number(v):NaN
          if(v&&(!Number.isFinite(n)||n<=0||n>1e9)){errDiv.textContent='Enter a positive number up to 1,000,000,000.';return}
          const r=await api('/project-budget',{project:p.id,monthlyLimitUsd:v?n:null})
          if(!current())return
          if(!r?.ok){errDiv.textContent=r?.error||'Save failed.';return}
          runSessionTask(()=>loadWorkspaceTab(p))
        }
        if(clearBtn)clearBtn.onclick=async()=>{
          const r=await api('/project-budget',{project:p.id,monthlyLimitUsd:null})
          if(!current())return
          if(!r?.ok){errDiv.textContent=r?.error||'Clear failed.';return}
          runSessionTask(()=>loadWorkspaceTab(p))
        }
      }
    }
  } else if(tab==='obs'){
    await loadWorkspaceObservability(p)
  } else if(tab==='registry'){
    // Read-only per spec §1.2 ⑥ — the org-wide catalog, browsable in place.
    // Zero write affordances render for this role (capability-gated, and the
    // write APIs 403 for builders regardless — defense in depth).
    const r = await api('/registry')
    const entries = r.entries||[]
    body.innerHTML = entries.length ? `<table><thead><tr><th>Name</th><th>Type</th><th>Domain</th><th>Status</th></tr></thead><tbody>
      ${entries.slice(0,50).map(e=>{
        const latest=[...(e.versions||[])].sort((a,b)=>a.semver.localeCompare(b.semver,undefined,{numeric:true})).pop()
        return `<tr><td>${REG_TYPE_ICON[e.type]||''} ${esc(e.name)}</td><td><span class="chip type">${esc(e.type)}</span></td><td>${domChip(e.domain)}</td><td>${regStatusBadge((e.resolved||{}).status||latest?.status)}</td></tr>`
      }).join('')}
    </tbody></table><p class="d" style="color:var(--muted);font-size:.72rem;margin-top:8px">Read-only</p>` : '<div class="empty">No registry entries.</div>'
  }
}

// ---------- TLP-B2: Domain Console (spec §6) ----------
// The Domain Lead's ENTIRE UI: Dashboard / Projects (+ Create Project) /
// Users & Access — sections come from the sidebar (SHELL_NAV.lead), there is
// no in-page tab bar and no global items alongside. Governance & Approvals
// routes to the lead-variant Governance view (the domain approval inbox).
function vDomainConsole(){
  const tab = S.dcTab || 'dashboard'
  const label = (SHELL_NAV.lead.find(t=>t[5]===tab)||['','Dashboard'])[1]
  // B17/B3: per-tab intro — Dashboard and Projects used to share one subtitle
  // word for word. Each intro now describes only the page it sits on.
  const intro = tab==='projects'
    ? `Projects in ${esc(domainLabel(activeDomain()))}.`
    : tab==='users'
    ? `Project access in ${esc(domainLabel(activeDomain()))}.`
    : `Health, budget burn and per-project cost for ${esc(domainLabel(activeDomain()))}.`
  return `<span class="roletag dom">Domain team · application plane</span><h1>${esc(domainLabel(activeDomain()))} · ${esc(label)}</h1>
  <p class="subtitle">${intro}</p>
  ${authMode()==='cognito'&&tab==='dashboard'?'<div id="domain-foundation-summary"></div>':''}
  <div id="dcbody"><div class="empty"><span class="spin">⟳</span> loading…</div></div>`
}
async function loadHostedDomainDashboard(box,domainId){
  const epoch=sessionEpoch
  const current=()=>sessionEpochIsCurrent(epoch)&&box.isConnected&&activeDomain()===domainId
  try{
    const [projectResult,fleet]=await Promise.all([api('/projects'),api('/fleet')])
    if(!current())return
    if(projectResult?.ok!==true||!Array.isArray(projectResult.projects)
      ||fleet?.ok!==true||!Array.isArray(fleet.agents)){
      box.innerHTML='<div class="empty">Domain inventory is unavailable. Its runtime status is unknown.</div>';return
    }
    const projects=projectResult.projects.filter(p=>p.domain===domainId&&String(p.status).toUpperCase()==='ACTIVE')
    const agents=fleet.agents.filter(a=>a.domain===domainId&&projects.some(p=>p.id===a.projectId))
    const deployed=agents.filter(a=>a.status==='READY').length
    box.innerHTML=`<div class="grid3">
      <div class="card"><h3>Active projects</h3><strong>${projects.length}</strong></div>
      <div class="card"><h3>Agent records</h3><strong>${agents.length}</strong></div>
      <div class="card"><h3>Ready deployments</h3><strong>${deployed}</strong><p class="d">Deployment status is separate from live runtime health.</p></div>
    </div>
    <section class="card"><h2>Project workspaces</h2>
      <p>Open a project to inspect its agents, operational evidence and resource bindings.</p>
      <div class="bar">${projects.map((p,i)=>`<button class="ghost" data-domain-workspace="${i}">${esc(p.name||p.id)}</button>`).join('')||'<p>No active projects in this domain.</p>'}</div>
    </section>
    <section class="card"><h2>Production approvals</h2><p>Pending requests are tied to a release and target. Review decisions in Governance &amp; Approvals.</p><div id="dompromos"></div></section>
    <div id="domaincost"><div class="empty">Loading cost data…</div></div>`
    box.querySelectorAll('[data-domain-workspace]').forEach(button=>button.onclick=()=>{
      if(current())selectWorkspaceProject(projects[Number(button.dataset.domainWorkspace)],{view:'workspace',tab:'fleet'})
    })
    await Promise.all([
      loadHostedPromotionRecords(box.querySelector('#dompromos'),{domainId}),
      loadScopedHostedCost(box.querySelector('#domaincost'),{domainId}),
    ])
  }catch(error){
    if(error===CANCELED_REQUEST||!current())return
    box.innerHTML='<div class="empty">Domain dashboard is unavailable. Retry from Dashboard.</div>'
  }
}
async function loadDomainConsole(){
  const box=document.getElementById('dcbody'); if(!box)return
  const tab = S.dcTab || 'dashboard'
  const dom = activeDomain()
  const foundation=document.getElementById('domain-foundation-summary')
  if(foundation)runSessionTask(()=>mountDomainFoundation(foundation,{request:rawApi,domainId:dom}))
  if(tab==='dashboard'){
    if(authMode()==='cognito')return loadHostedDomainDashboard(box,dom)
    // TLP-B3 §6.1: budget/overspend chips + per-PROJECT cost breakdown from
    // the domain cost rollup route, health summary (agents by status) from
    // the domain health route — both domain-scoped server-side.
    const [roll,health] = await Promise.all([authMode()==='cognito'?Promise.resolve({ok:false}):api('/domain-cost-rollup?id='+encodeURIComponent(dom)), api('/domain-health?id='+encodeURIComponent(dom))])
    const bh = (health.ok&&health.byHealth)||{healthy:0,degraded:0,suspended:0,undeployed:0}
    const alertChip = authMode()==='cognito'
      ? '<span class="chip">Calendar budget projection unavailable</span>'
      : roll.alert==='over'
      ? `<span class="chip" style="color:var(--err);border-color:var(--err-bd);background:var(--err-bg)">${SHIELD_IC}over budget · ${roll.budgetPct}%</span>`
      : roll.alert==='warn'
      ? `<span class="chip" style="color:var(--lock);border-color:var(--lock-bd);background:var(--lock-bg)">${BELL_IC}nearing budget · ${roll.budgetPct}%</span>`
      : roll.alert==='ok'
      ? `<span class="chip" style="color:var(--ok);border-color:var(--ok-bd)">within budget · ${roll.budgetPct}%</span>`
      : `<span class="chip" style="color:var(--muted);border-color:var(--muted-bd)">no budget set</span>`
    const burnBar = roll.budgetPct!=null?`<div style="height:6px;border-radius:4px;background:var(--surface2);margin-top:8px;overflow:hidden">
        <div style="height:100%;width:${Math.min(100,roll.budgetPct)}%;background:${roll.alert==='over'?'var(--err)':roll.alert==='warn'?'var(--warn)':'var(--ok)'}"></div>
      </div>`:''
    const dot=c=>`<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${c};margin-right:5px"></span>`
    const projRows = roll.ok?(roll.projects||[]):[]
    box.innerHTML = `<div class="grid3">
      <div class="card"><div class="sec-h" style="margin-top:0">Agents</div><div style="font-size:1.6rem;font-weight:600">${health.total??'—'}</div>
        <div class="d" style="color:var(--dim);font-size:.74rem;margin-top:2px">across ${pluralize(projRows.length,'project')}</div></div>
      <div class="card"><div class="sec-h" style="margin-top:0">Domain health</div>
        <div class="meta" style="margin-top:6px">
          <span class="chip" style="color:var(--ok);border-color:var(--ok-bd)">${dot('var(--ok)')}${pluralize(bh.healthy,'healthy agent')}</span>
          ${bh.degraded?`<span class="chip" style="color:var(--lock);border-color:var(--lock-bd)">${dot('var(--warn)')}${bh.degraded} degraded</span>`:''}
          ${bh.suspended?`<span class="chip" style="color:var(--err);border-color:var(--err-bd)">${dot('var(--err)')}${bh.suspended} suspended</span>`:''}
          ${bh.undeployed?`<span class="chip" style="color:var(--muted);border-color:var(--muted-bd)">${dot('var(--muted)')}${bh.undeployed} not deployed</span>`:''}
        </div></div>
      <div class="card"><div class="sec-h" style="margin-top:0">Budget burn</div>
        <div style="font-size:1.6rem;font-weight:600">${roll.budgetPct!=null?roll.budgetPct+'%':'—'}</div>
        <div class="meta" style="margin-top:4px">${alertChip}</div>${burnBar}</div>
    </div>
    <div class="card"><div class="sec-h" style="margin-top:0">Promotion approvals <span class="chip">S3-brokered · CI run frozen until decided</span><span class="chip" style="color:var(--dom);border-color:var(--dom-bd)">domain-owner review</span></div>
      <div id="dompromos"><div class="empty"><span class="spin">⟳</span> loading pending promotions…</div></div></div>
    ${authMode()==='cognito'?'<div id="domaincost"><div class="empty">Loading cost data…</div></div>':`    <div class="card"><div class="sec-h" style="margin-top:0">Cost control — per-project breakdown</div>
      <p class="d" style="color:var(--dim);font-size:.82rem">Domain spend: <b>${usd(roll.costUsd)}</b> + <b>${usd(roll.sharedAllocatedUsd)}</b> shared allocated${roll.totalWithSharedUsd!=null?` = <b data-totalshared>${usd(roll.totalWithSharedUsd)}</b> total`:''}${roll.tokenBudget?` · ${(roll.tokensUsed||0).toLocaleString()} of ${roll.tokenBudget.toLocaleString()} budgeted tokens`:` · ${(roll.tokensUsed||0).toLocaleString()} tokens (no budget set)`}</p>
      ${projRows.length?`<table><thead><tr><th>Project</th><th>Owner</th><th>Invocations</th><th>Tokens</th><th>Cost</th><th>Shared</th></tr></thead><tbody>
        ${projRows.map(p=>`<tr><td><b>${esc(p.name)}</b></td><td>${esc(p.owner||'—')}</td><td>${p.invocations}</td><td>${(p.tokensUsed||0).toLocaleString()}${p.estimated?' <span class="chip" style="color:var(--muted);border-color:var(--muted-bd);font-size:.62rem">estimated</span>':''}</td><td>${usd(p.costUsd)}</td><td style="color:var(--muted);font-size:.78rem">${usd(p.sharedAllocatedUsd)}</td></tr>`).join('')}
      </tbody></table>`:'<div class="empty">No projects in this domain yet.</div>'}
      <p class="d" data-costfootnote style="color:var(--muted);font-size:.72rem;margin-top:8px">Totals shown are direct costs; shared platform allocation listed separately.</p>
    </div>`}`
    if(authMode()==='cognito')await loadScopedHostedCost(document.getElementById('domaincost'),{domainId:dom})
    runSessionTask(()=>loadDomainPromotions(dom))
  } else if(tab==='projects'){
    if(authMode()==='cognito'){
      await loadHostedProjectSetup(box)
      return
    }
    // TLP-B3 §6.2: full card fields — type badge, per-environment lights
    // (non-prod = runtime health, prod = registry approval; separate signals),
    // compliance, owner (P2: resolved server-side, never "backfill"), created.
    const r = await api('/domain-projects?id='+encodeURIComponent(dom))
    const list = (r.ok&&r.projects)||[]
    const envDot=s=>s==='green'?`<span style="color:var(--ok)">●</span>`:s==='amber'?`<span style="color:var(--warn)">●</span>`:s==='red'?`<span style="color:var(--err)">●</span>`:`<span style="color:var(--muted)">○</span>`
    const compChip=c=>c==='ok'?`<span class="chip" style="color:var(--ok);border-color:var(--ok-bd)">${SHIELD_IC}compliant — guardrails wired</span>`
      :c==='warn'?`<span class="chip" style="color:var(--lock);border-color:var(--lock-bd)">${SHIELD_IC}guardrails not wired</span>`
      :`<span class="chip" style="color:var(--muted);border-color:var(--muted-bd)">${SHIELD_IC}compliance n/a — not deployed</span>`
    box.innerHTML = `<div class="grid2">${list.map(p=>`<div class="card bp" data-project="${esc(p.id)}" style="cursor:pointer">
      <h4 style="display:flex;justify-content:space-between;align-items:center;gap:8px">${FOLDER_IC}${esc(p.name)}
        ${p.type?`<span class="chip type" style="flex-shrink:0">${esc(p.type)}</span>`:'<span class="chip" style="color:var(--muted);border-color:var(--muted-bd);flex-shrink:0">no blueprint</span>'}</h4>
      <div class="meta" style="margin-top:6px">
        <span class="chip">${pluralize(p.agentCount,'agent')}</span>
        <span class="chip">${pluralize(p.memberCount,'member')}</span>
        <span class="chip">owner: ${esc(p.owner||'—')}</span>
        <span class="chip">created: ${esc((p.createdAt||'').slice(0,10)||'—')}</span>
      </div>
      <div class="meta" style="margin-top:6px">
        <span class="chip">non-prod ${envDot(p.env.nonprod)}</span>
        <span class="chip">prod ${envDot(p.env.prod)}</span>
        ${compChip(p.compliance)}
      </div>
    </div>`).join('') || '<div class="empty">No projects in this domain yet.</div>'}</div>
    <div class="card" id="dccreate"><div class="sec-h" style="margin-top:0">＋ Create Project</div>
      ${S.wiz?'<div id="dcwizard"></div>':'<div class="bar"><button class="primary" id="dcprojgo">Create project →</button></div>'}
    </div>`
    box.querySelectorAll('[data-project]').forEach(c=>c.onclick=()=>{ S.projectDetail=c.dataset.project; S.view='projects'; render() })
    const go=document.getElementById('dcprojgo')
    if(go)go.onclick=sessionTaskHandler(async()=>{ await wizOpen(); runSessionTask(loadDomainConsole) })
    if(S.wiz) renderWizard(document.getElementById('dcwizard'))
  } else if(tab==='users'){
    if(authMode()==='cognito'){box.innerHTML=vHostedAccessAdmin();await loadHostedAccessAdmin();return}
    // TLP-B3 §6.3: user × project TRI-STATE matrix (Owner / Builder / —).
    // Click an empty cell to assign, a filled cell to change/revoke — every
    // write goes through the SAME capability-gated project-member routes the
    // workspace uses (manageProjectMembers, server-side; UI is an affordance).
    const r = await api('/domain-users?id='+encodeURIComponent(dom))
    if(!r.ok){ box.innerHTML=`<div class="empty">${esc(r.error||'Could not load the access matrix.')}</div>`; return }
    const users=r.users||[], projects=r.projects||[], canManage=!!r.canManage
    const cellLabel=b=>b==='lead'?'Owner':b==='admin'?'Owner':b?'Builder':'—'
    const cellStyle=b=>b==='lead'||b==='admin'?'color:var(--plat);font-weight:600':b?'color:var(--dom);font-weight:600':'color:var(--muted)'
    box.innerHTML = `<div class="card"><div class="sec-h" style="margin-top:0">Access matrix <span class="chip">${pluralize(users.length,'user')} × ${pluralize(projects.length,'project')}</span>${canManage?'':' <span class="chip">read-only</span>'}</div>
    <table><thead><tr><th>User</th>${projects.map(p=>`<th>${esc(p.name)}</th>`).join('')}</tr></thead><tbody>
    ${users.map(u=>`<tr><td><b>${esc(u.name)}</b> <span class="chip" style="font-size:.62rem">${esc(u.id)}</span></td>${projects.map(p=>{
      const m=(p.members||[]).find(x=>x.principal===u.id)
      return `<td class="${canManage?'uacell':''}" ${canManage?`data-project="${esc(p.id)}" data-principal="${esc(u.id)}" data-bundle="${esc(m?m.bundle:'')}" style="cursor:pointer" title="${m?'Click to change or revoke':'Click to assign access'}"`:''}><span style="${cellStyle(m&&m.bundle)}">${m?cellLabel(m.bundle):'—'}</span></td>`
    }).join('')}</tr>`).join('')}
    </tbody></table>
    <div id="uastatus"></div></div>`
    if(!canManage)return
    const st=document.getElementById('uastatus')
    box.querySelectorAll('.uacell').forEach(cell=>cell.onclick=sessionTaskHandler(async()=>{
      const {project,principal,bundle}=cell.dataset
      let r2
      if(!bundle){
        const pick=((await requestDemoChoice(
          'projectRole',
          `Assign ${principal} to ${project} — role?`,
          'builder',
        ))||'').trim().toLowerCase()
        if(!pick)return
        if(pick!=='owner'&&pick!=='builder'){ st.innerHTML='<div class="status err">Role must be "owner" or "builder".</div>'; return }
        r2=await api('/project-member-set',{projectId:project,principal,bundle:pick==='owner'?'lead':'builder'})
      } else {
        if(!confirm(`${principal} holds "${bundle}" on ${project}. Revoke access?`))return
        r2=await api('/project-member-remove',{projectId:project,principal})
      }
      if(!r2.ok){ st.innerHTML=`<div class="status err">${esc(r2.error||'update failed')}</div>`; return }
      runSessionTask(loadDomainConsole)
    }))
  }
}

// ---------- TLP-B4: 6-step create-project wizard ----------
// Replaces the single profile+name form. The draft is assembled client-side;
// EVERY step advance posts /api/wizard-validate (the server is the validator)
// and the final create posts the full draft to /api/wizard-create, which rides
// the same governed pipeline as /api/generate. Step 5 reads the org/domain
// enforced-guardrail tiers (TLP-B3 §6.4 store) — locked items are not removable.
async function wizOpen(){
  businessForms.clear("wizard")
  if(authMode()==='cognito'){
    if(!hostedProjectCreateAllowed())return
    const registry=await api('/registry')
    if(registry?.ok!==true)throw new Error('The domain resource catalog is unavailable. Refresh before creating a project.')
    const catalog=foundationCatalog(registry,{displayOnly:true})
    const resources=[...catalog.blueprints,...catalog.models,...catalog.resources].map(entry=>({
      name:entry.name,ref:{type:entry.ref.type,id:entry.ref.id,registryId:entry.ref.registryId,
        ...(entry.registryName?{registryName:entry.registryName}:{})}}))
    const hasDomainPolicy=registry.domainResourcePolicyApplied===true
    S.wiz={hosted:true,step:1,domainId:SHELL()==='admin'?'platform':activeDomain(),resources,hasDomainPolicy,
      canManage:hostedActionEnabled('grantProjectMembership',hostedCaps()),
      data:{template:null,id:'',projectName:'',description:'',username:'',reason:'',reviewBudget:true,
        resourcePolicy:{resources:resources.map(entry=>entry.ref)}}}
    wizardDirty.setBaseline('wizard',S.wiz.data)
    return
  }
  const [meta,cat,picks]=await Promise.all([api('/wizard-templates'),api('/catalog'),api('/wizard-picks')])
  if(!meta.ok){ alert(meta.error||'wizard unavailable'); return }
  const users=await api('/domain-users?id='+encodeURIComponent(meta.domain))
  const locked=[...meta.orgEnforced.map(g=>g.id),...meta.domainEnforced]
  S.wiz={ step:1, meta, cat:(cat&&!cat.error)?cat:{blueprints:[],models:[]},
    picks:picks.ok!==false?picks:{skills:[],tools:[]},
    users:(users.ok&&users.users)||[], canManage:!!(users.ok&&users.canManage),
    locked, data:{ template:null, projectName:'', description:'', blueprint:null, model:null,
      persona:'', skillIds:[], toolIds:[], members:[], guardrails:[...locked],
      // F4 (bootstrap): the Domain Lead's provisioning terms. Empty for a
      // builder self-serve create — the server rejects them from non-leads.
      tokenBudget:'', monthlyLimitUsd:'', allowedBlueprints:[] } }
  wizardDirty.setBaseline('wizard',S.wiz.data)
}
// Same six-step workflow as accepted main, adapted to the hosted contracts.
// Unsupported legacy provisioning is disabled; only the reviewed supported writes run.
function renderHostedProjectWizard(box){
  const w=S.wiz,d=w.data
  const unavailable=message=>`<p class="d">${message}</p>`
  let body=''
  if(w.step===1){
    body=`<button class="card bp ${d.template?'sel':''}" data-wtpl="blank" aria-pressed="${!!d.template}"><b>Blank project</b><p>Create a durable workspace with manual business inputs.</p></button>
      <button disabled>Automated project templates unavailable</button>
      ${unavailable('Hosted project creation does not support template provisioning. Agent blueprints can be configured separately in Build Agent after the project exists.')}`
  }else if(w.step===2){
    body=`<label for="wid">Project ID</label><input id="wid" maxlength="64" value="${esc(d.id)}" placeholder="Project identifier"/>
      <label for="wname">Project name</label><input id="wname" maxlength="128" value="${esc(d.projectName)}"/>
      <label for="wdesc">Description</label><textarea id="wdesc" maxlength="4096">${esc(d.description)}</textarea>`
  }else if(w.step===3){
    body=`<h3>Project resource access</h3><p>Choose the resources builders may select in this project. This is a subset of the domain's Registry access; no agent is created now.</p>
      <div class="bar"><button class="ghost" data-project-select-all>Select all domain resources</button><button class="ghost" data-project-clear-all>Clear selection</button></div>
      ${[['Blueprint','Project blueprints'],['Model','Project models'],['resources','Project tools and skills']].map(([type,label])=>`<fieldset class="project-resource-group"><legend>${label}</legend><div class="project-resource-options">
        ${w.resources.map((entry,index)=>({entry,index})).filter(({entry})=>type==='resources'?['Skill','MCPServer'].includes(entry.ref.type):entry.ref.type===type).map(({entry,index})=>`<label class="project-resource-option"><input type="checkbox" data-project-resource="${index}" ${d.resourcePolicy===null||d.resourcePolicy.resources.some(ref=>ref.type===entry.ref.type&&ref.id===entry.ref.id)?'checked':''}/><span>${esc(entry.name)}</span></label>`).join('')||'<p>No resources enabled by this domain.</p>'}</div></fieldset>`).join('')}
      <p class="d">Models can be selected before runtime policies are configured. Invocation still requires runtime access, quotas and environment bindings.</p>`
  }else if(w.step===4){
    body=`<h3>Members &amp; Budget</h3><p>You become the project owner. Assign an existing domain member after the project is created.</p>
      ${w.canManage?`<label for="wmember">Existing Cognito username (optional)</label><input id="wmember" maxlength="128" value="${esc(d.username)}"/>
      <label for="wmemberreason">Assignment reason</label><textarea id="wmemberreason" maxlength="1024">${esc(d.reason)}</textarea>
      <p class="d">This assigns project membership only. It does not create a user or grant domain access.</p>`:'<p>Project member assignment requires an authorized domain lead or administrator.</p>'}
      <label><input id="wreviewbudget" type="checkbox" ${d.reviewBudget?'checked':''}/> Review monthly USD budget after creation</label>
      <p class="d">The persisted budget editor opens after creation. An authorized administrator or domain lead must save and verify it there. No budget is saved by Create project.</p>
      <p class="d">The project resource selection is saved with the project.</p>`
  }else if(w.step===5){
    body=`<h3>Inherited controls</h3><p>Platform and domain authorization, runtime limits, guardrails and deployment approvals continue to apply. The project resource selection narrows the domain catalog and cannot override those controls.</p>`
  }else{
    body=`<h3>Review &amp; Create</h3><table id="wizreview"><tbody>
      ${[['Domain',w.domainId],['Template','Blank project'],['Project ID',d.id],['Name',d.projectName],['Description',d.description],
        ['Member assignment',d.username||'Owner only'],['Assignment reason',d.reason||'—'],
        ['USD budget',d.reviewBudget?'Review and save separately after creation':'Not configured'],
        ['Allowed project resources',d.resourcePolicy===null?'Inherit domain catalog':w.resources.filter(entry=>d.resourcePolicy.resources.some(ref=>ref.type===entry.ref.type&&ref.id===entry.ref.id)).map(entry=>entry.name).join(', ')||'None selected'],
        ['Agent and runtime','Configured after project creation']].map(([label,value])=>`<tr><th>${esc(label)}</th><td>${esc(value)}</td></tr>`).join('')}
      </tbody></table><p>Creates the project${d.username?' and then requests the reviewed membership assignment':''}. These are separate operations; partial results are shown. No deployment or model invocation occurs.</p>`
  }
  box.innerHTML=`<section class="card" data-hosted-project-wizard><h2>Create project</h2>
    <div class="steps">${WIZ_STEPS.map(([n,t])=>`<div class="step ${w.step==n?'active':''}" ${w.step==n?'aria-current="step"':''}><span class="n">${n}</span>${esc(t)}</div>`).join('')}</div>
    ${body}<div class="bar" style="margin-top:12px">
    ${w.step>1?`<button class="ghost" id="wback" ${w.submitted?'disabled':''}>← Back</button>`:''}
    ${w.step<6?`<button class="primary" id="wnext" ${w.step===1&&!d.template?'disabled':''}>Next →</button>`:'<button class="primary" id="wcreate">Create project</button>'}
    <button class="ghost" id="wcancel">${w.submitted?'Close':'Cancel'}</button></div><div id="wizstatus" role="status"></div></section>`
  wireHostedProjectWizard(box)
}
function collectHostedProjectWizard(){
  const d=S.wiz.data, g=id=>document.getElementById(id)
  for(const [id,key] of [['wid','id'],['wname','projectName'],['wdesc','description'],['wmember','username'],['wmemberreason','reason']]){
    if(g(id))d[key]=g(id).value.trim()
  }
  if(g('wreviewbudget'))d.reviewBudget=g('wreviewbudget').checked
}
function validateHostedProjectWizard(w){
  const d=w.data
  if(!d.template)return 'Choose Blank project to continue.'
  if(w.step>=2&&(!/^[a-z][a-z0-9-]{0,63}$/.test(d.id)||!d.projectName||d.projectName.length>128||d.description.length>4096))return 'Enter a valid project ID and name (up to 128 characters).'
  if(w.step>=4&&d.username&&(!w.canManage||!/^[A-Za-z0-9][A-Za-z0-9._@+-]{0,127}$/.test(d.username)||d.reason.length<3||d.reason.length>1024))return 'Enter a valid existing username and an assignment reason (3–1024 characters).'
  return ''
}
function wireHostedProjectWizard(box){
  const w=S.wiz
  box.querySelectorAll('[data-project-resource]').forEach(input=>input.onchange=()=>{
    const entry=w.resources[Number(input.dataset.projectResource)]
    w.data.resourcePolicy.resources=w.data.resourcePolicy.resources.filter(ref=>!(ref.type===entry.ref.type&&ref.id===entry.ref.id))
    if(input.checked)w.data.resourcePolicy.resources.push(entry.ref)
  })
  box.querySelector('[data-project-select-all]')?.addEventListener('click',()=>{w.data.resourcePolicy={resources:w.resources.map(entry=>entry.ref)};renderWizard(box)})
  box.querySelector('[data-project-clear-all]')?.addEventListener('click',()=>{w.data.resourcePolicy={resources:[]};renderWizard(box)})
  box.querySelectorAll('[data-wtpl]').forEach(button=>button.onclick=()=>{w.data.template='blank';renderWizard(box)})
  const back=document.getElementById('wback')
  if(back)back.onclick=()=>{if(w.submitted)return;collectHostedProjectWizard();w.step--;renderWizard(box)}
  document.getElementById('wcancel').onclick=()=>{
    if(!confirmContextChange())return
    businessForms.clear('wizard');wizardDirty.clear('wizard')
    S.wiz=null;box.innerHTML='';runSessionTask(()=>loadHostedCollection('projects'))
  }
  const next=document.getElementById('wnext')
  if(next)next.onclick=()=>{
    collectHostedProjectWizard()
    const error=validateHostedProjectWizard(w)
    if(error){document.getElementById('wizstatus').textContent=error;return}
    w.step++;renderWizard(box)
  }
  const create=document.getElementById('wcreate')
  if(create)create.onclick=sessionTaskHandler(()=>createHostedWizardProject(box))
}
async function createHostedWizardProject(box){
  const w=S.wiz
  if(!w?.hosted||w.busy||w.step!==6||!hostedProjectCreateAllowed())return
  const error=validateHostedProjectWizard(w), status=document.getElementById('wizstatus')
  if(error){status.textContent=error;return}
  const epoch=sessionEpoch
  const current=()=>sessionEpochIsCurrent(epoch)&&S.wiz===w&&box.isConnected
  if(w.domainId!==(SHELL()==='admin'?'platform':activeDomain()))return
  w.busy=true;w.submitted=true;w.requestId ||= createRequestId()
  document.getElementById('wcreate').disabled=true
  document.getElementById('wback').disabled=true
  status.textContent='Creating the reviewed project…'
  try{
    if(!w.created){
      const result=await api('/projects',{id:w.data.id,name:w.data.projectName,description:w.data.description,resourcePolicy:w.data.resourcePolicy},{requestId:w.requestId})
      if(!current())return
      if(result?.ok!==true)throw new Error(apiErrorMessage(result,'Project creation failed. Retry the same request or close and check the project list.'))
      if(result.project?.domainId!==w.domainId||result.project?.id!==w.data.id)throw new Error('Project creation response has an invalid scope. Check the project list before continuing.')
      w.created=result.project
      S.workspaceProjects=null
    }
    if(w.data.username&&!w.memberAssigned){
      if(!hostedActionEnabled('grantProjectMembership',hostedCaps()))throw new Error('Project created; member assignment is not authorized.')
      w.memberRequestId ||= createRequestId()
      const result=await api('/access/project-memberships',{domainId:w.domainId,projectId:w.data.id,username:w.data.username,reason:w.data.reason},{requestId:w.memberRequestId})
      if(!current())return
      if(result?.ok!==true||result.domainId!==w.domainId||result.projectId!==w.data.id||result.username!==w.data.username||result.status!=='ACTIVE'||typeof result.subject!=='string'){
        throw new Error('Project created; member assignment is incomplete. '+apiErrorMessage(result,'Check Users & Access or retry this assignment.'))
      }
      w.memberAssigned=true
    }
    businessForms.clear('wizard');wizardDirty.clear('wizard')
    S.wiz=null
    box.innerHTML=`<section class="card"><h3>Project created</h3><p>${esc(w.domainId)} / ${esc(w.data.id)}${w.memberAssigned?' · membership assigned':''}.</p>
      <p>${w.data.reviewBudget?'Budget setup is pending. Review and explicitly save the persisted USD budget below.':'Budget has not been configured.'}</p>
      <button class="primary" data-created-project-open>Open project workspace</button></section>`
    box.querySelector('[data-created-project-open]').onclick=()=>selectWorkspaceProject({...w.created,domain:w.domainId},{view:['domainconsole','myprojects'].includes(S.view)?'workspace':S.view,tab:S.view==='domainconsole'?'fleet':S.wsTab})
    await loadHostedCollection('projects')
    if(w.data.reviewBudget&&sessionEpochIsCurrent(epoch)&&box.isConnected)await loadHostedProjectBudget(document.getElementById('hostedbudgetdetail'),{domainId:w.domainId,projectId:w.data.id})
  }catch(error){
    if(error===CANCELED_REQUEST||!current())return
    status.textContent=error.message||'Project creation is unconfirmed. Check the project list or retry the same request.'
    document.getElementById('wcreate').textContent=w.created?'Retry member assignment':'Retry project creation'
    document.getElementById('wcreate').disabled=false
  }finally{w.busy=false}
}

function wizDraft(){
  const d=S.wiz.data
  return { template:d.template, projectName:d.projectName, description:d.description,
    blueprint:d.blueprint, model:d.model, persona:d.persona,
    skillIds:d.skillIds, toolIds:d.toolIds, members:d.members, guardrails:d.guardrails,
    tokenBudget:d.tokenBudget, allowedBlueprints:d.allowedBlueprints,
    // B20-USD: optional per-project USD budget; server stamps into project.budget.
    monthlyLimitUsd:d.monthlyLimitUsd||undefined }
}
// F4 (bootstrap): the provisioning half of step 4 — the budget slice and the
// blueprint palette a Domain Lead hands a builder. Both are real constraints
// (server-validated against the domain's vended budget and the APPROVED
// registry), so the visual shows what is left to give, not just an input box.
// The allocation bar alone — redrawn in place as the lead types, so keystrokes
// never trigger a step re-render (that would swallow the next click).
function wizBudgetBarHtml(w){
  const b=w.meta.budget||{}, cap=b.domainBudget
  if(cap==null)return `<div class="d" style="color:var(--muted);font-size:.76rem">No token budget vended to this domain yet — the platform team sets one in Governance.</div>`
  const asked=Number(w.data.tokenBudget)||0
  const pctOf=n=>Math.max(0,Math.min(100,Math.round(n/cap*100)))
  return `<div style="height:10px;border-radius:5px;background:var(--surface);border:1px solid var(--bd);overflow:hidden;display:flex">
    <div style="width:${pctOf(b.allocated)}%;background:var(--dim)"></div>
    <div style="width:${pctOf(asked)}%;background:var(--accent)"></div>
  </div>
  <div class="d" style="margin-top:5px;font-size:.74rem;color:var(--dim)">
    <span style="color:var(--dim)">■</span> ${b.allocated.toLocaleString()} committed to other projects ·
    <span style="color:var(--accent)">■</span> ${asked.toLocaleString()} this project ·
    <b style="color:var(--fg)">${Math.max(0,b.unallocated-asked).toLocaleString()}</b> left of ${cap.toLocaleString()} vended to the domain
  </div>`
}
function wizProvisionHtml(w){
  const d=w.data, bps=w.meta.registryBlueprints||[]
  return `<div class="sec-h">Budget <span class="chip" style="text-transform:none;letter-spacing:0">slice of the domain's vended tokens</span></div>
  <input id="wbudget" inputmode="numeric" value="${esc(String(d.tokenBudget||''))}" placeholder="e.g. 6000 tokens"/>
  <div id="wbudgetbar" style="margin-top:8px">${wizBudgetBarHtml(w)}</div>
  <div class="sec-h" style="margin-top:12px">Monthly budget (USD) <span class="chip" style="text-transform:none;letter-spacing:0">optional · project cost page</span></div>
  <p class="d" style="color:var(--muted);font-size:.76rem;margin:0 0 6px">Set a USD spend limit for this project's Cost page. Leave blank for no budget.</p>
  <input id="wmonthlybudgetusd" type="number" min="0.01" max="1000000000" step="0.01" value="${esc(String(d.monthlyLimitUsd||''))}" placeholder="e.g. 500"/>
  <div class="sec-h">Allowed blueprints <span class="chip" style="text-transform:none;letter-spacing:0">registry · APPROVED</span></div>
  <p class="d" style="color:var(--muted);font-size:.76rem;margin:0 0 8px">The palette this project may build from. Leave empty for the full approved catalog.</p>
  ${bps.map(bp=>`<div class="item pick ${d.allowedBlueprints.includes(bp.id)?'sel':''}" data-wpal="${esc(bp.id)}" style="margin-bottom:6px">
    <h4>${esc(bp.name||bp.id)} <span class="chip type">v${esc(bp.version||'1.0.0')}</span></h4>
    <div class="d">${esc(bp.description||'')}</div></div>`).join('')
    ||'<div class="d" style="color:var(--muted);font-size:.8rem">No APPROVED blueprints visible to your domain.</div>'}`
}
function wizApplyTemplate(id){
  const w=S.wiz, tpl=w.meta.templates.find(t=>t.id===id)
  if(!tpl)return
  w.data.template=id
  w.data.blueprint=tpl.blueprint
  w.data.model=tpl.model
  w.data.persona=tpl.personaPreset||''
  w.data.skillIds=[...(tpl.skillIds||[])]
  w.data.toolIds=[...(tpl.toolIds||[])]
  w.data.guardrails=[...new Set([...(tpl.defaultGuardrails||[]),...w.locked])]
}
const WIZ_STEPS=[['1','Template'],['2','Basics'],['3','Blueprint & Harness'],['4','Members & Budget'],['5','Policy'],['6','Review & Create']]
function renderWizard(box){
  if(!box||!S.wiz)return
  if(S.wiz.hosted)return renderHostedProjectWizard(box)
  const w=S.wiz, d=w.data
  const steps=`<div class="steps">${WIZ_STEPS.map(([n,t])=>`<div class="step ${w.step==n?'active':''}"><span class="n">${n}</span>${t}</div>`).join('')}</div>`
  let body=''
  if(w.step===1){
    body=`<div class="grid3">${w.meta.templates.map(t=>`<div class="card bp ${d.template===t.id?'sel':''}" data-wtpl="${esc(t.id)}"><h4>${esc(t.name)}</h4>
      <div class="d" style="font-size:.78rem;color:var(--dim)">${esc(t.description)}</div>
      ${t.blueprint?`<div class="meta" style="margin-top:6px"><span class="chip type">${esc(t.blueprint)}</span>${(t.defaultGuardrails||[]).map(g=>`<span class="chip">${esc(g)}</span>`).join('')}</div>`:''}
    </div>`).join('')}</div>`
  } else if(w.step===2){
    body=`<label style="margin-top:0">Project name</label><input id="wname" value="${esc(d.projectName)}" placeholder="e.g. billing-helper"/>
    <label>Description</label><textarea id="wdesc" style="min-height:56px" placeholder="What is this project for?">${esc(d.description)}</textarea>`
  } else if(w.step===3){
    const bp=w.cat.blueprints||[], models=w.cat.models||[]
    body=`<label style="margin-top:0">Blueprint</label>
    <select id="wbp"><option value="">— pick a blueprint —</option>${bp.map(b=>`<option value="${esc(b.id)}" ${d.blueprint===b.id?'selected':''}>${esc(b.name||b.id)}</option>`).join('')}</select>
    <label>Model</label>
    <select id="wmodel"><option value="">Blueprint default</option>${models.map(m=>`<option value="${esc(m.id)}" ${d.model===m.id?'selected':''}>${esc(m.label||m.id)}</option>`).join('')}</select>
    <label>Persona / system prompt</label><textarea id="wpersona" style="min-height:72px">${esc(d.persona)}</textarea>
    <div class="sec-h">Skills <span class="chip" style="text-transform:none;letter-spacing:0">registry · APPROVED</span></div>
    ${(w.picks.skills||[]).map(s=>`<div class="item pick ${d.skillIds.includes(s.id)?'sel':''}" data-wskill="${esc(s.id)}" style="margin-bottom:6px"><h4>${esc(s.name)}</h4><div class="d">${esc(s.description)}</div></div>`).join('')||'<div class="d" style="color:var(--muted);font-size:.8rem">No APPROVED skills visible to your domain.</div>'}
    <div class="sec-h">Tools <span class="chip" style="text-transform:none;letter-spacing:0">registry · APPROVED</span></div>
    ${(w.picks.tools||[]).map(t=>`<div class="item pick ${d.toolIds.includes(t.id)?'sel':''}" data-wtool="${esc(t.id)}" style="margin-bottom:6px"><h4>${esc(t.name)} <span class="chip type">${esc(t.type||'tool')}</span></h4><div class="d">${esc(t.description)}</div></div>`).join('')||'<div class="d" style="color:var(--muted);font-size:.8rem">No APPROVED tools visible to your domain.</div>'}`
  } else if(w.step===4){
    body=w.canManage
      ?`<p class="d" style="color:var(--muted);font-size:.76rem">You join as owner automatically. Give a builder a seat, then set the terms you are provisioning them.</p>
      <table><thead><tr><th>User</th><th>Seat</th></tr></thead><tbody>
      ${w.users.map(u=>{const m=d.members.find(x=>x.principal===u.id)
        return `<tr><td><b>${esc(u.name)}</b> <span class="chip" style="font-size:.62rem">${esc(u.id)}</span></td>
        <td><select data-wmember="${esc(u.id)}" style="width:auto;padding:4px 8px">
          <option value="" ${!m?'selected':''}>—</option>
          <option value="builder" ${m&&m.bundle==='builder'?'selected':''}>Builder</option>
          <option value="lead" ${m&&m.bundle==='lead'?'selected':''}>Owner</option>
        </select></td></tr>`}).join('')}
      </tbody></table>
      ${wizProvisionHtml(w)}`
      :`<div class="empty">Assigning member seats is a Domain Lead action — you will own the project; a lead can assign others afterwards.</div>`
  } else if(w.step===5){
    const org=w.meta.orgEnforced, domEnf=w.meta.domainEnforced
    const optional=w.meta.options.filter(o=>!domEnf.includes(o.id))
    body=`<div class="sec-h" style="margin-top:4px">Locked</div>
    ${org.map(g=>`<div class="item" style="margin-bottom:6px"><h4>${esc(g.name)} <span class="chip wizlocked" data-wlocked="${esc(g.id)}" style="color:var(--lock);border-color:var(--lock-bd)">org-enforced · locked</span></h4></div>`).join('')}
    ${domEnf.map(id=>{const o=w.meta.options.find(x=>x.id===id)
      return `<div class="item" style="margin-bottom:6px"><h4>${esc(o?o.name:id)} <span class="chip wizlocked" data-wlocked="${esc(id)}" style="color:var(--lock);border-color:var(--lock-bd)">domain-enforced · locked</span></h4></div>`}).join('')}
    <div class="sec-h">Optional</div>
    ${optional.map(o=>`<div class="item pick ${d.guardrails.includes(o.id)?'sel':''}" data-wguard="${esc(o.id)}" style="margin-bottom:6px"><h4>${esc(o.name)}</h4></div>`).join('')||'<div class="d" style="color:var(--muted);font-size:.8rem">No optional guardrails.</div>'}`
  } else {
    const row=(k,v)=>`<tr><td style="color:var(--dim)">${k}</td><td>${v}</td></tr>`
    body=`<table id="wizreview"><tbody>
      ${row('Template',esc(d.template||'—'))}
      ${row('Name',esc(d.projectName||'—'))}
      ${row('Description',esc(d.description||'—'))}
      ${row('Blueprint',esc(d.blueprint||'—'))}
      ${row('Model',esc(d.model||'(blueprint default)'))}
      ${row('Persona',esc((d.persona||'—').split('\n')[0].slice(0,70)))}
      ${row('Skills',d.skillIds.map(esc).join(', ')||'—')}
      ${row('Tools',d.toolIds.map(esc).join(', ')||'—')}
      ${row('Members',d.members.map(m=>esc(m.principal+' ('+(m.bundle==='lead'?'owner':m.bundle)+')')).join(', ')||'(you, as owner)')}
      ${w.canManage?row('Token budget',d.tokenBudget?esc(Number(d.tokenBudget).toLocaleString()+' tokens'):'—'):''}
      ${w.canManage?row('Monthly USD budget',d.monthlyLimitUsd?esc('$'+Number(d.monthlyLimitUsd).toFixed(2)):'—'):''}
      ${w.canManage?row('Allowed blueprints',d.allowedBlueprints.map(b=>`<span class="chip">${esc(b)}</span>`).join(' ')||'<span style="color:var(--dim)">full approved catalog</span>'):''}
      ${row('Guardrails',d.guardrails.map(g=>w.locked.includes(g)?`<span class="chip" style="color:var(--lock);border-color:var(--lock-bd)">${esc(g)} ${ic2(ICONS.lock)}</span>`:`<span class="chip">${esc(g)}</span>`).join(' ')||'—')}
    </tbody></table>`
  }
  box.innerHTML=`${steps}${body}
    <div class="bar" style="margin-top:12px">
      ${w.step>1?'<button class="ghost" id="wback">← Back</button>':''}
      ${w.step<6?`<button class="primary" id="wnext" ${w.step===1&&!d.template?'disabled':''}>Continue →</button>`
        :'<button class="primary" id="wcreate">Create project</button>'}
      <button class="ghost" id="wcancel">Cancel</button>
    </div><div id="wizstatus"></div>`
  wireWizard(box)
}
function wizCollect(){
  const d=S.wiz.data, g=id=>document.getElementById(id)
  if(g('wname'))d.projectName=g('wname').value.trim()
  if(g('wdesc'))d.description=g('wdesc').value.trim()
  if(g('wbp'))d.blueprint=g('wbp').value||null
  if(g('wmodel'))d.model=g('wmodel').value||null
  if(g('wpersona'))d.persona=g('wpersona').value
  if(g('wbudget'))d.tokenBudget=g('wbudget').value.replace(/[,\s]/g,'')
  if(g('wmonthlybudgetusd'))d.monthlyLimitUsd=g('wmonthlybudgetusd').value.trim()
  const members=[]
  document.querySelectorAll('[data-wmember]').forEach(s=>{ if(s.value)members.push({principal:s.dataset.wmember,bundle:s.value}) })
  if(document.querySelector('[data-wmember]'))d.members=members
}
function wireWizard(box){
  const w=S.wiz, st=()=>document.getElementById('wizstatus')
  box.querySelectorAll('[data-wtpl]').forEach(c=>c.onclick=()=>{ wizApplyTemplate(c.dataset.wtpl); renderWizard(box) })
  const toggle=(sel,list)=>box.querySelectorAll(sel).forEach(c=>c.onclick=()=>{
    const id=c.dataset.wskill||c.dataset.wtool||c.dataset.wguard||c.dataset.wpal
    // F4: a toggle re-renders the step, so keep whatever is typed in this
    // step's inputs (the step-4 budget) instead of dropping it.
    wizCollect()
    const i=list.indexOf(id); i>=0?list.splice(i,1):list.push(id); renderWizard(box) })
  toggle('[data-wskill]',w.data.skillIds); toggle('[data-wtool]',w.data.toolIds); toggle('[data-wguard]',w.data.guardrails)
  toggle('[data-wpal]',w.data.allowedBlueprints)
  // F4: redraw ONLY the allocation bar as the lead types, so they watch the
  // remaining domain budget shrink without a step re-render stealing the click
  // that follows (a full render mid-blur detaches the palette cards).
  const budget=document.getElementById('wbudget')
  if(budget)budget.oninput=()=>{
    wizCollect()
    const bar=document.getElementById('wbudgetbar')
    if(bar)bar.innerHTML=wizBudgetBarHtml(w)
  }
  const back=document.getElementById('wback'); if(back)back.onclick=()=>{ wizCollect(); w.step--; renderWizard(box) }
  const cancel=document.getElementById('wcancel'); if(cancel)cancel.onclick=()=>{ if(!confirmContextChange())return;businessForms.clear('wizard');wizardDirty.clear('wizard');S.wiz=null; runSessionTask(loadDomainConsole) }
  const next=document.getElementById('wnext')
  if(next)next.onclick=sessionTaskHandler(async()=>{
    wizCollect()
    next.disabled=true
    const r=await api('/wizard-validate',{step:w.step,draft:wizDraft()})
    next.disabled=false
    if(!r.ok){ st().innerHTML=`<div class="status err">${(r.errors||[r.error||'validation failed']).map(esc).join('<br>')}</div>`; return }
    w.step++; renderWizard(box)
  })
  const create=document.getElementById('wcreate')
  if(create)create.onclick=sessionTaskHandler(async()=>{
    create.disabled=true
    st().innerHTML='<div class="empty"><span class="spin">⟳</span> validating &amp; composing on the paved road…</div>'
    const r=await api('/wizard-create',{draft:wizDraft()})
    if(!r.ok){ create.disabled=false; st().innerHTML=`<div class="status err">${(r.errors||[r.error||'create failed']).map(esc).join('<br>')}</div>`; return }
    businessForms.clear('wizard');wizardDirty.clear('wizard')
    S.wiz=null; S.projectDetail=r.project; S.view='projects'; render()
  })
}

// ---------- TLP-B2: Platform Console (spec §7) ----------
// The Platform Admin's ENTIRE UI. Sidebar sections (SHELL_NAV.admin): Home /
// AI Registry / Governance / Platform Approvals / Blueprints / Platform
// Projects — Registry,
// Governance and Blueprints route straight to their full (writable) views;
// this view serves Home and Platform Projects (with the Templates sub-area
// as a visible Batch-4 placeholder).
function vPlatformConsole(){
  return `<span class="roletag plat">Platform team · control plane</span><h1>Platform Console</h1>
  <p class="subtitle">Aggregate metrics per domain.</p>
  <div id="pcbody"><div class="empty"><span class="spin">⟳</span> loading…</div></div>`
}
// TLP-B7: Home became Dashboard — the button-wall Operations card retired
// (every drill-down is a top-level sidebar section now) and a KPI row landed
// in its place. Platform Projects retired too; Build now lives in the
// persistent BUILD WORKSPACE sidebar section (spec v2.5 §2), not a page here.
async function loadPlatformConsole(){
  const box=document.getElementById('pcbody'); if(!box)return
  const [r,c] = await Promise.all([api('/domains'), api('/costs')])
  if(document.getElementById('pcbody')!==box)return
  const doms = (r.domains||[]).filter(d=>d.id!=='platform')
  const agentCount = (r.domains||[]).reduce((n,d)=>n+(d.agents||[]).length,0)
  box.innerHTML = `<div class="grid3" style="margin-bottom:14px">
    <div class="card" style="margin-bottom:0"><div class="sec-h" style="margin-top:0">Domains</div><div class="kpi">${doms.length}</div><div class="d" style="color:var(--dim);font-size:.78rem">vended governance boundaries</div></div>
    <div class="card" style="margin-bottom:0;cursor:pointer" id="pcallfleet"><div class="sec-h" style="margin-top:0">Agents</div><div class="kpi">${agentCount}</div><div class="d" style="color:var(--dim);font-size:.78rem">across every domain incl. platform · <span style="color:var(--accent)">Open fleet →</span></div></div>
    ${authMode()==='cognito'?'<div class="card"><div class="sec-h">Model inference estimate</div><div class="d">See Cost for the selected UTC window, USD estimate and partial coverage. Calendar spend unavailable.</div></div>':`    <div class="card" style="margin-bottom:0"><div class="sec-h" style="margin-top:0">Monthly spend ${srcBadge('ledger')}</div><div class="kpi">${usd(c.totalCostUsd||0)}</div><div class="d" style="color:var(--dim);font-size:.78rem">direct cost, all domains</div></div>`}
  </div>
  <div class="sec-h" style="margin-top:0">Domains overview</div>
  <div class="grid3">${doms.map(d=>`<div class="card bp" data-domcard="${esc(d.id)}" style="cursor:pointer">
    <h4>${TAG_IC}${esc(d.name)}</h4>
    <div class="meta"><span class="chip">owner: ${esc(d.owner||'—')}</span><span class="chip">${pluralize((d.agents||[]).length,'agent')}</span></div>
  </div>`).join('')}</div>`
  box.querySelectorAll('[data-domcard]').forEach(c=>c.onclick=()=>alert('Domain workspace requires domain login. You are viewing aggregate metrics only.'))
  // R-B10-04: All Agents left the admin nav; the fleet/agent-detail view is
  // still reachable from the Dashboard's Agents KPI card (routable, not a nav
  // entry).
  box.querySelector('#pcallfleet')?.addEventListener('click',()=>{ S.fleetAgent=null; S.view='fleet'; render() })
}

// TLP-B9 (spec v2.5 §2): the platform BUILD WORKSPACE section lands directly
// in the shared workspace view (vWorkspace/loadWorkspace), scoped to the
// platform domain's own projects by ensureWorkspaceProjects — no separate
// picker page or platform-flavored build UI. The old switch-away 'Build'
// single entry and its dedicated page are retired.

// hides affordances, it never decides.
// IA restructure: Projects left the top-level nav — the roster now renders as
// a section on the domain detail page (loadDomainDetail), and this view only
// serves the project drill-down (reached from a domain or an agent crumb).
function vProjects(){
  return `<div class="bar" style="margin:0 0 10px"><button class="ghost" id="projback">← ${S.domainDetail?esc(domainLabel(S.domainDetail)):'Domains'}</button></div>
  <div id="projdetail"><div class="empty"><span class="spin">⟳</span> loading project ${esc(S.projectDetail)}…</div></div>`
}
async function loadProfiles(){
  const box=document.getElementById('profilecards'); if(!box)return
  const r=await api('/profiles')
  if(!r.ok||!Array.isArray(r.profiles)){ box.innerHTML=`<div class="empty">${esc(r.error||'Could not load profiles.')}</div>`; return }
  box.innerHTML=r.profiles.map(p=>`<div class="item" style="margin-bottom:10px">
    <h4>${esc(p.name)} <span class="chip" style="color:var(--plat);border-color:var(--plat-bd)">${esc(p.id)}</span></h4>
    <div class="d" style="color:var(--dim);font-size:.78rem;margin:4px 0 6px">${esc(p.description)}</div>
    <div class="meta">${(p.blueprints||[]).map(b=>`<span class="chip">${ic2(ICONS.ruler)}${esc(b)}</span>`).join('')}
      ${(p.skills||[]).map(s=>`<span class="chip">${ic2(ICONS.book)}${esc(s)}</span>`).join('')}
      ${(p.tools||[]).map(t=>`<span class="chip">${ic2(ICONS.wrench)}${esc(t)}</span>`).join('')}
      <span class="chip">${ic2(ICONS.shield)}${esc(p.guardrailPack)}</span></div>
    <div class="bar" style="margin-top:10px;align-items:end">
      <div><label style="margin-top:0">Project name</label><input class="profname" data-profile="${esc(p.id)}" placeholder="e.g. ${esc(p.id.replace(/-/g,''))}demo"></div>
      <button class="primary profcreate" data-profile="${esc(p.id)}" style="align-self:end">Create project</button>
    </div></div>`).join('')+'<div id="profstatus"></div>'
  box.querySelectorAll('.profcreate').forEach(btn=>btn.onclick=sessionTaskHandler(async()=>{
    const id=btn.dataset.profile
    const name=(box.querySelector(`.profname[data-profile="${id}"]`)?.value||'').trim()
    const st=document.getElementById('profstatus')
    if(!name){ st.innerHTML='<div class="status err">A project name is required.</div>'; return }
    btn.disabled=true
    st.innerHTML='<div class="empty"><span class="spin">⟳</span> composing the starter agent…</div>'
    const r=await api('/project-from-profile',{profileId:id,projectName:name})
    btn.disabled=false
    if(!r.ok){ st.innerHTML=`<div class="status err">${esc(r.error||'create failed')}</div>`; return }
    businessForms.clear('profileCreate')
    S.projectDetail=r.project; S.view='projects'; render()
  }))
}
// Renders the projects of ONE domain (the section on the domain detail page).
async function loadProjects(domainId){
  const box=document.getElementById('projroster'); if(!box)return
  const r=await api('/projects')
  if(!r.ok||!Array.isArray(r.projects)){ box.innerHTML=`<div class="empty">${esc(r.error||'Could not load projects.')}</div>`; return }
  const list=r.projects.filter(p=>!domainId||p.domain===domainId)
  box.innerHTML=list.length?list.map(p=>`<div class="item pick" style="margin-bottom:8px" data-project="${esc(p.id)}" data-domain="${esc(p.domain)}">
    <h4>${FOLDER_IC}${esc(p.name)} ${domChip(p.domain)}</h4>
    <div class="meta"><span class="chip">${pluralize((p.agents||[]).length,'agent')}</span>
      <span class="chip">${pluralize((p.members||[]).length,'member')}</span>
      <span class="chip">created by ${esc(p.owner||p.createdBy)}</span>
      ${p.profileId?`<span class="chip" style="color:var(--plat);border-color:var(--plat-bd)">profile: ${esc(p.profileId)}</span>`:''}</div>
    <div class="d" style="margin-top:6px;color:var(--accent);font-size:.76rem">Open project →</div>
  </div>`).join(''):'<div class="empty">No projects in this domain yet — compose an agent and its project appears here.</div>'
  box.querySelectorAll('[data-project]').forEach(card=>card.onclick=()=>{ S.projectDetail=card.dataset.project; S.projectDetailDomain=card.dataset.domain; S.view='projects'; render() })
}
// F4 (bootstrap): what the BUILDER sees when a Domain Lead stood this project
// up for them — who provisioned it, the token budget they were given (against
// tokens actually burned, from the same cost rollup the table below reads) and
// the blueprint palette they may build from. Absent for self-serve projects.
function provisioningCardHtml(p,costRows){
  if(!p.provisionedBy&&p.tokenBudget==null&&!(p.allowedBlueprints||[]).length)return ''
  const knownUsage=authMode()!=='cognito'||(costRows?.length>0&&costRows.every(a=>Number.isSafeInteger(a.inputTokens)&&a.inputTokens>=0&&Number.isSafeInteger(a.outputTokens)&&a.outputTokens>=0))
  const used=knownUsage?(costRows||[]).reduce((n,a)=>n+(a.inputTokens||0)+(a.outputTokens||0),0):null
  const cap=p.tokenBudget
  const pct=used===null?null:!cap?0:Math.max(0,Math.min(100,Math.round(used/cap*100)))
  return `<div class="card"><div class="sec-h" style="margin-top:0">Provisioned for you
    ${p.provisionedBy?`<span class="chip" style="color:var(--plat);border-color:var(--plat-bd)">by ${esc(p.provisionedBy)}</span>`:''}</div>
    ${cap!=null?`<div style="display:flex;align-items:baseline;gap:8px">
      <div style="font-size:1.5rem;font-weight:600;color:var(--accent)">${cap.toLocaleString()}</div>
      <div class="d" style="color:var(--dim);font-size:.8rem">token budget for this project</div></div>
    ${used===null?'':`    <div style="height:8px;border-radius:4px;background:var(--surface);border:1px solid var(--bd);overflow:hidden;margin-top:8px">
      <div style="width:${pct}%;height:100%;background:var(--accent)"></div></div>`}
    <div class="d" style="margin-top:5px;font-size:.74rem;color:var(--dim)">${used===null?'Token usage unavailable':used.toLocaleString()+' tokens used ('+pct+'%) · usage from the platform cost ledger'}</div>`:''}
    ${(p.allowedBlueprints||[]).length?`<div class="sec-h">Allowed blueprints <span class="chip" style="text-transform:none;letter-spacing:0">registry · APPROVED</span></div>
      <div class="meta">${(p.allowedBlueprints||[]).map(b=>`<span class="chip type">${esc(b)}</span>`).join('')}</div>
      <div class="d" style="margin-top:6px;font-size:.74rem;color:var(--muted)">Your lead scoped this project to these blueprints — each one an APPROVED registry entry, and this project's build was validated against the list.</div>`:''}
  </div>`
}
async function loadProjectDetail(){
  const box=document.getElementById('projdetail'); if(!box)return
  if(authMode()==='cognito'){
    const result=await readHostedCollection('projects')
    const domainId=S.projectDetailDomain||S.domainDetail||activeDomain()
    const matches=result?.ok===true?result.items.filter(project=>project.id===S.projectDetail
      &&(!domainId||project.domainId===domainId)):[]
    if(matches.length!==1){
      box.innerHTML='<div class="empty">Project scope is unavailable. Select the project from its domain.</div>'
      return
    }
    await loadHostedProjectBudget(box,{domainId:matches[0].domainId,projectId:matches[0].id})
    return
  }
  const r=await api('/project-detail?id='+encodeURIComponent(S.projectDetail))
  if(!r.ok){ box.innerHTML=`<div class="empty">${esc(r.error||'Project not found.')}</div>`; return }
  const p=r.project
  const bundleChip=b=>`<span class="chip" style="color:var(--plat);border-color:var(--plat-bd)">${esc(b)}</span>`
  const manage=!!r.canManage
  // Landing header: name / domain / profile / created-by framing (SPEC G6).
  // G14: Domain › Project breadcrumb — a project lives in exactly one domain.
  box.innerHTML=`
  ${crumbTrail([{label:domainLabel(p.domain),go:'domains',domain:p.domain},{label:p.name}])}
  <span class="roletag ${p.domain==='platform'?'plat':'dom'}">${p.domain==='platform'?'Platform team · control plane':'Domain team · application plane'}</span><h1>${esc(p.name)}</h1>
  <p class="subtitle">Durable multi-agent workspace in ${esc(domainLabel(p.domain))} — created by <b>${esc(p.owner||'—')}</b>${p.createdAt?` on ${esc(p.createdAt.slice(0,10))}`:''}${p.profileId?` from profile <b>${esc(p.profileId)}</b>`:' (no domain profile)'}.</p>
  <div class="card"><div class="sec-h" style="margin-top:0">Workspace</div>
    <div class="meta">${domChip(p.domain)}<span class="chip">profile: ${esc(p.profileId||'none')}</span><span class="chip">owner: ${esc(p.owner||'—')}</span><span class="chip">${esc((p.createdAt||'').slice(0,10)||'—')}</span></div>
  </div>
  ${provisioningCardHtml(p,r.agentCosts)}
  <div class="card"><div class="sec-h" style="margin-top:0">Members (${(p.members||[]).length}) <span class="chip">capability bundles</span>${manage?'':' <span class="chip">read-only</span>'}</div>
    ${(p.members||[]).length?`<table><thead><tr><th>Member</th><th>Bundle</th>${manage?'<th></th>':''}</tr></thead><tbody>
      ${(p.members||[]).map(m=>`<tr data-member="${esc(m.principal)}">
        <td><b>${esc(m.principal)}</b></td>
        <td>${manage?`<select class="membundle" data-principal="${esc(m.principal)}" style="padding:4px 8px;font-size:.74rem">
          ${(r.bundles||[]).map(b=>`<option ${b===m.bundle?'selected':''}>${esc(b)}</option>`).join('')}</select>`:bundleChip(m.bundle)}</td>
        ${manage?`<td style="text-align:right"><button class="ghost memremove" data-principal="${esc(m.principal)}" style="padding:3px 10px;font-size:.72rem;color:var(--err)">Remove</button></td>`:''}
      </tr>`).join('')}
    </tbody></table>`:'<div class="empty">No members yet.</div>'}
    ${manage?`<div class="bar" style="margin-top:12px;align-items:end">
      <div><label style="margin-top:0">Add member</label><select id="memadd">${(r.directory||[]).filter(u=>!(p.members||[]).some(m=>m.principal===u.id)).map(u=>`<option value="${esc(u.id)}">${esc(u.name)} (${esc(u.id)})</option>`).join('')||'<option value="">(everyone in the directory is already a member)</option>'}</select></div>
      <div><label style="margin-top:0">Bundle</label><select id="memaddbundle">${(r.bundles||[]).map(b=>`<option ${b==='builder'?'selected':''}>${esc(b)}</option>`).join('')}</select></div>
      <button class="primary" id="memaddbtn" style="align-self:end">Add</button>
    </div><div id="memstatus"></div>`:''}
  </div>
  <div class="card"><div class="sec-h" style="margin-top:0">Agents (${(p.agents||[]).length})</div>
    ${(p.agents||[]).length?(p.agents||[]).map(a=>`<div class="item" style="margin-bottom:8px;display:flex;justify-content:space-between;align-items:center">
      <h4 style="margin:0">${AGENT_IC}${esc(a)}</h4>
      <button class="ghost projagent" data-agent="${esc(a)}" style="padding:3px 12px;font-size:.72rem">Open in Agent Fleet →</button>
    </div>`).join(''):'<div class="empty">No agents in this workspace.</div>'}
  </div>
  <div class="card"><div class="sec-h" style="margin-top:0">Delivery <span class="chip">reported by CI</span></div>
    <div id="projdelivery"><div class="empty">Loading delivery state…</div></div>
  </div>
  <div class="card"><div class="sec-h" style="margin-top:0">Cost — per-agent breakdown</div>
    <p class="d" style="color:var(--dim);font-size:.82rem">Project spend: <b>${usd(r.projectCostUsd)}</b> + <b>${usd(r.sharedAllocatedUsd)}</b> shared allocated.</p>
    <p class="d" data-costfootnote style="color:var(--muted);font-size:.72rem">Totals shown are direct costs; shared platform allocation listed separately.</p>
    ${(r.agentCosts||[]).length?`<table><thead><tr><th>Agent</th><th>Model</th><th>Invocations</th><th>Tokens</th><th>LLM</th><th>Memory</th><th>KB</th><th>Gateway</th><th>Cost</th></tr></thead><tbody>
      ${(r.agentCosts||[]).map(a=>`<tr><td><b>${esc(a.project)}</b></td><td>${esc(a.model||'—')}</td><td>${a.invocations}</td><td>${((a.inputTokens||0)+(a.outputTokens||0)).toLocaleString()}${a.estimated?' <span class="chip" style="color:var(--muted);border-color:var(--muted-bd);font-size:.62rem">estimated</span>':''}</td><td>${usd(a.components.llm)}</td><td>${usd(a.components.memory)}</td><td>${usd(a.components.kb)}</td><td>${usd(a.components.gateway)}</td><td>${usd(a.costUsd)}</td></tr>`).join('')}
    </tbody></table>`:'<div class="empty">No cost activity for this project\'s agents yet.</div>'}
  </div>`
  box.querySelectorAll('.projagent').forEach(btn=>btn.onclick=()=>{ S.fleetAgent={project:btn.dataset.agent,name:btn.dataset.agent}; S.detail=null; S.fleetChat=[]; S.fleetSession=null; S.view='fleet'; render() })
  loadProjectDelivery(p.id)
  wireCrumbs()
  const st=()=>document.getElementById('memstatus')
  const memberWrite=async(path,body)=>{
    const rr=await api(path,body)
    if(!rr.ok){ if(st())st().innerHTML=`<div class="status err">${esc(rr.error||'update failed')}</div>`; else alert(rr.error||'update failed'); return false }
    businessForms.clear('projectMembers')
    runSessionTask(loadProjectDetail); return true
  }
  box.querySelectorAll('.membundle').forEach(sel=>sel.onchange=()=>runSessionTask(()=>memberWrite('/project-member-set',{projectId:p.id,principal:sel.dataset.principal,bundle:sel.value})))
  box.querySelectorAll('.memremove').forEach(btn=>btn.onclick=()=>runSessionTask(()=>memberWrite('/project-member-remove',{projectId:p.id,principal:btn.dataset.principal})))
  const addBtn=document.getElementById('memaddbtn')
  if(addBtn)addBtn.onclick=sessionTaskHandler(async()=>{
    const principal=document.getElementById('memadd').value
    if(!principal){ st().innerHTML='<div class="status err">Pick a directory identity to add.</div>'; return }
    addBtn.disabled=true
    const ok=await memberWrite('/project-member-set',{projectId:p.id,principal,bundle:document.getElementById('memaddbundle').value})
    if(!ok)addBtn.disabled=false
  })
}

// Delivery card (CI telemetry backflow): everything shown is CI SELF-REPORTED
// via the S3 telemetry relay — the copy says "reported by CI" (observability,
// trust anchored in the OIDC role→repo binding), never "verified by platform".
// The relay is not real-time, so the card always states when it last synced.
async function loadProjectDelivery(projectId){
  const box=document.getElementById('projdelivery'); if(!box)return
  const r=await api('/project-delivery?id='+encodeURIComponent(projectId))
  if(!r.ok){ box.innerHTML=`<div class="empty">${esc(r.error||'Delivery state unavailable.')}</div>`; return }
  if(!r.mapped){ box.innerHTML='<div class="empty">No GitHub repo mapped to this project yet — export it to a repo and CI telemetry will land here.</div>'; return }
  const gateDot=g=>g&&g.pass===true?'<span style="color:var(--ok)">●</span>':g&&g.pass===false?'<span style="color:var(--err)">●</span>':'<span style="color:var(--muted)">○</span>'
  const ts=t=>t?esc(String(t).slice(0,16).replace('T',' '))+'Z':'—'
  const trend=r.evalTrend||[]
  const latestEval=trend.length?trend[trend.length-1]:null
  box.innerHTML=`
    <p class="d" style="color:var(--muted);font-size:.72rem;margin-top:0">CI self-reported runs from <b>${esc(r.repo)}</b> via the S3 telemetry relay — observability, not platform attestation. Last synced ${ts(r.syncedAt)}.</p>
    <div class="sec-h" style="font-size:.78rem">Environments</div>
    ${(r.environments||[]).length?`<div class="meta" style="gap:10px">${r.environments.map(e=>`
      <span class="chip" ${e.status==='skipped'?'style="color:var(--muted)" ':''}title="${esc(e.runtime_name||'')}">${e.status==='success'?'<span style="color:var(--ok)">●</span>':e.status==='skipped'?'<span style="color:var(--muted)">◌</span>':'<span style="color:var(--err)">●</span>'} <b>${esc(e.environment)}</b>${e.status==='skipped'?` · skipped — ${esc(e.reason||'no deploy target configured')}`:''} · ${esc((e.sha||'').slice(0,7))} · ${ts(e.at)} · <a href="${esc(e.run_url||'#')}" target="_blank" rel="noopener">run ↗</a></span>`).join('')}
    </div>`:'<div class="empty">No deployments reported yet.</div>'}
    <div class="sec-h" style="font-size:.78rem">Eval score trend <span class="chip">last ${trend.length} scored run${trend.length===1?'':'s'}</span></div>
    ${trend.length?`<div style="display:flex;align-items:center;gap:14px">${svgSpark(trend.map(t=>t.score),'var(--accent)',180,36)}
      <span style="font-size:.82rem">latest <b>${Math.round(latestEval.score*100)}%</b> @ ${esc((latestEval.sha||'').slice(0,7))}</span></div>`
    :'<div class="empty">No eval scores reported yet (scores ride PR eval-gate runs).</div>'}
    <div class="sec-h" style="font-size:.78rem">Recent runs <span class="chip">as reported by CI</span></div>
    ${(r.runs||[]).length?`<table><thead><tr><th>Run</th><th>Branch</th><th>Commit</th><th>eval</th><th>tests</th><th>compliance</th><th>guardrails</th><th>Reported</th><th></th></tr></thead><tbody>
      ${r.runs.map(x=>`<tr>
        <td><b>${esc(x.run_name||'—')}</b>${x.conclusion==='success'?' <span style="color:var(--ok)">●</span>':x.conclusion?' <span style="color:var(--err)">●</span>':''}</td>
        <td>${esc(x.branch||'—')}</td><td>${esc((x.sha||'').slice(0,7))}</td>
        <td>${gateDot(x.gates?.eval)}${typeof x.gates?.eval?.score==='number'?` ${Math.round(x.gates.eval.score*100)}%`:''}</td>
        <td>${gateDot(x.gates?.tests)}</td><td>${gateDot(x.gates?.compliance)}</td><td>${gateDot(x.gates?.guardrails)}</td>
        <td style="font-size:.74rem">${ts(x.reported_at)}</td>
        <td><a href="${esc(x.run_url||'#')}" target="_blank" rel="noopener" style="font-size:.74rem">run ↗</a></td>
      </tr>`).join('')}
    </tbody></table>`:'<div class="empty">No CI runs reported yet for this repo.</div>'}`
}

// ---------- Access requests tab (G7 — decision record §7 ③④) ----------
// ONE queue over the generalized grant store: every request type
// (trace/memory/tool/dataScope/toolCredential) in one place, approve/reject
// with purpose + expiry visible. Deciding stays capability-gated SERVER-side
// (decideAccessRequests, requester ≠ approver) — buttons here are affordances.
// Lives as the Governance › Access requests tab (the standalone Requests nav
// item folded in here — owner request 2026-08-06).
const GRANT_TYPES=['trace','memory','tool','dataScope','toolCredential']
const GRANT_STATUSES=['pending','approved','rejected','expired','revoked']
function govRequestsTab(){
  // TLP-B3 §6.4: a DOMAIN LEAD's Governance & Approvals page carries three
  // same-page sections (spec: queue + escalation tracking + policy config,
  // deliberately not sub-tabs): the decision queue, the escalated-to-platform
  // READ-ONLY tracker, and the Domain Policy (domain-enforced guardrails).
  const types=authMode()==='cognito'?['AGENT','MODEL','TOOL','MCP_SERVER','SKILL','BLUEPRINT','MEMORY','KNOWLEDGE_BASE']:GRANT_TYPES
  const statuses=authMode()==='cognito'?['PENDING','APPROVED','REJECTED','CANCELLED']:GRANT_STATUSES
  const leadExtras = authMode()!=='cognito' && hasCap('decideAccessRequests') && !hasCap('viewAllDomains')
    ? `<div id="dcescalations"><div class="empty"><span class="spin">⟳</span> loading escalations…</div></div>
       <div id="dcpolicy"><div class="empty"><span class="spin">⟳</span> loading domain policy…</div></div>`
    : ''
  // AP-01: this queue is domain-scoped resource-access requests, distinct from
  // the Platform approvals tab (publication + guardrail exemptions). A platform
  // admin can read across domains but does not decide these — the requesting
  // domain's lead does.
  const context=hasCap('viewAllDomains')
    ?'<p class="d" style="color:var(--muted);font-size:.76rem;margin:-4px 0 12px">Requests to use resources in your domain. Access decisions are handled by the requesting domain’s lead.</p>'
    :'<p class="d" style="color:var(--muted);font-size:.76rem;margin:-4px 0 12px">Requests to use resources in your domain.</p>'
  return `${context}<div class="card" style="display:flex;gap:14px;flex-wrap:wrap;align-items:flex-end;padding:14px 20px">
    <div><label style="margin-top:0">Type</label><select id="reqftype" style="min-width:130px"><option value="">all types</option>${types.map(t=>`<option ${S.reqFType===t?'selected':''}>${t}</option>`).join('')}</select></div>
    <div><label style="margin-top:0">Status</label><select id="reqfstatus" style="min-width:120px"><option value="">all statuses</option>${statuses.map(t=>`<option ${S.reqFStatus===t?'selected':''}>${t}</option>`).join('')}</select></div>
    ${hasCap('viewAllDomains')?`<div><label style="margin-top:0">Domain</label><select id="reqfdomain" style="min-width:150px"><option value="">all domains</option>${(S.domainDirectory||[]).map(d=>`<option value="${esc(d.id)}" ${S.reqFDomain===d.id?'selected':''}>${esc(d.name)}</option>`).join('')}</select></div>`:''}
  </div>
  <div id="reqinbox"><div class="empty"><span class="spin">⟳</span> loading requests…</div></div>
  ${leadExtras}`
}
// TLP-B3 §6.4: escalated-to-platform items — READ-ONLY status tracking. A
// lead sees where her domain's platform-routed requests stand (restricted-
// entry use, single-lead break-glass) but never gets decision buttons —
// grant-decide answers 404 for her on these rows regardless.
async function loadDomainEscalations(){
  const box=document.getElementById('dcescalations'); if(!box)return
  const r=await api('/domain-escalations?id='+encodeURIComponent(activeDomain()))
  if(!r.ok){ box.innerHTML=''; return }
  const rows=r.requests||[]
  const statusChip=s=>({pending:`<span class="chip" style="color:var(--lock);border-color:var(--lock-bd)">${HG_IC}platform review pending</span>`,
    approved:'<span class="chip" style="color:var(--ok);border-color:var(--ok-bd)">approved by platform</span>',
    rejected:'<span class="chip" style="color:var(--err);border-color:var(--err-bd)">rejected by platform</span>',
    expired:'<span class="chip" style="color:var(--muted)">expired</span>',
    revoked:'<span class="chip" style="color:var(--muted)">revoked</span>'})[s]||esc(s)
  box.innerHTML=`<div class="card" style="border-left:3px solid var(--plat)">
    <div class="sec-h" style="margin:0 0 4px;color:var(--plat)">Escalated to Platform <span class="chip">read-only tracking</span></div>
    ${rows.length?rows.map(x=>`<div class="item" style="margin-bottom:8px" data-escalation="${esc(x.id)}">
      <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;font-size:.72rem">
        ${statusChip(x.status)}<span class="chip type">${esc(x.resourceType)}</span><code>${esc(x.resourceId)}</code>
        <b>${esc(x.requesterName||x.requestedBy)}</b><span style="color:var(--muted)">· ${esc((x.requestedAt||'').slice(0,19).replace('T',' '))}</span>
        ${x.decidedBy?`<span style="color:var(--muted)">· decided by <b>${esc(x.decidedBy)}</b></span>`:''}
      </div>
      <div style="font-size:.8rem;margin-top:4px;color:var(--dim)">purpose: “${esc(x.purpose)}”</div>
    </div>`).join(''):'<div class="empty" style="padding:10px 0">No requests from this domain are with the platform right now.</div>'}
  </div>`
}
// TLP-B3 §6.4: Domain Policy — the write end of the Domain-Enforced guardrail
// tier (feeds the Batch-4 wizard Step 5). Org-enforced items render locked.
async function loadDomainPolicy(){
  const box=document.getElementById('dcpolicy'); if(!box)return
  const r=await api('/domain-policy?id='+encodeURIComponent(activeDomain()))
  if(!r.ok){ box.innerHTML=''; return }
  const enforced=new Set(r.enforced||[])
  box.innerHTML=`<div class="card" style="border-left:3px solid var(--dom)">
    <div class="sec-h" style="margin:0 0 4px;color:var(--dom)">Domain Policy — enforced guardrails</div>
    ${(r.orgEnforced||[]).map(g=>`<div class="item" style="margin-bottom:6px;display:flex;align-items:center;gap:8px;opacity:.8">
      ${LOCK_IC}<b style="font-size:.8rem">${esc(g.name)}</b><span class="chip" style="color:var(--plat);border-color:var(--plat-bd)">Org policy · locked</span>
    </div>`).join('')}
    ${(r.options||[]).map(g=>`<div class="item" style="margin-bottom:6px;display:flex;align-items:center;gap:8px">
      <input type="checkbox" class="dpguard" data-guard="${esc(g.id)}" ${enforced.has(g.id)?'checked':''} ${r.canEdit?'':'disabled'} style="margin:0"/>
      <b style="font-size:.8rem">${esc(g.name)}</b>
      ${enforced.has(g.id)?'<span class="chip" style="color:var(--dom);border-color:var(--dom-bd)">Domain-enforced</span>':''}
    </div>`).join('')}
    ${r.canEdit?`<div class="bar" style="margin-top:10px"><button class="primary" id="dpsave" style="padding:6px 16px;font-size:.78rem">Save domain policy</button><span id="dpstatus" style="font-size:.74rem;color:var(--dim)">${r.updatedAt?`last updated ${esc(r.updatedAt.slice(0,19).replace('T',' '))} by ${esc(r.updatedBy)}`:''}</span></div>`:''}
  </div>`
  const save=document.getElementById('dpsave')
  if(save)save.onclick=sessionTaskHandler(async()=>{
    save.disabled=true
    const enforcedNow=[...box.querySelectorAll('.dpguard:checked')].map(c=>c.dataset.guard)
    const rr=await api('/domain-policy',{domain:activeDomain(),enforced:enforcedNow})
    save.disabled=false
    const st=document.getElementById('dpstatus')
    if(!rr.ok){ st.innerHTML=`<span style="color:var(--err)">${esc(rr.error||'save failed')}</span>`; return }
    businessForms.clear('domainPolicy')
    runSessionTask(loadDomainPolicy)
  })
}
async function loadRequests(){
  const box=document.getElementById('reqinbox'); if(!box)return
  if(authMode()==='cognito')return loadAdminApprovalQueue(box,'RESOURCE_ACCESS',null,loadRequests)
  const current=adminReadStart(box,'/api/grant-requests · requests')
  // R-014: purpose/evidence arrive maskPII'd; a deciding lead may reveal the
  // original text per-request (?revealed=) — the server audits every reveal.
  if(!S.reqRevealed) S.reqRevealed=new Set()
  const q=[S.reqFType?'type='+encodeURIComponent(S.reqFType):'',S.reqFStatus?'status='+encodeURIComponent(S.reqFStatus):'',S.reqFDomain?'domain='+encodeURIComponent(S.reqFDomain):'',S.reqRevealed.size?'revealed='+encodeURIComponent([...S.reqRevealed].join(',')):''].filter(Boolean).join('&')
  const r=await adminRead('/grant-requests'+(q?'?'+q:''))
  if(!current())return
  if(adminReadFailure(box,r,['requests'],'/api/grant-requests · requests',loadRequests))return
  const reqs=r.requests
  const pending=reqs.filter(x=>x.status==='pending'), rest=reqs.filter(x=>x.status!=='pending')
  const statusChip=s=>({pending:'<span class="chip" style="color:var(--lock)">pending</span>',
    approved:'<span class="chip" style="color:var(--ok);border-color:var(--ok-bd)">approved</span>',
    rejected:'<span class="chip" style="color:var(--err)">rejected</span>',
    expired:'<span class="chip" style="color:var(--muted)">expired</span>',
    revoked:'<span class="chip" style="color:var(--muted)">revoked</span>'})[s]||esc(s)
  const canDecide=x=>hasCap('decideAccessRequests')&&x.status==='pending'&&x.requestedBy!==SESSION.user&&x.domain===activeDomain()
  const canReveal=x=>hasCap('decideAccessRequests')&&x.domain===activeDomain()
  const row=x=>`<div class="item" style="margin-bottom:8px">
    <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;font-size:.72rem">
      ${statusChip(x.status)}<span class="chip type">${esc(x.resourceType)}</span><code>${esc(x.resourceId)}</code>
      ${x.domain?domChip(x.domain):''}
      <b>${esc(x.requesterName||x.requestedBy)}</b><span style="color:var(--muted)">· ${fmtDur(x.durationS)} · ${esc((x.requestedAt||'').slice(0,19).replace('T',' '))}</span>
      ${x.onBehalfOfProject?`<span class="chip">project: ${esc(x.onBehalfOfProject)}</span>`:''}
      ${x.decidedBy?`<span style="color:var(--muted)">· decided by <b>${esc(x.decidedBy)}</b></span>`:''}
      ${x.status==='approved'?`<span style="color:var(--muted)">· expires ${esc((x.expiresAt||'').slice(11,19))} UTC</span>`:''}</div>
    <div style="font-size:.8rem;margin-top:4px;color:var(--dim)">purpose: “${esc(x.purpose)}”${x.evidence?` · evidence: <code style="font-size:.72rem">${esc(x.evidence)}</code>`:''}
      ${canReveal(x)?(S.reqRevealed.has(x.id)
        ?` <span class="chip" style="color:var(--err);border-color:var(--err-bd)">revealed · audited</span><button class="ghost req-reveal" data-req="${esc(x.id)}" data-action="mask" style="padding:2px 8px;font-size:.65rem">Re-mask</button>`
        :` <button class="ghost req-reveal" data-req="${esc(x.id)}" data-action="reveal" style="padding:2px 8px;font-size:.65rem">Reveal purpose</button>`):''}</div>
    ${canDecide(x)?`<div class="bar" style="margin:8px 0 0">
      <button class="primary req-decide" data-req="${esc(x.id)}" data-d="approve" style="padding:4px 14px;font-size:.75rem">Approve</button>
      <button class="ghost req-decide" data-req="${esc(x.id)}" data-d="reject" style="padding:4px 14px;font-size:.75rem;color:var(--err);border-color:var(--err)">Reject</button></div>`:''}
  </div>`
  box.innerHTML=`<div class="card" style="border-left:3px solid var(--dom)">
    <div class="sec-h" style="margin:0 0 4px;color:var(--dom)">Pending ${pending.length?`<span class="chip">${pending.length}</span>`:''}</div>
    ${pending.length?pending.map(row).join(''):'<div class="empty" style="padding:10px 0">No pending requests in this scope.</div>'}
    ${hasCap('decideAccessRequests')&&pending.some(x=>x.requestedBy===SESSION.user)?'<div class="d" style="color:var(--muted);font-size:.72rem">Your own requests need a different lead to approve.</div>':''}
  </div>
  ${rest.length?`<div class="card"><div class="sec-h" style="margin:0 0 8px">Decision history</div>${rest.slice(0,20).map(row).join('')}</div>`:''}`
  box.querySelectorAll('.req-decide').forEach(btn=>btn.onclick=sessionTaskHandler(async()=>{
    btn.disabled=true
    const rr=await api('/grant-decide',{requestId:btn.dataset.req,decision:btn.dataset.d})
    if(!rr.ok){btn.disabled=false;alert(rr.error||'decision failed');return}
    runSessionTask(loadRequests)
  }))
  box.querySelectorAll('.req-reveal').forEach(btn=>btn.onclick=()=>{
    if(btn.dataset.action==='reveal') S.reqRevealed.add(btn.dataset.req); else S.reqRevealed.delete(btn.dataset.req)
    runSessionTask(loadRequests)
  })
}
function wireRequests(){
  // Filter changes rerender the queue. Confirm discards the active
  // actor+domain reason drafts; Cancel keeps drafts and restores the filter.
  // (AP-04: the filter dirty-guard is satisfied by the more specific
  // approval-reason-draft guard landed in the batch-1 writer.)
  const f=(id,key)=>{const el=document.getElementById(id); if(el)el.onchange=()=>{
    if(!confirmApprovalReasonDiscard()){el.value=S[key]||'';return}
    S[key]=el.value;runSessionTask(loadRequests)}}
  f('reqftype','reqFType'); f('reqfstatus','reqFStatus'); f('reqfdomain','reqFDomain')
}

// ---------- Audit trail (G9 — decision record §7 ④) ----------
// ONE chronological timeline over both audit stores: governance decisions
// (interrupts, registry approvals, drift) and content-access events (reveals,
// grant lifecycle incl. break-glass reads, member changes, bundle edits).
// Capability-gated (viewAuditTrail) and scoped server-side; rows are metadata.
function vAudit(){
  const isLead=SESSION.role==='lead'
  return `<span class="roletag ${S.who==='admin'?'plat':'dom'}">${S.who==='admin'?'Platform team · control plane':'Domain team · application plane'}</span><h1>Audit</h1>
  <p class="subtitle">${hasCap('viewAllDomains')
    ?'Governance decisions and content-access events, platform-wide. Metadata only.'
    :'Your domain\'s decisions, grants, reveals and membership changes.'}</p>
  ${storyLine('','requests','Decide the requests')}
  ${scopeNote()}
  <div class="card" style="display:flex;gap:14px;flex-wrap:wrap;align-items:flex-end;padding:14px 20px">
    <div><label style="margin-top:0">Type</label><select id="audftype" style="min-width:150px"><option value="">all types</option>${(S.auditTypes||[]).map(t=>`<option ${S.audFType===t?'selected':''}>${t}</option>`).join('')}</select></div>
    ${hasCap('viewAllDomains')?`<div><label style="margin-top:0">Domain</label><select id="audfdomain" style="min-width:150px"><option value="">all domains</option>${(S.domainDirectory||[]).map(d=>`<option value="${esc(d.id)}" ${S.audFDomain===d.id?'selected':''}>${esc(d.name)}</option>`).join('')}</select></div>`:''}
  </div>
  <div id="audlist"><div class="empty"><span class="spin">⟳</span> loading audit trail…</div></div>`
}
async function loadAudit(){
  const box=document.getElementById('audlist'); if(!box)return
  const q=auditFilterQuery()
  const current=adminReadStart(box,'audit-timeline')
  const r=await api('/audit-trail'+(q?'?'+q:''))
  if(!current())return
  if(!r.ok||!Array.isArray(r.events)){adminReadFailure(box,{ok:false},[],'audit-timeline',loadAudit);return}
  if(Array.isArray(r.types)&&!S.auditTypes){ S.auditTypes=r.types; const sel=document.getElementById('audftype'); if(sel)sel.innerHTML=`<option value="">all types</option>${r.types.map(t=>`<option ${S.audFType===t?'selected':''}>${t}</option>`).join('')}` }
  const streamChip=s=>s==='governance'
    ?'<span class="chip">governance</span>'
    :'<span class="chip">access</span>'
  const row=e=>`<div class="item" style="margin-bottom:8px">
    <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;font-size:.72rem">
      ${streamChip(e.stream)}<span class="chip type">${esc(e.type)}</span><b>${esc(e.action||'—')}</b>
      ${e.subject?`<code>${esc(e.subject)}</code>`:''}
      ${e.domain?domChip(e.domain):''}
      ${e.who?`<span style="color:var(--muted)">by <b>${esc(e.who)}</b></span>`:''}
      <span style="color:var(--muted)">· ${esc((e.at||'').slice(0,19).replace('T',' '))}</span>
      ${e.requestId?`<span class="chip" style="color:var(--muted)" title="request id">req ${esc(String(e.requestId).slice(0,12))}</span>`:''}</div>
    ${e.detail?`<div style="font-size:.78rem;margin-top:4px;color:var(--dim)">${esc(e.detail)}</div>`:''}
  </div>`
  box.innerHTML=`<div class="card">
    <div class="sec-h" style="margin:0 0 4px">Timeline <span class="chip">${r.total} event${r.total===1?'':'s'}</span><button class="ghost" data-audit-refresh>Refresh audit</button></div>
    ${r.events.length?r.events.map(row).join(''):'<div class="empty" style="padding:10px 0">No audit events in this scope.</div>'}
    <p class="d" style="color:var(--muted);font-size:.72rem;margin-top:8px">${esc(r.store||'')}</p></div>`
  box.querySelectorAll('[data-audit-refresh]').forEach(b=>b.onclick=sessionTaskHandler(async()=>{if(b.disabled||!current())return;b.disabled=true;await loadAudit()}))
}
function wireAudit(){
  const f=(id,key)=>{const el=document.getElementById(id); if(el)el.onchange=()=>{S[key]=el.value;const st=document.getElementById('siemstatus');if(st){st.filterRevision=(st.filterRevision||0)+1;if(!document.getElementById('siemexport')?.disabled)st.innerHTML=''}syncAuditExportScope();runSessionTask(loadAudit)}}
  f('audftype','audFType'); f('audfdomain','audFDomain')
}

// ---------- Cost (Loom-informed token usage + cost tracking) ----------
// Fed by REAL invocations (chat, streaming chat, eval runs) through the server's
// usage ledger. Token counts try the Bedrock CountTokens API first and fall back
// to a 4-chars/token heuristic (rows marked "estimated"). Pricing is platform-
// entered metadata in catalog.json — the platform's rate card, not a billing API.
const usd = v=>typeof v==='number'?('$'+(v<0.01&&v>0?v.toFixed(5):v.toFixed(4))):'—'
// TLP-B3 (P2 fix, independent review B2 drill): ONE pluralize helper for every count chip —
// "1 agent" / "3 agents", never "1 agents". Irregulars pass the plural form.
const pluralize=(n,noun,pl)=>`${n} ${n===1?noun:(pl||noun+'s')}`
function vCost(){
  if(authMode()==='cognito')return vHostedCost()
  return `<span class="roletag plat">Platform team · control plane</span><h1>Cost</h1>
  <p class="subtitle">Token usage and spend per agent, metered from real invocations.</p>
  ${hasCap('viewAllDomains')
    ? storyLine('','domains','Set budgets in Domains')
    : storyLine('','observability','Correlate in Observability')}
  ${scopeNote()}
  <div class="grid3" id="costtotals">
    <div class="item"><div class="d">Recorded invocations</div><h4 style="font-size:1.3rem;margin-top:4px"><span class="spin">⟳</span></h4></div>
    <div class="item"><div class="d">Total tokens</div><h4 style="font-size:1.3rem;margin-top:4px">…</h4></div>
    <div class="item"><div class="d">Total spend</div><h4 style="font-size:1.3rem;margin-top:4px">…</h4></div>
  </div>
  <div class="card" style="margin-top:14px"><div class="sec-h" style="margin-top:0">Domain cost buckets ${srcBadge('ledger')}</div>
    <div id="costdomains"><div class="empty"><span class="spin">⟳</span> loading…</div></div></div>
  <div class="card"><div class="sec-h" style="margin-top:0">Cost components ${srcBadge('projection')}</div>
    <div id="costcomponents"><div class="empty"><span class="spin">⟳</span> loading…</div></div></div>
  ${finopsOptimizationCard()}
  <div class="card"><div class="sec-h" style="margin-top:0">Per-agent breakdown ${srcBadge('ledger')}</div>
    <div id="costbox"><div class="empty"><span class="spin">⟳</span> loading usage ledger…</div></div></div>
  <div class="card"><div class="sec-h" style="margin-top:0">Per-model breakdown ${srcBadge('ledger')}</div>
    <div id="costmodelbox"><div class="empty"><span class="spin">⟳</span> loading…</div></div></div>
  <div class="card"><div class="sec-h" style="margin-top:0">Model rate card</div>
    <div id="costpricing"></div></div>`
}
async function loadCost(){
  if(authMode()==='cognito')return loadHostedCost()
  const box=document.getElementById('costbox'); if(!box)return
  const r=await api('/costs')
  const totals=document.getElementById('costtotals')
  if(totals)totals.innerHTML=`
    <div class="item"><div class="d">Recorded invocations</div><h4 style="font-size:1.3rem;margin-top:4px">${r.invocations}</h4></div>
    <div class="item"><div class="d">Total tokens</div><h4 style="font-size:1.3rem;margin-top:4px">${(r.totalTokens||0).toLocaleString()}</h4></div>
    <div class="item"><div class="d">Total spend</div><h4 style="font-size:1.3rem;margin-top:4px">${usd(r.totalCostUsd)}</h4></div>
    <div class="item"><div class="d">Shared allocated <span class="chip" style="text-transform:none;letter-spacing:0;font-size:.6rem">4% platform overhead</span></div><h4 style="font-size:1.3rem;margin-top:4px">${usd(r.sharedAllocatedUsd)}</h4></div>
    <p class="d" data-costfootnote style="grid-column:1/-1;color:var(--muted);font-size:.72rem;margin:0">Totals shown are direct costs; shared platform allocation listed separately.</p>`
  // TLP-B5 G3: component breakdown — LLM (real metered) vs memory/KB/gateway
  // (simulated overhead), from the same componentTotals the reconciliation
  // check above derives, plus the shared-allocated line as its own bar so
  // it's never silently folded into the components.
  const cbox=document.getElementById('costcomponents')
  if(cbox && r.componentTotals){
    const ct=r.componentTotals
    const rows=[
      {label:'LLM (metered)',value:ct.llm,color:'#006ce0',display:usd(ct.llm)},
      {label:'Memory (estimated)',value:ct.memory,color:'#424650',display:usd(ct.memory)},
      {label:'KB (estimated)',value:ct.kb,color:'#656871',display:usd(ct.kb)},
      {label:'Gateway (estimated)',value:ct.gateway,color:'#8c8c94',display:usd(ct.gateway)},
      {label:'Shared allocated',value:r.sharedAllocatedUsd||0,color:'#b4b4bb',display:usd(r.sharedAllocatedUsd)},
    ]
    cbox.innerHTML=svgBars(rows)
  }
  // T12/S5: per-domain budget bars — tokensUsed rolls up from the same ledger
  // rows in the per-agent table below, compared against the vended tokenBudget.
  const dbox=document.getElementById('costdomains')
  if(dbox)dbox.innerHTML=(r.domains||[]).length
    ? (r.domains||[]).map(d=>{
        const pct=d.budgetPct, w=pct==null?0:Math.min(100,pct)
        const color=d.alert==='over'?'var(--err)':d.alert==='warn'?'var(--lock)':'var(--ok)'
        return `<div class="item" style="margin-bottom:8px" data-costdomain="${esc(d.id)}">
          <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap">
            <h4>${esc(d.name)}</h4>
            <div class="meta" style="margin:0"><span class="chip">${d.tokensUsed.toLocaleString()} tokens used</span><span class="chip">${usd(d.costUsd)}</span><span class="chip" style="color:var(--muted)">+ ${usd(d.sharedAllocatedUsd)} shared</span>
            ${d.tokenBudget?`<span class="chip">budget ${d.tokenBudget.toLocaleString()}</span>`:'<span class="chip" style="color:var(--muted)">no budget set</span>'}
            ${d.alert==='over'?'<span class="chip" style="color:var(--err);border-color:var(--err-bd)">⚠ over budget</span>':d.alert==='warn'?'<span class="chip" style="color:var(--lock);border-color:var(--lock-bd)">⚠ 80% of budget</span>':''}</div>
          </div>
          ${!d.tokensUsed?'<div class="d" style="margin-top:4px;color:var(--muted);font-size:.72rem">No invocations recorded yet.</div>':''}
          ${d.tokenBudget?`<div style="margin-top:8px;height:8px;border-radius:4px;background:var(--surface2);overflow:hidden">
            <div class="budgetbar" style="height:100%;width:${w}%;background:${color}"></div></div>
          <div class="d" style="margin-top:4px;color:var(--muted);font-size:.72rem">${pct}% of token budget consumed</div>`:''}
        </div>`}).join('')
    : '<div class="empty">No domains on the platform.</div>'
  box.innerHTML=(r.perAgent||[]).length
    ? `<table><thead><tr><th>Agent</th><th>Domain</th><th>Model</th><th>Invocations</th><th>Input tokens</th><th>Output tokens</th><th>Cost</th><th>Trend</th><th>Last activity</th></tr></thead><tbody>
      ${r.perAgent.map(a=>`<tr data-cost="${esc(a.project)}">
        <td><b>${esc(a.project)}</b></td>
        <td>${domChip(a.domain)}</td>
        <td style="font-size:.75rem;color:var(--muted)">${esc((a.model||'—').replace('global.anthropic.',''))}</td>
        <td>${a.invocations}</td><td>${a.inputTokens.toLocaleString()}</td><td>${a.outputTokens.toLocaleString()}</td>
        <td><b>${usd(a.costUsd)}</b>${a.estimated?' <span class="chip">estimated</span>':''}</td>
        <td>${(a.costTrend&&a.costTrend.length>1)?svgSpark(a.costTrend,'var(--plat)',80,22):'<span style="color:var(--muted);font-size:.7rem">—</span>'}</td>
        <td style="font-size:.75rem;color:var(--muted)">${esc((a.lastAt||'').slice(0,16).replace('T',' '))}</td></tr>`).join('')}
      </tbody></table>
      <p class="d" style="color:var(--muted);font-size:.72rem;margin-top:8px">Store: ${esc(r.store||'')}</p>`
    : '<div class="empty">No invocations recorded yet.</div>'
  const mbox=document.getElementById('costmodelbox')
  if(mbox)mbox.innerHTML=(r.perModel||[]).length
    ? `<table><thead><tr><th>Model</th><th>Invocations</th><th>Input tokens</th><th>Output tokens</th><th>Cost</th></tr></thead><tbody>
      ${r.perModel.map(m=>`<tr>
        <td style="font-size:.8rem">${esc((m.model||'—').replace('global.anthropic.',''))}</td>
        <td>${m.invocations}</td><td>${m.inputTokens.toLocaleString()}</td><td>${m.outputTokens.toLocaleString()}</td>
        <td><b>${usd(m.costUsd)}</b>${m.estimated?' <span class="chip">estimated</span>':''}</td></tr>`).join('')}
      </tbody></table>`
    : '<div class="empty">No invocations recorded yet.</div>'
  const pr=document.getElementById('costpricing')
  if(pr)pr.innerHTML=`<table><thead><tr><th>Model</th><th>Input / 1k tokens</th><th>Output / 1k tokens</th><th>As of</th></tr></thead><tbody>
    ${(r.pricing||[]).map(m=>`<tr><td>${esc(m.label)}</td>
      <td>${m.pricing?usd(m.pricing.inputPer1k):'—'}</td><td>${m.pricing?usd(m.pricing.outputPer1k):'—'}</td>
      <td style="color:var(--muted);font-size:.75rem">${esc(m.pricing?.asOf||'—')}</td></tr>`).join('')}
  </tbody></table>`
  wireFinopsOptimization()
}

// ---------- FinOps optimization recommendations (KeyStone pattern) ----------
// Modeled savings opportunities per agent — fixture rows scaled to a fleet-
// size projection, labeled as such. Apply is display-level (client state
// only); in production it would open a change request against the agent's
// model/config.
const FINOPS_RECS = [
  { id:'fo1', title:'Route supportdesk to Haiku 4.5', cat:'Model Swap',    savings:4800, effort:['Low','badge-green'],   agent:'supportdesk',
    d:'92% of its requests are short classification turns — Haiku 4.5 holds the eval bar at a fraction of the cost.' },
  { id:'fo2', title:'Enable prompt caching on returns-bot',  cat:'Caching',       savings:2100, effort:['Low','badge-green'],   agent:'returns-bot',
    d:'The 6k-token system prompt + KB preamble repeats on every call; caching cuts the re-billed input tokens.' },
  { id:'fo3', title:'Trim the opsassistant system prompt', cat:'Prompt Optimization', savings:1350, effort:['Medium','badge-blue'], agent:'opsassistant',
    d:'2.8k tokens of boilerplate instructions per invocation; a 60% trim keeps golden-set scores unchanged.' },
  { id:'fo4', title:'Batch order-tracker nightly reconciliation', cat:'Batch Processing', savings:900, effort:['Medium','badge-blue'], agent:'order-tracker',
    d:'Reconciliation runs are latency-insensitive — moving them to the batch API halves the per-token rate.' },
]
function finopsOptimizationCard(){
  S.finopsApplied = S.finopsApplied || new Set()
  const total = FINOPS_RECS.filter(r=>!S.finopsApplied.has(r.id)).reduce((s,r)=>s+r.savings,0)
  return `<div class="card" id="finopsopt"><div class="sec-h" style="margin-top:0">Optimization recommendations (${FINOPS_RECS.length}) ${srcBadge('projection')}
      <span class="chip" style="text-transform:none;letter-spacing:0">projected ${fmtUsd(total)}/mo available</span></div>
    <table><thead><tr><th>Recommendation</th><th>Category</th><th>Agent</th><th style="text-align:right">Est. savings/mo</th><th>Effort</th><th></th></tr></thead><tbody>
    ${FINOPS_RECS.map(r=>{
      const applied=S.finopsApplied.has(r.id)
      return `<tr data-finopsrec="${r.id}" ${applied?'style="opacity:.55"':''}>
        <td><b>${esc(r.title)}</b><div class="d" style="color:var(--muted);font-size:.72rem">${esc(r.d)}</div></td>
        <td><span class="chip type">${esc(r.cat)}</span></td>
        <td><code style="font-size:.72rem">${esc(r.agent)}</code></td>
        <td style="text-align:right"><b>${fmtUsd(r.savings)}</b></td>
        <td><span class="badge ${r.effort[1]}">${r.effort[0]}</span></td>
        <td style="text-align:right">${applied
          ?'<span class="chip" style="color:var(--ok);border-color:var(--ok-bd)">✓ applied</span>'
          :`<button class="ghost finopsapply" data-rec="${r.id}" style="padding:3px 12px;font-size:.72rem">Apply</button>`}</td>
      </tr>`}).join('')}
    </tbody></table></div>`
}
function wireFinopsOptimization(){
  document.querySelectorAll('.finopsapply').forEach(btn=>btn.onclick=()=>{
    S.finopsApplied.add(btn.dataset.rec)
    const card=document.getElementById('finopsopt')
    if(card){ card.outerHTML=finopsOptimizationCard(); wireFinopsOptimization() }
  })
}


// ---------- Approval policies + audit trail (Governance tabs, ex-HITL view) ----------
// Policies and the audit trail are REAL records (server-side JSON stores). The
// interrupt itself is SIMULATED: no deployed agent pauses — the console
// fabricates the tool-call event and walks it through the policy gate. The demo
// card carries a visible [illustrative] chip (D6: no mock/simulated wording in rendered UI).
const HITL_STATUS_BADGE = {
  pending:'badge-orange', approved:'badge-green', rejected:'badge-red', notified:'badge-blue',
  firing:'badge-red', suspended:'badge-red', resolved:'badge-green',
}
const hitlBadge = s=>`<span class="badge ${HITL_STATUS_BADGE[s]||'badge-grey'}">${esc(s)}</span>`
function hitlAuditRows(records){
  if(!records.length)return '<div class="empty">No audit records match.</div>'
  return `<table><thead><tr><th>When</th><th>Agent</th><th>Tool</th><th>Policy</th><th>Status</th><th>Decided by</th></tr></thead><tbody>
    ${records.map(r=>`<tr data-audit="${esc(r.requestId)}">
      <td style="font-size:.75rem;color:var(--muted)">${esc((r.requestedAt||'').slice(0,19).replace('T',' '))}</td>
      <td><b>${esc(r.project)}</b></td>
      <td><code>${esc(r.toolName)}</code>${r.toolInputSummary?`<div style="color:var(--muted);font-size:.72rem">${esc(r.toolInputSummary)}</div>`:''}</td>
      <td style="font-size:.78rem">${esc(r.policyName)}</td>
      <td>${hitlBadge(r.status)}</td>
      <td style="font-size:.75rem;color:var(--muted)">${esc(r.decidedBy||'—')}${r.reason?`<div style="font-size:.72rem">${esc(r.reason)}</div>`:''}</td></tr>`).join('')}
  </tbody></table>`
}
async function loadHitlAudit(){
  const box=document.getElementById('hitlaudit'); if(!box)return
  const agent=document.getElementById('haagent')?.value||''
  const status=document.getElementById('hastatus')?.value||''
  const q=new URLSearchParams(); if(agent)q.set('agent',agent); if(status)q.set('status',status)
  const r=await api('/hitl-audit?'+q)
  box.innerHTML=hitlAuditRows(r.records||[])+`<p class="d" style="color:var(--muted);font-size:.72rem;margin-top:6px">${r.total} record(s)${agent?` for ${esc(agent)}`:''}${status?` · ${esc(status)}`:''}</p>`
}
async function readHostedHitlPolicies(){
  let cursor=null,first=null
  const policies=[],seen=new Set(),ids=new Set()
  for(let page=0;page<10;page++){
    const r=await adminRead('/hitl'+(cursor?'?cursor='+encodeURIComponent(cursor):''))
    if(r?.ok!==true)return r
    if(r.schemaVersion!==1||!Number.isSafeInteger(r.revision)||r.revision<1
      ||r.domainId!==(activeDomain()||'platform')||r.source!=='workspace-hitl-policy-catalog'
      ||r.enforcement!=='NOT_CONFIGURED'||typeof r.updatedAt!=='string'||!Number.isFinite(Date.parse(r.updatedAt))
      ||r.partial===true||r.complete===false||r.error||r.code
      ||!Array.isArray(r.policies)||r.policies.some(p=>!p||!Number.isSafeInteger(p.version)||p.version<1||!p.scope||!(p.scope.kind==='domain'&&p.agentScope==='all'||p.scope.kind==='project'&&typeof p.scope.projectId==='string'&&p.scope.projectId===p.agentScope))||!(r.cursor===null||typeof r.cursor==='string'&&r.cursor.length>0)
      ||first&&(r.revision!==first.revision||r.updatedAt!==first.updatedAt))return {ok:false,code:'INVALID_RESPONSE'}
    if(!first)first=r
    for(const p of r.policies){
      if(!p||ids.has(p.id))return {ok:false,code:'INVALID_RESPONSE'}
      ids.add(p.id);policies.push(p)
    }
    if(policies.length>200)return {ok:false,code:'INVALID_RESPONSE'}
    if(r.cursor===null)return {...first,policies,cursor:null}
    if(seen.has(r.cursor))return {ok:false,code:'INVALID_RESPONSE'}
    seen.add(r.cursor);cursor=r.cursor
  }
  return {ok:false,code:'INVALID_RESPONSE'}
}
async function loadHitl(){
  const pbox=document.getElementById('hitlpolicies'); if(!pbox)return
  const current=adminReadStart(pbox,'/api/hitl · policies')
  const hosted=authMode()==='cognito'
  const [r,fleet]=await Promise.all([hosted?readHostedHitlPolicies():adminRead('/hitl'),hosted?Promise.resolve({agents:[]}):api('/fleet').catch(()=>({ok:false}))])
  if(!current())return
  if(hosted&&(r?.code==='HITL_POLICY_NOT_CONFIGURED')){pbox.innerHTML='<p data-read-state="unconfigured">No approval policy catalog is configured for this scope.</p>';return}
  if(adminReadFailure(pbox,r,['policies'],'/api/hitl · policies',loadHitl))return
  if(hosted){
    pbox.innerHTML=approvalCatalogView(r)
    mountDraftActivity(pbox,{catalog:r,kind:'policy',read:path=>rawApi(path),current,identity:hostedModelReadContext})
    pbox.querySelectorAll('[data-hp-refresh]').forEach(button=>button.onclick=sessionTaskHandler(async()=>{if(button.disabled||!current()||!confirmContextChange())return;button.disabled=true;await loadHitl()}))
    if(SESSION?.role==='admin'&&hasCap('manageApprovalPolicies')&&r.domainId==='platform')mountPolicyDraftEditor(pbox,{
      catalog:r,api,current,identity:hostedModelReadContext,requestId:createRequestId,dirty:businessForms,
      confirmChange:confirmContextChange,reload:async()=>{const identity=hostedModelReadContext();await loadHitl();if(identity===hostedModelReadContext()){const box=document.getElementById('hitlpolicies');if(box){const status=document.createElement('p');status.setAttribute('role','status');status.textContent='Disabled draft save confirmed. Check the refreshed catalog below; runtime enforcement is unchanged.';box.prepend(status)}}},
    })
    return
  }
  // agent scope + demo + audit filter selects share the live fleet
  const projects=[...new Set((fleet.agents||[]).map(a=>a.project||a.name))]
  const opts=projects.map(p=>`<option value="${esc(p)}">${esc(p)}</option>`).join('')
  const scope=document.getElementById('hpscope')
  if(scope)scope.innerHTML='<option value="all">All agents</option>'+opts
  const demo=document.getElementById('hiagent')
  if(demo)demo.innerHTML=opts||'<option value="">(no deployed agents)</option>'
  // pending tool calls are decided in the cross-type Approval queue tab (§7.1)
  // policies
  pbox.innerHTML=(r.policies||[]).map(p=>`<div class="item" style="margin-bottom:8px;display:flex;justify-content:space-between;align-items:center;gap:10px" data-policy="${esc(p.id)}">
    <div><h4>${SHIELD_IC}${esc(p.name)} ${p.enabled?'':'<span class="chip" style="color:var(--muted)">disabled</span>'}</h4>
      <div class="meta">${(p.toolMatch||[]).map(t=>`<span class="chip"><code>${esc(t)}</code></span>`).join('')}
        <span class="chip type">${p.mode==='notify_only'?'notify only':'require approval'}</span>
        <span class="chip">scope: ${hosted?esc(r.domainId)+' / ':''}${esc(p.agentScope)}</span>${hosted?`<span class="chip">catalog v${esc(r.revision)} · enforcement not configured</span>`:''}</div></div>
    ${hosted?'':`<div style="display:flex;gap:6px;flex-shrink:0">
      <button class="ghost htoggle" data-id="${esc(p.id)}" data-en="${p.enabled?'0':'1'}" style="padding:4px 10px;font-size:.75rem">${p.enabled?'Disable':'Enable'}</button>
      <button class="ghost hpdel" data-id="${esc(p.id)}" data-name="${esc(p.name)}" style="padding:4px 10px;font-size:.75rem;color:var(--err)">Remove</button>
    </div>`}</div>`).join('')||(hosted?'<div class="empty" data-read-state="empty">No approval policies returned by the configured source.</div>':'<div class="empty">No policies yet — create one below.</div>')
  if(hosted){
    pbox.innerHTML=`<div class="d" data-source="workspace-hitl-policy-catalog">Source: /api/hitl · workspace-hitl-policy-catalog · Domain: ${esc(r.domainId)} · catalog v${esc(r.revision)} · Updated: ${esc(r.updatedAt)} · ${r.policies.length} policies (all pages loaded). Enforcement not configured. <button class="ghost" data-hp-refresh>Refresh policies</button></div>`+pbox.innerHTML
    pbox.querySelectorAll('[data-hp-refresh]').forEach(button=>button.onclick=sessionTaskHandler(async()=>{
      if(button.disabled||!button.isConnected||!current())return
      button.disabled=true;await loadHitl()
    }))
    return
  }
  pbox.querySelectorAll('.htoggle').forEach(btn=>btn.onclick=sessionTaskHandler(async()=>{
    btn.disabled=true
    const rr=await api('/hitl-policy-update',{id:btn.dataset.id,enabled:btn.dataset.en==='1'})
    if(rr.ok)runSessionTask(loadHitl); else {btn.disabled=false;alert(rr.error||'update failed')}
  }))
  pbox.querySelectorAll('.hpdel').forEach(btn=>btn.onclick=sessionTaskHandler(async()=>{
    if(!confirm(`Remove policy "${btn.dataset.name}"?`))return
    btn.disabled=true
    const rr=await api('/hitl-policy-remove',{id:btn.dataset.id})
    if(rr.ok)runSessionTask(loadHitl); else {btn.disabled=false;alert(rr.error||'remove failed')}
  }))
  runSessionTask(loadHitlAudit)
}
function wireHitl(){
  if(authMode()==='cognito')return
  const create=document.getElementById('hpcreate'); if(!create)return
  create.onclick=sessionTaskHandler(async()=>{
    const st=document.getElementById('hpstatus')
    const body={
      name:document.getElementById('hpname').value.trim(),
      toolMatch:document.getElementById('hptools').value,
      mode:document.getElementById('hpmode').value,
      agentScope:document.getElementById('hpscope').value,
    }
    st.innerHTML='<div class="status info"><span class="spin">⟳</span> creating…</div>'
    const r=await api('/hitl-policy-create',body)
    if(r.ok){st.innerHTML=`<div class="status ok">✓ Policy <b>${esc(r.policy.name)}</b> created (${pluralize(r.policy.toolMatch.length,'pattern')}).</div>`
      businessForms.clear('policy')
      document.getElementById('hpname').value='';document.getElementById('hptools').value='';runSessionTask(loadHitl)}
    else st.innerHTML=`<div class="status err">${esc(r.error||'create failed')}</div>`
  })
  const fire=document.getElementById('hifire')
  if(fire&&authMode()!=='cognito')fire.onclick=sessionTaskHandler(async()=>{
    const st=document.getElementById('histatus')
    const body={
      project:document.getElementById('hiagent').value,
      toolName:document.getElementById('hitool').value.trim(),
      toolInput:document.getElementById('hiinput').value.trim(),
    }
    st.innerHTML='<div class="status info"><span class="spin">⟳</span> agent calls the tool…</div>'
    const r=await api('/hitl-interrupt',body)
    if(!r.ok)st.innerHTML=`<div class="status err">${esc(r.error||'interrupt failed')}</div>`
    else if(!r.matched)st.innerHTML=`<div class="status info">No enabled policy matches <code>${esc(body.toolName)}</code> — the call proceeds without approval (still worth a policy?).</div>`
    else if(r.request.status==='pending'){st.innerHTML=`<div class="status ok">${HAND_IC}Interrupted: <code>${esc(r.request.toolName)}</code> is paused by policy <b>${esc(r.request.policyName)}</b>. Decide it in the <b>Approval queue</b> tab.</div>`;runSessionTask(loadHitl)}
    else {st.innerHTML=`<div class="status ok">${BELL_IC}Notified: policy <b>${esc(r.request.policyName)}</b> logged the call and let it continue.</div>`;runSessionTask(loadHitl)}
  })
  const f1=document.getElementById('haagent'),f2=document.getElementById('hastatus')
  if(f1)f1.onchange=sessionTaskHandler(loadHitlAudit)
  if(f2)f2.onchange=sessionTaskHandler(loadHitlAudit)
}

function foundationRows(f){
  return [['Identity',f.identity],['Memory',f.memory],['Observability',f.observability],['Guardrails',f.guardrails],['Runtime',f.runtime]]
    .map(([k,v])=>`<div class="lock"><b>${LOCK_IC}${esc(k)}</b><span>${esc(v||'')}</span></div>`).join('')
}
// One blueprint card = a predefined Foundation Harness template. Show the common
// dimensions (framework · memory · identity); only surface advanced ones (build,
// protocol) when they DIFFER from the defaults (CodeZip / HTTP), so ordinary blueprints
// stay clean and special ones (Claude SDK=Container, MCP Server=MCP) stand out.
function blueprintCard(b, opts){
  const t=b.template||{}
  const chip=(v)=>`<span class="chip type">${esc(v)}</span>`
  const flag=(v)=>`<span class="chip">${esc(v)}</span>`
  const advanced=[]
  if(t.build && t.build!=='CodeZip') advanced.push(flag('build: '+t.build))
  if(t.protocol && t.protocol!=='HTTP') advanced.push(flag('protocol: '+t.protocol))
  return `<div class="card ${opts&&opts.pick?'bp':''} ${opts&&opts.sel?'sel':''}" ${opts&&opts.pick?`data-bp="${esc(b.id)}"`:''}>
    <h4 style="font-size:1.02rem">${BP_IC} ${esc(b.name)}${b.version?` <span class="chip type" title="versioned in the AI Registry — agents pin the version they were composed from">v${esc(b.version)}</span>`:''}</h4>
    <div class="d" style="color:var(--dim);font-size:.8rem;margin-bottom:8px">${esc(b.useCase||'')}</div>
    <div class="meta" style="margin-bottom:8px">
      ${b.recommended?flag('Recommended · Strands + AgentCore'):''}
      ${flag(t.framework||'Not specified')}${flag(t.deployTarget||'Not specified')}
      ${flag('memory: '+(t.memory||'none'))}${t.identity?flag('per-user identity'):''}
      ${advanced.join('')}
    </div>
    ${opts&&opts.expandable?`<details class="bpharness" ${S.bpOpen===b.id?'open':''} data-bpdetail="${esc(b.id)}">
      <summary style="cursor:pointer;font-size:.76rem;color:var(--accent)">Harness &amp; parameters</summary>
      ${blueprintHarnessDetail(b)}
    </details>`:''}
  </div>`
}
// The expanded panel is the blueprint's real contract: where the harness code
// lives (exportable repo / GitHub / S3 bundle / illustrative-only, stated
// honestly), what the export contains, and every pre-wired parameter. Cards
// stay minimal; nothing here renders unless the platform actually declared it.
function blueprintHarnessDetail(b){
  const t=b.template||{}
  const src=b.source||null
  const githubUrl=(()=>{
    try{const url=new URL(src?.url);return url.protocol==='https:'&&!url.username&&!url.password?url.href:null}catch{return null}
  })()
  const row=(k,v)=>v==null?'':`<div class="lock" style="border-top-color:var(--border)"><b style="color:var(--dim);min-width:130px">${k}</b><span style="font-size:.78rem">${v}</span></div>`
  const srcHtml=!src
    ? row('Template source','<span class="chip">unknown — record predates source tracking</span>')
    : src.kind==='repo'
    ? row('Template source',`<span class="chip" style="color:var(--ok);border-color:var(--ok-bd)">exportable repo</span> <code style="font-size:.74rem">blueprints/${esc(src.templateId)}</code><div style="color:var(--muted);font-size:.72rem;margin-top:3px">Compose-to-deploy exports this harness — AGENTS.md, agentcore.json spec, app code, CDK, CI gates and a starter golden dataset — to your GitHub repo. Continue building there with a coding agent.</div>`)
    : src.kind==='github'
    ? row('Template source',`<span class="chip">GitHub template</span> ${githubUrl?`<a href="${esc(githubUrl)}" target="_blank" rel="noopener noreferrer" style="font-size:.76rem">${esc(githubUrl)}</a>`:`<code>${esc(src.url||'Invalid template URL')}</code>`}<div style="color:var(--muted);font-size:.72rem;margin-top:3px">External framework template — the platform pins the framework/hosting contract below; the harness code starts from this repository.</div>`)
    : src.kind==='s3'
    ? row('Template source',`<span class="chip">S3 bundle</span> <code style="font-size:.74rem">${esc(src.uri||'')}</code>${src.uploadedBy?`<span class="chip">uploaded by ${esc(src.uploadedBy)}</span>`:''}`)
    : row('Template source','<span class="chip" style="color:var(--muted)">illustrative</span> <span style="color:var(--muted);font-size:.74rem">documents a supported framework × hosting combination — no published harness code yet</span>')
  const modelHtml=t.modelSelection==='domain-approved'
    ? 'Choose from this domain’s allowed models during project / agent setup.'
    :t.defaultModel===undefined?null
    :t.defaultModel===null?'none — this blueprint runs no LLM (tool server)'
    :`<code style="font-size:.76rem">${esc(t.defaultModel)}</code> <span class="chip">override in the build wizard</span>`
  const params=[['framework',t.framework],['deployTarget',t.deployTarget],['build',t.build],['protocol',t.protocol],['memory',t.memory],['streaming',t.streaming],['identity',t.identity],['guardrails',t.guardrails]]
    .filter(([,v])=>v!==undefined)
    .map(([k,v])=>`<span class="chip">${k}: ${esc(String(v))}</span>`).join('')
  return `<div style="margin-top:8px">
    ${srcHtml}
    ${row('Default model',modelHtml)}
    ${Array.isArray(t.tools)?row('Pre-wired tools',t.tools.length?t.tools.map(x=>`<span class="chip">${esc(x)}</span>`).join(''):'none — add tools from the Registry in the build wizard'):''}
    ${t.observability?row('Observability',esc(t.observability)):''}
    ${row('Harness parameters',`<div class="meta" style="font-size:.72rem">${params}</div>`)}
  </div>`
}
// ---------- TLP-B4: Platform Approvals — the 4-eyes exemption queue ----------
// Layer-2 decisions (and escalated layer-1 rows) for guardrail exemptions.
// Every decide re-checks server-side: self-approval and same-approver-both-
// layers get a 403 + an audit row there, never a UI-only disable.
// TLP-B7: the former standalone Platform Approvals view — now the
// Governance & Approvals › Platform approvals tab. Same 4-eyes queue, plus
// the blueprint-submission peer queue (scope 3).
function govExemptionsTab(){
  return `<div class="card" id="exception-requests">
    <div id="apxlist"><div class="empty"><span class="spin">⟳</span> loading exemption requests…</div></div></div>
  ${hasCap('viewAllDomains')?`<div class="card" id="blueprint-requests"><div class="console-resource-header"><div><h2>Blueprint submissions</h2><p>Versioned templates awaiting an independent platform reviewer.</p></div><button class="ghost storynext" data-goview="blueprints">Submit a blueprint</button></div>
    <div id="bpsublist"><div class="empty"><span class="spin">⟳</span> loading blueprint submissions…</div></div></div>`:''}`
}
async function loadApprovals(){
  const box=document.getElementById('apxlist'); if(!box)return
  if(authMode()==='cognito'){
    const current=adminReadStart(box,'guardrail-exceptions')
    return mountGuardrailExceptions(box,{
      api,read:adminRead,projects:()=>readHostedCollection('projects'),
      identity:hostedModelReadContext,current,requestId:createRequestId,controls:GUARDRAIL_CATALOG,
      viewer:{actor:SESSION?.actor||SESSION?.user,role:SESSION?.role},
    })
  }
  const current=adminReadStart(box,'/api/policy-exemptions · exemptions')
  const r=await adminRead('/policy-exemptions')
  if(!current())return
  // AP-03: a real read failure (incl. the current 404) keeps the exemption
  // card in an explicit unavailable state — never coerced to “no requests” or
  // backfilled from ordinary approvals. adminReadFailure preserves the error
  // state + retry; we label it for the exemption contract without widening it.
  if(adminReadFailure(box,r,['exemptions'],'/api/policy-exemptions · exemptions',loadApprovals)){
    const state=adminReadState(r,['exemptions'],'/api/policy-exemptions')
    const note=state==='forbidden'?'You do not have permission to view exemption requests.'
      :state==='unconfigured'?'Exemption requests are currently unavailable.'
      :'Exemption requests are currently unavailable.'
    const status=box.querySelector?.('[data-read-state]')
    if(status)status.insertAdjacentHTML('afterbegin',`<div class="d">${esc(note)}</div>`)
    return
  }
  const rows=r.exemptions||[]
  if(!rows.length){ box.innerHTML='<div class="empty">No exemption requests.</div>'; return }
  const stChip=s=>({pending_domain:['layer 1 · pending','--lock'],pending_platform:['layer 2 · pending','--lock'],applied:['applied','--ok'],rejected_domain:['rejected · layer 1','--err'],rejected_platform:['rejected · layer 2','--err'],expired:['expired','--muted'],revoked:['revoked','--err']}[s]||[s,'--muted'])
  // TLP-B6: applied exemptions are time-boxed (expiresAt) and revocable by
  // the same roles that approve — the server gates; this button is affordance.
  const canRevoke=hasCap('decideBreakGlass')||hasCap('decideAccessRequests')
  box.innerHTML=rows.map(x=>{
    const [label,tone]=stChip(x.status)
    const pending=x.status==='pending_domain'||x.status==='pending_platform'
    const ends=x.status==='applied'&&x.expiresAt?`<span class="chip" data-expiry style="color:var(--lock);border-color:var(--lock-bd)">expires ${esc(x.expiresAt.slice(0,10))}</span>`
      :x.status==='revoked'?`<span class="chip" data-expiry style="color:var(--muted);border-color:var(--muted-bd)">revoked by ${esc(x.revokedBy||'—')} · ${esc((x.revokedAt||'').slice(0,10))}</span>`
      :x.status==='expired'?`<span class="chip" data-expiry style="color:var(--muted);border-color:var(--muted-bd)">expired ${esc((x.expiresAt||'').slice(0,10))}</span>`:''
    return `<div class="item" style="margin-bottom:8px">
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
        <b style="font-size:.82rem">${esc(x.guardrail)}</b>
        <span class="chip">${esc(x.project)}</span><span class="chip">${esc(x.domain)}</span>
        <span class="chip" style="color:var(${tone});border-color:var(${tone}-bd)">${esc(label)}</span>
        ${ends}
        ${x.layer1Queue==='platform'&&x.status==='pending_domain'?'<span class="chip" style="color:var(--plat);border-color:var(--plat-bd)">layer 1 escalated · single-lead domain</span>':''}
      </div>
      <div class="d" style="font-size:.78rem;color:var(--dim);margin-top:4px">requested by <b>${esc(x.requesterName)}</b> · ${esc(x.reason)}</div>
      <div class="d" style="font-size:.72rem;color:var(--muted);margin-top:3px">
        layer 1: ${x.layer1DecidedBy?esc(x.layer1DecidedBy):'—'} · layer 2: ${x.layer2DecidedBy?esc(x.layer2DecidedBy):'—'} · ${(x.history||[]).length} audit entries</div>
      ${pending?`<div class="bar" style="margin-top:8px">
        <button class="primary apxdecide" data-id="${esc(x.id)}" data-d="approve" style="padding:5px 12px;font-size:.75rem">Approve ${x.status==='pending_domain'?'layer 1':'layer 2'}</button>
        <button class="ghost apxdecide" data-id="${esc(x.id)}" data-d="reject" style="padding:5px 12px;font-size:.75rem;color:var(--err);border-color:var(--err)">Reject</button>
        <span class="apxmsg" style="font-size:.75rem;color:var(--err)"></span></div>`:''}
      ${x.status==='applied'&&canRevoke?`<div class="bar" style="margin-top:8px">
        <button class="ghost apxrevoke" data-id="${esc(x.id)}" style="padding:5px 12px;font-size:.75rem;color:var(--err);border-color:var(--err-bd)">Revoke exemption</button>
        <span class="apxmsg" style="font-size:.75rem;color:var(--err)"></span></div>`:''}
    </div>`}).join('')
  box.querySelectorAll('.apxdecide').forEach(btn=>btn.onclick=sessionTaskHandler(async()=>{
    btn.disabled=true
    const rr=await api('/policy-exemption-decide',{id:btn.dataset.id,decision:btn.dataset.d})
    if(!rr.ok){ btn.disabled=false; const m=btn.parentElement.querySelector('.apxmsg'); if(m)m.textContent=rr.error||'Decision failed.'; return }
    runSessionTask(loadApprovals)
  }))
  box.querySelectorAll('.apxrevoke').forEach(btn=>btn.onclick=sessionTaskHandler(async()=>{
    btn.disabled=true
    const rr=await api('/policy-exemption-revoke',{id:btn.dataset.id})
    if(!rr.ok){ btn.disabled=false; const m=btn.parentElement.querySelector('.apxmsg'); if(m)m.textContent=rr.error||'Revoke failed.'; return }
    runSessionTask(loadApprovals)
  }))
}

function vBlueprints(){
  // TLP-B7 scope 3: platform members get an "add a blueprint" submission
  // entry — a structured form, validated server-side, that lands in the peer
  // approval queue. Display gating only; /api/blueprint-submit re-checks.
  const canSubmit = hasCap('manageRegistryEntries')
  const opts = (S.catalog&&S.catalog.blueprintOptions)||{}
  const submitCard = !canSubmit ? '' : `
  <div class="card" id="bpsubmitcard"><div class="sec-h" style="margin-top:0">Add a blueprint <span class="chip" style="color:var(--plat);border-color:var(--plat-bd)">peer approval required</span></div>
    <div class="grid2">
      <div><label style="margin-top:0">Blueprint id (slug)</label><input id="bsid" placeholder="e.g. voice-assistant"/></div>
      <div><label style="margin-top:0">Name</label><input id="bsname" placeholder="e.g. Voice Assistant"/></div>
    </div>
    <label>Description / use case</label><input id="bsusecase" placeholder="e.g. Speech-driven assistant with tool use"/>
    <div class="grid2">
      <div><label>Base template</label><select id="bsbase"><option value="">— start from a published blueprint —</option>${S.blueprints.map(b=>`<option value="${esc(b.id)}">${esc(b.name)}</option>`).join('')}</select></div>
      <div><label>Framework</label><select id="bsfw">${(opts.framework||[]).map(f=>`<option>${esc(f)}</option>`).join('')}</select></div>
      <div><label>Deploy target</label><select id="bsdt">${(opts.deployTarget||[]).map(f=>`<option>${esc(f)}</option>`).join('')}</select></div>
      <div><label>Protocol</label><select id="bsproto">${(opts.protocol||[]).map(f=>`<option>${esc(f)}</option>`).join('')}</select></div>
      <div><label>Memory</label><select id="bsmem">${(opts.memory||[]).map(f=>`<option>${esc(f)}</option>`).join('')}</select></div>
    </div>
    <label>Template source — where the harness code lives</label>
    <div class="grid2">
      <div><select id="bssrckind">
        <option value="">— no code yet (illustrative combination) —</option>
        <option value="github">GitHub template repository</option>
        <option value="s3">S3 bundle (uploaded template)</option>
      </select></div>
      <div><input id="bssrcref" placeholder="https://github.com/org/template-repo or s3://bucket/prefix/template.zip" disabled/></div>
    </div>
    <label>…or upload the template as JSON <span class="chip" style="text-transform:none;letter-spacing:0">overrides the pickers; same schema as catalog blueprints</span></label>
    <textarea id="bsjson" placeholder='{"framework":"Strands","deployTarget":"AgentCore Runtime","protocol":"HTTP","memory":"shortTerm","streaming":true,"identity":true,"guardrails":true}' style="min-height:60px;font-family:'IBM Plex Mono',ui-monospace,monospace;font-size:.76rem"></textarea>
    <div class="bar"><button class="primary" id="bssubmit">Submit for approval</button><span id="bsmsg" style="font-size:.78rem"></span></div>
  </div>`
  return `<span class="roletag plat">Platform team · control plane</span><h1>Foundation Harness Blueprints</h1>
  <p class="subtitle">Platform-published templates with identity, memory, observability and guardrails pre-wired.</p>
  ${hasCap('viewAllDomains')
    ? storyLine('','registry','Version them in the Registry')
    : storyLine('','compose','Build an Agent')}
  <div class="grid2">${S.blueprints.map(b=>blueprintCard(b,{expandable:true})).join('')}</div>
  ${submitCard}`
}
function wireBlueprintSubmit(){
  const btn=document.getElementById('bssubmit'); if(!btn)return
  const base=document.getElementById('bsbase')
  if(base)base.onchange=()=>{
    const bp=S.blueprints.find(b=>b.id===base.value); if(!bp)return
    const t=bp.template||{}
    for(const [sel,key] of [['bsfw','framework'],['bsdt','deployTarget'],['bsproto','protocol'],['bsmem','memory']]){
      const el=document.getElementById(sel); if(el&&t[key])el.value=t[key]
    }
  }
  const srcKind=document.getElementById('bssrckind')
  const srcRef=document.getElementById('bssrcref')
  if(srcKind&&srcRef)srcKind.onchange=()=>{
    srcRef.disabled=!srcKind.value
    srcRef.placeholder=srcKind.value==='s3'?'s3://bucket/prefix/template.zip':'https://github.com/org/template-repo'
    if(!srcKind.value)srcRef.value=''
  }
  btn.onclick=sessionTaskHandler(async()=>{
    const v=id=>document.getElementById(id).value
    const msg=document.getElementById('bsmsg')
    let template
    if(v('bsjson').trim()){
      try{ template=JSON.parse(v('bsjson')) }catch{ msg.style.color='var(--err)'; msg.textContent='Template JSON is not valid JSON.'; return }
    } else {
      const baseT=(S.blueprints.find(b=>b.id===v('bsbase'))||{}).template||{}
      template={ ...baseT, framework:v('bsfw'), deployTarget:v('bsdt'), protocol:v('bsproto'), memory:v('bsmem') }
      if(!('streaming' in template))template.streaming=true
      if(!('identity' in template))template.identity=true
      if(!('guardrails' in template))template.guardrails=true
    }
    // Source is validated server-side (kind/URL shape); empty = illustrative.
    const kind=v('bssrckind'), ref=v('bssrcref').trim()
    if(kind&&!ref){ msg.style.color='var(--err)'; msg.textContent=kind==='s3'?'An S3 URI is required for an uploaded template.':'A GitHub repository URL is required.'; return }
    const source=!kind?{kind:'illustrative'}:kind==='s3'?{kind:'s3',uri:ref}:{kind:'github',url:ref}
    btn.disabled=true
    const payload={id:v('bsid').trim(),name:v('bsname').trim(),useCase:v('bsusecase').trim(),template,source}
    const r=authMode()==='cognito'?await submitHostedBlueprint(payload):await api('/blueprint-submit',payload)
    btn.disabled=false
    if(!r.ok){ msg.style.color='var(--err)'; msg.textContent=(r.errors||[r.error||apiErrorMessage(r,'Submission failed. Please retry.')]).join(' '); return }
    msg.style.color='var(--ok)'; msg.textContent=`Submitted — "${r.submission.name}" is pending peer approval.`
    businessForms.clear('blueprint')
    for(const id of ['bsid','bsname','bsusecase','bsjson','bssrcref'])document.getElementById(id).value=''
  })
}
async function submitHostedBlueprint(payload){
  const fingerprint=JSON.stringify([hostedModelReadContext(),payload])
  if(S.blueprintSubmissionOperation?.fingerprint!==fingerprint)S.blueprintSubmissionOperation={
    fingerprint,registerId:createRequestId(),submitId:createRequestId(),approvalId:hostedMutationSlug('blueprint'),draft:null,
  }
  const operation=S.blueprintSubmissionOperation
  if(!operation.draft){
    const result=await api('/governance/resources',{
      domainId:'platform',resourceType:'BLUEPRINT',resourceId:payload.id,displayName:payload.name,
      description:payload.useCase,version:'1.0.0',shared:true,
      specification:{template:payload.template,source:payload.source,useCase:payload.useCase},
    },{requestId:operation.registerId})
    if(result?.ok!==true)return result
    operation.draft=result
  }
  const result=await api('/governance/publications',{
    approvalId:operation.approvalId,registryId:operation.draft.registryId,recordId:operation.draft.recordId,
  },{requestId:operation.submitId})
  if(result?.ok!==true)return result
  S.blueprintSubmissionOperation=null
  return {ok:true,submission:{name:payload.name,id:result.approval?.id}}
}
// The blueprint-submission peer queue (Governance & Approvals › Platform
// approvals). Approve/reject re-checked server-side; self-approval 403s.
async function loadBlueprintSubmissions(){
  const box=document.getElementById('bpsublist'); if(!box)return
  if(authMode()==='cognito')return loadAdminApprovalQueue(box,'RESOURCE_PUBLICATION','BLUEPRINT',loadBlueprintSubmissions)
  const current=adminReadStart(box,'/api/blueprint-submissions · submissions')
  const r=await adminRead('/blueprint-submissions')
  if(!current())return
  if(adminReadFailure(box,r,['submissions'],'/api/blueprint-submissions · submissions',loadBlueprintSubmissions))return
  const rows=r.submissions||[]
  if(!rows.length){ box.innerHTML='<div class="empty">No blueprint submissions.</div>'; return }
  const stChip=s=>({pending_approval:['pending approval','--lock'],approved:['approved','--ok'],rejected:['rejected','--err']}[s]||[s,'--muted'])
  box.innerHTML=rows.map(s=>{
    const [label,tone]=stChip(s.status)
    const t=s.template||{}
    return `<div class="item" style="margin-bottom:8px" data-bpsub="${esc(s.id)}">
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
        <b style="font-size:.82rem">${esc(s.name)}</b>
        <span class="chip">${esc(s.blueprintId)}</span>
        <span class="chip" style="color:var(${tone});border-color:var(${tone}-bd)">${esc(label)}</span>
        <span class="chip">${esc(t.framework||'—')} · ${esc(t.deployTarget||'—')}</span>
      </div>
      <div class="d" style="font-size:.78rem;color:var(--dim);margin-top:4px">submitted by <b>${esc(s.submitterName)}</b> · ${esc(s.useCase||'')}</div>
      <div class="d" style="font-size:.72rem;color:var(--muted);margin-top:3px">decided by: ${s.decidedBy?esc(s.decidedBy):'—'} · ${(s.history||[]).length} audit entries</div>
      ${s.status==='pending_approval'?`<div class="bar" style="margin-top:8px">
        <button class="primary bpsubdecide" data-id="${esc(s.id)}" data-d="approve" style="padding:5px 12px;font-size:.75rem">Approve</button>
        <button class="ghost bpsubdecide" data-id="${esc(s.id)}" data-d="reject" style="padding:5px 12px;font-size:.75rem;color:var(--err);border-color:var(--err)">Reject</button>
        <span class="bpsubmsg" style="font-size:.75rem;color:var(--err)"></span></div>`:''}
    </div>`}).join('')
  box.querySelectorAll('.bpsubdecide').forEach(btn=>btn.onclick=sessionTaskHandler(async()=>{
    btn.disabled=true
    const rr=await api('/blueprint-submission-decide',{id:btn.dataset.id,decision:btn.dataset.d})
    if(!rr.ok){ btn.disabled=false; const m=btn.parentElement.querySelector('.bpsubmsg'); if(m)m.textContent=rr.error||'Decision failed.'; return }
    S.blueprints=[]   // approved blueprints join /api/blueprints — refresh the cache
    runSessionTask(loadBlueprintSubmissions)
  }))
}

async function vFleet(){
  if(authMode()==='cognito'&&S.who==='user')return vApprovedAgents()
  if(S.fleetAgent) return vAgentDetail()
  return `<span class="roletag plat">Platform team · control plane</span><h1>Agent Fleet</h1>
  <p class="subtitle">${hasCap('viewAllDomains')
    ? 'Every deployed agent, all domains, live from AgentCore.'
    : 'Your domain’s deployed agents, live from AgentCore.'}</p>
  ${hasCap('viewAllDomains')
    ? storyLine('','monitoring','Drill into Monitoring')
    : storyLine('','observability','Drill into Observability')}
  ${scopeNote()}
  <div class="card" id="fleetbox"><div class="empty"><span class="spin">⟳</span> loading live runtimes…</div></div>`
}
async function loadFleet(){
  const f=await api('/fleet'); S.fleet=f
  const box=document.getElementById('fleetbox'); if(!box)return
  // Persona scoping: End User sees only usable (chat-able) agents that passed
  // the governance gate (APPROVED), no delete; delete is a Platform Admin write
  // affordance (Loom's readOnly pattern).
  const agents = S.who==='user' ? f.agents.filter(a=>a.project&&a.approval==='APPROVED') : f.agents
  const canDelete = S.who==='admin'
  if(!agents.length){
    if(S.who==='user'){ box.innerHTML=`<div class="empty">No agents published for you yet.</div>`; return }
    // B13: onboarding empty state — the bare one-liner left this page
    // near-blank on a fresh install. Renders ONLY when the fleet is empty.
    box.innerHTML=`<div class="empty" id="fleetonboard" style="text-align:center;padding:40px 20px">
      <div class="icbig" style="margin-bottom:8px">${ic2(ICONS.fleet)}</div>
      <h3 style="margin:0 0 6px">Your agent fleet lives here</h3>
      <p class="d" style="color:var(--dim);max-width:480px;margin:0 auto 14px">Once agents are deployed in ${esc(f.region)}, this table tracks each one's status, health, version and cost — live from AgentCore. Build your first agent to get started.</p>
      <button class="primary" id="fleetonboardbuild">Build Agent +</button>
    </div>`
    document.getElementById('fleetonboardbuild').onclick=()=>{ S.view='compose'; S.door='blueprint'; S.step=S.step||1; render() }
    return
  }
  // B18: enduser Agents as cards (B17 workspace-fleet card pattern) — name,
  // lifecycle badge, short description, one Chat entry point. No approval/
  // cost/delete surface (persona scoping unchanged).
  if(S.who==='user'){
    const desc=a=>((S.domains||[]).find(d=>d.id===a.domain)||{}).description||'Reviewed and approved — ready to chat.'
    box.innerHTML=`<div class="grid3">${agents.map(a=>`<div class="card bp eufleetcard" data-agent="${esc(a.project)}" data-name="${esc(a.name)}" style="cursor:pointer">
      <h4>${ic2(ICONS.chat)}${esc(a.name)}</h4>
      <div class="meta" style="margin:4px 0"><span class="chip" data-lcbadge="registered" style="color:var(--dom);border-color:var(--dom-bd)">${LIFECYCLE_LABELS.registered}</span>${domChip(a.domain)}</div>
      <p class="d" style="font-size:.78rem;color:var(--dim);margin:4px 0 6px">${esc(desc(a))}</p>
      <div class="bar" style="margin-top:8px"><button class="ghost eufleetchat" style="padding:4px 14px;font-size:.75rem">${ic2(ICONS.chat)}Chat →</button></div>
    </div>`).join('')}</div>
    <p class="d" style="color:var(--muted);font-size:.75rem;margin-top:10px">${pluralize(agents.length,'agent')}</p>`
    box.querySelectorAll('.eufleetcard').forEach(card=>card.onclick=()=>{
      S.fleetAgent={project:card.dataset.agent,name:card.dataset.name}; S.detail=null; S.fleetChat=[]; S.fleetSession=null; render()
    })
    return
  }
  const costCell=a=>a.cost
    ? `<span data-costbadge="${esc(a.project)}" style="color:var(--dom);font-weight:600">${usd(a.cost.costUsd)}</span><span style="color:var(--muted);font-size:.72rem"> · ${a.cost.invocations} inv${a.cost.estimated?' ~':''}</span>`
    : '<span style="color:var(--muted)">—</span>'
  // T30: health badge from the agent's latest errorRate (same aggregate signal
  // Observability computes — see obsSeries('errorRate')), matches existing badge CSS.
  // T13B: an active alert overrides derived health — SEV1 auto-suspends (§8.4).
  const healthBadge=a=>a.health==='suspended'
    ? `<span class="chip" style="background:var(--err-bg);color:var(--err);border-color:var(--err-bd);font-weight:600" title="${esc(a.alert?.policyName||'')} (${esc(a.alert?.severity||'')}) — auto-suspended pending Platform Admin review">■ suspended</span>`
    : a.health==='degraded'
    ? `<span class="chip" style="color:var(--err);border-color:var(--err-bd)" title="${a.alert?esc(a.alert.policyName)+' ('+esc(a.alert.severity)+') firing':`errorRate ${a.errorRate}% (last day)`}">● degraded</span>`
    : `<span class="chip" style="color:var(--ok);border-color:var(--ok-bd)" title="errorRate ${a.errorRate}% (last day)">● healthy</span>`
  box.innerHTML=`<table><thead><tr><th>${S.who==='user'?'Agent':'Agent runtime'}</th><th>Status</th>${S.who==='user'?'':'<th>Domain</th><th>Owner team</th><th>Approval</th><th>Health</th><th>Version</th><th>Last deploy</th><th>Cost</th>'}<th>Region</th><th></th>${canDelete?'<th></th>':''}</tr></thead><tbody>
    ${agents.map(a=>`<tr data-name="${esc(a.name)}">
      <td ${a.project?`data-agent="${esc(a.project)}" style="cursor:pointer"`:'style="opacity:.55"'}>${esc(a.name)}${(a.driftedDependencies?.length&&S.who!=='user')?` <span class="chip" data-driftbadge="${esc(a.project||'')}" style="color:var(--lock);border-color:var(--lock-bd)" title="drifted dependency: ${esc(a.driftedDependencies.join(', '))} — re-approval pending in AI Registry">drifted dependency</span>`:''}${a.blueprintUpgrade?` <span class="chip" data-bpupgrade="${esc(a.project||'')}" style="color:var(--info);border-color:var(--info-bd)" title="blueprint ${esc(a.blueprintPin?.blueprint||'')} pinned at v${esc(a.blueprintUpgrade.from)}; platform approved v${esc(a.blueprintUpgrade.to)} — this agent keeps its pinned version until re-composed (§4.1.1)">blueprint upgrade available</span>`:''}</td>
      <td><span class="st ${esc(a.status)}"></span>${esc(a.status)}</td>${S.who==='user'?'':`<td>${domChip(a.domain)}</td><td><span class="chip" data-ownerteam style="${a.ownerTeam==='Platform team'?'color:var(--plat);border-color:var(--plat-bd)':'color:var(--dom);border-color:var(--dom-bd)'}">${esc(a.ownerTeam||'—')}</span></td><td>${mcpBadge(a.approval)}</td><td>${healthBadge(a)}</td><td style="font-size:.72rem;color:var(--muted);max-width:220px" title="${esc(a.version||'')}">${esc((a.version||'—').length>36?(a.version.slice(0,36)+'…'):(a.version||'—'))}</td><td style="font-size:.74rem;color:var(--muted)">${esc((a.lastDeploy||'').slice(0,16).replace('T',' ')||'—')}</td><td>${costCell(a)}</td>`}<td>${esc(f.region)}</td>
      <td style="text-align:right;color:${a.project?'var(--accent)':'var(--muted)'}">${a.project?(S.who==='user'?'chat →':'inspect & chat →'):'no local source'}</td>
      ${canDelete?`<td style="text-align:right">${a.project?`<button class="ghost gdel" data-del="${esc(a.project)}" data-dname="${esc(a.name)}" style="padding:4px 10px;font-size:.75rem">Delete</button>`:''}</td>`:''}</tr>`).join('')}
  </tbody></table><p class="d" style="color:var(--muted);font-size:.75rem;margin-top:10px">${pluralize(agents.length,'agent')}</p>`
  box.querySelectorAll('[data-agent]').forEach(cell=>{
    const proj=cell.dataset.agent; if(!proj)return
    cell.onclick=()=>{ S.fleetAgent={project:proj,name:cell.closest('tr').dataset.name}; S.detail=null; S.fleetChat=[]; S.fleetSession=null; render() }
  })
  // T29: Fleet → Obs drill-down — sets obs scope to this agent and navigates.
  box.querySelectorAll('[data-obsagent]').forEach(btn=>{
    btn.onclick=(e)=>{
      e.stopPropagation()
      const proj=btn.dataset.obsagent
      S.obsScopes=null   // refetch: the roster merges live fleet agents (T24)
      // B14: the admin's link lands on Platform Monitoring at the owning
      // domain's aggregate (no per-agent monitoring scope); builders/leads
      // keep the agent-scoped content view.
      if(S.who==='admin'){
        const dm=btn.dataset.obsdomain||'platform'
        S.obsScope={type:'domain',id:dm,label:domainLabel(dm)}
        S.obsTab='metrics'
        S.view='monitoring'
      } else {
        S.obsScope={type:'agent',id:proj,label:proj}
        S.traceAgent=proj
        S.view='observability'
      }
      render()
    }
  })
  box.querySelectorAll('.gdel').forEach(btn=>{
    btn.onclick=sessionTaskHandler(async(e)=>{
      e.stopPropagation()
      const proj=btn.dataset.del
      if(!confirm(`Delete deployed agent "${btn.dataset.dname}"?\nThis tears down its CloudFormation stack (runtime + memory). Cannot be undone.`))return
      btn.disabled=true; btn.textContent='Deleting…'
      const r=await api('/fleet-delete',{project:proj})
      if(r.ok){runSessionTask(loadFleet)} else {btn.disabled=false;btn.textContent='Delete';alert('Delete failed: '+(r.output||'unknown'))}
    })
  })
}

function vAgentDetail(){
  const a=S.fleetAgent
  // End User: chat only — no setup/metadata, no eval pipeline (persona scoping).
  if(S.who==='user') return `<div class="bar" style="margin:0 0 10px"><button class="ghost" id="fleetback">← Agents</button></div>
  <h1>${a.project}</h1>
  <div class="card"><div class="sec-h" style="margin-top:0">Chat (streaming)</div>
    ${userPicker()}
    <div class="chat" id="fchat">${S.fleetChat.map(m=>`<div class="msg"><div class="role">${m.role}</div><div class="body">${chatBody(m)}</div></div>`).join('')||'<span style="color:var(--muted)">No messages yet.</span>'}</div>
    <label>Message</label>
    <textarea id="fmsg" placeholder="Ask ${a.project}..." style="min-height:56px"></textarea>
    <div class="bar"><button class="primary" id="fsend">Send</button></div>
  </div>`
  return `<div class="bar" style="margin:0 0 10px"><button class="ghost" id="fleetback">← Agent Fleet</button></div>
  <div id="agentcrumb"></div>
  <span class="roletag plat">${a.record&&a.record.status!=='READY'?'Agent draft':'Deployed agent'} · ${esc(a.name)}</span><h1>${esc(a.name)}</h1>
  <div class="split">
    <div class="card"><div class="sec-h" style="margin-top:0">Setup / metadata</div>
      <div id="detailbox"><div class="empty"><span class="spin">⟳</span> loading agent setup…</div></div>
    </div>
    <div class="card"><div class="sec-h" style="margin-top:0">Chat (streaming)</div>
      ${userPicker()}
      <div class="chat" id="fchat">${S.fleetChat.map(m=>`<div class="msg"><div class="role">${m.role}</div><div class="body">${chatBody(m)}</div></div>`).join('')||'<span style="color:var(--muted)">No messages yet.</span>'}</div>
      <label>Message</label>
      <textarea id="fmsg" placeholder="Ask ${a.project}... (Enter = new line; click Send to send)" style="min-height:56px"></textarea>
      <div class="bar"><button class="primary" id="fsend">Send</button></div>
    </div>
  </div>
  <div id="flifecycle"></div>
  ${promotionEvidenceCard(a.project)}
  ${goldenEvalCard(a.project)}`
}

// TLP-B19 (B-J1 step 8): the lifecycle stepper on the fleet agent detail —
// the same 5-stage pipeline the export tracker shows (renderLifecycle),
// resolved by probing the SSO orgs for this agent's exported repo. Advance is
// the real /api/lifecycle-advance call, so the stage is server-side state and
// survives a refresh. End users never reach this card (their detail view is
// chat-only) and the API 403s them regardless.
async function loadAgentLifecycle(){
  const host=document.getElementById('flifecycle'); if(!host||!S.fleetAgent)return
  const project=S.fleetAgent.project
  const orgs=sortedGhOrgs((S.catalog&&S.catalog.githubOrgs)||[])
  let repo=null, lc=null
  for(const o of orgs){
    const r=await api('/lifecycle?repo='+encodeURIComponent(o.id+'/'+project))
    if(r.ok&&r.lifecycle){ repo=o.id+'/'+project; lc=r.lifecycle; break }
  }
  const idx=lc?LIFECYCLE_ORDER.indexOf(lc.stage):-1
  const nextStage=lc?LIFECYCLE_ORDER[idx+1]:null
  host.innerHTML=`<div class="card" style="margin-top:14px" data-fleetlifecycle="${esc(project)}">
    <div class="sec-h" style="margin-top:0">Agent lifecycle</div>
    <div style="display:flex;gap:6px;flex-wrap:wrap;margin:6px 0">${LIFECYCLE_ORDER.map((s,i)=>`<span class="chip" data-lcstage="${s}"${i===idx?' data-lccurrent="1"':''} style="${i===idx?'color:var(--accent);border-color:var(--accent-bd);font-weight:600':i<idx?'color:var(--ok);border-color:var(--ok-bd)':'color:var(--muted)'}">${i<=idx?'✓ ':''}${LIFECYCLE_LABELS[s]}</span>`).join('')}</div>
    ${lc
      ? `<div class="d" style="font-size:.72rem;color:var(--muted)">Repo: <code>${esc(repo)}</code></div>
        ${nextStage?(showSim()?`<div class="bar" style="margin-top:8px"><button class="ghost" id="flcadvance" data-next="${nextStage}">Advance: ${LIFECYCLE_LABELS[nextStage]} →</button><span id="flcmsg" style="font-size:.75rem;color:var(--err)"></span></div>`:''):'<div class="d" style="font-size:.76rem;color:var(--muted);margin-top:6px">Lifecycle complete.</div>'}`
      : `<div class="d" style="font-size:.76rem;color:var(--muted)">No exported repo for this agent yet.</div>`}
  </div>`
  const btn=document.getElementById('flcadvance')
  if(btn)btn.onclick=sessionTaskHandler(async()=>{
    btn.disabled=true
    const r=await api('/lifecycle-advance',{repo,stage:btn.dataset.next})
    if(!r.ok){ btn.disabled=false; const m=document.getElementById('flcmsg'); if(m)m.textContent=r.error||'advance failed'; return }
    runSessionTask(loadAgentLifecycle)
  })
}

// ---------- Promotion evidence (WS-C) ----------
// The golden-set offline eval is the build-time promotion gate. This card
// presents the latest gate result as the agent's evidence for running in
// production; the full eval tooling + run history lives in the card below.
function promotionEvidenceCard(project){
  if(!project) return ''
  return `<div class="card" style="margin-top:14px" id="pecard">
    <div class="sec-h" style="margin-top:0">Promotion evidence · offline eval gate</div>
    <div id="pebox"><div class="empty"><span class="spin">⟳</span> loading gate evidence…</div></div>
  </div>`
}
function renderPromotionEvidence(runs){
  const box=document.getElementById('pebox'); if(!box)return
  const done=(runs||[]).filter(r=>r.status==='done'&&r.aggregate&&Object.keys(r.aggregate).length)
  if(!done.length){
    box.innerHTML='<div class="status info">No gate evidence yet — run the golden-dataset eval below.</div>'
    return
  }
  const passing=r=>{const v=Object.values(r.aggregate).filter(x=>typeof x==='number');return v.length>0&&v.every(x=>x>=EVAL_THRESH)}
  const latest=done[0]
  const passed=passing(latest)
  const when=latest.runId.replace('run-','').replace(/-/g,':').slice(0,16).replace('T',' ')
  const verdict=passed
    ? `<span class="tag" style="background:var(--ok-bg);color:var(--ok);border:1px solid var(--ok-bd)">✓ Gate passed</span>`
    : `<span class="tag" style="background:var(--err-bg);color:var(--err);border:1px solid var(--err-bd)">✗ Gate not met</span>`
  const passCount=done.filter(passing).length
  box.innerHTML=`<div style="display:flex;align-items:center;gap:10px;margin-bottom:6px">${verdict}<span style="color:var(--muted);font-size:.76rem">latest run ${esc(when)}${latest.snapshot&&latest.snapshot.model?' · model '+esc(latest.snapshot.model):''}</span></div>
    <table class="fill" style="width:100%;font-size:.8rem"><tr style="color:var(--dim)"><td>Metric</td><td style="text-align:right">Avg (0-1)</td></tr>${Object.entries(latest.aggregate).map(([k,v])=>`<tr><td>${esc(k.replace('Builtin.',''))}</td><td style="text-align:right">${evalPill(v)}</td></tr>`).join('')}</table>
    <div style="color:var(--muted);font-size:.72rem;margin-top:6px">Dataset <b>${esc(latest.dataset||'—')}</b> · ${latest.scored||0}/${latest.total||0} scenarios scored · pass ≥ ${EVAL_THRESH} · ${passCount}/${done.length} run${done.length>1?'s':''} passed</div>`
}

// ---------- Offline eval pipeline (golden dataset) ----------
// One reusable card: shows the project's golden dataset + evaluators, runs the
// pipeline (invoke each scenario, then LLM-as-judge with per-scenario ground
// truth), and lists past runs so you can compare before/after a model or
// prompt change.
function goldenEvalCard(project, baseline){
  if(!project) return ''
  return `<div class="card" style="margin-top:14px" id="gecard" data-project="${project}">
    <div class="sec-h" style="margin-top:0">Offline eval · golden dataset ${baseline?'<span class="chip" style="text-transform:none;letter-spacing:0">baseline · scores the configuration before anything is deployed, not a deployed instance</span>':''}</div>
    <div id="geinfo"><div class="empty"><span class="spin">⟳</span> loading dataset…</div></div>
    <div id="epbox" style="margin-top:12px"><div class="empty"><span class="spin">⟳</span> loading evaluation packs…</div></div>
    <div class="bar"><button class="primary" id="gerun">Review &amp; run eval…</button><button class="ghost" id="gerefresh">Refresh runs</button></div>
    <div id="geconfirm"></div>
    <div id="geruns"></div>
  </div>`
}
async function loadGoldenEval(){
  const card=document.getElementById('gecard'); if(!card)return
  const project=card.dataset.project
  const info=await api('/eval-dataset?project='+encodeURIComponent(project))
  const box=document.getElementById('geinfo'); if(!box)return
  card._info=info
  // Metrics pick-list — prebuilt platform metrics with descriptions + a ground-truth badge.
  const metricRow=m=>`<label class="metric" title="${esc(m.desc)}" style="display:flex;gap:8px;align-items:flex-start;padding:6px 8px;border:1px solid var(--border);border-radius:8px;margin:4px 0;cursor:pointer">
      <input type="checkbox" data-ev="${esc(m.id)}" ${m.id==='Builtin.Correctness'||m.custom?'checked':''} style="width:auto;margin-top:3px"/>
      <span><b style="font-size:.82rem">${esc(m.label)}</b>${m.custom?' <span class="chip type">custom</span>':''}${m.needsGroundTruth?' <span class="chip" style="color:var(--lock);border-color:var(--lock-bd)">needs expected answer</span>':''}<div style="color:var(--muted);font-size:.72rem">${esc(m.desc)}</div></span>
    </label>`
  const metricsHtml=`<label style="margin-top:10px">Metrics — pick what to score (hover for details)</label>
    <div id="gevs" style="max-height:200px;overflow:auto">${(info.metrics||[]).map(metricRow).join('')}</div>`

  const hasData=info.dataset && info.scenarios.length
  const datasetHtml = hasData
    ? `<div class="d" style="font-size:.8rem;margin-bottom:6px">✓ Golden dataset <b>${esc(info.dataset)}</b> · ${pluralize(info.scenarios.length,'scenario')}${info.masked?' <span class="chip" style="color:var(--lock);border-color:var(--lock-bd)" title="Scenario text can be sampled from real conversations — platform sessions see it PII-masked; raw text needs a domain-owner-approved grant.">PII-masked</span>':''} <a href="#" id="gedschange" style="font-size:.75rem;margin-left:8px">change</a></div>
       <div style="max-height:120px;overflow:auto;border:1px solid var(--border);border-radius:8px;padding:6px 10px;font-size:.76rem;color:var(--dim)">
         ${info.scenarios.map(s=>`<div>· <b>${esc(s.id)}</b> — ${esc(s.input.slice(0,80))}${s.input.length>80?'…':''} <span style="color:var(--muted)">(${s.assertions} checks)</span></div>`).join('')}
       </div>`
    : datasetUploader(info.presets)
  box.innerHTML = datasetHtml + (hasData?metricsHtml:'')
  const runBtn=document.getElementById('gerun'); if(runBtn)runBtn.disabled=!hasData
  runSessionTask(()=>loadEvalPlatform(project,info))
  runSessionTask(loadGoldenRuns) // runs (and promotion evidence) exist independently of the current dataset
  wireDatasetUploader(card)
}

// The upload UI — three ways to provide a golden dataset without touching AWS:
// (1) one-click starter, (2) paste JSONL/JSON/CSV, (3) point at an S3 file.
function datasetUploader(presets){
  const opts=(presets||[]).map(p=>`<option value="${esc(p.key)}">${esc(p.label)}</option>`).join('')
  return `<div class="status info" style="margin-bottom:10px">No golden dataset yet — add one below.</div>
    <label style="margin-top:0">Quick start — load a curated demo dataset</label>
    <div class="bar" style="margin-top:0">
      <select id="gepreset" style="max-width:280px">${opts}</select>
      <button class="ghost" id="gestarter">Load this dataset</button>
    </div>
    <label style="margin-top:12px">…or paste your own — JSONL, JSON array, or CSV (<code>input,expected</code>)</label>
    <textarea id="gepaste" placeholder='{"scenario_id":"greeting","turns":[{"input":"Hi, what can you do?"}],"assertions":["Summarizes its capabilities"]}
{"scenario_id":"unknown","turns":[{"input":"What is my balance?"}],"assertions":["Does not invent a number"]}' style="min-height:90px;font-family:ui-monospace,monospace;font-size:.76rem"></textarea>
    <div class="bar" style="margin-top:8px"><button class="primary" id="gesavepaste">Save pasted dataset</button></div>
    <label style="margin-top:12px">…or point at a file in S3 (the console reads it with your AWS creds)</label>
    <div class="bar" style="margin-top:0"><input id="ges3" placeholder="s3://my-bucket/eval/golden.jsonl"/><button class="ghost" id="gesaves3">Load from S3</button></div>
    <div id="gesavestatus"></div>`
}
function wireDatasetUploader(card){
  const b=id=>document.getElementById(id)
  const project=card.dataset.project
  const reload=()=>runSessionTask(loadGoldenEval)
  const save=async(body,btn)=>{
    const st=b('gesavestatus'); if(st)st.innerHTML='<div class="status info"><span class="spin">⟳</span> saving…</div>'
    if(btn)btn.disabled=true
    const r=await api('/eval-dataset-save',{project,...body})
    if(r.ok){businessForms.clear('dataset');reload()} else { if(st)st.innerHTML=`<div class="status err">${esc(r.error||'save failed')}</div>`; if(btn)btn.disabled=false }
  }
  if(b('gestarter'))b('gestarter').onclick=()=>runSessionTask(()=>save({preset:(b('gepreset')||{}).value||'generic'},b('gestarter')))
  if(b('gesavepaste'))b('gesavepaste').onclick=()=>{const t=b('gepaste').value.trim(); if(!t){b('gesavestatus').innerHTML='<div class="status err">Paste some scenarios first.</div>';return} runSessionTask(()=>save({text:t},b('gesavepaste')))}
  if(b('gesaves3'))b('gesaves3').onclick=()=>{const u=b('ges3').value.trim(); if(!u){b('gesavestatus').innerHTML='<div class="status err">Enter an s3:// URI.</div>';return} runSessionTask(()=>save({s3Uri:u},b('gesaves3')))}
  if(b('gedschange'))b('gedschange').onclick=e=>{e.preventDefault();const box=document.getElementById('geinfo');box.innerHTML=datasetUploader((card._info||{}).presets);document.getElementById('gerun').disabled=true;wireDatasetUploader(card)}
}
function renderPackTile(pack, datasetId, latest){
  const disabled=!datasetId
  const state=latest&&latest.pack===pack.id?`<div style="color:var(--muted);font-size:.7rem;margin-top:4px">latest: <b>${esc(latest.status)}</b>${latest.gate?` · gate ${esc(latest.gate.decision)}`:''}</div>`:''
  const backend=pack.backend==='local'
    ? '<span class="chip" style="color:var(--ok);border-color:var(--ok-bd)">local deterministic</span>'
    : '<span class="chip">AgentCore backend required</span>'
  return `<div class="item" style="padding:10px 12px">
    <div style="display:flex;justify-content:space-between;gap:8px;align-items:flex-start"><b style="font-size:.85rem">${esc(pack.label)}</b>${backend}</div>
    <div class="d" style="font-size:.72rem;color:var(--dim);margin:4px 0 8px">${esc(pack.description)}</div>
    <button class="ghost eprun" data-pack="${esc(pack.id)}" ${disabled?'disabled':''} style="padding:5px 10px;font-size:.74rem">Run ${esc(pack.label)}</button>${state}
  </div>`
}
function renderPlatformEvalRun(run){
  if(!run)return ''
  const gate=run.gate?.decision||'—'
  const color=gate==='PASS'?'var(--ok)':gate==='FAIL'?'var(--err)':'var(--lock)'
  const scored=(run.results||[]).filter(r=>r.status!=='not_run').length
  const total=(run.results||[]).length
  const agg=Object.entries(run.aggregate||{})
    .map(([k,v])=>`<tr><td>${esc(k.replace('deterministic.',''))}</td><td style="text-align:right">${evalPill(v)}</td></tr>`).join('')
  return `<div class="card" style="background:var(--surface2);margin-top:10px;border-left:3px solid ${color}">
    <div style="display:flex;align-items:center;justify-content:space-between;gap:10px"><b style="font-size:.84rem">${esc(run.pack)} pack · ${esc(run.status)}</b><span class="chip" style="color:${color};border-color:${color}">gate ${esc(gate)}</span></div>
    <div class="d" style="color:var(--muted);font-size:.72rem;margin-top:4px">${scored}/${total} cases scored · ${esc(run.backend?.detail||'')}</div>
    ${agg?`<table style="margin-top:8px"><thead><tr><th>Evaluator</th><th style="text-align:right">Score</th></tr></thead><tbody>${agg}</tbody></table>`:''}
  </div>`
}
async function loadEvalPlatform(project, goldenInfo){
  const box=document.getElementById('epbox'); if(!box)return
  const [packsR,dsR,runsR]=await Promise.all([
    api('/eval/packs'),
    api('/eval/datasets?project='+encodeURIComponent(project)),
    api('/eval/runs?project='+encodeURIComponent(project)),
  ])
  const packs=packsR.packs||[]
  const datasets=dsR.datasets||[]
  const ds=datasets[0]
  const latest=(runsR.runs||[])[0]
  const register=`<button class="ghost" id="epregister" style="padding:5px 10px;font-size:.74rem">Register current golden dataset</button>`
  box.innerHTML=`<div class="card" style="background:var(--surface2);border-left:3px solid var(--dom)">
    <div class="sec-h" style="margin:0 0 6px;color:var(--dom)">Evaluation packs <span class="chip" style="text-transform:none;letter-spacing:0">/api/eval/*</span></div>
    ${ds?`<div class="status ok">Dataset record <b>${esc(ds.name)}</b> · ${pluralize(ds.caseCount,'case')} · ${esc(ds.status)}${ds.validation?.warnings?.length?` <span class="chip" style="color:var(--lock);border-color:var(--lock-bd)">${ds.validation.warnings.length} warning${ds.validation.warnings.length>1?'s':''}</span>`:''}</div>`
      :`<div class="status info">No platform eval dataset record yet for this agent. ${goldenInfo?.dataset?register:'Add a golden dataset first, then register it here.'}</div>`}
    <div class="grid2" style="margin-top:10px">${packs.map(p=>renderPackTile(p,ds?.id,latest)).join('')}</div>
    <div id="epstatus">${renderPlatformEvalRun(latest)}</div>
  </div>`
  const reg=document.getElementById('epregister')
  if(reg)reg.onclick=sessionTaskHandler(async()=>{
    const st=document.getElementById('epstatus')
    st.innerHTML='<div class="status info"><span class="spin">⟳</span> registering dataset record…</div>'
    const r=await api('/eval/datasets',{source:'golden',project})
    if(r.ok)runSessionTask(()=>loadEvalPlatform(project,goldenInfo))
    else st.innerHTML=`<div class="status err">${esc(r.error||'registration failed')}</div>`
  })
  document.querySelectorAll('.eprun').forEach(btn=>btn.onclick=sessionTaskHandler(async()=>{
    const st=document.getElementById('epstatus')
    st.innerHTML='<div class="status info"><span class="spin">⟳</span> starting '+esc(btn.dataset.pack)+' pack…</div>'
    const r=await api('/eval/run',{datasetId:ds.id,agentRuntimeId:project,pack:btn.dataset.pack})
    if(r.ok){st.innerHTML=renderPlatformEvalRun(r.run); runSessionTask(()=>loadEvalPlatform(project,goldenInfo))}
    else st.innerHTML=`<div class="status err">${esc(r.error||'run failed')}</div>`
  }))
}
const EVAL_THRESH=0.6 // pass bar (0-1 scale) — same for all builtin metrics in the demo
function evalPill(v){ if(typeof v!=='number')return `<span style="color:var(--muted)">—</span>`
  const c=v>=0.8?'var(--ok)':v>=EVAL_THRESH?'var(--lock)':'var(--err)'; const mark=v>=EVAL_THRESH?'✓':'✗'
  return `<span style="color:${c};font-weight:600">${v.toFixed(2)} ${mark}</span>` }
async function loadGoldenRuns(){
  const card=document.getElementById('gecard'); if(!card)return
  const project=card.dataset.project
  const r=await api('/eval-runs?project='+encodeURIComponent(project))
  renderPromotionEvidence(r.runs)
  const box=document.getElementById('geruns'); if(!box)return
  if(!(r.runs||[]).length){box.innerHTML='<div class="d" style="color:var(--muted);font-size:.76rem;margin-top:6px">No runs yet.</div>';return}
  const THRESH=EVAL_THRESH
  const pill=evalPill
  box.innerHTML=`<label style="margin-top:12px">Evaluation runs</label>`+r.runs.map(run=>{
    const when=run.runId.replace('run-','').replace(/-/g,':').slice(0,16).replace('T',' ')
    const prog=run.status==='done'?'':` · <b style="color:var(--lock)">${esc(run.status)}</b> (${run.invoked||0}/${run.total} invoked, ${run.scored||0}/${run.total} scored)`
    const snap=run.snapshot&&run.snapshot.model?`<span style="color:var(--muted);font-size:.74rem">model: ${esc(run.snapshot.model)}</span>`:''
    // Judge availability is a
    // credentials question, not an environment one. A local-dev run with AWS
    // credentials scores with the same Bedrock judge the CI gate uses; without
    // credentials it degrades to deterministic checks — the card states which
    // mode actually ran, so a local green is never mistaken for more than it is.
    const modeChip=run.mode==='local-dev'?(run.judge==='bedrock'
      ?`<div class="chip type" style="margin-top:4px">local dev run · deterministic checks + Bedrock LLM judge — same scoring capability as the CI gate</div>`
      :`<div class="chip" style="margin-top:4px">local dev run · deterministic checks only — LLM judge skipped (no AWS credentials)</div>`):''
    // aggregate scorecard: metric → avg with pass/fail pill
    const agg=run.aggregate&&Object.keys(run.aggregate).length
      ? `<table class="fill" style="width:100%;font-size:.8rem;margin-top:6px"><tr style="color:var(--dim)"><td>Metric</td><td style="text-align:right">Avg (0-1)</td></tr>${Object.entries(run.aggregate).map(([k,v])=>`<tr><td>${esc(k.replace('Builtin.',''))}</td><td style="text-align:right">${pill(v)}</td></tr>`).join('')}</table>
         <div style="color:var(--muted);font-size:.72rem;margin-top:4px">✓ ≥ ${THRESH} pass · scored on the golden dataset's ground truth</div>`:''
    const detail=run.status==='done'?(run.scenarios||[]).map(sc=>{
      const scores=(sc.scores||[]).map(s=>`${esc((s.evaluator||'').replace('Builtin.',''))} ${pill(typeof s.value==='number'?s.value:undefined)}${s.label?' <span style="color:var(--muted)">('+esc(s.label)+')</span>':''}`).join(' · ')
      const why=(sc.scores||[]).find(s=>s.explanation)?.explanation||''
      return `<div style="margin:6px 0;padding:6px 8px;border-left:2px solid var(--border)"><b>${esc(sc.id)}</b> — ${scores||'no scores'}<div style="color:var(--muted);font-size:.72rem;margin-top:2px">Q: ${esc((sc.input||'').slice(0,90))}</div>${why?`<div style="color:var(--muted);font-size:.7rem;margin-top:2px">judge: ${esc(why.slice(0,160))}</div>`:''}</div>`
    }).join(''):''
    return `<div class="card" style="background:var(--surface2);margin-top:8px">
      <div style="font-size:.8rem;display:flex;justify-content:space-between"><b>${esc(when)}</b>${snap}</div>${modeChip}${prog}
      ${agg}
      ${detail?`<details style="margin-top:6px;font-size:.78rem"><summary style="cursor:pointer;color:var(--dim)">per-scenario detail (${(run.scenarios||[]).length})</summary>${detail}</details>`:''}
    </div>`
  }).join('')
}
async function wireGoldenEval(){
  const card=document.getElementById('gecard'); if(!card)return
  runSessionTask(loadGoldenEval)
  const runBtn=document.getElementById('gerun')
  // Step 1: clicking Run opens a review/confirm summary — it does NOT start yet.
  if(runBtn)runBtn.onclick=()=>{
    const info=card._info||{}
    const evs=[...document.querySelectorAll('#gevs [data-ev]:checked')].map(e=>e.dataset.ev)
    if(!evs.length){document.getElementById('geconfirm').innerHTML='<div class="status err">Pick at least one metric first.</div>';return}
    const metricLabels=evs.map(id=>((info.metrics||[]).find(m=>m.id===id)||{}).label||id)
    const cf=document.getElementById('geconfirm')
    cf.innerHTML=`<div class="card" style="background:var(--surface2);margin-top:10px">
      <b style="font-size:.85rem">Review this evaluation before running</b>
      <table class="fill" style="width:100%;font-size:.8rem;margin-top:6px">
        <tr><td style="color:var(--dim);width:130px">Agent</td><td>${esc(card.dataset.project)}</td></tr>
        <tr><td style="color:var(--dim)">Dataset</td><td>${esc(info.dataset||'—')} · ${pluralize((info.scenarios||[]).length,'scenario')}</td></tr>
        <tr><td style="color:var(--dim)">Metrics</td><td>${metricLabels.map(esc).join(', ')}</td></tr>
        <tr><td style="color:var(--dim)">Signed in as</td><td>${esc(SESSION?SESSION.user:'—')} (the agent is invoked as this user)</td></tr>
        <tr><td style="color:var(--dim)">How it runs</td><td>Invoke each scenario → ~3 min trace ingestion → score vs ground truth. LLM-as-judge calls cost tokens.</td></tr>
      </table>
      <div class="bar"><button class="primary" id="geconfirmrun">Start evaluation</button><button class="ghost" id="geconfirmcancel">Cancel</button></div>
    </div>`
    document.getElementById('geconfirmcancel').onclick=()=>{cf.innerHTML=''}
    // Step 2: confirmed → actually start the job + poll with explicit states.
    document.getElementById('geconfirmrun').onclick=sessionTaskHandler(async()=>{
      cf.innerHTML='<div class="status info"><span class="spin">⟳</span> starting…</div>'
      runBtn.disabled=true
      const r=await api('/eval-dataset',{project:card.dataset.project,evaluators:evs})
      if(!r.ok){cf.innerHTML=`<div class="status err">${esc(r.error||'failed to start')}</div>`;runBtn.disabled=false;return}
      const stateLabel={invoking:'Invoking agent on each scenario',"waiting-ingestion":'Waiting ~3 min for trace ingestion',scoring:'Scoring against ground truth',done:'Done',error:'Error'}
      const poll=sessionInterval(async()=>{
        const rr=await api('/eval-runs?project='+encodeURIComponent(card.dataset.project))
        const live=(rr.runs||[]).find(x=>x.runId===r.runId)
        await loadGoldenRuns()
        if(live) cf.innerHTML=`<div class="status info"><span class="spin">⟳</span> <b>${esc(stateLabel[live.status]||live.status)}</b> — ${live.invoked||0}/${live.total} invoked, ${live.scored||0}/${live.total} scored</div>`
        if(!live||live.status==='done'||live.status==='error'){clearSessionInterval(poll);runBtn.disabled=false;cf.innerHTML=live&&live.status==='done'?'<div class="status ok">✓ Evaluation complete — results below.</div>':''}
      },5000)
    })
  }
  const refBtn=document.getElementById('gerefresh')
  if(refBtn)refBtn.onclick=()=>runSessionTask(loadGoldenRuns)
}
// External integration panel (Loom-informed): how enterprise systems call this
// deployed agent — real invocation URL + auth requirements + copy-ready snippet,
// all assembled from real deploy state server-side.
function integrationPanel(i){
  if(!i)return ''
  return `<div id="integration" style="margin-top:14px;padding-top:10px;border-top:1px solid var(--border)">
    <div class="sec-h" style="margin:0 0 8px">External integration — call this agent from your systems</div>
    <div class="d" style="font-size:.76rem;color:var(--dim);margin-bottom:6px">${esc(i.auth)}</div>
    <div class="meta" style="margin-bottom:8px"><span class="chip" style="max-width:100%;overflow:hidden;text-overflow:ellipsis" title="${esc(i.invocationUrl)}">${esc(i.invocationUrl)}</span></div>
    <pre id="intsnippet" style="max-height:220px">${esc(i.snippet)}</pre>
    <div class="bar" style="margin-top:8px"><button class="ghost" id="intcopy" style="padding:5px 12px;font-size:.76rem">Copy snippet</button><span id="intcopied" style="font-size:.74rem;color:var(--ok)"></span></div>
  </div>`
}
function wireIntegration(){
  const btn=document.getElementById('intcopy'); if(!btn)return
  btn.onclick=async()=>{
    const txt=document.getElementById('intsnippet')?.textContent||''
    try{await navigator.clipboard.writeText(txt)}catch{
      const ta=document.createElement('textarea');ta.value=txt;document.body.appendChild(ta);ta.select();document.execCommand('copy');ta.remove()
    }
    const ok=document.getElementById('intcopied'); if(ok){ok.textContent='✓ copied';sessionTimeout(()=>ok.textContent='',2000)}
  }
}
async function loadDetail(){
  const a=S.fleetAgent; const box=document.getElementById('detailbox'); if(!box)return
  const d=authMode()==='cognito'?hostedAgentDetail(a.record):await api('/agent-detail',{project:a.project}); S.detail=d
  if(!d){box.innerHTML='<div class="empty">Agent setup is unavailable. Reopen the agent from Fleet.</div>';return}
  if(d.error){box.innerHTML=`<div class="status err">${d.error}</div>`;return}
  // G14: Domain › Project › Agent breadcrumb from the server-resolved chain.
  const cr=document.getElementById('agentcrumb')
  if(cr&&d.domain){
    cr.innerHTML=crumbTrail([{label:domainLabel(d.domain),go:'domains',domain:d.domain},
      d.owningProject?{label:d.owningProject,go:'projects',project:d.owningProject}:null,{label:a.project}])
    wireCrumbs()
  }
  const row=(k,v)=>`<div class="lock" style="border-top-color:var(--border)"><b style="color:var(--dim);min-width:110px">${k}</b><span>${v}</span></div>`
  const idDetail = d.identity && /CUSTOM_JWT|Cognito/i.test(d.identity)
    ? `${esc(d.identity)}<div style="color:var(--muted);font-size:.72rem;margin-top:2px">Cognito profile (sub · name · email) forwarded as allowlisted headers → <code>_profile_from_context()</code>; sub scopes memory.</div>`
    : esc(d.identity||'none')
  box.innerHTML =
    row('Runtime', `${esc(d.runtime)} · ${esc(d.protocol)}`)+
    row(LOCK_IC+'Identity', idDetail)+
    row(LOCK_IC+'Memory', d.memory?`${esc(d.memory.name)} (${d.memory.strategies.join(', ')})`
      :d.memoryMode?`${esc(d.memoryMode)} <span class="chip">no store provisioned yet</span>`:'none')+
    row(LOCK_IC+'Observability', esc(d.observability))+
    row('Model', esc(d.model||'(default)'))+
    (d.modelParams&&Object.keys(d.modelParams).length?row('Model params',Object.entries(d.modelParams).map(([k,v])=>`${esc(k)}: ${esc(v)}`).join(' · ')):'')+
    row('Persona', esc((d.persona||'').slice(0,90)))+
    row('Skills', (d.skills||[]).map(s=>esc(s.name||s.id)).join(', ')||'—')+
    row('Tools', (d.tools||[]).map(t=>`${esc(t.id)} (${esc(t.type)})`).join(', ')||'—')+
    ((d.builtinTools||[]).length?row('Built-in tools',(d.builtinTools||[]).map(esc).join(', ')+' <span class="chip">simulated</span>'):'')+
    (d.deployedArn?`<p class="d" style="color:var(--muted);font-size:.7rem;margin-top:8px">${esc(d.deployedArn)}</p>`:'')+
    integrationPanel(d.integration)
  wireIntegration()
}

// Platform Observability — AGGREGATE, NON-SENSITIVE metrics only. Scope drills
// fleet → domain → agent. Content-level traces (input/output) are NOT here; they
// live on the domain side behind elevated access (see the Domain Builder view).
// B14: Platform Monitoring — the admin governance-nav entry. Aggregate,
// non-sensitive signals only (fleet + per-domain scope), Metrics + Alerts
// tabs. No trace element renders here, ever; there is no agent-level scope
// option. The content view is a separate route (vObservability, bwobs).
async function vMonitoring(){
  if(authMode()==='cognito')return vHostedOperations()
  if(!S.obsScopes) S.obsScopes = await api('/obs-scopes')
  const sc=S.obsScopes
  if(!['fleet','domain'].includes(S.obsScope.type)) S.obsScope={type:'fleet',id:'all',label:'Entire platform'}
  if(!['metrics','alerts'].includes(S.obsTab)) S.obsTab='metrics'
  const mcur=`${S.obsScope.type}:${S.obsScope.id}`
  const mopt=(v,l,sel)=>`<option value="${v}" ${sel?'selected':''}>${esc(l)}</option>`
  const mScopeOptions=[mopt('fleet:all','Entire platform',mcur==='fleet:all')]
    .concat(sc.domains.map(d=>mopt('domain:'+d.id,d.label,mcur==='domain:'+d.id))).join('')
  const mtab=S.obsTab
  const mtabBtn=(id,label)=>`<button class="ghost obstab ${mtab===id?'primary':''}" data-tab="${id}" style="padding:7px 16px">${label}</button>`
  return `<span class="roletag plat">Platform team · control plane</span>
  <h1>Platform Monitoring</h1>
  <p class="subtitle">Aggregate, non-sensitive signals per domain — performance, cost, reliability, alerts.</p>
  <div class="chip type" id="obsscopechip" style="margin-bottom:10px">${S.obsScope.type==='domain'?'Domain aggregate: '+esc(S.obsScope.label):'Platform-wide aggregates'}</div>
  ${storyLine('','cost','Follow the spend in Cost')}
  <div class="bar" style="margin:0 0 14px">${mtabBtn('metrics','Metrics')}${mtabBtn('alerts',ic2(ICONS.bell)+'Alerts')}</div>
  ${mtab==='alerts'?`
  <div id="alertsbox"><div class="empty"><span class="spin">⟳</span> loading alerts…</div></div>
  ${govAlertsTab()}`
  :`<div class="card" style="display:flex;align-items:center;gap:14px;flex-wrap:wrap;padding:14px 20px">
    <label style="margin:0;font-size:.72rem">Scope</label>
    <select id="obsscope" style="max-width:280px">${mScopeOptions}</select>
  </div>
  <div id="obsbox"><div class="empty"><span class="spin">⟳</span> loading metrics…</div></div>
  <div id="oebox"></div>
  <div class="card" style="border-left:3px solid var(--lock);background:var(--lock-bg)">
    <div class="sec-h" style="margin:0 0 6px;color:var(--lock)">${LOCK_IC}Content-level traces are not shown here</div>
    <div class="d" style="font-size:.82rem;color:var(--dim)">Traces stay in the owning domain account — access is grant-gated, time-boxed and audited.</div>
  </div>
  <div id="agbox"></div>
  <p class="d" style="color:var(--muted);font-size:.72rem;margin-top:4px">Backends: CloudWatch (<code>bedrock-agentcore</code>) · Langfuse</p>`}`
}
async function loadWorkspaceObservability(project){
  const body=document.getElementById('wsbody');if(!body)return
  const epoch=sessionEpoch
  const request=(body.obsRequest||0)+1;body.obsRequest=request
  const current=()=>sessionEpochIsCurrent(epoch)&&document.getElementById('wsbody')===body&&body.obsRequest===request
  const scope={domainId:project.domain,projectId:project.id}
  S.obsScope={type:'project',id:scope.projectId,domainId:scope.domainId}
  body.innerHTML='<div class="empty"><span class="spin">⟳</span> loading project agents…</div>'
  try{
    // Mock (local) backend: no hosted telemetry roster, but /api/obs-traces
    // serves this project's content-level session traces (real chat-stream
    // sessions + end-user HITL feedback). Render those instead of throwing.
    if(authMode()!=='cognito'){
      S.traceAgent=scope.projectId
      if(!S.revealed)S.revealed=new Set()
      body.innerHTML=`<p class="chip" id="obsscopechip">Project: ${esc(scope.domainId)} / ${esc(scope.projectId)}</p>
        <div id="tracebox"><div class="empty"><span class="spin">⟳</span> loading traces…</div></div>`
      await loadTraces()
      return
    }
    // Do not adapt domain-scoped obs rosters: that adapter loses project identity.
    const agents=projectAgents(await readHostedCollection('agents'),scope)
    if(!current())return
    if(!agents.some(agent=>agent.id===S.traceAgent))S.traceAgent=''
    if(!['metrics','traces','agent'].includes(S.obsTab))S.obsTab='metrics'
    const tab=S.obsTab
    const agent=agents.find(agent=>agent.id===S.traceAgent)
    body.innerHTML=`<p class="chip" id="obsscopechip">Project: ${esc(scope.domainId)} / ${esc(scope.projectId)}</p>
      <div class="bar">${[['metrics','Metrics'],['traces','Traces'],['agent','Agent details']].map(([id,label])=>`<button class="ghost ${tab===id?'primary':''}" data-workspace-obs-tab="${id}" aria-pressed="${tab===id}">${label}</button>`).join('')}</div>
      <div class="bar"><label>Agent <select id="workspaceobsagent"><option value="" ${!agent?'selected':''}>All project agents</option>${agents.map(a=>`<option value="${esc(a.id)}" ${a.id===S.traceAgent?'selected':''}>${esc(a.name||a.id)}</option>`).join('')}</select></label>
      ${hostedWindowControl('workspaceobswindow',S.workspaceObsWindow||'24h')}</div>
      <div id="workspaceobsdetail"></div>`
    body.querySelectorAll('[data-workspace-obs-tab]').forEach(button=>button.onclick=()=>{
      S.obsTab=button.dataset.workspaceObsTab
      runSessionTask(()=>loadWorkspaceObservability(project))
    })
    const picker=document.getElementById('workspaceobsagent')
    picker.onchange=()=>{
      if(picker.value&&!agents.some(a=>a.id===picker.value))return
      S.traceAgent=picker.value;S.revealed=new Set()
      runSessionTask(()=>loadWorkspaceObservability(project))
    }
    document.getElementById('workspaceobswindow').onchange=event=>{
      S.workspaceObsWindow=event.target.value
      runSessionTask(()=>loadWorkspaceObservability(project))
    }
    const detail=document.getElementById('workspaceobsdetail')
    if(tab==='traces'){
      detail.innerHTML='<div class="card"><h2>Project native traces are unavailable</h2><p>This backend does not expose an authorized project-and-agent trace query. Session, run and trace detail cannot be loaded for this project.</p></div>'
    }else if(tab==='agent'){
      detail.innerHTML=agent?`<section class="card"><h2>${esc(agent.name||agent.id)}</h2><p>Agent ID: ${esc(agent.id)} · Status: ${esc(agent.status)}</p><p>Domain: ${esc(agent.domainId)} · Project: ${esc(agent.projectId)}</p><p>Per-agent metrics and native execution details are unavailable.</p></section>`:'<div class="empty">Select a project agent to see its details.</div>'
    }else if(agent){
      detail.innerHTML='<div class="empty">Per-agent metrics are unavailable from the aggregate telemetry service.</div>'
    }else{
      detail.innerHTML='<div class="empty"><span class="spin">⟳</span> loading project metrics…</div>'
      const result=await loadOperationsPages(api,S.workspaceObsWindow||'24h')
      if(!current())return
      // operationsHtml filters by projectId but the operations API returns a
      // platform-scope aggregate (scope.type==='platform') for this role —
      // project-level rows are not in the response. Show an honest, informative
      // panel that names the project and lists its agents instead of a bare empty.
      const opsHtml=operationsHtml(result,scope)
      const isUnavailable=opsHtml.includes('data-operations-scope')===false
      detail.innerHTML=isUnavailable
        ? obsProjectUnavailableHtml(scope.domainId,scope.projectId,project.name||scope.projectId,agents,S.workspaceObsWindow||'24h')
        : opsHtml
    }
  }catch(error){
    if(error===CANCELED_REQUEST||!current())return
    S.traceAgent='';S.revealed=new Set()
    body.innerHTML='<div class="empty">Project observability is unavailable for this scope and window. Reopen Observability to retry.</div>'
  }
}
// Workspace Observability always enters through the selected domain/project wrapper.
async function vObservability(){
  S.wsTab='obs'
  return vWorkspace()
}
// T13B Alerts tab (§8.5): catalog (read from the Governance-owned policy
// store), the firing/history feed, and a demo incident trigger. The trigger
// stands in for a CloudWatch alarm evaluating a threshold; the state it
// produces — firing record, Operate card flip, SEV1 auto-suspend, audit —
// is real server state.
async function loadAlertsTab(){
  const box=document.getElementById('alertsbox'); if(!box)return
  const [r,fleet]=await Promise.all([api('/alerts'),api('/fleet')])
  const pols=(r.policies||[]).filter(p=>p.enabled)
  const firings=r.firings||[]
  const active=firings.filter(f=>f.status==='firing')
  const isAdmin=hasCap('manageIncidents')
  const agents=(fleet.agents||[]).filter(a=>a.project).map(a=>a.project)
  const fRow=f=>`<tr data-firing="${esc(f.id)}">
    <td style="font-size:.75rem;color:var(--muted)">${esc((f.firedAt||'').slice(0,19).replace('T',' '))}</td>
    <td><b>${esc(f.policyName)}</b>${f.autoSuspended?' <span class="chip" style="color:var(--err);border-color:var(--err-bd)">auto-suspended</span>':''}</td>
    <td>${sevBadge(f.severity)}</td>
    <td>${f.agent?`<code style="font-size:.72rem">${esc(f.agent)}</code>`:'<span style="color:var(--muted)">platform</span>'}</td>
    <td style="font-size:.76rem">${esc(f.owner)}</td>
    <td>${f.status==='firing'?`<span class="badge badge-red">● firing</span>`:`<span class="chip" style="color:var(--ok);border-color:var(--ok-bd)">resolved by ${esc(f.resolvedBy)}</span>`}</td>
    <td style="text-align:right">${f.status==='firing'&&isAdmin?`<button class="ghost aresolve" data-id="${esc(f.id)}" style="padding:3px 10px;font-size:.72rem">Resolve</button>`:''}</td></tr>`
  box.innerHTML=`
  ${active.length?`<div class="card" style="border-left:3px solid var(--err)">
    <div class="sec-h" style="margin-top:0;color:var(--err)">${BELL_IC}Active incidents (${active.length})</div>
    <table><thead><tr><th>Fired</th><th>Alert</th><th>Severity</th><th>Agent</th><th>Owner (RACI)</th><th>Status</th><th></th></tr></thead>
    <tbody>${active.map(fRow).join('')}</tbody></table>
    <p class="d" style="color:var(--muted);font-size:.72rem;margin-top:8px">A SEV1 with an agent attached auto-suspends it pending Platform Admin review — check the agent's card under Agent Fleet.</p></div>`
  :`<div class="card" style="border-left:3px solid var(--ok)"><div class="sec-h" style="margin-top:0;color:var(--ok)">✓ No active incidents</div></div>`}
  <div class="card"><div class="sec-h" style="margin-top:0">Alert catalog <span class="chip" style="color:var(--plat);border-color:var(--plat-bd)">defined in Governance</span></div>
    <table><thead><tr><th>Alert</th><th>Metric</th><th>Threshold</th><th>Severity</th><th>Owner</th></tr></thead><tbody>
    ${pols.map(p=>`<tr data-alertcat="${esc(p.id)}"><td><b>${esc(p.name)}</b></td><td style="font-size:.78rem">${esc(p.metric)}</td><td style="font-size:.78rem"><code>${esc(p.threshold)}</code></td><td>${sevBadge(p.severity)}</td><td style="font-size:.76rem">${esc(p.owner)}</td></tr>`).join('')}
    </tbody></table></div>
  ${isAdmin?`<div class="card"><div class="sec-h" style="margin-top:0">Demo an incident <span class="chip">test trigger</span></div>
    <div class="grid2">
      <div><label style="margin-top:0">Alert</label><select id="afpolicy">${pols.map(p=>`<option value="${esc(p.id)}">${esc(p.name)} (${esc(p.severity)})</option>`).join('')}</select></div>
      <div><label style="margin-top:0">Affected agent</label><select id="afagent">${agents.map(a=>`<option>${esc(a)}</option>`).join('')}<option value="">(platform-level, no agent)</option></select></div>
    </div>
    <div class="bar"><button class="primary" id="affire">Fire the alert</button></div>
    <div id="afstatus"></div></div>`:''}
  ${firings.some(f=>f.status!=='firing')?`<div class="card"><div class="sec-h" style="margin-top:0">Incident history</div>
    <table><thead><tr><th>Fired</th><th>Alert</th><th>Severity</th><th>Agent</th><th>Owner (RACI)</th><th>Status</th><th></th></tr></thead>
    <tbody>${firings.filter(f=>f.status!=='firing').map(fRow).join('')}</tbody></table></div>`:''}`
  box.querySelectorAll('.aresolve').forEach(btn=>btn.onclick=sessionTaskHandler(async()=>{
    btn.disabled=true
    const rr=await api('/alert-resolve',{id:btn.dataset.id})
    if(rr.ok)runSessionTask(loadAlertsTab); else {btn.disabled=false;alert(rr.error||'resolve failed')}
  }))
  const fire=document.getElementById('affire')
  if(fire)fire.onclick=sessionTaskHandler(async()=>{
    const st=document.getElementById('afstatus')
    st.innerHTML='<div class="status info"><span class="spin">⟳</span> firing…</div>'
    const rr=await api('/alert-fire',{policyId:document.getElementById('afpolicy').value,agent:document.getElementById('afagent').value})
    if(rr.ok){st.innerHTML=`<div class="status ok">${BELL_IC}<b>${esc(rr.firing.policyName)}</b> is firing${rr.firing.agent?` on <code>${esc(rr.firing.agent)}</code>${rr.firing.autoSuspended?' — agent <b>auto-suspended</b> pending review (SEV1)':' — agent shows degraded'}`:''}. See Agent Fleet and the Governance audit trail.</div>`;runSessionTask(loadAlertsTab)}
    else st.innerHTML=`<div class="status err">${esc(rr.error||'fire failed')}</div>`
  })
}
// Stat card with a sparkline; delta vs. window start shown as ▲/▼.
function statCard(series, color, fmt){
  const p=series.points||[], first=p[0]||0, last=series.last||0
  const delta=first?((last-first)/first*100):0
  const flat=Math.abs(delta)<0.5
  const arrow=flat?'▪':(delta>=0?'▲':'▼')
  const dcol=flat?'var(--muted)':(series.kind==='latency'||series.kind==='rate')?(delta<0?'var(--ok)':'var(--err)'):(delta>=0?'var(--ok)':'var(--err)')
  return `<div class="item" style="padding:12px 14px">
    <div class="d" style="font-size:.72rem;color:var(--muted)">${esc(series.label)}</div>
    <div style="display:flex;align-items:baseline;gap:8px;margin:2px 0 6px"><h4 style="font-size:1.35rem;margin:0">${fmt(series.last)}</h4>
      <span style="font-size:.72rem;color:${dcol}">${arrow} ${Math.abs(delta).toFixed(0)}%</span></div>
    ${svgSpark(p,color)}
  </div>`
}
// T09 — Online evaluation (production sampled scoring). WS-C repositioning:
// build-time golden-set eval lives on the agent detail page as promotion
// evidence; THIS is the runtime quality trend. Sample denominators come from
// the real usage ledger (same source the Cost page derives from), so
// samples ≤ invocations and the numbers reconcile across pages (D7/H2).
// Platform view: aggregate quality score only. Builder view: per-day trend detail.
async function loadOnlineEval(){
  const box=document.getElementById('oebox'); if(!box)return
  const r=await api('/obs/online-eval?scope='+S.obsScope.type+'&scopeId='+encodeURIComponent(S.obsScope.id))
  if(r.error){box.innerHTML='';return}
  const head=`<div class="sec-h" style="margin:0 0 6px;color:var(--heading)">Online evaluation — production sampled scoring ${srcBadge('ledger')}</div>`
  if(!(r.days||[]).length){
    box.innerHTML=`<div class="card" style="margin-bottom:14px;border-left:3px solid var(--dom)">${head}
      <div class="d" style="color:var(--muted);font-size:.78rem">No recorded invocations in this scope yet.</div></div>`
    return
  }
  const pct=r.totals.invocations?Math.round(r.totals.samples/r.totals.invocations*100):0
  const srcLine=`<div class="d" style="color:var(--muted);font-size:.72rem;margin-top:8px"><b>${r.totals.samples}</b> of <b>${r.totals.invocations}</b> recorded invocations sampled (${pct}%) · usage ledger</div>`
  if(S.who!=='builder'){
    // Platform team: the aggregate quality score for the selected scope — no per-agent breakdown here.
    box.innerHTML=`<div class="card" style="margin-bottom:14px;border-left:3px solid var(--dom)">${head}
      <div style="display:flex;align-items:center;gap:14px;flex-wrap:wrap">
        <div><div class="d" style="font-size:.72rem;color:var(--muted)">Aggregate quality score</div>
          <h4 style="font-size:1.35rem;margin:2px 0">${evalPill(r.score.avg)}</h4></div>
        ${svgSpark(r.days.map(d=>d.score),'var(--dom)',180,40)}
        <span class="chip" style="color:var(--muted)">per-day detail: builder view</span>
      </div>${srcLine}</div>`
    return
  }
  box.innerHTML=`<div class="card" style="margin-bottom:14px;border-left:3px solid var(--dom)">${head}
    <div class="d" style="color:var(--dim);font-size:.74rem;margin:2px 0 8px"><b>${esc(S.obsScope.id)}</b> · avg ${evalPill(r.score.avg)} · latest ${evalPill(r.score.last)} · pass ≥ ${EVAL_THRESH}</div>
    ${svgArea({points:r.days.map(d=>d.score)},'var(--dom)',110)}
    <table style="margin-top:10px"><thead><tr><th>Day</th><th style="text-align:right">Invocations</th><th style="text-align:right">Sampled</th><th style="text-align:right">Judge score</th></tr></thead><tbody>
    ${r.days.map(d=>`<tr><td>${esc(d.day)}</td><td style="text-align:right">${d.invocations}</td><td style="text-align:right">${d.samples}</td><td style="text-align:right">${evalPill(d.score)}</td></tr>`).join('')}
    </tbody></table>${srcLine}</div>`
}
// T11 (J1.6): the platform admin's view of the access workflow — grant METADATA
// (who/what/why/how-long/status), never the content those grants unlock.
// G7: the grant-metadata table moved to the unified access-requests inbox
// (now the Governance › Access requests tab) — this panel became the compat
// link so the old obs surface still leads there.
async function loadAccessGrantMeta(){
  const box=document.getElementById('agbox'); if(!box)return
  const r=await api('/grant-requests?status=pending')
  const n=(r.requests||[]).length
  box.innerHTML=`<div class="card">
    <div class="sec-h" style="margin:0 0 6px">Content-access grants <span class="chip">metadata only</span>${n?` <span class="chip" style="color:var(--lock);border-color:var(--lock-bd)">${n} pending</span>`:''}</div>
    <button class="ghost" id="agopeninbox" style="padding:6px 12px;font-size:.76rem">Open Governance › Access requests →</button>
  </div>`
  const b=document.getElementById('agopeninbox')
  if(b)b.onclick=()=>{ S.view='requests'; render() }
}
// G13: rows arrive already scoped to the session's deployment account (server-
// side); the agent picker groups/narrows them per agent — a filter, never a
// widener. S.lfAgent holds the pick (cleared on login/domain switch).
async function loadLangfuse(){
  const box=document.getElementById('lfbox'); if(!box)return
  const r=await api('/langfuse-traces'+(S.lfAgent?'?agent='+encodeURIComponent(S.lfAgent):''))
  if(r.error||!r.traces){box.innerHTML='';return}
  const agentSel=(r.agents||[]).length?`<select id="lfagent" style="max-width:220px">
    <option value="">All agents (${r.agents.length})</option>
    ${r.agents.map(a=>`<option value="${esc(a)}" ${S.lfAgent===a?'selected':''}>${esc(a)}</option>`).join('')}</select>`:''
  box.innerHTML=`<div class="card" style="margin-bottom:14px">
    <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap"><div class="sec-h" style="margin:0;color:var(--heading)">Live Langfuse traces (latest ${r.traces.length}) ${srcBadge('otel')}</div>${agentSel}</div>
    ${r.traces.length?`<table><thead><tr><th>Agent</th><th>Time</th><th>User</th><th>Session</th><th>Tokens</th><th>Latency</th></tr></thead><tbody>
    ${r.traces.map(t=>`<tr><td>${t.agent?`<code style="font-size:.72rem">${esc(t.agent)}</code>`:'<span style="color:var(--muted)">unattributed</span>'}</td><td>${esc((t.timestamp||'').slice(0,19).replace('T',' '))}</td><td>${esc(t.userId||'—')}</td><td>${esc((t.sessionId||'—').slice(0,26))}</td><td>${esc(t.totalTokens??'—')}</td><td>${t.latency?esc(t.latency.toFixed(1))+'s':'—'}</td></tr>`).join('')}
    </tbody></table>`:`<div class="d" style="color:var(--muted);font-size:.76rem">no traces in this scope${S.lfAgent?' for '+esc(S.lfAgent):''} yet</div>`}</div>`
  const sel=document.getElementById('lfagent')
  if(sel)sel.onchange=e=>{ S.lfAgent=e.target.value; runSessionTask(loadLangfuse) }
}
const fmtNum=n=>n>=1e6?(n/1e6).toFixed(2)+'M':n>=1e3?(n/1e3).toFixed(1)+'k':String(n)
const fmtUsd=n=>'$'+(n>=1e3?(n/1e3).toFixed(1)+'k':n.toFixed(0))
const fmtMs=n=>n+' ms'
const fmtPct=n=>n+'%'
function obsSeriesForUi(series, fallbackLabel, kind='volume'){
  const points=(series?.points||[]).map(p=>typeof p==='number'?p:Number(p.v||0))
  const total=typeof series?.total==='number'?series.total:points.reduce((s,v)=>s+v,0)
  const avg=typeof series?.avg==='number'?series.avg:(points.length?total/points.length:0)
  const last=typeof series?.last==='number'?series.last:(points.at(-1)||0)
  return {label:series?.label||fallbackLabel,unit:series?.unit||'',kind:series?.kind||kind,points,total,avg,last}
}
async function loadObs(){
  const box=document.getElementById('obsbox'); if(!box)return
  const metrics='invocations,tokens.total,latency,ttft,errors,tool.invocations,reasoning.cycles,cost.usd'
  const m=await api('/obs/metrics?scope='+S.obsScope.type+'&scopeId='+encodeURIComponent(S.obsScope.id)+'&metrics='+encodeURIComponent(metrics)+'&window=14d&granularity=1d')
  const c=m.series||{}
  const s={
    latency:obsSeriesForUi(c.latency,'Latency','latency'),
    errors:obsSeriesForUi(c.errors,'Errors','volume'),
    ttft:obsSeriesForUi(c.ttft,'TTFT','latency'),
    tokens:obsSeriesForUi(c['tokens.total'],'Total tokens','volume'),
    reasoning:obsSeriesForUi(c['reasoning.cycles'],'Reasoning cycles','volume'),
    tools:obsSeriesForUi(c['tool.invocations'],'Tool invocations','volume'),
    invocations:obsSeriesForUi(c.invocations,'Invocations','volume'),
    costUsd:obsSeriesForUi(c['cost.usd'],'Cost','volume'),
  }
  const scopeName = S.obsScope.type==='fleet'?'the entire platform':(S.obsScope.type==='domain'?'domain "'+S.obsScope.id+'"':'agent "'+S.obsScope.id+'"')
  const sourceBadge=m.source==='cloudwatch'
    ? `${srcBadge('cloudwatch')} <span class="chip">CloudWatch · ${esc(m.namespace||'AgenticPlatform/Agents')}</span>`
    : `${srcBadge('fixture')} <span class="chip">offline demo fallback</span>`
  const sourceNote=m.source==='cloudwatch' ? '' : (m.fallbackReason?esc(m.fallbackReason):'')
  // Plain-language metric groups (Service health / Model performance / Agent
  // reasoning / Cost & usage) — replaces the old L1-L4 numbered-tier labels.
  // Both the top stat cards and the area-chart cards below are grouped under
  // the same four headers so the taxonomy is consistent top-to-bottom.
  // Recolor round 2: headings are normal dark section headers (no per-group
  // hue, no colored left border); the accent blue chart color stays.
  const group=(title,cards)=>`<div class="card" style="margin-bottom:14px">
    <div class="sec-h" style="margin:0 0 8px;color:var(--heading)">${title}</div>
    <div class="grid3">${cards}</div></div>`
  const stats=group('Service health',statCard(s.latency,'var(--accent)',fmtMs)+statCard(s.errors,'var(--accent)',fmtNum))
    + group('Model performance',statCard(s.ttft,'var(--accent)',fmtMs)+statCard(s.tokens,'var(--accent)',fmtNum))
    + group('Agent reasoning',statCard(s.reasoning,'var(--accent)',fmtNum)+statCard(s.tools,'var(--accent)',fmtNum))
    + group('Cost & usage',statCard(s.invocations,'var(--accent)',fmtNum)+statCard(s.costUsd,'var(--accent)',v=>fmtUsd(v)))
  // one area-chart card per metric group; these are the canonical Task 07 metric names.
  const layer=(title,metricId,fmt,sub)=>{const ser=s[metricId];return `<div class="card">
    <div style="display:flex;justify-content:space-between;align-items:baseline"><div class="sec-h" style="margin:0;color:var(--heading)">${title}</div>
      <div style="font-size:.72rem;color:var(--muted)">avg ${fmt(ser.avg)} · last ${fmt(ser.last)}</div></div>
    <div style="color:var(--dim);font-size:.74rem;margin:2px 0 8px">${sub}</div>
    ${svgArea(ser,'var(--accent)')}</div>`}
  const layers=`
    ${layer('Service health','latency',fmtMs,'agent.latency in the runtime template')}
    ${layer('Model performance','ttft',fmtMs,'agent.ttft — responsiveness the user feels')}
    ${layer('Agent reasoning','reasoning',fmtNum,'agent.reasoning.cycles across the selected scope')}
    ${layer('Cost & usage','costUsd',v=>fmtUsd(v),'Daily spend across the scope — the FinOps signal')}`
  // per-domain comparison (fleet scope only — it's the chargeback/showback view)
  const domainBars = S.obsScope.type==='fleet' ? `<div class="card">
    <div class="sec-h" style="margin:0 0 4px">Cost by domain <span class="chip" style="text-transform:none;letter-spacing:0">chargeback · ${m.windowDays}d</span></div>
    ${(m.domains||[]).length?svgBars(m.domains.map(d=>({label:d.label,value:d.costUsd,display:fmtUsd(d.costUsd),color:'var(--accent)'})),'var(--accent)'):'<div class="d" style="color:var(--muted);font-size:.76rem">No domain comparison rows returned for this backend.</div>'}
  </div>` : S.view==='monitoring' ? `<div class="card"><div class="d" style="color:var(--muted);font-size:.76rem">Switch Scope to <b>Entire platform</b> for cost by domain.</div></div>` : ''
  box.innerHTML = `<div class="d" style="color:var(--muted);font-size:.74rem;margin:-2px 0 12px;display:flex;gap:8px;align-items:center;flex-wrap:wrap">Showing <b style="color:var(--dim)">${scopeName}</b> · last ${m.windowDays} days ${sourceBadge}<span>${sourceNote}</span></div>`
    + stats + `<div class="grid2">${layers}</div>` + domainBars
}
function wireObs(){
  const sel=document.getElementById('obsscope'); if(!sel)return
  sel.onchange=e=>{
    const [type,id]=e.target.value.split(':')
    const label=e.target.options[e.target.selectedIndex].text.trim().replace(/^↳\s*/,'')
    S.obsScope={type,id,label}
    runSessionTask(loadObs); runSessionTask(loadOnlineEval)   // re-render metrics + online-eval boxes; scope selector stays put
  }
}

// Domain Builder observability: their own agents only, with a Metrics tab (same
// aggregate charts, scoped) and a Traces tab that is LOCKED behind elevated
// access — the content-level (input/output) view the platform team never sees.
function vObsBuilder(sc){
  // T03: /api/obs-scopes is domain-scoped server-side — only the builder's own
  // domain (and its agents) ever arrives here.
  const myAgents = sc.domains.flatMap(d=>d.agents)
  if(!S.traceAgent) S.traceAgent = myAgents[0]?.id || ''
  // T11: Domain Leads get the approval queue — they decide their domain's
  // content-access requests (requester ≠ approver, enforced server-side).
  const isLead=hasCap('decideAccessRequests')
  if(S.obsTab==='approvals') S.obsTab='metrics'   // legacy tab id — the queue moved to Governance › Access requests (G7)
  const tab=S.obsTab||'metrics'
  const tabBtn=(id,label)=>`<button class="ghost obstab ${tab===id?'primary':''}" data-tab="${id}" style="padding:7px 16px">${label}</button>`
  return `<span class="roletag dom">Domain team · application plane</span><h1>Observability</h1>
  <p class="subtitle">${isLead?'Metrics and content-level traces for your domain\'s agents.':'Metrics and content-level traces — content access: your Domain Lead decides.'}</p>
  ${isLead
    ? storyLine('','requests','Decide in Governance')
    : storyLine('','fleet','Your agents in Agent Fleet')}
  ${scopeNote()}
  <div class="bar" style="margin:0 0 14px">${tabBtn('metrics','Metrics')}${tabBtn('traces',isLead?ic2(ICONS.compass)+'Traces':ic2(ICONS.lock)+'Traces')}${tabBtn('alerts',ic2(ICONS.bell)+'Alerts')}${isLead?`<button class="ghost obstab" data-tab="goto-requests" style="padding:7px 16px">✓ Access requests →</button>`:''}</div>
  ${tab==='alerts'?`
    <div id="alertsbox"><div class="empty"><span class="spin">⟳</span> loading alerts…</div></div>`
  :tab==='metrics'?`
    <div class="card" style="display:flex;align-items:center;gap:14px;flex-wrap:wrap;padding:14px 20px">
      <label style="margin:0;font-size:.72rem">Agent</label>
      <select id="obsscope" style="max-width:240px">${myAgents.map(a=>`<option value="agent:${a.id}" ${S.obsScope.id===a.id?'selected':''}>${esc(a.label)}</option>`).join('')}</select>
    </div>
    <div id="obsbox"><div class="empty"><span class="spin">⟳</span> loading metrics…</div></div>
    <div id="oebox"></div>
    <div id="lfbox"></div>`
  :`
    <div class="card" style="display:flex;align-items:center;gap:14px;flex-wrap:wrap;padding:14px 20px">
      <label style="margin:0;font-size:.72rem">Agent</label>
      <select id="traceagent" style="max-width:240px">${myAgents.map(a=>`<option value="${a.id}" ${S.traceAgent===a.id?'selected':''}>${esc(a.label)}</option>`).join('')}</select>
    </div>
    <div id="tracebox"><div class="empty"><span class="spin">⟳</span> checking access…</div></div>`}`
}
// T11: shared request-access form + status for the locked state (traces AND
// memory extractions). Approval is human: justification + duration go to the
// same-domain Domain Lead; the form reflects where the request stands.
const fmtDur = s => s%3600===0?(s/3600)+'h':s%60===0?(s/60)+'m':s+'s'
function accessRequestPanel(kind,id,last,compact){
  const pad=compact?'12px 14px':'20px'
  const status = !last?'' :
    last.status==='pending'?`<div class="status info" style="margin-bottom:10px">⏳ Request pending — awaiting a decision by your <b>Domain Lead</b>. Justification: “${esc(last.justification)}” · requested duration ${fmtDur(last.durationS)}.</div>` :
    last.status==='denied'?`<div class="status err" style="margin-bottom:10px">✗ Your last request was denied by <b>${esc(last.decidedBy)}</b>. You can submit a new one with a stronger justification.</div>` :
    last.status==='expired'?`<div class="status info" style="margin-bottom:10px">⌛ Your previous grant expired (was approved by <b>${esc(last.decidedBy)}</b> for ${fmtDur(last.durationS)}). Request access again if you still need it.</div>` :
    last.status==='revoked'?`<div class="status info" style="margin-bottom:10px">${LOCK_IC}Your previous grant was revoked. Request access again if you still need it.</div>` : ''
  const form = (last&&last.status==='pending')?'' :
    `<div style="display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end;justify-content:${compact?'flex-start':'center'}">
      <div style="flex:1;min-width:220px;max-width:420px;text-align:left"><label style="margin-top:0">Justification (reviewed by your Domain Lead)</label>
        <input class="areq-why" placeholder="e.g. investigating ticket #4521 — refund loop"/></div>
      <div style="text-align:left"><label style="margin-top:0">Duration</label>
        <select class="areq-dur" style="max-width:110px"><option value="14400">4 hours</option><option value="3600">1 hour</option></select></div>
      <button class="primary areq-send" style="padding:9px 16px">Request access</button>
    </div>`
  return {html:`<div class="areq" data-kind="${esc(kind)}" data-id="${esc(id)}" style="padding:${pad}">${status}${form}</div>`}
}
function wireAccessRequest(box,reload){
  const p=box.querySelector('.areq'); if(!p)return
  const btn=p.querySelector('.areq-send'); if(!btn)return
  btn.onclick=sessionTaskHandler(async()=>{
    btn.disabled=true
    const r=await api('/obs-access-request',{kind:p.dataset.kind,id:p.dataset.id,
      justification:p.querySelector('.areq-why').value.trim(),
      durationS:Number(p.querySelector('.areq-dur').value)})
    if(!r.ok){btn.disabled=false;alert(r.error||'request failed');return}
    businessForms.clear('traceAccess')
    runSessionTask(reload)
  })
}
async function loadTraces(){
  const box=document.getElementById('tracebox'); if(!box)return
  if(!S.revealed) S.revealed=new Set()
  const revealedParam = S.revealed.size ? '&revealed='+encodeURIComponent([...S.revealed].join(',')) : ''
  const r=await api('/obs-traces?agent='+encodeURIComponent(S.traceAgent)+revealedParam)
  if(r.locked){
    box.innerHTML=`<div class="card" style="border-left:3px solid var(--lock);text-align:center;padding:36px 20px">
      <div class="icbig">${ICONS.lock}</div>
      <div class="sec-h" style="color:var(--lock);justify-content:center;margin:8px 0 6px">Elevated access required</div>
      <div class="d" style="color:var(--dim);font-size:.85rem;max-width:560px;margin:0 auto 16px">${esc(r.reason)} Access is approved by your <b>Domain Lead</b> (never self-approved), time-boxed, and audited.</div>
      ${accessRequestPanel('trace',S.traceAgent,r.request).html}
    </div>`
    wireAccessRequest(box,loadTraces)
    return
  }
  const t=r.traces||[]
  // T33: audit list — "Recently revealed" so a domain lead can see who's been
  // looking at raw content. Fetched alongside traces (separate small store).
  const auditR = await api('/obs-audit')
  const auditForAgent = (auditR.events||[]).filter(e=>e.agentId===S.traceAgent).slice(0,8)
  box.innerHTML=`<div class="card">
    <div style="display:flex;justify-content:space-between;align-items:center"><div class="sec-h" style="margin:0;color:var(--heading)">Session traces — ${esc(r.agent)} ${srcBadge('fixture')} ${r.ownPlane
      ?`<span class="chip">own plane · default access (masked)</span>`
      :`<span class="chip">access granted by ${esc(r.grant?.approvedBy||'lead')} · until ${esc((r.grant?.expiresAt||'').slice(11,19))} UTC</span>`}</div>
      ${r.ownPlane?'':`<button class="ghost" id="revokeaccess" style="padding:4px 12px;font-size:.75rem">Revoke</button>`}</div>
    <div class="meta" style="margin:4px 0 4px"><span class="chip" data-tracenote="synthetic" title="illustrative synthetic data">synthetic</span><span class="chip" data-tracenote="masked" title="Masked by default (&lt;EMAIL&gt;/&lt;PHONE&gt;/&lt;ORDER_ID&gt;) — demo-grade pattern masking, not a production PII detector (production: CloudWatch Logs data protection / Amazon Comprehend).">masked</span></div>
  </div>
  ${auditForAgent.length?`<div class="card" style="margin-bottom:10px">
    <div class="sec-h" style="margin:0 0 6px;color:var(--heading)">Recently revealed <span class="chip">audit</span></div>
    <div style="font-size:.74rem;color:var(--dim)">${auditForAgent.map(e=>`<div style="padding:3px 0">${e.action==='revoke'?LOCK_IC+'re-masked':UNLOCK_IC+'revealed'} <code>${esc(e.traceId)}</code> by <b>${esc(e.who)}</b> · ${esc(e.timestamp.slice(0,19).replace('T',' '))}</div>`).join('')}</div>
  </div>`:''}
  ${t.map(x=>{
    const revealed = S.revealed.has(x.traceId)
    return `<div class="item" style="margin-bottom:10px">
    <div style="display:flex;gap:8px;flex-wrap:wrap;font-size:.68rem;color:var(--muted);margin-bottom:8px;align-items:center">
      <span class="chip">${esc(x.sessionId)}</span><span class="chip">user ${esc(x.userId)}</span><span class="chip">${x.hoursAgo}h ago</span>
      <span class="chip">TTFT ${x.ttftMs}ms</span><span class="chip">${x.totalTokens} tok</span><span class="chip">${x.latencyS}s</span>
      <span class="chip" style="color:${x.evalScore>=0.8?'var(--ok)':x.evalScore>=0.6?'var(--lock)':'var(--err)'}">eval ${x.evalScore}</span>
      ${revealed?`<span class="chip" style="color:var(--err);border-color:var(--err-bd)">access granted · audited</span><button class="ghost reveal-toggle" data-trace="${esc(x.traceId)}" data-action="revoke" style="padding:2px 10px;font-size:.68rem">Revoke</button>`
        :`<button class="ghost reveal-toggle" data-trace="${esc(x.traceId)}" data-action="reveal" style="padding:2px 10px;font-size:.68rem">Reveal PII</button>`}</div>
    <div style="font-size:.82rem"><span style="color:var(--dim);font-weight:600;font-size:.7rem;text-transform:uppercase;letter-spacing:.05em">▸ input</span><div style="margin:2px 0 8px">${esc(x.input)}</div>
      <span style="color:var(--dim);font-weight:600;font-size:.7rem;text-transform:uppercase;letter-spacing:.05em">◂ output</span><div style="margin:2px 0 8px;color:var(--dim)">${esc(x.output)}</div>
      <span style="color:var(--muted)">tools:</span> ${x.tools.map(tl=>`<span class="chip type">${esc(tl)}</span>`).join(' ')}
      ${x.feedback?`<div style="margin-top:6px;font-size:.72rem;color:var(--muted)">${x.feedback.rating==='up'?'👍':'👎'} <b>${esc(x.feedback.user||'user')}</b>${x.feedback.comment?` · ${esc(x.feedback.comment)}`:''}</div>`:''}</div>
  </div>`}).join('')}`
  const revokeBtn=document.getElementById('revokeaccess')
  if(revokeBtn) revokeBtn.onclick=sessionTaskHandler(async()=>{ await api('/obs-access-revoke',{kind:'trace',id:S.traceAgent}); S.revealed=new Set(); runSessionTask(loadTraces) })
  box.querySelectorAll('.reveal-toggle').forEach(btn=>{
    btn.onclick=sessionTaskHandler(async()=>{
      const traceId=btn.dataset.trace, action=btn.dataset.action
      if(action==='reveal') S.revealed.add(traceId); else S.revealed.delete(traceId)
      await api('/obs-audit',{agentId:S.traceAgent,traceId,action})
      runSessionTask(loadTraces)
    })
  })
}
function wireObsTabs(){
  document.querySelectorAll('.obstab').forEach(b=>b.onclick=()=>{
    // Compat link (G7): the lead's old approvals tab lives in Governance › Access requests now.
    if(b.dataset.tab==='goto-requests'){ S.view='requests'; render(); return }
    S.obsTab=b.dataset.tab; render() })
  const ta=document.getElementById('traceagent')
  if(ta) ta.onchange=e=>{ S.traceAgent=e.target.value; runSessionTask(loadTraces) }
}
// ---------- Compose wizard (domain) ----------
function composeSteps(){
  const steps=[['1','Choose Blueprint'],['2','Compose from Catalog'],['3','Review & export']]
  return `<div class="steps">${steps.map(([n,t])=>`<div class="step ${S.step==n?'active':''}"><span class="n">${n}</span>${t}</div>`).join('')}</div>`
}
// Three-door entry (builder journeys): the Build tab opens on a landing with
// one card per journey. They differ only in how much the platform prescribes;
// the CI/CD + eval gate is identical across all three.
// TLP-B8 (b8-feedback #5): AI-assisted moved to first door and now default-
// carries the org foundation harness; "Start from scratch" is redefined as
// "Foundation start" — an org foundation configurator (guardrails/CI/
// governance/observability/eval), not a blank slate. Blueprint moves to the
// third door. All three still exit through the same GitHub-first gate.
const DOORS=[
  { id:'blueprint', ic:BP_IC, title:'Start from Blueprint', preset:'FULL preset',
    d:'Compose on an approved template; export code + spec + gates.' },
  { id:'scratch', ic:WRENCH_IC, title:'Foundation start', preset:'MINIMAL preset',
    d:'Configure the org foundation — guardrails, CI, governance, observability, eval — and export it.' },
  { id:'plato', ic:CHAT_IC, title:'AI-assisted design', preset:'SPEC preset',
    d:'Describe the agent in a conversation; export a spec-first repo (CLAUDE.md, SPEC.md, TDD skeleton) with the org foundation harness.' },
]
function vDoorLanding(){
  return `<div class="card"><span class="roletag dom">choose your journey</span>
    <p class="d" style="color:var(--muted);font-size:.78rem;margin-bottom:12px">Three ways in, one gate out — the same CI/CD + eval gate.</p>
    <div class="grid3">${DOORS.map(d=>`<div class="card bp" data-door="${d.id}"><h4>${d.ic} ${d.title}</h4><div class="d" style="font-size:.8rem;color:var(--dim);margin:6px 0 8px">${d.d}</div><span class="chip type">${d.preset}</span></div>`).join('')}</div></div>
  ${builderBlueprintSubmitCard()}`
}
// TLP-B19 (B-J3 step 1): the builder-side blueprint contribution entry.
// Platform members submit from the Blueprints page (TLP-B7); domain builders
// had no entry at all. Same structured draft, the same server-side
// /api/blueprint-submit validation, and the same platform peer-approval
// queue decide the submission — only the entry point is new.
function builderBlueprintSubmitCard(){
  if(!hasCap('useBuilderSurfaces')) return ''
  const opts=(S.catalog&&S.catalog.blueprintOptions)||{}
  return `<div class="card" id="bbsubmitcard"><div class="sec-h" style="margin-top:0">Contribute a blueprint <span class="chip" style="color:var(--plat);border-color:var(--plat-bd)">platform peer approval</span></div>
    <div class="grid2">
      <div><label style="margin-top:0">Blueprint id (slug)</label><input id="bbid" placeholder="e.g. returns-triage"/></div>
      <div><label style="margin-top:0">Name</label><input id="bbname" placeholder="e.g. Returns Triage"/></div>
    </div>
    <label>Description / use case</label><input id="bbusecase" placeholder="e.g. Classifies return requests and drafts the customer reply"/>
    <div class="grid2">
      <div><label>Base template</label><select id="bbbase"><option value="">— start from a published blueprint —</option>${S.blueprints.map(b=>`<option value="${esc(b.id)}">${esc(b.name)}</option>`).join('')}</select></div>
      <div><label>Framework</label><select id="bbfw">${(opts.framework||[]).map(f=>`<option>${esc(f)}</option>`).join('')}</select></div>
      <div><label>Deploy target</label><select id="bbdt">${(opts.deployTarget||[]).map(f=>`<option>${esc(f)}</option>`).join('')}</select></div>
      <div><label>Protocol</label><select id="bbproto">${(opts.protocol||[]).map(f=>`<option>${esc(f)}</option>`).join('')}</select></div>
      <div><label>Memory</label><select id="bbmem">${(opts.memory||[]).map(f=>`<option>${esc(f)}</option>`).join('')}</select></div>
    </div>
    <div class="bar"><button class="primary" id="bbsubmit">Submit for approval</button><span id="bbmsg" style="font-size:.78rem"></span></div>
  </div>`
}
function wireBuilderBlueprintSubmit(){
  const btn=document.getElementById('bbsubmit'); if(!btn)return
  const base=document.getElementById('bbbase')
  if(base)base.onchange=()=>{
    const bp=S.blueprints.find(b=>b.id===base.value); if(!bp)return
    const t=bp.template||{}
    for(const [sel,key] of [['bbfw','framework'],['bbdt','deployTarget'],['bbproto','protocol'],['bbmem','memory']]){
      const el=document.getElementById(sel); if(el&&t[key])el.value=t[key]
    }
  }
  btn.onclick=sessionTaskHandler(async()=>{
    const v=id=>document.getElementById(id).value
    const msg=document.getElementById('bbmsg')
    const baseT=(S.blueprints.find(b=>b.id===v('bbbase'))||{}).template||{}
    const template={ ...baseT, framework:v('bbfw'), deployTarget:v('bbdt'), protocol:v('bbproto'), memory:v('bbmem') }
    if(!('streaming' in template))template.streaming=true
    if(!('identity' in template))template.identity=true
    if(!('guardrails' in template))template.guardrails=true
    btn.disabled=true
    const payload={id:v('bbid').trim(),name:v('bbname').trim(),useCase:v('bbusecase').trim(),template,source:{kind:'illustrative'}}
    const r=authMode()==='cognito'?await submitHostedBlueprint(payload):await api('/blueprint-submit',payload)
    btn.disabled=false
    if(!r.ok){ msg.style.color='var(--err)'; msg.textContent=(r.errors||[r.error||'Submission failed.']).join(' '); return }
    msg.style.color='var(--ok)'; msg.textContent=`Submitted — "${r.submission.name}" is pending platform peer approval.`
    businessForms.clear('blueprint')
    for(const id of ['bbid','bbname','bbusecase'])document.getElementById(id).value=''
  })
}
function mainBuildSlug(value,fallback='agent'){
  const slug=String(value||'').trim().toLowerCase()
    .replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'')
  const normalized=/^[a-z]/.test(slug)?slug:`agent-${slug||fallback}`
  return normalized.slice(0,64).replace(/-+$/,'')||fallback
}
function mainBuildDomainId(){
  return SESSION?.role==='admin'?'platform':activeDomain()
}
function mainBuildOptions(blueprint){
  const template=blueprint?.template||{}
  return {
    framework:S.framework||template.framework||'Strands',
    deployTarget:S.deployTarget||template.deployTarget||'AgentCore Runtime',
    memory:S.optMemory||template.memory||'none',
    streaming:(S.optStreaming!==undefined?S.optStreaming:template.streaming)!==false,
    identity:(S.optIdentity!==undefined?S.optIdentity:template.identity)!==false,
    guardrails:(S.optGuardrails!==undefined?S.optGuardrails:template.guardrails)!==false,
  }
}
function mainBuildGuardrailChain(){
  if(!S.guardrailConfig)return defaultGuardrailChain()
  try{
    return validateGuardrailChain(S.guardrailConfig.map((entry,priority)=>({
      id:entry.id,
      enabled:entry.enabled===true,
      action:entry.action,
      runMode:entry.runMode,
      message:String(entry.message||'').trim(),
      priority,
    })))
  }catch{
    return defaultGuardrailChain()
  }
}
function mainBuildAgentInput({
  name=S.project,
  description=S.persona,
  instructions=S.persona,
  modelId=resolveBuildModelId(mainProjectCatalog().models,S.model),
  blueprintId=S.bp,
  projectId,
  agentId,
}={}){
  const domainId=mainBuildDomainId()
  const selectedProject=currentMainBuildProject()
  const normalizedProjectId=mainBuildSlug(projectId||selectedProject?.id||name||'agent-project')
  const normalizedAgentId=mainBuildSlug(agentId||name||normalizedProjectId)
  const blueprint=S.blueprints.find(item=>item.id===blueprintId)
  const buildOptions=mainBuildOptions(blueprint)
  const buildConfig={
    instructions:String(instructions||'').trim(),
    modelParameters:{
      temperature:S.mpTemp===''||S.mpTemp==null?null:Number(S.mpTemp),
      maxTokens:S.mpMaxTok===''||S.mpMaxTok==null?null:Number(S.mpMaxTok),
    },
    buildOptions,
    ...(buildOptions.guardrails?{guardrailChain:mainBuildGuardrailChain()}:{}),
  }
  return {
    project:{
      domainId,
      id:normalizedProjectId,
      name:selectedProject?.name||String(name||normalizedProjectId).trim().slice(0,128),
      description:selectedProject?.description||String(description||'').replace(/\s+/g,' ').trim().slice(0,4096),
    },
    agent:{
      domainId,
      projectId:normalizedProjectId,
      id:normalizedAgentId,
      name:String(name||normalizedAgentId).trim().slice(0,128),
      // Metadata is single-line; the full multiline prompt belongs in buildConfig.
      description:String(description||'').replace(/\s+/g,' ').trim().slice(0,4096),
      modelId,
      toolIds:normalizeSelectedResourceIds(S.tools,S.approvedTools),
      mcpServerIds:normalizeSelectedResourceIds(S.mcp,S.approvedMcp),
      skillIds:normalizeSelectedResourceIds(S.skills,S.approvedSkills),
      blueprintIds:blueprintId?[blueprintId]:[],
      memoryIds:[],
      knowledgeBaseIds:[],
      buildConfig,
    },
  }
}
function mainSpecInstructions(journey){
  const profile=journey?.inception?.profile||{}
  const capabilities=Array.isArray(profile.capabilities)?profile.capabilities:[]
  const compliance=Array.isArray(profile.compliance)?profile.compliance:[]
  return [
    profile.summary||`Implement the approved specification for ${journey.repositoryName}.`,
    capabilities.length?`Required capabilities:\n- ${capabilities.join('\n- ')}`:'',
    profile.performsActions===false?'The Agent must remain read-only.':'',
    compliance.length?`Compliance requirements:\n- ${compliance.join('\n- ')}`:'',
  ].filter(Boolean).join('\n\n')
}
function mainSpecAgentInput(journey){
  const profile=journey?.inception?.profile||{}
  const blueprint=mainProjectBlueprints().find(item=>item.deployable!==false)
  const suffix=String(journey?.id||'journey')
    .replace(/[^a-z0-9]/gi,'').slice(-6).toLowerCase()
  const base=mainBuildSlug(journey?.repositoryName||profile.name||'spec-agent')
  const agentId=`${base.slice(0,Math.max(1,57-suffix.length)).replace(/-+$/,'')}-${suffix}`
  return mainBuildAgentInput({
    name:profile.name||journey?.repositoryName||'Specification Agent',
    description:profile.summary||'Agent generated from an approved specification contract.',
    instructions:mainSpecInstructions(journey),
    modelId:resolveBuildModelId(mainProjectCatalog().models),
    blueprintId:blueprint?.id||'',
    projectId:currentMainBuildProject()?.id,
    agentId,
  })
}
function mainBuildNotice(){
  return S.mainBuildMessage
    ?`<div class="status ${S.mainBuildMessage.ok?'ok':'err'}">${esc(S.mainBuildMessage.text)}</div>`
    :''
}
function mainBuildRef(agent){
  return {
    domainId:agent.domainId,
    projectId:agent.projectId,
    agentId:agent.id,
  }
}
function setMainBuildAgent(target,agent){
  if(target==='plato')S.platoAgent=agent
  else if(S.gen)S.gen.agent=agent
}
async function mainDeploySandbox(agent,target){
  if(!agent)return
  const result=await mainBuildActions.deploySandbox(mainBuildRef(agent))
  if(result?.ok===true&&result.agent){
    setMainBuildAgent(target,result.agent)
    S.mainBuildMessage={
      ok:true,
      text:'The Agent is deployed to the governed sandbox Runtime.',
    }
  }else{
    S.mainBuildMessage={
      ok:false,
      text:apiErrorMessage(result,'The sandbox deployment did not complete.'),
    }
  }
  render()
}
async function mainSubmitProduction(agent,target){
  if(!agent)return
  const result=await mainBuildActions.submitProduction(mainBuildRef(agent))
  if(result?.ok===true&&result.agent){
    setMainBuildAgent(target,result.agent)
    S.mainBuildMessage={
      ok:true,
      text:'Production deployment was submitted. A different eligible reviewer must approve it in Approvals.',
    }
  }else{
    S.mainBuildMessage={
      ok:false,
      text:apiErrorMessage(result,'The production deployment request could not be submitted.'),
    }
  }
  render()
}
// J-T10: from-scratch journey — the org-mandated minimum. A short form (agent
// name; domain from the server session; the org gates, all on) drives a live
// file-list preview from /api/scratch-manifest, then a MINIMAL-preset export.
// TLP-B8 (b8-feedback #2/#5): Foundation start — redefined from a blank
// "start from scratch" into an org-foundation configurator. Same MINIMAL-preset
// export pipeline underneath (single-digit gate pack), plus the shared
// guardrails-configurator panel (also used by Blueprint config, wireGuardrailPanel
// below) and toggles for CI / governance & controls / observability / eval
// foundation — all on by default, all editable before export.
function vScratchDoor(){
  const orgs=sortedGhOrgs((S.catalog&&S.catalog.githubOrgs)||[])
  S.foundationOpts=S.foundationOpts||{ci:true,governance:true,observability:true,evalFoundation:true}
  const fo=S.foundationOpts
  const optRow=(id,label,checked)=>`<label style="display:flex;gap:6px;align-items:center;margin:0"><input type="checkbox" id="${id}" ${checked?'checked':''} style="width:auto"/> ${label}</label>`
  const exportPanel=authMode()==='cognito'
    ?`<label style="margin-top:0">${KEY_IC}Preview the foundation repository</label>
      <p class="d" style="color:var(--muted);font-size:.74rem">The immutable preview is approved before GitHub OAuth. You choose the owning GitHub account during authorization.</p>
      <label>Repository name</label>
      <div class="bar"><input id="scghrepo" data-demo-assist-field="repositoryName" value="${esc(S.hostedBuildDelivery?.repositoryName||S.scratchName||'')}" placeholder="defaults to the agent name"/></div>
      <div class="bar"><button class="primary" id="scexp">Preview foundation repository</button></div>`
    :`<label style="margin-top:0">${KEY_IC}Export the foundation — SSO GitHub org</label>
      <select id="scghorg">${orgs.map(o=>`<option value="${o.id}" ${S.ghOrg===o.id?'selected':''}>${o.label} · ${o.kind}${o.real?' (live)':' (demo)'}</option>`).join('')}</select>
      ${orgConfirmRow('sc')}
      <label>Repository name</label>
      <div class="bar"><input id="scghrepo" placeholder="defaults to the agent name"/></div>
      <div class="bar"><button class="primary" id="scexp">Authorize with SSO &amp; Export to GitHub</button></div>`
  return `${mainBuildNotice()}<div class="bar" style="margin-bottom:4px"><button class="ghost" id="doorback" style="font-size:.78rem;padding:5px 12px">← All journeys</button></div>
    <div class="card"><span class="roletag dom">journey · foundation start</span>
    <h3 style="margin-top:8px">${WRENCH_IC}Foundation start</h3>
    <p class="d" style="color:var(--muted);font-size:.78rem">Configure the org foundation — Guardrails, CI, Governance &amp; controls, Observability, Eval foundation — and export it.</p>
    <label>Agent name</label>
    <div class="bar"><input id="scname" data-demo-assist-field="agentName" value="${esc(S.scratchName||'')}" placeholder="e.g. inventory-helper"/></div>
    <div class="d" style="color:var(--muted);font-size:.74rem;margin-top:2px">Domain: <b>${esc(SESSION&&SESSION.domain||'platform')}</b> · Gates: <b>eval · tests · compliance</b> — always on.</div>
    <label style="margin-top:12px">Foundation options</label>
    <div style="display:flex;gap:14px;flex-wrap:wrap;font-size:.82rem;color:var(--text)">
      ${optRow('fo-ci','CI (the 3-gate workflows)',fo.ci)}
      ${optRow('fo-gov','Governance &amp; controls',fo.governance)}
      ${optRow('fo-obs','Observability basics',fo.observability)}
      ${optRow('fo-eval','Eval foundation pipeline',fo.evalFoundation)}
    </div>
    ${guardrailPanelHtml('sc')}
    <label style="margin-top:12px">Repository files</label>
    <div id="scprev"><div class="d" style="color:var(--muted);font-size:.78rem">Name your agent to preview the file list.</div></div>
    <div class="card" style="background:var(--surface2);margin-top:12px">
      ${exportPanel}
      <div id="sces"></div>
      <div id="sclifecycle"></div>
    </div></div>${authMode()==='cognito'?hostedDeliveryCard():''}`
}
async function loadScratchManifest(){
  const box=document.getElementById('scprev'); if(!box)return
  const name=(document.getElementById('scname')?.value||'').trim()
  S.scratchName=name
  if(!name){ box.innerHTML=`<div class="d" style="color:var(--muted);font-size:.78rem">Name your agent to preview the file list.</div>`; return }
  if(authMode()==='cognito'){
    const files=[
      '.github/workflows/eval.yml',
      '.github/workflows/tests.yml',
      '.github/workflows/compliance.yml',
      'CLAUDE.md',
      'gates/platform-gates.json',
      'gates/run-eval.mjs',
      'gates/run-tests.mjs',
      'gates/check-guardrails.mjs',
      'README.md',
    ]
    box.innerHTML=`
      <div class="d" style="color:var(--dim);font-size:.78rem;margin-bottom:6px"><b>${files.length}</b> foundation files · the authoritative contents are fingerprinted in the immutable preview.</div>
      <div style="border:1px solid var(--border);border-radius:8px;padding:8px 10px">
        ${files.map(path=>`<div style="font-size:.74rem;padding:1px 0;color:var(--text)"><code>${esc(path)}</code></div>`).join('')}
      </div>`
    return
  }
  const r=await api('/scratch-manifest?name='+encodeURIComponent(name))
  if(!r.ok){ box.innerHTML=`<div class="status err">${esc(r.error||'manifest failed')}</div>`; return }
  const files=r.files||[]
  box.innerHTML=`
    <div class="d" style="color:var(--dim);font-size:.78rem;margin-bottom:6px"><b>${files.length}</b> files — the whole repo. Single-digit by design.</div>
    <div style="border:1px solid var(--border);border-radius:8px;padding:8px 10px">
      ${files.map(f=>`<div style="font-size:.74rem;padding:1px 0;color:var(--text)"><code>${esc(f.path)}</code>${f.kind==='generate'?' <span class="chip" style="text-transform:none;letter-spacing:0">generated</span>':''}</div>`).join('')}
    </div>`
}
async function scratchExport(){
  const st=document.getElementById('sces'), name=(document.getElementById('scname')?.value||'').trim()
  if(!name){ st.innerHTML=`<div class="status err">Name your agent first.</div>`; return }
  if(authMode()==='cognito'){
    const repositoryName=(document.getElementById('scghrepo')?.value||name).trim()
    st.innerHTML=`<div class="empty"><span class="spin">⟳</span> composing immutable foundation preview…</div>`
    const result=await mainBuildActions.previewFoundation(repositoryName)
    if(result?.ok===true&&result.delivery){
      S.hostedBuildDelivery=result.delivery
      S.hostedBuildDeliveryResult=null
      S.mainBuildMessage={ok:true,text:'Foundation repository preview is ready for approval.'}
    }else{
      S.mainBuildMessage={ok:false,text:apiErrorMessage(result,'The foundation repository preview could not be created.')}
    }
    render()
    return
  }
  const owner=document.getElementById('scghorg')?.value, repoName=(document.getElementById('scghrepo')?.value||'').trim()
  const confirmReal=!!document.getElementById('scconfirmreal')?.checked
  st.innerHTML=`<div class="empty"><span class="spin">⟳</span> staging foundation, creating repo…</div>`
  const r=await api('/scratch-export',{name,owner,repoName,confirmReal})
  st.innerHTML=r.ok?`<div class="status ok">✓ ${esc(r.repo||'')} — <a href="${esc(r.url||'#')}" target="_blank" style="color:var(--ok)">${esc(r.url||'')}</a><pre style="white-space:pre-wrap;font-size:.72rem;margin-top:6px">${esc(r.output||'')}</pre></div>`
    :`<div class="status err"><pre style="white-space:pre-wrap;font-size:.72rem;margin:0">${esc(r.output||r.error||'export failed')}</pre></div>`
  if(r.ok){ S.lifecycleRepo=r.repo; await renderLifecycle('sclifecycle') }
}
// TLP-B8 (b8-feedback #2): shared guardrails-configurator panel, rendered by
// both Foundation start (prefix 'sc') and Blueprint config (prefix 'bp').
// Each row: toggle + Action + Run Mode + custom message; priority = list
// order via up/down buttons (top = highest — same-action matches show only
// the top hit's message; disabled rows carry no reorder affordance).
// R-B10-06: shared confirm-real-org UI row. selecting a live/real GitHub org
// requires an explicit checkbox before export; mock orgs need no confirmation.
function orgConfirmRow(prefix){
  return `<div id="${prefix}confirmwrap" style="display:none;margin-top:8px;padding:8px 10px;border:1px solid var(--lock-bd);border-radius:8px;background:var(--lock-bg)">
    <label style="display:flex;gap:8px;align-items:center;font-size:.8rem;margin:0"><input type="checkbox" id="${prefix}confirmreal"/> This will create a real GitHub repository</label>
  </div>`
}
function toggleConfirmReal(prefix){
  const sel=document.getElementById(prefix+'ghorg'), wrap=document.getElementById(prefix+'confirmwrap')
  if(!sel||!wrap)return
  const org=((S.catalog||{}).githubOrgs||[]).find(o=>o.id===sel.value)
  wrap.style.display = org&&org.real ? '' : 'none'
}
// F3 — Memory plan (wizard step 2). A "Memory: longAndShortTerm" dropdown says
// nothing about the two things a reviewer actually asks: how long conversation
// events live, and whether one user can read another's. Both come from the
// blueprint's own agentcore.json (memoryPlan on /api/blueprints), so this panel
// is the provisioned policy, not a caption: the retention bar is the real
// eventExpiryDuration, and each row is a real namespaceTemplate with {actorId}
// — the per-user partition key — highlighted in the accent.
// An imported agent-config.yaml may tighten retention/scope; when one is loaded
// its values render as the domain override next to the platform default.
function memoryPlanHtml(bp,mode){
  if(mode==='none') return `<div class="d" style="color:var(--muted);font-size:.74rem;margin-top:8px">${MEM_IC}Memory off — this agent keeps no state between turns.</div>`
  const plan=bp&&bp.memoryPlan
  const ov=(S.acConfig||{}).memory
  const days=ov?.retentionDays ?? plan?.retentionDays ?? null
  // 90 days is the org retention ceiling the bar is drawn against, so a 30-day
  // policy reads as "well inside the cap" rather than as a full bar.
  const CAP=90, pct=days?Math.max(6,Math.min(100,Math.round(days/CAP*100))):0
  const ns=s=>esc(s).replace(/\{actorId\}/g,`<b style="color:var(--accent)">{actorId}</b>`).replace(/\{sessionId\}/g,`<span style="color:var(--dim)">{sessionId}</span>`)
  const rows=(plan?.strategies||[]).filter(s=>(s.namespaces||[]).length)
  const perUser=rows.some(s=>s.namespaces.some(n=>n.includes('{actorId}')))
  return `<div style="border:1px solid var(--border);border-radius:8px;padding:10px 12px;margin-top:10px;background:var(--surface2)">
    <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:8px">
      <span style="font-size:.72rem;color:var(--dom);text-transform:uppercase;letter-spacing:.06em">${MEM_IC}Memory plan${bp&&bp.name?` · ${esc(bp.name)}`:''}</span>
      <span class="chip" style="color:var(--lock);border-color:var(--lock-bd)">${LOCK_IC}platform-provisioned</span>
      ${perUser?'<span class="chip" style="color:var(--ok);border-color:var(--ok-bd)">namespaced per user</span>':''}
      ${ov?'<span class="chip" style="color:var(--ok);border-color:var(--ok-bd)">from agent-config.yaml</span>':''}
    </div>
    ${days?`<div style="display:flex;align-items:center;gap:10px;margin-bottom:8px">
      <span class="d" style="font-size:.74rem;color:var(--muted);min-width:104px">Retention policy</span>
      <div style="flex:1;min-width:120px;max-width:280px;height:8px;border-radius:4px;background:var(--muted-bg);overflow:hidden">
        <div style="width:${pct}%;height:100%;background:var(--accent)"></div></div>
      <span style="font-size:.78rem;font-weight:600;white-space:nowrap">${days} days</span>
      <span class="d" style="font-size:.72rem;color:var(--muted);white-space:nowrap">then events auto-expire · org cap ${CAP}d</span>
    </div>`:''}
    ${rows.length?`<div class="d" style="font-size:.74rem;color:var(--muted);margin-bottom:4px">Namespaces written per strategy</div>
    ${rows.map(s=>`<div style="display:flex;gap:10px;align-items:baseline;font-size:.74rem;padding:1px 0">
      <span class="chip type" style="min-width:118px;text-align:center">${esc(s.type)}</span>
      <code style="font-family:ui-monospace,SFMono-Regular,Menlo,monospace">${s.namespaces.map(ns).join('</code> <code>')}</code>
    </div>`).join('')}
    <p class="d" style="color:var(--muted);font-size:.72rem;margin-top:6px"><b style="color:var(--accent)">{actorId}</b> is the signed-in user's identity — one partition per user, so a retrieval can never reach another user's memory.${ov?.scope?` Imported scope: <code>${esc(ov.scope)}</code>.`:''}</p>`
    :`<p class="d" style="color:var(--muted);font-size:.72rem;margin:0">Namespaces are provisioned at deploy time — this blueprint is a published template, so the exact templates land with the generated project.</p>`}
  </div>`
}
function guardrailPanelHtml(prefix){
  const rows=S.guardrailConfig||[]
  const row=(g,i)=>`<div class="item" data-grow="${esc(g.id)}" style="margin-bottom:6px;padding:8px 10px">
    <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
      <label style="display:flex;gap:6px;align-items:center;margin:0;min-width:170px"><input type="checkbox" data-gtoggle="${esc(g.id)}" ${g.enabled?'checked':''} style="width:auto"/><b style="font-size:.82rem">${esc(g.name)}</b></label>
      <span style="display:flex;gap:6px;align-items:center;font-size:.78rem">Action: <select data-gaction="${esc(g.id)}" style="width:auto;padding:4px 8px">${GUARDRAIL_ACTION_OPTS.map(a=>`<option ${g.action===a?'selected':''}>${a}</option>`).join('')}</select></span>
      <span style="display:flex;gap:6px;align-items:center;font-size:.78rem">Run mode: <select data-grunmode="${esc(g.id)}" style="width:auto;padding:4px 8px">${GUARDRAIL_RUNMODE_OPTS.map(m=>`<option ${g.runMode===m?'selected':''}>${m}</option>`).join('')}</select></span>
      <span style="margin-left:auto;display:flex;gap:2px">${g.enabled?`<button class="ghost" data-gup="${esc(g.id)}" ${i===0?'disabled':''} style="padding:2px 8px;font-size:.74rem">↑</button><button class="ghost" data-gdown="${esc(g.id)}" ${i===rows.length-1?'disabled':''} style="padding:2px 8px;font-size:.74rem">↓</button>`:''}</span>
    </div>
    <input data-gmsg="${esc(g.id)}" data-demo-assist-field="guardrailMessage" value="${esc(g.message||'')}" placeholder="custom message shown when this guardrail blocks/flags" style="margin-top:6px;font-size:.78rem;padding:5px 8px"/>
  </div>`
  return `<label style="margin-top:12px">Guardrails <span class="chip type">priority: top = highest — same-action matches show only the top hit's message</span></label>
    <div data-gpanel="${prefix}">${rows.map((g,i)=>row(g,i)).join('')||'<div class="d" style="color:var(--muted);font-size:.78rem">Loading guardrail catalog…</div>'}</div>`
}
const GUARDRAIL_ACTION_OPTS=['Block','Flag','Redact']
const GUARDRAIL_RUNMODE_OPTS=['Pre-Agent Execution','Post-Agent Execution']
async function loadGuardrailPanel(prefix){
  if(!S.guardrailConfig){
    const r=await api('/guardrail-catalog')
    if(r.ok) S.guardrailConfig=r.catalog.map((g,i)=>({ id:g.id, name:g.name, enabled:true, action:g.defaultAction, runMode:g.defaultRunMode, message:'', priority:i }))
  }
  const host=document.querySelector(`[data-gpanel="${prefix}"]`); if(!host)return
  host.outerHTML=`<div data-gpanel="${prefix}">${(S.guardrailConfig||[]).map((g,i)=>guardrailRowHtml(g,i,(S.guardrailConfig||[]).length)).join('')}</div>`
  wireGuardrailPanel(prefix)
  applyDemoAssistToHostedView()
}
function guardrailRowHtml(g,i,n){
  return `<div class="item" data-grow="${esc(g.id)}" style="margin-bottom:6px;padding:8px 10px">
    <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
      <label style="display:flex;gap:6px;align-items:center;margin:0;min-width:170px"><input type="checkbox" data-gtoggle="${esc(g.id)}" ${g.enabled?'checked':''} style="width:auto"/><b style="font-size:.82rem">${esc(g.name)}</b></label>
      <span style="display:flex;gap:6px;align-items:center;font-size:.78rem">Action: <select data-gaction="${esc(g.id)}" style="width:auto;padding:4px 8px">${GUARDRAIL_ACTION_OPTS.map(a=>`<option ${g.action===a?'selected':''}>${a}</option>`).join('')}</select></span>
      <span style="display:flex;gap:6px;align-items:center;font-size:.78rem">Run mode: <select data-grunmode="${esc(g.id)}" style="width:auto;padding:4px 8px">${GUARDRAIL_RUNMODE_OPTS.map(m=>`<option ${g.runMode===m?'selected':''}>${m}</option>`).join('')}</select></span>
      <span style="margin-left:auto;display:flex;gap:2px">${g.enabled?`<button class="ghost" data-gup="${esc(g.id)}" ${i===0?'disabled':''} style="padding:2px 8px;font-size:.74rem">↑</button><button class="ghost" data-gdown="${esc(g.id)}" ${i===n-1?'disabled':''} style="padding:2px 8px;font-size:.74rem">↓</button>`:''}</span>
    </div>
    <input data-gmsg="${esc(g.id)}" data-demo-assist-field="guardrailMessage" value="${esc(g.message||'')}" placeholder="custom message shown when this guardrail blocks/flags" style="margin-top:6px;font-size:.78rem;padding:5px 8px"/>
  </div>`
}
function wireGuardrailPanel(prefix){
  const host=document.querySelector(`[data-gpanel="${prefix}"]`); if(!host)return
  const rerender=()=>{ host.outerHTML=`<div data-gpanel="${prefix}">${(S.guardrailConfig||[]).map((g,i)=>guardrailRowHtml(g,i,(S.guardrailConfig||[]).length)).join('')}</div>`; wireGuardrailPanel(prefix); applyDemoAssistToHostedView() }
  host.querySelectorAll('[data-gtoggle]').forEach(el=>el.onchange=e=>{
    const g=S.guardrailConfig.find(x=>x.id===e.target.dataset.gtoggle); if(g)g.enabled=e.target.checked; rerender() })
  host.querySelectorAll('[data-gaction]').forEach(el=>el.onchange=e=>{
    const g=S.guardrailConfig.find(x=>x.id===e.target.dataset.gaction); if(g)g.action=e.target.value })
  host.querySelectorAll('[data-grunmode]').forEach(el=>el.onchange=e=>{
    const g=S.guardrailConfig.find(x=>x.id===e.target.dataset.grunmode); if(g)g.runMode=e.target.value })
  host.querySelectorAll('[data-gmsg]').forEach(el=>el.oninput=e=>{
    const g=S.guardrailConfig.find(x=>x.id===e.target.dataset.gmsg); if(g)g.message=e.target.value })
  host.querySelectorAll('[data-gup]').forEach(el=>el.onclick=()=>{
    const id=el.dataset.gup, i=S.guardrailConfig.findIndex(x=>x.id===id)
    if(i>0){ [S.guardrailConfig[i-1],S.guardrailConfig[i]]=[S.guardrailConfig[i],S.guardrailConfig[i-1]]; rerender() } })
  host.querySelectorAll('[data-gdown]').forEach(el=>el.onclick=()=>{
    const id=el.dataset.gdown, i=S.guardrailConfig.findIndex(x=>x.id===id)
    if(i>=0&&i<S.guardrailConfig.length-1){ [S.guardrailConfig[i+1],S.guardrailConfig[i]]=[S.guardrailConfig[i],S.guardrailConfig[i+1]]; rerender() } })
}
// TLP-B8 (b8-feedback #3/#4): lifecycle tracker — Exported → In development →
// Eval results available → Deployed → Registered. Renders under an export
// panel once a repo exists; "advance" buttons simulate the next real-world
// trigger (a commit landing, CI+eval finishing, a deploy, a fleet registration)
// since this demo has no live GitHub Actions/S3 wiring — each advance calls
// the server so the state is real server-side state, not client-only paint.
// F5: those advance buttons are HIDDEN unless the server ran with SHOW_SIM=1
// (see showSim()); the stepper itself always renders, read-only.
const LIFECYCLE_LABELS={exported:'Exported',in_development:'In development',eval_available:'Eval results available',deployed:'Deployed',registered:'Registered'}
const LIFECYCLE_ORDER=['exported','in_development','eval_available','deployed','registered']
async function renderLifecycle(hostId){
  const host=document.getElementById(hostId); if(!host||!S.lifecycleRepo)return
  const r=await api('/lifecycle?repo='+encodeURIComponent(S.lifecycleRepo))
  const lc=r.lifecycle
  const idx=lc?LIFECYCLE_ORDER.indexOf(lc.stage):-1
  const nextStage=LIFECYCLE_ORDER[idx+1]
  const evalEntry=(lc?.history||[]).find(h=>h.stage==='eval_available')
  host.innerHTML=`<div class="card" style="background:var(--surface2);margin-top:10px" data-lifecycle="${esc(S.lifecycleRepo)}">
    <label style="margin-top:0">Agent lifecycle</label>
    <div style="display:flex;gap:6px;flex-wrap:wrap;margin:6px 0">${LIFECYCLE_ORDER.map((s,i)=>`<span class="chip" data-lcstage="${s}" style="${i<=idx?'color:var(--ok);border-color:var(--ok-bd)':'color:var(--muted)'}">${i<=idx?'✓ ':''}${LIFECYCLE_LABELS[s]}</span>`).join('')}</div>
    <div class="d" style="font-size:.72rem;color:var(--muted)">Chat availability comes from the live runtime status in the Fleet, not from this tracker.</div>
    ${evalEntry?`<div id="lcevalbox" class="d" style="font-size:.78rem;color:var(--dim)">Gate eval against the dev-deployed agent (results read from S3; fixture in this demo): <b>${esc(JSON.stringify(evalEntry.aggregate||{}))}</b> · <code>${esc(evalEntry.s3Uri||'')}</code></div>`:''}
    ${nextStage?(showSim()?`<div class="bar" style="margin-top:8px"><button class="ghost" id="lcadvance" data-next="${nextStage}">Simulate: ${LIFECYCLE_LABELS[nextStage]} →</button></div>`:''):'<div class="d" style="font-size:.76rem;color:var(--muted);margin-top:6px">Lifecycle complete.</div>'}
  </div>`
  const btn=document.getElementById('lcadvance')
  if(btn)btn.onclick=sessionTaskHandler(async()=>{ await api('/lifecycle-advance',{repo:S.lifecycleRepo,stage:btn.dataset.next}); runSessionTask(()=>renderLifecycle(hostId)) })
}
// J-T7: spec-first journey — inception conversation with Plato (real Bedrock
// call under the server session; transcript lives on the server per session).
function vPlatoDoor(){
  return `${mainBuildNotice()}<div class="bar" style="margin-bottom:4px"><button class="ghost" id="doorback" style="font-size:.78rem;padding:5px 12px">← All journeys</button></div>
    <div class="card"><span class="roletag dom">journey · spec-first</span>
    <h3 style="margin-top:8px">${CHAT_IC}AI-assisted design</h3>
    <p class="d" style="color:var(--muted);font-size:.78rem">Discovery conversation → governed Agent → spec-first repo (CLAUDE.md, SPEC.md, TDD skeleton) with the CI gate: eval against a golden dataset, guardrail conformance, secret scan.</p>
    ${authMode()==='cognito'?`<label>Repository name</label><input id="prepo" data-demo-assist-field="repositoryName" maxlength="100" value="${esc(S.platoRepositoryName||'')}" placeholder="support-assistant"/>`:''}
    <div class="chat" id="pchat"><div class="empty"><span class="spin">⟳</span> loading conversation…</div></div>
    <label>Your message</label>
    <div class="bar"><textarea id="pmsg" data-demo-assist-field="specDiscoveryResponse" style="min-height:52px" placeholder="e.g. I want an agent that answers billing questions for our support team…"></textarea></div>
    <div class="bar"><button class="primary" id="psend">Send</button><button class="ghost" id="pgen">Generate recommendations &amp; spec →</button><button class="ghost" id="preset2">Start over</button></div>
    <div id="pcontract">${S.platoInception?vPlatoContract():''}</div></div>${authMode()==='cognito'?hostedDeliveryCard():''}`
}
// J-T8: the derived inception contract — profile, recommendations (with the
// WHY per decision), CLAUDE.md/SPEC.md/TDD previews, SPEC-preset export form.
function vPlatoContract(){
  const inc=S.platoInception, p=inc.profile, r=inc.recommendations
  const prev=S.platoPreviews||{}
  const chip=(label,c)=>`<div style="border:1px solid var(--border);border-radius:8px;padding:8px 10px"><div style="font-size:.68rem;color:var(--muted);text-transform:uppercase;letter-spacing:.06em">${label}</div><div style="font-size:.86rem;color:var(--dom);margin:2px 0">${esc(c.choice)}</div><div class="d" style="color:var(--dim);font-size:.72rem">${esc(c.why)}</div></div>`
  const pv=(name,body)=>`<details style="margin-top:6px"><summary style="cursor:pointer;font-size:.8rem;color:var(--text)"><code>${esc(name)}</code></summary><pre class="yaml" style="max-height:320px;overflow:auto;font-size:.7rem">${esc(body)}</pre></details>`
  const orgs=sortedGhOrgs((S.catalog&&S.catalog.githubOrgs)||[])
  const hosted=authMode()==='cognito'
  const agent=S.platoAgent
  const canPreview=!!agent
  const deliveryPanel=hosted
    ?`<label style="margin-top:0">${KEY_IC}Governed spec repository</label>
      <p class="d">Review the specification, inherited controls and development files. Export the repository, implement the Agent locally, then run its tests and evaluation pipeline before deployment.</p>
      <div class="bar">
        <button class="primary" id="pexp" ${canPreview?'':'disabled'}>Preview spec repository</button>
      </div>
      <div id="pes"></div>`
    :`<label style="margin-top:0">${KEY_IC}Export the spec repo — SSO GitHub org</label>
      <select id="pghorg">${orgs.map(o=>`<option value="${o.id}" ${S.ghOrg===o.id?'selected':''}>${o.label} · ${o.kind}${o.real?' (live)':' (demo)'}</option>`).join('')}</select>
      ${orgConfirmRow('p')}
      <label>Repository name</label>
      <div class="bar"><input id="pghrepo" value="${esc(p.name)}" placeholder="repo name"/></div>
      <div class="bar"><button class="primary" id="pexp">Authorize with SSO &amp; Export to GitHub</button></div>
      <div id="pes"></div>`
  return `
    <div class="sec-h" style="margin-top:18px">Inception contract — deterministic: same conversation, same spec</div>
    <div class="card" style="background:var(--surface2)">
      <label style="margin-top:0">${CLIP_IC}Profile <span class="chip type">${esc(inc.complexity.level)} · score ${inc.complexity.score}</span> <span class="chip type">risk ${esc(inc.risk.level)}</span></label>
      <div class="d" style="font-size:.8rem;color:var(--text)"><b>${esc(p.name)}</b> — ${esc(p.summary)}</div>
      <div class="d" style="font-size:.74rem;color:var(--dim);margin-top:4px">users: ${esc(p.targetUsers)} · channels: ${esc(p.channels.join(', ')||'—')} · data: ${esc(p.dataSources.join(', ')||'—')} · compliance: ${esc(p.compliance.join('; ')||'none declared')} · ${p.performsActions?'performs actions':'read-only'}</div>
      ${p.openQuestions.length?`<div class="d" style="font-size:.72rem;color:var(--muted);margin-top:4px">open questions: ${esc(p.openQuestions.join(' · '))}</div>`:''}
    </div>
    <div class="card" style="background:var(--surface2)">
      <label style="margin-top:0">${COMPASS_IC}Recommendations</label>
      <div class="grid2" style="gap:8px">${chip('Framework',r.framework)}${chip('Hosting',r.hosting)}${chip('Guardrail profile',r.guardrailProfile)}${chip('Risk class',r.riskClass)}</div>
    </div>
    <div class="card" style="background:var(--surface2)">
      <label style="margin-top:0">${PKG_IC}Spec-first repo preview <span class="chip type">SPEC preset</span></label>
      <div class="d" style="color:var(--muted);font-size:.74rem">Contract + CI gate, ${esc(String((S.platoManifest||[]).length||''))} files. TDD tests are deliberately red — the acceptance bar.</div>
      ${pv('CLAUDE.md',prev['CLAUDE.md']||'')}${pv('SPEC.md',prev['SPEC.md']||'')}${pv('tests/test_acceptance.py',prev['tests/test_acceptance.py']||'')}
      ${S.platoManifest?`<details style="margin-top:6px"><summary style="cursor:pointer;font-size:.8rem">All ${S.platoManifest.length} files</summary>${S.platoManifest.map(f=>`<div style="font-size:.72rem;padding:1px 0"><code>${esc(f.path)}</code>${f.kind==='generate'?' <span class="chip" style="text-transform:none;letter-spacing:0">generated</span>':''}</div>`).join('')}</details>`:''}
    </div>
    ${hosted?`<div class="card" style="background:var(--surface2)">
      <label style="margin-top:0">${AGENT_IC}Governed Agent</label>
      <div class="grid2">
        <div><div class="d">Agent</div><b>${esc(agent?.name||'Creating from the contract')}</b></div>
        <div><div class="d">Status</div><b>${esc(agent?.status||'PENDING')}</b></div>
        <div><div class="d">Domain</div><b>${esc(agent?.domainId||mainBuildDomainId()||'—')}</b></div>
        <div><div class="d">Project</div><b>${esc(agent?.projectId||'—')}</b></div>
      </div>
    </div>`:''}
    <div class="card" style="background:var(--surface2)">
      ${deliveryPanel}
      <div id="plifecycle"></div>
    </div>`
}
async function platoGenerate(){
  if(S.platoGenerating)return
  const box=document.getElementById('pcontract')
  if(authMode()==='cognito'&&!currentMainBuildProject()){
    box.innerHTML='<div class="status err">Choose an existing project workspace before generating the specification.</div>'
    return
  }
  S.platoGenerating=true
  box.innerHTML=`<div class="empty" style="margin-top:12px"><span class="spin">⟳</span> deriving profile from the conversation, scoring, generating the contract…</div>`
  if(authMode()==='cognito'){
    const result=await mainBuildActions.createSpecContract(S.hostedBuildJourneyDraft?.id)
    S.platoGenerating=false
    if(result?.ok!==true||!result.journey){
      box.innerHTML=`<div class="status err">${esc(apiErrorMessage(result,'Record two discovery responses before creating the contract.'))}</div>`
      return
    }
    S.hostedBuildJourneyDraft=result.journey
    S.platoInception=result.journey.inception
    S.platoPreviews={}
    S.platoManifest=[]
    const input=mainSpecAgentInput(result.journey)
    if(!input.agent.modelId||!input.agent.blueprintIds.length){
      S.mainBuildMessage={ok:false,text:'An approved model and supported Blueprint are required before the governed Agent can be created.'}
      render()
      return
    }
    const prepared=await mainBuildActions.prepareAgent(input)
    if(prepared?.ok!==true||!prepared.agent){
      S.mainBuildMessage={ok:false,text:apiErrorMessage(prepared,'The governed Agent could not be created from the specification contract.')}
      render()
      return
    }
    S.platoAgent=prepared.agent
    S.mainBuildMessage={ok:true,text:'Specification contract and governed Agent are ready.'}
    render()
    return
  }
  const r=await api('/plato-profile',{})
  S.platoGenerating=false
  if(!r.ok){ box.innerHTML=`<div class="status err">${esc(r.error||'contract generation failed')}</div>`; return }
  S.platoInception=r.inception; S.platoPreviews=r.previews; S.platoManifest=r.files
  render()
}
async function platoExport(){
  if(authMode()==='cognito'){
    const st=document.getElementById('pes')
    const journey=S.hostedBuildJourneyDraft
    const agent=S.platoAgent
    if(!journey||!agent){st.innerHTML='<div class="status err">Create the specification contract and governed Agent first.</div>';return}
    st.innerHTML=`<div class="empty"><span class="spin">⟳</span> composing immutable SPEC repository preview…</div>`
    const previewed=await mainBuildActions.previewSpec({
      domainId:agent.domainId,
      projectId:agent.projectId,
      agentId:agent.id,
    },journey.repositoryName,journey.id)
    if(previewed?.ok===true&&previewed.delivery){
      S.hostedBuildDelivery=previewed.delivery
      S.hostedBuildDeliveryResult=null
      S.mainBuildMessage={ok:true,text:'SPEC repository preview is ready. Test the Agent, then submit it to AI Registry.'}
    }else{
      S.mainBuildMessage={ok:false,text:apiErrorMessage(previewed,'The SPEC repository preview could not be created.')}
    }
    render()
    return
  }
  const st=document.getElementById('pes'), owner=document.getElementById('pghorg')?.value, repoName=(document.getElementById('pghrepo')?.value||'').trim()
  const confirmReal=!!document.getElementById('pconfirmreal')?.checked
  st.innerHTML=`<div class="empty"><span class="spin">⟳</span> staging spec contract + TDD skeleton + CI gate, creating repo…</div>`
  const r=await api('/plato-export',{owner,repoName,confirmReal})
  st.innerHTML=r.ok?`<div class="status ok">✓ ${esc(r.repo||'')} — <a href="${esc(r.url||'#')}" target="_blank" style="color:var(--ok)">${esc(r.url||'')}</a><pre style="white-space:pre-wrap;font-size:.72rem;margin-top:6px">${esc(r.output||'')}</pre></div>`
    :`<div class="status err"><pre style="white-space:pre-wrap;font-size:.72rem;margin:0">${esc(r.output||r.error||'export failed')}</pre></div>`
  if(r.ok){ S.lifecycleRepo=r.repo; await renderLifecycle('plifecycle') }
}
async function platoTest(){
  const agent=S.platoAgent
  if(!agent)return
  const tested=await mainBuildActions.testAgent({
    domainId:agent.domainId,
    projectId:agent.projectId,
    agentId:agent.id,
  },'Confirm the Agent satisfies its approved specification contract.')
  if(tested?.ok===true&&tested.agent){
    S.platoAgent=tested.agent
    S.mainBuildMessage={ok:true,text:'The governed Agent test passed and publication is now available.'}
  }else{
    S.mainBuildMessage={ok:false,text:apiErrorMessage(tested,'The governed Agent test did not complete successfully.')}
  }
  render()
}
async function platoPublish(){
  const agent=S.platoAgent
  if(!agent)return
  const published=await mainBuildActions.publishAgent({
    domainId:agent.domainId,
    projectId:agent.projectId,
    agentId:agent.id,
  })
  S.mainBuildMessage=published?.ok===true
    ?{ok:true,text:'The Agent was submitted to AI Registry. A different eligible reviewer must decide it in Approvals.'}
    :{ok:false,text:apiErrorMessage(published,'The Agent could not be submitted to AI Registry.')}
  render()
}
async function platoDeploySandbox(){
  await mainDeploySandbox(S.platoAgent,'plato')
}
async function platoSubmitProduction(){
  await mainSubmitProduction(S.platoAgent,'plato')
}
// Batch 1: real per-turn counters from the ConverseStream metadata frame —
// tokens in/out + latency chips under the assistant turn that carries them.
const platoTurnMeta = m => (m.usage||m.latencyMs)
  ? `<div class="meta" style="margin-top:4px">${m.usage?`<span class="chip" style="font-size:.64rem;color:var(--muted)">tokens ${m.usage.inputTokens??'—'} in / ${m.usage.outputTokens??'—'} out</span>`:''}${m.latencyMs?`<span class="chip" style="font-size:.64rem;color:var(--muted)">${Math.round(m.latencyMs)} ms</span>`:''}</div>`
  : ''
const platoMsgs = t => t.length
  ? t.map(m=>`<div class="msg"><div class="role">${m.role==='user'?'you':'assistant'}</div><div class="body">${md(m.text)}${platoTurnMeta(m)}</div></div>`).join('')
  : '<span style="color:var(--muted)">Start by describing what you want to build — the assistant answers with questions, not architecture.</span>'
async function loadPlatoChat(){
  const box=document.getElementById('pchat'); if(!box)return
  if(authMode()==='cognito'){
    S.platoChat=S.hostedBuildJourneyDraft?.transcript||[]
    box.innerHTML=platoMsgs(S.platoChat)
    box.scrollTop=box.scrollHeight
    return
  }
  const r=await api('/plato-chat')
  if(!r.ok){ box.innerHTML=`<div class="status err">${esc(r.error||'failed to load')}</div>`; return }
  S.platoChat=r.transcript||[]
  box.innerHTML=platoMsgs(S.platoChat)
  box.scrollTop=box.scrollHeight
}
// G15: streaming send — SSE from /api/plato-chat-stream, tokens render as
// they arrive. The typing indicator (⟳) stays up until the first chunk; if
// SSE setup fails (network, non-stream response) we fall back to the
// non-streaming POST /api/plato-chat with the same indicator.
async function platoSend(){
  if(S.platoSending)return
  const inp=document.getElementById('pmsg'), msg=(inp?.value||'').trim(); if(!msg)return
  if(authMode()==='cognito'){
    const repositoryName=(document.getElementById('prepo')?.value||S.platoRepositoryName||'').trim()
    if(!repositoryName){
      S.mainBuildMessage={ok:false,text:'Choose the repository name before starting discovery.'}
      render()
      return
    }
    S.platoRepositoryName=repositoryName
    S.platoSending=true
    let journey=S.hostedBuildJourneyDraft
    if(!journey){
      const started=await mainBuildActions.startSpec(repositoryName)
      if(started?.ok!==true||!started.journey){
        S.platoSending=false
        S.mainBuildMessage={ok:false,text:apiErrorMessage(started,'The AI-assisted discovery journey could not be started.')}
        render()
        return
      }
      journey=started.journey
    }
    const result=await mainBuildActions.addSpecMessage(journey.id,msg)
    S.platoSending=false
    if(result?.ok===true&&result.journey){
      S.hostedBuildJourneyDraft=result.journey
      S.platoChat=result.journey.transcript||[]
      S.mainBuildMessage=null
    }else{
      S.mainBuildMessage={ok:false,text:apiErrorMessage(result,'The discovery response could not be recorded.')}
    }
    render()
    return
  }
  const operationEpoch=sessionEpoch
  S.platoSending=true
  const box=document.getElementById('pchat')
  S.platoChat=S.platoChat||[]
  S.platoChat.push({role:'user',text:msg}); inp.value=''
  const paint=tail=>{ box.innerHTML=platoMsgs(S.platoChat)+(tail||''); box.scrollTop=box.scrollHeight }
  const typing=`<div class="msg"><div class="role">assistant</div><div class="body"><span class="spin">⟳</span></div></div>`
  paint(typing)
  const fail=err=>{ S.platoChat.pop(); inp.value=msg; paint(`<div class="status err">${esc(err||'The assistant is unavailable.')}</div>`); S.platoSending=false }
  let reply=null, errMsg=null, handoff=false, doneMeta=null
  const request=beginSessionRequest()
  try{
    const resp=await fetch(apiUrl('/plato-chat-stream'),{method:'POST',headers:{'content-type':'application/json',...authHeaders()},
      body:JSON.stringify({message:msg}),signal:request.controller.signal})
    if(!sessionRequestIsCurrent(request))return
    if(resp.status===401){handleUnauthorized();return}
    if(!resp.ok||!(resp.headers.get('content-type')||'').includes('text/event-stream')) throw new Error('no stream')
    const reader=resp.body.getReader(), dec=new TextDecoder(); let buf='', partial=''
    while(true){
      const {done,value}=await reader.read(); if(done)break
      if(!sessionRequestIsCurrent(request))return
      buf+=dec.decode(value,{stream:true})
      const events=buf.split('\n\n'); buf=events.pop()
      for(const ev of events){
        const et=(ev.match(/event: (\w+)/)||[])[1]
        const dm=(ev.match(/data: (.*)/s)||[])[1]
        if(!et||!dm)continue
        if(et==='chunk'){ partial+=JSON.parse(dm); paint(`<div class="msg" data-streaming="1"><div class="role">assistant</div><div class="body">${md(partial)}</div></div>`) }
        else if(et==='error'){ errMsg=JSON.parse(dm) }
        else if(et==='done'){ const d=JSON.parse(dm); reply=partial; handoff=!!d.handoff; doneMeta=d }
      }
    }
    if(errMsg) return fail(errMsg)
    if(reply===null) throw new Error('stream ended without done')
  }catch(e){
    if(e?.name==='AbortError'||!sessionRequestIsCurrent(request))return
    // SSE unavailable — non-streaming fallback keeps the door usable
    const r=await api('/plato-chat',{message:msg})
    if(!sessionEpochIsCurrent(operationEpoch))return
    if(!r.ok) return fail(r.error)
    reply=r.reply; handoff=!!r.handoff
  }finally{
    finishSessionRequest(request)
  }
  if(!sessionEpochIsCurrent(operationEpoch))return
  S.platoChat.push({role:'assistant',text:reply,
    usage:doneMeta&&doneMeta.usage||null,latencyMs:doneMeta&&doneMeta.latencyMs||null})
  paint()
  S.platoSending=false
  // G17: builder confirmed — Plato hands off; start generation immediately
  // instead of waiting for another click. Same path as the pgen button.
  if(handoff&&!S.platoInception&&!S.platoGenerating)runSessionTask(platoGenerate)
}
function currentMainBuildProject(){
  if(authMode()!=='cognito')return null
  return activeBuildProjects(S.mainBuildProjects,mainBuildDomainId()).find(project=>
    project.id===S.mainBuildProjectId)||null
}
function mainProjectAllows(type,id){
  if(authMode()!=='cognito')return true
  const project=currentMainBuildProject()
  return !!project&&projectAllowsResource(project,type,id)
}
function mainProjectCatalog(){
  return {...S.catalog,models:(S.catalog?.models||[]).filter(model=>mainProjectAllows('Model',model.id))}
}
function mainProjectBlueprints(){
  return (S.blueprints||[]).filter(blueprint=>mainProjectAllows('Blueprint',blueprint.id))
}
function mainProjectPicker(){
  if(authMode()!=='cognito')return ''
  const projects=activeBuildProjects(S.mainBuildProjects,mainBuildDomainId())
  return `<div class="card"><label for="buildproject" style="margin-top:0">Project workspace</label>
    <select id="buildproject"><option value="">Choose a project</option>${projects.map(project=>
      `<option value="${esc(project.id)}" ${S.mainBuildProjectId===project.id?'selected':''}>${esc(project.name||project.id)}</option>`).join('')}</select>
    <p class="d">Your project determines the available models, templates, tools and skills.</p>
    ${S.mainBuildProjectsError?`<div class="status err">${esc(S.mainBuildProjectsError)}</div>`:''}
    ${projects.length?'':'<p class="d">No project workspace is available. Ask your Domain Lead to create one and assign you access.</p>'}</div>`
}
function vCompose(){
  const projectBlueprints=mainProjectBlueprints()
  const runnableBlueprints=buildableBlueprints(projectBlueprints)
  const head=`<span class="roletag dom">Domain team · application plane</span><h1>Build an Agent</h1>
    <p class="subtitle">Compose an Agent construct, review evaluation options and export your development repository.</p>
    ${mainBuildNotice()}
    ${storyLine('','fleet','See it in Agent Fleet')}
    <p class="d">Owning domain: ${domChip(mainBuildDomainId()||'platform')}</p>${mainProjectPicker()}`
  if(!S.door) return head+vDoorLanding()
  if(S.door==='plato') return head+vPlatoDoor()
  if(S.door==='scratch') return head+vScratchDoor()
  let body=''
  if(S.step===1){
    const sel=runnableBlueprints.find(x=>x.id===S.bp)
    // The catalog publishes more blueprints than the console can build from:
    // only ones with a real exportable harness (source.kind=repo) are
    // deployable here. Show the rest greyed out with the reason, so the step-1
    // list matches the Blueprints page instead of silently dropping entries.
    const others=projectBlueprints.filter(b=>!runnableBlueprints.some(r=>r.id===b.id))
    body=`<span class="locktag">${LOCK_IC}platform-owned · locked</span>
      <p class="d" style="color:var(--muted);font-size:.78rem;margin-bottom:12px">Identity, memory, observability, guardrails and runtime come pre-wired.</p>
      <div class="grid2">${runnableBlueprints.map(b=>blueprintCard(b,{pick:true,sel:S.bp===b.id})).join('')}</div>
      ${runnableBlueprints.length?'':`<div class="status info">${currentMainBuildProject()?'This project has no runnable Blueprint selected.':'Choose a project with an approved runnable Blueprint.'}</div>`}
      ${others.length?`<details style="margin-top:10px"><summary style="cursor:pointer;font-size:.78rem;color:var(--muted)">${others.length} more in the catalog — no exportable harness published yet</summary>
        <p class="d" style="color:var(--muted);font-size:.74rem;margin:6px 0">These blueprints document approved framework × hosting combinations (or point at external template repos). The console can only compose-to-deploy from templates whose harness the platform publishes in this repository.</p>
        <div class="grid2" style="opacity:.55;pointer-events:none">${others.map(b=>blueprintCard(b)).join('')}</div></details>`:''}
      <div class="bar"><button class="primary" id="n1" ${sel?'':'disabled'}>Continue →</button></div>`
  } else if(S.step===2){
    const c=mainProjectCatalog()
    // The blueprint's declared defaultModel seeds the picker (user override
    // wins); the platform's Haiku fallback applies only when neither resolves.
    const bpDefaultModel=(S.blueprints.find(x=>x.id===S.bp)||{}).template?.defaultModel
    const selectedModelId=resolveBuildModelId(c.models,S.model||bpDefaultModel)
    body=`<div class="grid2"><div>
        <span class="roletag dom">your domain harness</span>
        <details class="console-config-import"><summary>Import an existing configuration</summary>${agentConfigImportHtml()}</details>
        <label>${authMode()==='cognito'?'Agent name':'Project name'}</label><input id="pname" maxlength="128" aria-required="true" data-demo-assist-field="projectName" value="${esc(S.project)}" placeholder="e.g. support-desk"/>
        <label>Persona / system prompt</label><textarea id="persona" maxlength="16384" aria-required="true" data-demo-assist-field="agentInstructions" placeholder="You are ...">${esc(S.persona)}</textarea>
        <label for="model">Project model</label>
        <select id="model" ${c.models.length?'':'disabled'}>${c.models.length?c.models.map(m=>`<option value="${esc(m.id)}" ${selectedModelId===m.id?'selected':''}>${esc(m.label||m.id)}</option>`).join(''):'<option value="">No models assigned to this project</option>'}</select>
        ${c.models.length?'':`<p class="status info">${c.modelAccessUnavailable?'Model access could not be verified. Refresh the catalog and try again.':'No registered model is currently available to this domain and project. Ask your Domain Admin to assign access, then refresh the catalog.'}</p>`}
        <details class="console-build-options"><summary>Model parameters and template settings</summary>
        <label>Model parameters</label>
        <div style="display:flex;gap:14px;flex-wrap:wrap;font-size:.82rem;align-items:center">
          <span style="display:flex;gap:6px;align-items:center">Temperature <input id="mp-temp" data-demo-assist-field="modelTemperature" type="number" min="0" max="1" step="0.1" value="${S.mpTemp??''}" placeholder="default" style="width:90px;padding:6px 10px"/></span>
          <span style="display:flex;gap:6px;align-items:center">Max output tokens <input id="mp-maxtok" data-demo-assist-field="modelMaxTokens" type="number" min="1" max="4096" step="256" value="${S.mpMaxTok??''}" placeholder="default" style="width:110px;padding:6px 10px" title="Governed builds cap output at 4096 tokens"/></span>
        </div>
        <p class="d" style="color:var(--muted);font-size:.74rem;margin-top:4px">Blank = blueprint defaults.</p>
        ${(()=>{const bp=S.blueprints.find(x=>x.id===S.bp)||{template:{}};const t=bp.template;const bo=c.blueprintOptions||{};
          const me=S.optMemory||t.memory;
          const sel=(id,cur,opts)=>`<select id="${id}" style="width:auto;padding:6px 10px">${opts.map(o=>`<option ${cur===o?'selected':''}>${o}</option>`).join('')}</select>`;
          // T15 (testplan T2): framework × hosting compatibility matrix — an
          // incompatible hosting option is unselectable, with the reason on the
          // option itself and spelled out below the selects.
          const compat=bo.compatibility||{};
          const fw=S.framework||t.framework||'Strands';
          const dt=S.deployTarget||t.deployTarget||'AgentCore Runtime';
          const fwSel=`<select id="framework" style="width:auto;padding:6px 10px">${(bo.framework||[fw]).map(o=>`<option ${fw===o?'selected':''}>${o}</option>`).join('')}</select>`;
          const dtSel=`<select id="deployTarget" style="width:auto;padding:6px 10px">${(bo.deployTarget||[dt]).map(o=>{const why=(compat[fw]||{})[o];
            return `<option ${dt===o?'selected':''} ${why?`disabled title="${esc(why)}"`:''}>${o}${why?' — incompatible':''}</option>`}).join('')}</select>`;
          const whyLines=Object.entries(compat[fw]||{}).map(([target,why])=>`<b>${esc(fw)} × ${esc(target)}</b>: ${esc(why)}`);
          // Protocol/build stay the blueprint's choice (advanced) — not per-agent
          // toggles. MCP/A2A come from adding a gateway tool.
          return `<label>Template options — prefilled from <b>${bp.name||'blueprint'}</b>${bp.version?` <span class="chip type">v${esc(bp.version)}</span>`:''}</label>
        <div style="display:flex;gap:14px;flex-wrap:wrap;font-size:.82rem;color:var(--text);align-items:center">
          <span style="display:flex;gap:6px;align-items:center">Framework: ${fwSel}</span>
          <span style="display:flex;gap:6px;align-items:center">Hosting: ${dtSel}</span>
        </div>
        ${whyLines.length?`<p class="d" id="compatnote" style="color:var(--muted);font-size:.72rem;margin-top:4px">${whyLines.join('<br>')}</p>`:''}
        <div style="display:flex;gap:14px;flex-wrap:wrap;font-size:.82rem;color:var(--text);align-items:center;margin-top:8px">
          <span style="display:flex;gap:6px;align-items:center">Memory: ${sel('opt-memory',me,bo.memory||[me])}</span>
          <label style="display:flex;gap:6px;align-items:center;margin:0"><input type="checkbox" id="opt-streaming" ${(S.optStreaming!==undefined?S.optStreaming:t.streaming)!==false?'checked':''} style="width:auto"/> Streaming</label>
          <label style="display:flex;gap:6px;align-items:center;margin:0"><input type="checkbox" id="opt-identity" ${(S.optIdentity!==undefined?S.optIdentity:t.identity)!==false?'checked':''} style="width:auto"/> Per-user identity</label>
          <label style="display:flex;gap:6px;align-items:center;margin:0"><input type="checkbox" id="opt-guardrails" ${(S.optGuardrails!==undefined?S.optGuardrails:t.guardrails)!==false?'checked':''} style="width:auto"/> Guardrails</label>
        </div>
        ${memoryPlanHtml(bp,me)}
        ${(S.optGuardrails!==undefined?S.optGuardrails:t.guardrails)!==false?guardrailPanelHtml('bp'):''}`})()}
        </details>
        <details class="console-build-options"><summary>Skills, tools and integrations</summary><p class="d">Add approved capabilities your agent needs. Leave this section empty for a model-only agent.</p>
        <div class="sec-h">Reuse platform skills <span class="chip" style="text-transform:none;letter-spacing:0">registry · APPROVED</span></div>
        ${(S.approvedSkills||[]).map(s=>`<div class="item pick ${S.skills.has(s.id)?'sel':''}" data-skill="${esc(s.id)}" style="margin-bottom:8px"><h4>${esc(s.name)} <span class="chip type">v${esc(s.version||'1.0.0')}</span></h4><div class="d">${esc(s.description)}</div></div>`).join('')||'<div class="d" style="color:var(--muted);font-size:.8rem">No APPROVED skills in the registry yet.</div>'}
        <div class="sec-h">Reuse platform tools <span class="chip" style="text-transform:none;letter-spacing:0">registry · APPROVED</span></div>
        ${(S.approvedTools||[]).map(t=>`<div class="item pick ${S.tools.has(t.id)?'sel':''}" data-tool="${esc(t.id)}" style="margin-bottom:8px"><h4>${esc(t.name)} <span class="chip type">${esc(t.type||'tool')}</span></h4><div class="d">${esc(t.description)}</div></div>`).join('')||'<div class="d" style="color:var(--muted);font-size:.8rem">No APPROVED tools in the registry yet.</div>'}
        <div class="sec-h">Built-in tools <span class="chip" style="text-transform:none;letter-spacing:0">illustrative</span></div>
        ${[['code_interpreter','Code Interpreter','Sandboxed Python execution for analysis and math'],['browser','Browser','Managed headless browser for web tasks']].map(([id,name,desc])=>`<div class="item pick ${S.builtin.has(id)?'sel':''}" data-builtin="${id}" style="margin-bottom:8px"><h4>${name} <span class="chip type">built-in</span></h4><div class="d">${desc}</div></div>`).join('')}
        <div class="sec-h">Approved MCP servers <span class="chip" style="text-transform:none;letter-spacing:0">governance-gated</span></div>
        ${(S.approvedMcp||[]).map(s=>`<div class="item pick ${S.mcp.has(s.id)?'sel':''}" data-mcpsrv="${s.id}" style="margin-bottom:8px"><h4>${PLUG_IC}${esc(s.name)} <span class="chip type">remote_mcp</span></h4><div class="d">${esc(s.description||s.url)}</div></div>`).join('')||'<div class="d" style="color:var(--muted);font-size:.8rem">No APPROVED MCP servers yet — a Platform Admin approves them under Governance.</div>'}
        <div class="sec-h">Approved A2A agents <span class="chip" style="text-transform:none;letter-spacing:0">governance-gated</span></div>
        ${(S.approvedA2a||[]).map(a=>`<div class="item pick ${S.a2a.has(a.id)?'sel':''}" data-a2apick="${a.id}" style="margin-bottom:8px"><h4>${A2A_IC}${esc(a.name)} <span class="chip type">a2a</span></h4><div class="d">${esc((a.card||{}).description||a.baseUrl)}</div></div>`).join('')||'<div class="d" style="color:var(--muted);font-size:.8rem">No APPROVED A2A agents yet — a Platform Admin approves them under Governance.</div>'}
        </details><div class="bar"><button class="ghost" id="b2">← Back</button><button class="primary" id="gen" ${c.models.length?'':'disabled'}>Generate →</button></div>
        <div id="gs"></div>
      </div><div>
        <span class="locktag">live harness preview</span>
        <!-- the global pre max-height (340px) would scroll the imported sections
             out of sight; this preview is the point of the step, so let it grow -->
        <pre class="yaml" id="prev" style="max-height:640px">${previewYaml()}</pre>
      </div></div>`
  } else {
    const orgs=sortedGhOrgs((S.catalog&&S.catalog.githubOrgs)||[])
    const hosted=authMode()==='cognito'
    const agent=S.gen?.agent
    const tested=['TESTED','SANDBOX_DEPLOYED','PRODUCTION_PENDING','PRODUCTION_APPROVED','PRODUCTION_DEPLOYED','REJECTED'].includes(agent?.status)
    const sandboxed=['SANDBOX_DEPLOYED','PRODUCTION_PENDING','PRODUCTION_APPROVED','PRODUCTION_DEPLOYED'].includes(agent?.status)
    const productionRequested=['PRODUCTION_PENDING','PRODUCTION_APPROVED','PRODUCTION_DEPLOYED'].includes(agent?.status)
    const canSandbox=agent?.status==='TESTED'
    const canProduction=['TESTED','SANDBOX_DEPLOYED'].includes(agent?.status)
    const exportPanel=hosted
      ?`<label style="margin-top:0">${KEY_IC}GitHub delivery</label>
        <p class="d" style="color:var(--muted);font-size:.74rem">Preview the exact repository files before authorizing GitHub access. You can also download the project for local development.</p>
        <label>Repository name</label>
        <div class="bar"><input id="ghrepo" data-demo-assist-field="repositoryName" value="${esc(S.gen?.repositoryName??agentRepositoryName(S.gen?.agent))}" placeholder="agent repository name"/></div>
        <p class="d">Defaults to your Agent name. You can choose a different repository name.</p>
        <div class="bar"><button class="primary" id="exp">Preview repository files</button></div>`
      :`<label style="margin-top:0">${KEY_IC}SSO — choose a GitHub organization you can access</label>
        <select id="ghorg">${orgs.map(o=>`<option value="${o.id}" ${S.ghOrg===o.id?'selected':''}>${o.label} · ${o.kind}${o.real?' (live)':' (demo)'}</option>`).join('')}</select>
        <div class="d" style="color:var(--muted);font-size:.74rem;margin-top:6px" id="ghnote">${(orgs.find(o=>o.id===(S.ghOrg||orgs[0]&&orgs[0].id))||{}).note||''}</div>
        ${orgConfirmRow('')}
        <label>Repository name</label>
        <div class="bar"><input id="ghrepo" value="${S.gen?.project||''}" placeholder="repo name"/></div>
        <div class="d" style="color:var(--muted);font-size:.74rem;margin-top:-4px">Lowercase letters, digits, <code>-</code> <code>_</code> <code>.</code> — must be unique in the org.</div>
        <div class="bar"><button class="primary" id="exp">Authorize with SSO &amp; Export to GitHub</button></div>`
    body=`<span class="roletag dom">review &amp; export</span>
      <h2>Review your Agent construct</h2>
      <p>Agent <b>${esc(agent?.name||S.gen?.project)}</b> · Project <b>${esc(agent?.projectId||S.gen?.project)}</b> · Blueprint <b>${esc(S.bp)}</b></p>
      <p class="status info">This export does not deploy or evaluate an Agent. Implement and evaluate your Domain Harness locally after export.</p>
      <div class="sec-h">1 · Foundation and Agent configuration</div>
      <p>The repository includes inherited controls, Agent code, model and resource references, and development instructions. Review the actual files before authorizing GitHub delivery.</p>
      <details><summary>Selected configuration</summary><pre>${esc(JSON.stringify({model:agent?.modelId,instructions:agent?.buildConfig?.instructions,tools:agent?.toolIds,skills:agent?.skillIds,guardrails:agent?.buildConfig?.guardrailChain},null,2))}</pre></details>
      <div class="bar"><button class="ghost" id="b3">← Edit construct</button></div>
      <div class="sec-h" style="margin-top:22px">2 · Evaluation setup</div>
      ${evaluationSetupHtml(S.gen?.evaluation||defaultEvaluation())}
      <div id="evalprev"></div>
      <div class="sec-h" style="margin-top:22px">3 · Review GitHub contents</div>
      <p>Preview the files and configuration that will be exported. After export, clone the repository and follow AGENTS.md to develop, evaluate and deliver through CI.</p>
      <div class="card" style="background:var(--surface2)">
        <label style="margin-top:0">${PKG_IC}Repository files</label>
        <div id="expprev" data-project="${esc(S.gen?.project||'')}"><div class="empty"><span class="spin">⟳</span> composing manifest…</div></div>
      </div>
      <div class="card" style="background:var(--surface2)">
        ${exportPanel}
        <div id="es"></div>
        <div id="lifetrack"></div>
      </div>${hosted?hostedDeliveryCard():''}`
  }
  return `${head}
    <div class="bar" style="margin-bottom:4px"><button class="ghost" id="doorback" style="font-size:.78rem;padding:5px 12px">← All journeys</button></div>
    ${composeSteps()}<div class="card">${body}</div>`
}
// ---------- Config-as-code: import an agent-config.yaml ----------
// The compose step's alternative to the form. A builder who already keeps the
// agent's config in git pastes or uploads the file; the SERVER parses and
// validates it (/api/agent-config-import) against the same approved models and
// guardrail vocabulary the pickers offer, and the result populates the form,
// the preview and — via the raw yaml — the generate call.
function acRow(k,v){ return `<div style="display:flex;gap:8px;font-size:.76rem;padding:1px 0"><span class="d" style="color:var(--muted);min-width:96px">${k}</span><span style="color:var(--text)">${v}</span></div>` }
function agentConfigImportHtml(){
  const c=S.acConfig
  const imported=c?`
    <div class="status ok" style="margin:0 0 8px">✓ Imported <code>${esc(S.acPath||'agent-config.yaml')}</code> — the fields below and the preview come from the file.</div>
    ${acRow('model',`<code>${esc(c.model||'(blueprint default)')}</code>`)}
    ${acRow('system_prompt',`<code>${esc(c.systemPromptFile||'—')}</code>${S.acPrompt?' <span class="chip" style="text-transform:none;letter-spacing:0">file resolved</span>':''}`)}
    ${c.rag?acRow('rag',`${esc(c.rag.datasource||'—')} · index <code>${esc(c.rag.index||'—')}</code> · top_k ${c.rag.retrieval?.topK??'—'}`):''}
    ${c.memory?acRow('memory',`${c.memory.retentionDays??'—'}d retention · ${esc(c.memory.scope||'—')}`):''}
    ${c.eval?acRow('eval',`${esc(c.eval.goldenDataset||'—')} · threshold ${c.eval.threshold!=null?Math.round(c.eval.threshold*100)+'%':'—'}`):''}
    ${acRow('guardrails',(c.effectiveGuardrails||[]).map(g=>`<span class="badge ${(c.lockedGuardrails||[]).includes(g)?'badge-orange':'badge-blue'}">${esc(g)}</span>`).join(' ')||'—')}
    <p class="d" style="color:var(--muted);font-size:.72rem;margin:6px 0 0">${LOCK_IC}amber = platform-enforced, added whether or not the file lists it.</p>
    <div class="bar"><button class="ghost" id="acclear" style="font-size:.76rem;padding:5px 12px">Clear import</button></div>`:''
  const panel=(S.acOpen||c)?`
    ${imported}
    ${c?'':`<textarea id="acyaml" placeholder="# paste agent-config.yaml" style="font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.76rem;min-height:150px">${esc(S.acYaml)}</textarea>
    <div class="bar" style="flex-wrap:wrap;gap:8px">
      <button class="primary" id="acimport" style="font-size:.78rem;padding:6px 16px">Import &amp; apply</button>
      <button class="ghost" id="acsample" style="font-size:.78rem;padding:6px 14px">Load sample</button>
      <label style="margin:0;font-size:.74rem;color:var(--muted);display:flex;align-items:center;gap:6px">or choose a file <input type="file" id="acfile" accept=".yaml,.yml" style="width:auto;font-size:.72rem;padding:2px"/></label>
    </div>
    ${S.acErr.length?`<div class="status err">${S.acErr.map(e=>esc(e)).join('<br>')}</div>`:''}`}
    ${S.acWarn.length?`<div class="status info" style="margin-top:6px">${S.acWarn.map(w=>esc(w)).join('<br>')}</div>`:''}
    <div id="acstatus"></div>`:''
  return `<div class="card" style="background:var(--surface2);margin-bottom:16px">
    <label style="margin-top:0;display:flex;align-items:center;gap:8px;justify-content:space-between">
      <span>${BOOK_IC}Import <code>agent-config.yaml</code> <span class="chip" style="text-transform:none;letter-spacing:0">config-as-code</span></span>
      ${c?'':`<button class="ghost" id="actoggle" style="font-size:.74rem;padding:4px 12px">${S.acOpen?'Use the form instead':'Import a file →'}</button>`}
    </label>
    <p class="d" style="color:var(--muted);font-size:.74rem;margin:0">Already keep this agent's config in your repo? Import it instead of filling the form. Same checks either way: models must be APPROVED in the registry, guardrail ids must be real, and the platform baseline stays locked.</p>
    ${panel}
  </div>`
}
async function acImport(){
  const ta=document.getElementById('acyaml')
  const yaml=ta?ta.value:S.acYaml
  S.acYaml=yaml
  const box=document.getElementById('acstatus')
  if(box)box.innerHTML='<div class="status info"><span class="spin">⟳</span> parsing agent-config.yaml…</div>'
  const r=await api('/agent-config-import',{yaml})
  S.acErr=r.errors||(r.error?[r.error]:[]); S.acWarn=r.warnings||[]
  if(!r.ok||!r.config){ S.acConfig=null; render(); return }
  const c=r.config
  S.acConfig=c; S.acPrompt=r.promptFile||null; S.acWarn=r.warnings||[]
  // Populate the wizard from the file — the form fields are the same fields.
  S.project=c.name
  // The picker may offer the model under a gateway routing id while the file
  // names the runtime id (or vice versa); match either.
  const m=((S.catalog||{}).models||[]).find(x=>x.id===c.model||x.runtimeModelId===c.model)
  if(m)S.model=m.id
  // system_prompt is a file reference. When it resolves, its content becomes the
  // persona — so the prompt that ships in the export is the file from the repo,
  // not something retyped into a console box.
  if(r.promptFile)S.persona=r.promptFile.content.trim()
  render()
}
// One-line gist of the persona for the preview. A sectioned instruction file
// system_prompt file) starts with a markdown heading, which says nothing — skip
// headings and show the first real line.
function personaSummary(){
  const lines=(S.persona||'').split('\n').map(l=>l.trim()).filter(Boolean)
  return lines.find(l=>!l.startsWith('#'))||lines[0]||'<your prompt>'
}
function previewYaml(){
  const b=S.blueprints.find(x=>x.id===S.bp)||{foundation:{},template:{}}
  const f=b.foundation, t=b.template||{}
  const sk=[...S.skills]; const tl=[...S.tools]
  const fw=S.framework||t.framework||'Strands', dt=S.deployTarget||t.deployTarget||'AgentCore Runtime'
  const pr=S.protocol||t.protocol||'HTTP', me=S.optMemory||t.memory||'none'
  const st=(S.optStreaming!==undefined?S.optStreaming:t.streaming)!==false
  return `<span class="dom-line">name:</span> ${S.project||'<project>'}
<span class="lock-line"># Foundation Harness — platform-owned, locked</span>
<span class="lock-line">identity:      ${f.identity||''}</span>
<span class="lock-line">observability: ${f.observability||''}</span>
<span class="lock-line">guardrails:    ${f.guardrails||''}</span>
<span class="dom-line"># Template — blueprint + your config</span>
<span class="dom-line">framework:    ${fw}</span>
<span class="dom-line">deployTarget: ${dt}</span>
<span class="dom-line">protocol:     ${pr}</span>
<span class="dom-line">streaming:    ${st}</span>
<span class="dom-line">memory:       ${me}</span>
<span class="dom-line"># Domain Harness — you compose this</span>
<span class="dom-line">model:   ${S.model||'(blueprint default)'}</span>
<span class="dom-line">params:  ${[S.mpTemp!==''?'temperature: '+S.mpTemp:null,S.mpMaxTok!==''?'max_tokens: '+S.mpMaxTok:null].filter(Boolean).join(' · ')||'(defaults)'}</span>
<span class="dom-line">persona: ${personaSummary().slice(0,60)}</span>
<span class="dom-line">skills:  [${sk.join(', ')||'—'}]</span>
<span class="dom-line">tools:   [${tl.join(', ')||'—'}]</span>
<span class="dom-line">builtin: [${[...S.builtin].join(', ')||'—'}]</span>
<span class="dom-line">mcp:     [${[...S.mcp].join(', ')||'—'}]</span>
<span class="dom-line">a2a:     [${[...S.a2a].join(', ')||'—'}]</span>${acPreviewYaml()}`
}
// The imported file's own sections, appended to the live preview in the SAME two
// colors the rest of it uses: green = domain config (yours, from the file), amber
// = platform-owned and locked. The locked guardrails render amber inside the
// imported block precisely because the file cannot switch them off.
function acPreviewYaml(){
  const c=S.acConfig
  if(!c) return ''
  const pad=s=>String(s)
  const lines=[`<span class="dom-line"># Imported — agent-config.yaml (your repo, config-as-code)</span>`]
  if(c.systemPromptFile) lines.push(`<span class="dom-line">system_prompt: ${esc(c.systemPromptFile)}</span>`)
  if(c.rag) lines.push(
    `<span class="dom-line">rag:</span>`,
    `<span class="dom-line">  datasource: ${esc(pad(c.rag.datasource||'—'))}</span>`,
    `<span class="dom-line">  index:      ${esc(pad(c.rag.index||'—'))}</span>`,
    `<span class="dom-line">  top_k:      ${c.rag.retrieval?.topK??'—'}${c.rag.retrieval?.rerank?' (rerank)':''}</span>`)
  if(c.memory) lines.push(
    `<span class="dom-line">memory:</span>`,
    `<span class="dom-line">  retention_days: ${c.memory.retentionDays??'—'}</span>`,
    `<span class="dom-line">  scope:          ${esc(pad(c.memory.scope||'—'))}</span>`)
  if(c.eval) lines.push(
    `<span class="dom-line">eval:</span>`,
    `<span class="dom-line">  golden_dataset: ${esc(pad(c.eval.goldenDataset||'—'))}</span>`,
    `<span class="dom-line">  threshold:      ${c.eval.threshold??'—'}</span>`)
  lines.push(`<span class="dom-line">guardrails:    [${(c.guardrails||[]).join(', ')||'—'}]</span>`)
  if((c.lockedGuardrails||[]).length) lines.push(
    `<span class="lock-line"># platform-enforced — merged in, not removable by the file</span>`,
    `<span class="lock-line">guardrails+:   [${c.lockedGuardrails.join(', ')}]</span>`)
  return '\n'+lines.join('\n')
}

// F3 — Eval gate preview (wizard step 3, BEFORE the export button). The golden
// scenarios, the threshold and the judge all come from the composed manifest's
// own bytes (evalGate on /api/export-manifest), so this card cannot drift from
// what the repo receives. The three stages at the bottom are one runner —
// gates/run-eval.mjs — invoked locally, by eval.yml on every PR, and by
// promote.yml before a staging/prod redeploy.
const EVAL_STAGES=[
  ['local dev','node gates/run-eval.mjs','before you open the PR'],
  ['every PR','.github/workflows/eval.yml','required check — blocks merge'],
  ['promote','.github/workflows/promote.yml','re-scored before staging/prod'],
]
function evalGateCardHtml(g){
  if(!g) return ''
  const pct=g.threshold!=null?Math.round(g.threshold*100):null
  const scen=g.scenarios||[]
  const sc=s=>`<div style="display:flex;gap:10px;align-items:baseline;font-size:.74rem;padding:2px 0;border-top:1px solid var(--border)">
    <code style="min-width:132px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--accent)">${esc(s.id)}</code>
    <span style="flex:1;color:var(--dim)">“${esc(String(s.input||'').slice(0,84))}”</span>
    <span class="chip" style="white-space:nowrap">${pluralize(s.checks,'check')}</span>
  </div>`
  return `<div class="card" style="background:var(--surface2)">
    <label style="margin-top:0">${ic2(ICONS.shield)}Eval gate <span class="chip type">golden dataset</span>${g.seeded?' <span class="chip" style="text-transform:none;letter-spacing:0">seeded by the platform</span>':' <span class="chip" style="color:var(--ok);border-color:var(--ok-bd)">your dataset</span>'}</label>
    <div style="display:flex;gap:14px;align-items:center;flex-wrap:wrap;margin-bottom:6px">
      ${pct!=null?`<span style="display:flex;align-items:baseline;gap:6px"><b style="font-size:1.5rem;color:var(--accent);line-height:1">${pct}%</b><span class="d" style="font-size:.74rem;color:var(--muted)">pass threshold — below this, merge is blocked</span></span>`:''}
      <span class="chip">${pluralize(scen.length,'scenario')}</span>
      ${g.judgeModel?`<span class="chip" style="text-transform:none;letter-spacing:0">judge: ${esc(String(g.judgeModel).split('.').pop())}</span>`:''}
    </div>
    ${scen.length?scen.map(sc).join(''):'<div class="d" style="color:var(--muted);font-size:.74rem">No scenarios in the dataset yet.</div>'}
    <div class="d" style="color:var(--muted);font-size:.72rem;margin-top:6px">Shipped as <code>${esc(g.dataset)}</code>. Add scenarios in your repo; the threshold is the org floor and can only go up.</div>
    <div style="display:flex;gap:6px;align-items:stretch;flex-wrap:wrap;margin-top:10px">
      ${EVAL_STAGES.map(([when,where,why],i)=>`${i?'<span style="align-self:center;color:var(--border2)">→</span>':''}
      <div style="flex:1;min-width:150px;border:1px solid var(--accent-bd);border-radius:8px;background:var(--accent-bg);padding:7px 9px">
        <div style="font-size:.74rem;font-weight:600;color:var(--accent)">${esc(when)}</div>
        <code style="font-size:.68rem;color:var(--dim);word-break:break-all">${esc(where)}</code>
        <div class="d" style="font-size:.68rem;color:var(--muted);margin-top:2px">${esc(why)}</div>
      </div>`).join('')}
    </div>
    <div class="d" style="color:var(--dim);font-size:.72rem;margin-top:6px"><b>One runner, three moments</b> — the same <code>gates/run-eval.mjs</code> and the same <code>gates/platform-gates.json</code> threshold at every stage, so a green local run means the PR gate agrees.</div>
  </div>`
}

// Export manifest preview (wizard step 3): what the FULL preset packages —
// grouped so the gate files read as one unit. Server-computed, read-only.
async function loadExportManifest(){
  const box=document.getElementById('expprev'); if(!box)return
  const project=box.dataset.project; if(!project)return
  const ev=document.getElementById('evalprev')
  if(authMode()==='cognito'){
    const manifest=S.hostedBuildDelivery?.preset==='FULL'
      ?S.hostedBuildDelivery.manifest
      :null
    if(!manifest){
      box.innerHTML='<div class="status info">Create a repository preview below to inspect the exact files before GitHub authorization.</div>'
      if(ev)ev.innerHTML=''
      return
    }
    if(!Array.isArray(manifest.entries)){
      box.innerHTML=`<div class="status info">${Number(manifest.fileCount)||'Repository'} files exported. Open the GitHub repository below to inspect the delivered contents.</div>`
      if(ev)ev.innerHTML='<p>Evaluation assets were exported. Business evaluation has not run.</p>'
      return
    }
    const files=manifest.entries
    const isGate=path=>path.startsWith('.github/workflows/')||path.startsWith('gates/')||path.startsWith('evaluation/')||path==='agentcore/datasets/golden.jsonl'
    const gate=files.filter(file=>isGate(file.path))
    const row=file=>`<details><summary><code>${esc(file.path)}</code></summary><pre style="max-height:400px;overflow:auto">${esc(file.content??"Content unavailable")}</pre></details>`
    if(ev)ev.innerHTML=`<div class="status ok">${gate.length} CI and evaluation files are included in the immutable manifest.</div>`
    box.innerHTML=`
      <div class="d" style="color:var(--dim);font-size:.78rem;margin-bottom:6px"><b>${files.length}</b> files · fingerprint <code>${esc(manifest.fingerprint||'')}</code></div>
      <details class="console-build-options"><summary>Browse ${files.length} repository files</summary><div class="console-manifest-files">${files.map(row).join('')}</div></details>`
    return
  }
  let evaluation
  try{evaluation=validateEvaluation(S.gen?.evaluation||defaultEvaluation())}catch(error){box.textContent=error.message;return}
  const r=await api('/export-manifest',{project,preset:'FULL',evaluation})
  if(!r.ok){
    box.innerHTML=`<div class="status err">${esc(r.error||'manifest failed')}</div>`
    if(ev) ev.innerHTML=`<div class="status err">${esc(r.error||'gate contract unreadable')}</div>`
    return
  }
  if(ev) ev.innerHTML='<p>Business evaluation has not run. Review the generated dataset, evaluator and workflow below.</p>'
  const files=r.files||[]
  const isGate=p=>p.startsWith('.github/workflows/')||p.startsWith('gates/')||p==='agentcore/datasets/golden.jsonl'
  const gate=files.filter(f=>isGate(f.path))
  const row=f=>`<details><summary><code>${esc(f.path)}</code></summary><pre>${esc(f.content??"")}</pre></details>`
  box.innerHTML=`
    <div class="d" style="color:var(--dim);font-size:.78rem;margin-bottom:6px"><b>${files.length}</b> files — your agent code + CLAUDE.md, plus the CI gate below.</div>
    <div style="border:1px solid var(--border);border-radius:8px;padding:8px 10px;margin-bottom:4px">
      <div style="font-size:.72rem;color:var(--dom);text-transform:uppercase;letter-spacing:.06em;margin-bottom:4px">${ic2(ICONS.shield)}CI gate — runs on every PR (${pluralize(gate.length,'file')})</div>
      ${files.map(row).join('')}
    </div>
    <div class="d" style="color:var(--muted);font-size:.72rem">eval blocks merge below threshold · tests must pass · compliance = gate intact + secret scan. Rules in <code>gates/README.md</code>.</div>`
}

// Streaming chat with a deployed fleet agent (SSE from /api/invoke-stream).
async function fleetSend(){
  if(S.fleetSending)return                 // guard: ignore double-fire (Enter + click)
  const inp=document.getElementById('fmsg'), msg=(inp?.value||'').trim(); if(!msg)return
  const operationEpoch=sessionEpoch
  S.fleetSending=true
  S.fleetChat.push({role:'you',text:msg}); inp.value=''
  const chat=document.getElementById('fchat')
  const renderChat=()=>{
    chat.innerHTML=S.fleetChat.map((m,i)=>`<div class="msg"><div class="role">${m.role}</div><div class="body">${chatBody(m)}</div>${chatFeedbackHtml(m,i)}</div>`).join('')
    wireFeedbackButtons(chat)
  }
  renderChat()
  const agentMsg={role:'agent',text:''}; S.fleetChat.push(agentMsg)
  renderChat(); const pending=chat.querySelector('.msg:last-child .body'); if(pending) pending.innerHTML=`<span class="spin">⟳</span>`
  await streamInvoke({project:S.fleetAgent.project, prompt:msg, sessionKey:'fleetSession', agentMsg, render:renderChat})
  if(!sessionEpochIsCurrent(operationEpoch))return
  if(!agentMsg.text){agentMsg.text='(no response)';renderChat()}
  else renderChat()   // re-render to show feedback buttons on completed reply
  S.fleetSending=false
}

// Wire up thumbs buttons and comment inputs inside the fleet chat panel.
function wireFeedbackButtons(chat){
  if(!chat)return
  chat.querySelectorAll('.fb-up,.fb-dn').forEach(btn=>{
    btn.onclick=async()=>{
      const idx=Number(btn.dataset.fbidx)
      const m=S.fleetChat[idx]; if(!m||m.feedbackSubmitted)return
      const row=chat.querySelector(`.chat-fb[data-fbidx="${idx}"]`)
      const comment=(row?.querySelector(`.fb-comment[data-fbidx="${idx}"]`)?.value||'').trim()||undefined
      m.feedbackComment=comment||null
      const rating=btn.classList.contains('fb-up')?'up':'down'
      try{
        await api('/fleet-feedback',{project:S.fleetAgent.project,sessionId:S.fleetSession,turnIndex:idx,rating,comment})
      }catch(e){ /* local state still updates */ }
      m.feedbackSubmitted={rating,comment:comment||null}
      // replace feedback row inline without full re-render — re-query: the
      // pre-await node may have been detached by a re-render during the POST
      const live=chat.querySelector(`.chat-fb[data-fbidx="${idx}"]`)||row
      if(live&&live.isConnected) live.outerHTML=`<div class="chat-fb-done" data-fbidx="${idx}" style="font-size:.72rem;color:var(--muted);margin-top:4px">✓ feedback recorded</div>`
    }
  })
}

// Shared SSE streaming: forwards `as` (the signed-in demo user) so the agent
// greets the real tester, and appends chunks token-by-token as they arrive.
async function streamInvoke({project, prompt, sessionKey, agentMsg, render}){
  // Failures render as a visible error row and stop the spinner — never swallow
  // (independent review finding: server-side invoke errors left the panel spinning/blank).
  const fail=msg=>{ agentMsg.err=true; agentMsg.text=String(msg||'invoke failed'); render() }
  const request=beginSessionRequest()
  try{
    const resp=await fetch(apiUrl('/invoke-stream'),{method:'POST',headers:{'content-type':'application/json',...authHeaders()},
      body:JSON.stringify({project,prompt,sessionId:S[sessionKey]}),signal:request.controller.signal})
    if(!sessionRequestIsCurrent(request))return
    if(resp.status===401){handleUnauthorized();return}
    if(!(resp.headers.get('content-type')||'').includes('text/event-stream')){
      const j=await resp.json().catch(()=>null)
      if(!sessionRequestIsCurrent(request))return
      return fail((j&&(j.error||j.output))||`invoke failed (HTTP ${resp.status})`)
    }
    const reader=resp.body.getReader(), dec=new TextDecoder(); let buf=''
    while(true){
      const {done,value}=await reader.read(); if(done)break
      if(!sessionRequestIsCurrent(request))return
      buf+=dec.decode(value,{stream:true})
      const events=buf.split('\n\n'); buf=events.pop()
      for(const ev of events){
        const et=(ev.match(/event: (\w+)/)||[])[1]
        const dm=(ev.match(/data: (.*)/s)||[])[1]
        if(!et||!dm)continue
        if(et==='session'){ try{S[sessionKey]=JSON.parse(dm)}catch{} }
        else if(et==='chunk'){ try{agentMsg.text+=JSON.parse(dm)}catch{}; render() }
        else if(et==='error'){ let m=dm; try{m=JSON.parse(dm)}catch{}; return fail(m) }
      }
    }
  }catch(e){
    if(e?.name==='AbortError'||!sessionRequestIsCurrent(request))return
    fail(String(e))
  }finally{
    finishSessionRequest(request)
  }
}

// ---------- render + wire ----------
async function renderSession(){
  disposeDomains?.(); disposeDomains=null
  disposeLanding?.(); disposeLanding=null
  if(cognitoBootstrapError||SESSION?.profileType==='authenticated-unscoped'){renderOrdinaryBootstrap();return}
  if(!SESSION){ vLogin(); return }
  // Retire the hidden workspace tab as well as its standalone page routes.
  if(S.wsTab==='obs')S.wsTab='fleet'
  const renderEpoch=sessionEpoch
  try{
    await ensure()
  }catch(error){
    // Registry owns its inventory/error state. A failed shared catalog preload
    // must not prevent its loader from clearing an old successful inventory.
    if(error===CANCELED_REQUEST||authMode()!=='cognito'||S.view!=='registry')throw error
    S.registryEntries=[]
  }
  if(!sessionEpochIsCurrent(renderEpoch))return
  if(!SESSION){ vLogin(); return }   // session invalidated mid-fetch (stale token)
  // The project chooser retains the full authorized sidebar.
  if(S.view==='myprojects'&&allowedViews().includes('myprojects')){
    renderTopbar()
    sidebar()
    const m=document.getElementById('main')
    m.innerHTML=vMyProjects(); runSessionTask(loadMyProjects)
    syncUrl()
    return
  }
  renderTopbar()
  sidebar()
  if(!allowedViews().includes(S.view)){
    // Legacy jump targets that fold into Governance tabs where the shell has it.
    if(S.view==='audit'&&allowedViews().includes('governance')){ S.view='governance'; S.govTab='audit' }
    else if(S.view==='requests'&&allowedViews().includes('governance')){ S.view='governance'; S.govTab='requests' }
    // TLP-B7: the standalone Platform Approvals view folded into Governance
    else if(S.view==='approvals'&&SHELL()==='admin'){ S.view='governance'; S.govTab='exemptions' }
    // TLP-B2 shells: anything unroutable lands on the persona's shell home —
    // there is no shared Overview fallback for scoped roles.
    else S.view=mainHomeView()
    sidebar()
  }
  // a bare 'projects' navigation (no project selected) has no roster page —
  // send it to the shell's project surface instead of a dead drill-down
  if(S.view==='projects'&&!S.projectDetail){ S.view=SHELL()==='lead'?'domainconsole':mainHomeView(); if(SHELL()==='lead')S.dcTab='projects'; sidebar() }
  // builder/lead 'fleet' is only the agent drill-down — a bare fleet lands on
  // the shell's own fleet surface (workspace Fleet tab / Domain Console).
  if(S.view==='fleet'&&!S.fleetAgent&&SHELL()==='builder'){ S.view='workspace'; S.wsTab='fleet'; sidebar() }
  if(S.view==='fleet'&&!S.fleetAgent&&SHELL()==='lead'){ S.view='domainconsole'; sidebar() }
  syncUrl()
  const m=document.getElementById('main')
  if(S.view==='overview'){ m.innerHTML=vOverview(); const qs=document.getElementById('ovquickstart'); if(qs)qs.onclick=()=>{S.view='fleet';render()}; if(S.who==='user')runSessionTask(loadOverviewRecs) }
  else if(S.view==='approvedagents'){m.innerHTML=vApprovedAgents();runSessionTask(loadApprovedAgents)}
  else if(S.view==='registry'){ m.innerHTML=vRegistry(); wireRegistry(); await loadRegistry() }
  else if(S.view==='blueprints'){ m.innerHTML=vBlueprints(); wireBlueprintSubmit()
    // Remember which harness panel is open across re-renders (one at a time).
    m.querySelectorAll('[data-bpdetail]').forEach(d=>d.addEventListener('toggle',()=>{S.bpOpen=d.open?d.dataset.bpdetail:(S.bpOpen===d.dataset.bpdetail?null:S.bpOpen)})) }
  else if(S.view==='governance'){ m.innerHTML=vGovernance(); wireGovernance(); runSessionTask(loadGovernance) }
  else if(S.view==='cost'){ m.innerHTML=vCost(); runSessionTask(loadCost) }
  else if(S.view==='domains'){
    if(authMode()==='cognito'&&SHELL()==='admin'){
      m.innerHTML='<div id="domain-bootstrap-root"></div>'
      disposeDomains=mountDomains(document.getElementById('domain-bootstrap-root'),{
        request:rawApi,actor:SESSION?.actor||SESSION?.user,
        registerDirtyGuard:guard=>{domainBootstrapDirty=guard},
        onRegistry:()=>{if(confirmContextChange()){S.view='registry';render()}},
      })
    }else{
      m.innerHTML=vDomains()
      if(S.domainDetail){
        document.getElementById('domback').onclick=()=>{S.domainDetail=null;render()}
        runSessionTask(loadDomainDetail)
      } else { runSessionTask(loadDomainRoster); wireDomains() }
    }
  }
  else if(S.view==='projects'){
    // IA restructure: only the project drill-down lives here — the roster is a
    // section on the domain detail page. Back returns to the owning domain.
    m.innerHTML=vProjects()
    document.getElementById('projback').onclick=()=>{S.projectDetail=null;S.view='domains';render()}
    runSessionTask(loadProjectDetail)
  }
  else if(S.view==='audit'){ m.innerHTML=vAudit(); wireAudit(); runSessionTask(loadAudit) }
  else if(S.view==='fleet'){
    m.innerHTML=await vFleet()
    if(authMode()==='cognito'&&S.who==='user')runSessionTask(loadApprovedAgents)
    else if(S.fleetAgent){runSessionTask(loadDetail);runSessionTask(loadAgentLifecycle)}
    else runSessionTask(loadFleet)
  }
  else if(S.view==='workspace'){ m.innerHTML=vWorkspace(); runSessionTask(loadWorkspace) }
  else if(S.view==='domainconsole'){ m.innerHTML=vDomainConsole(); runSessionTask(loadDomainConsole) }
  else if(S.view==='platformconsole'){ m.innerHTML=vPlatformConsole(); runSessionTask(loadPlatformConsole) }
  else if(S.view==='monitoring'){
    // B14: aggregate-only route — no trace loader is ever wired here.
    m.innerHTML=await vMonitoring()
    if(authMode()==='cognito'){
      runSessionTask(loadHostedOperations)
      if(document.getElementById('alertpolicies'))runSessionTask(loadGovAlerts)
    }
    else {
      wireObsTabs()
      if(S.obsTab==='alerts'){ runSessionTask(loadAlertsTab); wireGovAlerts(); runSessionTask(loadGovAlerts) }
      else { wireObs(); runSessionTask(loadObs); runSessionTask(loadOnlineEval); runSessionTask(loadAccessGrantMeta) }
    }
  }
  else if(S.view==='observability'){
    m.innerHTML=await vObservability()
    runSessionTask(loadWorkspace)
  }
  else if(S.view==='compose'){
    if(authMode()==='cognito'){
      const projects=await readHostedCollection('projects')
      S.mainBuildProjects=projects?.ok===true?activeBuildProjects(projects.items):[]
      S.mainBuildProjectsError=projects?.ok===true?'':apiErrorMessage(projects,'Project workspaces could not be loaded.')
      if(!currentMainBuildProject()){
        if(S.mainBuildProjectId&&projects?.ok===true){
          S.mainBuildMessage={ok:false,text:'The selected project is no longer active or available. Choose an active project workspace to continue.'}
        }
        S.mainBuildProjectId=''
        S.bp=null;S.model='';S.step=1
        S.gen=null;S.hostedBuildDelivery=null;S.hostedBuildDeliveryResult=null
      }
      if(S.bp&&!mainProjectAllows('Blueprint',S.bp)){S.bp=null;S.step=1}
      if(S.model&&!mainProjectAllows('Model',S.model))S.model=''
    }
    if(S.door==='blueprint'&&S.step===2){
      // Governance gate: the wizard only ever offers APPROVED entries, resolved
      // from the unified AI Registry (T20 — single source, not the legacy stores).
      const wp=await api('/wizard-picks')
      S.approvedSkills=(wp.skills||[]).filter(resource=>mainProjectAllows('Skill',resource.id))
      S.approvedTools=(wp.tools||[]).filter(resource=>mainProjectAllows('Skill',resource.id))
      S.approvedMcp=(wp.mcpServers||[]).filter(resource=>mainProjectAllows('MCPServer',resource.id))
      S.approvedA2a=wp.a2aAgents||[]
      // prune picks that lost approval since they were selected
      S.skills=new Set([...S.skills].filter(id=>S.approvedSkills.some(s=>s.id===id)))
      S.tools=new Set([...S.tools].filter(id=>S.approvedTools.some(t=>t.id===id)))
      S.mcp=new Set([...S.mcp].filter(id=>S.approvedMcp.some(s=>s.id===id)))
      S.a2a=new Set([...S.a2a].filter(id=>S.approvedA2a.some(a=>a.id===id)))
    }
    m.innerHTML=vCompose()
  }
  wire()
  if(pendingNavFocus){
    document.querySelector(`[data-shellnav="${pendingNavFocus}"]`)?.focus({preventScroll:true})
    pendingNavFocus=null
  }
  runSessionTask(wireGoldenEval)   // no-op unless a golden-eval card is on the page
  runSessionTask(loadExportManifest)   // no-op unless the export preview box is on the page
}
function render(){return runSessionTask(renderSession)}
function wire(){
  const b=id=>document.getElementById(id)
  if(b('buildproject'))b('buildproject').onchange=e=>{
    if(!confirmContextChange()){e.target.value=S.mainBuildProjectId||'';return}
    S.mainBuildProjectId=e.target.value;S.bp=null;S.model='';S.step=1;S.gen=null
    S.platoAgent=null;S.platoInception=null;S.platoPreviews={};S.platoManifest=[]
    S.hostedBuildDelivery=null
    S.skills=new Set();S.tools=new Set();S.mcp=new Set()
    businessForms.clear('compose');composeDirty.clear('compose')
    render()
  }
  document.querySelectorAll('.storynext').forEach(e=>e.onclick=()=>{if(!confirmContextChange())return;clearBusinessDrafts();S.wiz=null;S.view=e.dataset.goview;render()})
  // Fleet agent detail + streaming chat
  if(b('fleetback'))b('fleetback').onclick=()=>{S.fleetAgent=null;render()}
  if(b('fsend'))b('fsend').onclick=()=>runSessionTask(fleetSend)
  document.querySelectorAll('[data-door]').forEach(e=>e.onclick=()=>{S.door=e.dataset.door;if(S.door==='blueprint')S.step=S.step||1;render()})
  if(b('doorback'))b('doorback').onclick=()=>{if(!confirmContextChange())return;businessForms.clear('compose');composeDirty.clear('compose');S.door=null;render()}
  wireBuilderBlueprintSubmit()   // no-op unless the door landing's contribute card is on the page
  // Plato inception chat (spec-first door)
  if(b('psend'))b('psend').onclick=()=>runSessionTask(platoSend)
  if(b('pmsg'))b('pmsg').onkeydown=e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();runSessionTask(platoSend)}}
  if(b('preset2'))b('preset2').onclick=()=>runSessionTask(async()=>{
    if(authMode()!=='cognito')await api('/plato-reset',{})
    S.platoChat=[]
    S.platoInception=S.platoPreviews=S.platoManifest=null
    S.platoRepositoryName=''
    S.platoAgent=null
    S.hostedBuildJourneyDraft=null
    S.hostedBuildDelivery=null
    S.hostedBuildDeliveryResult=null
    S.mainBuildMessage=null
    render()
  })
  if(b('pchat'))runSessionTask(loadPlatoChat)
  if(b('pgen'))b('pgen').onclick=()=>runSessionTask(platoGenerate)
  if(b('pexp'))b('pexp').onclick=()=>runSessionTask(platoExport)
  if(b('ptest'))b('ptest').onclick=()=>runSessionTask(platoTest)
  if(b('ppublish'))b('ppublish').onclick=()=>runSessionTask(platoPublish)
  if(b('psandbox'))b('psandbox').onclick=()=>runSessionTask(platoDeploySandbox)
  if(b('pproduction'))b('pproduction').onclick=()=>runSessionTask(platoSubmitProduction)
  if(b('pghorg')){b('pghorg').addEventListener('change',()=>toggleConfirmReal('p'));toggleConfirmReal('p')}
  // contract survives tab navigation server-side; re-fetch if client state lost it
  if(authMode()!=='cognito'&&b('pcontract')&&!S.platoInception)runSessionTask(async()=>{const r=await api('/plato-profile');if(r.ok&&r.inception){S.platoInception=r.inception;S.platoPreviews=r.previews;S.platoManifest=r.files;render()}})
  // From-scratch door (J-T10, now "Foundation start" per TLP-B8): live manifest
  // preview, debounced while typing; the shared guardrails panel + foundation
  // option toggles.
  if(b('scname')){b('scname').oninput=()=>{clearSessionTimeout(scratchPrevTimer);scratchPrevTimer=sessionTimeout(loadScratchManifest,350)};runSessionTask(loadScratchManifest)}
  if(b('scexp'))b('scexp').onclick=()=>runSessionTask(scratchExport)
  if(b('scghorg')){b('scghorg').addEventListener('change',()=>toggleConfirmReal('sc'));toggleConfirmReal('sc')}
  if(document.querySelector('[data-gpanel="sc"]'))runSessionTask(()=>loadGuardrailPanel('sc'))
  if(document.querySelector('[data-gpanel="bp"]'))runSessionTask(()=>loadGuardrailPanel('bp'))
  ;['fo-ci','fo-gov','fo-obs','fo-eval'].forEach(id=>{ if(b(id))b(id).onchange=e=>{
    S.foundationOpts=S.foundationOpts||{}
    S.foundationOpts[{'fo-ci':'ci','fo-gov':'governance','fo-obs':'observability','fo-eval':'evalFoundation'}[id]]=e.target.checked } })
  document.querySelectorAll('[data-bp]').forEach(e=>e.onclick=()=>{S.bp=e.dataset.bp;
    // reset option overrides so Step 2 re-prefills from the newly chosen blueprint
    S.framework=S.deployTarget=S.protocol=S.optMemory=undefined;S.optStreaming=S.optIdentity=S.optGuardrails=undefined;render()})
  document.querySelectorAll('[data-skill]').forEach(e=>e.onclick=()=>{const k=e.dataset.skill;S.skills.has(k)?S.skills.delete(k):S.skills.add(k);b('prev').innerHTML=previewYaml();e.classList.toggle('sel')})
  document.querySelectorAll('[data-tool]').forEach(e=>e.onclick=()=>{const k=e.dataset.tool;S.tools.has(k)?S.tools.delete(k):S.tools.add(k);b('prev').innerHTML=previewYaml();e.classList.toggle('sel')})
  document.querySelectorAll('[data-builtin]').forEach(e=>e.onclick=()=>{const k=e.dataset.builtin;S.builtin.has(k)?S.builtin.delete(k):S.builtin.add(k);b('prev').innerHTML=previewYaml();e.classList.toggle('sel')})
  document.querySelectorAll('[data-mcpsrv]').forEach(e=>e.onclick=()=>{const k=e.dataset.mcpsrv;S.mcp.has(k)?S.mcp.delete(k):S.mcp.add(k);b('prev').innerHTML=previewYaml();e.classList.toggle('sel')})
  document.querySelectorAll('[data-a2apick]').forEach(e=>e.onclick=()=>{const k=e.dataset.a2apick;S.a2a.has(k)?S.a2a.delete(k):S.a2a.add(k);b('prev').innerHTML=previewYaml();e.classList.toggle('sel')})
  if(b('n1'))b('n1').onclick=()=>{composeDirty.setBaseline('compose',composeDraft());S.step=2;render()}
  if(b('b2'))b('b2').onclick=()=>{S.step=1;render()}
  if(b('b3'))b('b3').onclick=()=>{S.step=2;render()}
  if(b('pname'))b('pname').oninput=e=>{S.project=e.target.value;b('prev').innerHTML=previewYaml()}
  if(b('persona'))b('persona').oninput=e=>{S.persona=e.target.value;b('prev').innerHTML=previewYaml()}
  if(b('model')){
    S.model=resolveBuildModelId(mainProjectCatalog().models,S.model)
    b('model').onchange=e=>{S.model=e.target.value;b('prev').innerHTML=previewYaml()}
  }
  if(b('mp-temp'))b('mp-temp').oninput=e=>{S.mpTemp=e.target.value;b('prev').innerHTML=previewYaml()}
  if(b('mp-maxtok'))b('mp-maxtok').oninput=e=>{S.mpMaxTok=e.target.value;b('prev').innerHTML=previewYaml()}
  // T15 (T2): framework change re-renders so the hosting select's disabled
  // options track the compatibility matrix; an invalid hosting pick resets.
  if(b('framework'))b('framework').onchange=e=>{S.framework=e.target.value;
    const bo=(S.catalog||{}).blueprintOptions||{}
    const compat=bo.compatibility||{}
    const bp=S.blueprints.find(x=>x.id===S.bp)||{template:{}}
    const dt=S.deployTarget||bp.template.deployTarget||'AgentCore Runtime'
    if((compat[S.framework]||{})[dt])S.deployTarget=(bo.deployTarget||[]).find(o=>!(compat[S.framework]||{})[o])
    render()}
  if(b('deployTarget'))b('deployTarget').onchange=e=>{S.deployTarget=e.target.value;b('prev').innerHTML=previewYaml()}
  if(b('protocol'))b('protocol').onchange=e=>{S.protocol=e.target.value;b('prev').innerHTML=previewYaml()}
  if(b('opt-streaming'))b('opt-streaming').onchange=e=>{S.optStreaming=e.target.checked;b('prev').innerHTML=previewYaml()}
  if(b('opt-identity'))b('opt-identity').onchange=e=>{S.optIdentity=e.target.checked;b('prev').innerHTML=previewYaml()}
  if(b('opt-guardrails'))b('opt-guardrails').onchange=e=>{S.optGuardrails=e.target.checked;render()}
  if(b('opt-memory'))b('opt-memory').onchange=e=>{S.optMemory=e.target.value;b('prev').innerHTML=previewYaml()}
  if(b('actoggle'))b('actoggle').onclick=()=>{S.acOpen=!S.acOpen;S.acErr=[];S.acWarn=[];render()}
  if(b('acclear'))b('acclear').onclick=()=>{S.acConfig=null;S.acYaml='';S.acWarn=[];S.acErr=[];S.acPrompt=null;S.acPath='';S.acOpen=true;render()}
  if(b('acyaml'))b('acyaml').oninput=e=>{S.acYaml=e.target.value}
  if(b('acsample'))b('acsample').onclick=sessionTaskHandler(async()=>{
    const r=await api('/agent-config-sample')
    if(!r.ok){b('acstatus').innerHTML=`<div class="status err">${esc(r.error||'could not load the sample')}</div>`;return}
    S.acYaml=r.yaml;S.acPath=r.path;render()
  })
  if(b('acfile'))b('acfile').onchange=sessionTaskHandler(async e=>{
    const f=e.target.files&&e.target.files[0]; if(!f)return
    S.acYaml=await f.text();S.acPath=f.name;await acImport()
  })
  if(b('acimport'))b('acimport').onclick=()=>runSessionTask(acImport)
  if(b('gen'))b('gen').onclick=()=>runSessionTask(async()=>{
    b('gs').innerHTML='<div class="status info"><span class="spin">⟳</span> composing project…</div>'
    if(authMode()==='cognito'){
      if(!currentMainBuildProject()){
        b('gs').innerHTML='<div class="status err">Choose an existing project workspace.</div>'
        return
      }
      // Field checks before any mutation — the server enforces the same limits
      // but replies with a generic INVALID_REQUEST, and by then the project
      // may already have been created. Say which field is wrong, here.
      const maxTok=S.mpMaxTok===''||S.mpMaxTok==null?null:Number(S.mpMaxTok)
      if(maxTok!==null&&(!Number.isSafeInteger(maxTok)||maxTok<1||maxTok>4096)){
        b('gs').innerHTML='<div class="status err">Max output tokens must be a whole number between 1 and 4096 (governed build limit).</div>'
        return
      }
      const temp=S.mpTemp===''||S.mpTemp==null?null:Number(S.mpTemp)
      if(temp!==null&&(!Number.isFinite(temp)||temp<0||temp>1)){
        b('gs').innerHTML='<div class="status err">Temperature must be between 0 and 1.</div>'
        return
      }
      const input=mainBuildAgentInput()
      if(!input.agent.modelId||!input.agent.blueprintIds.length){
        b('gs').innerHTML='<div class="status err">Choose an approved model and Blueprint.</div>'
        return
      }
      const prepared=await mainBuildActions.prepareAgent(input)
      if(prepared?.ok!==true||!prepared.agent){
        b('gs').innerHTML=`<div class="status err">${esc(apiErrorMessage(prepared,'The governed Agent could not be prepared.'))}</div>`
        return
      }
      businessForms.clear('compose');composeDirty.clear('compose')
      S.gen={
        project:input.project.id,
        agent:prepared.agent,
        ref:{
          domainId:prepared.agent.domainId,
          projectId:prepared.agent.projectId,
          agentId:prepared.agent.id,
        },
      }
      S.mainBuildMessage={ok:true,text:'Agent construct generated. Review evaluation options and repository files before export.'}
      S.step=3
      render()
      return
    }
    const r=await api('/generate',{blueprint:S.bp,projectName:S.project,persona:S.persona,model:S.model,skillIds:[...S.skills],toolIds:[...S.tools],mcpIds:[...S.mcp],a2aIds:[...S.a2a],builtinTools:[...S.builtin],modelParams:{temperature:S.mpTemp,maxTokens:S.mpMaxTok},framework:S.framework,deployTarget:S.deployTarget,
      // the raw file, not S.acConfig — the server re-parses and re-validates it
      ...(S.acYaml&&S.acConfig?{agentConfigYaml:S.acYaml}:{})})
    if(r.error){b('gs').innerHTML=`<div class="status err">${r.error}</div>`;return}
    businessForms.clear('compose');composeDirty.clear('compose')
    S.gen=r;S.step=3;render()
  })
  if(b('val'))b('val').onclick=()=>runSessionTask(async()=>{
    b('val').disabled=true
    b('ds').innerHTML='<div class="status info"><span class="spin">⟳</span> validating…</div>'
    if(authMode()==='cognito'){
      S.buildTestPrompt=b('build-test-prompt')?.value.trim()||''
      if(!S.buildTestPrompt){b('ds').textContent='Enter a test prompt.';b('val').disabled=false;return}
      const tested=await mainBuildActions.testAgent(
        S.gen.ref,
        S.buildTestPrompt,
      )
      if(tested?.ok===true&&tested.agent){
        S.gen.agent=tested.agent
        S.mainBuildMessage={ok:true,text:'The Agent test passed. Registry submission and repository preview are available.'}
      }else{
        S.gen.agent={...S.gen.agent,status:'TEST_FAILED',lastTestOutput:null,lastTestStatus:'FAILED'}
        S.mainBuildMessage={ok:false,text:apiErrorMessage(tested,'The Agent test did not complete successfully.')}
      }
      render()
      return
    }
    const r=await api('/validate',{project:S.gen.project})
    b('val').disabled=false
    b('ds').innerHTML=`<div class="status ${r.ok?'ok':'err'}">${r.ok?'✓ ':'✗ '}${esc(r.output)}</div>`
  })
  if(b('pub'))b('pub').onclick=()=>runSessionTask(async()=>{
    const published=await mainBuildActions.publishAgent(S.gen.ref)
    S.mainBuildMessage=published?.ok===true
      ?{ok:true,text:'The Agent was submitted to AI Registry. A different eligible reviewer must decide it in Approvals.'}
      :{ok:false,text:apiErrorMessage(published,'The Agent could not be submitted to AI Registry.')}
    render()
  })
  if(b('sandbox'))b('sandbox').onclick=()=>runSessionTask(()=>
    mainDeploySandbox(S.gen?.agent,'blueprint'))
  if(b('production'))b('production').onclick=()=>runSessionTask(()=>
    mainSubmitProduction(S.gen?.agent,'blueprint'))
  if(b('dep'))b('dep').onclick=()=>runSessionTask(async()=>{
    b('ds').innerHTML='<div class="status info"><span class="spin">⟳</span> deploying to AgentCore (provisions runtime + memory + identity, ~3–5 min)…</div>'
    const r=await api('/deploy',{project:S.gen.project})
    b('ds').innerHTML=`<div class="status ${r.ok?'ok':'err'}">${r.ok?'✓ deployed':'✗ failed'}${r.runtime?' · '+esc(r.runtime):''}<pre style="margin-top:8px">${esc((r.output||'').slice(-500))}</pre></div>`
    if(r.ok)b('ip').value=S.gen.project
  })
  if(b('ghorg'))b('ghorg').onchange=e=>{S.ghOrg=e.target.value;const o=((S.catalog||{}).githubOrgs||[]).find(x=>x.id===S.ghOrg);if(b('ghnote'))b('ghnote').textContent=o?o.note:'';toggleConfirmReal('')}
  if(b('confirmwrap'))toggleConfirmReal('')
  if(b('exp'))b('exp').onclick=()=>runSessionTask(async()=>{
    const owner=(b('ghorg')&&b('ghorg').value)||S.ghOrg
    const repoName=(b('ghrepo')&&b('ghrepo').value.trim())||(authMode()==='cognito'?agentRepositoryName(S.gen?.agent):S.gen.project)
    const confirmReal=!!b('confirmreal')?.checked
    if(authMode()==='cognito'){
      b('es').innerHTML='<div class="status info"><span class="spin">⟳</span> composing immutable runnable repository preview…</div>'
      let evaluation
      try{evaluation=validateEvaluation(S.gen.evaluation||defaultEvaluation())}catch(error){b('es').innerHTML=`<div class="status err">${esc(error.message)}</div>`;return}
      const previewRef=S.gen.ref
      const previewed=await mainBuildActions.previewFull(previewRef,repoName,evaluation)
      if(S.gen?.ref!==previewRef)return
      try{if(JSON.stringify(evaluation)!==JSON.stringify(validateEvaluation(S.gen.evaluation||defaultEvaluation())))return}catch{return}
      if(previewed?.ok===true&&previewed.delivery){
        S.hostedBuildDelivery=previewed.delivery
        S.hostedBuildDeliveryResult=null
        S.mainBuildMessage={ok:true,text:'Repository preview is ready. Review the files, then export to GitHub.'}
      }else{
        S.mainBuildMessage={ok:false,text:apiErrorMessage(previewed,'The runnable repository preview could not be created.')}
      }
      render()
      return
    }
    b('es').innerHTML='<div class="status info"><span class="spin">⟳</span> SSO sign-in to '+owner+'… creating '+owner+'/'+repoName+' (foundation code + CLAUDE.md + CI gate)…</div>'
    const r=await api('/export',{project:S.gen.project,owner,repoName,confirmReal,evaluation:validateEvaluation(S.gen.evaluation||defaultEvaluation())})
    const label=r.mock?'✓ repo created (SSO demo org)':(r.ok?'✓ repo created':'✗ export failed')
    b('es').innerHTML=`<div class="status ${r.ok?'ok':'err'}">${label}${r.url?` — <a href="${esc(r.url)}" target="_blank">${esc(r.repo)}</a>`:''}<pre style="margin-top:8px">${esc((r.output||'').slice(-500))}</pre></div>`
    if(r.ok){ S.lifecycleRepo=r.repo; await renderLifecycle('lifetrack') }
  })
  if(S.gen&&!S.gen.evaluation)S.gen.evaluation=defaultEvaluation()
  wireEvaluationSetup({document,get:()=>S.gen?.evaluation,set:value=>{S.gen.evaluation=value;S.hostedBuildDelivery=null;S.hostedBuildDeliveryResult=null;document.querySelector('[data-delivery-card]')?.remove();loadExportManifest()},render})
  if(b('ghrepo')&&authMode()==='cognito')b('ghrepo').oninput=e=>{
    S.gen.repositoryName=e.target.value
    S.hostedBuildDelivery=null;S.hostedBuildDeliveryResult=null
    document.querySelector('[data-delivery-card]')?.remove()
    loadExportManifest()
  }
  wireHostedDeliveryApproval()
  applyDemoAssistToHostedView()
}
if(authMode()==='cognito'){
  renderCognitoHydration()
  await hydrateCognitoSession()
}
// ---------- Deep links ----------
// The console is otherwise a pure client-state SPA (S.view). The AI Registry is
// the one page people send each other links to ("approve this pack"), so it gets
// a real URL: /registry maps onto S.view on load and on Back/Forward, and
// syncUrl() (called at the end of render) keeps the address bar honest. The
// server serves the same document for /registry, so a cold load works.
const URL_VIEWS = { '/registry':'registry' }
let navigationUrl = new URL(location.href)
function viewForPath(){ return URL_VIEWS[location.pathname] || null }
function syncUrl(){
  const want = Object.keys(URL_VIEWS).find(p=>URL_VIEWS[p]===S.view) || '/'
  if(location.pathname!==want){
    history.pushState({view:S.view}, '', want)
    navigationUrl = new URL(location.href)
  }
}
addEventListener('popstate',()=>{
  const previous = navigationUrl
  navigationUrl = new URL(location.href)
  // Native anchor navigation also emits popstate. Keep the mounted public
  // landing (and native focus/scroll), but still render real route transitions.
  if(!SESSION && disposeLanding && previous.pathname===navigationUrl.pathname
    && previous.search===navigationUrl.search && previous.hash!==navigationUrl.hash)return
  if(!confirmContextChange()){syncUrl();return}
  clearBusinessDrafts();S.wiz=null
  S.view = viewForPath() || (SESSION?SHELL_HOME[SHELL()]:'overview'); render()
})
addEventListener('beforeunload',event=>{if(hasUnsavedContextChanges()){event.preventDefault();event.returnValue=''}})
const bootView = viewForPath()
if(bootView) S.view = bootView
render()
