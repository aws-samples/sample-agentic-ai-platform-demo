import assert from "node:assert/strict";
import test from "node:test";
import { ROLE_CAPABILITY_BUNDLES } from "../lambda/authz/capabilities.mjs";
import * as identity from "../lambda/api/identity.mjs";

const {
  groupsFromClaims,
  projectIdentity,
} = identity;

const canonicalBundles = Object.fromEntries(
  Object.entries(ROLE_CAPABILITY_BUNDLES).map(
    ([role, capabilities]) => [role, { capabilities }],
  ),
);

const demoOperatorClaims = {
  sub: "operator-sub",
  "cognito:username": "operator-user",
  token_use: "access",
  "cognito:groups": [
    "platform-admin",
    "demo-operator",
    "domain-platform",
  ],
};

const availableDomains = [
  { id: "customer_support", name: "Customer Support" },
  { id: "operations", name: "Operations" },
];

const demoRoles = ["admin", "lead", "builder", "user"];

function cognitoUser({
  enabled = true,
  sub = "operator-sub",
  username = "operator-user",
} = {}) {
  return {
    Username: username,
    Enabled: enabled,
    UserStatus: "CONFIRMED",
    UserAttributes: [
      { Name: "sub", Value: sub },
    ],
  };
}

function isIdentityScopeError(code) {
  return (error) =>
    error instanceof identity.IdentityScopeError
    && error.code === code
    && error.statusCode === 403
    && error.retryable === false;
}

test("groupsFromClaims normalizes recognized Cognito array groups", () => {
  assert.deepEqual(
    groupsFromClaims({
      "cognito:groups": [
        " platform-admin ",
        123,
        "unknown",
        "domain-builder",
        null,
        " end-user ",
      ],
    }),
    ["platform-admin", "domain-builder", "end-user"],
  );
});

test("groupsFromClaims normalizes recognized serialized array groups", () => {
  assert.deepEqual(
    groupsFromClaims({
      "cognito:groups":
        "[\" domain-builder \",42,\"unknown\",\" end-user \",\"platform-admin\"]",
    }),
    ["domain-builder", "end-user", "platform-admin"],
  );
});

test("groupsFromClaims accepts whitespace-delimited groups", () => {
  assert.deepEqual(
    groupsFromClaims({
      "cognito:groups": "unknown, end-user domain-builder",
    }),
    ["end-user", "domain-builder"],
  );
});

test("projectIdentity parses strict dynamic domain groups", () => {
  const projected = projectIdentity({
    sub: "admin-with-domains",
    "cognito:groups": [
      "platform-admin",
      "domain-platform",
      "domain-customer-support",
      "domain-finance",
      "domain-",
      "domain-../../admin",
      "unknown",
    ],
  });

  assert.equal(projected.role, "admin");
  assert.deepEqual(projected.groups, [
    "platform-admin",
    "domain-platform",
    "domain-customer-support",
    "domain-finance",
  ]);
  assert.deepEqual(
    projected.domains,
    ["platform", "customer_support", "finance"],
  );
});

test("groupsFromClaims ignores inherited Cognito groups", () => {
  const claims = Object.create({
    "cognito:groups": ["platform-admin", "domain-platform"],
  });
  claims.sub = "own-user";

  assert.deepEqual(groupsFromClaims(claims), []);
  assert.equal(projectIdentity(claims).role, "user");
  assert.deepEqual(projectIdentity(claims).domains, []);
});

test("groupsFromClaims fails closed for absent or malformed group claims", () => {
  assert.deepEqual(groupsFromClaims({}), []);
  assert.deepEqual(groupsFromClaims({ "cognito:groups": "" }), []);
  assert.deepEqual(groupsFromClaims({ "cognito:groups": "[\"domain-builder\"" }), []);
  assert.deepEqual(groupsFromClaims({ "cognito:groups": "{not-json" }), []);
  assert.deepEqual(
    projectIdentity({
      sub: "malformed-domains",
      "cognito:groups": "[domain-builder,domain-platform",
    }).domains,
    [],
  );
});

test("reserved role and access group aliases never become domain scope", () => {
  const groups = [
    "platform-admin",
    "domain-builder",
    "domain-lead",
    "end-user",
    "demo-operator",
    "domain-platform-admin",
    "domain-domain-builder",
    "domain-end-user",
    "domain-demo-operator",
  ];
  const projected = projectIdentity({
    sub: "reserved-groups",
    "cognito:groups": groups,
  });

  assert.deepEqual(projected.domains, []);
});

test("reserved domain identifiers cannot be activated from authoritative state", () => {
  for (const domain of [
    "builder",
    "lead",
    "platform_admin",
    "domain_builder",
    "end_user",
    "demo_operator",
  ]) {
    assert.throws(
      () => identity.projectEffectiveIdentity(
        demoOperatorClaims,
        {
          "x-demo-role": "builder",
          "x-active-domain": domain,
        },
        {
          availableDomains: [{ id: domain, name: "Reserved" }],
          availableDemoDomains: [{ id: domain, name: "Reserved" }],
        },
      ),
      (error) =>
        error?.code === "DEMO_DOMAIN_NOT_ALLOWED"
        && error?.statusCode === 403,
      domain,
    );
  }
});

