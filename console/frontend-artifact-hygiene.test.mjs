import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildFrontend } from './build-frontend.mjs';

test('canonical frontend artifact contains runtime modules, not Node test sources', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'frontend-hygiene-'));
  try {
    const output = path.join(root, 'public');
    const manifest = await buildFrontend(output);
    const paths = manifest.files.map(file => file.path);
    assert.deepEqual(paths.filter(name => /(?:^|\/)[^/]+\.(?:test|spec)\.[cm]?js$/.test(name)), [],
      'Node test sources must live outside console/public (also used by CDK Source.asset)');
    assert.ok(paths.includes('dirty-state.mjs'));
    assert.ok(paths.includes('form-dirty-guard.mjs'));
    assert.ok(paths.includes('modules/app.mjs'));
    assert.ok(!paths.includes('runtime-config.js'), 'deployment-owned config stays excluded');
    for (const name of paths.filter(name => name.endsWith('.mjs'))) {
      assert.doesNotMatch(await readFile(path.join(output, name), 'utf8'),
        /(?:from\s*|import\s*\()['"]node:(?:test|assert(?:\/strict)?)['"]/,
        `Node-only test dependency in ${name}`);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
