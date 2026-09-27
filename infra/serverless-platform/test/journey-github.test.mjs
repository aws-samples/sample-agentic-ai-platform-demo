import assert from "node:assert/strict";
import test from "node:test";
import {
  GitHubClientError,
  createGitHubClient,
  probeGitHubIdentity,
} from "../lambda/journeys/github.mjs";

const TOKEN = "test-token-value";
const OWNER = "ExampleOwner";

function response(status, body, headers = {}) {
  return new Response(
    body === null ? null : JSON.stringify(body),
    {
      status,
      headers: {
        ...(body === null ? {} : { "content-type": "application/json" }),
        ...headers,
      },
    },
  );
}

function harness(replies) {
  const calls = [];
  const queue = [...replies];
  const client = createGitHubClient({
    owner: OWNER,
    token: TOKEN,
    async fetch(url, options) {
      calls.push({
        url,
        options: {
          ...options,
          headers: { ...options.headers },
        },
      });
      if (queue.length === 0) {
        throw new Error("Unexpected GitHub request.");
      }
      const next = queue.shift();
      if (next instanceof Error) throw next;
      return next;
    },
  });
  return { calls, client };
}

function expectCode(code) {
  return (error) => {
    assert.ok(error instanceof GitHubClientError);
    assert.equal(error.code, code);
    assert.equal(error.message.includes(TOKEN), false);
    return true;
  };
}

test("GitHub client requires bounded owner, token, and fetch configuration", () => {
  for (const input of [
    {},
    { owner: OWNER, token: TOKEN },
    { owner: "not an owner!", token: TOKEN, fetch: globalThis.fetch },
    { owner: OWNER, token: "", fetch: globalThis.fetch },
  ]) {
    assert.throws(
      () => createGitHubClient(input),
      /GitHub client configuration is invalid/,
    );
  }
});

test("identity probe discovers the repository owner and required scopes before client construction", async () => {
  const calls = [];
  const fetch = async (url, options) => {
    calls.push({ url, options });
    return response(200, {
      id: 12345,
      login: OWNER,
      type: "User",
    }, {
      "x-oauth-scopes": "repo, workflow, read:user",
    });
  };

  assert.deepEqual(
    await probeGitHubIdentity({ token: TOKEN, fetch }),
    {
      login: OWNER,
      userId: 12345,
      canCreatePrivateRepositories: true,
      canManageWorkflows: true,
    },
  );
  assert.equal(calls[0].url, "https://api.github.com/user");
  assert.equal(calls[0].options.headers.authorization, `Bearer ${TOKEN}`);
  assert.ok(calls[0].options.signal instanceof AbortSignal);

  await assert.rejects(
    probeGitHubIdentity({
      token: TOKEN,
      fetch: async () => response(200, {
        id: 12345,
        login: OWNER,
        type: "User",
      }, {
        "x-oauth-scopes": "repo, read:user",
      }),
    }),
    expectCode("PERMISSION_DENIED"),
  );
  await assert.rejects(
    probeGitHubIdentity({
      token: TOKEN,
      fetch: async () => response(200, {
        id: 12345,
        login: OWNER,
        type: "User",
      }),
    }),
    expectCode("PERMISSION_DENIED"),
  );
});

test("preflight verifies the authenticated login without returning credentials", async () => {
  const { calls, client } = harness([
    response(200, {
      id: 12345,
      login: OWNER,
      type: "User",
    }, {
      "x-oauth-scopes": "repo, workflow, read:user",
      "x-ratelimit-remaining": "4999",
    }),
  ]);

  const result = await client.preflight();
  assert.deepEqual(result, {
    configured: true,
    connected: true,
    owner: OWNER,
    authenticatedLogin: OWNER,
    authenticatedUserId: 12345,
    canCreatePrivateRepositories: true,
    canManageWorkflows: true,
  });
  assert.equal(calls[0].url, "https://api.github.com/user");
  assert.equal(calls[0].options.method, "GET");
  assert.equal(calls[0].options.headers.authorization, `Bearer ${TOKEN}`);
  assert.equal(JSON.stringify(result).includes(TOKEN), false);
});