test("projectIdentity projects a platform administrator from Cognito claims", () => {
  const identity = projectIdentity({
    sub: "sub-123",
    "cognito:username": "platform-admin-user",
    "cognito:groups": ["platform-admin"],
    email: "EMAIL_PLACEHOLDER",
    name: "Platform Administrator",
  });

  assert.equal(identity.ok, true);
  assert.equal(identity.user, "sub-123");
  assert.equal(identity.username, "platform-admin-user");
  assert.equal(identity.name, "Platform Administrator");
  assert.equal(identity.email, "EMAIL_PLACEHOLDER");
  assert.equal(identity.role, "admin");
  assert.deepEqual(identity.groups, ["platform-admin"]);
  assert.equal(identity.domain, null);
  assert.deepEqual(identity.domains, []);
  assert.equal(identity.identityProvider, "cognito");
  assert.ok(identity.capabilities.includes("manageCapabilityBundles"));
  assert.ok(identity.capabilities.includes("manageRegistryEntries"));
  assert.ok(
    identity.capabilities.includes("approveRestrictedPolicyException"),
  );
  assert.equal(
    identity.capabilities.includes("approveRegistryVersion"),
    true,
  );
  assert.ok(identity.capabilities.includes("viewAllDomains"));
});

test("projectIdentity preserves the canonical hosted administrator capabilities", () => {
  const projected = projectIdentity({
    sub: "hosted-admin",
    "cognito:groups": ["platform-admin"],
  });

  assert.deepEqual(
    projected.capabilities,
    canonicalBundles.admin.capabilities,
  );
});

test("projectIdentity exposes the approved explicit hosted journey capabilities", () => {
  const projections = {
    admin: projectIdentity({
      sub: "admin",
      "cognito:groups": ["platform-admin"],
    }),
    builder: projectIdentity({
      sub: "builder",
      "cognito:groups": ["domain-builder"],
    }),
    user: projectIdentity({
      sub: "user",
      "cognito:groups": ["end-user"],
    }),
  };

  for (const capability of [
    "viewPlatformInventory",
    "managePlatformPolicy",
    "manageGateway",
    "usePlatformBuilderWorkspace",
    "createAgent",
  ]) {
    assert.ok(
      projections.admin.capabilities.includes(capability),
      `admin must receive ${capability}`,
    );
  }
  for (const capability of [
    "createAgent",
    "configureAgent",
    "testAgent",
    "deployAgentToSandbox",
    "submitAgentProductionDeployment",
    "submitDomainResourcePublication",
  ]) {
    assert.ok(
      projections.builder.capabilities.includes(capability),
      `builder must receive ${capability}`,
    );
  }
  assert.deepEqual(
    projections.user.capabilities,
    [
      "discoverEntitledAgents",
      "invokeEntitledAgent",
      "viewOwnSessions",
      "submitAgentFeedback",
      "requestAgentAccess",
    ],
  );
});

test("projectIdentity uses only own non-empty string identity claims", () => {
  const claims = Object.create({
    sub: "inherited-sub",
    "cognito:username": "inherited-cognito-username",
    username: "inherited-username",
    name: "Inherited Name",
    email: "INHERITED_EMAIL_PLACEHOLDER",
  });
  claims.sub = " sub-456 ";
  claims["cognito:username"] = 123;
  claims.username = " own-username ";
  claims.name = [];
  claims.email = {};

  assert.deepEqual(projectIdentity(claims), {
    ok: true,
    user: "sub-456",
    username: "own-username",
    name: "own-username",
    email: null,
    role: "user",
    groups: [],
    domain: null,
    domains: [],
    capabilities: [],
    identityProvider: "cognito",
  });
});

test("projectIdentity fails closed when multiple recognized role groups are present", () => {
  for (const groups of [
    ["platform-admin", "domain-builder"],
    ["platform-admin", "end-user"],
    ["domain-builder", "end-user"],
    ["end-user", "domain-builder", "platform-admin"],
  ]) {
    const projected = projectIdentity({
      sub: "mixed-role",
      "cognito:groups": groups,
    });
    assert.equal(projected.role, "user", groups.join(","));
    assert.deepEqual(projected.capabilities, [], groups.join(","));
  }
});

test("projectIdentity maps domain builders to the builder role", () => {
  assert.equal(
    projectIdentity({
      sub: "builder-1",
      "cognito:groups": ["domain-builder"],
    }).role,
    "builder",
  );
});

test("projectIdentity treats domain-lead as a permanent role, never a domain membership", () => {
  const projected = projectIdentity({
    sub: "lead-1",
    "cognito:groups": ["domain-lead"],
  });

  assert.equal(projected.role, "lead");
  assert.deepEqual(projected.groups, ["domain-lead"]);
  assert.deepEqual(projected.domains, []);
  assert.deepEqual(projected.capabilities, canonicalBundles.lead.capabilities);
});

