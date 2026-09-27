import {test} from 'node:test';
import assert from 'node:assert/strict';
import {releaseDeliveryHtml} from './public/release-delivery-view.mjs';

test('release review displays exact artifact, production target and environment evidence', () => {
  const html=releaseDeliveryHtml([{id:'release',agentId:'contract',domainId:'platform',
    projectId:'foundation',repository:'owner/contract',releases:[{
      status:'AWAITING_APPROVAL',executionId:'execution',commitSha:'a'.repeat(40),
      artifactSha256:'b'.repeat(64),accountId:'123456789012',region:'us-west-2',
      environment:'prod',canApprove:true,
      evidence:{dev:{status:'VERIFIED',runtimeVersion:'2',evaluation:{status:'PASSED',caseCount:2}}},
    }]}]);
  assert.ok(html.includes('a'.repeat(40)));
  assert.ok(html.includes('b'.repeat(64)));
  assert.ok(html.includes('123456789012 / us-west-2 / prod'));
  assert.match(html,/No verified deployment/);
  assert.match(html,/Approve production/);
});

test('non-reviewers cannot submit and remote data is escaped', () => {
  const html=releaseDeliveryHtml([{id:'release',agentId:'<script>alert(1)</script>',
    releases:[{status:'InProgress',executionId:'one',canApprove:false}]}]);
  assert.doesNotMatch(html,/<script>|<form|Approve production/);
  assert.match(html,/&lt;script&gt;/);
});

test('unconfirmed human decision retries its saved reason without offering a replacement', () => {
  const release={executionId:'one',canDecide:true,canApprove:true,canRetryDecision:true,
    decision:{decision:'APPROVE',status:'SUBMISSION_UNCONFIRMED',reason:'Reviewed <exact> release'}};
  const render=r=>releaseDeliveryHtml([{id:'release',releases:[r]}]);
  const html=render(release);
  assert.match(html,/Retry saved approval/);
  assert.match(html,/readonly>Reviewed &lt;exact&gt; release<\/textarea>/);
  assert.doesNotMatch(html,/Reject release|>Approve production</);
  assert.doesNotMatch(render({...release,canRetryDecision:false}),/<form/);
  assert.doesNotMatch(render({...release,canRetryDecision:false,
    decision:{...release.decision,status:'SUBMITTED'}}),/<form/);
});
