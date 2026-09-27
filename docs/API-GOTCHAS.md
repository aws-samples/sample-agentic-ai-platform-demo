# API & Test Gotchas

Hard-won notes from independently re-verifying every batch of this demo (didi, the
review side of the two-signature process). Everything here was found by a probe
failing on a **false premise** — a guessed endpoint name, a guessed field shape, a
too-loose regex — not by reading the source. If you are writing a script, a test, or
an agent that drives this console, read this first; it will save you the same hours.

Companion docs:
- `docs/PLATFORM-DESIGN.md` — UI structure, full API catalogue, data stores, batch change log.
- `ao-brain projects/plato-demo-design/` — findings ledger (R-numbers, verdicts, closing shas) and per-batch sign-off reports.

---

## 1. Endpoint names that are not what you would guess

| You will type | It is actually | Notes |
|---|---|---|
| `/api/github-export` | **`/api/export`** | Body `{project, owner, repoName, preset}`. `preset` ∈ `PRESETS` (`FULL`/`MINIMAL`/`SPEC`…); unknown preset → 400 with the valid list. |
| `/api/platform-overview` | **`/api/fleet`** | The org-wide agent list the platform Dashboard card drills into. An all-domains admin session gets every domain; a scoped session gets its own. |
| `/api/audit` | **`/api/audit-trail`** | Returns `{events: [...]}` — **not** `entries`, not `rows`. |
| `/api/access-requests` | **`/api/grant-requests`** | Row author field is **`requestedBy`** (not `by`, not `user`). |
| `/api/cost-rollup?domain=x` | **`/api/domain-cost-rollup?id=x`** | Query param is `id`, and it takes the domain id. |

**Rule of thumb:** before writing a probe, `grep -n 'url.pathname === "/api/' console/server.mjs`
and copy the literal. Guessing an endpoint gives you `{"error":"not found"}` which then
fails an assertion *downstream*, and the red looks like a product bug when it is yours.

## 2. Response shapes that bite

- **`/api/wizard-create` returns `project` as a STRING id**, not an object.
  `mk.project?.id` is `undefined` → the next `/api/export` 404s → your ownership
  assertions fail on a premise that never held.
- **`/api/lifecycle` returns `{ok, lifecycle}`** where `lifecycle` is `null` when the repo
  has no entry. `null` is a valid answer, not an error.
- Guardrail metadata: `/api/wizard-templates` gives `orgEnforced` as **objects** (`{id,…}`)
  but `domainEnforced` as **plain id strings**. Mixing them without normalising drops locks:
  `[...(meta.orgEnforced||[]).map(g => g.id), ...(meta.domainEnforced||[])]`.

## 3. Identifier namespaces are not interchangeable

Four different ids look similar and are not:
- **project id** — what `wizard-create` returns, what `guardProject()` checks.
- **on-disk dir** — `projectDir()` strips hyphens; the folder name ≠ the project id.
- **fleet/runtime id** — the deploy name, used by `/api/fleet` and the chat/invoke paths.
- **lifecycle key** — the full **`owner/repo`** string. A bare repo name is rejected
  (`invalid repo name`); the whitelist is `^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$`.

Reading a 400 from `/api/lifecycle-advance`, the `error` field tells you which premise broke:
`invalid repo name` = bare name · `unknown repo` = never exported · `out-of-order stage` =
stage index not current+1 (or you passed `exported`, which only the real export path may mint).

## 4. Never let a test create real external side effects

`catalog.json → githubOrgs[]` carries a **`real`** flag. Orgs with `real: true` hit
GitHub for real with the machine's credentials — an export against one **creates a
repository**. This actually happened during diagnosis (two repos created, deleted
within a minute, verified 404) and became finding R-B8-06: the default owner used to be
a real org, i.e. an irreversible side effect on the default path.

