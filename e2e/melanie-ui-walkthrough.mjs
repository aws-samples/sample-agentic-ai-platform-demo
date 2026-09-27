// Full user-facing UI walkthrough across admin/builder/lead/user personas.
// Screenshots every nav item + discoverable tab into /tmp/tlp-ui-walkthrough/
import fs from 'node:fs'
import { chromium } from 'playwright'
import { uiLogin } from './login.mjs'

const SHOT_DIR = '/tmp/tlp-ui-walkthrough/'
fs.mkdirSync(SHOT_DIR, { recursive: true })
const log = []
function note(x) { console.log(x); log.push(x) }

async function settle(page) {
  await page.waitForFunction(() => !document.querySelector('#main .spin'), null, { timeout: 15000 }).catch(() => {})
  await page.waitForTimeout(450)
}

async function shot(page, name) {
  await settle(page)
  const p = SHOT_DIR + name + '.png'
  await page.screenshot({ path: p, fullPage: true })
  note('SHOT ' + name)
  return p
}

async function clickTabsIn(page, selector, prefix) {
  const tabs = await page.locator(selector).all()
  const results = []
  for (let i = 0; i < tabs.length; i++) {
    try {
      const t = page.locator(selector).nth(i)
      const text = (await t.innerText().catch(() => '')).trim().slice(0, 30)
      await t.click({ timeout: 5000 })
      await settle(page)
      const name = `${prefix}-tab${i}-${text.replace(/[^a-z0-9]+/gi, '_') || 'tab'}`
      await shot(page, name)
      results.push({ text, name })
    } catch (e) {
      note(`  ! tab click failed idx=${i}: ${e.message}`)
    }
  }
  return results
}

const browser = await chromium.launch()
try {
  const page = await browser.newPage({ viewport: { width: 1500, height: 1100 } })
  page.on('console', msg => { if (msg.type() === 'error') note('CONSOLE ERROR: ' + msg.text().slice(0,200)) })
  page.on('pageerror', err => note('PAGE ERROR: ' + err.message.slice(0,200)))

  // ===================== LOGIN PAGE =====================
  await page.goto('http://localhost:4000')
  await page.waitForTimeout(800)
  await shot(page, '00-login-page')

  // ===================== ADMIN (melanie) =====================
  note('=== ADMIN (melanie) ===')
  await uiLogin(page, 'melanie')
  await page.waitForSelector('#whoami')
  await shot(page, 'admin-00-home-dashboard')

  const adminGovNav = ['home','domains','blueprints','registry','governance','cost','monitoring']
  for (const navId of adminGovNav) {
    try {
      await page.locator(`.nav[data-shellnav="${navId}"]`).click()
      await shot(page, `admin-gov-${navId}`)
      // try tabs within this page
      await clickTabsIn(page, '.tabbar .tab, .tabs button, [data-dctab], [data-govtab]', `admin-gov-${navId}`)
    } catch (e) { note(`admin nav ${navId} failed: ${e.message}`) }
  }

  // BUILD WORKSPACE section (admin's own platform-domain workspace).
  // B13: no bwregistry — admin's registry entry is the org-level one.
  const bwNav = ['bwfleet','bwmemorykb','bwcost','bwobs']
  for (const navId of bwNav) {
    try {
      await page.locator(`.nav[data-shellnav="${navId}"]`).click()
      await shot(page, `admin-bw-${navId}`)
    } catch (e) { note(`admin bw nav ${navId} failed: ${e.message}`) }
  }

  // Build wizard - three doors
  try {
    await page.locator('.nav[data-shellnav="bwbuild"]').click()
    await settle(page)
    await shot(page, 'admin-build-doors-landing')
    // Door 1: blueprint
    const bpDoor = page.locator('[data-door="blueprint"]')
    if (await bpDoor.count()) {
      await bpDoor.click(); await settle(page)
      await shot(page, 'admin-build-door-blueprint-step1')
    }
  } catch (e) { note('admin build wizard failed: ' + e.message) }

  // ===================== BUILDER (alice) =====================
  note('=== BUILDER (alice) ===')
  await uiLogin(page, 'alice')
  await page.waitForSelector('#whoami')
  await shot(page, 'builder-00-workspace-fleet')

  const builderNav = ['fleet','memorykb','cost','obs','registry']
  for (const navId of builderNav) {
    try {
      await page.locator(`.nav[data-shellnav="${navId}"]`).click()
      await shot(page, `builder-nav-${navId}`)
    } catch (e) { note(`builder nav ${navId} failed: ${e.message}`) }
  }

  // Builder build wizard - three doors, walk each to first step
  try {
    await page.locator('.nav[data-shellnav="build"]').click()
    await settle(page)
    await shot(page, 'builder-build-doors-landing')
    for (const doorId of ['blueprint','scratch','plato']) {
      const door = page.locator(`[data-door="${doorId}"]`)
      if (await door.count()) {
        await door.click(); await settle(page)
        await shot(page, `builder-build-door-${doorId}-step1`)
        // go back to doors landing
        const back = page.locator('#doorback')
        if (await back.count()) { await back.click(); await settle(page) }
        else { await page.locator('.nav[data-shellnav="build"]').click(); await settle(page) }
      }
    }
  } catch (e) { note('builder build wizard failed: ' + e.message) }

  // ===================== LEAD (carol) =====================
  note('=== LEAD (carol) ===')
  await uiLogin(page, 'carol')
  await page.waitForSelector('#whoami')
  await shot(page, 'lead-00-domainconsole-dashboard')

  const leadGovNav = ['dashboard','projects','users','governance']
  for (const navId of leadGovNav) {
    try {
      await page.locator(`.nav[data-shellnav="${navId}"]`).click()
      await shot(page, `lead-gov-${navId}`)
    } catch (e) { note(`lead nav ${navId} failed: ${e.message}`) }
  }
  for (const navId of ['bwfleet','bwmemorykb','bwcost','bwobs','bwregistry']) {
    try {
      await page.locator(`.nav[data-shellnav="${navId}"]`).click()
      await shot(page, `lead-bw-${navId}`)
    } catch (e) { note(`lead bw nav ${navId} failed: ${e.message}`) }
  }

  // ===================== USER (enduser) =====================
  note('=== USER (enduser) ===')
  await uiLogin(page, 'enduser')
  await page.waitForSelector('#whoami')
  await shot(page, 'user-00-overview')
  for (const navId of ['overview','fleet']) {
    try {
      await page.locator(`.nav[data-shellnav="${navId}"]`).click()
      await shot(page, `user-nav-${navId}`)
    } catch (e) { note(`user nav ${navId} failed: ${e.message}`) }
  }

  note('ALL SHOTS SAVED')
} catch (e) {
  note('FATAL: ' + e.message)
} finally {
  await browser.close()
  fs.writeFileSync(SHOT_DIR + 'walkthrough-log.txt', log.join('\n'))
}
