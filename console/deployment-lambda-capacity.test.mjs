import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {PLATFORM_RESERVED_CONCURRENCY, validateLambdaCapacity} from '../scripts/deploy-clean-account.mjs';

test('fresh-account capacity budget includes all committed Lambda reservations', () => {
  const paths = [
    '../infra/serverless-platform/lib/platform-web-stack.ts',
    '../infra/serverless-platform/lib/domain-bootstrap-stack.ts',
    '../infra/serverless-platform/lib/policy-inventory.ts',
  ];
  const total = paths.flatMap(path => [...readFileSync(new URL(path, import.meta.url), 'utf8')
    .matchAll(/reservedConcurrentExecutions:\s*lambdaReservedConcurrency\(\w+,\s*(\d+)\)/g)])
    .reduce((sum, match) => sum + Number(match[1]), 0);
  assert.equal(PLATFORM_RESERVED_CONCURRENCY, total);
});

test('only opt-in reservations need AWS unreserved minimum headroom', () => {
  for (const available of [10, 50, 100, 242]) {
    assert.throws(() => validateLambdaCapacity({
      AccountLimit: {UnreservedConcurrentExecutions: available},
    }, 'reserved'), /243 required.*quota increase/);
    assert.doesNotThrow(() => validateLambdaCapacity({
      AccountLimit: {UnreservedConcurrentExecutions: available},
    }));
  }
  for (const available of [243, 998]) {
    assert.doesNotThrow(() => validateLambdaCapacity({
      AccountLimit: {UnreservedConcurrentExecutions: available},
    }, 'reserved'));
  }
});

test('shared mode rejects exhausted capacity and unknown modes', () => {
  assert.throws(() => validateLambdaCapacity({AccountLimit: {UnreservedConcurrentExecutions: 0}}), /no unreserved/);
  assert.throws(() => validateLambdaCapacity({}, 'automatic'), /shared or reserved/);
});

test('missing or malformed quota evidence fails closed', () => {
  for (const available of [undefined, null, '1000', -1, 243.5]) {
    assert.throws(() => validateLambdaCapacity({
      AccountLimit: {UnreservedConcurrentExecutions: available},
    }), /valid unreserved/);
  }
});
