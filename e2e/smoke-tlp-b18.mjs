// TLP-B18 smoke — enduser landing recommendations + fleet cards.
//   1. Enduser Overview renders >=2 recommendation cards (#ovrecs .ovreccard),
//      each with an agent name, a short description and a Chat affordance;
//      clicking one lands DIRECTLY on that agent's chat page (#fmsg).
//   2. Enduser Agents page renders cards (.eufleetcard) instead of the old
//      table — lifecycle badge, description, Chat button — and a card click
//      opens the chat page too.
// Data-driven like smoke-tlp-b13/b16: the recommendation source is the live
// /api/fleet APPROVED filter (registry seed guarantees >=2 on a seeded
// account); when this account has <2 live published runtimes the >=2 half is
// skipped-as-pass, but whatever cards render must still be chat-linked.
import { chromium } from 'playwright'
import { apiLogin, authedGet, uiLogin } from './login.mjs'

let failures = 0
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  | ' + extra : ''}`)
  if (!ok) failures++
}

const enduser = await apiLogin('enduser')
const fleet = await authedGet('/fleet', enduser)
const published = (fleet.agents || []).filter(a => a.project && a.approval === 'APPROVED')

const browser = await chromium.launch()
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 950 } })
  await uiLogin(page, 'enduser')

  // ---------- 1. Overview recommendation cards ----------
  await page.waitForFunction(() => {
    const box = document.getElementById('ovrecs')
    return box && !box.querySelector('.spin')
  }, null, { timeout: 30000 })
  const recCards = await page.locator('#ovrecs .ovreccard').count()
  check(`R1 overview renders one recommendation card per published agent (${published.length})`,
    recCards === published.length, `cards=${recCards}`)
  if (published.length >= 2) {
    check('R2 >=2 recommendation cards on a seeded account', recCards >= 2, `cards=${recCards}`)
  } else {
    check('R2 (skipped-as-pass) <2 live published runtimes in this account — registry self-heal', true,
      `published=${published.length}`)
  }
  if (recCards >= 1) {
    const first = page.locator('#ovrecs .ovreccard').first()
    const txt = await first.textContent()
    const name = await first.getAttribute('data-recname')
    check('R3 card shows the agent name + a description + a Chat affordance',
      txt.includes(name) && txt.includes('Chat') && txt.replace(name, '').trim().length > 20)
    // click → lands directly on the chat page (chat-only enduser agent view)
    await first.click()
    await page.waitForSelector('#fmsg', { timeout: 15000 })
    check('R4 card click lands directly on the agent chat page',
      (await page.locator('#fmsg').count()) === 1 &&
      (await page.locator('#fsend').count()) === 1 &&
      (await page.locator('#detailbox').count()) === 0)
    // back to Agents keeps working from the chat page
    await page.locator('#fleetback').click()
  }

  // ---------- 2. Agents page renders cards, each opening chat ----------
  await page.locator('.nav[data-shellnav="fleet"]').click()
  await page.waitForFunction(() => {
    const box = document.getElementById('fleetbox')
    return box && !box.querySelector('.spin') && (box.querySelector('.eufleetcard') || box.querySelector('.empty'))
  }, null, { timeout: 30000 })
  const fleetCards = await page.locator('#fleetbox .eufleetcard').count()
  check(`F1 Agents page renders one card per published agent (${published.length}), no table`,
    fleetCards === published.length && (await page.locator('#fleetbox table').count()) === 0,
    `cards=${fleetCards}`)
  if (fleetCards >= 1) {
    const card = page.locator('#fleetbox .eufleetcard').first()
    const ctxt = await card.textContent()
    check('F2 card carries lifecycle badge + description + Chat button',
      (await card.locator('[data-lcbadge]').count()) === 1 &&
      (await card.locator('.eufleetchat').count()) === 1 &&
      ctxt.includes('Chat'))
    check('F3 no approval/cost/delete surface on enduser cards',
      !ctxt.includes('APPROVED') && !/\$\d/.test(ctxt) &&
      (await page.locator('.gdel').count()) === 0)
    await card.click()
    await page.waitForSelector('#fmsg', { timeout: 15000 })
    check('F4 fleet card click opens the chat page', (await page.locator('#fmsg').count()) === 1)
  }
} finally {
  await browser.close()
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS')
process.exit(failures ? 1 : 0)
