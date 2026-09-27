# Incident Escalation Runbook

## Overview

This runbook defines the incident priority framework, SLA commitments, escalation matrix, and war room procedures for Acme IT. All IT staff must follow these definitions consistently.

---

## Priority Definitions

| Priority | Name | Definition | Example |
|----------|------|------------|---------|
| **P1** | Critical | Complete outage affecting business-critical systems or an entire site; data breach suspected | Production API down, VPN gateway unreachable company-wide, active ransomware |
| **P2** | High | Major degradation affecting many users; no workaround available | Email delivery failure for >50 users, core business application slow/unstable |
| **P3** | Medium | Significant impact on an individual or small group; workaround available | Single user cannot access shared drive, printer offline for a team |
| **P4** | Low | Minor inconvenience; request or question with no urgency | Password expiry warning, software installation request |

---

## SLA Table

| Priority | First Response | Status Update Frequency | Target Resolution |
|----------|---------------|------------------------|-------------------|
| **P1**   | 15 minutes     | Every 30 minutes        | 2 hours           |
| **P2**   | 1 hour         | Every 2 hours           | 8 hours           |
| **P3**   | 4 hours        | Once daily              | 3 business days   |
| **P4**   | 1 business day | On request              | 5 business days   |

SLA clock starts when the ticket is opened in ServiceNow. Tickets created outside business hours start the clock at the next business day opening (8am ET), **except P1 which runs 24/7**.

---

## Escalation Matrix

### P1 Escalation (immediately upon identification)

1. **Tier 1** — IT Helpdesk on-call: Opens war room bridge (see below). Pages on-call engineer via PagerDuty.
2. **Tier 2** — On-call Network/Systems Engineer: Joins bridge within 15 minutes.
3. **Tier 3** — IT Director: Notified via SMS within 30 minutes. Joins bridge at T+30 if unresolved.
4. **Exec Notification** — CTO and CISO: Notified via direct call at T+1 hour if unresolved.

### P2 Escalation

1. **Tier 1** — IT Helpdesk: Diagnoses and assigns to appropriate team within 1 hour.
2. **Tier 2** — Relevant engineering team (#network-ops, #sysadmin, #appsupport): Engaged if Tier 1 cannot resolve.
3. **IT Manager**: Auto-notified by ServiceNow at T+4 hours if still open.

### P3/P4 Escalation

- Handled by normal ticket queue rotation.
- P3 tickets unresolved past SLA trigger manager review automatically.

---

## On-Call Rotation

| Role | Schedule | Pager |
|------|----------|-------|
| IT Helpdesk On-Call | 24/7 rotation (weekly) | PagerDuty escalation policy: `acme-it-helpdesk` |
| Network Engineer On-Call | 24/7 rotation (weekly) | PagerDuty: `acme-network` |
| Security On-Call | 24/7 rotation (bi-weekly) | PagerDuty: `acme-security` |

Current on-call roster: https://pagerduty.acme.internal/oncall

---

## War Room Procedures (P1 Only)

1. **Open the bridge**: Dial or join the standing P1 war room: Zoom link is pinned in #incidents Slack channel. Bridge PIN: `8675309#`.
2. **Appoint roles immediately**:
   - **Incident Commander** (IC): Usually IT Director or senior on-call engineer. Makes all decisions.
   - **Communications Lead**: Drafts status updates for #status-page Slack and status.acme.internal.
   - **Scribe**: Documents timeline, actions, and decisions in the ServiceNow war room notes field.
3. **Status page update**: Post initial message within 15 minutes: "We are aware of an issue affecting [system]. Investigation is underway. Next update in 30 minutes."
4. **Resolution**: IC declares all-clear. Scribe closes the bridge and opens a post-mortem ticket (due within 5 business days).

---

## Post-Incident Review

P1 and P2 incidents require a blameless post-mortem within **5 business days**:
- Timeline of events
- Root cause
- Contributing factors
- Action items with owners and due dates

Post-mortem template: https://wiki.acme.internal/post-mortem-template
