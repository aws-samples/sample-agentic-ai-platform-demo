import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { ROLE_CAPABILITY_BUNDLES } from "../lambda/authz/capabilities.mjs";
import {
  DynamoDBClient,
  QueryCommand,
} from "@aws-sdk/client-dynamodb";
import {
  createApiHandler,
  handler,
} from "../lambda/api/index.mjs";

const canonicalBundles = Object.fromEntries(
  Object.entries(ROLE_CAPABILITY_BUNDLES).map(
    ([role, capabilities]) => [role, { capabilities }],
  ),
);

const operatorClaims = {
  sub: "operator-sub",
  token_use: "access",
  "cognito:username": "deployment-operator",
  "cognito:groups": [
    "platform-admin",
    "demo-operator",
    "domain-platform",
  ],
};
const allowCurrentDemoOperator = async () => true;

function meEvent({
  claims = operatorClaims,
  headers,
  requestId = "identity-request",
} = {}) {
  return {
    version: "2.0",
    routeKey: "GET /api/me",
    headers,
    requestContext: {
      http: { method: "GET", path: "/api/me" },
      requestId,
      authorizer: { jwt: { claims } },
    },
  };
}

function dynamoDomainItem(id, name = id) {
  return {
    pk: { S: "DOMAIN" },
    sk: { S: `DOMAIN#${id}` },
    entityType: { S: "DOMAIN" },
    id: { S: id },
    name: { S: name },
    status: { S: "ACTIVE" },
  };
}

