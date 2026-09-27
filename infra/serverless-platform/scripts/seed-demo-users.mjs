import { execFileSync as nodeExecFileSync } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const SUPPORTED_GROUPS = Object.freeze([
  "platform-admin",
  "domain-builder",
  "end-user",
]);

export const DEMO_USER_MANAGED_BY_ATTRIBUTE = "custom:managed_by";
export const DEMO_USER_MANAGED_BY_VALUE = "agentic-ai-platform-demo";
export const DEFAULT_AWS_CLI_TIMEOUT_MS = 20_000;

const ADMIN_GET_USER_NOT_FOUND = new Set([
  "An error occurred (UserNotFoundException) when calling the "
    + "AdminGetUser operation: User does not exist.\n",
  "\nAn error occurred (UserNotFoundException) when calling the "
    + "AdminGetUser operation: User does not exist.\n",
  "\naws: [ERROR]: An error occurred (UserNotFoundException) when calling the "
    + "AdminGetUser operation: User does not exist.\n",
]);
const ADMIN_DELETE_USER_NOT_FOUND = new Set([
  "An error occurred (UserNotFoundException) when calling the "
    + "AdminDeleteUser operation: User does not exist.\n",
  "\nAn error occurred (UserNotFoundException) when calling the "
    + "AdminDeleteUser operation: User does not exist.\n",
  "\naws: [ERROR]: An error occurred (UserNotFoundException) when calling the "
    + "AdminDeleteUser operation: User does not exist.\n",
]);
const USER_NOT_FOUND_BY_OPERATION = new Map([
  ["admin-delete-user", ADMIN_DELETE_USER_NOT_FOUND],
  ["admin-get-user", ADMIN_GET_USER_NOT_FOUND],
]);
const COGNITO_PASSWORD_SYMBOLS =
  "^$*.[]{}()?-\"!@#%&/\\,><':;|_~`+=";
const CLI_INPUT_JSON_OPTION = "--cli-input-json";
const CLI_INPUT_STDIN_SENTINEL = "file:///dev/stdin";
const DEFAULT_INPUT_FILE_SYSTEM = Object.freeze({
  chmodSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
});
const awsCliErrorClassifications = new WeakMap();

class TemporaryInputCleanupError extends Error {
  constructor(outcome) {
    const details = {
      recovered: {
        code: "TEMP_INPUT_CLEANUP_RECOVERED",
        message: "AWS CLI temporary input cleanup required secure recovery.",
      },
      scrubbed: {
        code: "TEMP_INPUT_CLEANUP_FAILED_AFTER_SECRET_SCRUBBING",
        message:
          "AWS CLI temporary input cleanup failed after secret scrubbing.",
      },
      unscrubbed: {
        code: "TEMP_INPUT_CLEANUP_AND_SECRET_SCRUBBING_FAILED",
        message:
          "AWS CLI temporary input cleanup and secret scrubbing failed.",
      },
    }[outcome];
    super(details.message);
    this.name = "TemporaryInputCleanupError";
    this.code = details.code;
  }
}

function stringOutput(value) {
  if (typeof value === "string") {
    return value;
  }
  return value === undefined || value === null ? "" : String(value);
}

function sanitizedAwsError(args, error, input) {
  const operation = args[1] ?? args[0] ?? "command";
  const code = Number.isInteger(error?.status)
    ? error.status
    : error?.code;
  const sanitized = new Error(
    `AWS CLI ${operation} failed (exit code ${code ?? "unknown"}).`,
  );
  sanitized.name = "AwsCliError";
  sanitized.code = code;
  const stderr = input === undefined ? stringOutput(error?.stderr) : "";
  awsCliErrorClassifications.set(sanitized, {
    userNotFound:
      input === undefined
      && code === 254
      && args[0] === "cognito-idp"
      && USER_NOT_FOUND_BY_OPERATION.get(args[1])?.has(stderr) === true,
  });
  return sanitized;
}

function removeTemporaryInputDirectory(directoryPath, inputFileSystem) {
  try {
    inputFileSystem.rmSync(directoryPath, { recursive: true, force: true });
    return;
  } catch {}

  let secretScrubbed = false;
  try {
    inputFileSystem.writeFileSync(
      join(directoryPath, "input.json"),
      "",
      {
        encoding: "utf8",
        flag: "w",
        mode: 0o600,
      },
    );
    secretScrubbed = true;
  } catch {}

  try {
    inputFileSystem.rmSync(directoryPath, { recursive: true, force: true });
  } catch {
    throw new TemporaryInputCleanupError(
      secretScrubbed ? "scrubbed" : "unscrubbed",
    );
  }

  throw new TemporaryInputCleanupError("recovered");
}

