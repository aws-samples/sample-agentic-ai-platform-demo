// Guardrails tab — the org guardrail policy surface.
// Renders the versioned guardrail policy document (guardrails-policy.json,
// shipped with every console deployment) exactly as governed: org defaults
// locked on, domain strengthen-only additions, the configurable runtime
// catalog projects compose from, and the enforcement contract. This view is
// static-policy truth, not runtime verification — it never claims a deployed
// Bedrock guardrail binding it cannot see.
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))

export function validGuardrailPolicy(doc) {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return false
  if (doc.schemaVersion !== 1) return false
  if (typeof doc.defaultPackId !== 'string' || !doc.defaultPackId) return false
  const namedRow = row => row && typeof row === 'object' && !Array.isArray(row)
    && typeof row.id === 'string' && row.id && typeof row.name === 'string' && row.name
  if (!Array.isArray(doc.guardrails) || !doc.guardrails.length || !doc.guardrails.every(namedRow)) return false
  if (!Array.isArray(doc.packs) || !doc.packs.every(p => namedRow(p) && Array.isArray(p.guardrails))) return false
  const pack = doc.packs.find(p => p.id === doc.defaultPackId)
  if (!pack) return false
  const known = new Set(doc.guardrails.map(g => g.id))
  if (!pack.guardrails.every(id => known.has(id))) return false
  if (!Array.isArray(doc.domainOptions) || !doc.domainOptions.every(namedRow)) return false
  if (!Array.isArray(doc.catalog) || !doc.catalog.every(row => namedRow(row)
    && typeof row.defaultAction === 'string' && typeof row.defaultRunMode === 'string')) return false
  if (!doc.enforcement || typeof doc.enforcement !== 'object') return false
  return true
}

const lockBadge = '<span class="badge badge-grey" title="Org default — cannot be removed or weakened">Locked on</span>'
const addBadge = '<span class="badge badge-blue">Strengthen-only</span>'

function describe(row) {
  return typeof row.description === 'string' && row.description.trim()
    ? `<p class="d">${esc(row.description)}</p>` : ''
}

export function guardrailPolicyView(doc) {
  if (!validGuardrailPolicy(doc)) throw new Error('Guardrail policy document is invalid')
  const pack = doc.packs.find(p => p.id === doc.defaultPackId)
  const byId = new Map(doc.guardrails.map(g => [g.id, g]))
  const orgRows = pack.guardrails.map(id => byId.get(id))
  return `
  <div class="card">
    <div class="sec-h" style="margin-top:0">Org default pack ${lockBadge}</div>
    <p class="d" style="margin-bottom:12px">Pack <b>${esc(pack.name)}</b> is attached to every project at creation. ${esc(doc.enforcement.orgDefaults || '')}</p>
    <div style="overflow-x:auto"><table>
      <thead><tr><th style="width:32%">Guardrail</th><th>What it enforces</th><th style="width:14%">Scope</th></tr></thead>
      <tbody>${orgRows.map(g => `<tr>
        <td><b>${esc(g.name)}</b><div class="d" style="font-size:.72rem;color:var(--muted)"><code>${esc(g.id)}</code></div></td>
        <td class="d">${esc(g.description || 'Not documented')}</td>
        <td>${lockBadge}</td>
      </tr>`).join('')}</tbody>
    </table></div>
  </div>
  <div class="card">
    <div class="sec-h" style="margin-top:0">Domain additions ${addBadge}</div>
    <p class="d" style="margin-bottom:12px">${esc(doc.enforcement.domainAdditions || '')} Domain leads pick from this reviewed list; additions never replace the org defaults above.</p>
    <div style="overflow-x:auto"><table>
      <thead><tr><th style="width:32%">Guardrail</th><th>What it adds</th></tr></thead>
      <tbody>${doc.domainOptions.map(g => `<tr>
        <td><b>${esc(g.name)}</b><div class="d" style="font-size:.72rem;color:var(--muted)"><code>${esc(g.id)}</code></div></td>
        <td class="d">${esc(g.description || 'Not documented')}</td>
      </tr>`).join('')}</tbody>
    </table></div>
  </div>
  <div class="card">
    <div class="sec-h" style="margin-top:0">Configurable runtime controls</div>
    <p class="d" style="margin-bottom:12px">${esc(doc.enforcement.projectConfiguration || '')} Defaults below apply until a project overrides action or run mode.</p>
    <div style="overflow-x:auto"><table>
      <thead><tr><th style="width:26%">Control</th><th>Purpose</th><th style="width:13%">Default action</th><th style="width:20%">Default run mode</th></tr></thead>
      <tbody>${doc.catalog.map(g => `<tr>
        <td><b>${esc(g.name)}</b><div class="d" style="font-size:.72rem;color:var(--muted)"><code>${esc(g.id)}</code></div></td>
        <td class="d">${esc(g.description || 'Not documented')}</td>
        <td><span class="badge ${g.defaultAction === 'Block' ? 'badge-red' : g.defaultAction === 'Flag' ? 'badge-orange' : 'badge-grey'}">${esc(g.defaultAction)}</span></td>
        <td class="d">${esc(g.defaultRunMode)}</td>
      </tr>`).join('')}</tbody>
    </table></div>
  </div>
  <div class="card">
    <div class="sec-h" style="margin-top:0">Exemptions</div>
    <p class="d">${esc(doc.enforcement.exemptions || '')} Pending exemption requests appear in <b>Approval requests</b>.</p>
  </div>`
}
