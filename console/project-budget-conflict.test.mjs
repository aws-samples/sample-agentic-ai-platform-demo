import assert from 'node:assert/strict';
import test from 'node:test';
import { createProjectBudgetController } from './public/modules/project-budget.mjs';

const scope = { domainId: 'support', projectId: 'case-assist' };
const budget = (version, monthlyLimitUsd) => ({ ...scope, version, monthlyLimitUsd,
  thresholdPercent: 80, currency: 'USD', period: 'CALENDAR_MONTH_UTC' });
const view = value => ({ ok: true, resource: 'project-budget', scope,
  project: { ...scope, ownerSubject: 'test-owner', status: 'ACTIVE' },
  access: { role: 'lead', canEdit: true }, budget: value, evaluation: null });

test('after a conflict, dirty comparison uses the newly persisted budget without losing the draft', async () => {
  let gets = 0;
  const controller = createProjectBudgetController({ scope, request: async (_path, body) => {
    if (body) return { ok: false, code: 'CONFLICT' };
    return view(++gets === 1 ? budget(1, 10) : budget(2, 25));
  } });
  await controller.load();
  await controller.save({ monthlyLimitUsd: '30', thresholdPercent: '80' });
  assert.equal(controller.state.phase, 'conflict');
  assert.equal(controller.state.view.budget.version, 2);
  assert.equal(controller.state.draft.monthlyLimitUsd, '30');
  assert.equal(controller.state.dirty, true);
  controller.edit({ monthlyLimitUsd: '10', thresholdPercent: '80' });
  assert.equal(controller.state.dirty, true, 'old baseline is now an unsaved change against persisted version 2');
  controller.edit({ monthlyLimitUsd: '25', thresholdPercent: '80' });
  assert.equal(controller.state.dirty, false, 'matching the confirmed current budget is clean');
});