test("reserved access group names are never parsed as domain memberships", () => {
  for (const [groups, expectedRole] of [
    [["domain-builder"], "builder"],
    [["domain-lead"], "lead"],
    [["platform-admin", "domain-lead"], "user"],
    [["domain-builder", "domain-lead"], "user"],
  ]) {
    const projected = projectIdentity({
      sub: `${groups.join("-")}-subject`,
      "cognito:groups": groups,
    });

    assert.equal(projected.role, expectedRole);
    assert.deepEqual(projected.groups, groups);
    assert.deepEqual(projected.domains, []);
  }

  assert.deepEqual(
    projectIdentity({
      sub: "ordinary-domain-subject",
      "cognito:groups": ["domain-customer-support"],
    }).groups,
    ["domain-customer-support"],
  );
});

test("projectIdentity retains demo-operator as a non-role access group", () => {
  const projected = projectIdentity({
    sub: "operator-sub",
    "cognito:groups": ["platform-admin", "demo-operator"],
  });

  assert.equal(projected.role, "admin");
  assert.deepEqual(projected.groups, ["platform-admin", "demo-operator"]);
  assert.equal(
    projectIdentity({
      sub: "access-only",
      "cognito:groups": ["demo-operator"],
    }).role,
    "user",
  );
});

test("projectIdentity maps end users to the user role", () => {
  const projected = projectIdentity({
    sub: "user-1",
    "cognito:groups": ["end-user", "domain-operations"],
  });

  assert.equal(projected.role, "user");
  assert.equal(projected.domain, null);
  assert.deepEqual(projected.domains, []);
  assert.deepEqual(
    projected.capabilities,
    canonicalBundles.user.capabilities,
  );
});

test("projectEffectiveIdentity projects an authorized domain lead override", () => {
  assert.equal(typeof identity.projectEffectiveIdentity, "function");

  const profile = identity.projectEffectiveIdentity(
    demoOperatorClaims,
    {
      "x-demo-role": "lead",
      "x-active-domain": "customer_support",
    },
    { availableDomains },
  );

  assert.equal(profile.user, "operator-sub");
  assert.equal(profile.actor, "operator-sub");
  assert.equal(profile.authenticatedRole, "admin");
  assert.equal(profile.role, "lead");
  assert.equal(profile.assumedRole, "lead");
  assert.equal(profile.domain, "customer_support");
  assert.deepEqual(profile.domains, ["customer_support"]);
  assert.deepEqual(
    profile.capabilities,
    canonicalBundles.lead.capabilities,
  );
  assert.equal(profile.demoRoleActive, true);
  assert.equal(profile.canSwitchDemoRole, true);
  assert.deepEqual(profile.availableDemoRoles, demoRoles);
});

test("preflightEffectiveIdentity enforces deterministic header precedence", () => {
  assert.equal(typeof identity.preflightEffectiveIdentity, "function");

  for (const headers of [
    {
      "x-demo-role": "owner",
      "x-active-domain": "operations",
      "X-Active-Domain": "customer_support",
    },
    {
      "x-demo-role": "lead",
      "X-Demo-Role": "builder",
      "x-active-domain": "operations",
      "X-Active-Domain": "customer_support",
    },
  ]) {
    assert.throws(
      () => identity.preflightEffectiveIdentity(
        demoOperatorClaims,
        headers,
      ),
      isIdentityScopeError("DEMO_ROLE_NOT_ALLOWED"),
    );
  }

  assert.throws(
    () => identity.preflightEffectiveIdentity(
      demoOperatorClaims,
      {
        "x-demo-role": "builder",
        "x-active-domain": "operations",
        "X-Active-Domain": "customer_support",
      },
    ),
    isIdentityScopeError("DEMO_DOMAIN_NOT_ALLOWED"),
  );
});

test("projectEffectiveIdentity keeps platform for admin validation but not Lead or Builder choices", () => {
  const authoritativeDomains = [
    { id: "platform", name: "Platform" },
    { id: "shared", name: "Shared" },
    ...availableDomains,
  ];
  const admin = identity.projectEffectiveIdentity(
    demoOperatorClaims,
    {
      "x-demo-role": "admin",
      "x-active-domain": "platform",
    },
    {
      availableDomains: authoritativeDomains,
      availableDemoDomains: availableDomains,
    },
  );
  assert.equal(admin.role, "admin");
  assert.equal(admin.domain, "platform");

  for (const role of ["lead", "builder"]) {
    for (const domain of ["platform", "shared"]) {
      assert.throws(
        () => identity.projectEffectiveIdentity(
          demoOperatorClaims,
          {
            "x-demo-role": role,
            "x-active-domain": domain,
          },
          { availableDomains: authoritativeDomains },
        ),
        isIdentityScopeError("DEMO_DOMAIN_NOT_ALLOWED"),
        `${role}:${domain}`,
      );
    }
  }
});

test("projectEffectiveIdentity accepts single case-insensitive demo headers", () => {
  const profile = identity.projectEffectiveIdentity(
    demoOperatorClaims,
    {
      "X-DeMo-RoLe": "builder",
      "X-AcTiVe-DoMaIn": "customer-support",
    },
    { availableDomains },
  );

  assert.equal(profile.role, "builder");
  assert.equal(profile.domain, "customer_support");
  assert.deepEqual(profile.domains, ["customer_support"]);
});

