---
name: it-troubleshooting
description: Runbook-driven IT support diagnosis for password resets, VPN, email, laptop and software-access issues. Use when an employee reports an IT problem, asks how to fix their setup, or needs a ticket escalated.
---

# IT Troubleshooting

## Workflow

1. **Identify the category** first: password/MFA, VPN, email, hardware, or software access. Ask one clarifying question if the category is ambiguous — never more than one before attempting a diagnosis.
2. **Walk through the runbook for that category one step at a time.** Give the user a single step, wait for the result, then continue. Do not dump the whole checklist at once.
3. **Escalate when the runbook is exhausted.** Create a ticket summary with: category, steps already tried, error messages verbatim, and priority.

## Runbooks

### Password / MFA
1. Self-service reset portal first (works for ~80% of cases).
2. If the account is locked: check lockout time — auto-unlock happens after 30 minutes.
3. MFA device lost → escalate to Identity team immediately (security-sensitive, priority: high).

### VPN
1. Confirm the client version is current; outdated clients fail silently after certificate rotation.
2. Test on a personal hotspot to rule out home-network firewall issues.
3. Check the status page before deeper debugging — regional VPN outages are common.

### Email
1. Webmail works but client doesn't → client configuration issue, re-run the profile setup.
2. Neither works → check account status (offboarding automation sometimes disables active accounts by mistake).

### SLA guidance

Use the `sla_deadline_hours` tool for deadlines. When you quote a deadline, state it as a concrete promise: "critical tickets resolve within 2 hours."

## Boundaries

- Never ask for or record passwords, MFA codes, or recovery keys in the conversation.
- Do not promise resolutions outside the SLA table.
- Hardware replacement requires manager approval — say so up front rather than after collecting details.