function prepareCliInput(
  args,
  input,
  inputFileSystem,
  onDirectoryCreated,
) {
  const optionIndexes = [];
  const sentinelIndexes = [];
  let hasMalformedSentinel = false;

  for (const [index, argument] of args.entries()) {
    if (argument === CLI_INPUT_JSON_OPTION) {
      optionIndexes.push(index);
    }
    if (argument === CLI_INPUT_STDIN_SENTINEL) {
      sentinelIndexes.push(index);
    } else if (
      typeof argument === "string"
      && argument.includes(CLI_INPUT_STDIN_SENTINEL)
    ) {
      hasMalformedSentinel = true;
    }
  }

  if (
    typeof input !== "string"
    || hasMalformedSentinel
    || optionIndexes.length !== 1
    || sentinelIndexes.length !== 1
    || sentinelIndexes[0] !== optionIndexes[0] + 1
  ) {
    throw new Error("Invalid AWS CLI JSON input configuration.");
  }

  const directoryPath = inputFileSystem.mkdtempSync(
    join(tmpdir(), "agentic-ai-platform-cognito-"),
  );
  onDirectoryCreated(directoryPath);
  inputFileSystem.chmodSync(directoryPath, 0o700);
  const filePath = join(directoryPath, "input.json");
  inputFileSystem.writeFileSync(filePath, input, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });

  const executionArgs = [...args];
  executionArgs[sentinelIndexes[0]] = `file://${filePath}`;
  return { executionArgs };
}

export async function runAwsCli(
  args,
  {
    input,
    environment = process.env,
    inputFileSystem = DEFAULT_INPUT_FILE_SYSTEM,
    timeoutMs,
  } = {},
  execFileSync = nodeExecFileSync,
) {
  if (
    timeoutMs !== undefined
    && (!Number.isInteger(timeoutMs) || timeoutMs <= 0)
  ) {
    throw new Error("AWS CLI timeout must be a positive integer.");
  }
  let temporaryInputDirectory;
  try {
    const childEnvironment = { ...environment };
    delete childEnvironment.COGNITO_DEMO_USER_PASSWORDS_JSON;
    const options = {
      encoding: "utf8",
      env: childEnvironment,
      maxBuffer: 1024 * 1024,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      ...(timeoutMs === undefined
        ? {}
        : { timeout: timeoutMs, killSignal: "SIGKILL" }),
    };
    let executionArgs = args;
    if (input !== undefined) {
      const preparedInput = prepareCliInput(
        args,
        input,
        inputFileSystem,
        (directoryPath) => {
          temporaryInputDirectory = directoryPath;
        },
      );
      executionArgs = preparedInput.executionArgs;
      options.stdio = ["ignore", "pipe", "pipe"];
    }

    const stdout = execFileSync("aws", executionArgs, options);
    return { stdout, stderr: "" };
  } catch (error) {
    throw sanitizedAwsError(args, error, input);
  } finally {
    if (temporaryInputDirectory !== undefined) {
      removeTemporaryInputDirectory(
        temporaryInputDirectory,
        inputFileSystem,
      );
    }
  }
}

export function isAwsCliUserNotFound(error) {
  return awsCliErrorClassifications.get(error)?.userNotFound === true;
}

function userArguments(operation, userPoolId, username, region) {
  return [
    "cognito-idp",
    operation,
    "--user-pool-id",
    userPoolId,
    "--username",
    username,
    "--region",
    region,
  ];
}

function existingUserError(username) {
  return new Error(
    `Existing Cognito demo user ${username} is not managed by this deployment.`,
  );
}

function existingUserGroupError(username) {
  return new Error(
    `Existing Cognito demo user ${username} has unexpected group membership.`,
  );
}

function exactAttribute(attributes, name, value) {
  const matches = attributes.filter((attribute) =>
    attribute
    && typeof attribute === "object"
    && !Array.isArray(attribute)
    && attribute.Name === name
  );
  return matches.length === 1 && matches[0].Value === value;
}

function verifyExistingUser(stdout, user) {
  let document;
  try {
    document = JSON.parse(stdout);
  } catch {
    throw existingUserError(user.username);
  }

  if (
    !document
    || typeof document !== "object"
    || Array.isArray(document)
    || document.Username !== user.username
    || document.Enabled !== true
    || !["CONFIRMED", "FORCE_CHANGE_PASSWORD"].includes(document.UserStatus)
    || !Array.isArray(document.UserAttributes)
    || !exactAttribute(document.UserAttributes, "name", user.name)
    || (
      user.email !== undefined
      && (
        !exactAttribute(document.UserAttributes, "email", user.email)
        || !exactAttribute(
          document.UserAttributes,
          "email_verified",
          "true",
        )
      )
    )
    || !exactAttribute(
      document.UserAttributes,
      DEMO_USER_MANAGED_BY_ATTRIBUTE,
      DEMO_USER_MANAGED_BY_VALUE,
    )
  ) {
    throw existingUserError(user.username);
  }
  return document.UserStatus;
}

