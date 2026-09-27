const API_VERSION = "2022-11-28";
const OWNER_PATTERN =
  /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const REPOSITORY_PATTERN = /^[a-z0-9][a-z0-9._-]{0,99}$/;
const SHA_PATTERN = /^[a-f0-9]{40}$/;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_COMMIT_BYTES = 8 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 5_000;

export class GitHubClientError extends Error {
  constructor(code) {
    super("GitHub operation failed.");
    this.name = "GitHubClientError";
    this.code = code;
  }
}

function fail(code) {
  throw new GitHubClientError(code);
}

function plain(value) {
  return Boolean(
    value
    && typeof value === "object"
    && !Array.isArray(value)
    && (
      Object.getPrototypeOf(value) === Object.prototype
      || Object.getPrototypeOf(value) === null
    ),
  );
}

function text(value, maxBytes, { empty = false } = {}) {
  return (
    typeof value === "string"
    && value === value.trim()
    && Buffer.byteLength(value) <= maxBytes
    && (empty || value.length > 0)
    && !/[\u0000-\u001f\u007f]/.test(value)
  );
}

function multilineText(value, maxBytes) {
  return typeof value === "string"
    && value === value.trim()
    && value.length > 0
    && Buffer.byteLength(value) <= maxBytes
    && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value);
}

function repositoryName(value) {
  return typeof value === "string"
    && value === value.toLowerCase()
    && REPOSITORY_PATTERN.test(value);
}

function branchName(value) {
  return (
    text(value, 255)
    && !value.startsWith("/")
    && !value.endsWith("/")
    && !value.includes("..")
    && !value.includes("//")
    && !value.endsWith(".")
    && !value.endsWith(".lock")
    && /^[A-Za-z0-9._/-]+$/.test(value)
  );
}

function filePath(value) {
  return (
    text(value, 512)
    && !value.startsWith("/")
    && !value.includes("\\")
    && value.split("/").every((part) =>
      part.length > 0 && part !== "." && part !== "..")
  );
}

function headers(response) {
  return {
    scopes: String(response.headers.get("x-oauth-scopes") || "")
      .split(",")
      .map((scope) => scope.trim())
      .filter(Boolean),
    rateRemaining: response.headers.get("x-ratelimit-remaining"),
  };
}

async function json(response) {
  const body = await response.text();
  if (Buffer.byteLength(body) > MAX_RESPONSE_BYTES) {
    fail("INVALID_RESPONSE");
  }
  if (!body) return null;
  try {
    return JSON.parse(body);
  } catch {
    fail("INVALID_RESPONSE");
  }
}

function errorFor(response, metadata) {
  if (response.status === 401) return "AUTHENTICATION_FAILED";
  if (
    response.status === 429
    || (
      response.status === 403
      && metadata.rateRemaining === "0"
    )
  ) {
    return "RATE_LIMITED";
  }
  if (response.status === 403) return "PERMISSION_DENIED";
  if (response.status === 404) return "NOT_FOUND";
  if (response.status === 409 || response.status === 422) return "CONFLICT";
  return response.status >= 500 ? "UNAVAILABLE" : "INVALID_RESPONSE";
}

function requestSignal(signal) {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  return signal === undefined
    ? timeout
    : AbortSignal.any([signal, timeout]);
}