test("projectEffectiveIdentity rejects duplicate case-insensitive demo role headers", () => {
  assert.throws(
    () => identity.projectEffectiveIdentity(
      demoOperatorClaims,
      {
        "x-demo-role": "lead",
        "X-Demo-Role": "builder",
        "x-active-domain": "operations",
      },
      { availableDomains },
    ),
    isIdentityScopeError("DEMO_ROLE_NOT_ALLOWED"),
  );
});

test("projectEffectiveIdentity rejects duplicate case-insensitive active domain headers", () => {
  assert.throws(
    () => identity.projectEffectiveIdentity(
      demoOperatorClaims,
      {
        "x-demo-role": "lead",
        "x-active-domain": "operations",
        "X-Active-Domain": "customer_support",
      },
      { availableDomains },
    ),
    isIdentityScopeError("DEMO_DOMAIN_NOT_ALLOWED"),
  );
});

test("projectEffectiveIdentity rejects an unauthorized role before duplicate active-domain headers", () => {
  assert.throws(
    () => identity.projectEffectiveIdentity(
      {
        sub: "admin-only",
        "cognito:groups": ["platform-admin"],
      },
      {
        "x-demo-role": "admin",
        "x-active-domain": "operations",
        "X-Active-Domain": "customer_support",
      },
      { availableDomains },
    ),
    isIdentityScopeError("DEMO_ROLE_NOT_ALLOWED"),
  );
});

test("projectEffectiveIdentity rejects an unknown role before duplicate active-domain headers", () => {
  assert.throws(
    () => identity.projectEffectiveIdentity(
      demoOperatorClaims,
      {
        "x-demo-role": "owner",
        "x-active-domain": "operations",
        "X-Active-Domain": "customer_support",
      },
      { availableDomains },
    ),
    isIdentityScopeError("DEMO_ROLE_NOT_ALLOWED"),
  );
});

test("projectEffectiveIdentity ignores inherited demo headers", () => {
  const headers = Object.create({
    "x-demo-role": "lead",
    "x-active-domain": "operations",
  });
  const base = projectIdentity(demoOperatorClaims);
  const projected = identity.projectEffectiveIdentity(
    demoOperatorClaims,
    headers,
    { availableDomains },
  );

  assert.equal(projected.role, base.role);
  assert.equal(projected.domain, base.domain);
  assert.deepEqual(projected.domains, base.domains);
  assert.deepEqual(projected.capabilities, base.capabilities);
  assert.equal(projected.demoRoleActive, false);
  assert.equal(projected.assumedRole, null);
});

test("projectEffectiveIdentity authorizes overrides from both permanent access groups", () => {
  const unauthorizedClaims = [
    {
      sub: "admin-only",
      "cognito:groups": ["platform-admin"],
    },
    {
      sub: "operator-builder",
      "cognito:groups": ["domain-builder", "demo-operator"],
    },
  ];

  for (const claims of unauthorizedClaims) {
    assert.throws(
      () => identity.projectEffectiveIdentity(
        claims,
        { "x-demo-role": "admin" },
        { availableDomains },
      ),
      isIdentityScopeError("DEMO_ROLE_NOT_ALLOWED"),
    );
  }
});

test("projectEffectiveIdentity accepts exactly the four canonical roles", () => {
  for (const role of ["Admin", "lead ", "", "owner", ["admin"]]) {
    assert.throws(
      () => identity.projectEffectiveIdentity(
        demoOperatorClaims,
        { "x-demo-role": role },
        { availableDomains },
      ),
      isIdentityScopeError("DEMO_ROLE_NOT_ALLOWED"),
      String(role),
    );
  }

  const requestedDomains = {
    admin: undefined,
    lead: "operations",
    builder: "operations",
    user: undefined,
  };
  for (const role of demoRoles) {
    const domain = requestedDomains[role];
    const profile = identity.projectEffectiveIdentity(
      demoOperatorClaims,
      {
        "x-demo-role": role,
        ...(domain ? { "x-active-domain": domain } : {}),
      },
      { availableDomains },
    );

    assert.equal(profile.role, role);
  }
});

test("projectEffectiveIdentity requires a domain for lead and builder overrides", () => {
  for (const role of ["lead", "builder"]) {
    assert.throws(
      () => identity.projectEffectiveIdentity(
        demoOperatorClaims,
        { "x-demo-role": role },
        { availableDomains },
      ),
      isIdentityScopeError("DEMO_DOMAIN_REQUIRED"),
      role,
    );
  }
});

test("projectEffectiveIdentity rejects malformed and unavailable demo domains", () => {
  for (const domain of [
    "finance",
    "",
    " operations",
    "Operations",
    "../operations",
    42,
  ]) {
    assert.throws(
      () => identity.projectEffectiveIdentity(
        demoOperatorClaims,
        {
          "x-demo-role": "builder",
          "x-active-domain": domain,
        },
        { availableDomains },
      ),
      isIdentityScopeError("DEMO_DOMAIN_NOT_ALLOWED"),
      String(domain),
    );
  }
});

