const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({
  '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;',
})[c]);
const repositoryUrl = value => /^[\w-]+\/[\w.-]+$/.test(value || '')
  ? `https://github.com/${value}` : null;

export function releaseDeliveryHtml(pipelines) {
  if (!pipelines.length) return '<p class="empty">No governed delivery pipelines are configured for your scope.</p>';
  return pipelines.map(pipeline => `<section class="card">
    <div class="console-resource-header"><div><h3>${escape(pipeline.agentId)}</h3>
    <p>${escape(pipeline.domainId)} / ${escape(pipeline.projectId)} · ${repositoryUrl(pipeline.repository)
      ? `<a href="${repositoryUrl(pipeline.repository)}" target="_blank" rel="noopener noreferrer">${escape(pipeline.repository)}</a>`
      : escape(pipeline.repository)}</p></div></div>
    ${pipeline.releases.length ? pipeline.releases.map(release => release.status === 'INVALID_RELEASE'
      ? `<details><summary>Release identity unavailable</summary><p>Execution ${escape(release.executionId)} has no valid commit and artifact identity. It cannot be approved.</p></details>`
      : `<details>
      <summary>${escape(release.status)} · ${escape(release.commitSha?.slice(0,12) || release.executionId)}</summary>
      <dl><dt>Production target</dt><dd>${escape(release.accountId)} / ${escape(release.region)} / prod</dd>
      <dt>Commit</dt><dd>${repositoryUrl(pipeline.repository) && /^[a-f0-9]{40}$/.test(release.commitSha || '')
        ? `<a href="${repositoryUrl(pipeline.repository)}/commit/${release.commitSha}" target="_blank" rel="noopener noreferrer"><code>${release.commitSha}</code></a>`
        : `<code>${escape(release.commitSha)}</code>`}</dd>
      <dt>Artifact SHA-256</dt><dd style="overflow-wrap:anywhere"><code>${escape(release.artifactSha256)}</code></dd>
      <dt>Pipeline execution</dt><dd>${escape(release.executionId)}</dd></dl>
      <table><thead><tr><th>Environment</th><th>Verification</th><th>Evaluation</th><th>Runtime version</th></tr></thead><tbody>
      ${['dev','preprod','prod'].map(env => {
        const evidence = release.evidence?.[env];
        return `<tr><td>${env}</td><td>${escape(evidence?.status || 'No verified deployment')}</td>
        <td>${evidence ? `${escape(evidence.evaluation?.status)} · ${escape(evidence.evaluation?.caseCount)} cases
        <br>Minimum ${escape(evidence.evaluation?.minimumScore)} / required ${escape(evidence.evaluation?.requiredScore)}` : '—'}</td>
        <td>${escape(evidence?.runtimeVersion || '—')}</td></tr>`;
      }).join('')}</tbody></table>
      ${release.decision ? `<p>Decision: ${escape(release.decision.decision)} · ${escape(release.decision.status)}</p>
        <p>${escape(release.decision.reason)}</p>` : ''}
      ${(release.canDecide ?? release.canApprove) && (!release.decision || release.canRetryDecision) ? `<form data-release="${escape(release.executionId)}" data-pipeline="${escape(pipeline.id)}">
        <p>Review the exact release and verified environments above. Your decision controls this production execution.</p>
        ${release.canApprove ? '' : '<p role="status">This release does not meet the current evaluation requirement. Reject it before submitting a newly verified release.</p>'}
        ${release.canRetryDecision ? '<p role="status">Your decision was saved, but delivery to the pipeline is not confirmed. Retry the original decision below; its release, author and reason remain unchanged.</p>' : ''}
        <label>Decision reason<textarea name="reason" required minlength="10" maxlength="1000" rows="3"${release.canRetryDecision?' readonly':''}>${release.canRetryDecision?escape(release.decision.reason):''}</textarea></label>
        <div class="bar">${release.canRetryDecision
          ? `<button type="submit" name="decision" value="${escape(release.decision.decision)}"${release.decision.decision==='APPROVE'&&!release.canApprove?' disabled':''}>Retry saved ${release.decision.decision==='APPROVE'?'approval':'rejection'}</button>`
          : `<button type="submit" name="decision" value="APPROVE"${release.canApprove?'':' disabled'}>Approve production</button>
        <button type="submit" name="decision" value="REJECT" class="ghost">Reject release</button>`}</div>
        <p role="status" data-decision-status></p></form>` : ''}
    </details>`).join('') : '<p>No releases submitted yet.</p>'}
  </section>`).join('');
}

export async function mountReleaseDelivery(root, request) {
  if (!root) return;
  root.innerHTML = '<p role="status">Loading governed releases…</p>';
  let response;
  try { response = await request('/release-delivery'); } catch { response = null; }
  if (!root.isConnected) return;
  if (response?.message === 'Not Found') {
    root.innerHTML = '<p class="empty">Governed delivery is not configured. A platform administrator needs to connect the project repository to its delivery pipeline.</p>';
    return;
  }
  if (!response?.ok || !Array.isArray(response.pipelines)) {
    root.innerHTML = '<p role="status">Release delivery is unavailable. Refresh to retry; no approval has been submitted.</p>';
    return;
  }
  root.innerHTML = releaseDeliveryHtml(response.pipelines);
  root.querySelectorAll('form[data-release]').forEach(form => {
    form.onsubmit = async event => {
      event.preventDefault();
      if (form.dataset.busy || !form.reportValidity()) return;
      const pipeline = response.pipelines.find(p => p.id === form.dataset.pipeline);
      const release = pipeline?.releases.find(r => r.executionId === form.dataset.release);
      if (!(release?.canDecide ?? release?.canApprove) || !['APPROVE','REJECT'].includes(event.submitter?.value)) return;
      if (release.decision && (!release.canRetryDecision || event.submitter.value !== release.decision.decision)) return;
      if (event.submitter.value === 'APPROVE' && !release.canApprove) return;
      const body = Object.fromEntries(['pipelineId','executionId','commitSha','artifactSha256',
        'accountId','region','environment'].map(key => [key, release[key]]));
      body.decision = event.submitter.value;
      body.reason = form.elements.reason.value.trim();
      form.dataset.busy = 'true';
      form.querySelectorAll('button').forEach(button => button.disabled = true);
      try {
        const result = await request('/release-decisions', body);
        if (result?.ok) await mountReleaseDelivery(root, request);
        else form.querySelector('[data-decision-status]').textContent = `Decision not confirmed: ${result?.code || 'service unavailable'}. Refresh the release before retrying.`;
      } catch {
        form.querySelector('[data-decision-status]').textContent = 'Decision not confirmed. Refresh the release before retrying.';
      } finally {
        delete form.dataset.busy;
        form.querySelectorAll('button').forEach(button => button.disabled = button.value === 'APPROVE' && !release.canApprove);
      }
    };
  });
}
