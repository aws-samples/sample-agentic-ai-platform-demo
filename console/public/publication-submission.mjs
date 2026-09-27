// Explicit review initiation and owner submission; no registration or implicit mutation.
function mountAdminInitiation(button, box, root, {row, api, readApprovals, current, identity, requestId, reload}) {
  const actor = identity();
  const valid = () => current() && root.isConnected && actor === identity();
  const resourceId = `${row.version._aws.registryId}/${row.version._aws.recordId}`;
  const checkRequests = async () => {
    const result = await readApprovals();
    if (result?.ok !== true || result.resource !== 'approvals' || !Array.isArray(result.items)
      || result.cursor !== null || result.complete === false || result.partial === true || result.nextToken
      || result.error || result.code || result.errors?.length) throw new Error('Existing requests could not be verified. Refresh the queue.');
    if (result.items.some(a => !a || !['PENDING','APPROVED','REJECTED','CANCELLED'].includes(a.status)
      || !['id','domainId','resourceId','kind','requesterSubject'].every(k => typeof a[k] === 'string' && a[k].trim()))) throw new Error('Existing requests could not be verified. Refresh the queue.');
    return result.items.some(a => a.kind === 'RESOURCE_PUBLICATION' && a.domainId === row.entry.domain && a.resourceId === resourceId && a.status === 'PENDING');
  };
  let formOpened = false;
  button.textContent = 'Initiate review';
  button.onclick = async () => {
    if (button.disabled || !valid()) return;
    button.disabled = true;
    try {
      const exists = await checkRequests();
      if (!valid()) return;
      if (exists) { box.textContent = 'A review request already exists. Refresh the queue to view it.'; return; }
      box.replaceChildren();
      const info = document.createElement('p'); info.textContent = 'Create a formal review request. A different authorized reviewer must decide it.';
      const reason = document.createElement('textarea'); reason.setAttribute('aria-label','Reason for initiating review'); reason.setAttribute('data-dirty-field','true'); reason.rows = 3;
      const submit = document.createElement('button'); submit.className = 'primary'; submit.textContent = 'Submit for independent review';
      const status = document.createElement('p'); status.setAttribute('role','status');
      box.append(info, reason, submit, status);
      formOpened = true;
      let sent = false;
      submit.onclick = async () => {
        if (submit.disabled || sent || !valid()) return;
        const text = reason.value?.trim();
        if (!text || text.length < 10 || text.length > 2000) { status.textContent = 'Enter a review reason between 10 and 2000 characters.'; return; }
        submit.disabled = true;
        try {
          const exists = await checkRequests();
          if (!valid()) return;
          if (exists) { status.textContent = 'A review request already exists. Refresh the queue to view it.'; return; }
          sent = true;
          const response = await api('/governance/publication-initiations', {registryId:row.version._aws.registryId, recordId:row.version._aws.recordId, expectedRecordVersion:row.version.semver, reason:text}, {requestId:requestId()});
          if (!valid()) return;
          if (response?.ok === true && response.approval?.status === 'PENDING') { await reload(); return; }
          status.textContent = response?.code === 'INVALID_RESOURCE_METADATA'
            ? 'Verified resource ownership is required before review can be initiated.'
            : response?.code === 'FORBIDDEN' ? 'You are not authorized to initiate this review.'
            : 'Review initiation was not confirmed. Refresh and check request status before trying again.';
        } catch {
          if (valid()) status.textContent = sent ? 'The result is unknown. Refresh and check request status before trying again.' : 'Could not verify existing requests. Refresh the queue.';
        } finally { if (valid() && !sent) submit.disabled = false; }
      };
    } catch (error) { if (valid()) box.textContent = error.message || 'Could not verify existing requests.'; }
    finally { if (valid() && !formOpened) button.disabled = false; }
  };
}
const blockers = {
  GOVERNANCE_METADATA_REQUIRED: 'This resource needs verified governance ownership before it can be submitted. Contact its owner.',
  OWNER_REQUIRED: 'Only the resource owner can submit it here.',
  RESOURCE_NOT_SUBMITTABLE: 'This resource is not available for submission.',
  SUBMISSION_NOT_ALLOWED: 'Your current role cannot submit this resource.',
};
const UNKNOWN_MATCHING = 'Could not verify existing requests. Refresh and try again.';
const contextFailureMessage = (context) => {
  if (context?.status === 403 || ['FORBIDDEN','DEMO_DOMAIN_REQUIRED','DEMO_DOMAIN_NOT_ALLOWED','DOMAIN_REQUIRED','DOMAIN_NOT_ALLOWED'].includes(context?.code)) return 'You do not have permission to view submission eligibility for this resource.';
  if (context?.status === 404 || ['NOT_FOUND','ROUTE_NOT_FOUND'].includes(context?.code)) return 'Submission eligibility was not found for this resource. Refresh the queue.';
  if (context?.status === 503 || context?.code === 'CONTROL_PLANE_UNAVAILABLE') return 'The eligibility service is temporarily unavailable. Try again shortly.';
  return 'Submission eligibility could not be checked. Refresh and try again.';
};
const isNetworkError = error => error?.network === true || /network|fetch/i.test(error?.message || '');
const NETWORK_MESSAGE = 'A network problem prevented the eligibility check. Check your connection and retry.';
export function mountPublicationSubmission(root, { row, api, readApprovals, current, identity, requestId, reload, access }) {
  const button = root.querySelector('[data-publication-check]');
  const box = root.querySelector('[data-publication-context]');
  if (!button || !box) return;
  // The role only exposes the form; the authenticated server authorizes every write.
  if (access?.role === 'admin' && row.entry?._source === 'agentcore-registry'
    && ['MCPServer','Agent','A2AAgent','Skill','Blueprint'].includes(row.entry.type)
    && ['DRAFT','IN_REVIEW','REJECTED'].includes(row.version?.status)
    && /^[A-Za-z0-9]{12,16}$/.test(row.version?._aws?.registryId || '')
    && /^[A-Za-z0-9]{12}$/.test(row.version?._aws?.recordId || '')) {
    mountAdminInitiation(button, box, root, {row, api, readApprovals, current, identity, requestId, reload});
    return;
  }
  // This is a UI preflight only. Ownership/version and all writes remain server-authorized.
  if (access) {
    const crossDomainAdmin = access.role === 'admin' && access.resourceDomain !== 'platform';
    const sameScope = typeof access.resourceDomain === 'string' && !!access.resourceDomain
      && access.resourceDomain === access.activeDomain;
    if (crossDomainAdmin || !sameScope || !access.capabilities?.includes('submitDomainResourcePublication')) {
      button.hidden = true;
      button.disabled = true;
      button.onclick = null;
      // A platform admin is a reviewer here, not the submitting owner: do not
      // misdirect her to "submit from its domain workspace" (a place she does
      // not own). Decidable native records surface Approve/Reject upstream and
      // never reach this card; anything still here is awaiting the owner's
      // formal submission, which only a domain-scoped owner can file.
      box.textContent = access.role === 'admin'
        ? 'Awaiting the owner\u2019s formal submission from its domain workspace before a decision can be recorded.'
        : crossDomainAdmin
          ? 'The owner must submit this resource from its domain workspace.'
          : 'Submission is not available in your current role and domain.';
      return;
    }
  }
  button.textContent = 'Review submission';
  const capturedIdentity = identity();
  const valid = () => current() && root.isConnected && capturedIdentity === identity();
  const registryId = row.version._aws.registryId, recordId = row.version._aws.recordId;
  const path = '/governance/publication-context?' + new URLSearchParams({ registryId, recordId });
  let pendingRequestId;
  const message = text => { box.textContent = text; };
  const retireSubmit = submit => { submit.disabled = true; submit.onclick = null; };
  // Eligibility context is trusted only when every governance field is explicit
  // and well-formed. Unknown/missing/wrongly-typed values are never coerced to
  // an eligible state: governed must be strictly true, and identity/version
  // fields must be real non-blank strings.
  const text = value => typeof value === 'string' && !!value.trim();
  const eligibleContext = context => context?.ok === true && context.governed === true && context.canSubmit === true
    && context.registryId === registryId && context.recordId === recordId && context.domainId === row.entry.domain
    && ['recordVersion', 'approvalId', 'ownerSubject', 'reviewerRole', 'status'].every(key => text(context[key]));
  // Three-state structured read: {state:'found',id} (a matching PENDING request
  // exists, carrying its real request id), {state:'absent'} (complete read, no
  // match), {state:'unknown'} (paginated/partial/invalid/rejected/conflicting
  // read — never treated as absence, never allowed to trigger a context GET or
  // a POST).
  const UNKNOWN = { state: 'unknown' };
  const matching = async () => {
    let result;
    try { result = await readApprovals(); } catch { return UNKNOWN; }
    if (result?.ok !== true || result.resource !== 'approvals' || !Array.isArray(result.items)
      || result.cursor !== null || result.complete === false || result.partial === true
      || result.nextToken || result.code || result.error
      || (result.completeness && result.completeness !== 'complete')
      || (result.errors != null && (!Array.isArray(result.errors) || result.errors.length))) return UNKNOWN;
    const seen = new Map();
    for (const item of result.items) {
      if (!item || !['PENDING','APPROVED','REJECTED','CANCELLED'].includes(item.status)
        || !['id','kind','domainId','resourceId','resourceType','requesterSubject'].every(key => text(item[key]))) return UNKNOWN;
      const key = JSON.stringify([item.domainId,item.id]);
      if (seen.has(key) && JSON.stringify(seen.get(key)) !== JSON.stringify(item)) return UNKNOWN;
      seen.set(key,item);
    }
    const type = ({ MCPServer: 'MCP_SERVER', Agent: 'AGENT', A2AAgent: 'AGENT', Skill: 'SKILL', Blueprint: 'BLUEPRINT' })[row.entry.type];
    const candidates = [...seen.values()].filter(a => a?.kind === 'RESOURCE_PUBLICATION' && a.domainId === row.entry.domain
      && a.resourceId === row.identity && a.resourceType === type);
    if (candidates.some(a => typeof a.status !== 'string')) return UNKNOWN;
    const pending = candidates.filter(a => a.status === 'PENDING');
    if (pending.length > 1) return UNKNOWN;
    return pending.length === 1 ? { state: 'found', id: pending[0].id } : { state: 'absent' };
  };
  const foundMessage = found => `A review request already exists (request ${found.id}). Refresh the queue to open it.`;
  button.onclick = async () => {
    if (button.disabled || !valid()) return;
    button.disabled = true;
    try {
      const state = await matching();
      if (!valid()) return;
      if (state.state === 'found') { message(foundMessage(state)); return; }
      if (state.state !== 'absent') { message(UNKNOWN_MATCHING); return; }
      let context;
      try { context = await api(path); }
      catch (error) { if (valid()) message(isNetworkError(error) ? NETWORK_MESSAGE : contextFailureMessage()); return; }
      if (!valid()) return;
      if (context?.ok !== true) { message(contextFailureMessage(context)); return; }
      if (context.governed !== true || context.canSubmit !== true) { message(blockers[context.blocker] || 'This resource cannot be submitted in your current scope.'); return; }
      if (!eligibleContext(context)) { message('Resource details changed. Refresh the queue.'); return; }
      box.replaceChildren();
      const info = document.createElement('p');
      info.textContent = `Owner: ${context.ownerSubject} · Reviewer: ${context.reviewerRole}`;
      const submit = document.createElement('button'); submit.className = 'primary'; submit.textContent = 'Submit for review';
      box.append(info, submit);
      submit.onclick = async () => {
        if (submit.disabled || !valid()) return;
        submit.disabled = true;
        let posted = false;
        try {
          const recheck = await matching();
          if (!valid()) return;
          if (recheck.state === 'found') { retireSubmit(submit); message(foundMessage(recheck)); return; }
          if (recheck.state !== 'absent') { message(UNKNOWN_MATCHING); return; }
          const latest = await api(path);
          if (!valid()) return;
          // The second eligibility read must independently prove governance and
          // match the first read exactly. Any drift (including governed flipping
          // away from strict true) fails closed and permanently retires this
          // submit handler — a retained reference can never write afterwards.
          if (!eligibleContext(latest)
            || ['registryId', 'recordId', 'domainId', 'recordVersion', 'ownerSubject', 'approvalId', 'status'].some(key => latest[key] !== context[key])) {
            retireSubmit(submit); message('Resource details or permissions changed. Refresh the queue.'); return;
          }
          pendingRequestId ||= `submit-${context.approvalId}`;
          posted = true;
          const result = await api('/governance/publications', {
            registryId, recordId, approvalId: context.approvalId, expectedRecordVersion: context.recordVersion,
          }, { requestId: pendingRequestId });
          if (!valid()) return;
          if (result?.ok === true) await reload();
          else { const error = document.createElement('p'); error.setAttribute('role', 'status'); error.textContent = result?.code === 'FORBIDDEN' ? 'You do not have permission to submit this resource in this scope.' : 'The submission result is unknown. Check the request status before retrying.'; box.append(error); }
        } catch {
          if (valid()) {
            const error = document.createElement('p'); error.setAttribute('role', 'status');
            // If the request was already sent (e.g. it timed out), the outcome is unknown —
            // never claim it definitely was not submitted. Retrying reuses the same requestId.
            error.textContent = posted
              ? 'The submission result is unknown. Check the request status before retrying.'
              : 'Submission was not sent. Retry or refresh the queue.';
            box.append(error);
          }
        }
        finally { if (valid() && submit.isConnected && submit.onclick) submit.disabled = false; }
      };
    } catch (error) { if (valid()) message(error.message || 'Could not check submission eligibility.'); }
    finally { if (valid()) button.disabled = false; }
  };
}