test("projectEffectiveIdentity prevents end users from carrying a domain", () => {
  assert.throws(
    () => identity.projectEffectiveIdentity(
      demoOperatorClaims,
      {
        "x-demo-role": "user",
        "x-active-domain": "operations",
      },
      { availableDomains },
    ),
    isIdentityScopeError("DEMO_DOMAIN_NOT_ALLOWED"),
  );

  const profile = identity.projectEffectiveIdentity(
    demoOperatorClaims,
    { "x-demo-role": "user" },
    { availableDomains },
  );
  assert.equal(profile.role, "user");
  assert.equal(profile.domain, null);
  assert.deepEqual(profile.domains, []);
});

test("projectEffectiveIdentity rejects a permanent end-user active domain", () => {
  assert.throws(
    () => identity.projectEffectiveIdentity(
      {
        sub: "user-1",
        "cognito:groups": ["end-user", "domain-operations"],
      },
      { "x-active-domain": "operations" },
      { availableDomains },
    ),
    isIdentityScopeError("DEMO_DOMAIN_NOT_ALLOWED"),
  );
});

test("projectEffectiveIdentity applies a permanent admin active domain", () => {
  const profile = identity.projectEffectiveIdentity(
    {
      sub: "admin-1",
      "cognito:groups": ["platform-admin", "domain-platform"],
    },
    { "X-Active-Domain": "operations" },
    { availableDomains },
  );

  assert.equal(profile.actor, "admin-1");
  assert.equal(profile.authenticatedRole, "admin");
  assert.equal(profile.role, "admin");
  assert.equal(profile.domain, "operations");
  assert.deepEqual(profile.domains, ["platform"]);
  assert.deepEqual(profile.capabilities, canonicalBundles.admin.capabilities);
  assert.equal(profile.demoRoleActive, false);
  assert.equal(profile.assumedRole, null);
});

test("projectEffectiveIdentity applies an allowed permanent builder active domain", () => {
  const profile = identity.projectEffectiveIdentity(
    {
      sub: "builder-1",
      "cognito:groups": [
        "domain-builder",
        "domain-operations",
        "domain-customer-support",
      ],
    },
    { "x-active-domain": "operations" },
    { availableDomains },
  );

  assert.equal(profile.actor, "builder-1");
  assert.equal(profile.authenticatedRole, "builder");
  assert.equal(profile.role, "builder");
  assert.equal(profile.domain, "operations");
  assert.deepEqual(profile.domains, ["operations", "customer_support"]);
  assert.deepEqual(
    profile.capabilities,
    canonicalBundles.builder.capabilities,
  );
  assert.equal(profile.demoRoleActive, false);
  assert.equal(profile.assumedRole, null);
});

test("projectEffectiveIdentity applies a permanent admin domain without authoritative options", () => {
  const profile = identity.projectEffectiveIdentity(
    {
      sub: "admin-1",
      "cognito:groups": ["platform-admin"],
    },
    { "x-active-domain": "customer-support" },
  );

  assert.equal(profile.role, "admin");
  assert.equal(profile.domain, "customer_support");
  assert.deepEqual(profile.domains, []);
  assert.equal(profile.demoRoleActive, false);
});

test("projectEffectiveIdentity applies a permanent builder group domain without authoritative options", () => {
  const profile = identity.projectEffectiveIdentity(
    {
      sub: "builder-1",
      "cognito:groups": [
        "domain-builder",
        "domain-operations",
        "domain-customer-support",
      ],
    },
    { "x-active-domain": "operations" },
  );

  assert.equal(profile.role, "builder");
  assert.equal(profile.domain, "operations");
  assert.deepEqual(profile.domains, ["operations", "customer_support"]);
  assert.equal(profile.demoRoleActive, false);
});

test("projectEffectiveIdentity rejects a permanent builder foreign domain without authoritative options", () => {
  assert.throws(
    () => identity.projectEffectiveIdentity(
      {
        sub: "builder-1",
        "cognito:groups": ["domain-builder", "domain-operations"],
      },
      { "x-active-domain": "customer_support" },
    ),
    isIdentityScopeError("DEMO_DOMAIN_NOT_ALLOWED"),
  );
});

for (const [role, claims] of [
  [
    "admin",
    {
      sub: "admin-1",
      "cognito:groups": ["platform-admin"],
    },
  ],
  [
    "builder",
    {
      sub: "builder-1",
      "cognito:groups": ["domain-builder", "domain-finance"],
    },
  ],
]) {
  test(`projectEffectiveIdentity rejects an unavailable permanent ${role} active domain`, () => {
    assert.throws(
      () => identity.projectEffectiveIdentity(
        claims,
        { "x-active-domain": "finance" },
        { availableDomains },
      ),
      isIdentityScopeError("DEMO_DOMAIN_NOT_ALLOWED"),
    );
  });

  test(`projectEffectiveIdentity rejects malformed permanent ${role} active domains`, () => {
    for (const domain of ["", " operations", "Operations", 42]) {
      assert.throws(
        () => identity.projectEffectiveIdentity(
          claims,
          { "x-active-domain": domain },
          { availableDomains },
        ),
        isIdentityScopeError("DEMO_DOMAIN_NOT_ALLOWED"),
        String(domain),
      );
    }
  });

  test(`projectEffectiveIdentity rejects duplicate permanent ${role} active-domain headers`, () => {
    assert.throws(
      () => identity.projectEffectiveIdentity(
        claims,
        {
          "x-active-domain": "operations",
          "X-Active-Domain": "customer_support",
        },
        { availableDomains },
      ),
      isIdentityScopeError("DEMO_DOMAIN_NOT_ALLOWED"),
    );
  });
}

