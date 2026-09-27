// TLP-B11 smoke: fixes from the builder-journey gap batch.
// 1. tests gate fail-closed (no tests -> FAIL) unless allowNoTests: true
// 2. FULL export ships app/*/tests/{test_identity,test_memory_local,test_multiturn}.py
// 3. FULL export ships gates/record-transcripts.mjs + deploy-dev.yml + promote.yml
// 4. baseline eval: local `agentcore dev` fallback path exists (source-level check;
//    the live local-runtime path is exercised manually in the B11 report, not here,
//    since it needs a running `agentcore dev` process this suite doesn't manage)
import fs from 'node:fs'
import path from 'node:path'
import { execSync } from 'node:child_process'
import { apiLogin, authedPost } from './login.mjs'

let failures = 0
const check = (name, ok) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`); if (!ok) failures++ }

const here = path.dirname(new URL(import.meta.url).pathname)
const repoRoot = path.join(here, '..')

// ---- 1) test gate fail-closed / explicit exemption (pure unit test, no export) ----
const tmpDir = fs.mkdtempSync('/tmp/b11-gate-')
fs.mkdirSync(path.join(tmpDir, 'gates'), { recursive: true })
fs.copyFileSync(path.join(repoRoot, 'console/ci-templates/gates/run-tests.mjs'), path.join(tmpDir, 'gates/run-tests.mjs'))

fs.writeFileSync(path.join(tmpDir, 'gates/platform-gates.json'), JSON.stringify({ threshold: 0.8 }))
let failedClosed = false
try { execSync('node gates/run-tests.mjs', { cwd: tmpDir, stdio: 'pipe' }) }
catch (e) { failedClosed = e.status === 1 }
check('run-tests.mjs fails closed with zero tests and no exemption', failedClosed)

fs.writeFileSync(path.join(tmpDir, 'gates/platform-gates.json'), JSON.stringify({ threshold: 0.8, allowNoTests: true }))
let exemptOk = false
try { execSync('node gates/run-tests.mjs', { cwd: tmpDir, stdio: 'pipe' }); exemptOk = true }
catch { exemptOk = false }
check('run-tests.mjs passes with explicit allowNoTests: true exemption', exemptOk)
fs.rmSync(tmpDir, { recursive: true, force: true })

// ---- 2/3) FULL export manifest ships the new files ----
const alice = await apiLogin('alice')
const PROJECT = 'b11smoke' + Date.now().toString().slice(-6)
const gen = await authedPost('/generate', {
  blueprint: 'chat-assistant', projectName: PROJECT, persona: 'B11 smoke export agent',
}, alice)
check('project generated for export-manifest check', !gen.error)

const exp = await authedPost('/export', {
  project: PROJECT, owner: 'acme-platform', repoName: PROJECT, preset: 'FULL',
}, alice)
check('FULL export to mock org acme-platform succeeds', exp.ok === true && exp.mock === true)

const stagedRoot = path.join(repoRoot, '.export-staging', PROJECT)
const expectFile = p => check(`export contains ${p}`, fs.existsSync(path.join(stagedRoot, p)))
expectFile('app/chat_agent/tests/test_identity.py')
expectFile('app/chat_agent/tests/test_memory_local.py')
expectFile('app/chat_agent/tests/test_multiturn.py')
expectFile('gates/record-transcripts.mjs')
expectFile('.github/workflows/deploy-dev.yml')
expectFile('.github/workflows/promote.yml')

// gates/platform-gates.json protects record-transcripts.mjs too
const pg = JSON.parse(fs.readFileSync(path.join(stagedRoot, 'gates/platform-gates.json'), 'utf8'))
check('platform-gates.json protects gates/record-transcripts.mjs', (pg.protectedFiles || []).includes('gates/record-transcripts.mjs'))

// ---- 4) baseline eval local fallback: source-level check the fallback path exists ----
const serverSrc = fs.readFileSync(path.join(repoRoot, 'console/server.mjs'), 'utf8')
check('server.mjs has isLocalDevRuntimeUp fallback helper', serverSrc.includes('async function isLocalDevRuntimeUp'))
check('server.mjs has runGoldenEvalLocal fallback path', serverSrc.includes('async function runGoldenEvalLocal'))
check('runGoldenEval branches to local fallback when undeployed', serverSrc.includes('return runGoldenEvalLocal(run, dir, rows)'))
// Melanie follow-up: judge availability is a credentials question, not an
// environment one — local-dev eval runs the Bedrock judge when creds exist.
check('local-dev eval detects AWS creds for judge capability', serverSrc.includes('hasAwsCredsForJudge'))
check('local-dev eval scores assertions with a Bedrock judge when creds exist', serverSrc.includes('judgeAssertionsLocal') && serverSrc.includes('bedrock-runtime'))
check('local-dev run records which judge mode actually ran', serverSrc.includes('run.judge = hasAwsCredsForJudge()'))
const uiSrc = fs.readFileSync(path.join(repoRoot, 'console/public/index.html'), 'utf8')
check('eval card chip differentiates judge-backed vs deterministic-only local runs', uiSrc.includes("run.judge==='bedrock'") && uiSrc.includes('LLM judge skipped (no AWS credentials)'))

// ---- 5) B11 follow-ups (#11/#13/#14/#15/#16): provenance, actual-state compliance,
// multi-turn execution, exit-0 mitigation, no undeclared egress ----
const rtSrc = fs.readFileSync(path.join(repoRoot, 'console/ci-templates/gates/record-transcripts.mjs'), 'utf8')
check('#11 record-transcripts writes a provenance .meta.json sidecar', rtSrc.includes('.meta.json') && rtSrc.includes('recordedAt'))
check('#15 record-transcripts replays every turn in one session', rtSrc.includes('X-Amzn-Bedrock-AgentCore-Runtime-Session-Id') && rtSrc.includes('for (const turn of turns)'))
check('#15 transcript holds only agent replies (turn markers, no user echo)', rtSrc.includes('--- turn ') && !rtSrc.includes('user:'))
const reSrc = fs.readFileSync(path.join(repoRoot, 'console/ci-templates/gates/run-eval.mjs'), 'utf8')
check('#11 run-eval scorecard flags transcripts without recording provenance', reSrc.includes('UNVERIFIED') && reSrc.includes('.meta.json'))

// #13 behavioral: declared control with empty policyEngines must FAIL; with a backed engine must PASS
const cgDir = fs.mkdtempSync('/tmp/b11-cg-')
fs.mkdirSync(path.join(cgDir, 'gates'), { recursive: true })
fs.mkdirSync(path.join(cgDir, 'agentcore/datasets'), { recursive: true })
fs.copyFileSync(path.join(repoRoot, 'console/ci-templates/gates/check-guardrails.mjs'), path.join(cgDir, 'gates/check-guardrails.mjs'))
fs.writeFileSync(path.join(cgDir, 'gates/platform-gates.json'), JSON.stringify({ threshold: 0.8, protectedFiles: [], guardrails: { 'content-guardrails': { enabled: true } } }))
fs.writeFileSync(path.join(cgDir, 'agentcore/datasets/golden.jsonl'), '{"scenario_id":"s1","turns":[{"input":"hi"}]}\n')
fs.writeFileSync(path.join(cgDir, 'agentcore/agentcore.json'), JSON.stringify({ policyEngines: [] }))
let hollowFails = false
try { execSync('node gates/check-guardrails.mjs', { cwd: cgDir, stdio: 'pipe' }) } catch (e) { hollowFails = e.status === 1 }
check('#13 check-guardrails FAILS when declared control has no policy engine backing', hollowFails)
fs.writeFileSync(path.join(cgDir, 'agentcore/agentcore.json'), JSON.stringify({ policyEngines: [{ name: 'platform_content_guardrails', policies: [{ name: 'platform_baseline', statement: 'permit(principal, action, resource);', validationMode: 'FAIL_ON_ANY_FINDINGS' }] }] }))
let backedPasses = true
try { execSync('node gates/check-guardrails.mjs', { cwd: cgDir, stdio: 'pipe' }) } catch { backedPasses = false }
check('#13 check-guardrails PASSES when the declared control is backed by a real engine', backedPasses)
fs.rmSync(cgDir, { recursive: true, force: true })

// #13 staged export ships a non-empty policy engine (declaration backed at birth)
const acJson = JSON.parse(fs.readFileSync(path.join(stagedRoot, 'agentcore/agentcore.json'), 'utf8'))
check('#13 exported agentcore.json carries the platform baseline policy engine', (acJson.policyEngines || []).some(e => (e.policies || []).length > 0))

// #16 exported MCP client is env-gated, no hardcoded third-party endpoint
const mcpSrc = fs.readFileSync(path.join(stagedRoot, 'app/chat_agent/mcp_client/client.py'), 'utf8')
check('#16 MCP client reads MCP_SERVER_URL from env', mcpSrc.includes('MCP_SERVER_URL'))
check('#16 MCP client has no hardcoded exa.ai endpoint', !mcpSrc.includes('exa.ai'))
check('#16 MCP client warns and disables when unconfigured', mcpSrc.includes('return None') && mcpSrc.includes('logger.warning'))

// #14 CD workflows verify CLI output, not just exit codes
for (const wf of ['.github/workflows/deploy-dev.yml', '.github/workflows/promote.yml']) {
  const wfSrc = fs.readFileSync(path.join(stagedRoot, wf), 'utf8')
  check(`#14 ${wf} uses set -euo pipefail + output verification`, wfSrc.includes('set -euo pipefail') && wfSrc.includes('deploy.log'))
}

// ---- cleanup: remove the generated (never deployed) project + export staging ----
fs.rmSync(path.join(repoRoot, 'domain-examples/generated', PROJECT), { recursive: true, force: true })
fs.rmSync(stagedRoot, { recursive: true, force: true })

console.log(failures === 0 ? '\nALL B11 SMOKE CHECKS PASSED' : `\n${failures} B11 SMOKE CHECK(S) FAILED`)
process.exit(failures ? 1 : 0)
