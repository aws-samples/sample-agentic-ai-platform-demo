import { resourceKey } from "./domain-foundation-catalog.mjs";

const esc = value => String(value ?? "").replace(/[&<>"']/g, char =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
const badge = (text, tone = "") => `<span class="chip ${tone}">${esc(text)}</span>`;
const titles = ["Domain & administrator", "Domain resource access", "AWS environment", "Review & initialize"];
const jsonEqual = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function label(status) {
  return ({ SUCCEEDED: "Ready for projects", RUNNING: "Preparing foundation", QUEUED: "Queued",
    FAILED: "Needs attention", READY_FOR_PROJECTS: "Ready for projects" })[status] || "Not verified";
}
function environmentSummary() {
  return `<dl class="df-facts">
    <dt>Identity</dt><dd>Domain group and administrator membership</dd>
    <dt>Resource access</dt><dd>Selected Registry resources, within platform policies</dd>
    <dt>Observability</dt><dd>Environment log groups and scoped telemetry roles</dd>
    <dt>Project setup</dt><dd>Agent blueprint, runtime, integrations and release pipeline are selected later in projects</dd>
  </dl>`;
}
const selectedRefs = (config, field) => config?.[field]
  || (field === "blueprints" && config?.blueprint ? [config.blueprint]
    : field === "models" && config?.model ? [config.model] : []);
function accessSummary(config, applied = {}) {
  return ["blueprints", "models", "resources"].map(field => {
    const refs = selectedRefs(config, field);
    const entries = applied[field] || [];
    const names = refs.map(ref => entries.find(entry => resourceKey(entry.ref) === resourceKey(ref))?.name || ref.id);
    return `<dt>${({ blueprints: "Available agent blueprints", models: "Allowed models", resources: "Tools, MCP & skills" })[field]}</dt><dd>${esc(names.join(", ") || "None enabled")}</dd>`;
  }).join("");
}
function styles() {
  return `<style>
    .df-head{display:flex;justify-content:space-between;align-items:center;gap:16px;flex-wrap:wrap}
    .df-sub{color:var(--muted);max-width:760px;line-height:1.6}
    .df-toolbar,.df-actions{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin:20px 0}
    .df-toolbar input{max-width:380px;margin:0}.df-toolbar select{max-width:230px;margin:0}
    .df-table{overflow-x:auto}.df-table table{min-width:620px}.df-table button{text-align:left}
    .df-stages{display:flex;gap:8px;flex-wrap:wrap;margin:22px 0}.df-stages span{padding:8px 12px;border:1px solid var(--border);border-radius:7px;color:var(--muted)}
    .df-stages .current{border-color:var(--accent);color:var(--accent)}
    .df-facts{display:grid;grid-template-columns:minmax(100px,170px) 1fr;gap:10px 18px;font-size:.86rem}
    .df-facts dt{color:var(--muted)}.df-facts dd{margin:0;overflow-wrap:anywhere}
    .df-options{display:grid;gap:10px;margin:14px 0}.df-option{display:flex;gap:12px;align-items:flex-start;padding:12px;border:1px solid var(--border);border-radius:8px}
    .df-option input{width:auto;margin:4px 0}.df-option label{margin:0;cursor:pointer}
    .df-step{display:flex;justify-content:space-between;gap:14px;padding:14px 0;border-bottom:1px solid var(--border)}
    .df-error{color:var(--err);padding:12px 0;line-height:1.6}.df-notice{padding:12px 16px;border-left:3px solid var(--accent);background:var(--surface2);line-height:1.6}
    .df-grid{display:grid;grid-template-columns:1fr 1fr;gap:18px}.df-grid>*{min-width:0}
    @media(max-width:640px){.df-grid{grid-template-columns:1fr}.df-facts{grid-template-columns:110px 1fr}.df-stages{font-size:.72rem}.df-head h1{font-size:1.65rem}}
  </style>`;
}
async function checked(request, path, body) {
  const result = await request(path, body);
  if (result?.ok !== true) throw new Error(result?.message || result?.error || "The request could not complete.");
  return result;
}
async function loadProjects(request) {
  const items = [], seen = new Set();
  let cursor;
  do {
    const page = await checked(request, `/projects?limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
    if (!Array.isArray(page.items)) throw new Error("Project overview is unavailable.");
    items.push(...page.items);
    cursor = page.cursor;
    if (cursor && (seen.has(cursor) || seen.size >= 100)) throw new Error("Project list is incomplete.");
    seen.add(cursor);
  } while (cursor);
  return items;
}
export function mountDomains(root, { request, actor, registerDirtyGuard = () => {}, onRegistry = () => {} }) {
  let alive = true, timer, domains = [], projects = null, catalog = null, detail = null;
  let wizard = null, saved = null, message = "", filter = "", query = "", loading = true;
  const storageKey = `domain-bootstrap-draft:${actor}`;
  const operationKey = `domain-bootstrap-operation:${actor}`;
  try { detail = sessionStorage.getItem(operationKey) || null; } catch { /* Optional preference. */ }
  const active = () => alive && root.isConnected;
  const dirty = () => Boolean(wizard && !jsonEqual(wizard.config, saved));
  registerDirtyGuard(dirty);
  const run = async fn => {
    try { await fn(); } catch (error) { if (active()) { message = error.message || "Request unavailable."; render(); } }
  };
  function saveDraft() {
    try { sessionStorage.setItem(storageKey, JSON.stringify(wizard.config)); }
    catch { throw new Error("Draft storage is unavailable in this browser."); }
    saved = structuredClone(wizard.config); message = ""; render();
  }
  async function loadCatalog() {
    catalog = await checked(request, "/domain-bootstrap/catalog");
    return catalog;
  }
  async function openWizard() {
    message = "";
    await loadCatalog();
    let config;
    try { config = JSON.parse(sessionStorage.getItem(storageKey)); } catch { /* Storage is optional. */ }
    config ||= { name: "", owner: "", description: "", administrator: "", accountId: catalog.target.accountId,
      region: catalog.target.region, environments: ["dev"], blueprints: [], models: [], resources: [] };
    // Migrate old saved single-agent drafts into the domain resource allowlist.
    config.blueprints = selectedRefs(config, "blueprints");
    config.models = selectedRefs(config, "models");
    delete config.blueprint; delete config.model;
    if (!config.administrator) config.administrator = catalog.defaultAdministrator || "";
    wizard = { step: 0, config, preview: null, submitting: false };
    saved = structuredClone(config);
    render();
  }
  function selectedAdministrator() {
    return catalog?.administrators.find(user => user.username === wizard?.config.administrator);
  }
  function administratorLabel(user) {
    const identity = user.name === user.username ? user.name : `${user.name} (${user.username})`;
    return `${identity}${user.email ? ` · ${user.email}` : ""} · ${
      user.role === "platform-admin" ? "Platform Admin" : user.role === "domain-lead" ? "Domain Admin" : user.role || "No role"
    }${user.eligible === false ? " — unavailable" : ""}`;
  }
  function resourceChoices(field, title, help) {
    const entries = catalog[field];
    const selected = wizard.config[field];
    const missing = selected.filter(ref => !entries.some(entry => resourceKey(entry.ref) === resourceKey(ref)));
    return `<fieldset><legend>${esc(title)}</legend><p class="df-sub">${esc(help)}</p>
      <div class="df-actions"><button class="ghost" data-select-all="${field}">Select all</button>
      <button class="ghost" data-clear-all="${field}">Clear selection</button></div>
      <div class="df-options">${entries.map((entry, index) => `<div class="df-option">
        <input type="checkbox" data-selection="${field}" data-ref="${esc(resourceKey(entry.ref))}" id="df-${field}-${index}"
          ${selected.some(ref => resourceKey(ref) === resourceKey(entry.ref)) ? "checked" : ""}/>
        <label for="df-${field}-${index}">${esc(entry.name)} ${badge(entry.ref.version)}
        ${entry.content.recommended === true ? badge("Recommended · Strands + AgentCore") : ""}
        <div class="df-sub">${esc(entry.description)}</div></label></div>`).join("")
      || `<p class="df-sub">${field === "models"
        ? "No models are registered. Add models in AI Registry, then refresh."
        : "No approved shared resources are available in this category. You can initialize the environment with none enabled."}</p>`}</div>
      ${field === "models" && catalog.modelAvailability ? `<p class="df-sub">${catalog.modelAvailability.discovered} registered · ${catalog.modelAvailability.selectable} available for domain selection.
        Runtime access and quotas are checked before invocation, independently of this selection.</p>` : ""}
      ${missing.map(ref => `<p class="df-error">Selected resource is unavailable or changed: ${esc(ref.id)} · ${esc(ref.version)}
        <button class="ghost" data-remove-selection="${field}" data-ref="${esc(resourceKey(ref))}">Remove selection</button></p>`).join("")}</fieldset>`;
  }
  function wizardBody() {
    const config = wizard.config;
    if (wizard.step === 0) return `<div class="df-grid">
      <div><label for="df-name">Domain name</label><input id="df-name" maxlength="57" value="${esc(config.name)}" placeholder="e.g. Finance"/>
      <label for="df-owner">Business owner (optional)</label><input id="df-owner" maxlength="256" value="${esc(config.owner)}" placeholder="Defaults to the selected administrator"/>
      <p class="df-sub">Leave blank to use the selected administrator, or name the accountable team.</p></div>
      <div><label for="df-admin">Domain administrator</label><select id="df-admin"><option value="">Choose a user</option>
      ${catalog.administrators.map(user => `<option value="${esc(user.username)}" ${config.administrator === user.username ? "selected" : ""} ${!user.enabled || user.eligible === false ? "disabled" : ""}>${esc(administratorLabel(user))}</option>`).join("")}</select>
      <p class="df-sub">Select an existing user to administer this domain. Their current platform role is preserved.</p>
      <p class="df-sub" id="df-admin-role">${selectedAdministrator()?.role === "platform-admin" ? "This user already has Platform Admin access and will retain it." : selectedAdministrator()?.reason || ""}</p>
      <button class="ghost" data-refresh-users>Refresh users</button></div></div>
      <label for="df-description">Description</label><textarea id="df-description" maxlength="2048">${esc(config.description)}</textarea>
      ${catalog.administrators.some(user => user.enabled && user.eligible !== false) ? "" : '<p class="df-notice">No eligible users are available. An enabled Platform Admin or Domain Admin can administer this domain. Refresh users after updating the directory.</p>'}
      <p class="df-sub">A new domain starts with no projects. Its administrator creates projects after onboarding.</p>`;
    if (wizard.step === 1) {
      return `<div class="df-head"><p class="df-sub">Choose the Registry resources this domain's teams may use in their projects. Select multiple resources, or initialize with none enabled.</p><button class="ghost" data-refresh-catalog>Refresh Registry</button></div>
        <p class="df-notice">Agent blueprints are chosen when building agents inside projects. They do not define the domain's AWS environment.</p>
        ${catalog.incomplete ? `<p class="df-notice">Some Registry records could not be read and cannot be selected. Environment initialization can continue with the readable approved selections.${catalog.errors?.length ? ` Reported records: ${esc(catalog.errors.join(", "))}.` : ""}</p>` : ""}
        ${resourceChoices("blueprints", "Available agent blueprints", "Allow these templates for future agent builds. No agent or project is created now.")}
        ${resourceChoices("models", "Allowed models", "Choose any registered models this domain may use. Domain Admins choose project subsets from this set; builders select an agent model later.")}
        ${resourceChoices("resources", "Tools, MCP servers & skills", "Enable approved integrations for project setup. Connections and credentials are bound when an agent is built.")}
        <button class="ghost" data-registry>Open AI Registry</button>`;
    }
    if (wizard.step === 2) return `<div class="df-grid">
      <div><label for="df-account">Connected AWS account</label><input id="df-account" readonly value="${esc(catalog.target.accountId)}"/></div>
      <div><label for="df-region">Region</label><input id="df-region" readonly value="${esc(catalog.target.region)}"/></div>
      </div><p class="df-sub">Initialize this domain's environments in the connected AWS account.</p>
      <div class="df-options">${["dev", "preprod", "prod"].map(environment => `<div class="df-option">
        <input type="checkbox" data-environment="${environment}" id="df-env-${environment}" ${config.environments.includes(environment) ? "checked" : ""} ${environment === "dev" ? "disabled" : ""}/>
        <label for="df-env-${environment}">${esc(environment.toUpperCase())}${environment === "dev" ? " · initial development environment" : ""}</label></div>`).join("")}</div>
      ${environmentSummary()}<p class="df-notice">Each selected environment gets a scoped telemetry role and log destination. Applications, tool connections and production releases are configured in projects.</p>`;
    const preview = wizard.preview;
    const resolved = preview?.resolved || catalog;
    return preview ? `<h3>${esc(preview.config.name)}</h3><dl class="df-facts">
      <dt>Business owner</dt><dd>${esc(config.owner)}</dd><dt>Domain Admin</dt><dd>${esc(selectedAdministrator()?.name || config.administrator)}</dd>
      <dt>Account / region</dt><dd>${esc(config.accountId)} · ${esc(config.region)}</dd>
      <dt>Environments</dt><dd>${esc(config.environments.join(", "))}</dd>
      ${accessSummary(config, resolved)}
      </dl><p class="df-notice">Initialize the domain Registry, administrator membership, selected resource access and AWS environment foundations. No project, agent or application runtime is created.</p>
      ${(preview.warnings || []).map(warning => `<p class="df-notice">${esc(warning.message)}</p>`).join("")}
      <section aria-label="Readiness checks"><h3>Readiness checks</h3>${preview.ready === false
        ? `<ul class="df-error">${preview.blockers.map(blocker => `<li>${esc(blocker.message)}</li>`).join("")}</ul>
          <p class="df-sub">Your configuration is preserved. Resolve these checks, then check again before starting bootstrap.</p>
          <div class="df-actions"><button class="ghost" data-check-again ${wizard.submitting ? "disabled" : ""}>Check again</button><button class="ghost" data-registry>Open AI Registry</button></div>`
        : '<p class="df-sub">Current identity, Registry selections and target checks passed.</p>'}</section>
      <p class="df-sub">The reviewed Registry versions are recorded for this run. New Registry defaults remain visible for future setup.</p>`
      : '<p class="df-sub">Validating the current Registry definitions and configuration…</p>';
  }
  function renderWizard() {
    root.innerHTML = styles() + `<div class="df-head"><h1>Create domain</h1><button class="ghost" data-close>Back to domains</button></div>
      <p class="df-sub">Prepare a business unit for its Domain Admin and builders.</p>
      <div class="df-stages">${titles.map((title, index) => `<span ${index === wizard.step ? 'class="current" aria-current="step"' : ""}>${index + 1}. ${title}</span>`).join("")}</div>
      <div class="card">${wizardBody()}<p role="status" class="${/^(Registry|Users) refreshed\./.test(message) ? "df-sub" : "df-error"}">${esc(message)}</p>
      <div class="df-actions"><button class="ghost" data-save>Save draft</button>
        ${wizard.step ? '<button class="ghost" data-back>Back</button>' : ""}
        <button class="primary" data-next ${wizard.submitting || (wizard.step === 3 && (!wizard.preview?.previewHash || wizard.preview.ready === false)) ? "disabled" : ""}>${wizard.submitting ? "Working…" : wizard.step === 3 ? "Bootstrap domain" : "Continue"}</button></div></div>`;
    root.querySelector("[data-close]").onclick = () => {
      if (dirty() && !confirm("Discard unsaved changes and return to domains?")) return;
      wizard = null; message = ""; render();
    };
    root.querySelector("[data-save]").onclick = () => run(async () => saveDraft());
    root.querySelector("[data-back]")?.addEventListener("click", () => { wizard.step--; message = ""; render(); });
    root.querySelector("[data-registry]")?.addEventListener("click", () => onRegistry());
    for (const [id, field] of [["df-name", "name"], ["df-owner", "owner"], ["df-description", "description"], ["df-admin", "administrator"]]) {
      root.querySelector(`#${id}`)?.addEventListener("input", event => { wizard.config[field] = event.target.value; wizard.preview = null; });
    }
    root.querySelector("#df-admin")?.addEventListener("change", event => {
      wizard.config.administrator = event.target.value;
      const user = selectedAdministrator();
      root.querySelector("#df-admin-role").textContent = user?.role === "platform-admin"
        ? "This user already has Platform Admin access and will retain it." : user?.reason || "";
    });
    root.querySelector("[data-refresh-users]")?.addEventListener("click", () => run(async () => {
      await loadCatalog(); wizard.preview = null; message = "Users refreshed. Your draft is preserved."; render();
    }));
    root.querySelectorAll("[data-selection]").forEach(input => input.onchange = () => {
      const field = input.dataset.selection;
      const selected = catalog[field].find(entry => resourceKey(entry.ref) === input.dataset.ref);
      wizard.config[field] = wizard.config[field].filter(ref => resourceKey(ref) !== input.dataset.ref);
      if (input.checked && selected) wizard.config[field].push(selected.ref);
      wizard.preview = null;
    });
    root.querySelectorAll("[data-select-all]").forEach(button => button.onclick = () => {
      const field = button.dataset.selectAll;
      wizard.config[field] = catalog[field].map(entry => entry.ref);
      wizard.preview = null; render();
    });
    root.querySelectorAll("[data-clear-all]").forEach(button => button.onclick = () => {
      wizard.config[button.dataset.clearAll] = [];
      wizard.preview = null; render();
    });
    root.querySelectorAll("[data-remove-selection]").forEach(button => button.onclick = () => {
      const field = button.dataset.removeSelection;
      wizard.config[field] = wizard.config[field].filter(ref => resourceKey(ref) !== button.dataset.ref);
      wizard.preview = null; render();
    });
    root.querySelectorAll("[data-environment]").forEach(input => input.onchange = () => {
      wizard.config.environments = [...root.querySelectorAll("[data-environment]:checked")].map(input => input.dataset.environment); wizard.preview = null;
    });
    root.querySelector("[data-refresh-catalog]")?.addEventListener("click", () => run(async () => {
      await loadCatalog(); wizard.preview = null; message = "Registry refreshed. Review your selections."; render();
    }));
    root.querySelector("[data-check-again]")?.addEventListener("click", () => run(async () => {
      wizard.submitting = true; message = ""; render();
      try {
        await loadCatalog();
        wizard.preview = await checked(request, "/domain-bootstrap/preview", wizard.config);
      } finally { wizard.submitting = false; }
      render();
    }));
    root.querySelector("[data-next]").onclick = () => run(async () => {
      message = "";
      if (wizard.step === 0) {
        wizard.config.name = wizard.config.name.trim();
        if (!wizard.config.name) throw new Error("Enter a domain name.");
        const user = selectedAdministrator();
        if (!user?.enabled || user.eligible === false) throw new Error("Choose an available domain administrator.");
        wizard.config.owner = wizard.config.owner.trim() || user.name || user.username;
      }
      if (wizard.step < 2) { wizard.step++; render(); return; }
      wizard.submitting = true; render();
      try {
        if (wizard.step === 2) {
          wizard.preview = await checked(request, "/domain-bootstrap/preview", wizard.config);
          wizard.step = 3;
        } else {
          if (!wizard.preview?.previewHash || wizard.preview.ready === false) throw new Error("Resolve the readiness checks before starting bootstrap.");
          try { sessionStorage.setItem(operationKey, wizard.config.name.trim().toLowerCase().replace(/[ _-]+/g, "_")); } catch { /* Optional preference. */ }
          const result = await checked(request, "/domain-bootstrap", { configuration: wizard.config, previewHash: wizard.preview.previewHash });
          try { sessionStorage.removeItem(storageKey); } catch { /* Optional storage. */ }
          detail = result.operation.domainId; wizard = null; saved = null; message = "";
          await refresh();
          return;
        }
      } finally { if (wizard) wizard.submitting = false; }
      render();
    });
  }
  let operation = null;
  async function refresh() {
    if (detail) {
      const result = await checked(request, `/domain-bootstrap?domainId=${encodeURIComponent(detail)}`);
      operation = result.operation;
    }
    const domainResponse = await checked(request, "/domains");
    if (!Array.isArray(domainResponse.domains)) throw new Error("Domain directory is unavailable.");
    domains = domainResponse.domains;
    try { projects = await loadProjects(request); } catch { projects = null; }
    loading = false;
    render();
    clearTimeout(timer);
    if (detail && ["RUNNING", "QUEUED"].includes(operation?.status)) timer = setTimeout(() => { if (active()) run(refresh); }, 4000);
  }
  function renderDetail() {
    const domain = domains.find(domain => domain.id === detail);
    const ownProjects = projects?.filter(project => project.domainId === detail);
    root.innerHTML = styles() + `<button class="ghost" data-back-list>← Domains</button>
      <div class="df-head"><h1>${esc(domain?.name || operation?.configuration.name || detail)}</h1>${badge(label(operation?.status))}</div>
      <p class="df-sub">${esc(domain?.description || operation?.configuration.description || "")}</p>
      <div class="df-grid"><section class="card"><h3>Ownership & foundation</h3><dl class="df-facts">
        <dt>Business owner</dt><dd>${esc(domain?.owner || operation?.configuration.owner || "Not assigned")}</dd>
        <dt>Domain Admin</dt><dd>${esc(operation?.configuration.administrator || "See Users & Access")}</dd>
        <dt>Identity group</dt><dd>${esc(domain?.ownerGroup || "Pending")}</dd>
        <dt>Account</dt><dd>${esc(operation?.configuration.accountId || "Not verified")}</dd>
        </dl>${operation ? `${environmentSummary()}<h3>Initial domain resource access</h3><dl class="df-facts">${accessSummary(operation.configuration, operation.applied)}</dl>
        <p class="df-sub">These are the initial access selections. Registry content stays in AI Registry; current approval and access policies are rechecked when resources are used.</p>`
        : '<p class="df-sub">This existing domain has no recorded initialization run.</p>'}</section>
        <section class="card"><h3>Environments</h3>${["dev", "preprod", "prod"].map(name => {
          const env = operation?.outputs.environments?.find(environment => environment.name === name);
          return `<div class="df-step"><b>${name.toUpperCase()}</b>${badge(env ? label(env.status) : "Not configured")}</div>`;
        }).join("")}<p class="df-sub">Environment readiness describes foundation setup. Production application releases still require approval.</p></section></div>
      ${operation ? `<section class="card"><div class="df-head"><h3>Bootstrap progress</h3><button class="ghost" data-refresh>Refresh</button></div>
        ${operation.steps.map(step => `<div class="df-step"><span>${esc(step.label)}</span>${badge(step.status.toLowerCase())}</div>`).join("")}
        ${operation.error ? `<p class="df-error" role="alert">${esc(operation.error)}</p><button data-retry>Retry bootstrap</button>` : ""}
        ${operation.status === "SUCCEEDED" ? '<p class="df-notice">Foundation verified. The assigned Domain Admin can sign in, open this domain and create its first project.</p>' : ""}</section>` : ""}
      <section class="card"><h3>Projects ${ownProjects ? badge(ownProjects.length) : ""}</h3>
      ${ownProjects === undefined ? '<p class="df-sub">Project overview is unavailable.</p>' : ownProjects.length
        ? `<div class="df-table"><table><thead><tr><th>Project</th><th>Owner</th><th>Status</th></tr></thead><tbody>${ownProjects.map(project =>
          `<tr><td>${esc(project.name)}</td><td>${esc(project.ownerSubject || "Not assigned")}</td><td>${esc(project.status)}</td></tr>`).join("")}</tbody></table></div>`
        : '<p class="df-sub">No projects yet. The Domain Admin creates projects inside this domain.</p>'}</section>
      <p role="alert" class="df-error">${esc(message)}</p>`;
    root.querySelector("[data-back-list]").onclick = () => {
      try { sessionStorage.removeItem(operationKey); } catch { /* Optional preference. */ }
      detail = null; operation = null; clearTimeout(timer); message = ""; render();
    };
    root.querySelector("[data-refresh]")?.addEventListener("click", () => run(refresh));
    root.querySelector("[data-retry]")?.addEventListener("click", () => run(async () => {
      await checked(request, "/domain-bootstrap/retry", { domainId: detail }); await refresh();
    }));
  }
  function render() {
    if (!active()) return;
    if (wizard) { renderWizard(); return; }
    if (detail) { renderDetail(); return; }
    const visible = domains.filter(domain => (filter !== "business" || domain.id !== "platform")
      && `${domain.name} ${domain.owner || ""}`.toLowerCase().includes(query.toLowerCase()));
    root.innerHTML = styles() + `<div class="df-head"><div><span class="roletag plat">Platform administration</span><h1>Domains</h1></div>
      <button class="primary" data-create-domain>Create domain</button></div>
      <p class="df-sub">Onboard business units, prepare their foundations and hand over to Domain Admins.</p>
      <div class="df-toolbar"><input aria-label="Search domains" id="df-search" placeholder="Search by domain or owner" value="${esc(query)}"/>
      <select aria-label="Domain type" id="df-filter"><option value="">All domains</option><option value="business" ${filter === "business" ? "selected" : ""}>Business domains</option></select><button class="ghost" data-refresh>Refresh</button></div>
      <section class="card df-table">${loading ? '<p role="status">Loading domains…</p>' : `<table><thead><tr><th>Domain</th><th>Owner</th><th>Projects</th><th>Identity group</th><th></th></tr></thead>
      <tbody>${visible.map(domain => `<tr><td><b>${esc(domain.name)}</b>${domain.id === "platform" ? ` ${badge("Platform-owned")}` : ""}<div class="df-sub">${esc(domain.description || "")}</div></td>
      <td>${esc(domain.owner || "Not assigned")}</td><td>${projects ? projects.filter(project => project.domainId === domain.id).length : "Unavailable"}</td>
      <td>${esc(domain.ownerGroup || "Not assigned")}</td><td><button class="ghost" data-open="${esc(domain.id)}">Open domain →</button></td></tr>`).join("") || '<tr><td colspan="5">No matching domains.</td></tr>'}</tbody></table>`}</section>
      <p role="alert" class="df-error">${esc(message)}</p>`;
    root.querySelector("[data-create-domain]").onclick = () => run(openWizard);
    root.querySelector("[data-refresh]").onclick = () => run(refresh);
    root.querySelector("#df-search").onchange = event => { query = event.target.value; render(); };
    root.querySelector("#df-filter").onchange = event => { filter = event.target.value; render(); };
    root.querySelectorAll("[data-open]").forEach(button => button.onclick = () => run(async () => { detail = button.dataset.open; operation = null; await refresh(); }));
  }
  render(); run(refresh);
  return () => { alive = false; clearTimeout(timer); registerDirtyGuard(() => false); };
}

export async function mountDomainFoundation(root, { request, domainId }) {
  try {
    const { operation } = await checked(request, `/domain-bootstrap?domainId=${encodeURIComponent(domainId)}`);
    if (!root.isConnected || !operation) return;
    root.innerHTML = styles() + `<section class="card"><div class="df-head"><h3>Domain foundation</h3>${badge(label(operation.status))}</div>
      <p class="df-sub">Prepared by the platform for ${esc(operation.configuration.name)}. Projects inherit this domain's identity and resource policies.</p>
      <dl class="df-facts"><dt>Account / region</dt><dd>${esc(operation.configuration.accountId)} · ${esc(operation.configuration.region)}</dd>
      ${accessSummary(operation.configuration, operation.applied)}</dl>
      ${environmentSummary()}
      <div class="df-actions">${["dev", "preprod", "prod"].map(name => badge(`${name}: ${operation.outputs.environments?.some(environment => environment.name === name) ? "foundation ready" : "not configured"}`)).join("")}</div></section>`;
  } catch {
    if (root.isConnected) root.innerHTML = '<p class="df-sub">Domain foundation status is unavailable. Refresh to try again.</p>';
  }
}