test("projectEffectiveIdentity rejects a permanent builder domain outside its groups", () => {
  assert.throws(
    () => identity.projectEffectiveIdentity(
      {
        sub: "builder-1",
        "cognito:groups": ["domain-builder", "domain-operations"],
      },
      { "x-active-domain": "customer_support" },
      { availableDomains },
    ),
    isIdentityScopeError("DEMO_DOMAIN_NOT_ALLOWED"),
  );
});

test("projectEffectiveIdentity preserves permanent builder domain selection rules", () => {
  const singleDomain = identity.projectEffectiveIdentity(
    {
      sub: "builder-1",
      "cognito:groups": ["domain-builder", "domain-operations"],
    },
    {},
    { availableDomains },
  );
  assert.equal(singleDomain.domain, "operations");
  assert.deepEqual(singleDomain.domains, ["operations"]);

  assert.throws(
    () => identity.projectEffectiveIdentity(
      {
        sub: "builder-2",
        "cognito:groups": [
          "domain-builder",
          "domain-operations",
          "domain-customer-support",
        ],
      },
      {},
      { availableDomains },
    ),
    isIdentityScopeError("DEMO_DOMAIN_REQUIRED"),
  );

  assert.throws(
    () => identity.projectEffectiveIdentity(
      {
        sub: "builder-3",
        "cognito:groups": ["domain-builder"],
      },
      {},
      { availableDomains },
    ),
    isIdentityScopeError("DEMO_DOMAIN_REQUIRED"),
  );
});

test("projectEffectiveIdentity preserves no-override identity behavior", () => {
  const base = projectIdentity(demoOperatorClaims);
  const projected = identity.projectEffectiveIdentity(
    demoOperatorClaims,
    {},
    { availableDomains },
  );

  for (const key of [
    "ok",
    "user",
    "username",
    "name",
    "email",
    "role",
    "groups",
    "domain",
    "domains",
    "capabilities",
    "identityProvider",
  ]) {
    assert.deepEqual(projected[key], base[key], key);
  }
  assert.equal(projected.actor, base.user);
  assert.equal(projected.authenticatedRole, base.role);
  assert.equal(projected.demoRoleActive, false);
  assert.equal(projected.canSwitchDemoRole, true);
  assert.equal(projected.assumedRole, null);
  assert.deepEqual(projected.availableDemoRoles, demoRoles);
});

test("projectEffectiveIdentity capabilities exactly match every canonical bundle", () => {
  for (const role of demoRoles) {
    const requiresDomain = role === "lead" || role === "builder";
    const profile = identity.projectEffectiveIdentity(
      demoOperatorClaims,
      {
        "x-demo-role": role,
        ...(requiresDomain ? { "x-active-domain": "operations" } : {}),
      },
      { availableDomains },
    );

    assert.deepEqual(
      profile.capabilities,
      canonicalBundles[role].capabilities,
      role,
    );
  }
});

test("control-plane scope auto-selects a builder's only domain", () => {
  assert.equal(
    typeof identity.projectControlPlaneScope,
    "function",
  );

  assert.deepEqual(
    identity.projectControlPlaneScope({
      sub: "builder-1",
      "cognito:groups": ["domain-builder", "domain-operations"],
    }),
    {
      role: "builder",
      allowedDomains: ["operations"],
      activeDomain: "operations",
    },
  );
});

test("control-plane scope rejects a builder without a domain", () => {
  assert.equal(
    typeof identity.projectControlPlaneScope,
    "function",
  );

  assert.throws(
    () => identity.projectControlPlaneScope({
      sub: "builder-without-domain",
      "cognito:groups": ["domain-builder"],
    }),
    (error) =>
      error.code === "DOMAIN_REQUIRED"
      && error.statusCode === 403
      && error.message === "An allowed active domain is required.",
  );
});

test("control-plane scope requires an allowed active domain for multi-domain users", () => {
  assert.equal(
    typeof identity.projectControlPlaneScope,
    "function",
  );
  const claims = {
    sub: "multi-domain-builder",
    "cognito:groups": [
      "domain-builder",
      "domain-platform",
      "domain-operations",
    ],
  };

  assert.throws(
    () => identity.projectControlPlaneScope(claims),
    (error) =>
      error.code === "DOMAIN_REQUIRED"
      && error.statusCode === 403,
  );
  assert.throws(
    () => identity.projectControlPlaneScope(claims, "customer_support"),
    (error) =>
      error.code === "DOMAIN_NOT_ALLOWED"
      && error.statusCode === 403
      && error.message === "The active domain is not allowed.",
  );
  assert.deepEqual(
    identity.projectControlPlaneScope(claims, "platform"),
    {
      role: "builder",
      allowedDomains: ["platform", "operations"],
      activeDomain: "platform",
    },
  );
});