function createRequest({ token, fetchImpl, apiBaseUrl, signal }) {
  return async function request(path, {
    method = "GET",
    body,
    nullOn404 = false,
  } = {}) {
    let response;
    try {
      response = await fetchImpl(`${apiBaseUrl}${path}`, {
        method,
        signal: requestSignal(signal),
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${token}`,
          "x-github-api-version": API_VERSION,
          ...(body === undefined
            ? {}
            : { "content-type": "application/json" }),
          "user-agent": "agentic-platform-journey-delivery",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      fail("UNAVAILABLE");
    }
    if (
      !response
      || typeof response.status !== "number"
      || typeof response.text !== "function"
    ) {
      fail("INVALID_RESPONSE");
    }
    const metadata = headers(response);
    if (response.status === 404 && nullOn404) {
      await json(response);
      return { value: null, metadata };
    }
    if (response.status < 200 || response.status >= 300) {
      await json(response);
      fail(errorFor(response, metadata));
    }
    return { value: await json(response), metadata };
  };
}

function identity(value, metadata) {
  if (
    !plain(value)
    || !Number.isSafeInteger(value.id)
    || value.id < 1
    || !OWNER_PATTERN.test(value.login)
    || value.type !== "User"
  ) {
    fail("INVALID_RESPONSE");
  }
  const canCreatePrivateRepositories = metadata.scopes.includes("repo");
  const canManageWorkflows = metadata.scopes.includes("workflow");
  if (
    canCreatePrivateRepositories === false
    || canManageWorkflows === false
  ) {
    fail("PERMISSION_DENIED");
  }
  return {
    login: value.login,
    userId: value.id,
    canCreatePrivateRepositories,
    canManageWorkflows,
  };
}

export async function probeGitHubIdentity({
  token,
  fetch: fetchImpl,
  apiBaseUrl = "https://api.github.com",
  signal,
} = {}) {
  if (
    !text(token, 2048)
    || typeof fetchImpl !== "function"
    || apiBaseUrl !== "https://api.github.com"
    || (
      signal !== undefined
      && !(signal instanceof AbortSignal)
    )
  ) {
    throw new TypeError("GitHub client configuration is invalid.");
  }
  const request = createRequest({
    token,
    fetchImpl,
    apiBaseUrl,
    signal,
  });
  const result = await request("/user");
  return identity(result.value, result.metadata);
}

function repositoryResult(value, owner) {
  const description = value?.description ?? "";
  if (
    !plain(value)
    || !Number.isSafeInteger(value.id)
    || value.id < 1
    || !text(value.node_id, 256)
    || !repositoryName(value.name)
    || value.full_name !== `${owner}/${value.name}`
    || value.private !== true
    || !text(description, 2048, { empty: true })
    || !text(value.html_url, 2048)
    || !branchName(value.default_branch)
    || !plain(value.owner)
    || value.owner.login !== owner
    || !Number.isSafeInteger(value.owner.id)
    || value.owner.id < 1
  ) {
    fail("FOREIGN_RESOURCE");
  }
  return {
    id: value.id,
    nodeId: value.node_id,
    name: value.name,
    fullName: value.full_name,
    private: true,
    description,
    url: value.html_url,
    defaultBranch: value.default_branch,
    owner,
    ownerId: value.owner.id,
  };
}

function pullRequestResult(value, head, base) {
  if (
    !plain(value)
    || !Number.isSafeInteger(value.id)
    || value.id < 1
    || !text(value.node_id, 256)
    || !Number.isSafeInteger(value.number)
    || value.number < 1
    || value.state !== "open"
    || !text(value.html_url, 2048)
    || value.head?.ref !== head
    || value.base?.ref !== base
  ) {
    fail("FOREIGN_RESOURCE");
  }
  return {
    id: value.id,
    nodeId: value.node_id,
    number: value.number,
    state: "open",
    url: value.html_url,
    head,
    base,
  };
}

export function createGitHubClient({
  owner,
  token,
  fetch: fetchImpl,
  apiBaseUrl = "https://api.github.com",
  signal,
} = {}) {
  if (
    typeof owner !== "string"
    || !OWNER_PATTERN.test(owner)
    || !text(token, 2048)
    || typeof fetchImpl !== "function"
    || apiBaseUrl !== "https://api.github.com"
    || (
      signal !== undefined
      && !(signal instanceof AbortSignal)
    )
  ) {
    throw new TypeError("GitHub client configuration is invalid.");
  }

  const request = createRequest({
    token,
    fetchImpl,
    apiBaseUrl,
    signal,
  });

  return Object.freeze({
    async preflight() {
      const result = await probeGitHubIdentity({
        token,
        fetch: fetchImpl,
        apiBaseUrl,
        signal,
      });
      if (result.login !== owner) fail("OWNER_MISMATCH");
      return {
        configured: true,
        connected: true,
        owner,
        authenticatedLogin: result.login,
        authenticatedUserId: result.userId,
        canCreatePrivateRepositories: result.canCreatePrivateRepositories,
        canManageWorkflows: result.canManageWorkflows,
      };
    },

    async createPrivateRepository({ name, description } = {}) {
      if (!repositoryName(name) || !text(description, 2048, { empty: true })) {
        fail("INVALID_REQUEST");
      }
      const { value } = await request("/user/repos", {
        method: "POST",
        body: {
          name,
          description,
          private: true,
          auto_init: true,
        },
      });
      return repositoryResult(value, owner);
    },

    async getRepository({ name } = {}) {
      if (!repositoryName(name)) fail("INVALID_REQUEST");
      const { value } = await request(
        `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`,
        { nullOn404: true },
      );
      return value === null ? null : repositoryResult(value, owner);
    },

    async getBranch({ repository, branch } = {}) {
      if (!repositoryName(repository) || !branchName(branch)) {
        fail("INVALID_REQUEST");
      }
      const { value } = await request(
        `/repos/${encodeURIComponent(owner)}/`
          + `${encodeURIComponent(repository)}/branches/`
          + branch.split("/").map(encodeURIComponent).join("/"),
        { nullOn404: true },
      );
      if (value === null) return null;
      if (
        !plain(value)
        || value.name !== branch
        || !plain(value.commit)
        || !SHA_PATTERN.test(value.commit.sha)
      ) {
        fail("FOREIGN_RESOURCE");
      }
      return { name: branch, sha: value.commit.sha };
    },

    async renameBranch({ repository, branch, newName } = {}) {
      if (
        !repositoryName(repository)
        || !branchName(branch)
        || !branchName(newName)
        || branch === newName
      ) {
        fail("INVALID_REQUEST");
      }
      const { value } = await request(
        `/repos/${encodeURIComponent(owner)}/`
          + `${encodeURIComponent(repository)}/branches/`
          + `${branch.split("/").map(encodeURIComponent).join("/")}/rename`,
        {
          method: "POST",
          body: { new_name: newName },
        },
      );
      if (
        !plain(value)
        || value.name !== newName
        || !plain(value.commit)
        || !SHA_PATTERN.test(value.commit.sha)
      ) {
        fail("INVALID_RESPONSE");
      }
      return { name: newName, sha: value.commit.sha };
    },

    async createBranch({ repository, branch, sha } = {}) {
      if (
        !repositoryName(repository)
        || !branchName(branch)
        || !SHA_PATTERN.test(sha)
      ) {
        fail("INVALID_REQUEST");
      }
      const { value } = await request(
        `/repos/${encodeURIComponent(owner)}/`
          + `${encodeURIComponent(repository)}/git/refs`,
        {
          method: "POST",
          body: {
            ref: `refs/heads/${branch}`,
            sha,
          },
        },
      );
      if (
        !plain(value)
        || value.ref !== `refs/heads/${branch}`
        || !plain(value.object)
        || value.object.type !== "commit"
        || value.object.sha !== sha
      ) {
        fail("INVALID_RESPONSE");
      }
      return { ref: value.ref, sha: value.object.sha };
    },

    async commitFiles({
      repository,
      branch,
      expectedHeadOid,
      message,
      files,
    } = {}) {
      if (
        !repositoryName(repository)
        || !branchName(branch)
        || !SHA_PATTERN.test(expectedHeadOid)
        || !text(message, 256)
        || !Array.isArray(files)
        || files.length === 0
        || files.length > 100
      ) {
        fail("INVALID_REQUEST");
      }
      let bytes = 0;
      const paths = new Set();
      const additions = files.map((file) => {
        if (
          !plain(file)
          || Object.keys(file).sort().join(",") !== "content,path"
          || !filePath(file.path)
          || paths.has(file.path)
          || typeof file.content !== "string"
        ) {
          fail("INVALID_REQUEST");
        }
        paths.add(file.path);
        const size = Buffer.byteLength(file.content);
        if (size > MAX_FILE_BYTES) fail("INVALID_REQUEST");
        bytes += size;
        return {
          path: file.path,
          contents: Buffer.from(file.content).toString("base64"),
        };
      });
      if (bytes > MAX_COMMIT_BYTES) fail("INVALID_REQUEST");

      const { value } = await request("/graphql", {
        method: "POST",
        body: {
          query: [
            "mutation CreateCommit($input: CreateCommitOnBranchInput!) {",
            "  createCommitOnBranch(input: $input) {",
            "    commit { oid url tree { oid } }",
            "  }",
            "}",
          ].join("\n"),
          variables: {
            input: {
              branch: {
                repositoryNameWithOwner: `${owner}/${repository}`,
                branchName: branch,
              },
              message: { headline: message },
              fileChanges: { additions },
              expectedHeadOid,
            },
          },
        },
      });
      if (Array.isArray(value?.errors) && value.errors.length > 0) {
        const types = value.errors.map(({ type }) => type);
        if (types.includes("FORBIDDEN")) fail("PERMISSION_DENIED");
        if (
          types.includes("UNPROCESSABLE")
          || types.includes("VALIDATION")
        ) {
          fail("CONFLICT");
        }
        fail("UNAVAILABLE");
      }
      const commit = value?.data?.createCommitOnBranch?.commit;
      if (
        !plain(commit)
        || !SHA_PATTERN.test(commit.oid)
        || !text(commit.url, 2048)
        || !SHA_PATTERN.test(commit.tree?.oid)
      ) {
        fail("INVALID_RESPONSE");
      }
      return {
        oid: commit.oid,
        treeOid: commit.tree.oid,
        url: commit.url,
      };
    },

    async getCommit({ repository, sha } = {}) {
      if (!repositoryName(repository) || !SHA_PATTERN.test(sha)) {
        fail("INVALID_REQUEST");
      }
      const { value } = await request(
        `/repos/${encodeURIComponent(owner)}/`
          + `${encodeURIComponent(repository)}/git/commits/${sha}`,
        { nullOn404: true },
      );
      if (value === null) return null;
      if (
        !plain(value)
        || value.sha !== sha
        || !multilineText(value.message, 16_384)
        || !SHA_PATTERN.test(value.tree?.sha)
        || !text(value.html_url, 2048)
      ) {
        fail("FOREIGN_RESOURCE");
      }
      return {
        sha,
        message: value.message,
        treeSha: value.tree.sha,
        url: value.html_url,
      };
    },

    async getCommitTree({ repository, treeSha } = {}) {
      if (!repositoryName(repository) || !SHA_PATTERN.test(treeSha)) {
        fail("INVALID_REQUEST");
      }
      const { value } = await request(
        `/repos/${encodeURIComponent(owner)}/`
          + `${encodeURIComponent(repository)}/git/trees/${treeSha}`
          + "?recursive=1",
      );
      if (
        !plain(value)
        || value.sha !== treeSha
        || value.truncated !== false
        || !Array.isArray(value.tree)
        || value.tree.length > 1_000
      ) {
        fail("FOREIGN_RESOURCE");
      }
      const files = [];
      for (const entry of value.tree) {
        if (
          !plain(entry)
          || !filePath(entry.path)
          || !SHA_PATTERN.test(entry.sha)
        ) {
          fail("FOREIGN_RESOURCE");
        }
        if (
          entry.type === "tree"
          && entry.mode === "040000"
          && entry.size === undefined
        ) {
          continue;
        }
        if (
          entry.type !== "blob"
          || entry.mode !== "100644"
          || !Number.isSafeInteger(entry.size)
          || entry.size < 0
          || entry.size > MAX_FILE_BYTES
        ) {
          fail("FOREIGN_RESOURCE");
        }
        files.push({
          path: entry.path,
          sha: entry.sha,
          size: entry.size,
        });
      }
      return files.sort((left, right) =>
        left.path.localeCompare(right.path));
    },

    async createPullRequest({
      repository,
      head,
      base,
      title,
      body,
    } = {}) {
      if (
        !repositoryName(repository)
        || !branchName(head)
        || !branchName(base)
        || head === base
        || !text(title, 256)
        || !text(body, 16_384, { empty: true })
      ) {
        fail("INVALID_REQUEST");
      }
      const { value } = await request(
        `/repos/${encodeURIComponent(owner)}/`
          + `${encodeURIComponent(repository)}/pulls`,
        {
          method: "POST",
          body: { title, body, head, base },
        },
      );
      try {
        return pullRequestResult(value, head, base);
      } catch (error) {
        if (error instanceof GitHubClientError) fail("INVALID_RESPONSE");
        throw error;
      }
    },

    async findOpenPullRequest({
      repository,
      head,
      base,
    } = {}) {
      if (
        !repositoryName(repository)
        || !branchName(head)
        || !branchName(base)
        || head === base
      ) {
        fail("INVALID_REQUEST");
      }
      const query = new URLSearchParams({
        state: "open",
        head: `${owner}:${head}`,
        base,
        per_page: "100",
      });
      const { value } = await request(
        `/repos/${encodeURIComponent(owner)}/`
          + `${encodeURIComponent(repository)}/pulls?${query}`,
      );
      if (!Array.isArray(value) || value.length > 1) {
        fail("FOREIGN_RESOURCE");
      }
      return value.length === 0
        ? null
        : pullRequestResult(value[0], head, base);
    },

    async getPullRequest({
      repository,
      number,
      head,
      base,
    } = {}) {
      if (
        !repositoryName(repository)
        || !Number.isSafeInteger(number)
        || number < 1
        || !branchName(head)
        || !branchName(base)
        || head === base
      ) {
        fail("INVALID_REQUEST");
      }
      const { value } = await request(
        `/repos/${encodeURIComponent(owner)}/`
          + `${encodeURIComponent(repository)}/pulls/${number}`,
        { nullOn404: true },
      );
      if (value === null) return null;
      const result = pullRequestResult(value, head, base);
      if (result.number !== number) fail("FOREIGN_RESOURCE");
      return result;
    },
  });
}
