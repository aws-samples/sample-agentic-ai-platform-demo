# Registry tab correction on the new account 820 Console

Target: 820242898417 / us-west-2, https://d35q3a338iunvm.cloudfront.net.

The deployed assets matched main 607ab2d. PR #65 was still open and its fix
was absent from that deployment. After Registry loading, wireRegistryControls
replaced the normal resource click handler with a list-only reload. On the real
Console, selecting Skill after Blueprint loaded Skill rows but retained the
Blueprint highlight.

The fix removes that duplicate binding so the normal state/render path owns
selection, and uses native buttons with aria-pressed and a visible selected
border. Browser regression checks cover all seven resource types, list filtering,
search refresh and keyboard activation across admin, lead and builder personas.
These automated role checks use synthetic APIs, not live role identities.

Deployment was limited to modules/app.mjs and styles/app.css on the existing
Web asset bucket, with exact pre-change ETag conditions and prior object backups.
No infrastructure, runtime config, user data, API or other AWS account changed.
CloudFront invalidation I7TIE2CIK3I4T8E2FQ8441I63 completed; both public assets
match the patched source byte-for-byte.

Default predeployment audit passed. Strict postdeployment audit still fails on
the previously recorded control-plane boundary/source mismatch. This UI fix does
not resolve that issue or certify the entire installation for production.

During the browser refresh, the current URL returned an XML AccessDenied page;
returning to the Console root restored the app/authentication flow. Deep-link
refresh behavior requires a separate routing investigation.

Live acceptance after publication: the existing platform-admin session on the
new Console passed Agent, A2AAgent, MCPServer, Skill, Blueprint, Model and All.
Each tab had exactly one matching aria-pressed selection; non-model filtered
tables contained only the selected type. Model displayed its separate model
inventory. The owner workspace retains sanitized live-tabs.json evidence.