test("preflight rejects a classic token without workflow permission", async () => {
  const { client } = harness([
    response(200, {
      id: 12345,
      login: OWNER,
      type: "User",
    }, {
      "x-oauth-scopes": "repo, read:user",
    }),
  ]);
  await assert.rejects(client.preflight(), expectCode("PERMISSION_DENIED"));
});

test("preflight rejects a credential for a different owner", async () => {
  const { client } = harness([
    response(
      200,
      { id: 54321, login: "DifferentOwner", type: "User" },
      { "x-oauth-scopes": "repo, workflow" },
    ),
  ]);
  await assert.rejects(client.preflight(), expectCode("OWNER_MISMATCH"));
});

test("GitHub failures map to stable redacted service codes", async () => {
  for (const [reply, code] of [
    [response(401, { message: `bad ${TOKEN}` }), "AUTHENTICATION_FAILED"],
    [response(403, { message: `denied ${TOKEN}` }), "PERMISSION_DENIED"],
    [
      response(
        403,
        { message: `rate ${TOKEN}` },
        { "x-ratelimit-remaining": "0" },
      ),
      "RATE_LIMITED",
    ],
    [response(429, { message: `slow ${TOKEN}` }), "RATE_LIMITED"],
    [new Error(`network ${TOKEN}`), "UNAVAILABLE"],
  ]) {
    const { client } = harness([reply]);
    await assert.rejects(client.preflight(), expectCode(code));
  }
});

test("private repository creation is exact and existing names conflict", async () => {
  const { calls, client } = harness([
    response(201, {
      id: 98765,
      node_id: "R_kgDOExample",
      name: "support-agent",
      full_name: `${OWNER}/support-agent`,
      private: true,
      description: "Governed agent source.",
      html_url: `https://github.com/${OWNER}/support-agent`,
      default_branch: "main",
      owner: { login: OWNER, id: 12345 },
    }),
  ]);
  assert.deepEqual(
    await client.createPrivateRepository({
      name: "support-agent",
      description: "Governed agent source.",
    }),
    {
      id: 98765,
      nodeId: "R_kgDOExample",
      name: "support-agent",
      fullName: `${OWNER}/support-agent`,
      private: true,
      description: "Governed agent source.",
      url: `https://github.com/${OWNER}/support-agent`,
      defaultBranch: "main",
      owner: OWNER,
      ownerId: 12345,
    },
  );
  assert.equal(calls[0].url, "https://api.github.com/user/repos");
  assert.ok(calls[0].options.signal instanceof AbortSignal);
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    name: "support-agent",
    description: "Governed agent source.",
    private: true,
    auto_init: true,
  });

  const conflict = harness([
    response(422, { message: "name already exists" }),
  ]);
  await assert.rejects(
    conflict.client.createPrivateRepository({
      name: "support-agent",
      description: "",
    }),
    expectCode("CONFLICT"),
  );
});

test("repository verification rejects foreign or public repositories", async () => {
  for (const repository of [
    {
      id: 1,
      node_id: "R_kgDOForeign",
      name: "support-agent",
      full_name: "ForeignOwner/support-agent",
      private: true,
      description: "Foreign repository.",
      html_url: "https://github.com/ForeignOwner/support-agent",
      default_branch: "main",
      owner: { login: "ForeignOwner", id: 9 },
    },
    {
      id: 1,
      node_id: "R_kgDOPublic",
      name: "support-agent",
      full_name: `${OWNER}/support-agent`,
      private: false,
      description: "Public repository.",
      html_url: `https://github.com/${OWNER}/support-agent`,
      default_branch: "main",
      owner: { login: OWNER, id: 9 },
    },
  ]) {
    const { client } = harness([response(200, repository)]);
    await assert.rejects(
      client.getRepository({ name: "support-agent" }),
      expectCode("FOREIGN_RESOURCE"),
    );
  }

  const { client } = harness([response(404, { message: "not found" })]);
  assert.equal(
    await client.getRepository({ name: "support-agent" }),
    null,
  );
});

