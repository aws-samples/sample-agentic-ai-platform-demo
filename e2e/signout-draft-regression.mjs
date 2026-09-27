// TEST MOCKS NOT LIVE. Actual app buttons and auth-client; all HTTP is intercepted.
// Node 22.23.2: node e2e/signout-draft-regression.mjs <new-evidence-directory> [--base]
// --base routes exact accepted-base app bytes through the same assertions (expected RED).
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { fixture, signIn, navigate, ready, poll, loaded, unexpected, errors, origin } from './approved-ui-integration.mjs';

assert.equal(process.version, 'v22.23.2');
assert.ok(process.argv[2], 'Supply a new evidence directory');
assert.ok(process.argv.length === 3 || (process.argv.length === 4 && process.argv[3] === '--base'));
const output = path.resolve(process.argv[2]);
await mkdir(output);
const root = fileURLToPath(new URL('../', import.meta.url));
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
const base = '8eecfc7faa7237195f8822a528a7c2d81edf817a';
const baseline = process.argv[3] === '--base';
const app = baseline ? execFileSync('git', ['show', `${base}:console/public/modules/app.mjs`], { cwd: root })
  : await readFile(path.join(root, 'console/public/modules/app.mjs'));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const launchOptions = { headless: true, chromiumSandbox: true };
const checks = [], failures = [], requests = [], screenshots = [], logoutSnapshots = [];
const actions = ['Switch user', 'Sign out'];
let browser;

async function setup(canSwitch = false) {
  const f = await fixture('lead', {}, browser);
  f.state.canSwitch = canSwitch;
  f.acceptDiscard = false;
  f.logout = [];
  f.page.setDefaultTimeout(10000);
  f.page.removeAllListeners('dialog');
  f.page.on('dialog', async dialog => {
    f.state.dialogs.push({ type: dialog.type(), message: dialog.message() });
    if (dialog.type() === 'confirm' && f.acceptDiscard) await dialog.accept();
    else await dialog.dismiss();
  });
  f.page.on('request', req => {
    const url = new URL(req.url());
    requests.push({ origin: url.origin, path: url.pathname, method: req.method() });
  });
  if (baseline) await f.context.route(`${origin}/modules/app.mjs`, route => {
    loaded.set('modules/app.mjs', hash(app));
    return route.fulfill({ contentType: 'text/javascript', body: app });
  });
  // Fail closed even for an accidental write to a known fixture API.
  await f.context.route(`${origin}/api/**`, route => {
    const req = route.request(), url = new URL(req.url());
    if (req.method() !== 'GET' && !(req.method() === 'POST' && url.pathname === '/api/operations/project-budgets')) {
      unexpected.push(`${req.method()} ${url.pathname}`);
      return route.abort();
    }
    return route.fallback();
  });
  // Observe the departing console document synchronously. Evaluating the page
  // from a paused navigation route deadlocks Chromium's navigation lifecycle.
  await f.context.addInitScript(() => {
    window.addEventListener('pagehide', () => {
      if (location.origin !== 'https://console.test') return;
      sessionStorage.setItem('test.signout-departure', JSON.stringify({
        origin: location.origin,
        tokens: sessionStorage.getItem('console.cognito.tokens'),
        flow: sessionStorage.getItem('console.cognito.flow'),
        context: sessionStorage.getItem('console.demo-context'),
        draftFields: document.querySelectorAll('#wid,#wname,#wdesc,[data-budget-form]').length,
        signedOut: !!document.querySelector('#cognitosignin'),
      }));
    });
  });
  await f.context.route('https://identity.test/logout**', async route => {
    const url = new URL(route.request().url());
    assert.equal(url.searchParams.get('client_id'), 'synthetic-client');
    assert.equal(url.searchParams.get('logout_uri'), origin + '/');
    f.logout.push(url.pathname);
    return route.fallback();
  });
  await signIn(f);
  return f;
}

async function check(name, work, canSwitch = false) {
  let f;
  try {
    f = await setup(canSwitch);
    await work(f);
    checks.push(name);
    console.log('PASS', name);
  } catch (error) {
    failures.push({ name, error: error.stack, dialogs: f?.state.dialogs || [] });
    console.error('FAIL', name, error.stack);
    process.exitCode = 1;
  } finally {
    if (f) await f.context.close();
  }
}

async function screenshot(f, name) {
  await f.page.screenshot({ path: path.join(output, name + '.png'), fullPage: true });
  screenshots.push(name + '.png');
}

async function session(f) {
  return {
    tokens: await f.page.evaluate(() => sessionStorage.getItem('console.cognito.tokens')),
    identity: await f.page.locator('#tbprofile').innerText(),
  };
}

async function clickAction(f, action) {
  if (await f.page.locator('#tbprofile').getAttribute('aria-expanded') !== 'true') {
    await f.page.locator('#tbprofile').click();
  }
  await f.page.evaluate(() => sessionStorage.removeItem('test.signout-departure'));
  await f.page.getByRole('button', { name: action, exact: true }).click();
}