function verifyExistingGroups(stdout, user) {
  let document;
  try {
    document = JSON.parse(stdout);
  } catch {
    throw existingUserGroupError(user.username);
  }

  if (
    !document
    || typeof document !== "object"
    || Array.isArray(document)
    || !Array.isArray(document.Groups)
    || Object.hasOwn(document, "NextToken")
  ) {
    throw existingUserGroupError(user.username);
  }

  const groupNames = new Set();
  for (const group of document.Groups) {
    if (
      !group
      || typeof group !== "object"
      || Array.isArray(group)
      || typeof group.GroupName !== "string"
      || !SUPPORTED_GROUPS.includes(group.GroupName)
      || group.GroupName !== user.group
      || groupNames.has(group.GroupName)
    ) {
      throw existingUserGroupError(user.username);
    }
    groupNames.add(group.GroupName);
  }
  return groupNames.has(user.group);
}

export async function seedDemoUsers({
  userPoolId,
  passwordFor,
  region,
  users,
  runAws = runAwsCli,
  timeoutMs = DEFAULT_AWS_CLI_TIMEOUT_MS,
}) {
  if (
    !Number.isInteger(timeoutMs)
    || timeoutMs <= 0
    || timeoutMs > 60_000
  ) {
    throw new Error("timeoutMs must be an integer from 1 through 60000.");
  }
  if (!Array.isArray(users) || users.length === 0) {
    throw new Error("At least one configured demo persona is required.");
  }
  const cliOptions = (options = {}) => ({ ...options, timeoutMs });
  const userStates = [];

  for (const user of users) {
    let lookup;
    try {
      lookup = await runAws(
        userArguments("admin-get-user", userPoolId, user.username, region),
        cliOptions(),
      );
    } catch (error) {
      if (!isAwsCliUserNotFound(error)) {
        throw error;
      }
      userStates.push({
        user,
        exists: false,
        hasExpectedGroup: false,
      });
      continue;
    }

    const userStatus = verifyExistingUser(lookup?.stdout, user);
    const groups = await runAws(
      userArguments(
        "admin-list-groups-for-user",
        userPoolId,
        user.username,
        region,
      ),
      cliOptions(),
    );
    userStates.push({
      user,
      exists: true,
      userStatus,
      hasExpectedGroup: verifyExistingGroups(groups?.stdout, user),
    });
  }

  for (const {
    user,
    exists,
    userStatus,
    hasExpectedGroup,
  } of userStates) {
    if (!exists) {
      await runAws(
        [
          "cognito-idp",
          "admin-create-user",
          "--cli-input-json",
          "file:///dev/stdin",
          "--region",
          region,
        ],
        cliOptions({
          input: JSON.stringify({
            UserPoolId: userPoolId,
            Username: user.username,
            TemporaryPassword: passwordFor(user.username),
            UserAttributes: [
              { Name: "name", Value: user.name },
              ...(user.email === undefined
                ? []
                : [
                    { Name: "email", Value: user.email },
                    { Name: "email_verified", Value: "true" },
                  ]),
              {
                Name: DEMO_USER_MANAGED_BY_ATTRIBUTE,
                Value: DEMO_USER_MANAGED_BY_VALUE,
              },
            ],
            MessageAction: "SUPPRESS",
          }),
        }),
      );
    } else if (userStatus === "FORCE_CHANGE_PASSWORD") {
      await runAws(
        [
          "cognito-idp",
          "admin-set-user-password",
          "--cli-input-json",
          "file:///dev/stdin",
          "--region",
          region,
        ],
        cliOptions({
          input: JSON.stringify({
            UserPoolId: userPoolId,
            Username: user.username,
            Password: passwordFor(user.username),
            Permanent: false,
          }),
        }),
      );
    }

    if (!hasExpectedGroup) {
      await runAws(
        [
          "cognito-idp",
          "admin-add-user-to-group",
          "--user-pool-id",
          userPoolId,
          "--username",
          user.username,
          "--group-name",
          user.group,
          "--region",
          region,
        ],
        cliOptions(),
      );
    }
  }
}