test("branch creation uses the exact expected commit", async () => {
  const { calls, client } = harness([
    response(201, {
      ref: "refs/heads/platform/full-abcdef12",
      object: {
        type: "commit",
        sha: "a".repeat(40),
        url: "https://api.github.com/commit",
      },
    }),
  ]);
  assert.deepEqual(
    await client.createBranch({
      repository: "support-agent",
      branch: "platform/full-abcdef12",
      sha: "a".repeat(40),
    }),
    {
      ref: "refs/heads/platform/full-abcdef12",
      sha: "a".repeat(40),
    },
  );
  assert.equal(
    calls[0].url,
    `https://api.github.com/repos/${OWNER}/support-agent/git/refs`,
  );
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    ref: "refs/heads/platform/full-abcdef12",
    sha: "a".repeat(40),
  });
});

test("file sets are committed atomically with GitHub GraphQL", async () => {
  const { calls, client } = harness([
    response(200, {
      data: {
        createCommitOnBranch: {
          commit: {
            oid: "b".repeat(40),
            url: `https://github.com/${OWNER}/support-agent/commit/${"b".repeat(40)}`,
            tree: {
              oid: "c".repeat(40),
            },
          },
        },
      },
    }),
  ]);
  const files = [
    { path: "README.md", content: "# Support agent\n" },
    { path: "gates/platform-gates.json", content: "{}\n" },
  ];
  assert.deepEqual(
    await client.commitFiles({
      repository: "support-agent",
      branch: "main",
      expectedHeadOid: "a".repeat(40),
      message: "Bootstrap platform foundation",
      files,
    }),
    {
      oid: "b".repeat(40),
      treeOid: "c".repeat(40),
      url: `https://github.com/${OWNER}/support-agent/commit/${"b".repeat(40)}`,
    },
  );
  assert.equal(calls[0].url, "https://api.github.com/graphql");
  const body = JSON.parse(calls[0].options.body);
  assert.equal(
    body.variables.input.branch.repositoryNameWithOwner,
    `${OWNER}/support-agent`,
  );
  assert.deepEqual(
    body.variables.input.fileChanges.additions,
    files.map(({ path, content }) => ({
      path,
      contents: Buffer.from(content).toString("base64"),
    })),
  );
});

test("commit verification returns the exact immutable marker", async () => {
  const sha = "b".repeat(40);
  const { calls, client } = harness([
    response(200, {
      sha,
      message: "feat: add FULL platform source\n\nDelivery: abcdef12",
      tree: { sha: "c".repeat(40) },
      html_url: `https://github.com/${OWNER}/support-agent/commit/${sha}`,
    }),
  ]);
  assert.deepEqual(
    await client.getCommit({
      repository: "support-agent",
      sha,
    }),
    {
      sha,
      message: "feat: add FULL platform source\n\nDelivery: abcdef12",
      treeSha: "c".repeat(40),
      url: `https://github.com/${OWNER}/support-agent/commit/${sha}`,
    },
  );
  assert.equal(
    calls[0].url,
    `https://api.github.com/repos/${OWNER}/support-agent/git/commits/${sha}`,
  );
});

test("commit tree verification returns only exact regular files", async () => {
  const treeSha = "c".repeat(40);
  const { calls, client } = harness([
    response(200, {
      sha: treeSha,
      truncated: false,
      tree: [
        {
          path: "README.md",
          mode: "100644",
          type: "blob",
          sha: "d".repeat(40),
          size: 18,
        },
        {
          path: "gates",
          mode: "040000",
          type: "tree",
          sha: "e".repeat(40),
        },
        {
          path: "gates/platform-gates.json",
          mode: "100644",
          type: "blob",
          sha: "f".repeat(40),
          size: 42,
        },
      ],
    }),
  ]);

  assert.deepEqual(
    await client.getCommitTree({
      repository: "support-agent",
      treeSha,
    }),
    [
      {
        path: "gates/platform-gates.json",
        sha: "f".repeat(40),
        size: 42,
      },
      { path: "README.md", sha: "d".repeat(40), size: 18 },
    ],
  );
  assert.equal(
    calls[0].url,
    `https://api.github.com/repos/${OWNER}/support-agent/git/trees/`
      + `${treeSha}?recursive=1`,
  );
});

