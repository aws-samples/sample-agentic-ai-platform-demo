import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { parse } from "yaml";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const {
  PLATFORM_WEB_RUNTIME_ROLE_NAMES,
  REQUIRED_TAGS,
  RUNTIME_PERMISSIONS_BOUNDARY_NAME,
  stackName,
} = require("../lib/config.ts");

const README_PATH = fileURLToPath(new URL("../README.md", import.meta.url));
const PLATFORM_ROOT = fileURLToPath(new URL("..", import.meta.url));
const REPOSITORY_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const PLATFORM_REGISTRY_ROOT = path.join(
  REPOSITORY_ROOT,
  "infra",
  "platform-registry",
);
const PLATFORM_REGISTRY_README_PATH = path.join(
  PLATFORM_REGISTRY_ROOT,
  "README.md",
);
const CONTROL_PLANE_OUTPUTS_PATH = path.join(
  PLATFORM_REGISTRY_ROOT,
  "control-plane-outputs.json",
);
const CONSOLE_PUBLIC_ROOT = fileURLToPath(
  new URL("../../../console/public", import.meta.url),
);
const PACKAGE_PATH = fileURLToPath(new URL("../package.json", import.meta.url));
const ROOT_PACKAGE_PATH = fileURLToPath(
  new URL("../../../package.json", import.meta.url),
);
const DEPLOY_WORKFLOW_PATH = fileURLToPath(
  new URL(
    "../../../.github/workflows/deploy-serverless-platform.yml",
    import.meta.url,
  ),
);
const TRIGGER_WORKFLOW_PATH = fileURLToPath(
  new URL(
    "../../../.github/workflows/verify-serverless-platform.yml",
    import.meta.url,
  ),
);
const APP_PATH = fileURLToPath(new URL("../bin/app.ts", import.meta.url));
const LEGACY_SHARED_PASSWORD_ENV = [
  "COGNITO",
  "DEMO",
  "TEMP",
  "PASSWORD",
].join("_");
const DEMO_USER_PASSWORDS_ENV = [
  "COGNITO",
  "DEMO",
  "USER",
  "PASSWORDS",
  "JSON",
].join("_");

const GITHUB_BOOTSTRAP_CONTEXT_ARGUMENTS = [
  '-c "repository=${GITHUB_REPOSITORY}"',
  '-c "repositoryId=${GITHUB_REPOSITORY_ID}"',
  '-c "repositoryOwnerId=${GITHUB_REPOSITORY_OWNER_ID}"',
  '-c "workflowRef=${GITHUB_WORKFLOW_REF}"',
  '-c "githubOidcSubjectMode=${GITHUB_OIDC_SUBJECT_MODE}"',
  '-c "githubOidcSubject=${GITHUB_OIDC_SUBJECT}"',
  "-c enableGitHubDeployment=true",
  "-c branchProtectionAttested=true",
];

function readRequired(path, label) {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      assert.fail(`${label} is missing at ${path}`);
    }
    throw error;
  }
}

function parseDeployWorkflow() {
  const workflow = parse(
    readRequired(
      DEPLOY_WORKFLOW_PATH,
      "reusable serverless deployment workflow",
    ),
  );
  assert.ok(workflow && typeof workflow === "object");
  return workflow;
}

function parseTriggerWorkflow() {
  const workflow = parse(
    readRequired(
      TRIGGER_WORKFLOW_PATH,
      "serverless verification trigger workflow",
    ),
  );
  assert.ok(workflow && typeof workflow === "object");
  return workflow;
}

function bashBlocks(markdown) {
  const blocks = [];
  let current = null;

  for (const line of markdown.split("\n")) {
    if (line === "```bash") {
      assert.equal(current, null, "bash code fences cannot be nested");
      current = [];
      continue;
    }
    if (line === "```" && current) {
      blocks.push(current.join("\n"));
      current = null;
      continue;
    }
    if (current) {
      current.push(line);
    }
  }

  assert.equal(current, null, "README has an unclosed bash code fence");
  return blocks;
}

function fencedCodeBlocks(markdown) {
  const blocks = [];
  let current = null;

  for (const line of markdown.split("\n")) {
    if (line === "```" && current) {
      blocks.push(current.lines.join("\n"));
      current = null;
      continue;
    }
    const opening = line.match(/^```[A-Za-z0-9_-]*$/);
    if (opening) {
      assert.equal(current, null, "code fences cannot be nested");
      current = { lines: [] };
      continue;
    }
    if (current) {
      current.lines.push(line);
    }
  }

  assert.equal(current, null, "plan has an unclosed code fence");
  return blocks;
}

function validateBashBlocks(blocks) {
  assert.ok(blocks.length > 0, "README must contain Bash command blocks");

  for (const [index, block] of blocks.entries()) {
    const result = spawnSync("/bin/bash", ["-n"], {
      encoding: "utf8",
      input: block,
    });
    assert.equal(
      result.status,
      0,
      `README Bash block ${index + 1} must pass bash -n:\n`
        + `${result.stderr || result.stdout}`,
    );
  }
}

function markdownTableRows(markdown, heading, headerCells) {
  const lines = markdown.split("\n");
  const headingIndex = lines.indexOf(`## ${heading}`);
  assert.notEqual(headingIndex, -1, `README is missing section ${heading}`);

  const nextHeadingIndex = lines.findIndex(
    (line, index) => index > headingIndex && line.startsWith("## "),
  );
  const sectionEnd = nextHeadingIndex === -1 ? lines.length : nextHeadingIndex;
  const expectedHeader = `| ${headerCells.join(" | ")} |`;
  const tableIndex = lines.findIndex(
    (line, index) =>
      index > headingIndex && index < sectionEnd && line === expectedHeader,
  );
  assert.notEqual(
    tableIndex,
    -1,
    `${heading} must contain table header ${expectedHeader}`,
  );
  assert.match(
    lines[tableIndex + 1] ?? "",
    /^\|\s*---\s*(?:\|\s*---\s*)+\|$/,
    `${heading} table must have a Markdown separator row`,
  );

  const rows = [];
  for (let index = tableIndex + 2; index < sectionEnd; index += 1) {
    const line = lines[index];
    if (!line.startsWith("|")) {
      break;
    }
    rows.push(
      line
        .slice(1, -1)
        .split("|")
        .map((cell) => cell.trim().replace(/^`|`$/g, "")),
    );
  }
  return rows;
}

function sectionText(markdown, heading) {
  const lines = markdown.split("\n");
  const headingIndex = lines.indexOf(`## ${heading}`);
  assert.notEqual(headingIndex, -1, `README is missing section ${heading}`);
  const nextHeadingIndex = lines.findIndex(
    (line, index) => index > headingIndex && line.startsWith("## "),
  );
  return lines
    .slice(
      headingIndex,
      nextHeadingIndex === -1 ? lines.length : nextHeadingIndex,
    )
    .join("\n");
}

function bashBlockContaining(markdown, commandPattern) {
  const matches = bashBlocks(markdown)
    .filter((block) => commandPattern.test(block));
  assert.equal(
    matches.length,
    1,
    `expected one Bash block matching ${commandPattern}; found ${matches.length}`,
  );
  return matches[0];
}

function continuedCommandsContaining(markdown, commandPattern) {
  const commands = [];
  for (const block of bashBlocks(markdown)) {
    const lines = block.split("\n");
    for (let index = 0; index < lines.length; index += 1) {
      if (!commandPattern.test(lines[index])) {
        continue;
      }
      const command = [lines[index]];
      while (command.at(-1).trimEnd().endsWith("\\")) {
        index += 1;
        assert.ok(
          index < lines.length,
          `continued command ${commandPattern} is incomplete`,
        );
        command.push(lines[index]);
      }
      commands.push(command.join("\n"));
    }
  }
  return commands;
}

function assertCompleteGitHubBootstrapContexts(commands, label) {
  assert.ok(commands.length > 0, `${label} must contain bootstrap commands`);
  for (const [index, command] of commands.entries()) {
    for (const argument of GITHUB_BOOTSTRAP_CONTEXT_ARGUMENTS) {
      assert.equal(
        command.split(argument).length - 1,
        1,
        `${label} command ${index + 1} must pass ${argument} exactly once`,
      );
    }
  }
}

function assertDeployAuditImmediatelyBefore(block, commandPattern, label) {
  const lines = block.split("\n");
  const commandIndexes = lines
    .map((line, index) => commandPattern.test(line) ? index : -1)
    .filter((index) => index !== -1);
  assert.equal(
    commandIndexes.length,
    1,
    `${label} must contain exactly one guarded command`,
  );
  assert.equal(
    lines[commandIndexes[0] - 1],
    "SECURITY_AUDIT_MODE=deploy "
      + "npm --prefix infra/serverless-platform run security:audit",
    `${label} must run the deploy-phase audit directly before the command`,
  );
}

function runOperatorBlock(block, {
  mode,
  oidcList,
  provider = {},
  stackResources = {},
  failOidcList = false,
}) {
  const harness = `
npm() {
  printf 'NPM:%s\\n' "$*"
}

aws() {
  case "$1:$2" in
    iam:list-open-id-connect-providers)
      if [[ "$FAIL_OIDC_LIST" == "yes" ]]; then
        return 91
      fi
      printf '%s\\n' "$OIDC_LIST_FIXTURE"
      ;;
    iam:get-open-id-connect-provider)
      printf '%s\\n' "$OIDC_PROVIDER_FIXTURE"
      ;;
    cloudformation:list-stack-resources)
      printf '%s\\n' "$STACK_RESOURCES_FIXTURE"
      ;;
    iam:get-role)
      printf '%s\\n' '{"Role":{"AssumeRolePolicyDocument":{}}}'
      ;;
    *)
      printf 'Unexpected mocked AWS call: %s\\n' "$*" >&2
      return 92
      ;;
  esac
}

export AWS_ACCOUNT_ID="$AUDIT_FIXTURE_ACCOUNT_ID"
export AWS_REGION="us-west-2"
export GITHUB_REPOSITORY="example-org/example-repo"
export GITHUB_REPOSITORY_ID="987654321"
export GITHUB_REPOSITORY_OWNER_ID="12345678"
export GITHUB_WORKFLOW_REF="example-org/example-repo/.github/workflows/deploy-serverless-platform.yml@refs/heads/main"
export GITHUB_OIDC_SUBJECT_MODE="legacy"
export GITHUB_OIDC_SUBJECT="repo:example-org/example-repo:ref:refs/heads/main"
export COGNITO_DOMAIN_PREFIX="example-cognito-prefix"
export GITHUB_OIDC_PROVIDER_MODE="$OIDC_MODE"

${block}
`;
  return spawnSync("/bin/bash", [], {
    encoding: "utf8",
    input: harness,
    env: {
      ...process.env,
      AUDIT_FIXTURE_ACCOUNT_ID: ["1111", "2222", "3333"].join(""),
      FAIL_OIDC_LIST: failOidcList ? "yes" : "no",
      OIDC_LIST_FIXTURE: JSON.stringify(oidcList),
      OIDC_MODE: mode,
      OIDC_PROVIDER_FIXTURE: JSON.stringify(provider),
      STACK_RESOURCES_FIXTURE: JSON.stringify(stackResources),
    },
  });
}

function runBootstrapBlock(block, toolkitState, {
  accountId = ["1111", "2222", "3333"].join(""),
  policyArn =
    `arn:aws:iam::${accountId}:policy/CustomerApprovedCdkBootstrap`,
} = {}) {
  const harness = `
npm() {
  printf 'NPM:%s MODE:%s APPROVED:%s\\n' \
    "$*" "\${SECURITY_AUDIT_MODE:-deploy}" \
    "\${CDK_BOOTSTRAP_REMEDIATION_APPROVED:-no}"

  if [[ "$*" == *"run security:audit"* ]]; then
    case "\${SECURITY_AUDIT_MODE:-deploy}:\${TOOLKIT_STATE}" in
      deploy:compliant|bootstrap-new:absent|bootstrap-remediate:noncompliant)
        return 0
        ;;
      *)
        return 80
        ;;
    esac
  fi

  if [[ "$*" == *"cdk bootstrap"* ]]; then
    export TOOLKIT_STATE="compliant"
  fi
}

export AWS_ACCOUNT_ID="$AUDIT_FIXTURE_ACCOUNT_ID"
export AWS_REGION="us-west-2"
export CDK_BOOTSTRAP_EXECUTION_POLICY_ARN="$POLICY_ARN_FIXTURE"
export TOOLKIT_STATE

${block}
`;
  return spawnSync("/bin/bash", [], {
    encoding: "utf8",
    input: harness,
    env: {
      ...process.env,
      AUDIT_FIXTURE_ACCOUNT_ID: accountId,
      POLICY_ARN_FIXTURE: policyArn,
      TOOLKIT_STATE: toolkitState,
    },
  });
}

function runSmokeBlock(block, {
  healthStatuses,
  identityStatuses,
}) {
  const fixtureDirectory = mkdtempSync(
    path.join(tmpdir(), "serverless-readme-smoke-"),
  );
  const healthCounter = path.join(fixtureDirectory, "health-count");
  const identityCounter = path.join(fixtureDirectory, "identity-count");
  writeFileSync(healthCounter, "0\n");
  writeFileSync(identityCounter, "0\n");

  const harness = `
node() {
  printf 'https://example.cloudfront.net'
}

next_status() {
  local sequence="$1"
  local counter_file="$2"
  local count
  local index
  local statuses

  count="$(<"$counter_file")"
  count=$((count + 1))
  printf '%s\\n' "$count" > "$counter_file"
  IFS=',' read -r -a statuses <<< "$sequence"
  index=$((count - 1))
  if (( index >= \${#statuses[@]} )); then
    index=$((\${#statuses[@]} - 1))
  fi
  printf '%s' "\${statuses[$index]}"
}

curl() {
  local argument
  local url=""
  for argument in "$@"; do
    url="$argument"
  done

  case "$url" in
    */api/health)
      next_status "$HEALTH_STATUSES" "$HEALTH_COUNTER"
      ;;
    */api/me)
      next_status "$IDENTITY_STATUSES" "$IDENTITY_COUNTER"
      ;;
    *)
      printf 'Unexpected URL: %s\\n' "$url" >&2
      return 92
      ;;
  esac
}

sleep() {
  :
}

${block}
`;
  const result = spawnSync("/bin/bash", [], {
    encoding: "utf8",
    input: harness,
    env: {
      ...process.env,
      HEALTH_COUNTER: healthCounter,
      HEALTH_STATUSES: healthStatuses.join(","),
      IDENTITY_COUNTER: identityCounter,
      IDENTITY_STATUSES: identityStatuses.join(","),
    },
  });
  const counts = {
    health: Number(readFileSync(healthCounter, "utf8").trim()),
    identity: Number(readFileSync(identityCounter, "utf8").trim()),
  };
  rmSync(fixtureDirectory, { force: true, recursive: true });
  return { counts, result };
}

function filesUnder(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (["node_modules", "cdk.out", "security-audit"].includes(entry.name)) {
        return [];
      }
      return filesUnder(absolutePath);
    }
    if (!entry.isFile() || /\.test\.[^.]+$/.test(entry.name)) {
      return [];
    }
    return [absolutePath];
  });
}

function deploymentSourcePaths() {
  const sourceDirectories = ["bin", "lib", "lambda", "scripts"]
    .map((directory) => path.join(PLATFORM_ROOT, directory));
  const sourceFiles = sourceDirectories.flatMap(filesUnder);
  const publicAssets = filesUnder(CONSOLE_PUBLIC_ROOT)
    .filter((sourcePath) => /\.(?:css|html|js|json|mjs)$/i.test(sourcePath));
  const configurationFiles = [
    README_PATH,
    DEPLOY_WORKFLOW_PATH,
    TRIGGER_WORKFLOW_PATH,
    path.join(PLATFORM_ROOT, "cdk.json"),
    path.join(PLATFORM_ROOT, "package.json"),
    path.join(PLATFORM_ROOT, "tsconfig.json"),
  ];
  return [
    ...new Set([...configurationFiles, ...sourceFiles, ...publicAssets]),
  ].sort();
}

// Leakage scanning decodes only reviewed source, documentation, and fixture formats.
const PORTABILITY_TEXT_EXTENSIONS = new Set([
  ".cjs",
  ".css",
  ".html",
  ".js",
  ".json",
  ".jsx",
  ".md",
  ".mjs",
  ".py",
  ".sh",
  ".toml",
  ".ts",
  ".tsx",
  ".txt",
  ".yaml",
  ".yml",
]);
const PORTABILITY_TEXT_BASENAMES = new Set([
  ".gitignore",
  "Dockerfile",
  "Makefile",
]);
const PORTABILITY_MAX_TEXT_BYTES = 1_048_576;
const PORTABILITY_PATHSPECS = [
  ".github/workflows/deploy-serverless-platform.yml",
  ".github/workflows/verify-serverless-platform.yml",
  "console",
  "infra/platform-registry",
  "infra/serverless-platform",
  "package.json",
];

function validatedGitPath(value, label) {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
    throw new Error(`invalid ${label}: expected a non-empty path`);
  }
  const segments = value.split("/");
  if (
    value.startsWith("/")
    || /^[A-Za-z]:\//.test(value)
    || value.startsWith(":")
    || segments.some(
      (segment) => segment === "" || segment === "." || segment === ".."
    )
  ) {
    throw new Error(`invalid ${label}: ${value}`);
  }
  return value;
}

