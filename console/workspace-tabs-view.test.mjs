import assert from 'node:assert/strict'
import test from 'node:test'
import {
  fleetEmptyHtml,
  agentStatusLabel,
  memoryKbTabHtml,
  costTabHeadingHtml,
  obsProjectUnavailableHtml,
} from './public/workspace-tabs-view.mjs'

// ---------------------------------------------------------------------------
// fleetEmptyHtml
// ---------------------------------------------------------------------------

test('fleetEmptyHtml includes project name escaped', () => {
  const html = fleetEmptyHtml('Case Assist <&>')
  assert.match(html, /Case Assist &lt;&amp;&gt;/)
  assert.match(html, /Build Agent \+/)
  assert.match(html, /data-fleet-empty/)
  assert.match(html, /id="wsnewagent2"/)
})

test('fleetEmptyHtml does not include empty or undefined project name', () => {
  const html = fleetEmptyHtml('')
  assert.doesNotMatch(html, /undefined/)
})

// ---------------------------------------------------------------------------
// agentStatusLabel
// ---------------------------------------------------------------------------

test('agentStatusLabel returns human-readable labels for all known statuses', () => {
  assert.equal(agentStatusLabel('DRAFT'), 'Draft')
  assert.equal(agentStatusLabel('READY_FOR_TEST'), 'Ready for test')
  assert.equal(agentStatusLabel('TEST_FAILED'), 'Test failed')
  assert.equal(agentStatusLabel('TESTED'), 'Tested')
  assert.equal(agentStatusLabel('SANDBOX_DEPLOYED'), 'Sandbox deployed')
  assert.equal(agentStatusLabel('PRODUCTION_PENDING'), 'Pending production approval')
  assert.equal(agentStatusLabel('PRODUCTION_APPROVED'), 'Production approved')
  assert.equal(agentStatusLabel('PRODUCTION_DEPLOYED'), 'Production deployed')
  assert.equal(agentStatusLabel('REJECTED'), 'Rejected')
  assert.equal(agentStatusLabel('RETIRED'), 'Retired')
})

test('agentStatusLabel escapes and returns unknown values safely', () => {
  const label = agentStatusLabel('<UNKNOWN>')
  assert.doesNotMatch(label, /<UNKNOWN>/)
  assert.match(label, /&lt;UNKNOWN&gt;/)
})

test('agentStatusLabel returns Unknown for null/undefined', () => {
  assert.equal(agentStatusLabel(null), 'Unknown')
  assert.equal(agentStatusLabel(undefined), 'Unknown')
})

// ---------------------------------------------------------------------------
// memoryKbTabHtml — no agents
// ---------------------------------------------------------------------------

test('memoryKbTabHtml with no agents shows no-agent empty states', () => {
  const html = memoryKbTabHtml([], 'FAQ Bot')
  assert.match(html, /data-memorykb-section="memory"/)
  assert.match(html, /data-memorykb-section="kb"/)
  assert.match(html, /data-mem-empty/)
  assert.match(html, /data-kb-empty/)
  assert.doesNotMatch(html, /data-mem-table/)
  assert.doesNotMatch(html, /data-kb-table/)
})

// ---------------------------------------------------------------------------
// memoryKbTabHtml — agents with no memory/KB config
// ---------------------------------------------------------------------------

test('memoryKbTabHtml with agents but no memory/KB config shows configure prompt', () => {
  const agents = [
    { id: 'a1', name: 'Triage Agent', status: 'DRAFT', memoryIds: [], knowledgeBaseIds: [] },
    { id: 'a2', name: 'Report Bot', status: 'PRODUCTION_DEPLOYED', memoryIds: [], knowledgeBaseIds: [] },
  ]
  const html = memoryKbTabHtml(agents, 'Incident Triage')
  assert.match(html, /data-mem-empty/)
  assert.match(html, /data-kb-empty/)
  assert.match(html, /Incident Triage/)
  assert.doesNotMatch(html, /data-mem-table/)
  assert.doesNotMatch(html, /data-kb-table/)
})

// ---------------------------------------------------------------------------
// memoryKbTabHtml — agents with memory IDs configured
// ---------------------------------------------------------------------------

test('memoryKbTabHtml with memory IDs shows table and IDs', () => {
  const agents = [
    {
      id: 'a1', name: 'Case Agent', status: 'PRODUCTION_DEPLOYED',
      memoryIds: ['mem-001', 'mem-002'], knowledgeBaseIds: [],
    },
    {
      id: 'a2', name: 'Support Bot', status: 'DRAFT',
      memoryIds: [], knowledgeBaseIds: [],
    },
  ]
  const html = memoryKbTabHtml(agents, 'Case Assist')
  assert.match(html, /data-mem-table/)
  assert.match(html, /mem-001/)
  assert.match(html, /mem-002/)
  assert.match(html, /Case Agent/)
  assert.match(html, /Production deployed/)
  assert.doesNotMatch(html, /Support Bot/)  // a2 has no memoryIds, not in table
  assert.match(html, /data-kb-empty/)  // no KB IDs
  // Never shows store content/names from unknown APIs
  assert.doesNotMatch(html, /0 events/)
  assert.doesNotMatch(html, /kb$/)
})

// ---------------------------------------------------------------------------
// memoryKbTabHtml — agents with KB IDs configured
// ---------------------------------------------------------------------------