test("commit tree verification rejects truncated or executable content", async () => {
  for (const value of [
    {
      sha: "c".repeat(40),
      truncated: true,
      tree: [],
    },
    {
      sha: "c".repeat(40),
      truncated: false,
      tree: [{
        path: "deploy.sh",
        mode: "100755",
        type: "blob",
        sha: "d".repeat(40),
        size: 12,
      }],
    },
  ]) {
    const { client } = harness([response(200, value)]);
    await assert.rejects(
      client.getCommitTree({
        repository: "support-agent",
        treeSha: "c".repeat(40),
      }),
      (error) => error.code === "FOREIGN_RESOURCE",
    );
  }
});

test("pull request creation is exact and conflicts fail closed", async () => {
  const { calls, client } = harness([
    response(201, {
      id: 321,
      node_id: "PR_kwDOExample",
      number: 7,
      state: "open",
      html_url: `https://github.com/${OWNER}/support-agent/pull/7`,
      head: { ref: "platform/full-abcdef12" },
      base: { ref: "main" },
    }),
  ]);
  assert.deepEqual(
    await client.createPullRequest({
      repository: "support-agent",
      head: "platform/full-abcdef12",
      base: "main",
      title: "Add governed FULL agent",
      body: "Generated from approved platform resources.",
    }),
    {
      id: 321,
      nodeId: "PR_kwDOExample",
      number: 7,
      state: "open",
      url: `https://github.com/${OWNER}/support-agent/pull/7`,
      head: "platform/full-abcdef12",
      base: "main",
    },
  );
  assert.equal(
    calls[0].url,
    `https://api.github.com/repos/${OWNER}/support-agent/pulls`,
  );

  const conflict = harness([
    response(422, { message: "pull request already exists" }),
  ]);
  await assert.rejects(
    conflict.client.createPullRequest({
      repository: "support-agent",
      head: "platform/full-abcdef12",
      base: "main",
      title: "Add governed FULL agent",
      body: "",
    }),
    expectCode("CONFLICT"),
  );
});

test("pull request verification rejects a foreign branch", async () => {
  const { client } = harness([
    response(200, {
      id: 321,
      node_id: "PR_kwDOExample",
      number: 7,
      state: "open",
      html_url: `https://github.com/${OWNER}/support-agent/pull/7`,
      head: { ref: "foreign/source" },
      base: { ref: "main" },
    }),
  ]);
  await assert.rejects(
    client.getPullRequest({
      repository: "support-agent",
      number: 7,
      head: "platform/full-abcdef12",
      base: "main",
    }),
    expectCode("FOREIGN_RESOURCE"),
  );
});

test("open pull request lookup is exact and rejects ambiguous matches", async () => {
  const pull = {
    id: 321,
    node_id: "PR_kwDOExample",
    number: 7,
    state: "open",
    html_url: `https://github.com/${OWNER}/support-agent/pull/7`,
    head: { ref: "platform/full-abcdef12" },
    base: { ref: "main" },
  };
  const { calls, client } = harness([response(200, [pull])]);
  assert.deepEqual(
    await client.findOpenPullRequest({
      repository: "support-agent",
      head: "platform/full-abcdef12",
      base: "main",
    }),
    {
      id: 321,
      nodeId: "PR_kwDOExample",
      number: 7,
      state: "open",
      url: `https://github.com/${OWNER}/support-agent/pull/7`,
      head: "platform/full-abcdef12",
      base: "main",
    },
  );
  assert.match(calls[0].url, /state=open/);
  assert.match(calls[0].url, /head=ExampleOwner%3Aplatform%2Ffull-abcdef12/);

  await assert.rejects(
    harness([response(200, [pull, { ...pull, number: 8 }])])
      .client.findOpenPullRequest({
        repository: "support-agent",
        head: "platform/full-abcdef12",
        base: "main",
      }),
    expectCode("FOREIGN_RESOURCE"),
  );
});