Current contract (verify, don't assume):
- Default export owner = the first **`real: false`** (mock) org in the catalog.
- A `real: true` owner requires an explicit truthy **`confirmReal`**; the flag merely
  being present is not enough.

**Probe rule:** always pass an explicit mock owner (e.g. `acme-platform`) and assert the
real-org path only at the **guard layer** — that the confirmation branch flips. Never
assert a real repository was created. Reproducing an irreversible side effect to prove it
is guarded is the mistake the finding is about.

## 5. Persistent stores your test will pollute

These are gitignored runtime stores. Touch them and you own restoring them, or the next
run's exact-sum/count assertions go red for no reason:

| Store | What it is the truth for |
|---|---|
| `console/agent-lifecycle.json` | delivery-pipeline narrative state (**not** chat availability) |
| `console/usage-ledger.json` | the only source cost figures derive from |
| `console/projects.json` | project ownership / membership |
| `console/domain-policies.json` | live-read policy store (re-read per request) |

Discipline that works:

```js
const snap = existsSync(STORE) ? readFileSync(STORE, 'utf8') : '{}'
try { /* … adversarial calls … */ }
finally {
  writeFileSync(STORE, snap)
  check('store restored byte-identical', readFileSync(STORE, 'utf8') === snap)
}
```

**Ordering matters more than you think.** A full-suite red on `smoke-tlp-b3`/`b5` cost
`exact-sum` assertions, twice, was never a product bug: probes had written to the usage
ledger before the suite ran. Triage order that settles it in minutes:
cold-start single run → replay the exact predecessor sequence → restart the server and
re-run the suite. If single runs are green and only the suite is red, suspect your own
ordering before the product's.

## 6. Chat availability vs lifecycle stage

Two independent truths, deliberately decoupled:
- **Can you talk to it?** → runtime/registry `status` (Fleet). This gates chat.
- **How far through delivery is it?** → `agent-lifecycle.json`. This gates nothing.

Advancing the lifecycle to `deployed` does **not** conjure a chattable agent, and a seeded
agent that answers chat may have no lifecycle entry at all. The UI states this
explicitly ("Chat availability comes from the live runtime status in the Fleet, not from
this tracker") — keep it that way; assert both directions.

## 7. Selector and copy gotchas in the e2e suite

- **`hasText` is substring, not equality.** After the governance nav was renamed,
  `page.locator('.nav', {hasText: 'AI Registry'})` matched both `AI Registry` and
  `AI Registry (org)` → *strict mode violation: resolved to 2 elements*, four files red
  (finding R-B9-01). Use the stable hook: **`.nav[data-shellnav="<id>"]`**. Labels are
  product copy and will keep changing; `data-shellnav` will not.
- **Case matters when you assert copy is gone.** `/Chat with a DEPLOYED agent/i` also
  matches legitimate prose like "over every deployed agent", producing a false red on a
  removal that had actually happened. Assert removals **case-sensitively** on the exact
  former label.
- **Anchor on the real markup.** Journey door titles live in a JS array as
  `title:'Start from Blueprint'`, not `<h4>`; a bare substring fallback hits unrelated
  prose and scrambles positional order checks.
- **Door copy hygiene rule:** door text must not contain `mock`/`simulated`
  (`smoke-scratch` enforces it). Phrase demo honesty as e.g. "each advance here simulates
  the real trigger" — same meaning, passes the rule. If you add new UI copy, run that
  suite before claiming green.

## 8. Assertion patterns that keep review honest

1. **Positional exact-lists, not existence checks.** For nav and ordered journeys, compare
   the full list element by element. "Contains X" cannot catch a wrong order — and wrong
   order was a real finding twice.
2. **Independent literals, never the shared constant.** A probe that imports the product's
   `ADMIN_NAV` agrees with the product even when the product is wrong. Keep a hand-written
   copy so the two cross-check each other.
3. **Content-level, not label-level.** "Two entries are separated" was once satisfied by a
   single different banner chip while both entries rendered the same page. Assert the
   *tab set* and the *first-screen content* differ.
4. **Every fix needs a reverse assertion.** Fail-closed is as wrong as fail-open:
   - repo whitelist tightened → a legal `owner/repo` must still advance
   - ownership tightened → a **same-project teammate** must still advance (not just the exporter)
   - real-org export gated → the mock-org default path must remain unblocked
   - a copy/entry removed → the legitimate remaining entry (Fleet chat, Dashboard drill-down)
     must still work
5. **Free-text fields are an injection/PII surface every time.** Any new user-controllable
   string that is echoed back (including a **repo name**) needs masking at egress plus an
   adversarial probe per exit. Scanner floor that has caught real leaks here:
   `+61-412-345-678` (international phone), 7–8 char passport shapes, emails.
6. **Report EXIT, not a mid-run snapshot.** "Full suite green" must mean the runner exited
   with the terminator line in the log. A mid-run count that looks good is not a pass.

---
Maintained by didi (review side). Add to it whenever a probe fails on a false premise —
that is exactly the knowledge this file exists to carry.