async function clickNav(f, id) {
  const button = f.page.locator(`[data-shellnav="${id}"]`);
  const group = button.locator('xpath=ancestor::details');
  if (await group.count() && !(await group.evaluate(node => node.open))) {
    await group.locator('summary').click();
  }
  await button.click();
}

async function cancelAction(f, action) {
  const before = await session(f), dialogs = f.state.dialogs.length;
  assert.ok(before.tokens, 'Synthetic login must have produced an actual stored token');
  await clickAction(f, action);
  assert.equal(f.state.dialogs.length, dialogs + 1, 'Explicit action must ask before discarding');
  assert.equal(f.state.dialogs.at(-1).type, 'confirm');
  assert.match(f.state.dialogs.at(-1).message, /Discard unsaved changes/);
  assert.equal(f.logout.length, 0);
  assert.deepEqual(await session(f), before, 'Cancel retains token and authenticated identity');
}

async function finishLogout(f, action, dirty) {
  const dialogs = f.state.dialogs.length;
  f.acceptDiscard = true;
  await clickAction(f, action);
  await f.page.waitForURL('https://identity.test/logout**');
  assert.equal(f.state.dialogs.length, dialogs + (dirty ? 1 : 0));
  if (dirty) assert.equal(f.state.dialogs.at(-1).type, 'confirm');
  assert.deepEqual(f.logout, ['/logout'], 'Exactly one synthetic Cognito logout request');
  await f.page.goto(origin);
  await ready(f.page, '#cognitosignin');
  const departure = await f.page.evaluate(() => JSON.parse(sessionStorage.getItem('test.signout-departure')));
  assert.deepEqual(departure, {
    origin, tokens: null, flow: null, context: null, draftFields: 0, signedOut: true,
  }, 'Discard and real auth-client cleanup happen before the console document leaves');
  logoutSnapshots.push(departure);
  assert.equal(await f.page.evaluate(() => sessionStorage.getItem('console.cognito.tokens')), null);
  assert.equal(await f.page.locator('#tbprofile,#wid,#wname,[data-budget-form]').count(), 0);
}

async function openWizard(f, draft = false) {
  await navigate(f.page, 'projects');
  await ready(f.page, '#dcprojgo');
  await f.page.locator('#dcprojgo').click();
  await ready(f.page, '[data-hosted-project-wizard]');
  if (draft) {
    await f.page.locator('[data-wtpl="blank"]').click();
    await f.page.locator('#wnext').click();
    await f.page.locator('#wid').fill('unsaved-project');
    await f.page.locator('#wname').fill('Synthetic unsaved project');
    await f.page.locator('#wdesc').fill('Keep this typed description on Cancel.');
  }
}

async function wizardValues(f) {
  return f.page.locator('#wid,#wname,#wdesc').evaluateAll(nodes => nodes.map(n => n.value));
}

async function openBudget(f) {
  await navigate(f.page, 'bwcost');
  await ready(f.page, '[name="monthlyLimitUsd"]');
  assert.equal(await f.page.locator('[name="monthlyLimitUsd"]').inputValue(), '100');
}

