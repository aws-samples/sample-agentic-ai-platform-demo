# Password Reset Runbook

## Overview

This runbook covers password resets for corporate Active Directory accounts, including self-service options, IT-assisted resets, account unlocks, and MFA re-enrollment. **Never ask a user for their password or MFA codes.**

---

## Self-Service Password Reset (SSPR)

Users who have registered their mobile number or personal email with SSPR can reset their own password without calling IT.

1. Navigate to: https://sspr.acme.internal (accessible without VPN or corporate network).
2. Enter your **corporate email address**.
3. Choose a verification method:
   - **Text message** to your registered mobile
   - **Email** to your registered personal address
   - **Authenticator app** (Microsoft Authenticator or Duo)
4. Enter the verification code received.
5. Choose a **new password** that meets complexity requirements:
   - Minimum 12 characters
   - At least one uppercase, one lowercase, one digit, one special character
   - Cannot match any of the last 10 passwords
6. Sign in with the new password.

If SSPR is not set up for your account, proceed to the IT-Assisted section below.

---

## IT-Assisted Password Reset

Only IT Helpdesk agents may perform a managed password reset. Never reset a password over chat without verifying identity.

### Identity Verification Steps (Required)

Before performing ANY reset, verify the user via **two** of the following:
1. Employee ID number
2. Manager's name
3. Last four digits of employee mobile on file
4. Answer to security question registered in HR system

Do NOT proceed with reset if fewer than two factors are confirmed.

### Reset Procedure

1. In the IT Admin Portal (https://admin.acme.internal), search for the user by email.
2. Select **Reset Password** and choose **Force Reset at Next Login**.
3. Generate a **temporary password** (use the portal's generator — do not create your own).
4. Deliver the temporary password **via a secure channel only**:
   - Call the user directly on their registered mobile number
   - Send via the encrypted HR messaging portal (never via email or Slack)
5. Instruct the user to sign in and change the password immediately.
6. Log the reset action in the ServiceNow ticket.

---

## Active Directory Account Unlock

Accounts lock after **5 failed login attempts** (policy: 30-minute auto-unlock).

To unlock manually before auto-unlock:
1. In Active Directory Users and Computers (ADUC), find the user account.
2. Right-click > **Unlock Account** (checkbox in Account tab).
3. Note: unlocking does **not** reset the password — a separate reset is needed if the user forgot it.

---

## MFA Reset

If a user has lost access to their MFA device:
1. Verify identity using the same two-factor verification above.
2. Temporarily disable MFA for the account in the Duo Admin Panel (https://duo.acme.internal/admin).
3. Instruct the user to sign in and re-enroll a new device at https://duo.acme.internal.
4. Re-enable MFA enforcement immediately after re-enrollment is confirmed.
5. Log in ServiceNow with reason and approver.

---

## Security Reminders

- **Never share passwords** — not even with IT staff.
- **Phishing warning**: IT will never ask for your password via email, Slack, or phone.
- Passwords must be changed every **180 days**; the system enforces this automatically.
- Suspicious password reset requests should be escalated to the Security team.
