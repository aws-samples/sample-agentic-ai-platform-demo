import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { landingHtml } from './public/modules/landing.mjs';

// Execute the actual public HTML renderer; no browser or authentication substitute.
const render = () => landingHtml('<button type="button" id="cognitosignin">Sign in with Cognito</button>');

test('public renderer uses short overview and example labels without internal disclaimers', () => {
  const html = render();
  assert.match(html, /Platform overview/);
  assert.match(html, /Example workflow/);
  assert.match(html, /Example journeys/);
  assert.doesNotMatch(html, /conceptual operating model|They do not assert|These original stories|source reference marker|not your account status|stories do not establish/);
  assert.match(html, /A shared foundation for agentic AI/);
});

test('renderer keeps one primary sign-in control and the keyboard skip anchor', () => {
  const html = render();
  assert.equal((html.match(/id="cognitosignin"/g) || []).length, 1);
  assert.equal((html.match(/href="#landing-signin"/g) || []).length, 1);
  assert.match(html, /<a class="landing-skip" href="#landing-signin">Skip to sign in<\/a>/);
  assert.match(html, /id="landing-signin"[^>]*tabindex="-1"/);
  assert.match(html, /id="landing-pause"[^>]*aria-pressed="false"/);
  assert.equal((html.match(/role="tab"/g) || []).length, 4);
  assert.equal((html.match(/data-gstage=/g) || []).length, 9);
  assert.match(html, /role="tabpanel" aria-labelledby="landing-role-admin"/);
  assert.match(html, /data-motion-track/);
});

test('rendered semantic controls resolve anchors and ARIA references without duplicate IDs', () => {
  // Parse renderer output with the standard-library HTML parser, not source regexes.
  // This verifies markup semantics only, not browser focus movement or pixels.
  execFileSync('python3', ['-c', `
from html.parser import HTMLParser
import sys
class Controls(HTMLParser):
 def __init__(self):
  super().__init__(); self.nodes=[]
 def handle_starttag(self, tag, attrs):
  self.nodes.append((tag, dict(attrs)))
p=Controls(); p.feed(sys.stdin.read())
ids=[a['id'] for _,a in p.nodes if 'id' in a]
assert len(ids)==len(set(ids)), 'duplicate rendered IDs'
for tag,a in p.nodes:
 for key in ('aria-controls','aria-labelledby'):
  for target in a.get(key,'').split(): assert target in ids, (key,target)
 if tag=='a' and a.get('href','').startswith('#'): assert a['href'][1:] in ids
 if tag=='button': assert a.get('type')=='button'
tabs=[a for _,a in p.nodes if a.get('role')=='tab']
assert len(tabs)==4
assert len([a for a in tabs if a.get('aria-selected')=='true' and a.get('tabindex')=='0'])==1
assert len([a for a in tabs if a.get('aria-selected')=='false' and a.get('tabindex')=='-1'])==3
assert len([a for t,a in p.nodes if t=='button' and a.get('id')=='cognitosignin'])==1
assert [a for _,a in p.nodes if a.get('id')=='landing-signin'][0]['tabindex']=='-1'
`], { input: render(), encoding: 'utf8' });
});

test('actual roadmap HTML scopes L3 account vending to reference design and keeps four levels and diagrams', () => {
  const html = readFileSync(new URL('./public/landing-roadmap.html', import.meta.url), 'utf8');
  // Parse the shipped asset used by both the standalone page and landing renderer.
  // Offline HTML semantics only; no browser, network or deployment claim.
  execFileSync('python3', ['-c', `
from html.parser import HTMLParser
import sys, re
class Roadmap(HTMLParser):
 def __init__(self):
  super().__init__(); self.stage=None; self.levels=[]; self.leads={}; self.capture=False; self.arch=[]; self.diagrams=0
 def handle_starttag(self, tag, attrs):
  a=dict(attrs); classes=a.get('class','').split()
  if tag=='section' and 'stage' in classes and a.get('id') in ('l1','l2','l3','l4'):
   self.stage=a.get('id'); self.levels.append(self.stage)
  if tag=='p' and 'lead' in classes and self.stage and self.stage not in self.leads:
   self.leads[self.stage]=''; self.capture=True
  if tag=='div' and 'arch' in classes: self.arch.append(self.stage)
  if tag=='pre' and 'mermaid' in classes: self.diagrams+=1
 def handle_data(self, data):
  if self.capture: self.leads[self.stage]+=data
 def handle_endtag(self, tag):
  if tag=='p': self.capture=False
  if tag=='section': self.stage=None
p=Roadmap(); p.feed(sys.stdin.read())
lead=p.leads['l3']
assert lead.startswith('In this reference design, '), lead
assert not re.search(r'demo console|already implemented|currently (?:provisions|vends)|is deployed', lead, re.I), lead
for concept in ('Governance / Landing-Zone account', 'dev → UAT → prod', 'approved architectural blueprints', 'shared control plane for all agents', 'automated evaluation and quality gates', 'federated domain-owned runtimes'):
 assert concept in lead, concept
assert p.levels==['l1','l2','l3','l4'], p.levels
assert p.arch==['l1','l2','l3','l4'], p.arch
assert p.diagrams==2, p.diagrams
`], { input: html, encoding: 'utf8' });
  assert.match(render(), /Reference architecture roadmap/);
  assert.match(render(), /href="\/landing-roadmap.html"/);
});

test('roadmap labels architecture as reference rather than deployed account status', () => {
  const html = readFileSync(new URL('./public/landing-roadmap.html', import.meta.url), 'utf8');
  assert.match(html, /Reference architecture/);
  assert.doesNotMatch(html, /not deployment evidence|NOW COMPLETE|NOW LIT UP|exactly what the demo console (?:provisions|implements)/);
  assert.match(html, /Domain and project resources are not automatically AWS accounts/);
  assert.equal((html.match(/<pre class="mermaid">/g) || []).length, 2);
  assert.match(html, /id="l1"/);
  assert.match(html, /id="l4"/);
});