try {
  browser = await chromium.launch(launchOptions);
  for (const action of actions) await check(`${action}: wizard Cancel retains session; confirm discards; fresh PKCE login works`, async f => {
    await openWizard(f, true);
    const values = await wizardValues(f), before = await session(f);
    assert.equal(values.length, 3);
    // Reproduce the reported contrast using an actual Registry sidebar button.
    await clickNav(f, 'bwregistry');
    assert.equal(f.state.dialogs.length, 1);
    assert.match(f.state.dialogs[0].message, /Discard unsaved changes/);
    assert.deepEqual(await wizardValues(f), values);
    assert.deepEqual(await session(f), before);
    await cancelAction(f, action);
    assert.deepEqual(await wizardValues(f), values);
    const prefix = action === 'Switch user' ? 'switch-user' : 'sign-out';
    await screenshot(f, prefix + '-cancel-retains-wizard');
    await finishLogout(f, action, true);
    await screenshot(f, prefix + '-signed-out');
    const previousState = f.state.authorize.state;
    await signIn(f);
    assert.notEqual(f.state.authorize.state, previousState, 'Reauthentication starts a fresh PKCE flow');
    assert.ok((await session(f)).tokens);
    assert.equal(f.logout.length, 1);
    await openWizard(f);
    await f.page.locator('[data-wtpl="blank"]').click();
    await f.page.locator('#wnext').click();
    assert.deepEqual(await wizardValues(f), ['', '', ''], 'Discarded values never reappear after login');
    assert.equal(f.state.projectPosts, 0);
  });

  if (!baseline) {
    for (const action of actions) for (const state of ['browsing', 'untouched-wizard', 'loaded', 'reverted', 'loading']) {
      await check(`${action}: ${state} has no false discard prompt`, async f => {
        if (state === 'browsing') {
          await navigate(f.page, 'bwregistry');
          await f.page.locator('#regsearch').fill('Synthetic filter');
          await navigate(f.page, 'bwfleet');
        } else if (state === 'untouched-wizard') {
          await openWizard(f);
        } else if (state === 'loading') {
          let observed = false;
          // Abort the pending synthetic read when logout cancels session work.
          // Keep its response pending so no business baseline has loaded.
          await f.context.route(`${origin}/api/operations/project-budgets**`, route => {
            observed = true;
            return new Promise(resolve => { f.releaseBudget = () => route.abort().then(resolve); });
          });
          try {
            await clickNav(f, 'bwcost');
            await poll(() => observed, 'Budget read started');
            assert.equal(await f.page.locator('[name="monthlyLimitUsd"]').count(), 0);
            await finishLogout(f, action, false);
          } finally {
            if (f.releaseBudget) await f.releaseBudget();
          }
          return;
        } else {
          await openBudget(f);
          if (state === 'reverted') {
            await f.page.locator('[name="monthlyLimitUsd"]').fill('125');
            await f.page.locator('[name="monthlyLimitUsd"]').fill('100');
          }
        }
        assert.equal(f.state.dialogs.length, 0);
        await finishLogout(f, action, false);
      });
    }

    for (const action of actions) for (const mode of ['failSave', 'readAfterSaveFailure', 'conflict']) {
      await check(`${action}: ${mode} budget stays protected`, async f => {
        await openBudget(f);
        f.state[mode] = true;
        await f.page.locator('[name="monthlyLimitUsd"]').fill('150');
        await f.page.getByRole('button', { name: 'Save USD budget', exact: true }).click();
        const message = mode === 'failSave' ? /Budget save failed/ : mode === 'conflict' ? /Budget changed/ : /unconfirmed/;
        await poll(async () => message.test(await f.page.locator('[data-project-budget]').innerText()), 'Budget outcome visible');
        const content = await f.page.locator('[data-project-budget]').innerText();
        await cancelAction(f, action);
        assert.equal(await f.page.locator('[data-project-budget]').innerText(), content);
        assert.equal(f.state.posts, 1, 'Cancel must not retry a save');
        if (mode === 'conflict') assert.equal(await f.page.locator('[name="monthlyLimitUsd"]').inputValue(), '150');
        await finishLogout(f, action, true);
        assert.equal(f.state.posts, 1);
      });
    }

    await check('working-context changes preserve authenticated identity and never call logout', async f => {
      const before = await session(f);
      await openWizard(f, true);
      const values = await wizardValues(f);
      await f.page.locator('#tbrole').selectOption('builder');
      assert.equal(await f.page.locator('#tbrole').inputValue(), 'lead');
      assert.deepEqual(await wizardValues(f), values);
      assert.deepEqual(await session(f), before);
      f.acceptDiscard = true;
      await f.page.locator('#tbrole').selectOption('builder');
      await poll(async () => await f.page.locator('#tbrole').inputValue() === 'builder'
        && await f.page.locator('#tbrole').isEnabled()
        && await f.page.locator('#wname').count() === 0, 'Authorized context revalidated and old draft removed');
      assert.deepEqual(await session(f), before);
      assert.equal(f.logout.length, 0);
      assert.equal(await f.page.locator('#wname').count(), 0);
    }, true);

    await check('forced 401 still clears a dirty session without confirmation or explicit logout', async f => {
      await openWizard(f, true);
      await f.context.route(`${origin}/api/projects`, route => route.fulfill({
        status: 401, contentType: 'application/json', body: JSON.stringify({ ok: false, code: 'UNAUTHORIZED' }),
      }));
      // Actual wizard submission reaches rawApi and its unchanged forced-401 path.
      // The POST receives only this synthetic rejection; no project is created.
      for (let step = 0; step < 4; step++) await f.page.locator('#wnext').click();
      await f.page.locator('#wcreate').click();
      await ready(f.page, '#cognitosignin');
      assert.equal(f.state.dialogs.length, 0);
      assert.equal(f.logout.length, 0);
      assert.equal(await f.page.evaluate(() => sessionStorage.getItem('console.cognito.tokens')), null);
      assert.equal(await f.page.locator('#wname').count(), 0);
    });
  }
  assert.deepEqual(unexpected, []);
  assert.deepEqual(errors, []);
  assert.equal(loaded.get('modules/app.mjs'), hash(app));
  assert.equal(loaded.get('auth-client.mjs'), hash(await readFile(path.join(root, 'console/public/auth-client.mjs'))));
} catch (error) {
  failures.push({ name: 'browser launch or boundary verification', error: error.stack });
  console.error(error);
  process.exitCode = 1;
} finally {
  if (browser) await browser.close();
  await writeFile(path.join(output, 'browser-results.json'), JSON.stringify({
    label: 'TEST MOCKS NOT LIVE', liveAcceptance: false, pixelsInspected: false, node: process.version,
    sourceSha: git('rev-parse', 'HEAD'), sourceTree: git('rev-parse', 'HEAD^{tree}'),
    trackedDiff: git('diff', '--stat'), appSource: baseline ? base : 'worktree', appSha256: hash(app),
    launchOptions, passed: checks.length, failed: failures.length, checks, failures, requests,
    unexpected, errors, loadedSourceSha256: Object.fromEntries(loaded), logoutSnapshots, screenshots,
  }, null, 2) + '\n', { flag: 'wx' });
}