function normalizedGitPathspec(value) {
  return validatedGitPath(
    value.replaceAll("\\", "/"),
    "Git pathspec",
  );
}

function validatedGitOutputPath(value) {
  if (value.includes("\\")) {
    throw new Error(
      `invalid repository-relative path: ambiguous backslash in ${value}`,
    );
  }
  return validatedGitPath(value, "repository-relative path");
}

function isPortabilityTextSource(repositoryPath) {
  const basename = path.posix.basename(repositoryPath);
  return PORTABILITY_TEXT_BASENAMES.has(basename)
    || PORTABILITY_TEXT_EXTENSIONS.has(
      path.posix.extname(basename).toLowerCase(),
    );
}

function enumerateGitTextSourcePaths({
  repositoryRoot,
  pathspecs,
  spawnGit = spawnSync,
}) {
  const normalizedRepositoryRoot = path.resolve(repositoryRoot);
  const normalizedPathspecs = pathspecs.map(normalizedGitPathspec);
  const result = spawnGit(
    "git",
    [
      "-C",
      normalizedRepositoryRoot,
      "ls-files",
      "--cached",
      "--others",
      "--exclude-standard",
      "-z",
      "--",
      ...normalizedPathspecs,
    ],
    {
      encoding: "utf8",
    },
  );

  if (result.error || result.status !== 0) {
    const detail = result.error?.message
      || result.stderr?.trim()
      || `exit status ${String(result.status)}`;
    throw new Error(`Git source enumeration failed: ${detail}`);
  }
  if (result.stderr !== "") {
    throw new Error(
      `Git source enumeration produced unexpected stderr: ${result.stderr}`,
    );
  }
  if (typeof result.stdout !== "string") {
    throw new Error("Git source enumeration returned non-text output");
  }
  if (result.stdout !== "" && !result.stdout.endsWith("\0")) {
    throw new Error("Git source enumeration output must be NUL-terminated");
  }

  const rawPaths = result.stdout === ""
    ? []
    : result.stdout.slice(0, -1).split("\0");
  const seenPaths = new Set();
  const sourcePaths = [];

  for (const rawPath of rawPaths) {
    const repositoryPath = validatedGitOutputPath(rawPath);
    if (seenPaths.has(repositoryPath)) {
      throw new Error(`duplicate repository path: ${repositoryPath}`);
    }
    seenPaths.add(repositoryPath);

    const absolutePath = path.resolve(
      normalizedRepositoryRoot,
      ...repositoryPath.split("/"),
    );
    const relativePath = path.relative(
      normalizedRepositoryRoot,
      absolutePath,
    );
    if (
      relativePath === ""
      || relativePath === ".."
      || relativePath.startsWith(`..${path.sep}`)
      || path.isAbsolute(relativePath)
    ) {
      throw new Error(
        `invalid repository-relative path: ${repositoryPath}`,
      );
    }

    let stats;
    try {
      stats = lstatSync(absolutePath);
    } catch (error) {
      if (error?.code === "ENOENT") {
        throw new Error(`missing source path: ${repositoryPath}`);
      }
      throw error;
    }
    if (stats.isSymbolicLink()) {
      throw new Error(
        `unsupported symlink in portability scan: ${repositoryPath}`,
      );
    }
    if (!stats.isFile()) {
      throw new Error(
        `portability source path is not a regular file: ${repositoryPath}`,
      );
    }
    if (!isPortabilityTextSource(repositoryPath)) {
      continue;
    }
    if (stats.size > PORTABILITY_MAX_TEXT_BYTES) {
      throw new Error(
        `${repositoryPath} exceeds the ${PORTABILITY_MAX_TEXT_BYTES}-byte portability limit`,
      );
    }
    sourcePaths.push({ absolutePath, repositoryPath });
  }

  return sourcePaths
    .sort((left, right) =>
      left.repositoryPath < right.repositoryPath
        ? -1
        : left.repositoryPath > right.repositoryPath
          ? 1
          : 0
    )
    .map(({ absolutePath }) => absolutePath);
}

function portabilitySourcePaths(spawnGit = spawnSync) {
  return enumerateGitTextSourcePaths({
    repositoryRoot: REPOSITORY_ROOT,
    pathspecs: PORTABILITY_PATHSPECS,
    spawnGit,
  });
}

function runGit(repositoryRoot, args) {
  const result = spawnSync("git", ["-C", repositoryRoot, ...args], {
    encoding: "utf8",
  });
  assert.equal(
    result.status,
    0,
    `git ${args.join(" ")} failed:\n${result.stderr || result.stdout}`,
  );
  return result;
}

function createTemporaryGitRepository(initialize = runGit) {
  const repositoryRoot = mkdtempSync(
    path.join(tmpdir(), "portability-git-"),
  );
  try {
    initialize(repositoryRoot, ["init", "--quiet"]);
    return repositoryRoot;
  } catch (error) {
    rmSync(repositoryRoot, { force: true, recursive: true });
    throw error;
  }
}

function writeRepositoryFile(repositoryRoot, repositoryPath, contents) {
  const absolutePath = path.join(
    repositoryRoot,
    ...repositoryPath.split("/"),
  );
  mkdirSync(path.dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, contents);
  return absolutePath;
}

function requirePortabilityEnumerator() {
  assert.equal(
    typeof enumerateGitTextSourcePaths,
    "function",
    "readme contract must provide reusable Git text-source enumeration",
  );
  return enumerateGitTextSourcePaths;
}

function repositoryPath(repositoryRoot, absolutePath) {
  return path.relative(repositoryRoot, absolutePath)
    .split(path.sep)
    .join("/");
}

function fileState(filePath) {
  let stats;
  try {
    stats = statSync(filePath, { bigint: true });
  } catch (error) {
    if (error?.code === "ENOENT") {
      return { exists: false };
    }
    throw error;
  }
  return {
    exists: true,
    contents: readFileSync(filePath),
    mode: Number(stats.mode & 0o7777n),
    mtimeNs: stats.mtimeNs.toString(),
  };
}

function lineNumberAt(source, offset) {
  return source.slice(0, offset).split("\n").length;
}

function isSensitiveAssignmentName(name) {
  const normalized = name.replace(/[-_]/g, "").toLowerCase();
  if (name === "id-token") {
    return false;
  }
  const exactNames = new Set([
    "awsaccesskeyid",
    "awssecretaccesskey",
    "awssessiontoken",
    "githubtoken",
    "ghtoken",
    "token",
    "password",
    "secret",
    "clientsecret",
    "privatekey",
    "apikey",
    "cognitodemouserpasswordsjson",
  ]);
  return exactNames.has(normalized)
    || [
      "password",
      "accesstoken",
      "idtoken",
      "refreshtoken",
      "sessiontoken",
      "clientsecret",
      "privatekey",
      "apikey",
      "secretaccesskey",
    ].some((suffix) => normalized.endsWith(suffix));
}

function unquotedAssignmentValue(rawValue) {
  let value = rawValue.trim().replace(/[,;]\s*$/, "").trim();
  const quote = value[0];
  if (
    value.length >= 2
    && ["\"", "'", "`"].includes(quote)
    && value.at(-1) === quote
  ) {
    value = value.slice(1, -1);
  }
  return value.trim();
}

