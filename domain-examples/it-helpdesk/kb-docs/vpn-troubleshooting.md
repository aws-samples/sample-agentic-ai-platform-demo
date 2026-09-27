# VPN Troubleshooting Runbook — GlobalProtect

## Overview

This runbook covers GlobalProtect VPN connection issues. GlobalProtect is the corporate VPN solution. All remote work requires VPN connectivity to access internal resources.

**VPN Gateway**: vpn.corp.acme.internal  
**Portal Address**: vpn.corp.acme.internal  
**Support Escalation**: #it-helpdesk Slack or x4357

---

## Initial Connection Steps

1. Open **GlobalProtect** from the system tray (Windows) or menu bar (macOS).
2. If prompted for a portal address, enter: `vpn.corp.acme.internal`
3. Enter your **corporate email** as the username.
4. Enter your **Active Directory password** (the same password used for your computer login).
5. Complete **MFA** via the Duo Mobile prompt (approve the push notification or enter a TOTP code).
6. Status should change to **Connected** within 30 seconds.

---

## Common Errors and Resolutions

### Error: "Authentication Failed"

**Symptoms**: "Authentication failed" or "Invalid credentials" at login.

**Steps**:
1. Confirm you are using your full email (`jsmith@acme.com`), not just your username.
2. Verify caps lock is not on.
3. Try resetting your password at https://password.acme.internal (accessible without VPN).
4. If MFA is the failure point, re-enroll Duo at https://duo.acme.internal.
5. If still failing, check with IT whether your account is locked (see Password Reset Runbook).

### Error: "Unable to Connect to Gateway" / Tunnel Error

**Symptoms**: "Cannot reach gateway", "Tunnel error", or spinning indefinitely.

**Steps**:
1. Check internet connectivity — open acmeretail.com in a browser.
2. If on hotel/airport Wi-Fi, try toggling the "Connect Before Login" option OFF.
3. Disable any personal firewall or antivirus temporarily and retry.
4. Try switching from automatic gateway selection to a named gateway:
   - Click the gear icon > Preferences > General
   - Set Gateway to `us-west-vpn.corp.acme.internal` or `us-east-vpn.corp.acme.internal`
5. Flush DNS: run `ipconfig /flushdns` (Windows) or `sudo dscacheutil -flushcache` (macOS).
6. Restart the GlobalProtect service:
   - Windows: `services.msc` > GlobalProtect > Restart
   - macOS: `sudo launchctl stop com.paloaltonetworks.gp.pangpa`

### Error: "Pre-logon Tunnel Failed"

**Symptoms**: Computer reports "Connected" but no internal resources are reachable.

**Steps**:
1. Disconnect and reconnect GlobalProtect.
2. If the issue persists, uninstall and reinstall GlobalProtect (download from software.acme.internal).
3. Submit a ticket — this may require a certificate re-enrollment.

### Split Tunneling Issues

Split tunneling is **disabled by default** on Acme corporate devices. All traffic routes through VPN. If you need access to a local resource (printer, NAS) that conflicts:
1. Submit a request for split-tunnel exemption at https://requests.acme.internal.
2. Exemptions require manager approval and Security team sign-off.

---

## Escalation Path

| Tier | Who | When |
|------|-----|------|
| Tier 1 | IT Helpdesk | First contact; steps above |
| Tier 2 | Network team (#network-ops) | Gateway unreachable from multiple users |
| Tier 3 | Security (CISO team) | Suspected compromise or certificate issue |

Escalate to Tier 2 if three or more users report the same gateway issue simultaneously — likely a gateway outage, not a client issue.