test("GET /api/health returns the exact public health response", async () => {
  const response = await handler({
    version: "2.0",
    routeKey: "GET /api/health",
    requestContext: {
      http: { method: "GET", path: "/api/health" },
      requestId: "health-request",
    },
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.headers, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  assert.deepEqual(JSON.parse(response.body), {
    ok: true,
    service: "agentic-platform-api",
    stage: "web-identity",
  });
});

test("GET /api/me projects identity only from JWT authorizer claims", async () => {
  const response = await handler({
    version: "2.0",
    routeKey: "GET /api/me",
    body: JSON.stringify({
      role: "user",
      token: "body-token",
      idToken: "body-id-token",
      accessToken: "body-access-token",
      refreshToken: "body-refresh-token",
    }),
    queryStringParameters: {
      role: "user",
      token: "query-token",
    },
    requestContext: {
      http: { method: "GET", path: "/api/me" },
      requestId: "identity-request",
      authorizer: {
        jwt: {
          claims: {
            sub: "sub-123",
            token_use: "access",
            "cognito:username": "platform-operator",
            "cognito:groups":
              "[platform-admin,domain-platform,domain-customer-support]",
            token: "claim-token",
            idToken: "claim-id-token",
            accessToken: "claim-access-token",
            refreshToken: "claim-refresh-token",
            authorization: "Bearer claim-authorization",
            password: "claim-password",
            secret: "claim-secret",
            apiKey: "claim-api-key",
            clientSecret: "claim-client-secret",
            credentials: { accessKeyId: "claim-access-key" },
            "custom:admin": "true",
            unexpected: "claim-unexpected",
          },
        },
      },
    },
  });
  const body = JSON.parse(response.body);

  assert.equal(response.statusCode, 200);
  assert.equal(body.ok, true);
  assert.equal(body.role, "admin");
  assert.equal(body.user, "sub-123");
  assert.equal(body.domain, null);
  assert.deepEqual(body.domains, ["platform", "customer_support"]);
  assert.deepEqual(Object.keys(body).sort(), [
    "actor",
    "assumedRole",
    "authenticatedRole",
    "availableDemoDomains",
    "availableDemoRoles",
    "canSwitchDemoRole",
    "capabilities",
    "demoRoleActive",
    "domain",
    "domains",
    "email",
    "groups",
    "identityProvider",
    "name",
    "ok",
    "role",
    "user",
    "username",
  ]);
  assert.deepEqual(
    body.capabilities,
    canonicalBundles.admin.capabilities,
  );

  for (const key of [
    "token",
    "idToken",
    "accessToken",
    "refreshToken",
    "authorization",
    "password",
    "secret",
    "apiKey",
    "clientSecret",
    "credentials",
    "custom:admin",
    "unexpected",
  ]) {
    assert.equal(Object.hasOwn(body, key), false);
  }
});

test("GET /api/me returns only authoritative selectable demo domains", async () => {
  let listCalls = 0;
  const api = createApiHandler({
    demoOperatorVerifier: allowCurrentDemoOperator,
    domainState: {
      async listDomains() {
        listCalls += 1;
        return [
          {
            pk: "DOMAIN",
            sk: "DOMAIN#platform",
            entityType: "DOMAIN",
            id: "platform",
            name: "Platform",
            status: "ACTIVE",
            rawClaim: "must-not-leak",
          },
          {
            pk: "DOMAIN",
            sk: "DOMAIN#customer_support",
            entityType: "DOMAIN",
            id: "customer_support",
            name: "Customer Support",
            status: "ACTIVE",
            registryArn: "must-not-leak",
          },
          {
            id: "operations",
            name: "Operations",
            status: "ACTIVE",
          },
          {
            id: "shared",
            name: "Shared",
            status: "ACTIVE",
          },
          {
            id: "failed_domain",
            name: "Failed Domain",
            status: "FAILED",
          },
        ];
      },
    },
  });

  const response = await api(meEvent());
  const body = JSON.parse(response.body);

  assert.equal(response.statusCode, 200);
  assert.equal(listCalls, 1);
  assert.equal(body.authenticatedRole, "admin");
  assert.equal(body.canSwitchDemoRole, true);
  assert.deepEqual(body.availableDemoRoles, [
    "admin",
    "lead",
    "builder",
    "user",
  ]);
  assert.deepEqual(body.availableDemoDomains, [
    { id: "customer_support", name: "Customer Support" },
    { id: "operations", name: "Operations" },
  ]);
  assert.doesNotMatch(
    JSON.stringify(body),
    /DOMAIN#|registryArn|rawClaim|must-not-leak/,
  );
});

test("GET /api/me preserves permanent admin platform and shared scope outside the demo selector", async () => {
  const api = createApiHandler({
    demoOperatorVerifier: allowCurrentDemoOperator,
    domainState: {
      async listDomains() {
        return [
          { id: "platform", name: "Platform", status: "ACTIVE" },
          { id: "shared", name: "Shared", status: "ACTIVE" },
          {
            id: "customer_support",
            name: "Customer Support",
            status: "ACTIVE",
          },
        ];
      },
    },
  });

  for (const domain of ["platform", "shared"]) {
    const response = await api(meEvent({
      headers: {
        "x-active-domain": domain,
      },
      requestId: `permanent-admin-${domain}`,
    }));
    const body = JSON.parse(response.body);

    assert.equal(response.statusCode, 200, domain);
    assert.equal(body.authenticatedRole, "admin");
    assert.equal(body.role, "admin");
    assert.equal(body.domain, domain);
    assert.equal(body.demoRoleActive, false);
    assert.deepEqual(body.availableDemoDomains, [
      { id: "customer_support", name: "Customer Support" },
    ]);
  }
});

test("GET /api/me validates Lead and Builder domains from platform state", async () => {
  const api = createApiHandler({
    demoOperatorVerifier: allowCurrentDemoOperator,
    domainState: {
      async listDomains() {
        return [
          { id: "platform", name: "Platform" },
          { id: "customer_support", name: "Customer Support" },
          { id: "operations", name: "Operations" },
        ];
      },
    },
  });

  for (const role of ["lead", "builder"]) {
    const response = await api(meEvent({
      headers: {
        "x-demo-role": role,
        "x-active-domain": "operations",
      },
    }));
    const body = JSON.parse(response.body);

    assert.equal(response.statusCode, 200);
    assert.equal(body.role, role);
    assert.equal(body.domain, "operations");
    assert.deepEqual(body.domains, ["operations"]);
    assert.deepEqual(
      body.capabilities,
      canonicalBundles[role].capabilities,
    );
    assert.deepEqual(body.availableDemoDomains, [
      { id: "customer_support", name: "Customer Support" },
      { id: "operations", name: "Operations" },
    ]);
  }
});

test("GET /api/me rejects forged roles without querying domains for ordinary users", async () => {
  let factoryCalls = 0;
  let listCalls = 0;
  const api = createApiHandler({
    domainStateFactory() {
      factoryCalls += 1;
      return {
        async listDomains() {
          listCalls += 1;
          return [];
        },
      };
    },
  });

  const response = await api(meEvent({
    claims: {
      sub: "ordinary-sub",
      token_use: "access",
      "cognito:username": "ordinary-user",
      "cognito:groups": ["end-user"],
    },
    headers: {
      "x-demo-role": "admin",
    },
    requestId: "ordinary-forged-role",
  }));
  const body = JSON.parse(response.body);

  assert.equal(response.statusCode, 403);
  assert.equal(factoryCalls, 0);
  assert.equal(listCalls, 0);
  assert.deepEqual(body, {
    ok: false,
    code: "DEMO_ROLE_NOT_ALLOWED",
    message: "The requested demo role is not allowed.",
    requestId: "ordinary-forged-role",
    retryable: false,
  });
});

test("GET /api/me maps demo scope errors to stable 403 bodies", async () => {
  const api = createApiHandler({
    demoOperatorVerifier: allowCurrentDemoOperator,
    domainState: {
      async listDomains() {
        return [
          { id: "operations", name: "Operations", status: "ACTIVE" },
        ];
      },
    },
  });
  const cases = [
    {
      headers: { "x-demo-role": "owner" },
      code: "DEMO_ROLE_NOT_ALLOWED",
      message: "The requested demo role is not allowed.",
    },
    {
      headers: { "x-demo-role": "lead" },
      code: "DEMO_DOMAIN_REQUIRED",
      message: "An available demo domain is required.",
    },
    {
      headers: {
        "x-demo-role": "builder",
        "x-active-domain": "finance",
      },
      code: "DEMO_DOMAIN_NOT_ALLOWED",
      message: "The requested demo domain is not allowed.",
    },
  ];

  for (const { headers, code, message } of cases) {
    const response = await api(meEvent({
      headers,
      requestId: `request-${code}`,
    }));

    assert.equal(response.statusCode, 403);
    assert.deepEqual(JSON.parse(response.body), {
      ok: false,
      code,
      message,
      requestId: `request-${code}`,
      retryable: false,
    });
  }
});

test("GET /api/me validates demo headers before unavailable domain state", async () => {
  let listCalls = 0;
  const api = createApiHandler({
    domainState: {
      async listDomains() {
        listCalls += 1;
        throw new Error("domain state unavailable");
      },
    },
  });
  const cases = [
    {
      headers: {
        "x-demo-role": "owner",
        "x-active-domain": "operations",
        "X-Active-Domain": "customer_support",
      },
      code: "DEMO_ROLE_NOT_ALLOWED",
    },
    {
      headers: {
        "x-demo-role": "lead",
        "X-Demo-Role": "builder",
        "x-active-domain": "operations",
        "X-Active-Domain": "customer_support",
      },
      code: "DEMO_ROLE_NOT_ALLOWED",
    },
    {
      headers: {
        "x-demo-role": "builder",
        "x-active-domain": "operations",
        "X-Active-Domain": "customer_support",
      },
      code: "DEMO_DOMAIN_NOT_ALLOWED",
    },
  ];

  for (const { headers, code } of cases) {
    const response = await api(meEvent({
      headers,
      requestId: `preflight-${code}`,
    }));
    assert.equal(response.statusCode, 403);
    assert.equal(JSON.parse(response.body).code, code);
  }
  assert.equal(listCalls, 0);
});

test("GET /api/me fails safely when authoritative demo context is unavailable", async () => {
  const api = createApiHandler({
    domainState: {
      async listDomains() {
        throw new Error("table secret and internal key DOMAIN#operations");
      },
    },
  });

  const response = await api(meEvent({
    headers: {
      "x-demo-role": "builder",
      "x-active-domain": "operations",
    },
    requestId: "state-failure",
  }));
  const body = JSON.parse(response.body);

  assert.equal(response.statusCode, 503);
  assert.deepEqual(body, {
    ok: false,
    code: "DEMO_CONTEXT_UNAVAILABLE",
    message: "Demo role context is temporarily unavailable.",
    requestId: "state-failure",
    retryable: true,
  });
  assert.doesNotMatch(response.body, /table secret|DOMAIN#/);
});

test("default domain configuration is validated lazily and fails safely", async () => {
  const previousTableName = process.env.PLATFORM_STATE_TABLE_NAME;
  delete process.env.PLATFORM_STATE_TABLE_NAME;
  try {
    const api = createApiHandler({
      demoOperatorVerifier: allowCurrentDemoOperator,
    });
    const health = await api({
      requestContext: {
        http: { method: "GET", path: "/api/health" },
        requestId: "health-without-table",
      },
    });
    assert.equal(health.statusCode, 200);

    const ordinary = await api(meEvent({
      claims: {
        sub: "ordinary-sub",
        token_use: "access",
        "cognito:groups": ["end-user"],
      },
    }));
    assert.equal(ordinary.statusCode, 200);

    const operator = await api(meEvent({ requestId: "missing-table" }));
    assert.equal(operator.statusCode, 503);
    assert.deepEqual(JSON.parse(operator.body), {
      ok: false,
      code: "DEMO_CONTEXT_UNAVAILABLE",
      message: "Demo role context is temporarily unavailable.",
      requestId: "missing-table",
      retryable: true,
    });
  } finally {
    if (previousTableName === undefined) {
      delete process.env.PLATFORM_STATE_TABLE_NAME;
    } else {
      process.env.PLATFORM_STATE_TABLE_NAME = previousTableName;
    }
  }
});

test("default domain state paginates the exact DOMAIN query", async () => {
  const previousTableName = process.env.PLATFORM_STATE_TABLE_NAME;
  const originalSend = DynamoDBClient.prototype.send;
  const commands = [];
  const sendOptions = [];
  const scheduled = [];
  const cleared = [];
  const deadlineTimers = {
    setTimeout(callback, timeoutMs) {
      const handle = { callback, timeoutMs };
      scheduled.push(handle);
      return handle;
    },
    clearTimeout(handle) {
      cleared.push(handle);
    },
  };
  const lastKey = {
    pk: { S: "DOMAIN" },
    sk: { S: "DOMAIN#customer_support" },
  };
  const responses = [
    {
      Items: [{
        pk: { S: "DOMAIN" },
        sk: { S: "DOMAIN#customer_support" },
        entityType: { S: "DOMAIN" },
        id: { S: "customer_support" },
        name: { S: "Customer Support" },
        status: { S: "ACTIVE" },
      }],
      LastEvaluatedKey: lastKey,
    },
    {
      Items: [{
        pk: { S: "DOMAIN" },
        sk: { S: "DOMAIN#operations" },
        entityType: { S: "DOMAIN" },
        id: { S: "operations" },
        name: { S: "Operations" },
        status: { S: "ACTIVE" },
      }],
    },
  ];

  process.env.PLATFORM_STATE_TABLE_NAME = "PlatformState";
  DynamoDBClient.prototype.send = async function send(command, options) {
    commands.push(command);
    sendOptions.push(options);
    return responses.shift();
  };
  try {
    const response = await createApiHandler({
      demoOperatorVerifier: allowCurrentDemoOperator,
      deadlineTimers,
    })(meEvent());
    assert.equal(response.statusCode, 200);
    assert.deepEqual(
      JSON.parse(response.body).availableDemoDomains,
      [
        { id: "customer_support", name: "Customer Support" },
        { id: "operations", name: "Operations" },
      ],
    );
    assert.equal(commands.length, 2);
    assert.ok(commands.every((command) => command instanceof QueryCommand));
    assert.deepEqual(commands[0].input, {
      TableName: "PlatformState",
      KeyConditionExpression: "#pk = :pk",
      ExpressionAttributeNames: {
        "#entityType": "entityType",
        "#id": "id",
        "#name": "name",
        "#pk": "pk",
        "#sk": "sk",
        "#status": "status",
      },
      ExpressionAttributeValues: {
        ":pk": { S: "DOMAIN" },
      },
      ProjectionExpression:
        "#pk, #sk, #entityType, #id, #name, #status",
      Select: "SPECIFIC_ATTRIBUTES",
      Limit: 100,
      ConsistentRead: true,
      ScanIndexForward: true,
    });
    assert.deepEqual(commands[1].input, {
      ...commands[0].input,
      ExclusiveStartKey: lastKey,
      Limit: 99,
    });
    assert.equal(new Set(sendOptions.map(({ abortSignal }) => abortSignal)).size, 1);
    assert.ok(sendOptions.every(({ abortSignal }) => abortSignal?.aborted === false));
    assert.equal(scheduled.length, 1);
    assert.equal(scheduled[0].timeoutMs, 1_000);
    assert.deepEqual(cleared, scheduled);
  } finally {
    DynamoDBClient.prototype.send = originalSend;
    if (previousTableName === undefined) {
      delete process.env.PLATFORM_STATE_TABLE_NAME;
    } else {
      process.env.PLATFORM_STATE_TABLE_NAME = previousTableName;
    }
  }
});

test("default domain state rejects more than ten query pages", async () => {
  const previousTableName = process.env.PLATFORM_STATE_TABLE_NAME;
  const originalSend = DynamoDBClient.prototype.send;
  let calls = 0;

  process.env.PLATFORM_STATE_TABLE_NAME = "PlatformState";
  DynamoDBClient.prototype.send = async function send() {
    calls += 1;
    if (calls > 10) {
      throw new Error("unbounded domain pagination");
    }
    return {
      Items: [],
      LastEvaluatedKey: {
        pk: { S: "DOMAIN" },
        sk: { S: `DOMAIN#page_${calls}` },
      },
    };
  };
  try {
    const response = await createApiHandler({
      demoOperatorVerifier: allowCurrentDemoOperator,
    })(meEvent({
      requestId: "too-many-domain-pages",
    }));
    assert.equal(response.statusCode, 503);
    assert.equal(
      JSON.parse(response.body).code,
      "DEMO_CONTEXT_UNAVAILABLE",
    );
    assert.equal(calls, 10);
  } finally {
    DynamoDBClient.prototype.send = originalSend;
    if (previousTableName === undefined) {
      delete process.env.PLATFORM_STATE_TABLE_NAME;
    } else {
      process.env.PLATFORM_STATE_TABLE_NAME = previousTableName;
    }
  }
});

test("default domain state confirms an empty continuation after one hundred items", async () => {
  const previousTableName = process.env.PLATFORM_STATE_TABLE_NAME;
  const originalSend = DynamoDBClient.prototype.send;
  const commands = [];
  const sendOptions = [];
  const items = [
    dynamoDomainItem("platform", "Platform"),
    dynamoDomainItem("shared", "Shared"),
    ...Array.from({ length: 98 }, (_, index) => {
      const id = `domain_${String(index).padStart(3, "0")}`;
      return dynamoDomainItem(id, `Domain ${index}`);
    }),
  ];
  const lastKey = {
    pk: { S: "DOMAIN" },
    sk: { S: "DOMAIN#domain_097" },
  };
  const responses = [
    { Items: items, LastEvaluatedKey: lastKey },
    { Items: [] },
  ];

  process.env.PLATFORM_STATE_TABLE_NAME = "PlatformState";
  DynamoDBClient.prototype.send = async function send(command, options) {
    commands.push(command);
    sendOptions.push(options);
    return responses.shift();
  };
  try {
    const response = await createApiHandler({
      demoOperatorVerifier: allowCurrentDemoOperator,
    })(meEvent({
      requestId: "exact-domain-item-limit",
    }));
    const body = JSON.parse(response.body);

    assert.equal(response.statusCode, 200);
    assert.equal(body.availableDemoDomains.length, 98);
    assert.equal(
      body.availableDemoDomains.some(
        ({ id }) => id === "platform" || id === "shared",
      ),
      false,
    );
    assert.deepEqual(
      commands.map(({ input }) => ({
        exclusiveStartKey: input.ExclusiveStartKey,
        limit: input.Limit,
      })),
      [
        { exclusiveStartKey: undefined, limit: 100 },
        { exclusiveStartKey: lastKey, limit: 1 },
      ],
    );
    assert.equal(
      new Set(sendOptions.map(({ abortSignal }) => abortSignal)).size,
      1,
    );
  } finally {
    DynamoDBClient.prototype.send = originalSend;
    if (previousTableName === undefined) {
      delete process.env.PLATFORM_STATE_TABLE_NAME;
    } else {
      process.env.PLATFORM_STATE_TABLE_NAME = previousTableName;
    }
  }
});

test("default domain state rejects a confirmed one-hundred-first item", async () => {
  const previousTableName = process.env.PLATFORM_STATE_TABLE_NAME;
  const originalSend = DynamoDBClient.prototype.send;
  const commands = [];
  const items = Array.from({ length: 100 }, (_, index) => {
    const id = `domain_${String(index).padStart(3, "0")}`;
    return dynamoDomainItem(id, `Domain ${index}`);
  });
  const lastKey = {
    pk: { S: "DOMAIN" },
    sk: { S: "DOMAIN#domain_099" },
  };
  const responses = [
    { Items: items, LastEvaluatedKey: lastKey },
    { Items: [dynamoDomainItem("domain_100", "Domain 100")] },
  ];

  process.env.PLATFORM_STATE_TABLE_NAME = "PlatformState";
  DynamoDBClient.prototype.send = async function send(command) {
    commands.push(command);
    return responses.shift();
  };
  try {
    const response = await createApiHandler({
      demoOperatorVerifier: allowCurrentDemoOperator,
    })(meEvent({
      requestId: "too-many-domain-items",
    }));
    assert.equal(response.statusCode, 503);
    assert.equal(
      JSON.parse(response.body).code,
      "DEMO_CONTEXT_UNAVAILABLE",
    );
    assert.deepEqual(
      commands.map(({ input }) => ({
        exclusiveStartKey: input.ExclusiveStartKey,
        limit: input.Limit,
      })),
      [
        { exclusiveStartKey: undefined, limit: 100 },
        { exclusiveStartKey: lastKey, limit: 1 },
      ],
    );
  } finally {
    DynamoDBClient.prototype.send = originalSend;
    if (previousTableName === undefined) {
      delete process.env.PLATFORM_STATE_TABLE_NAME;
    } else {
      process.env.PLATFORM_STATE_TABLE_NAME = previousTableName;
    }
  }
});

test("default domain state aborts a hanging query at its deadline", async () => {
  const previousTableName = process.env.PLATFORM_STATE_TABLE_NAME;
  const originalSend = DynamoDBClient.prototype.send;
  const scheduled = [];
  const cleared = [];
  let sendOptions;
  const deadlineTimers = {
    setTimeout(callback, timeoutMs) {
      const handle = { callback, timeoutMs };
      scheduled.push(handle);
      return handle;
    },
    clearTimeout(handle) {
      cleared.push(handle);
    },
  };

  process.env.PLATFORM_STATE_TABLE_NAME = "PlatformState";
  DynamoDBClient.prototype.send = async function send(_command, options) {
    sendOptions = options;
    return new Promise(() => {});
  };
  try {
    const pendingResponse = createApiHandler({
      demoOperatorVerifier: allowCurrentDemoOperator,
      deadlineTimers,
    })(meEvent({ requestId: "domain-query-deadline" }));
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(scheduled.length, 1);
    assert.equal(scheduled[0].timeoutMs, 1_000);
    scheduled[0].callback();

    const response = await pendingResponse;
    assert.equal(response.statusCode, 503);
    assert.equal(
      JSON.parse(response.body).code,
      "DEMO_CONTEXT_UNAVAILABLE",
    );
    assert.ok(sendOptions?.abortSignal);
    assert.equal(sendOptions.abortSignal.aborted, true);
    assert.deepEqual(cleared, scheduled);
  } finally {
    DynamoDBClient.prototype.send = originalSend;
    if (previousTableName === undefined) {
      delete process.env.PLATFORM_STATE_TABLE_NAME;
    } else {
      process.env.PLATFORM_STATE_TABLE_NAME = previousTableName;
    }
  }
});

test("role-switch implementation contains no person-specific configuration", async () => {
  const sourceUrls = [
    new URL("../lambda/api/identity.mjs", import.meta.url),
    new URL("../lambda/api/index.mjs", import.meta.url),
    new URL("../lib/config.ts", import.meta.url),
    new URL("../lib/platform-web-stack.ts", import.meta.url),
    new URL("../../../console/capability-bundles.json", import.meta.url),
  ];
  const emailLiteral =
    /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
  const identityAssignment =
    /\b(?:[A-Z0-9_]*operator[A-Z0-9_]*(?:username|email|subject|sub)|[A-Z0-9_]*(?:username|email|subject|sub)[A-Z0-9_]*operator[A-Z0-9_]*)\b\s*[:=]/i;
  const configuredOperatorValue =
    /\b(?:COGNITO[_-]?)?(?:DEMO|DEPLOYMENT)[A-Z0-9_]*OPERATOR[A-Z0-9_]*\b\s*[:=]\s*["'](?![A-Z0-9_]*PLACEHOLDER\b)[^"']+["']/i;

  for (const assignment of [
    "operatorUsername = GENERIC_PLACEHOLDER",
    "roleSwitchOperatorEmail: GENERIC_PLACEHOLDER",
    "subjectForDemoOperator = GENERIC_PLACEHOLDER",
  ]) {
    assert.match(assignment, identityAssignment);
  }
  assert.match(
    'DEMO_OPERATOR = "configured-user"',
    configuredOperatorValue,
  );
  assert.doesNotMatch(
    'DEMO_OPERATOR = "GENERIC_PLACEHOLDER"',
    configuredOperatorValue,
  );

  for (const sourceUrl of sourceUrls) {
    const source = await readFile(sourceUrl, "utf8");
    assert.doesNotMatch(
      source,
      emailLiteral,
      sourceUrl.pathname,
    );
    assert.doesNotMatch(
      source,
      identityAssignment,
      sourceUrl.pathname,
    );
    assert.doesNotMatch(
      source,
      configuredOperatorValue,
      sourceUrl.pathname,
    );
  }
});

test("GET /api/me fails closed without authorizer claims", async () => {
  const response = await handler({
    requestContext: {
      http: { method: "GET", path: "/api/me" },
      requestId: "unauthenticated-request",
    },
  });

  assert.equal(response.statusCode, 401);
  assert.deepEqual(JSON.parse(response.body), {
    ok: false,
    code: "NOT_AUTHENTICATED",
    message: "Sign in is required.",
    requestId: "unauthenticated-request",
    retryable: false,
  });
});

test("GET /api/me rejects an inherited sub claim", async () => {
  const claims = Object.create({ sub: "inherited-sub" });
  claims.token_use = "access";
  claims["cognito:groups"] = ["platform-admin"];

  const response = await handler({
    requestContext: {
      http: { method: "GET", path: "/api/me" },
      requestId: "inherited-sub-request",
      authorizer: { jwt: { claims } },
    },
  });

  assert.equal(response.statusCode, 401);
  assert.deepEqual(JSON.parse(response.body), {
    ok: false,
    code: "NOT_AUTHENTICATED",
    message: "Sign in is required.",
    requestId: "inherited-sub-request",
    retryable: false,
  });
});

test("GET /api/me rejects non-string or blank sub claims", async () => {
  for (const sub of [123, [], {}, "   "]) {
    const response = await handler({
      requestContext: {
        http: { method: "GET", path: "/api/me" },
        requestId: "invalid-sub-request",
        authorizer: { jwt: { claims: { sub, token_use: "access" } } },
      },
    });

    assert.equal(response.statusCode, 401);
    assert.equal(JSON.parse(response.body).code, "NOT_AUTHENTICATED");
  }
});

test("GET /api/me rejects a missing token_use claim", async () => {
  const response = await handler({
    requestContext: {
      http: { method: "GET", path: "/api/me" },
      requestId: "missing-token-use",
      authorizer: { jwt: { claims: { sub: "sub-123" } } },
    },
  });

  assert.equal(response.statusCode, 401);
  assert.equal(JSON.parse(response.body).code, "NOT_AUTHENTICATED");
});

test("GET /api/me rejects an ID token", async () => {
  const response = await handler({
    requestContext: {
      http: { method: "GET", path: "/api/me" },
      requestId: "id-token",
      authorizer: {
        jwt: { claims: { sub: "sub-123", token_use: "id" } },
      },
    },
  });

  assert.equal(response.statusCode, 401);
  assert.equal(JSON.parse(response.body).code, "NOT_AUTHENTICATED");
});

test("GET /api/me rejects an inherited access token_use claim", async () => {
  const claims = Object.create({ token_use: "access" });
  claims.sub = "sub-123";

  const response = await handler({
    requestContext: {
      http: { method: "GET", path: "/api/me" },
      requestId: "inherited-token-use",
      authorizer: { jwt: { claims } },
    },
  });

  assert.equal(response.statusCode, 401);
  assert.equal(JSON.parse(response.body).code, "NOT_AUTHENTICATED");
});

test("unknown routes return a stable not-found error", async () => {
  const response = await handler({
    method: "GET",
    path: "/api/health",
    requestContext: {
      http: { method: "POST", path: "/api/unknown" },
      requestId: "not-found-request",
    },
  });

  assert.equal(response.statusCode, 404);
  assert.deepEqual(JSON.parse(response.body), {
    ok: false,
    code: "ROUTE_NOT_FOUND",
    message: "The requested route is not available.",
    requestId: "not-found-request",
    retryable: false,
  });
});

test("GET /api/me denies a stale demo-role claim when current Cognito membership is revoked", async () => {
  const verifierCalls = [];
  const api = createApiHandler({
    demoOperatorVerifier: async (claims) => {
      verifierCalls.push(claims);
      return false;
    },
  });
  const response = await api(meEvent({
    headers: { "x-demo-role": "admin" },
  }));

  assert.equal(response.statusCode, 403);
  assert.equal(JSON.parse(response.body).code, "DEMO_ROLE_NOT_ALLOWED");
  assert.deepEqual(verifierCalls, [operatorClaims]);
});

test("GET /api/me removes stale demo selectors after current membership is revoked", async () => {
  const verifierCalls = [];
  let domainReads = 0;
  const api = createApiHandler({
    demoOperatorVerifier: async (claims) => {
      verifierCalls.push(claims);
      return false;
    },
    domainState: {
      async listDomains() {
        domainReads += 1;
        return [];
      },
    },
  });

  const response = await api(meEvent());
  const body = JSON.parse(response.body);

  assert.equal(response.statusCode, 200);
  assert.equal(body.role, "admin");
  assert.equal(body.authenticatedRole, "admin");
  assert.equal(body.canSwitchDemoRole, false);
  assert.deepEqual(body.availableDemoRoles, []);
  assert.deepEqual(body.availableDemoDomains, []);
  assert.deepEqual(verifierCalls, [operatorClaims]);
  assert.equal(domainReads, 0);
});

test("GET /api/me fails closed when authoritative Cognito verification is unavailable", async () => {
  const api = createApiHandler({
    demoOperatorVerifier: async () => {
      throw new Error("Cognito unavailable");
    },
  });
  const response = await api(meEvent({
    headers: { "x-demo-role": "admin" },
    requestId: "authoritative-identity-unavailable",
  }));

  assert.equal(response.statusCode, 503);
  assert.deepEqual(JSON.parse(response.body), {
    ok: false,
    code: "DEMO_CONTEXT_UNAVAILABLE",
    message: "Demo role context is temporarily unavailable.",
    requestId: "authoritative-identity-unavailable",
    retryable: true,
  });
});