function requiredEnvironmentValue(env, name) {
  const value = env[name];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${name} is required.`);
  }
  return value;
}

export function parseDemoUsersJson(usersJson) {
  let users;
  try {
    users = JSON.parse(usersJson);
  } catch {
    throw new Error(
      "COGNITO_DEMO_USERS_JSON must be a valid JSON array.",
    );
  }
  if (!Array.isArray(users) || users.length === 0 || users.length > 20) {
    throw new Error(
      "COGNITO_DEMO_USERS_JSON must contain 1 through 20 personas.",
    );
  }

  const usernames = new Set();
  return users.map((candidate) => {
    if (
      !candidate
      || typeof candidate !== "object"
      || Array.isArray(candidate)
    ) {
      throw new Error("COGNITO_DEMO_USERS_JSON contains an invalid persona.");
    }
    const keys = Object.keys(candidate).sort();
    const allowedKeys = candidate.email === undefined
      ? ["group", "name", "username"]
      : ["email", "group", "name", "username"];
    if (
      keys.length !== allowedKeys.length
      || keys.some((key, index) => key !== allowedKeys[index])
      || typeof candidate.username !== "string"
      || !/^[A-Za-z0-9][A-Za-z0-9._@+-]{0,127}$/.test(candidate.username)
      || usernames.has(candidate.username)
      || typeof candidate.name !== "string"
      || candidate.name.length === 0
      || candidate.name.length > 128
      || candidate.name !== candidate.name.trim()
      || /[\u0000-\u001f\u007f]/.test(candidate.name)
      || !SUPPORTED_GROUPS.includes(candidate.group)
      || (
        candidate.email !== undefined
        && (
          typeof candidate.email !== "string"
          || candidate.email.length > 254
          || !/^[^@\s]+@[^@\s]+$/.test(candidate.email)
        )
      )
    ) {
      throw new Error("COGNITO_DEMO_USERS_JSON contains an invalid persona.");
    }
    usernames.add(candidate.username);
    return Object.freeze({ ...candidate });
  });
}

function isCognitoPassword(password) {
  return typeof password === "string"
    && password.length >= 14
    && password.length <= 256
    && /[A-Z]/.test(password)
    && /[a-z]/.test(password)
    && /[0-9]/.test(password)
    && [...password].some((character, index) =>
      COGNITO_PASSWORD_SYMBOLS.includes(character)
      || (
        character === " "
        && index > 0
        && index < password.length - 1
      )
    );
}

function passwordProvider(passwordsJson, users) {
  let passwords;
  try {
    passwords = JSON.parse(passwordsJson);
  } catch {
    throw new Error(
      "COGNITO_DEMO_USER_PASSWORDS_JSON must be a valid JSON object.",
    );
  }
  if (
    !passwords
    || typeof passwords !== "object"
    || Array.isArray(passwords)
  ) {
    throw new Error(
      "COGNITO_DEMO_USER_PASSWORDS_JSON must be a valid JSON object.",
    );
  }

  const expectedUsernames = users.map(({ username }) => username).sort();
  const actualUsernames = Object.keys(passwords).sort();
  if (
    actualUsernames.length !== expectedUsernames.length
    || actualUsernames.some(
      (username, index) => username !== expectedUsernames[index],
    )
  ) {
    throw new Error(
      "COGNITO_DEMO_USER_PASSWORDS_JSON keys must exactly match all configured usernames.",
    );
  }

  for (const { username } of users) {
    if (!isCognitoPassword(passwords[username])) {
      throw new Error(
        `COGNITO_DEMO_USER_PASSWORDS_JSON password for ${username} `
          + "does not meet the Cognito policy.",
      );
    }
  }
  if (new Set(Object.values(passwords)).size !== users.length) {
    throw new Error(
      "COGNITO_DEMO_USER_PASSWORDS_JSON must contain a distinct password "
        + "for every demo user.",
    );
  }

  const knownUsernames = new Set(expectedUsernames);
  return (username) => {
    if (!knownUsernames.has(username)) {
      throw new Error("Unknown demo user requested.");
    }
    return passwords[username];
  };
}

export async function runCli({
  argv = [],
  env = {},
  seed = seedDemoUsers,
} = {}) {
  const validateOnly = argv.length === 1 && argv[0] === "--validate-only";
  if (argv.length > 0 && !validateOnly) {
    throw new Error("Usage: seed-demo-users.mjs [--validate-only]");
  }
  const userPoolId = validateOnly
    ? undefined
    : requiredEnvironmentValue(env, "COGNITO_USER_POOL_ID");
  const users = parseDemoUsersJson(
    requiredEnvironmentValue(env, "COGNITO_DEMO_USERS_JSON"),
  );
  const passwordsJson = requiredEnvironmentValue(
    env,
    "COGNITO_DEMO_USER_PASSWORDS_JSON",
  );
  const region = typeof env.AWS_REGION === "string" && env.AWS_REGION.trim()
    ? env.AWS_REGION.trim()
    : "us-west-2";
  const passwordFor = passwordProvider(passwordsJson, users);

  if (validateOnly) {
    return;
  }
  await seed({
    userPoolId,
    passwordFor,
    region,
    users,
  });
}

const isExecutable = process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isExecutable) {
  try {
    await runCli({ argv: process.argv.slice(2), env: process.env });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
