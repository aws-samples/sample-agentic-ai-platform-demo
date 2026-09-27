// Offline contracts only: trusted synthetic authorizer claims, no cloud calls.
import assert from "node:assert/strict";
import test from "node:test";
import { createApiHandler } from "../lambda/api/index.mjs";
import { projectIdentity, projectEffectiveIdentity } from "../lambda/api/identity.mjs";
import { capabilitiesForRole } from "../lambda/authz/capabilities.mjs";
import { createAuthorizer } from "../lambda/authz/authorize.mjs";
import { createProductionIdentityProjector } from "../lambda/workspace/runtime.mjs";

const claims = {
  sub: "offline-lead",
  token_use: "access",
  "cognito:groups": ["domain-lead", "domain-operations"],
};
const project = (value = claims, headers = {}) =>
  projectEffectiveIdentity(value, headers, { demoOperatorAuthorized: false });
const handler = createApiHandler({
  demoOperatorVerifier: () => assert.fail("Ordinary identity must not query demo authority"),
  domainState: { listDomains: async () => [{ id: "operations", name: "Synthetic Operations", status: "ACTIVE" }] },
});
const event = (value = claims, headers = {}) => ({
  routeKey: "GET /api/me",
  headers,
  requestContext: {
    http: { method: "GET", path: "/api/me" },
    authorizer: { jwt: { claims: value } },
  },
});
test("ordinary domain-lead projects the existing scoped Lead bundle without demo authority", () => {
  const identity = project();
  assert.equal(identity.role, "lead");
  assert.equal(identity.authenticatedRole, "lead");
  assert.equal(identity.domain, "operations");
  assert.deepEqual(identity.domains, ["operations"]);
  assert.deepEqual(identity.capabilities, [...capabilitiesForRole("lead")]);
  assert.equal(identity.canSwitchDemoRole, false);
  assert.equal(identity.demoRoleActive, false);
  assert.equal(identity.assumedRole, null);
  for (const capability of ["approveRegistryVersion", "managePlatformPolicy", "approvePlatformPublication"]) {
    assert.equal(identity.capabilities.includes(capability), false);
  }
});
test("Lead group alone grants no domain, absent or ambiguous scope fails safely", () => {
  const value = { ...claims, "cognito:groups": ["domain-lead"] };
  assert.deepEqual(projectIdentity(value).domains, []);
  assert.throws(() => project(value), { code: "DEMO_DOMAIN_REQUIRED" });
  const multiple = { ...claims, "cognito:groups": [...claims["cognito:groups"], "domain-platform"] };
  assert.throws(() => project(multiple), { code: "DEMO_DOMAIN_REQUIRED" });
  assert.equal(project(multiple, { "x-active-domain": "platform" }).domain, "platform");
});
test("conflicting permanent role groups retain empty-capability default", () => {
  for (const group of ["platform-admin", "domain-builder", "end-user"]) {
    const identity = projectIdentity({ ...claims, "cognito:groups": [...claims["cognito:groups"], group] });
    assert.equal(identity.role, "user");
    assert.deepEqual(identity.capabilities, []);
    assert.deepEqual(identity.domains, []);
  }
});
test("ordinary Lead cannot select foreign scope or elevate with demo headers", () => {
  assert.throws(() => project(claims, { "x-active-domain": "foreign" }), { code: "DEMO_DOMAIN_NOT_ALLOWED" });
  assert.throws(() => project(claims, { "x-demo-role": "admin" }), { code: "DEMO_ROLE_NOT_ALLOWED" });
  assert.equal(project(claims, { role: "admin", "x-role": "admin" }).role, "lead");
});
test("/me ordinary Lead uses only authorizer claims and returns no demo selectors", async () => {
  const input = event(claims, { role: "admin" });
  input.body = JSON.stringify({ role: "admin", domain: "foreign" });
  input.queryStringParameters = { role: "admin" };
  const response = await handler(input);
  assert.equal(response.statusCode, 200);
  const body = JSON.parse(response.body);
  assert.equal(body.role, "lead");
  assert.equal(body.domain, "operations");
  assert.deepEqual(body.availableDemoDomains, []);
  assert.deepEqual(body.availableDemoRoles, []);
  assert.deepEqual(body.capabilities, [...capabilitiesForRole("lead")]);
});
test("/me rejects missing authorizer, invalid token, foreign domain and demo-role forgery", async () => {
  const missing = event(); delete missing.requestContext.authorizer;
  for (const input of [
    missing, event({ ...claims, token_use: "id" }),
    event(claims, { "x-active-domain": "foreign" }),
    event(claims, { "x-demo-role": "lead" }),
  ]) assert.ok([401, 403].includes((await handler(input)).statusCode));
});
test("production projector and unchanged authorize policy permit scoped Lead reads, deny foreign/admin work", async () => {
  const identity = createProductionIdentityProjector().projectEffective(claims, {}, { demoOperatorAuthorized: false });
  assert.equal(identity.role, "lead");
  for (const [action, domainId, expected] of [
    ["workspace.projects.read", "operations", "ALLOW"],
    ["access.domain-members.read", "operations", "ALLOW"],
    ["workspace.projects.read", "foreign", "NOT_FOUND"],
    ["access.domain-members.grant", "foreign", "NOT_FOUND"],
    ["platform-policy:update", "operations", "FORBIDDEN"],
  ]) {
    const authorize = createAuthorizer({
      resolvePrincipal: async () => ({ id: identity.actor, role: identity.role, domainIds: identity.domains, activeDomain: identity.domain, projectIds: [] }),
      resolveResource: async () => ({ id: "offline-project", domainId, projectId: "offline-project", ownerId: "offline-builder", assigneeIds: [], lifecycleState: "ACTIVE" }),
      resolvePolicy: async () => ({ allowed: true }),
      clock: () => Date.parse("2026-09-12T00:00:00Z"),
    });
    const pending = authorize({ requestContext: {}, action, resourceRef: "offline-resource" });
    if (expected === "ALLOW") assert.equal((await pending).decision, expected, action);
    else await assert.rejects(pending, error => error.decision === expected, action + "/" + domainId);
  }
});
test("ordinary admin, builder and user projections remain compatible", () => {
  for (const [group, role] of [["platform-admin", "admin"], ["domain-builder", "builder"], ["end-user", "user"]]) {
    const identity = project({ ...claims, "cognito:groups": [group, "domain-operations"] });
    assert.equal(identity.role, role);
    assert.deepEqual(identity.capabilities, [...capabilitiesForRole(role)]);
    assert.equal(identity.canSwitchDemoRole, false);
  }
});