test("control-plane scope lets admins omit an active domain", () => {
  assert.equal(
    typeof identity.projectControlPlaneScope,
    "function",
  );

  assert.deepEqual(
    identity.projectControlPlaneScope({
      sub: "admin-1",
      "cognito:groups": [
        "platform-admin",
        "domain-platform",
        "domain-customer-support",
      ],
    }),
    {
      role: "admin",
      allowedDomains: ["platform", "customer_support"],
      activeDomain: null,
    },
  );
  assert.deepEqual(
    identity.projectControlPlaneScope({
      sub: "admin-1",
      "cognito:groups": ["platform-admin"],
    }, null),
    {
      role: "admin",
      allowedDomains: [],
      activeDomain: null,
    },
  );
});

test("control-plane scope accepts a canonical dynamic admin domain", () => {
  assert.deepEqual(
    identity.projectControlPlaneScope({
      sub: "admin-1",
      "cognito:groups": ["platform-admin"],
    }, "finance"),
    {
      role: "admin",
      allowedDomains: [],
      activeDomain: "finance",
    },
  );
});

test("control-plane scope rejects malformed admin domain selections", () => {
  for (const activeDomain of [
    "",
    "   ",
    "../finance",
    "finance ops",
    "Finance",
    "1finance",
    "finance__ops",
    "finance_",
    `f${"a".repeat(64)}`,
    " finance",
    "finance ",
    42,
    {},
  ]) {
    assert.throws(
      () => identity.projectControlPlaneScope({
        sub: "admin-1",
        "cognito:groups": ["platform-admin"],
      }, activeDomain),
      (error) =>
        error.code === "DOMAIN_NOT_ALLOWED"
        && error.statusCode === 403
        && error.message === "The active domain is not allowed.",
      activeDomain,
    );
  }
});

test("control-plane scope accepts the UI customer-support domain identifier", () => {
  assert.deepEqual(
    identity.projectControlPlaneScope({
      sub: "admin-1",
      "cognito:groups": ["platform-admin"],
    }, "customer-support"),
    {
      role: "admin",
      allowedDomains: [],
      activeDomain: "customer_support",
    },
  );
});

test("control-plane scope rejects every end-user domain scope", () => {
  const claims = {
    sub: "user-1",
    "cognito:groups": ["end-user", "domain-operations"],
  };

  for (const [activeDomain, code, message] of [
    [
      undefined,
      "DOMAIN_REQUIRED",
      "An allowed active domain is required.",
    ],
    [
      "operations",
      "DOMAIN_NOT_ALLOWED",
      "The active domain is not allowed.",
    ],
  ]) {
    assert.throws(
      () => identity.projectControlPlaneScope(claims, activeDomain),
      (error) =>
        error.code === code
        && error.statusCode === 403
        && error.message === message,
    );
  }
});

test("projected capability snapshots preserve canonical bundles", () => {
  const projections = {
    admin: projectIdentity({
      sub: "admin",
      "cognito:groups": ["platform-admin"],
    }),
    builder: projectIdentity({
      sub: "builder",
      "cognito:groups": ["domain-builder"],
    }),
    user: projectIdentity({
      sub: "user",
      "cognito:groups": ["end-user"],
    }),
  };

  for (const role of ["admin", "builder", "user"]) {
    assert.deepEqual(
      projections[role].capabilities,
      canonicalBundles[role].capabilities,
    );
  }

  for (const role of ["builder", "user"]) {
    assert.equal(projections[role].capabilities.includes("viewAllDomains"), false);
    assert.equal(
      projections[role].capabilities.includes("manageCapabilityBundles"),
      false,
    );
  }
});

test("authoritative demo-operator verification reads the current enabled user and every group page", async () => {
  assert.equal(
    typeof identity.createAuthoritativeDemoOperatorVerifier,
    "function",
  );
  const calls = [];
  const pages = [
    {
      Groups: [{ GroupName: "platform-admin" }],
      NextToken: "next-page",
    },
    {
      Groups: [{ GroupName: "demo-operator" }],
    },
  ];
  const verify = identity.createAuthoritativeDemoOperatorVerifier({
    userPoolId: "us-west-2_example",
    cognito: {
      async send(command) {
        calls.push({
          name: command.constructor.name,
          input: command.input,
        });
        if (command.constructor.name === "AdminGetUserCommand") {
          return cognitoUser();
        }
        return pages.shift();
      },
    },
  });

  assert.equal(await verify(demoOperatorClaims), true);
  assert.deepEqual(calls, [
    {
      name: "AdminGetUserCommand",
      input: {
        UserPoolId: "us-west-2_example",
        Username: "operator-user",
      },
    },
    {
      name: "AdminListGroupsForUserCommand",
      input: {
        UserPoolId: "us-west-2_example",
        Username: "operator-user",
        Limit: 60,
      },
    },
    {
      name: "AdminListGroupsForUserCommand",
      input: {
        UserPoolId: "us-west-2_example",
        Username: "operator-user",
        Limit: 60,
        NextToken: "next-page",
      },
    },
  ]);
});

