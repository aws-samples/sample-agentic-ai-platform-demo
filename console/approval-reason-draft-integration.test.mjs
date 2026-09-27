import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const source = readFileSync(fileURLToPath(new URL('./public/modules/app.mjs', import.meta.url)), 'utf8')

test('app.mjs installs the shared approval reason draft store', () => {
  assert.match(source, /from "\.\.\/approval-reason-drafts\.mjs"/)
  assert.match(source, /const approvalReasonDrafts=createApprovalReasonDrafts\(\)/)
  assert.match(source, /function approvalReasonScope\(\)/)
})

test('wireHostedApprovalActions restores drafts and drops only the decided row on success', () => {
  const body = source.slice(source.indexOf('function wireHostedApprovalActions'), source.indexOf('function validHostedGatewayCatalog'))
  assert.match(body, /wireApprovalReasonInputs\(reasonDrafts,box,\{actor,domain\}\)/, 'drafts rewired after every approvals render')
  assert.match(body, /reasonDrafts\?\.discard\(\{actor,domain:expected.domainId,approvalId:expected\.id\}\)/, 'successful decision discards exactly that row draft')
  const success = body.indexOf('result?.ok===true')
  assert.ok(success >= 0 && success < body.indexOf('reasonDrafts?.discard({actor,domain:expected.domainId,approvalId:expected.id})'), 'row draft discarded on the success path only')
  assert.ok(body.indexOf('reasonDrafts?.discard({actor,domain:expected.domainId,approvalId:expected.id})') < body.indexOf('await retire()', success), 'row draft discarded before the retire reload rerenders')
})

test('reason drafts guard context changes and are discarded with other business drafts on confirm', () => {
  assert.match(source, /function hasUnsavedContextChanges\(\)\{\n  return domainBootstrapDirty\(\)\|\|projectBudgetDirty\(\)\|\|businessForms\.isDirty\(\)[\s\S]*?approvalReasonDrafts\.isDirty\(approvalReasonScope\(\)\)/, 'domain and approval drafts count as unsaved context changes')
  assert.match(source, /function clearBusinessDrafts\(\)\{\n\s*businessForms\.clear\(\);wizardDirty\.clear\('wizard'\);composeDirty\.clear\('compose'\);projectBudgetDirty=\(\)=>false;approvalReasonDrafts\.discard\(approvalReasonScope\(\)\)/, 'confirmed navigation discards only the active actor+domain drafts')
})

test('Type/Status/Domain filters cancel-keep and confirm-discard reason drafts', () => {
  const body = source.slice(source.indexOf('function wireRequests'), source.indexOf('// ---------- Audit trail'))
  assert.match(body, /confirmApprovalReasonDiscard\(\)/, 'filter change is gated by the reason-draft confirm')
  assert.match(body, /el\.value=S\[key\]\|\|''/, 'cancel restores the previous filter value and keeps drafts')
  assert.match(source, /function confirmApprovalReasonDiscard\(\)\{\n  if\(!approvalReasonDrafts\.isDirty\(approvalReasonScope\(\)\)\)return true\n  if\(!confirm\(/, 'no prompt when there is no draft')
  assert.match(source, /approvalReasonDrafts\.discard\(approvalReasonScope\(\)\)\n  return true\n\}/, 'confirm discards the active scope drafts')
})
