// Synthetic AWS SDK boundary; actual handler, identity projector, authorizer,
// governance service and Dynamo workspace adapter execute without replacement.
import assert from 'node:assert/strict';
import { GetItemCommand, PutItemCommand, QueryCommand, TransactWriteItemsCommand, TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import { GetRegistryRecordCommand, CreateRegistryRecordCommand, SubmitRegistryRecordForApprovalCommand, UpdateRegistryRecordStatusCommand } from '@aws-sdk/client-agent-registry-control';
import { createWorkspaceState } from '../../lambda/workspace/state.mjs';
import { createGovernanceService } from '../../lambda/governance/service.mjs';
import { createGovernanceHandler } from '../../lambda/governance/index.mjs';
import { createProductionIdentityProjector } from '../../lambda/workspace/runtime.mjs';
import { createGovernanceAuthorizer, createGovernanceMutationClaimResolver } from '../../lambda/governance/runtime.mjs';
export const REGISTRY = 'SyntheticReg';
export const RECORD = 'SyntheticRec';
// Distinct platform-domain registry so an admin can initiate AND (a different
// admin can) decide a platform-domain resource end-to-end (admins are pinned to
// the 'platform' active domain for decide). Kept separate from REGISTRY so
// domainForRegistry() resolves each registry to exactly one domain.
export const PLATFORM_REGISTRY = 'SyntheticPlatReg';
export const NOW = '2026-09-12T10:00:00.000Z';
export function workflowFixture() {
  const table = new Map(), records = new Map(), commands = [];
  const key = item => `${item.pk.S}|${item.sk.S}`;
  function condition(input) {
    const prior = table.get(key(input.Item));
    if (/attribute_not_exists/.test(input.ConditionExpression || '')) return !prior;
    if (!input.ConditionExpression) return true;
    return input.ConditionExpression.split(' AND ').every(term => {
      const [name, op, value] = term.split(' ');
      assert.equal(op, '=', 'Only real emitted equality conditions accepted');
      return JSON.stringify(prior?.[input.ExpressionAttributeNames[name]]) === JSON.stringify(input.ExpressionAttributeValues[value]);
    });
  }
  const dynamo = { async send(command) {
    commands.push(command.constructor.name);
    const i = command.input;
    if (command instanceof GetItemCommand) return table.has(key(i.Key)) ? { Item: structuredClone(table.get(key(i.Key))) } : {};
    if (command instanceof QueryCommand) {
      const pk = i.ExpressionAttributeValues[':pk']?.S;
      const prefix = Object.entries(i.ExpressionAttributeValues).find(([k]) => /prefix/i.test(k))?.[1]?.S;
      assert.ok(pk, 'Query must be explicitly partition scoped');
      return { Items: [...table.values()].filter(item => item.pk.S === pk && (!prefix || item.sk.S.startsWith(prefix))).map(item => structuredClone(item)) };
    }
    if (command instanceof PutItemCommand) {
      if (!condition(i)) throw Object.assign(Error('synthetic conditional conflict'), { name: 'ConditionalCheckFailedException' });
      table.set(key(i.Item), structuredClone(i.Item)); return {};
    }
    if (command instanceof TransactWriteItemsCommand) {
      const valid = i.TransactItems.map(t => { assert.ok(t.Put); return condition(t.Put); });
      if (valid.some(v => !v)) throw new TransactionCanceledException({ message: 'synthetic conditional conflict', $metadata: {}, CancellationReasons: valid.map(v => ({ Code: v ? 'None' : 'ConditionalCheckFailed' })) });
      i.TransactItems.forEach(t => table.set(key(t.Put.Item), structuredClone(t.Put.Item))); return {};
    }
    assert.fail(`Unexpected Dynamo command ${command.constructor.name}`);
  } };
  const registryClient = { async send(command) {
    commands.push(command.constructor.name); const i = command.input;
    if (command instanceof CreateRegistryRecordCommand) {
      const arn = `arn:aws:agent-registry:us-west-2:${'9988' + '77665544'}:registry/${i.registryId}`;
      const record = { ...i, recordId: RECORD, recordArn: `${arn}/record/${RECORD}`, registryArn: arn,
        status: 'DRAFT', createdAt: new Date(NOW), updatedAt: new Date(NOW) };
      records.set(`${i.registryId}/${RECORD}`, record); return { recordArn: record.recordArn };
    }
    const record = records.get(`${i.registryId}/${i.recordId}`);
    assert.ok(record, 'Synthetic record must exist');
    if (command instanceof GetRegistryRecordCommand) return structuredClone(record);
    if (command instanceof SubmitRegistryRecordForApprovalCommand) { assert.ok(['DRAFT','REJECTED'].includes(record.status)); record.status = 'PENDING_APPROVAL'; return {}; }
    if (command instanceof UpdateRegistryRecordStatusCommand) { assert.equal(record.status, 'PENDING_APPROVAL'); record.status = i.status; record.statusReason = i.statusReason; return {}; }
    assert.fail(`Unexpected Registry command ${command.constructor.name}`);
  } };
  const state = createWorkspaceState({ tableName: 'SyntheticPlatformState', dynamo, now: () => NOW });
  const registryFor = id => id === 'domain_a' ? REGISTRY : id === 'platform' ? PLATFORM_REGISTRY : 'OtherTestReg';
  const fullDomain = id => ({ id, status: 'ACTIVE', registryId: registryFor(id), registryArn: `arn:aws:agent-registry:us-west-2:${'9988' + '77665544'}:registry/${registryFor(id)}` });
  // Mirror production: the governance HANDLER consumes an active-domain
  // directory whose listActiveDomains returns bare {id} (createActiveDomainDirectory),
  // while the governance SERVICE consumes a record directory whose
  // listActiveDomains returns FULL domain objects + getDomain
  // (createActiveDomainRecordDirectory). The service uses the full shape for
  // domainForRegistry() (admin-initiate); the handler's validateDomains rejects
  // any object with more than the single {id} key.
  const handlerDirectory = {
    async listActiveDomains() { return ['domain_a','domain_b','platform'].map(id => ({ id })); },
  };
  const domainDirectory = {
    async getDomain(id) { return ['domain_a','domain_b','platform'].includes(id) ? fullDomain(id) : null; },
    async listActiveDomains() { return ['domain_a','domain_b','platform'].map(fullDomain); },
  };
  const service = createGovernanceService({ workspaceState: state, domainDirectory, registryClient,
    authorizer: createGovernanceAuthorizer({ workspaceState: state, clock: () => new Date(NOW) }),
    mutationClaimResolver: createGovernanceMutationClaimResolver({ tableName: 'SyntheticPlatformState', dynamo }),
    mandatoryTags: { 'auto-delete': 'no', managedBy: 'agentic-platform', project: 'agentic-ai-platform-demo' }, sleep: async () => {} });
  const handler = createGovernanceHandler({ governanceService: service, domainDirectory: handlerDirectory,
    identityProjector: createProductionIdentityProjector(), identityVerifier: async () => false });
  let sequence = 0;
  async function call(path, { actor = 'synthetic-owner', role = 'builder', domain = 'domain_a', body, requestId = `synthetic-${++sequence}`, groups, headers = {} } = {}) {
    const url = new URL(path, 'https://synthetic.invalid'); const method = body === undefined ? 'GET' : 'POST';
    const claims = { sub: actor, token_use: 'access', 'cognito:username': 'old-friendly-name', 'cognito:groups': JSON.stringify(groups || [role === 'admin' ? 'platform-admin' : `domain-${role}`, `domain-${domain.replaceAll('_','-')}`]) };
    const event = { routeKey: `${method} ${url.pathname}`, headers: { 'content-type': 'application/json', 'x-active-domain': domain, 'x-request-id': requestId, ...headers },
      requestContext: { requestId, http: { method, path: url.pathname }, authorizer: { jwt: { claims } } } };
    if (url.search) { event.queryStringParameters = Object.fromEntries(url.searchParams); event.rawQueryString = url.search.slice(1); }
    if (body !== undefined) event.body = JSON.stringify(body);
    const result = await handler(event); return { status: result.statusCode, ...JSON.parse(result.body) };
  }
  const draft = (overrides = {}) => call('/api/governance/resources', { body: { domainId: 'domain_a', resourceType: 'MCP_SERVER', resourceId: 'synthetic-mcp', displayName: 'Synthetic MCP', description: 'Synthetic approval test resource', version: '1.0.0', shared: false, specification: { name: 'synthetic-mcp', description: 'Synthetic MCP', version: '1.0.0', remotes: [{ type: 'streamable-http', url: 'https://example.invalid/mcp' }] } }, ...overrides });
  // Draft a genuinely-pending resource in the PLATFORM domain, owned by a
  // non-admin builder (owner != the initiating admin). Used to exercise the
  // admin-initiate -> self-reject -> independent-admin-approve flow end-to-end,
  // where admin decide is pinned to the platform active domain.
  const draftPlatform = (overrides = {}) => call('/api/governance/resources', { actor: 'synthetic-platform-owner', role: 'builder', domain: 'platform', body: { domainId: 'platform', resourceType: 'MCP_SERVER', resourceId: 'synthetic-platform-mcp', displayName: 'Synthetic Platform MCP', description: 'Synthetic platform approval test resource', version: '1.0.0', shared: false, specification: { name: 'synthetic-platform-mcp', description: 'Synthetic Platform MCP', version: '1.0.0', remotes: [{ type: 'streamable-http', url: 'https://example.invalid/platform-mcp' }] } }, ...overrides });
  const context = options => call(`/api/governance/publication-context?registryId=${REGISTRY}&recordId=${RECORD}`, options);
  return { call, draft, draftPlatform, context, state, service, table, records, commands, registryClient };
}