test("authoritative demo-operator verification accepts the Cognito access-token username claim", async () => {
  const calls = [];
  const verify = identity.createAuthoritativeDemoOperatorVerifier({
    userPoolId: "us-west-2_example",
    cognito: {
      async send(command) {
        calls.push({
          name: command.constructor.name,
          input: command.input,
        });
        if (command.constructor.name === "AdminGetUserCommand") {
          return cognitoUser();
        }
        return {
          Groups: [
            { GroupName: "platform-admin" },
            { GroupName: "demo-operator" },
          ],
        };
      },
    },
  });

  assert.equal(await verify({
    sub: "operator-sub",
    token_use: "access",
    username: "operator-user",
    "cognito:groups": ["platform-admin", "demo-operator"],
  }), true);
  assert.equal(calls[0].input.Username, "operator-user");
});

test("authoritative demo-operator verification binds the current user to token sub", async () => {
  const verify = identity.createAuthoritativeDemoOperatorVerifier({
    userPoolId: "us-west-2_example",
    cognito: {
      async send(command) {
        if (command.constructor.name === "AdminGetUserCommand") {
          return cognitoUser({ sub: "replacement-sub" });
        }
        return {
          Groups: [
            { GroupName: "platform-admin" },
            { GroupName: "demo-operator" },
          ],
        };
      },
    },
  });

  assert.equal(await verify(demoOperatorClaims), false);
});

test("authoritative demo-operator verification requires token sub", async () => {
  let calls = 0;
  const verify = identity.createAuthoritativeDemoOperatorVerifier({
    userPoolId: "us-west-2_example",
    cognito: {
      async send() {
        calls += 1;
        return {};
      },
    },
  });
  const { sub: _sub, ...claimsWithoutSub } = demoOperatorClaims;

  assert.equal(await verify(claimsWithoutSub), false);
  assert.equal(calls, 0);
});

test("authoritative demo-operator verification rejects conflicting username claims", async () => {
  let calls = 0;
  const verify = identity.createAuthoritativeDemoOperatorVerifier({
    userPoolId: "us-west-2_example",
    cognito: {
      async send() {
        calls += 1;
        return {};
      },
    },
  });

  assert.equal(await verify({
    sub: "operator-sub",
    token_use: "access",
    username: "different-user",
    "cognito:username": "operator-user",
    "cognito:groups": ["platform-admin", "demo-operator"],
  }), false);
  assert.equal(calls, 0);
});

test("authoritative demo-operator verification denies missing usernames, disabled users, and group removal", async () => {
  assert.equal(
    typeof identity.createAuthoritativeDemoOperatorVerifier,
    "function",
  );
  let calls = 0;
  const missingUsernameVerifier =
    identity.createAuthoritativeDemoOperatorVerifier({
      userPoolId: "us-west-2_example",
      cognito: {
        async send() {
          calls += 1;
          return {};
        },
      },
    });
  assert.equal(
    await missingUsernameVerifier({
      sub: "immutable-sub",
      "cognito:groups": ["platform-admin", "demo-operator"],
    }),
    false,
  );
  assert.equal(calls, 0);

  for (const fixture of [
    {
      user: cognitoUser({ enabled: false }),
      groups: ["platform-admin", "demo-operator"],
    },
    {
      user: cognitoUser({ username: "different-user" }),
      groups: ["platform-admin", "demo-operator"],
    },
    {
      user: cognitoUser(),
      groups: ["platform-admin"],
    },
    {
      user: cognitoUser(),
      groups: ["demo-operator"],
    },
  ]) {
    const verify = identity.createAuthoritativeDemoOperatorVerifier({
      userPoolId: "us-west-2_example",
      cognito: {
        async send(command) {
          if (command.constructor.name === "AdminGetUserCommand") {
            return fixture.user;
          }
          return {
            Groups: fixture.groups.map((GroupName) => ({ GroupName })),
          };
        },
      },
    });
    assert.equal(await verify(demoOperatorClaims), false);
  }
});

test("authoritative demo-operator verification fails closed on Cognito and pagination anomalies", async () => {
  assert.equal(
    typeof identity.createAuthoritativeDemoOperatorVerifier,
    "function",
  );
  const user = cognitoUser();

  for (const groupPages of [
    [{ Groups: "not-an-array" }],
    [{ Groups: [], NextToken: "" }],
    [
      { Groups: [], NextToken: "repeated" },
      { Groups: [], NextToken: "repeated" },
    ],
    [
      { Groups: [], NextToken: "page-two" },
      { Groups: [], NextToken: "page-three" },
    ],
  ]) {
    const pages = structuredClone(groupPages);
    const verify = identity.createAuthoritativeDemoOperatorVerifier({
      userPoolId: "us-west-2_example",
      maxGroupPages: 2,
      cognito: {
        async send(command) {
          if (command.constructor.name === "AdminGetUserCommand") {
            return user;
          }
          return pages.shift();
        },
      },
    });
    await assert.rejects(() => verify(demoOperatorClaims));
  }

  const verify = identity.createAuthoritativeDemoOperatorVerifier({
    userPoolId: "us-west-2_example",
    cognito: {
      async send() {
        throw new Error("Cognito unavailable");
      },
    },
  });
  await assert.rejects(() => verify(demoOperatorClaims));
});
