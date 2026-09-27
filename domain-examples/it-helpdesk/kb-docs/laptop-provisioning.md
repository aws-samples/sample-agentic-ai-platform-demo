# Laptop Provisioning Runbook — New Hire Checklist

## Overview

This runbook covers the end-to-end process for provisioning a corporate laptop for a new hire, including imaging, software installation, asset tagging, and delivery. Standard delivery timeline is **5 business days** before the start date.

---

## Pre-Provisioning Requirements

Before starting, confirm the following with HR and the hiring manager:

| Item | Source |
|------|--------|
| Employee full name | Workday onboarding ticket |
| Corporate email address | IT auto-generated (confirm with HR) |
| Department and cost center | Hiring manager |
| Job role (determines software bundle) | Hiring manager |
| Office location or remote address | Onboarding form |
| Start date | Workday |

---

## Hardware Procurement

1. Check laptop inventory in the **Asset Management Portal** (https://assets.acme.internal).
2. If in stock, assign the next available device for the role category:
   - **Standard**: 14" laptop, 16GB RAM, 512GB SSD (most roles)
   - **Developer**: 16" laptop, 32GB RAM, 1TB SSD (engineering, data)
   - **Executive**: Thin & light, 16GB RAM, 512GB SSD + docking station
3. If out of stock, submit a procurement request — allow **10 additional business days**.

---

## Imaging via JAMF (macOS) or SCCM (Windows)

### macOS — JAMF

1. Enroll the device in JAMF Pro (https://jamf.acme.internal):
   - Connect device to corporate Wi-Fi or ethernet.
   - Power on and allow the **Automated Device Enrollment (ADE)** profile to activate.
2. Assign the device to the new employee's pre-staged JAMF account.
3. Apply the appropriate **configuration profile** (maps to job role).
4. JAMF will automatically install the base software bundle (see below).
5. Verify enrollment status in JAMF console — should show "Managed" within 20 minutes.

### Windows — SCCM

1. Boot from the SCCM-imaged USB drive or PXE boot on the corporate network.
2. Select the appropriate **task sequence** for the device role.
3. Enter the employee's AD username when prompted — this binds the device to their account.
4. Imaging takes approximately 45 minutes. Do not interrupt.
5. Verify device appears in SCCM console with status "Installed Successfully".

---

## Software Bundles

| Bundle | Included Applications |
|--------|-----------------------|
| Base (all roles) | Office 365, Slack, Zoom, Chrome, GlobalProtect VPN, CrowdStrike Falcon, 1Password |
| Developer Add-on | VS Code, Docker, Git, AWS CLI, Terraform |
| Finance Add-on | SAP GUI, Tableau, Power BI |
| Design Add-on | Adobe Creative Cloud, Figma Desktop |

Additional software requires a separate request via https://software.acme.internal.

---

## Asset Tagging

1. Affix an **Acme IT asset tag** (barcode label) to the bottom of the laptop.
2. Scan the barcode to register it in the Asset Management Portal.
3. Enter the employee name, email, department, cost center, and delivery address.
4. Set status to **Provisioned — Pending Delivery**.

---

## Delivery

- **On-site start**: Deliver to the office reception desk by Day -1 (day before start date).
- **Remote start**: Ship via FedEx Priority Overnight to the employee's home address. Use the IT shipping account. Provide tracking to the new hire via their personal email (corporate email won't be active yet).

Delivery timeline from provisioning request to delivery: **5 business days** standard.

---

## Day-1 Checklist (Hand to New Hire)

- [ ] Device powered on and logged in with temp credentials
- [ ] Employee sets their own password on first login
- [ ] Duo MFA enrolled (https://duo.acme.internal)
- [ ] GlobalProtect VPN tested
- [ ] Slack workspace joined
- [ ] IT orientation email sent by IT Helpdesk