test('memoryKbTabHtml with KB IDs shows KB table and IDs', () => {
  const agents = [
    {
      id: 'b1', name: 'FAQ Agent', status: 'TESTED',
      memoryIds: [], knowledgeBaseIds: ['kb-faq-v1'],
    },
  ]
  const html = memoryKbTabHtml(agents, 'FAQ Bot')
  assert.match(html, /data-kb-table/)
  assert.match(html, /kb-faq-v1/)
  assert.match(html, /FAQ Agent/)
  assert.match(html, /Tested/)
  assert.match(html, /data-mem-empty/)
})

// ---------------------------------------------------------------------------
// memoryKbTabHtml — XSS safety
// ---------------------------------------------------------------------------

test('memoryKbTabHtml escapes dangerous strings in agent names and IDs', () => {
  const agents = [
    {
      id: 'a<b>', name: '<script>alert(1)</script>', status: 'DRAFT',
      memoryIds: ['<mem-id>'], knowledgeBaseIds: [],
    },
  ]
  const html = memoryKbTabHtml(agents, '<Project>')
  assert.doesNotMatch(html, /<script>/)
  assert.match(html, /&lt;script&gt;/)
  assert.match(html, /&lt;Project&gt;/)
  assert.match(html, /&lt;mem-id&gt;/)
})

// ---------------------------------------------------------------------------
// memoryKbTabHtml — de-duplicate IDs across agents
// ---------------------------------------------------------------------------

test('memoryKbTabHtml counts unique IDs across agents', () => {
  const agents = [
    { id: 'a1', name: 'A', status: 'DRAFT', memoryIds: ['shared'], knowledgeBaseIds: [] },
    { id: 'a2', name: 'B', status: 'DRAFT', memoryIds: ['shared', 'extra'], knowledgeBaseIds: [] },
  ]
  const html = memoryKbTabHtml(agents, 'My Project')
  // 2 unique IDs (shared + extra), 2 agents with memory
  assert.match(html, /2 configured store ID/)
  assert.match(html, /2 agent/)
})

// ---------------------------------------------------------------------------
// costTabHeadingHtml
// ---------------------------------------------------------------------------

test('costTabHeadingHtml includes project name prominently', () => {
  const html = costTabHeadingHtml('Case Assist', 'customer_support', 'case-assist')
  assert.match(html, /Project cost · Case Assist/)
  assert.match(html, /customer_support/)
  assert.match(html, /case-assist/)
  assert.match(html, /data-cost-project-heading/)
})

test('costTabHeadingHtml escapes HTML in project name and ids', () => {
  const html = costTabHeadingHtml('<Evil>', '<domain>', '<proj>')
  assert.doesNotMatch(html, /<Evil>/)
  assert.match(html, /&lt;Evil&gt;/)
})

test('costTabHeadingHtml does not contain platform framing', () => {
  const html = costTabHeadingHtml('Platform Foundation', 'platform', 'platform-foundation')
  assert.doesNotMatch(html, /Platform Cost/)
  assert.doesNotMatch(html, /Consolidated platform/)
  assert.doesNotMatch(html, /Domain Lead/)
})

// ---------------------------------------------------------------------------
// obsProjectUnavailableHtml
// ---------------------------------------------------------------------------

test('obsProjectUnavailableHtml with no agents explains empty state', () => {
  const html = obsProjectUnavailableHtml(
    'operations', 'incident-triage', 'Incident Triage', [], '24h')
  assert.match(html, /data-obs-unavailable/)
  assert.match(html, /Incident Triage/)
  assert.match(html, /operations/)
  assert.match(html, /incident-triage/)
  assert.match(html, /24h/)
  assert.match(html, /No agents are deployed/)
  assert.doesNotMatch(html, /data-obs-agent/)
})

test('obsProjectUnavailableHtml with agents lists them', () => {
  const agents = [
    { id: 'agent-1', name: 'Triage Bot', status: 'SANDBOX_DEPLOYED' },
    { id: 'agent-2', name: 'Router', status: 'DRAFT' },
  ]
  const html = obsProjectUnavailableHtml(
    'operations', 'incident-triage', 'Incident Triage', agents, '7d')
  assert.match(html, /Triage Bot/)
  assert.match(html, /Router/)
  assert.match(html, /Sandbox deployed/)
  assert.match(html, /Draft/)
  assert.match(html, /data-obs-agent="agent-1"/)
  assert.match(html, /data-obs-agent="agent-2"/)
  assert.match(html, /2 agent/)
})

test('obsProjectUnavailableHtml escapes project name and agent names', () => {
  const agents = [{ id: 'a1', name: '<script>', status: 'DRAFT' }]
  const html = obsProjectUnavailableHtml('d', 'p', '<Evil Project>', agents, '24h')
  assert.doesNotMatch(html, /<script>/)
  assert.doesNotMatch(html, /<Evil Project>/)
  assert.match(html, /&lt;Evil Project&gt;/)
  assert.match(html, /&lt;script&gt;/)
})

test('obsProjectUnavailableHtml uses singular grammar for 1 agent', () => {
  const agents = [{ id: 'a1', name: 'Only Agent', status: 'PRODUCTION_DEPLOYED' }]
  const html = obsProjectUnavailableHtml('d', 'p', 'P', agents, '24h')
  assert.match(html, /1 agent in this project:/)
  assert.doesNotMatch(html, /1 agents/)
})