function isSafeSensitiveValue(rawValue, sourcePath) {
  const value = unquotedAssignmentValue(rawValue);
  if (
    !value
    || /^<[^>]+>$/.test(value)
    || /^(?:null|undefined|true|false)$/i.test(value)
  ) {
    return true;
  }
  if (
    /^\$\{\{\s*secrets\.[A-Z0-9_]+\s*\}\}$/.test(value)
    || /^\$\{[A-Z_][A-Z0-9_]*\}$/.test(value)
    || /^\$\{[A-Za-z_$][A-Za-z0-9_$.]*\}$/.test(value)
    || /^\$[A-Z_][A-Z0-9_]*$/.test(value)
    || /^process\.env\.[A-Z_][A-Z0-9_]*$/.test(value)
    || /^requiredEnvironmentValue\(\s*$/.test(value)
    || /^passwordFor\(\s*[A-Za-z_$][A-Za-z0-9_$.]*\s*\)$/.test(value)
    || /^getAccessToken\(\)$/.test(value.replace(/;$/, ""))
  ) {
    return true;
  }

  const knownSafeRuntimeReferences = new Set([
    "authMode()==='cognito'?getAccessToken():SESSION?.token",
    "cloudFrontAlarmFunction.functionArn",
    "credentials?.secretAccessKey",
    "credentials?.secretAccessKey || credentials?.SecretAccessKey",
    "credentials?.sessionToken",
    "credentials?.sessionToken || credentials?.SessionToken",
    "env.AWS_SECRET_ACCESS_KEY",
    "invalidationFunction.functionArn",
    "result.access_token",
    "result.id_token",
    "temporaryPassword",
    "tokens.accessToken",
    "tokens.idToken",
    "value.SecretAccessKey",
    "value.Token",
  ]);
  if (knownSafeRuntimeReferences.has(value)) {
    return true;
  }
  const normalizedSourcePath = sourcePath.replaceAll("\\", "/");
  const fileSpecificSafeRuntimeReferences = new Map([
    [
      "console/public/modules/app.mjs",
      new Set(["tokenInput.value.trim()"]),
    ],
    [
      "infra/serverless-platform/lambda/release-delivery/service.py",
      new Set(['page.get("NextToken")', 'pending_approval(state, execution["pipelineExecutionId"])']),
    ],
    [
      "infra/serverless-platform/lambda/agent-runtime/proof-secret.mjs",
      new Set(["validSecretResponse(response, secretArn)"]),
    ],
    [
      "infra/serverless-platform/lambda/journeys/github-oauth.mjs",
      new Set(["clientSecret"]),
    ],
    [
      "infra/serverless-platform/lambda/journeys/runtime.mjs",
      new Set(["value.clientSecret"]),
    ],
    [
      "infra/serverless-platform/lambda/journeys/service.mjs",
      new Set(["exchanged?.token"]),
    ],
    [
      "infra/serverless-platform/lambda/agent-runtime/service.mjs",
      new Set(["proofSecret"]),
    ],
    [
      "infra/serverless-platform/lambda/experience/runtime-adapter.mjs",
      new Set(["proofSecret"]),
    ],
    [
      "infra/serverless-platform/lambda/model-governance/rate-limits.mjs",
      new Set(["clientToken(gatewayIdentifier, desired)"]),
    ],
    [
      "infra/serverless-platform/lambda/platform-admin/domain-directory.mjs",
      new Set(["validateOperationToken(operationToken)"]),
    ],
    [
      "infra/serverless-platform/lambda/workspace/gateway-credentials.mjs",
      new Set([
        "cached.secretAccessKey",
        "cached.sessionToken",
        "credentials.SecretAccessKey",
        "credentials.SessionToken",
      ]),
    ],
    [
      "infra/serverless-platform/lambda/workspace/gateway.mjs",
      new Set([
        "descriptors.secretAccessKey.value",
        "descriptors.sessionToken?.value",
      ]),
    ],
  ]);
  for (const [pathSuffix, safeValues] of fileSpecificSafeRuntimeReferences) {
    if (
      normalizedSourcePath.endsWith(pathSuffix)
      && safeValues.has(value)
    ) {
      return true;
    }
  }
  if (
    /(?:\|\||\?\?)\s*(?:"[^"]+"|'[^']+'|`[^`]+`)/.test(value)
    || /^[A-Za-z_$][A-Za-z0-9_$.]*\(\s*(?:"[^"]+"|'[^']+'|`[^`]+`)/.test(value)
  ) {
    return false;
  }
  if (/^(?:"[^"]*"|'[^']*'|`[^`]*`)$/.test(value)) {
    return false;
  }
  if (/^[A-Za-z0-9_./+=:@-]+$/.test(value)) {
    return false;
  }
  return false;
}

function leakageFindings(sourcePath, source) {
  const findings = [];
  const literalPatterns = [
    {
      label: "literal 12-digit account value",
      pattern: /\b[0-9]{12}\b/g,
    },
    {
      label: "AWS access-key identifier",
      pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
    },
    {
      label: "GitHub token value",
      pattern:
        /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g,
    },
    {
      label: "private-key material",
      pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g,
    },
  ];
  for (const { label, pattern } of literalPatterns) {
    for (const match of source.matchAll(pattern)) {
      findings.push({
        label,
        line: lineNumberAt(source, match.index),
      });
    }
  }

  const lines = source.split("\n");
  for (const [index, line] of lines.entries()) {
    const assignment = line.match(
      /^\s*(?:(?:const|let|var)\s+|export\s+)?(?:"([^"]+)"|'([^']+)'|([A-Za-z_][A-Za-z0-9_-]*))\s*(?::|=(?!=))\s*(.*?)\s*$/,
    );
    const assignmentName = assignment?.[1] ?? assignment?.[2] ?? assignment?.[3];
    const assignmentValue = assignment?.[4];
    if (
      assignment
      && isSensitiveAssignmentName(assignmentName)
      && !isSafeSensitiveValue(assignmentValue, sourcePath)
    ) {
      findings.push({
        label: `hard-coded ${assignmentName} value`,
        line: index + 1,
      });
    }
  }
  return findings;
}

function assertGitIgnored(relativePath) {
  const result = spawnSync(
    "git",
    ["check-ignore", "--quiet", "--", relativePath],
    {
      cwd: REPOSITORY_ROOT,
      encoding: "utf8",
    },
  );
  assert.equal(
    result.status,
    0,
    `${relativePath} must be ignored by git`,
  );
}

function applicationStackIds(source) {
  const sourceFile = ts.createSourceFile(
    APP_PATH,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const ids = new Set();

  function visit(node) {
    if (
      ts.isNewExpression(node)
      && ts.isIdentifier(node.expression)
      && ["GitHubBootstrapStack", "PlatformWebStack"].includes(
        node.expression.text,
      )
      && node.arguments?.length >= 2
      && ts.isStringLiteral(node.arguments[1])
    ) {
      ids.add(node.arguments[1].text);
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return [...ids].sort();
}

function workflowStep(job, name) {
  const step = job.steps.find((candidate) => candidate.name === name);
  assert.ok(step, `workflow is missing step ${name}`);
  return step;
}

test("leakage classifier rejects literals but permits references and documentation", () => {
  const unsafeFixtures = [
    ["account.yml", `account: ${"123456" + "789012"}`],
    ["credentials.sh", `AWS_ACCESS_KEY_ID=${"AKIA" + "A".repeat(16)}`],
    [
      "credentials.sh",
      `${DEMO_USER_PASSWORDS_ENV}=${[
        "runtime",
        "secret",
        "must",
        "not",
        "be",
        "literal",
      ].join("-")}`,
    ],
    [
      "config.ts",
      `const clientSecret = "${["literal", "client", "secret"].join("-")}";`,
    ],
    [
      "config.json",
      `"clientSecret": "${["literal", "client", "secret"].join("-")}",`,
    ],
    [
      "config.ts",
      `const password = fromVault("${["literal", "fallback"].join("-")}");`,
    ],
    [
      "config.ts",
      `const clientSecret = process.env.CLIENT_SECRET || "${["literal", "fallback"].join("-")}";`,
    ],
    ["config.ts", "const clientSecret = config.value;"],
    ["auth.mjs", "const accessToken = response.value;"],
    ["auth.mjs", "token: session.value,"],
    [
      "other.mjs",
      "const secret = validSecretResponse(response, secretArn);",
    ],
    [
      "other.mjs",
      "secretAccessKey: credentials.SecretAccessKey,",
    ],
    ["key.pem", "-----BEGIN " + "PRIVATE KEY-----"],
    ["github.yml", `token: ${"ghp_" + "a".repeat(36)}`],
    ["asset.js", `"${"github_pat_" + "a".repeat(82)}"`],
  ];
  for (const [sourcePath, source] of unsafeFixtures) {
    assert.notDeepEqual(
      leakageFindings(sourcePath, source),
      [],
      `${sourcePath} fixture must be rejected`,
    );
  }

  const safeFixtures = [
    [
      "README.md",
      "Document COGNITO_DEMO_USER_PASSWORDS_JSON without assigning a value.",
    ],
    [
      "README.md",
      'export COGNITO_DEMO_USER_PASSWORDS_JSON="$RUNTIME_INPUT"',
    ],
    [
      "workflow.yml",
      `${DEMO_USER_PASSWORDS_ENV}: `
        + "${{ secrets.COGNITO_DEMO_USER_PASSWORDS_JSON }}",
    ],
    [
      "seed.mjs",
      "const passwordsJson = requiredEnvironmentValue(",
    ],
    ["auth.mjs", "const accessToken = getAccessToken();"],
    ["config.ts", "const clientSecret = process.env.COGNITO_CLIENT_SECRET;"],
    ["auth-client.mjs", "accessToken: tokens.accessToken,"],
    ["auth-client.mjs", "idToken: result.id_token,"],
    [
      "infra/serverless-platform/lambda/model-governance/rate-limits.mjs",
      "const token = clientToken(gatewayIdentifier, desired);",
    ],
    ["credentials.mjs", "secretAccessKey: env.AWS_SECRET_ACCESS_KEY,"],
    ["credentials.mjs", "secretAccessKey: value.SecretAccessKey,"],
    ["credentials.mjs", "sessionToken: value.Token,"],
    [
      "infra/serverless-platform/lambda/workspace/gateway-credentials.mjs",
      "secretAccessKey: credentials.SecretAccessKey,",
    ],
    [
      "infra/serverless-platform/lambda/workspace/gateway-credentials.mjs",
      "sessionToken: credentials.SessionToken,",
    ],
    [
      "infra/serverless-platform/lambda/workspace/gateway-credentials.mjs",
      "secretAccessKey: cached.secretAccessKey,",
    ],
    [
      "infra/serverless-platform/lambda/workspace/gateway-credentials.mjs",
      "sessionToken: cached.sessionToken,",
    ],
    [
      "infra/serverless-platform/lambda/workspace/gateway.mjs",
      "const secretAccessKey = descriptors.secretAccessKey.value;",
    ],
    [
      "infra/serverless-platform/lambda/workspace/gateway.mjs",
      "const sessionToken = descriptors.sessionToken?.value;",
    ],
    [
      "gateway.mjs",
      "const secretAccessKey = credentials?.secretAccessKey "
        + "|| credentials?.SecretAccessKey;",
    ],
    ["gateway.mjs", "const secretAccessKey = credentials?.secretAccessKey"],
    [
      "gateway.mjs",
      "const sessionToken = credentials?.sessionToken "
        + "|| credentials?.SessionToken;",
    ],
    ["gateway.mjs", "const sessionToken = credentials?.sessionToken"],
    ["seed.mjs", "TemporaryPassword: temporaryPassword,"],
    [
      "infra/serverless-platform/lambda/agent-runtime/proof-secret.mjs",
      "const secret = validSecretResponse(response, secretArn);",
    ],
    [
      "infra/serverless-platform/lambda/agent-runtime/service.mjs",
      "secret: proofSecret,",
    ],
    [
      "infra/serverless-platform/lambda/experience/runtime-adapter.mjs",
      "secret: proofSecret,",
    ],
    [
      "infra/serverless-platform/lambda/platform-admin/domain-directory.mjs",
      "const token = validateOperationToken(operationToken);",
    ],
    ["provider.ts", "serviceToken: invalidationFunction.functionArn,"],
    ["console/public/modules/app.mjs", "const accessToken=tokenInput.value.trim()"],
    ["infra/serverless-platform/lambda/release-delivery/service.py", 'token = page.get("NextToken")'],
    ["infra/serverless-platform/lambda/release-delivery/service.py", 'token = pending_approval(state, execution["pipelineExecutionId"])'],
    ["workflow.yml", "id-token: write"],
    ["workflow.yml", "AWS_ACCOUNT_ID must contain exactly 12 digits."],
  ];
  for (const [sourcePath, source] of safeFixtures) {
    assert.deepEqual(
      leakageFindings(sourcePath, source),
      [],
      `${sourcePath} fixture must remain allowed`,
    );
  }
});

test("deployment sources contain no account or credential leakage", () => {
  const sourcePaths = deploymentSourcePaths();
  const relativePaths = sourcePaths.map((sourcePath) =>
    path.relative(REPOSITORY_ROOT, sourcePath)
  );

  for (const requiredPath of [
    ".github/workflows/deploy-serverless-platform.yml",
    ".github/workflows/verify-serverless-platform.yml",
    "infra/serverless-platform/README.md",
    "infra/serverless-platform/bin/app.ts",
    "infra/serverless-platform/lib/github-bootstrap-stack.ts",
    "infra/serverless-platform/lambda/api/index.mjs",
    "infra/serverless-platform/scripts/predeploy-security-audit.mjs",
    "infra/serverless-platform/scripts/seed-demo-users.mjs",
    "console/public/auth-client.mjs",
    "console/public/auth-core.mjs",
    "console/public/index.html",
    "console/public/runtime-config.js",
  ]) {
    assert.ok(
      relativePaths.includes(requiredPath),
      `deployment leakage scan must include ${requiredPath}`,
    );
  }
  for (const relativePath of relativePaths) {
    assert.doesNotMatch(
      relativePath,
      /(?:^|\/)(?:node_modules|cdk\.out|security-audit|test)(?:\/|$)|\.test\./,
      `deployment leakage scan must exclude generated evidence and tests: ${relativePath}`,
    );
  }

  for (const sourcePath of sourcePaths) {
    const relativePath = path.relative(REPOSITORY_ROOT, sourcePath);
    const findings = leakageFindings(
      sourcePath,
      readRequired(sourcePath, relativePath),
    );
    assert.deepEqual(
      findings,
      [],
      `${relativePath} contains leakage:\n`
        + findings.map(({ label, line }) => `line ${line}: ${label}`).join("\n"),
    );
  }

  assertGitIgnored("infra/serverless-platform/deployment-outputs.json");
  assertGitIgnored("infra/serverless-platform/security-audit/review.json");
});

test("committed and generated runtime configuration contains no secret values", () => {
  const committedRuntimeConfig = readRequired(
    path.join(CONSOLE_PUBLIC_ROOT, "runtime-config.js"),
    "committed runtime configuration",
  );
  assert.deepEqual(
    leakageFindings(
      path.join(CONSOLE_PUBLIC_ROOT, "runtime-config.js"),
      committedRuntimeConfig,
    ),
    [],
  );
  assert.doesNotMatch(
    committedRuntimeConfig,
    /clientSecret|accessToken|idToken|refreshToken|password|privateKey|apiKey/i,
  );

  const platformStackSource = readRequired(
    path.join(PLATFORM_ROOT, "lib", "platform-web-stack.ts"),
    "platform web stack",
  );
  const runtimeConfigSource = platformStackSource.slice(
    platformStackSource.indexOf("const runtimeConfig"),
    platformStackSource.indexOf("const deploymentLogs"),
  );
  assert.match(runtimeConfigSource, /window\.__RUNTIME_CONFIG__/);
  assert.doesNotMatch(
    runtimeConfigSource,
    /clientSecret|accessToken|idToken|refreshToken|password|privateKey|apiKey/i,
  );
});

test("every README Bash block passes bash -n", () => {
  validateBashBlocks(
    bashBlocks(readRequired(README_PATH, "serverless deployment README")),
  );
});

test("README documents the portable starter builder model policy", () => {
  const readme = readRequired(README_PATH, "serverless deployment README");

  assert.match(readme, /`starterBuilderModelId`/);
  assert.match(
    readme,
    /`bedrock-claude\/anthropic\.claude-haiku-4-5`/,
  );
  assert.match(
    readme,
    /CDK context[\s\S]+-c "starterBuilderModelId=<gateway-model-id>"/i,
  );
  assert.match(
    readme,
    /`customer_support`[\s\S]+`operations`[\s\S]+native AgentCore Gateway rate limits/i,
  );
  assert.match(
    readme,
    /newly created domains[\s\S]+default-deny[\s\S]+administrator assigns a model policy/i,
  );
});

test("every README bootstrap diff and deploy passes complete GitHub trust metadata", () => {
  const readme = readRequired(README_PATH, "serverless deployment README");
  const commands = continuedCommandsContaining(
    readme,
    /run (?:diff -- GitHubBootstrapStack|deploy:bootstrap --)/,
  );

  assert.equal(commands.length, 4);
  assertCompleteGitHubBootstrapContexts(commands, "README");
});

test("deployment README document legacy or immutable exact subject modes", () => {
  const documents = [
    ["README", readRequired(README_PATH, "serverless deployment README")],
  ];
  const legacySubject = "`repo:<owner/repo>:ref:refs/heads/main`";
  const immutableSubject =
    "`repo:<owner>@<repository-owner-id>/<repo>@<repository-id>:"
    + "ref:refs/heads/main`";

  for (const [label, document] of documents) {
    assert.ok(
      document.includes(legacySubject),
      `${label} must show the exact legacy subject`,
    );
    assert.ok(
      document.includes(immutableSubject),
      `${label} must show the exact immutable subject`,
    );
    assert.match(
      document,
      /legacy[\s\S]+immutable|immutable[\s\S]+legacy/i,
      `${label} must describe legacy or immutable subject modes`,
    );
    assert.match(
      document,
      /chosen mode[\s\S]+exact subject[\s\S]+audit[\s\S]+CDK/i,
      `${label} must keep the chosen mode and value aligned with audit and CDK`,
    );
    assert.doesNotMatch(
      document,
      /only (?:trusted|expected) subject is\s+`repo:<owner\/repo>:ref:refs\/heads\/main`/i,
      `${label} cannot imply that only the legacy subject is trusted`,
    );
    assert.match(
      document,
      /repositories created\s+before July 15, 2026[\s\S]+opt(?:ed)? in[\s\S]+immutable/i,
      `${label} must explain explicit immutable-subject opt-in for older repositories`,
    );
    assert.match(
      document,
      /claim template[\s\S]+use_default=false|use_default=false[\s\S]+claim template/i,
      `${label} must explain repository-level claim-template opt-in`,
    );
    assert.match(
      document,
      /wrong mode[\s\S]+fail(?:s|ed)? closed|fail(?:s|ed)? closed[\s\S]+wrong mode/i,
      `${label} must state that the wrong subject selection fails closed`,
    );
    assert.match(
      document,
      /no automated migration|does not automate[\s\S]+migration/i,
      `${label} must not invent an automated OIDC subject migration`,
    );
  }
});

test("deployment README document optional generic Cognito seeding", () => {
  const documents = [
    ["README", readRequired(README_PATH, "serverless deployment README")],
  ];

  for (const [label, document] of documents) {
    assert.ok(
      document.includes("COGNITO_DEMO_USERS_JSON"),
      `${label} must name the deployment-private persona JSON input`,
    );
    assert.ok(
      document.includes("COGNITO_DEMO_USER_PASSWORDS_JSON"),
      `${label} must name the runtime-only password JSON input`,
    );
    assert.doesNotMatch(
      document,
      new RegExp(LEGACY_SHARED_PASSWORD_ENV),
      `${label} cannot retain the shared-password contract`,
    );
    assert.match(
      document,
      /keys\s+exactly\s+match[\s\S]+configured usernames/i,
      `${label} must require the configured username key set`,
    );
    assert.match(
      document,
      /distinct[\s\S]+14[\s\S]+uppercase[\s\S]+lowercase[\s\S]+digit[\s\S]+symbol/i,
      `${label} must state the per-user password policy`,
    );
    assert.match(
      document,
      /custom:managed_by=agentic-ai-platform-demo/,
      `${label} must document the immutable ownership marker`,
    );
    assert.match(
      document,
      /Username[\s\S]+Enabled[\s\S]+name[\s\S]+ownership marker[\s\S]+fail\s+closed/i,
      `${label} must document existing-user verification`,
    );
    assert.match(
      document,
      /exact\s+UserNotFoundException[\s\S]+malformed\s+lookup\s+JSON[\s\S]+no\s+create[\s\S]+group\s+assignment/i,
      `${label} must preserve fail-closed lookup classification`,
    );
    assert.match(
      document,
      /(?:--validate-only|validation-only)[\s\S]+no\s+AWS\s+calls/i,
      `${label} must document secret-safe optional validation`,
    );
    assert.match(
      document,
      /admin-list-groups-for-user[\s\S]+zero memberships[\s\S]+exactly\s+the\s+expected\s+group[\s\S]+NextToken[\s\S]+fails?\s+closed/i,
      `${label} must document exact unpaginated group ownership`,
    );
    for (const group of [
      "platform-admin",
      "domain-builder",
      "end-user",
    ]) {
      assert.ok(
        document.includes(group),
        `${label} must name supported Cognito group ${group}`,
      );
    }
    assert.match(
      document,
      /UserStatus[\s\S]+CONFIRMED[\s\S]+without reading or resetting[\s\S]+password[\s\S]+FORCE_CHANGE_PASSWORD[\s\S]+admin-set-user-password[\s\S]+Permanent=false[\s\S]+private[\s\S]+temporary\s+JSON\s+file[\s\S]+other\s+status[\s\S]+fails?\s+closed/i,
      `${label} must document status-aware temporary-password recovery`,
    );
    assert.doesNotMatch(
      document,
      /COGNITO_DEMO_USER_PASSWORDS_JSON\s*=\s*['"]?\{/,
      `${label} cannot contain an example password object`,
    );
    assert.match(
      document,
      /(?:normal|reusable|GitHub)[\s\S]+deployment[\s\S]+(?:does not|never)[\s\S]+seed/i,
      `${label} must keep seeding out of normal deployment`,
    );
    assert.match(
      document,
      /existing users[\s\S]+preserv/i,
      `${label} must preserve existing users`,
    );
  }
});

test("deployment README preserve verified owned temporary-password recovery", () => {
  const documents = [
    ["README", readRequired(README_PATH, "serverless deployment README")],
  ];

  for (const [label, document] of documents) {
    assert.doesNotMatch(
      document,
      /existing identities\s+are\s+never\s+claimed\s+or\s+updated/i,
      `${label} cannot prohibit the verified owned temporary-password refresh`,
    );
  }

  const readme = documents[0][1];
  assert.match(readme, /FORCE_CHANGE_PASSWORD[\s\S]+Permanent=false[\s\S]+private temporary/i);
  assert.match(readme, /any mismatch causes[\s\S]+fail closed/i);

});

test("deployment README document portable private demo-password transport", () => {
  const documents = [
    ["README", readRequired(README_PATH, "serverless deployment README")],
  ];

  for (const [label, document] of documents) {
    assert.doesNotMatch(
      document,
      /file:\/\/\/dev\/stdin|using stdin JSON|through stdin JSON|over stdin/i,
      `${label} cannot retain the non-portable stdin paramfile contract`,
    );
    assert.doesNotMatch(
      document,
      /password values?[\s\S]{0,180}(?:out of|never enter)[\s\S]{0,100}\bfiles\b/i,
      `${label} cannot claim that the private temporary file does not exist`,
    );
    assert.match(
      document,
      /exclusive[\s\S]+short-lived[\s\S]+private\s+temporary\s+directory[\s\S]+0700[\s\S]+private\s+JSON\s+file[\s\S]+0600/i,
      `${label} must document the private temporary filesystem boundary`,
    );
    assert.match(
      document,
      /literal\s+`file:\/\/<absolute path>`[\s\S]+spaces[\s\S]+(?:not percent-encoded|no `%20`)/i,
      `${label} must document literal shell-free AWS CLI file references`,
    );
    assert.match(
      document,
      /password[\s\S]+never[\s\S]+(?:argv|arguments)[\s\S]+stdin[\s\S]+logs[\s\S]+errors[\s\S]+evidence/i,
      `${label} must document secret exclusion from process and evidence surfaces`,
    );
    assert.match(
      document,
      /immediate cleanup[\s\S]+scrub[\s\S]+retry[\s\S]+deployment[\s\S]+stop[\s\S]+cleanup failure/i,
      `${label} must document fail-closed cleanup recovery`,
    );
  }
});

test("README documents the global no-mutation seed preflight", () => {
  const readme = readRequired(README_PATH, "serverless deployment README");

  assert.match(
    readme,
    /complete[\s\S]+password\s+object[\s\S]+parsed[\s\S]+every\s+configured\s+password[\s\S]+validated[\s\S]+before\s+any\s+Cognito\s+mutation/i,
    "README must document complete password parsing and validation before mutation",
  );
  assert.match(
    readme,
    /every\s+configured\s+user'?s?[\s\S]+lookup[\s\S]+identity[\s\S]+status[\s\S]+attribute[\s\S]+exact\s+group\s+verification[\s\S]+completes\s+before\s+any\s+Cognito\s+mutation\s+occurs/i,
    "README must require all configured-user verification before mutation",
  );
  assert.match(
    readme,
    /mutation-specific\s+password\s+(?:retrieval|input)[\s\S]+deferred[\s\S]+private[\s\S]+temporary\s+JSON\s+file/i,
    "README must document deferred private mutation-specific password input",
  );
  assert.doesNotMatch(
    readme,
    /verification[\s\S]{0,120}before\s+any\s+password\s+is\s+read/i,
    "README cannot claim verification occurs before any password is read",
  );
});

test("README documents bounded hosted acceptance ownership and recovery", () => {
  const readme = readRequired(README_PATH, "serverless platform README");
  assert.match(
    readme,
    /AgenticPlatform-Web-HostedAcceptanceRole[\s\S]+exact deployed `userPool\.userPoolArn`/i,
  );
  for (const action of [
    "AdminGetUser",
    "AdminCreateUser",
    "AdminSetUserPassword",
    "AdminAddUserToGroup",
    "AdminListGroupsForUser",
    "AdminInitiateAuth",
    "AdminDeleteUser",
  ]) {
    assert.match(
      readme,
      new RegExp(`cognito-idp:${action}`),
      `README must document hosted acceptance ownership of ${action}`,
    );
  }
  assert.match(
    readme,
    /AgenticPlatformGitHubDeployRole[\s\S]+only[\s\S]+sts:AssumeRole[\s\S]+AgenticPlatform-Web-HostedAcceptanceRole/i,
  );
  assert.match(
    readme,
    /optional seed[\s\S]+20-second[\s\S]+per-call[\s\S]+AWS CLI[\s\S]+five-minute/i,
  );
  assert.match(
    readme,
    /3600-second[\s\S]+role session[\s\S]+20-minute[\s\S]+acceptance[\s\S]+5-minute[\s\S]+recovery cleanup/i,
  );
  assert.match(
    readme,
    /hosted-acceptance-admin-\$\{\{\s*github\.run_id\s*\}\}-\$\{\{\s*github\.run_attempt\s*\}\}/,
  );
  assert.match(
    readme,
    /hosted-acceptance-isolation-\$\{\{\s*github\.run_id\s*\}\}-\$\{\{\s*github\.run_attempt\s*\}\}/,
  );
  assert.match(
    readme,
    /killable child process[\s\S]+private stdin[\s\S]+minimal explicit environment allowlist[\s\S]+AWS_\*[\s\S]+ACTIONS_\*[\s\S]+GITHUB_TOKEN[\s\S]+excluded/i,
  );
  assert.match(
    readme,
    /isolated POSIX process group[\s\S]+negative PID[\s\S]+SIGKILL[\s\S]+stdio[\s\S]+secondary bounded[\s\S]+close[\s\S]+stable[\s\S]+before[\s\S]+retry/i,
  );
  assert.match(
    readme,
    /secondary bounded close deadline[\s\S]+unconfirmed[\s\S]+not retried/i,
  );
  assert.match(
    readme,
    /confirmed[\s\S]+process-group[\s\S]+worker[\s\S]+descendant[\s\S]+terminated/i,
  );
  assert.match(
    readme,
    /unconfirmed[\s\S]+stdio[\s\S]+destroyed[\s\S]+child[\s\S]+unref[\s\S]+bounded[\s\S]+does not guarantee[\s\S]+descendant[\s\S]+termination/i,
  );
  assert.match(
    readme,
    /browser retry[\s\S]+allowed only[\s\S]+process-group[\s\S]+SIGKILL[\s\S]+delivered[\s\S]+worker exit[\s\S]+confirmed/i,
  );
  assert.match(
    readme,
    /process-group\s+delivery\s+fails[\s\S]+direct-child[\s\S]+closes\s+the\s+worker[\s\S]+not\s+retried/i,
  );
  assert.doesNotMatch(
    readme,
    /hosted acceptance role must not be used[\s\S]+until these additional permissions/i,
    "README cannot retain the obsolete missing-permissions warning",
  );
  assert.match(
    readme,
    /AgenticPlatform-Web-HostedAcceptanceRole[\s\S]+lambda:InvokeFunction[\s\S]+AgenticPlatform-Web-HostedAcceptanceBroker/i,
  );
  assert.match(
    readme,
    /HostedAcceptanceRole[\s\S]+no direct[\s\S]+agent-registry[\s\S]+DynamoDB/i,
  );
  assert.match(
    readme,
    /private[\s\S]+AgenticPlatform-Web-HostedAcceptanceBroker[\s\S]+not exposed[\s\S]+API Gateway[\s\S]+Function URL/i,
  );
  for (const action of [
    "CreateRegistryRecord",
    "DeleteRegistry",
    "DeleteRegistryRecord",
    "GetRegistry",
    "GetRegistryRecord",
    "ListRegistryRecords",
    "ListTagsForResource",
    "SubmitRegistryRecordForApproval",
    "TagResource",
  ]) {
    assert.match(
      readme,
      new RegExp(`agent-registry:${action}`),
      `README must document hosted acceptance ownership of ${action}`,
    );
  }
  assert.match(
    readme,
    /HostedAcceptanceBrokerRole[\s\S]+configured shared fixture Registry[\s\S]+record descendants[\s\S]+mandatory request tags[\s\S]+resource tags/i,
  );
  assert.match(
    readme,
    /broker[\s\S]+account and region[\s\S]+Registry\/\*[\s\S]+managedBy=hosted-acceptance[\s\S]+exact handler validation/i,
  );
  assert.match(
    readme,
    /bedrock-agentcore:DeleteWorkloadIdentity[\s\S]{0,250}`workload-identity-directory\/default`/i,
  );
  assert.match(
    readme,
    /Agent Registry deletion[\s\S]{0,250}directory\s+resource/i,
  );
  assert.match(
    readme,
    /`workload-identity-directory\/default\/workload-identity\/registry-\*`[\s\S]+generated[\s\S]+workload identity/i,
    "README must document the generated Registry workload identity child resource",
  );
  assert.match(
    readme,
    /broker execution role[\s\S]+dynamodb:GetItem[\s\S]+dynamodb:PutItem[\s\S]+dynamodb:DeleteItem[\s\S]+dynamodb:EnclosingOperation=TransactWriteItems[\s\S]+does not[\s\S]+dynamodb:TransactWriteItems[\s\S]+exact `PlatformStateTableName`[\s\S]+HOSTED_ACCEPTANCE[\s\S]+REQUEST#\*[\s\S]+PROJECT#\*[\s\S]+AGENT#\*[\s\S]+DEPLOYMENT#\*[\s\S]+ENTITLEMENT#\*/i,
  );
  assert.match(
    readme,
    /broker execution role[\s\S]+bedrock-agentcore:GetAgentRuntime[\s\S]+bedrock-agentcore:GetAgentRuntimeEndpoint[\s\S]+exact governed Runtime[\s\S]+production endpoint/i,
  );
  assert.match(
    readme,
    /HostedAcceptanceBrokerFunctionArn[\s\S]+Lambda Invoke[\s\S]+nine[\s\S]+allowlisted operations/i,
  );
  assert.match(
    readme,
    /hosted-acceptance-admin-<runId>-<attempt>[\s\S]+hosted-role-switching-admin-<runId>-<attempt>[\s\S]+deterministic request ID[\s\S]+initial CreateRegistry[\s\S]+managedBy=hosted-acceptance/i,
  );
  assert.doesNotMatch(
    readme,
    /changes only `managedBy`|retag(?:s|ging)? the domain Registry/i,
  );
  assert.match(
    readme,
    /durable actor mapping[\s\S]+before[\s\S]+fixture[\s\S]+browser[\s\S]+exact `GetItem`[\s\S]+never[\s\S]+scan/i,
  );
  assert.match(
    readme,
    /actor mapping[\s\S]+deleted[\s\S]+only after[\s\S]+exact request-item cleanup succeeds/i,
  );
  assert.match(
    readme,
    /Cognito subject[\s\S]+domain recovery[\s\S]+actor mapping[\s\S]+unavailable[\s\S]+cleanup fails closed/i,
  );
  assert.match(
    readme,
    /worker stdout[\s\S]+explicit allowlist[\s\S]+resource identities[\s\S]+statuses[\s\S]+mutation request IDs[\s\S]+no request payloads[\s\S]+arbitrary API response bodies/i,
  );
  assert.match(
    readme,
    /`if: always\(\)`[\s\S]+reacquires[\s\S]+AgenticPlatformGitHubDeployRole[\s\S]+role-chains[\s\S]+AgenticPlatform-Web-HostedAcceptanceRole[\s\S]+both (?:temporary )?verifier users[\s\S]+exact empty[\s\S]+operation-owned group[\s\S]+verifies group absence/i,
  );

  const orderedSteps = [
    "Validate deployed project tags",
    "Smoke test deployed application",
    "Assume hosted acceptance role",
    "Run hosted control-plane acceptance",
    "Reacquire GitHub deploy role for verifier cleanup",
    "Assume hosted acceptance role for verifier cleanup",
    "Delete hosted acceptance verifier users",
    "Publish deployment summary",
  ];
  const sequenceStart = readme.indexOf("The implemented sequence is:");
  const sequenceEnd = readme.indexOf(
    "The verification job has only",
    sequenceStart,
  );
  assert.ok(sequenceStart !== -1 && sequenceEnd > sequenceStart);
  const sequence = readme.slice(sequenceStart, sequenceEnd);
  let previousIndex = -1;
  for (const stepName of orderedSteps) {
    const index = sequence.indexOf(`\`${stepName}\``);
    assert.ok(index > previousIndex, `README must order ${stepName}`);
    previousIndex = index;
  }
});

test("deployment README document hardened CloudFront providers", () => {
  const documents = [
    ["README", readRequired(README_PATH, "serverless deployment README")],
  ];

  for (const [label, document] of documents) {
    assert.match(
      document,
      /CreateInvalidation[\s\S]+GetInvalidation[\s\S]+InProgress[\s\S]+Completed[\s\S]+bounded[\s\S]+fail(?:s|ed)?\s+closed/i,
      `${label} must document bounded invalidation completion polling`,
    );
    assert.match(
      document,
      /PlatformWeb[\s\S]+distribution\s+ID[\s\S]+alarm name/i,
      `${label} must document the deployment-specific alarm name`,
    );
    assert.doesNotMatch(
      document,
      /AgenticPlatform-CloudFront-5xx/,
      `${label} cannot retain the account-global alarm name`,
    );
    assert.match(
      document,
      /ListTagsForResource[\s\S]+before[\s\S]+PutMetricAlarm[\s\S]+DeleteAlarms/i,
      `${label} must document ownership verification before alarm mutation`,
    );
    assert.match(
      document,
      /project=agentic-ai-platform-demo[\s\S]+managedBy=cdk[\s\S]+ownership/i,
      `${label} must name the immutable alarm ownership markers`,
    );
    assert.match(
      document,
      /exact\s+ResourceNotFoundException[\s\S]+absence[\s\S]+other[\s\S]+fail(?:s|ed)?\s+closed/i,
      `${label} must document exact alarm-absence classification`,
    );
    assert.match(
      document,
      /in-place[\s\S]+PhysicalResourceId[\s\S]+current\s+alarm\s+name[\s\S]+ownership/i,
      `${label} must bind in-place alarm updates to the owned current alarm`,
    );
    assert.match(
      document,
      /replacement[\s\S]+PhysicalResourceId[\s\S]+OldResourceProperties[\s\S]+new\s+alarm[\s\S]+absent[\s\S]+old-resource\s+Delete/i,
      `${label} must document absence-only replacement creation and bound cleanup`,
    );
    assert.match(
      document,
      /Delete[\s\S]+PhysicalResourceId[\s\S]+Delete\s+event\s+AlarmName[\s\S]+before[\s\S]+lookup/i,
      `${label} must bind alarm deletion to the event name before lookup`,
    );
    assert.match(
      document,
      /role[\s\S]+runtime\s+boundary[\s\S]+PlatformWeb-AgenticPlatform-Web-\*-CloudFront-5xx[\s\S]+old[\s\S]+new/i,
      `${label} must document the narrow replacement-transition IAM scope`,
    );
    assert.match(
      document,
      /CloudFront\s+invalidation[\s\S]+exact\s+distribution\s+ARN[\s\S]+(?:not|never)\s+broaden/i,
      `${label} must preserve exact invalidation scope`,
    );
    assert.match(
      document,
      /CloudFormation\s+response[\s\S]+2xx[\s\S]+response\s+ends[\s\S]+bounded[\s\S]+upload\s+timeout[\s\S]+fail(?:s|ed)?\s+closed/i,
      `${label} must document fail-closed CloudFormation response delivery`,
    );
    assert.match(
      document,
      /SUCCESS[\s\S]+retr(?:y|ies)[\s\S]+identical[\s\S]+PhysicalResourceId[\s\S]+FAILED[\s\S]+exact[\s\S]+PhysicalResourceId[\s\S]+(?:no|zero)\s+(?:Lambda\s+)?retr(?:y|ies)/i,
      `${label} must preserve physical identity across response retries`,
    );
    assert.match(
      document,
      /remaining[\s-]time[\s\S]+(?:30|45)[\s-]second[\s\S]+reserve[\s\S]+before[\s\S]+sleep[\s\S]+poll/i,
      `${label} must document the invalidation deadline reserve`,
    );
    assert.match(
      document,
      /CreateInvalidation[\s\S]+GetInvalidation[\s\S]+AbortController[\s\S]+abortSignal[\s\S]+per-call[\s\S]+deadline[\s\S]+response\s+reserve/i,
      `${label} must document abortable per-call CloudFront deadlines`,
    );
    assert.match(
      document,
      /Create[\s\S]+replacement[\s\S]+PutMetricAlarm[\s\S]+Tags[\s\S]+atomic[\s\S]+in-place[\s\S]+tag\s+reconciliation/i,
      `${label} must document atomic alarm creation and in-place reconciliation`,
    );
    assert.match(
      document,
      /RequiredTags[\s\S]+auto-delete=no[\s\S]+project=agentic-ai-platform-demo[\s\S]+managedBy=cdk[\s\S]+empty[\s\S]+drift[\s\S]+remov/i,
      `${label} must document the exact tag contract and empty drift removal`,
    );
    assert.match(
      document,
      /cloudFormationRequestId[\s\S]+event\.RequestId[\s\S]+ownership[\s\S]+same[\s-]request[\s\S]+no[\s\S]+mutation/i,
      `${label} must document owned same-request alarm replay`,
    );
    assert.match(
      document,
      /RequiredTags[\s\S]+exactly[\s\S]+three[\s\S]+provider-owned[\s\S]+separate/i,
      `${label} must keep the internal request marker outside RequiredTags`,
    );
  }
});

test("deployment README document retained runtime boundary tag reconciliation", () => {
  const documents = [
    ["README", readRequired(README_PATH, "serverless deployment README")],
  ];

  for (const [label, document] of documents) {
    assert.match(
      document,
      /AWS::IAM::ManagedPolicy[\s\S]+(?:does not|cannot)[\s\S]+Tags[\s\S]+Custom::RuntimePermissionsBoundaryTags/i,
      `${label} must document why the custom tag resource is required`,
    );
    assert.match(
      document,
      /AgenticPlatform-Web-RuntimeBoundaryTagProviderRole[\s\S]+runtime permissions boundary/i,
      `${label} must document the bounded runtime-boundary provider role`,
    );
    assert.match(
      document,
      /ListPolicyTags[\s\S]+TagPolicy[\s\S]+UntagPolicy[\s\S]+exact[\s\S]+root[\s-]path[\s\S]+AgenticPlatform-Web-RuntimePermissionsBoundary/i,
      `${label} must document the exact least-privilege IAM scope`,
    );
    assert.match(
      document,
      /auto-delete=no[\s\S]+project=agentic-ai-platform-demo[\s\S]+managedBy=cdk[\s\S]+idempotent/i,
      `${label} must document exact idempotent mandatory-tag reconciliation`,
    );
    assert.match(
      document,
      /Delete[\s\S]+preserve[\s\S]+tags[\s\S]+retain/i,
      `${label} must preserve boundary tags when the retained resource is deleted`,
    );
    assert.match(
      document,
      /security\s+audit[\s\S]+list-policy-tags[\s\S]+fail(?:s|ed)? closed/i,
      `${label} must document fail-closed boundary tag auditing`,
    );
  }
});

test("deployment README require the targeted secretless browser fixture", () => {
  const documents = [
    ["README", readRequired(README_PATH, "serverless deployment README")],
  ];

  for (const [label, document] of documents) {
    assert.match(
      document,
      /verify-serverless-platform\.yml[\s\S]+secretless[\s\S]+browser\s+authentication\s+fixture/i,
      `${label} must scope the secretless browser fixture to verification CI`,
    );
    assert.match(
      document,
      /playwright install --with-deps --only-shell chromium[\s\S]+10[\s-]minute/i,
      `${label} must document the bounded Chromium headless-shell install`,
    );
    assert.match(
      document,
      /node --test e2e\/smoke-auth-integration\.mjs[\s\S]+5[\s-]minute/i,
      `${label} must document the bounded direct fixture command`,
    );
    assert.match(
      document,
      /after[\s\S]+synth[\s\S]+node --test e2e\/smoke-auth-integration\.mjs/i,
      `${label} must run the direct fixture after synth`,
    );
    assert.match(
      document,
      /(?:does not|never)[\s\S]+e2e\/run-all\.mjs[\s\S]+npm --prefix e2e test/i,
      `${label} must exclude the full e2e entry points`,
    );
    assert.match(
      document,
      /(?:no|without)[\s\S]+(?:secret|credential)[\s\S]+COGNITO_DEMO_USER_PASSWORDS_JSON/i,
      `${label} must keep credentials and Cognito passwords out of the fixture`,
    );
    assert.match(
      document,
      /deploy-serverless-platform\.yml[\s\S]+(?:does not|never)[\s\S]+browser/i,
      `${label} must keep browser testing out of the reusable deployment workflow`,
    );
  }
});

test("deployment README document push-only live protected-main deployment", () => {
  const documents = [
    ["README", readRequired(README_PATH, "serverless deployment README")],
  ];

  for (const [label, document] of documents) {
    assert.match(
      document,
      /workflow_dispatch[\s\S]+verification-only/i,
      `${label} must keep manual dispatch verification-only`,
    );
    assert.match(
      document,
      /github\.ref_protected == true/,
      `${label} must require the live protected-ref context`,
    );
    assert.match(
      document,
      /git ls-remote --exit-code origin refs\/heads\/main/,
      `${label} must document the current remote main-head comparison`,
    );
    assert.match(
      document,
      /historical rerun[\s\S]+fail(?:s|ed)? closed|fail(?:s|ed)? closed[\s\S]+historical rerun/i,
      `${label} must explain the historical-rerun rollback guard`,
    );
  }
});

test("target confirmation enforces Bash 3.2 and the workflow Cognito prefix contract", () => {
  const readme = readRequired(README_PATH, "serverless deployment README");
  const targetBlock = bashBlockContaining(
    sectionText(readme, "Prerequisites and target confirmation"),
    /export COGNITO_DOMAIN_PREFIX=/,
  );
  const workflowValidation = workflowStep(
    parseDeployWorkflow().jobs.deploy,
    "Validate deployment configuration",
  ).run;
  const workflowPrefixPattern = workflowValidation.match(
    /\[\[ "\$COGNITO_DOMAIN_PREFIX" =~ ([^\n]+) \]\]/,
  )?.[1];

  assert.ok(workflowPrefixPattern, "workflow Cognito validation is missing");
  assert.match(
    targetBlock,
    new RegExp(
      String.raw`\[\[ "\$COGNITO_DOMAIN_PREFIX" =~ `
        + workflowPrefixPattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
        + String.raw` \]\]`,
    ),
    "manual target confirmation must use the workflow's exact Cognito regex",
  );

  for (const [value, expectedStatus] of [
    ["<unique-cognito-prefix>", 1],
    ["UPPERCASE", 1],
    ["-leading", 1],
    ["trailing-", 1],
    ["valid-prefix-22", 0],
    ["a", 0],
  ]) {
    const result = spawnSync(
      "/bin/bash",
      [
        "-c",
        `value="$1"; [[ "$value" =~ ${workflowPrefixPattern} ]]`,
        "--",
        value,
      ],
      { encoding: "utf8" },
    );
    assert.equal(
      result.status,
      expectedStatus,
      `Cognito prefix ${value} returned ${result.status}`,
    );
  }

  const versionGuard = targetBlock.match(
    /if \(\( ([^\n]+BASH_VERSINFO[^\n]+) \)\); then/,
  )?.[1];
  assert.ok(versionGuard, "Bash version guard is missing");
  const simulatedGuard = versionGuard
    .replaceAll("BASH_VERSINFO[0]", "major")
    .replaceAll("BASH_VERSINFO[1]", "minor");
  for (const [major, minor, shouldReject] of [
    [3, 0, true],
    [3, 1, true],
    [3, 2, false],
    [4, 0, false],
    [5, 2, false],
  ]) {
    const result = spawnSync(
      "/bin/bash",
      [
        "-c",
        `major="$1"; minor="$2"; if (( ${simulatedGuard} )); `
          + "then exit 9; fi",
        "--",
        String(major),
        String(minor),
      ],
      { encoding: "utf8" },
    );
    assert.equal(
      result.status,
      shouldReject ? 9 : 0,
      `Bash ${major}.${minor} guard returned ${result.status}`,
    );
  }

  assert.doesNotMatch(
    targetBlock,
    /aws ssm|get-parameter|2>\/dev\/null/,
    "target confirmation must not classify suppressed AWS errors as absence",
  );
});

test("new and remediation bootstrap commands are guarded by exclusive audit modes", () => {
  const readme = readRequired(README_PATH, "serverless deployment README");
  const bootstrapSection = sectionText(readme, "One-time AWS bootstrap");
  const cdkBootstrapBlocks = bashBlocks(bootstrapSection)
    .filter((block) => /cdk bootstrap/.test(block));

  assert.equal(
    cdkBootstrapBlocks.length,
    2,
    "runbook must separate new bootstrap from remediation",
  );
  const newBootstrapBlock = cdkBootstrapBlocks.find((block) =>
    /SECURITY_AUDIT_MODE=bootstrap-new/.test(block)
  );
  const remediationBlock = cdkBootstrapBlocks.find((block) =>
    /SECURITY_AUDIT_MODE=bootstrap-remediate/.test(block)
  );
  assert.ok(newBootstrapBlock, "new-account bootstrap mode is missing");
  assert.ok(remediationBlock, "bootstrap remediation mode is missing");
  assert.match(
    remediationBlock,
    /CDK_BOOTSTRAP_REMEDIATION_APPROVED=yes/,
  );
  for (const block of cdkBootstrapBlocks) {
    assert.ok(
      block.indexOf("run security:audit") < block.search(/cdk bootstrap/),
      "state audit must run before cdk bootstrap",
    );
    assert.ok(
      block.lastIndexOf("run security:audit") > block.search(/cdk bootstrap/),
      "deploy-mode audit must verify the toolkit after cdk bootstrap",
    );
  }

  const blockedNew = runBootstrapBlock(newBootstrapBlock, "compliant");
  assert.notEqual(blockedNew.status, 0);
  assert.doesNotMatch(blockedNew.stdout, /cdk bootstrap/);

  const allowedNew = runBootstrapBlock(newBootstrapBlock, "absent");
  assert.equal(
    allowedNew.status,
    0,
    allowedNew.stderr || allowedNew.stdout,
  );
  assert.equal((allowedNew.stdout.match(/cdk bootstrap/g) ?? []).length, 1);

  const blockedRemediation = runBootstrapBlock(
    remediationBlock,
    "compliant",
  );
  assert.notEqual(blockedRemediation.status, 0);
  assert.doesNotMatch(blockedRemediation.stdout, /cdk bootstrap/);

  const allowedRemediation = runBootstrapBlock(
    remediationBlock,
    "noncompliant",
  );
  assert.equal(
    allowedRemediation.status,
    0,
    allowedRemediation.stderr || allowedRemediation.stdout,
  );
  assert.equal(
    (allowedRemediation.stdout.match(/cdk bootstrap/g) ?? []).length,
    1,
  );
});

test("bootstrap policy ARN is commercial, account-bound, and exactly named", () => {
  const readme = readRequired(README_PATH, "serverless deployment README");
  const bootstrapBlocks = bashBlocks(
    sectionText(readme, "One-time AWS bootstrap"),
  ).filter((block) => /cdk bootstrap/.test(block));
  const accountId = ["1111", "2222", "3333"].join("");
  const anotherAccountId = ["4444", "5555", "6666"].join("");
  const invalidPolicyArns = [
    `arn:aws:iam::${anotherAccountId}:policy/ApprovedPolicy`,
    `arn:aws-us-gov:iam::${accountId}:policy/ApprovedPolicy`,
    `arn:aws:iam::${accountId}:policy/`,
    `arn:aws:iam::${accountId}:policy/Approved/Embedded`,
    `arn:aws:iam::${accountId}:policy/ApprovedPolicy?trailing`,
  ];

  assert.equal(bootstrapBlocks.length, 2);
  for (const [index, block] of bootstrapBlocks.entries()) {
    const toolkitState = /bootstrap-new/.test(block)
      ? "absent"
      : "noncompliant";
    for (const policyArn of invalidPolicyArns) {
      const result = runBootstrapBlock(block, toolkitState, {
        accountId,
        policyArn,
      });
      assert.notEqual(
        result.status,
        0,
        `bootstrap block ${index + 1} accepted ${policyArn}`,
      );
      assert.doesNotMatch(result.stdout, /cdk bootstrap/);
      assert.match(
        result.stderr,
        /commercial IAM managed policy ARN for AWS_ACCOUNT_ID/,
      );
    }
  }
});

test("manual stack diff and deploy commands have immediate deploy-phase audits", () => {
  const readme = readRequired(README_PATH, "serverless deployment README");
  const bootstrapBlock = bashBlockContaining(
    sectionText(readme, "One-time AWS bootstrap"),
    /run deploy:bootstrap/,
  );
  const platformBlock = bashBlockContaining(
    sectionText(readme, "Manual pre-commit deployment"),
    /run deploy:web/,
  );
  const cleanupBlock = bashBlockContaining(
    sectionText(readme, "Post-merge trust cleanup"),
    /enableGitHubDeployment=true/,
  );

  for (const [label, block, commands] of [
    [
      "initial GitHubBootstrapStack",
      bootstrapBlock,
      [
        /run diff -- GitHubBootstrapStack/,
        /run deploy:bootstrap --/,
      ],
    ],
    [
      "PlatformWebStack",
      platformBlock,
      [
        /run diff -- PlatformWebStack/,
        /run deploy:web --/,
      ],
    ],
    [
      "post-merge GitHubBootstrapStack",
      cleanupBlock,
      [
        /run diff -- GitHubBootstrapStack/,
        /run deploy:bootstrap --/,
      ],
    ],
  ]) {
    for (const commandPattern of commands) {
      assertDeployAuditImmediatelyBefore(
        block,
        commandPattern,
        `${label} ${commandPattern}`,
      );
    }
  }
});

test("manual smoke tests bound retries and assert exact status codes", () => {
  const readme = readRequired(README_PATH, "serverless deployment README");
  const smokeBlock = bashBlockContaining(
    sectionText(readme, "Smoke tests"),
    /APPLICATION_URL=/,
  );

  const healthFailure = runSmokeBlock(smokeBlock, {
    healthStatuses: ["503"],
    identityStatuses: ["401"],
  });
  assert.notEqual(healthFailure.result.status, 0);
  assert.equal(healthFailure.counts.health, 12);
  assert.equal(healthFailure.counts.identity, 0);

  const identityFailure = runSmokeBlock(smokeBlock, {
    healthStatuses: ["200"],
    identityStatuses: ["200"],
  });
  assert.notEqual(identityFailure.result.status, 0);
  assert.equal(identityFailure.counts.health, 1);
  assert.equal(identityFailure.counts.identity, 12);

  const recovery = runSmokeBlock(smokeBlock, {
    healthStatuses: ["503", "200"],
    identityStatuses: ["503", "401"],
  });
  assert.equal(
    recovery.result.status,
    0,
    recovery.result.stderr || recovery.result.stdout,
  );
  assert.deepEqual(recovery.counts, {
    health: 2,
    identity: 2,
  });
});

test("OIDC operator blocks run under Bash 3.2 nounset semantics", () => {
  const readme = readRequired(README_PATH, "serverless deployment README");
  const bootstrapBlock = bashBlockContaining(
    sectionText(readme, "One-time AWS bootstrap"),
    /run deploy:bootstrap/,
  );
  const cleanupBlock = bashBlockContaining(
    sectionText(readme, "Post-merge trust cleanup"),
    /enableGitHubDeployment=true/,
  );
  const bash32SafeContextExpansion =
    /\$\{GITHUB_OIDC_CONTEXT\[@\]\+"\$\{GITHUB_OIDC_CONTEXT\[@\]\}"\}/g;

  for (const [label, block] of [
    ["bootstrap", bootstrapBlock],
    ["cleanup", cleanupBlock],
  ]) {
    assert.equal(
      (block.match(bash32SafeContextExpansion) ?? []).length,
      2,
      `${label} block must use the Bash 3.2-safe optional array expansion`,
    );
    assert.doesNotMatch(
      block,
      /^\s*"\$\{GITHUB_OIDC_CONTEXT\[@\]\}"\s*$/m,
      `${label} block cannot expand an empty array directly with set -u`,
    );
  }

  const absent = runOperatorBlock(bootstrapBlock, {
    mode: "create",
    oidcList: { OpenIDConnectProviderList: [] },
  });
  assert.equal(
    absent.status,
    0,
    `create mode with no provider must run:\n${absent.stderr || absent.stdout}`,
  );
  assert.match(absent.stdout, /NPM:.*run diff -- GitHubBootstrapStack/);
  assert.match(absent.stdout, /NPM:.*run deploy:bootstrap --/);
  assert.doesNotMatch(absent.stdout, /githubOidcProviderArn=/);

  const accountId = ["1111", "2222", "3333"].join("");
  const providerArn =
    `arn:aws:iam::${accountId}:`
    + "oidc-provider/token.actions.githubusercontent.com";
  const imported = runOperatorBlock(bootstrapBlock, {
    mode: "import",
    oidcList: {
      OpenIDConnectProviderList: [{ Arn: providerArn }],
    },
    provider: {
      Url: "token.actions.githubusercontent.com",
      ClientIDList: ["sts.amazonaws.com"],
    },
  });
  assert.equal(
    imported.status,
    0,
    `import mode with one provider must run:\n`
      + `${imported.stderr || imported.stdout}`,
  );
  assert.equal(
    (imported.stdout.match(/githubOidcProviderArn=/g) ?? []).length,
    2,
  );

  const cleanup = runOperatorBlock(cleanupBlock, {
    mode: "create",
    oidcList: {
      OpenIDConnectProviderList: [{ Arn: providerArn }],
    },
    provider: {
      Url: "token.actions.githubusercontent.com",
      ClientIDList: ["sts.amazonaws.com"],
    },
    stackResources: {
      StackResourceSummaries: [{
        ResourceType: "AWS::IAM::OIDCProvider",
        PhysicalResourceId: providerArn,
      }],
    },
  });
  assert.equal(
    cleanup.status,
    0,
    `stack-owned cleanup mode must run:\n`
      + `${cleanup.stderr || cleanup.stdout}`,
  );

  const listFailure = runOperatorBlock(bootstrapBlock, {
    mode: "create",
    oidcList: { OpenIDConnectProviderList: [] },
    failOidcList: true,
  });
  assert.notEqual(listFailure.status, 0);
  assert.doesNotMatch(listFailure.stdout, /run diff -- GitHubBootstrapStack/);
  assert.doesNotMatch(listFailure.stdout, /run deploy:bootstrap --/);
});

test("runbook gates every AWS mutation and documents customer-controlled CDK bootstrap", () => {
  const readme = readRequired(README_PATH, "serverless deployment README");
  const infrastructurePackage = JSON.parse(
    readRequired(PACKAGE_PATH, "serverless package.json"),
  );
  const orderedHeadings = [
    "Stage 1 scope",
    "Prerequisites and target confirmation",
    "Mandatory pre-deployment security audit",
    "One-time AWS bootstrap",
    "GitHub repository configuration",
    "Manual pre-commit deployment",
  ];
  const headingIndexes = orderedHeadings.map((heading) => {
    const index = readme.indexOf(`## ${heading}`);
    assert.notEqual(index, -1, `missing heading ${heading}`);
    return index;
  });
  for (let index = 1; index < headingIndexes.length; index += 1) {
    assert.ok(
      headingIndexes[index - 1] < headingIndexes[index],
      `${orderedHeadings[index - 1]} must precede ${orderedHeadings[index]}`,
    );
  }

  assert.match(readme, /Bash 3\.2\+/);
  assert.match(readme, /run every `bash` block with Bash/i);
  assert.equal(
    infrastructurePackage.scripts["security:audit"],
    "node scripts/predeploy-security-audit.mjs",
  );

  const securitySection = sectionText(
    readme,
    "Mandatory pre-deployment security audit",
  );
  assert.match(
    securitySection,
    /npm --prefix infra\/serverless-platform run security:audit/,
  );
  assert.match(securitySection, /portable enforced gate/i);
  assert.match(securitySection, /infra\/serverless-platform\/security-audit\//);
  for (const deployPredecessorContract of [
    /`deploy`[\s\S]+exact Task 5 target[\s\S]+exact Task 3 predecessor/i,
    /previously deployed transaction-authorization policy/i,
    /Governance API role/i,
    /Platform Admin API role/i,
    /Registry decision finalizer/i,
    /runtime permissions boundary/i,
    /three exact broker-policy\s+predecessors/i,
    /no other\s+predecessor is accepted/i,
    /PlatformAdminApiRole/i,
    /finalizer role/i,
    /HostedAcceptanceBrokerRole/i,
  ]) {
    assert.match(securitySection, deployPredecessorContract);
  }
  assert.match(
    securitySection,
    /`postdeploy`[\s\S]+current synthesized CDK IAM contract[\s\S]+SECURITY_AUDIT_WEB_TEMPLATE[\s\S]+fail closed/i,
  );
  for (const requiredAdminAudit of [
    /PlatformAdminApiRole/i,
    /Lambda trust/i,
    /inline[\s-]+(?:logging\/table\/tagged-CreateRegistry )?policy/i,
    /Shared runtime boundary[\s\S]+checks remain mandatory/i,
  ]) {
    assert.match(securitySection, requiredAdminAudit);
  }
  assert.match(
    securitySection,
    /bootstrap-new[\s\S]+bootstrap-remediate[\s\S]+do not permit the Task 3[\s\S]+transition/i,
  );

  const bootstrapSection = sectionText(readme, "One-time AWS bootstrap");
  assert.match(bootstrapSection, /AdministratorAccess/);
  assert.match(bootstrapSection, /shared account infrastructure/i);
  assert.match(bootstrapSection, /do not rebootstrap casually/i);
  assert.match(
    bootstrapSection,
    /CDK_BOOTSTRAP_EXECUTION_POLICY_ARN/,
  );
  assert.match(
    bootstrapSection,
    /sufficient\s+for other CDK workloads sharing/i,
  );
  assert.match(
    bootstrapSection,
    /--cloudformation-execution-policies "\$CDK_BOOTSTRAP_EXECUTION_POLICY_ARN"/,
  );
  assert.match(bootstrapSection, /--termination-protection/);
  for (const tag of [
    "auto-delete=no",
    "project=agentic-ai-platform-demo",
    "managedBy=cdk",
  ]) {
    assert.match(bootstrapSection, new RegExp(`--tags "${tag}"`));
  }
  const cdkBootstrapBlocks = bashBlocks(bootstrapSection)
    .filter((block) => /cdk bootstrap/.test(block));
  assert.equal(cdkBootstrapBlocks.length, 2);
  assert.ok(
    cdkBootstrapBlocks.some((block) =>
      /SECURITY_AUDIT_MODE=bootstrap-new/.test(block)
    ),
  );
  assert.ok(
    cdkBootstrapBlocks.some((block) =>
      /SECURITY_AUDIT_MODE=bootstrap-remediate/.test(block)
      && /CDK_BOOTSTRAP_REMEDIATION_APPROVED=yes/.test(block)
    ),
  );
  for (const cdkBootstrapBlock of cdkBootstrapBlocks) {
    assert.doesNotMatch(cdkBootstrapBlock, /AdministratorAccess/);
    assert.ok(
      cdkBootstrapBlock.indexOf("run security:audit")
        < cdkBootstrapBlock.search(/cdk bootstrap/),
    );
    assert.ok(
      cdkBootstrapBlock.lastIndexOf("run security:audit")
        > cdkBootstrapBlock.search(/cdk bootstrap/),
    );
  }

  const bootstrapCommandBlock = bashBlockContaining(
    bootstrapSection,
    /run deploy:bootstrap/,
  );
  for (const preparationPattern of [
    /npm --prefix infra\/serverless-platform run security:audit/,
    /GITHUB_OIDC_PROVIDER_MODE/,
    /GITHUB_OIDC_CONTEXT=\(\)/,
    /list-open-id-connect-providers/,
    /get-open-id-connect-provider/,
    /list-stack-resources/,
  ]) {
    assert.match(bootstrapCommandBlock, preparationPattern);
  }
  assert.match(
    bootstrapSection,
    /`create`\s+when\s+the\s+audited provider status is absent[\s\S]+`import`\s+when it is present/i,
  );
  assert.match(
    bootstrapCommandBlock,
    /GITHUB_OIDC_PROVIDER_MODE" == "import"[\s\S]+GITHUB_OIDC_CONTEXT=\(/,
  );
  assert.match(
    bootstrapCommandBlock,
    /GITHUB_OIDC_PROVIDER_MODE" == "create"[\s\S]+AWS::IAM::OIDCProvider/,
  );
  for (const [commandPattern, requiredPreparations] of [
    [/run diff -- GitHubBootstrapStack/, 1],
    [/run deploy:bootstrap/, 2],
  ]) {
    const commandIndex = bootstrapCommandBlock.search(commandPattern);
    assert.notEqual(commandIndex, -1);
    const prefix = bootstrapCommandBlock.slice(0, commandIndex);
    assert.ok(
      (prefix.match(/^prepare_github_bootstrap_context$/gm) ?? []).length
        >= requiredPreparations,
      `${commandPattern} requires ${requiredPreparations} current-shell preparations`,
    );
  }
  assert.doesNotMatch(
    bootstrapCommandBlock,
    /list-open-id-connect-providers[\s\S]{0,160}(?:\|\| true|2>\/dev\/null)/,
  );
  assert.doesNotMatch(
    bootstrapCommandBlock,
    /get-open-id-connect-provider[\s\S]{0,160}(?:\|\| true|2>\/dev\/null)/,
  );
  assert.match(bootstrapSection, /GITHUB_REPOSITORY[\s\S]+git origin/i);
  assert.match(bootstrapSection, /rejects placeholders/i);
  assert.match(
    bootstrapSection,
    /all twenty-five exact[\s\S]+boundary-constrained runtime roles[\s\S]+exact runtime permissions\s+boundary/i,
  );
  assert.match(
    bootstrapSection,
    new RegExp(RUNTIME_PERMISSIONS_BOUNDARY_NAME),
  );
  for (const roleName of Object.values(PLATFORM_WEB_RUNTIME_ROLE_NAMES)) {
    assert.match(bootstrapSection, new RegExp(roleName));
  }
  for (const commandPattern of [
    /run diff -- GitHubBootstrapStack/,
    /run deploy:bootstrap --/,
  ]) {
    const commandIndex = bootstrapCommandBlock.search(commandPattern);
    const prefix = bootstrapCommandBlock.slice(0, commandIndex);
    assert.match(prefix, /export ENABLE_GITHUB_DEPLOYMENT=true/);
    assert.match(prefix, /export BRANCH_PROTECTION_ATTESTED=true/);
  }

  const manualSection = sectionText(
    readme,
    "Manual pre-commit deployment",
  );
  const manualVerificationBlock = bashBlockContaining(
    manualSection,
    /run synth --/,
  );
  const verificationCommands = [
    "npm ci",
    "npm --prefix infra/platform-registry ci",
    "npm --prefix infra/serverless-platform ci",
    "npm test",
    "npm --prefix infra/platform-registry test",
    "npm --prefix infra/platform-registry run build",
    "npm --prefix infra/serverless-platform test",
    "npm --prefix infra/serverless-platform run build",
    "npm audit --audit-level=high",
    "npm --prefix infra/platform-registry audit --audit-level=high",
    "npm --prefix infra/serverless-platform run audit",
    "npm --prefix infra/platform-registry run synth --",
    "npm --prefix infra/serverless-platform run synth --",
  ];
  let previousCommandIndex = -1;
  for (const command of verificationCommands) {
    const commandIndex = manualVerificationBlock.indexOf(command);
    assert.ok(commandIndex > previousCommandIndex, `${command} is out of order`);
    previousCommandIndex = commandIndex;
  }
  const manualBlock = bashBlockContaining(readme, /run deploy:web/);
  for (const [commandPattern, requiredAudits] of [
    [/infra\/platform-registry run diff --/, 1],
    [/infra\/platform-registry run deploy --/, 2],
    [/run diff -- PlatformWebStack/, 3],
    [/run deploy:web/, 4],
  ]) {
    const commandIndex = manualBlock.search(commandPattern);
    assert.notEqual(commandIndex, -1);
    assert.ok(
      (
        manualBlock
          .slice(0, commandIndex)
          .match(
            /npm --prefix infra\/serverless-platform run security:audit/g,
          ) ?? []
      ).length >= requiredAudits,
      `${commandPattern} requires ${requiredAudits} audit runs`,
    );
  }
  assert.match(
    manualBlock.slice(manualBlock.search(/run deploy:web/)),
    /SECURITY_AUDIT_MODE=postdeploy[\s\S]+run security:audit/,
  );

  const cleanupSection = sectionText(readme, "Post-merge trust cleanup");
  const cleanupBlock = bashBlockContaining(
    cleanupSection,
    /enableGitHubDeployment=true/,
  );
  for (const preparationPattern of [
    /npm --prefix infra\/serverless-platform run security:audit/,
    /GITHUB_OIDC_PROVIDER_MODE/,
    /GITHUB_OIDC_CONTEXT=\(\)/,
    /list-open-id-connect-providers/,
    /get-open-id-connect-provider/,
    /list-stack-resources/,
  ]) {
    assert.match(cleanupBlock, preparationPattern);
  }
  assert.match(
    cleanupSection,
    /recorded OIDC provider ownership mode/i,
  );
  assert.match(cleanupSection, /protected `main`/i);
  assert.match(cleanupBlock, /branchProtectionAttested=true/);
  assert.match(cleanupBlock, /export ENABLE_GITHUB_DEPLOYMENT=true/);
  assert.match(cleanupBlock, /export BRANCH_PROTECTION_ATTESTED=true/);
  for (const roleName of Object.values(PLATFORM_WEB_RUNTIME_ROLE_NAMES)) {
    assert.match(cleanupSection, new RegExp(roleName));
  }
  assert.doesNotMatch(cleanupBlock, /featureBranch|FEATURE_BRANCH/);
  for (const [commandPattern, requiredPreparations] of [
    [/run diff -- GitHubBootstrapStack/, 1],
    [/run deploy:bootstrap/, 2],
  ]) {
    const commandIndex = cleanupBlock.search(commandPattern);
    assert.notEqual(commandIndex, -1);
    const prefix = cleanupBlock.slice(0, commandIndex);
    assert.ok(
      (prefix.match(/^prepare_github_bootstrap_context$/gm) ?? []).length
        >= requiredPreparations,
      `${commandPattern} requires ${requiredPreparations} current-shell preparations`,
    );
  }

  for (const reference of [
    "https://docs.aws.amazon.com/cdk/v2/guide/ref-cli-cmd-bootstrap.html",
    "https://docs.aws.amazon.com/cdk/v2/guide/bootstrapping-customizing.html",
    "https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/using-cfn-protect-stacks.html",
  ]) {
    assert.ok(readme.includes(reference), `missing AWS reference ${reference}`);
  }
});

test("control-plane output is read-only, ignored, and absent from portability enumeration", () => {
  const before = fileState(CONTROL_PLANE_OUTPUTS_PATH);

  try {
    const result = spawnSync(
      "git",
      [
        "-C",
        REPOSITORY_ROOT,
        "check-ignore",
        "--quiet",
        path.relative(REPOSITORY_ROOT, CONTROL_PLANE_OUTPUTS_PATH),
      ],
      { encoding: "utf8" },
    );
    assert.equal(
      result.status,
      0,
      "infra/platform-registry/control-plane-outputs.json must be git-ignored",
    );
    assert.equal(
      portabilitySourcePaths().includes(CONTROL_PLANE_OUTPUTS_PATH),
      false,
    );
  } finally {
    assert.deepEqual(fileState(CONTROL_PLANE_OUTPUTS_PATH), before);
  }
});

test("ignored output checks preserve an absent output path", () => {
  const enumerate = requirePortabilityEnumerator();
  const repositoryRoot = createTemporaryGitRepository();
  const outputRepositoryPath =
    "infra/platform-registry/control-plane-outputs.json";
  const outputPath = path.join(
    repositoryRoot,
    ...outputRepositoryPath.split("/"),
  );
  let before;

  try {
    writeRepositoryFile(
      repositoryRoot,
      ".gitignore",
      `${outputRepositoryPath}\n`,
    );
    runGit(repositoryRoot, ["add", "--", ".gitignore"]);
    before = fileState(outputPath);
    assert.deepEqual(before, { exists: false });
    assert.equal(existsSync(outputPath), false);
    runGit(repositoryRoot, [
      "check-ignore",
      "--quiet",
      "--",
      outputRepositoryPath,
    ]);
    assert.equal(
      enumerate({
        repositoryRoot,
        pathspecs: ["infra/platform-registry"],
      }).includes(outputPath),
      false,
    );
  } finally {
    if (before !== undefined) {
      assert.deepEqual(fileState(outputPath), before);
    }
    rmSync(repositoryRoot, { force: true, recursive: true });
  }
});

test("isolated Git portability enumeration includes text sources and excludes ignored and binary files", () => {
  const enumerate = requirePortabilityEnumerator();
  const repositoryRoot = createTemporaryGitRepository();
  const prohibitedValues = [
    ["2507", "0845", "4815"].join(""),
    ["cAIh", "vscg", "2Gwj", "6AGb"].join(""),
    ["agentic-demo-llm-gateway-", "j5bh", "ipqo", "rh"].join(""),
  ];

  try {
    writeRepositoryFile(
      repositoryRoot,
      ".gitignore",
      "generated/\ntest/ignored.test.ts\ntest/force-added.test.ts\n",
    );
    writeRepositoryFile(repositoryRoot, "README.md", "# Fixture repository\n");
    writeRepositoryFile(
      repositoryRoot,
      "src/tracked.ts",
      `export const account = "${prohibitedValues[0]}";\n`,
    );
    writeRepositoryFile(
      repositoryRoot,
      "src/untracked.mjs",
      `export const registryId = "${prohibitedValues[1]}";\n`,
    );
    writeRepositoryFile(
      repositoryRoot,
      "generated/control-plane-outputs.json",
      JSON.stringify({ account: prohibitedValues[0] }),
    );
    writeRepositoryFile(
      repositoryRoot,
      "test/unignored.test.ts",
      `export const gatewayId = "${prohibitedValues[2]}";\n`,
    );
    writeRepositoryFile(
      repositoryRoot,
      "test/tracked.test.ts",
      `export const registryId = "${prohibitedValues[1]}";\n`,
    );
    writeRepositoryFile(
      repositoryRoot,
      "test/ignored.test.ts",
      `export const registryId = "${prohibitedValues[1]}";\n`,
    );
    writeRepositoryFile(
      repositoryRoot,
      "test/force-added.test.ts",
      `export const account = "${prohibitedValues[0]}";\n`,
    );
    writeRepositoryFile(
      repositoryRoot,
      "assets/font.woff2",
      Buffer.concat([
        Buffer.from([0, 1, 2, 3]),
        Buffer.from(prohibitedValues[2]),
      ]),
    );
    runGit(repositoryRoot, [
      "add",
      "--",
      ".gitignore",
      "README.md",
      "src/tracked.ts",
      "test/tracked.test.ts",
    ]);
    runGit(repositoryRoot, [
      "add",
      "--force",
      "--",
      "test/force-added.test.ts",
    ]);

    const sourcePaths = enumerate({
      repositoryRoot,
      pathspecs: [
        ".gitignore",
        "README.md",
        "assets",
        "generated",
        "src",
        "test",
      ],
    });
    assert.deepEqual(
      sourcePaths.map((sourcePath) =>
        repositoryPath(repositoryRoot, sourcePath)
      ),
      [
        ".gitignore",
        "README.md",
        "src/tracked.ts",
        "src/untracked.mjs",
        "test/force-added.test.ts",
        "test/tracked.test.ts",
        "test/unignored.test.ts",
      ],
    );

    const findings = sourcePaths.flatMap((sourcePath) =>
      prohibitedValues
        .filter((value) => readRequired(sourcePath, sourcePath).includes(value))
        .map((value) => [repositoryPath(repositoryRoot, sourcePath), value])
    );
    assert.deepEqual(findings, [
      ["src/tracked.ts", prohibitedValues[0]],
      ["src/untracked.mjs", prohibitedValues[1]],
      ["test/force-added.test.ts", prohibitedValues[0]],
      ["test/tracked.test.ts", prohibitedValues[1]],
      ["test/unignored.test.ts", prohibitedValues[2]],
    ]);
  } finally {
    rmSync(repositoryRoot, { force: true, recursive: true });
  }
});

test("isolated Git portability enumeration rejects symlinks", () => {
  const enumerate = requirePortabilityEnumerator();
  const repositoryRoot = createTemporaryGitRepository();

  try {
    writeRepositoryFile(
      repositoryRoot,
      "src/real.ts",
      "export const value = true;\n",
    );
    symlinkSync(
      path.join(tmpdir(), "outside-portability-source.ts"),
      path.join(repositoryRoot, "src", "outside.test.ts"),
    );

    assert.throws(
      () => enumerate({ repositoryRoot, pathspecs: ["src"] }),
      /symlink/i,
    );
  } finally {
    rmSync(repositoryRoot, { force: true, recursive: true });
  }
});

test("Git portability enumeration fails closed for command and output anomalies", () => {
  const enumerate = requirePortabilityEnumerator();
  const repositoryRoot = createTemporaryGitRepository();

  try {
    writeRepositoryFile(
      repositoryRoot,
      "src/ok.ts",
      "export const value = true;\n",
    );
    writeRepositoryFile(
      repositoryRoot,
      "foo/bar.ts",
      "export const value = true;\n",
    );

    for (const [label, result, errorPattern] of [
      [
        "nonzero Git status",
        { status: 128, stderr: "fatal: failed", stdout: "" },
        /Git source enumeration failed/,
      ],
      [
        "unexpected Git stderr",
        { status: 0, stderr: "warning", stdout: "src/ok.ts\0" },
        /unexpected stderr/,
      ],
      [
        "unterminated Git output",
        { status: 0, stderr: "", stdout: "src/ok.ts" },
        /NUL-terminated/,
      ],
      [
        "absolute path",
        { status: 0, stderr: "", stdout: "/tmp/outside.ts\0" },
        /invalid repository-relative path/,
      ],
      [
        "Windows absolute path",
        { status: 0, stderr: "", stdout: "C:\\outside.ts\0" },
        /invalid repository-relative path/,
      ],
      [
        "ambiguous backslash path",
        { status: 0, stderr: "", stdout: "foo\\bar.ts\0" },
        /ambiguous backslash/,
      ],
      [
        "traversal path",
        { status: 0, stderr: "", stdout: "../outside.ts\0" },
        /invalid repository-relative path/,
      ],
      [
        "duplicate path",
        {
          status: 0,
          stderr: "",
          stdout: "src/ok.ts\0src/ok.ts\0",
        },
        /duplicate repository path/,
      ],
      [
        "missing file",
        { status: 0, stderr: "", stdout: "src/missing.ts\0" },
        /missing source path/,
      ],
      [
        "directory",
        { status: 0, stderr: "", stdout: "src\0" },
        /regular file/,
      ],
    ]) {
      assert.throws(
        () =>
          enumerate({
            repositoryRoot,
            pathspecs: ["src"],
            spawnGit: () => result,
          }),
        errorPattern,
        label,
      );
    }
  } finally {
    rmSync(repositoryRoot, { force: true, recursive: true });
  }
});

test("Git portability enumeration normalizes Windows-style separators", () => {
  const enumerate = requirePortabilityEnumerator();
  const repositoryRoot = createTemporaryGitRepository();
  let capturedArgs;

  try {
    const sourcePath = writeRepositoryFile(
      repositoryRoot,
      "src/nested/ok.ts",
      "export const value = true;\n",
    );
    assert.deepEqual(
      enumerate({
        repositoryRoot,
        pathspecs: ["src\\nested"],
        spawnGit: (_command, args) => {
          capturedArgs = args;
          return {
            status: 0,
            stderr: "",
            stdout: "src/nested/ok.ts\0",
          };
        },
      }),
      [sourcePath],
    );
    assert.deepEqual(
      capturedArgs.slice(capturedArgs.indexOf("--") + 1),
      ["src/nested"],
    );
  } finally {
    rmSync(repositoryRoot, { force: true, recursive: true });
  }
});

test("temporary Git repository cleanup owns initialization failures", () => {
  let createdRoot;
  let returnedRoot;

  try {
    assert.throws(
      () => {
        returnedRoot = createTemporaryGitRepository(
          (repositoryRoot, args) => {
            createdRoot = repositoryRoot;
            assert.deepEqual(args, ["init", "--quiet"]);
            throw new Error("injected git init failure");
          },
        );
      },
      /injected git init failure/,
    );
    assert.ok(createdRoot);
    assert.equal(existsSync(createdRoot), false);
  } finally {
    if (returnedRoot) {
      rmSync(returnedRoot, { force: true, recursive: true });
    }
    if (createdRoot) {
      rmSync(createdRoot, { force: true, recursive: true });
    }
  }
});

test("Git portability enumeration rejects oversized text sources", () => {
  const enumerate = requirePortabilityEnumerator();
  const repositoryRoot = createTemporaryGitRepository();

  try {
    writeRepositoryFile(
      repositoryRoot,
      "src/large.ts",
      "x".repeat(1_048_577),
    );
    assert.throws(
      () => enumerate({ repositoryRoot, pathspecs: ["src"] }),
      /exceeds the 1048576-byte portability limit/,
    );
  } finally {
    rmSync(repositoryRoot, { force: true, recursive: true });
  }
});

test("deployment surfaces and fixtures contain no live current-account identifiers", () => {
  const prohibitedValues = [
    ["2507", "0845", "4815"].join(""),
    ["cAIh", "vscg", "2Gwj", "6AGb"].join(""),
    ["ZK9u", "KRAy", "mNTE", "DzCI"].join(""),
    ["m7bi", "OB06", "jypO", "tGUF"].join(""),
    ["X8t5", "amga", "ZWy0", "fp7K"].join(""),
    ["agentic-demo-llm-gateway-", "j5bh", "ipqo", "rh"].join(""),
    ["platform-tools-gw-", "fxo7", "j9jk", "ha"].join(""),
  ];

  for (const sourcePath of portabilitySourcePaths()) {
    const source = readRequired(sourcePath, sourcePath);
    for (const prohibitedValue of prohibitedValues) {
      assert.equal(
        source.includes(prohibitedValue),
        false,
        `${sourcePath} must not contain a live current-account identifier`,
      );
    }
  }
});

test("current deployment instructions contain no live current-account identifiers", () => {
  const prohibitedValues = [
    ["2507", "0845", "4815"].join(""),
    ["cAIh", "vscg", "2Gwj", "6AGb"].join(""),
    ["ZK9u", "KRAy", "mNTE", "DzCI"].join(""),
    ["m7bi", "OB06", "jypO", "tGUF"].join(""),
    ["X8t5", "amga", "ZWy0", "fp7K"].join(""),
    ["agentic-demo-llm-gateway-", "j5bh", "ipqo", "rh"].join(""),
    ["platform-tools-gw-", "fxo7", "j9jk", "ha"].join(""),
  ];

  const codeSurfaces = [[README_PATH, bashBlocks(readRequired(README_PATH, "deployment README")).join("\n")]];
  for (const [sourcePath, commands] of codeSurfaces) {
    for (const prohibitedValue of prohibitedValues) {
      assert.equal(
        commands.includes(prohibitedValue),
        false,
        `${sourcePath} code blocks must not contain a live current-account identifier`,
      );
    }
  }

  for (const [sourcePath, activePlan] of [[README_PATH, readRequired(README_PATH, "deployment README")]]) {
    for (const prohibitedValue of prohibitedValues) {
      assert.equal(
        activePlan.includes(prohibitedValue),
        false,
        `${sourcePath} active instructions must not contain a live `
          + "current-account identifier",
      );
    }
  }
});

test("control-plane README documents portable reference and provision deployment", () => {
  const readme = readRequired(
    PLATFORM_REGISTRY_README_PATH,
    "control-plane deployment README",
  );

  assert.match(readme, /current account[\s\S]+reference-existing/i);
  assert.match(
    readme,
    /clean (?:customer )?account[\s\S]+provision/i,
  );
  assert.match(readme, /AgenticPlatform-ControlPlane-Provisioned/);
  assert.match(readme, /stable[\s\S]+export contract/i);
  assert.match(readme, /CONTROL_PLANE_CONTEXT=\(/);
  assert.match(readme, /"\$\{CONTROL_PLANE_CONTEXT\[@\]\}"/);
  for (const variableName of [
    "CONTROL_PLANE_MODE",
    "CONTROL_PLANE_SHARED_REGISTRY_ID",
    "CONTROL_PLANE_REGISTRY_PLATFORM_ID",
    "CONTROL_PLANE_REGISTRY_CUSTOMER_SUPPORT_ID",
    "CONTROL_PLANE_REGISTRY_OPERATIONS_ID",
    "CONTROL_PLANE_LLM_GATEWAY_ID",
    "CONTROL_PLANE_LLM_GATEWAY_REGION",
    "CONTROL_PLANE_TOOLS_GATEWAY_ID",
  ]) {
    assert.match(readme, new RegExp(variableName));
  }
  assert.match(
    readme,
    /reference-existing[\s\S]+seven[\s\S]+required/i,
  );
  assert.match(
    readme,
    /provision[\s\S]+must not[\s\S]+existing IDs/i,
  );
  assert.match(
    readme,
    /do not commit[\s\S]+Registry[\s\S]+Gateway[\s\S]+IDs/i,
  );
  assert.match(
    readme,
    /region precedence[\s\S]+CDK context `region`[\s\S]+non-empty\s+`AWS_REGION`[\s\S]+non-empty\s+`CDK_DEFAULT_REGION`[\s\S]+`us-west-2`/i,
  );
});

test("Task 6 targeted test command resolves to exact existing test files", () => {
  const infrastructurePackage = JSON.parse(
    readRequired(PACKAGE_PATH, "serverless package.json"),
  );
  const rootPackage = JSON.parse(
    readRequired(ROOT_PACKAGE_PATH, "root package.json"),
  );
  const expectedFiles = [
    "test/deploy-workflow.test.mjs",
    "test/readme-contract.test.mjs",
    "scripts/predeploy-security-audit.test.mjs",
    "scripts/validate-deployed-tags.test.mjs",
  ];
  assert.equal(
    infrastructurePackage.scripts["test:task6"],
    `tsx --test ${expectedFiles.join(" ")}`,
  );
  assert.equal(
    rootPackage.scripts["serverless:test:task6"],
    "npm --prefix infra/serverless-platform run test:task6",
  );
  for (const relativePath of expectedFiles) {
    readRequired(
      path.join(PLATFORM_ROOT, relativePath),
      `Task 6 test file ${relativePath}`,
    );
  }

  const command = "npm --prefix infra/serverless-platform run test:task6";
  const readme = readRequired(README_PATH, "serverless deployment README");
  assert.ok(readme.includes(command));
  assert.doesNotMatch(readme, /test -- deploy-workflow readme-contract predeploy-security-audit/);

});

test("operator runbook matches the implemented Stage 1 deployment contract", () => {
  const readme = readRequired(README_PATH, "serverless deployment README");
  const infrastructurePackage = JSON.parse(
    readRequired(PACKAGE_PATH, "serverless package.json"),
  );
  const rootPackage = JSON.parse(
    readRequired(ROOT_PACKAGE_PATH, "root package.json"),
  );
  const deployWorkflow = parseDeployWorkflow();
  const triggerWorkflow = parseTriggerWorkflow();
  const appStackIds = applicationStackIds(
    readRequired(APP_PATH, "CDK application entry point"),
  );
  const commands = bashBlocks(readme).join("\n");
  const githubDeploymentSection = sectionText(
    readme,
    "GitHub deployment after push",
  );

  assert.match(readme, /^# Serverless Platform Deployment$/m);
  for (const heading of [
    "Stage 1 scope",
    "Prerequisites and target confirmation",
    "One-time AWS bootstrap",
    "GitHub repository configuration",
    "Mandatory pre-deployment security audit",
    "Manual pre-commit deployment",
    "GitHub deployment after push",
    "Smoke tests",
    "Account portability",
    "Post-merge trust cleanup",
    "Stage 1 exceptions and cautions",
    "Troubleshooting",
  ]) {
    assert.match(readme, new RegExp(`^## ${heading}$`, "m"));
  }

  for (const scopeStatement of [
    "private S3",
    "CloudFront",
    "authorization code",
    "PKCE",
    "GET /api/health",
      "GET /api/me",
      "GitHub OIDC",
      "disabled by default",
      "protected `main`",
      "remaining application data APIs are not migrated in Stage 1",
  ]) {
    assert.ok(
      readme.includes(scopeStatement),
      `README must state Stage 1 scope: ${scopeStatement}`,
    );
  }

  for (const [key, value] of Object.entries(REQUIRED_TAGS)) {
    assert.ok(
      readme.includes(`${key}=${value}`),
      `README must document mandatory tag ${key}=${value}`,
    );
  }

  assert.match(
    githubDeploymentSection,
    /synthesizes `AgenticPlatform-ControlPlane-Provisioned` in\s+secretless provision mode before `PlatformWebStack`/,
  );

  for (const placeholder of [
    "<account-id>",
    "<owner/repo>",
    "<unique-cognito-prefix>",
  ]) {
    assert.ok(readme.includes(placeholder), `missing placeholder ${placeholder}`);
  }
  assert.doesNotMatch(readme, /\b\d{12}\b/);
  assert.doesNotMatch(
    readme,
    /AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|BEGIN (?:RSA |EC )?PRIVATE KEY/,
  );
  assert.match(
    readme,
    /Do not commit[\s\S]+passwords[\s\S]+tokens[\s\S]+client secrets[\s\S]+account-specific outputs/i,
  );

  assert.match(readme, /Node\.js 22/);
  assert.match(readme, /aws sts get-caller-identity/);
  assert.match(readme, /\/cdk-bootstrap\/hnb659fds\/version/);
  assert.match(readme, /AWS_REGION=us-west-2/);
  assert.match(readme, /repository write permission/i);
  assert.match(readme, /administrator/i);
  assert.match(readme, /Run these commands from the repository root/);

  for (const scriptName of [
    "test",
    "build",
    "audit",
    "security:audit",
    "synth",
    "diff",
    "deploy:bootstrap",
    "deploy:web",
  ]) {
    assert.ok(
      Object.hasOwn(infrastructurePackage.scripts, scriptName),
      `serverless package is missing script ${scriptName}`,
    );
  }
  for (const scriptName of [
    "infra:test",
    "infra:verify",
    "infra:diff",
    "infra:deploy",
    "platform:verify",
    "serverless:test",
    "serverless:build",
    "serverless:verify",
    "serverless:synth",
    "serverless:deploy:web",
  ]) {
    assert.ok(
      Object.hasOwn(rootPackage.scripts, scriptName),
      `root package is missing script ${scriptName}`,
    );
  }

  const referencedRunScripts = [
    ...commands.matchAll(
      /npm --prefix infra\/serverless-platform run ([a-z][a-z0-9:-]*)/g,
    ),
  ].map((match) => match[1]);
  for (const scriptName of referencedRunScripts) {
    assert.ok(
      Object.hasOwn(infrastructurePackage.scripts, scriptName),
      `README references missing serverless package script ${scriptName}`,
    );
  }
  for (const requiredScript of [
    "build",
    "audit",
    "security:audit",
    "synth",
    "diff",
    "deploy:bootstrap",
    "deploy:web",
  ]) {
    assert.ok(
      referencedRunScripts.includes(requiredScript),
      `README must invoke the ${requiredScript} package script`,
    );
  }
  assert.match(commands, /^npm ci$/m);
  assert.match(
    commands,
    /^npm --prefix infra\/platform-registry ci$/m,
  );
  assert.match(
    commands,
    /^npm --prefix infra\/serverless-platform ci$/m,
  );
  assert.match(commands, /^npm test$/m);
  assert.match(
    commands,
    /^npm --prefix infra\/platform-registry test$/m,
  );
  assert.match(
    commands,
    /^npm --prefix infra\/serverless-platform test$/m,
  );

  assert.deepEqual(appStackIds, [
    "GitHubBootstrapStack",
    "PlatformWebStack",
  ]);
  for (const stackId of appStackIds) {
    assert.ok(readme.includes(stackId), `README must reference ${stackId}`);
  }
  assert.ok(readme.includes(stackName("GitHubBootstrap")));
  assert.ok(readme.includes(stackName("Web")));
  assert.match(commands, /bootstrap "aws:\/\/\$\{AWS_ACCOUNT_ID\}\/\$\{AWS_REGION\}"/);
  assert.match(
    infrastructurePackage.scripts["deploy:web"],
    /--outputs-file deployment-outputs\.json/,
  );
  assert.ok(readme.includes("deployment-outputs.json"));

  const repositoryVariables = Object.entries(deployWorkflow.env)
    .filter(([, value]) => /^\${{ vars\.[A-Z0-9_]+ }}$/.test(value))
    .map(([name, value]) => {
      assert.equal(value, `\${{ vars.${name} }}`);
      return name;
    });
  assert.deepEqual(repositoryVariables.sort(), [
    "AWS_ACCOUNT_ID",
    "AWS_REGION",
    "BRANCH_PROTECTION_ATTESTED",
    "CFN_EXECUTION_ROLE_NAME",
    "COGNITO_DOMAIN_PREFIX",
    "CONTROL_PLANE_LLM_GATEWAY_ID",
    "CONTROL_PLANE_LLM_GATEWAY_REGION",
    "CONTROL_PLANE_MODE",
    "CONTROL_PLANE_REGISTRY_CUSTOMER_SUPPORT_ID",
    "CONTROL_PLANE_REGISTRY_OPERATIONS_ID",
    "CONTROL_PLANE_REGISTRY_PLATFORM_ID",
    "CONTROL_PLANE_SHARED_REGISTRY_ID",
    "CONTROL_PLANE_TOOLS_GATEWAY_ID",
    "ENABLE_GITHUB_DEPLOYMENT",
    "GITHUB_DEPLOY_ROLE_NAME",
    "GITHUB_OIDC_SUBJECT",
    "GITHUB_OIDC_SUBJECT_MODE",
    "JOURNEY_GITHUB_OAUTH_CLIENT_ID",
    "JOURNEY_GITHUB_OAUTH_CLIENT_SECRET_ARN",
    "STARTER_BUILDER_MODEL_ID",
  ]);
  for (const variableName of repositoryVariables) {
    assert.ok(
      readme.includes(variableName),
      `README must document workflow variable ${variableName}`,
    );
  }
  assert.deepEqual(
    markdownTableRows(
      readme,
      "GitHub repository configuration",
      ["Repository variable", "Value"],
    ),
    [
      ["AWS_ACCOUNT_ID", "<account-id>"],
      ["AWS_REGION", "us-west-2"],
      ["ENABLE_GITHUB_DEPLOYMENT", "true"],
      ["BRANCH_PROTECTION_ATTESTED", "true"],
      ["GITHUB_DEPLOY_ROLE_NAME", "AgenticPlatformGitHubDeployRole"],
      [
        "CFN_EXECUTION_ROLE_NAME",
        "AgenticPlatformCloudFormationExecutionRole",
      ],
      ["COGNITO_DOMAIN_PREFIX", "<unique-cognito-prefix>"],
      ["GITHUB_OIDC_SUBJECT_MODE", "legacy or immutable"],
      ["GITHUB_OIDC_SUBJECT", "<exact-attested-main-subject>"],
      ["CONTROL_PLANE_MODE", "reference-existing or provision"],
      [
        "CONTROL_PLANE_SHARED_REGISTRY_ID",
        "required only for reference-existing",
      ],
      [
        "CONTROL_PLANE_REGISTRY_PLATFORM_ID",
        "required only for reference-existing",
      ],
      [
        "CONTROL_PLANE_REGISTRY_CUSTOMER_SUPPORT_ID",
        "required only for reference-existing",
      ],
      [
        "CONTROL_PLANE_REGISTRY_OPERATIONS_ID",
        "required only for reference-existing",
      ],
      [
        "CONTROL_PLANE_LLM_GATEWAY_ID",
        "required only for reference-existing",
      ],
      [
        "CONTROL_PLANE_LLM_GATEWAY_REGION",
        "required only for reference-existing",
      ],
      [
        "CONTROL_PLANE_TOOLS_GATEWAY_ID",
        "required only for reference-existing",
      ],
      [
        "JOURNEY_GITHUB_OAUTH_CLIENT_ID",
        "optional GitHub OAuth App client ID for per-repository authorization",
      ],
      [
        "JOURNEY_GITHUB_OAUTH_CLIENT_SECRET_ARN",
        "optional same-account secret ARN containing the OAuth App client secret",
      ],
      [
        "STARTER_BUILDER_MODEL_ID",
        "exact model ID exposed by the selected inference Gateway",
      ],
    ],
    "GitHub repository variables must show raw values, not shell assignments",
  );
  assert.equal(
    deployWorkflow.env.GITHUB_REPOSITORY_ID,
    "${{ github.repository_id }}",
  );
  assert.equal(
    deployWorkflow.env.GITHUB_REPOSITORY_OWNER_ID,
    "${{ github.repository_owner_id }}",
  );
  assert.equal(
    deployWorkflow.env.AUDITED_GITHUB_WORKFLOW_REF,
    "${{ github.repository }}/.github/workflows/"
      + "deploy-serverless-platform.yml@refs/heads/main",
  );
  assert.deepEqual(Object.keys(deployWorkflow.on), ["workflow_call"]);
  assert.deepEqual(deployWorkflow.on.workflow_call, {});
  for (const [jobName, job] of Object.entries(deployWorkflow.jobs)) {
    assert.equal(
      Object.hasOwn(job, "environment"),
      false,
      `workflow job ${jobName} must not declare a GitHub Environment`,
    );
  }
  assert.doesNotMatch(
    JSON.stringify(deployWorkflow),
    /COGNITO_DEMO_USERS_JSON|COGNITO_DEMO_USER_PASSWORDS_JSON|seed-demo-users/i,
  );
  assert.match(
    readme,
    /normal[\s\S]+deployment[\s\S]+do(?:es)? not seed users/i,
  );
  assert.match(readme, /existing users are[\s\S]+preserved/i);
  assert.match(readme, /no GitHub Environment/i);
  assert.match(readme, /branch-scoped/i);
  assert.match(
    readme,
    /GitHub deployment remains disabled until an administrator/i,
  );
  assert.match(
    readme,
    /private repository[\s\S]+does not support branch protection/i,
  );

  const workflowBranches = triggerWorkflow.on.push.branches;
  assert.deepEqual(workflowBranches, [
    "main",
    "feat/serverless-aws-deployment",
  ]);
  for (const branch of workflowBranches) {
    assert.ok(readme.includes(branch), `README must document branch ${branch}`);
  }
  assert.match(
    readme,
    /feature-branch pushes[\s\S]+verification only/i,
  );
  assert.match(readme, /manual `workflow_dispatch`[\s\S]+verification-only/i);
  assert.match(readme, /deploy[\s\S]+main-only/i);

  const verifyJob = triggerWorkflow.jobs.verify;
  assert.doesNotMatch(JSON.stringify(verifyJob), /id-token/);
  assert.deepEqual(triggerWorkflow.jobs.deploy.permissions, {
    contents: "read",
    "id-token": "write",
  });
  assert.equal(
    triggerWorkflow.jobs.deploy.uses,
    "./.github/workflows/deploy-serverless-platform.yml",
  );
  const deployJob = deployWorkflow.jobs.deploy;
  const controlPlaneDiffStep = workflowStep(
    deployJob,
    "Review control-plane changes",
  );
  const controlPlaneDeployStep = workflowStep(
    deployJob,
    "Deploy control-plane stack",
  );
  const diffStep = workflowStep(deployJob, "Review web changes");
  const deployStep = workflowStep(deployJob, "Deploy PlatformWebStack");
  assert.equal(
    controlPlaneDiffStep["working-directory"],
    "infra/platform-registry",
  );
  assert.equal(
    controlPlaneDeployStep["working-directory"],
    "infra/platform-registry",
  );
  assert.equal(diffStep["working-directory"], "infra/serverless-platform");
  assert.equal(deployStep["working-directory"], "infra/serverless-platform");
  for (const step of [diffStep, deployStep]) {
    const stackId = appStackIds.find((candidate) => step.run.includes(candidate));
    assert.equal(stackId, "PlatformWebStack");
    assert.ok(readme.includes(stackId));
  }
  for (const stepName of [
    "Validate deployment configuration",
    "Verify checked commit is current main head",
    "Configure AWS credentials with GitHub OIDC",
    "Verify AWS caller and CDK bootstrap",
    "Run security audit before control-plane diff",
    "Review control-plane changes",
    "Run security audit before control-plane deploy",
    "Deploy control-plane stack",
    "Validate control-plane outputs and tags",
    "Run security audit before web diff",
    "Review web changes",
    "Run security audit before web deploy",
    "Deploy PlatformWebStack",
    "Validate security target after web deploy",
    "Validate deployed project tags",
    "Smoke test deployed application",
  ]) {
    workflowStep(deployJob, stepName);
    assert.ok(
      readme.includes(stepName),
      `README must describe workflow step ${stepName}`,
    );
  }

  assert.match(
    readme,
    /token\.actions\.githubusercontent\.com[\s\S]+githubOidcProviderArn/i,
  );
  assert.match(
    commands,
    /list-open-id-connect-providers[\s\S]+oidc-provider\/token\.actions\.githubusercontent\.com/,
  );
  assert.match(
    commands,
    /read -r -s[\s\S]+export COGNITO_DEMO_USERS_JSON[\s\S]+export COGNITO_DEMO_USER_PASSWORDS_JSON[\s\S]+node infra\/serverless-platform\/scripts\/seed-demo-users\.mjs[\s\S]+clear_seed_environment/,
  );
  assert.match(
    commands,
    /clear_seed_environment\(\)[\s\S]+unset COGNITO_DEMO_USERS_JSON[\s\S]+unset COGNITO_DEMO_USER_PASSWORDS_JSON[\s\S]+trap clear_seed_environment EXIT/,
  );
  assert.doesNotMatch(
    commands,
    /COGNITO_DEMO_USER_PASSWORDS_JSON\s*=\s*['"]?\{/,
  );
  assert.match(
    readme,
    /reference-existing[\s\S]+CONTROL_PLANE_SHARED_REGISTRY_ID[\s\S]+CONTROL_PLANE_TOOLS_GATEWAY_ID/i,
  );
  assert.match(
    readme,
    /provision[\s\S]+must not require[\s\S]+existing IDs/i,
  );
  assert.match(
    readme,
    /AgenticPlatform-ControlPlane-Provisioned[\s\S]+stable exports/i,
  );
  assert.match(
    readme,
    /security audit[\s\S]+immediately before[\s\S]+every[\s\S]+diff[\s\S]+deploy/i,
  );
  assert.match(
    readme,
    /post-deployment[\s\S]+auto-delete=no/i,
  );
  assert.match(
    readme,
    /no checked-in[\s\S]+Registry[\s\S]+Gateway[\s\S]+config/i,
  );

  assert.match(readme, /infra\/serverless-platform\/security-audit\//);
  for (const reviewArea of [
    "IAM trust",
    "IAM permissions",
    "mandatory tags",
    "S3 public access",
    "CloudFront origin access",
    "TLS",
    "Cognito",
    "API authorization",
    "throttling",
    "Lambda",
    "logging",
    "tracing",
    "concurrency",
    "alarms",
  ]) {
    assert.ok(
      readme.includes(reviewArea),
      `security gate must review ${reviewArea}`,
    );
  }

  assert.match(readme, /GET \/api\/health[\s\S]+200/);
  assert.match(readme, /GET \/api\/me[\s\S]+401/);
  assert.match(readme, /token_use[\s\S]+access/);
  assert.match(readme, /ID tokens[\s\S]+401/i);
  assert.match(readme, /do not require a Lambda-specific response body/i);
  assert.match(readme, /password-change challenge/i);
  assert.match(readme, /authenticated `GET \/api\/me` projection/i);
  assert.match(readme, /logout/i);
  assert.match(readme, /no token[\s\S]+secret[\s\S]+response/i);

  for (const caution of [
    "CloudFront default certificate",
    "TLS_V1_2_2021",
    "separate `us-east-1` edge stack",
    "termination protection",
    "`RETAIN`",
    "deliberate cleanup",
    "non-migrated panels may be empty",
  ]) {
    assert.ok(readme.includes(caution), `README must state caution: ${caution}`);
  }

  assert.match(readme, /^### Retained runtime boundary recovery$/m);
  assert.match(
    readme,
    /stack deletion or recreation[\s\S]+verify ownership[\s\S]+policy hash/i,
  );
  assert.match(
    readme,
    /approved recovery procedure[\s\S]+import or adopt[\s\S]+deliberately remove/i,
  );
  assert.match(
    readme,
    /never overwrite or delete an unknown policy/i,
  );

  for (const troubleshootingTopic of [
    "Cognito domain collision",
    "Duplicate GitHub OIDC provider",
    "Retained runtime boundary recovery",
    "401 after login",
    "GitHub OIDC subject mismatch",
  ]) {
    assert.match(
      readme,
      new RegExp(`^### ${troubleshootingTopic}$`, "m"),
    );
  }
});

test("README documents permanent Registry governance workflow retention", () => {
  const readme = readFileSync(README_PATH, "utf8");

  assert.match(readme, /^## Registry governance state retention$/m);
  assert.match(
    readme,
    /Registry decision request claims[\s\S]+request results[\s\S]+semver-scoped record locks[\s\S]+immutable audit evidence[\s\S]+permanent/i,
  );
  assert.match(
    readme,
    /omits\s+the\s+DynamoDB `expiresAt` attribute[\s\S]+not removed by TTL/i,
  );
  assert.match(
    readme,
    /domain-create[\s\S]+24-hour TTL/i,
  );
  assert.match(
    readme,
    /deliberate[\s\S]+retention\s+procedure[\s\S]+request\s+result[\s\S]+record\s+lock[\s\S]+audit\s+evidence/i,
  );
});

test("portable deployment docs define the Cognito domain owner-group lifecycle", () => {
  const documents = [
    ["README", readRequired(README_PATH, "serverless platform README")],
  ];

  for (const [label, document] of documents) {
    assert.match(
      document,
      /every domain creation\s+creates or reconciles an operation-bound Cognito\s+owner\s+group/i,
      label,
    );
    assert.match(
      document,
      /ownerGroup[\s\S]+string/i,
      label,
    );
    assert.match(
      document,
      /does not create Cognito users[\s\S]*does not\s+(?:create or assign|assign|add) memberships/i,
      label,
    );
    assert.match(
      document,
      /baseline domain groups[\s\S]+CDK/i,
      label,
    );
    assert.match(
      document,
      /dynamic Cognito groups[\s\S]+not\s+taggable[\s\S]+versioned description\s+marker[\s\S]+auto-delete=no/i,
      label,
    );
    assert.match(
      document,
      /temporary verifier users before\s+exact group\s+cleanup[\s\S]+verif(?:y|ies|ied) group\s+absence/i,
      label,
    );
  }

  const readme = documents[0][1];
  assert.match(
    readme,
    /PlatformAdminApiRole[\s\S]+CreateGroup[\s\S]+DeleteGroup[\s\S]+GetGroup[\s\S]+ListUsersInGroup[\s\S]+exact[\s\S]+user-pool ARN/i,
  );
  assert.match(
    readme,
    /HostedAcceptanceBrokerRole[\s\S]+DeleteGroup[\s\S]+GetGroup[\s\S]+ListUsersInGroup[\s\S]+exact[\s\S]+user-pool ARN/i,
  );
  assert.match(
    readme,
    /cleanup[\s\S]+exact empty[\s\S]+operation-owned group[\s\S]+before Registry and DynamoDB[\s\S]+mismatch[\s\S]+non-empty[\s\S]+fails closed/i,
  );
  assert.doesNotMatch(
    readme,
    /domain creation does not create (?:a )?Cognito group/i,
  );
});

test("README documents source-based strict IAM and cross-stack verification", () => {
  const readme = readFileSync(README_PATH, "utf8");

  assert.match(
    readme,
    /`deploy`[\s\S]+exact Task 5 target[\s\S]+exact Task 3 predecessor/i,
  );
  assert.match(
    readme,
    /`postdeploy`[\s\S]+current synthesized CDK IAM contract[\s\S]+exact inline\/attached policy inventories[\s\S]+SECURITY_AUDIT_DOMAIN_TEMPLATE/i,
  );
  assert.match(
    readme,
    /all 26 bounded Web roles plus the\s+separately constrained HostedAcceptanceRole/i,
  );
  assert.match(readme, /HostedAcceptanceBrokerRole/i);
  assert.match(
    readme,
    /unbounded[\s\S]+HostedAcceptanceRole|HostedAcceptanceRole[\s\S]+unbounded/i,
  );
});

test("README documents the strict Governance API effective-policy audit", () => {
  const readme = readFileSync(README_PATH, "utf8");
  const governanceAudit = readme.match(
    /`AgenticPlatform-Web-GovernanceApiRole` must match[\s\S]+?(?=\n\n)/i,
  )?.[0];

  assert.ok(governanceAudit, "README must document the Governance API audit");
  assert.match(governanceAudit, /exact effective policy/i);
  assert.match(
    governanceAudit,
    /`deploy` mode only[\s\S]+exact previously deployed[\s\S]+policy/i,
  );
  assert.match(governanceAudit, /`postdeploy` has no predecessor allowance/i);
  assert.match(
    governanceAudit,
    /transaction-scoped underlying item actions/i,
  );
  assert.match(governanceAudit, /GovernanceApiLogs[\s\S]+exactly one/i);
  assert.match(governanceAudit, /PlatformWeb/i);
  assert.match(governanceAudit, /exact Lambda trust/i);
  assert.match(governanceAudit, /no attached managed\s+policies/i);
  assert.match(governanceAudit, /exactly two inline policies/i);
  assert.match(governanceAudit, /`GovernanceApi`/i);
  assert.match(governanceAudit, /CDK\s+X-Ray/i);
  assert.match(
    governanceAudit,
    /exact log,[\s\S]+DynamoDB,[\s\S]+Cognito,[\s\S]+Registry permissions/i,
  );
  assert.match(governanceAudit, /request-tag conditions/i);
  assert.match(governanceAudit, /resource-tag conditions/i);
  assert.match(governanceAudit, /`auto-delete=no`/i);
  assert.match(governanceAudit, /no additional action, resource, condition/i);
  assert.match(governanceAudit, /deployment validation role/i);
  assert.match(governanceAudit, /policy-read\s+permissions/i);
});

test("provision docs keep the control-plane runtime boundary stack-owned", () => {
  const rootReadme = readRequired(
    path.join(REPOSITORY_ROOT, "README.md"),
    "root README",
  );
  const platformReadme = readRequired(
    PLATFORM_REGISTRY_README_PATH,
    "platform Registry README",
  );
  const serverlessReadme = readRequired(
    README_PATH,
    "serverless platform README",
  );

  for (const [label, markdown] of [
    ["platform Registry README", platformReadme],
    ["serverless platform README", serverlessReadme],
  ]) {
    assert.match(
      markdown,
      /provision[\s\S]+(?:stack-owned|creates\s+its\s+own)[\s\S]+runtime permissions boundary/i,
      label,
    );
    assert.doesNotMatch(
      markdown,
      /CONTROL_PLANE_RUNTIME_PERMISSIONS_BOUNDARY_ARN/,
      label,
    );
    assert.doesNotMatch(
      markdown,
      /runtimePermissionsBoundaryArn=/,
      label,
    );
  }
  assert.match(
    rootReadme,
    /npm run platform:deploy:clean-account/,
  );
  assert.match(
    rootReadme,
    /deploys[\s\S]+ControlPlane[\s\S]+then deploys the web stack/i,
  );
});

test("READMEs document provision Registry IAM, broker deadlines, and immutable acceptance evidence", () => {
  const readme = readFileSync(README_PATH, "utf8");
  const registryReadme = readFileSync(
    PLATFORM_REGISTRY_README_PATH,
    "utf8",
  );

  for (const document of [readme, registryReadme]) {
    const normalizedDocument = document.replace(/\s+/g, " ");
    assert.match(
      document,
      /`agent-registry:CreateRegistry`[\s\S]+`Resource: "\*"`[\s\S]+exact mandatory request tags[\s\S]+`aws:TagKeys`[\s\S]+`aws:RequestedRegion`/i,
    );
    assert.match(
      normalizedDocument,
      /`agent-registry:TagResource`.*regional account Registry wildcard.*exact request tags.*existing mandatory ownership tags/i,
    );
    assert.match(
      normalizedDocument,
      /Registry records receive the mandatory tags in (?:their|the) initial create request/i,
    );
    assert.match(
      normalizedDocument,
      /Existing Registry and record mutations require the same exact resource tags/i,
    );
  }
  assert.match(
    registryReadme,
    /reference-existing[\s\S]+creates no IAM role or policy/i,
  );
  assert.match(
    readme,
    /ControlPlaneRegistryDeployment[\s\S]+dedicated managed policy/i,
  );
  assert.match(
    readme,
    /broker Lambda[\s\S]+120 seconds[\s\S]+resource-operation caller\s+deadline[\s\S]+150 seconds[\s\S]+API[\s\S]+browser[\s\S]+Cognito[\s\S]+20 seconds/i,
  );
  assert.match(
    readme,
    /acceptance cleanup intentionally\s+preserves the Registry decision\s+request result[\s\S]+immutable audit[\s\S]+semver record lock/i,
  );
  assert.match(
    readme,
    /exact temporary domain-create request state[\s\S]+actor mapping is deleted only\s+after all temporary resource cleanup succeeds/i,
  );
});
