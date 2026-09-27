import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

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
const CONTROL_PLANE_APP_PATH = fileURLToPath(
  new URL("../../platform-registry/bin/app.ts", import.meta.url),
);
const CLEAN_ACCOUNT_DEPLOY_PATH = fileURLToPath(
  new URL("../../../scripts/deploy-clean-account.mjs", import.meta.url),
);
const ROOT_PACKAGE_PATH = fileURLToPath(
  new URL("../../../package.json", import.meta.url),
);
const DEPLOY_WORKFLOW_REFERENCE =
  "${{ github.repository }}/.github/workflows/"
  + "deploy-serverless-platform.yml@refs/heads/main";
const DEPLOYMENT_GATE =
  "github.event_name == 'push' "
  + "&& github.ref == 'refs/heads/main' "
  + "&& github.ref_protected == true "
  + "&& vars.ENABLE_GITHUB_DEPLOYMENT == 'true' "
  + "&& vars.BRANCH_PROTECTION_ATTESTED == 'true'";
const CONTROL_PLANE_RUNTIME_BOUNDARY_NAME =
  "AgenticPlatform-ControlPlane-RuntimePermissionsBoundary";
const PLATFORM_PACKAGE_PATH = fileURLToPath(
  new URL("../package.json", import.meta.url),
);
const LEGACY_GITHUB_SETUP_PATH = fileURLToPath(
  new URL("../scripts/configure-github-delivery.mjs", import.meta.url),
);
const LEGACY_GITHUB_SETUP_TEST_PATH = fileURLToPath(
  new URL("../scripts/configure-github-delivery.test.mjs", import.meta.url),
);

function parseWorkflow(path, label) {
  const workflow = parse(readFileSync(path, "utf8"));
  assert.ok(workflow && typeof workflow === "object", `${label} must be YAML`);
  return workflow;
}

let cachedDeployWorkflow;
let cachedTriggerWorkflow;

function deployWorkflowFixture() {
  cachedDeployWorkflow ??= parseWorkflow(
    DEPLOY_WORKFLOW_PATH,
    "reusable deployment workflow",
  );
  return cachedDeployWorkflow;
}

function triggerWorkflowFixture() {
  cachedTriggerWorkflow ??= parseWorkflow(
    TRIGGER_WORKFLOW_PATH,
    "verification trigger workflow",
  );
  return cachedTriggerWorkflow;
}

function stepByName(job, name) {
  const step = job.steps.find((candidate) => candidate.name === name);
  assert.ok(step, `missing workflow step: ${name}`);
  return step;
}

function combinedRuns(job) {
  return job.steps
    .map((step) => step.run)
    .filter((run) => typeof run === "string")
    .join("\n");
}

function runCurrentMainVerification(step, {
  githubSha = "a".repeat(40),
  checkedOutSha = githubSha,
  remoteOutput = `${githubSha}\trefs/heads/main\n`,
  remoteStatus = 0,
} = {}) {
  const harness = `
git() {
  if [[ "$#" -eq 2 && "$1" == "rev-parse" && "$2" == "HEAD" ]]; then
    printf '%s\\n' "$CHECKED_OUT_SHA"
    return 0
  fi
  if [[ "$#" -eq 4 && "$1" == "ls-remote" && "$2" == "--exit-code" && "$3" == "origin" && "$4" == "refs/heads/main" ]]; then
    printf '%s' "$REMOTE_OUTPUT"
    return "$REMOTE_STATUS"
  fi
  printf 'unexpected git command: %s\\n' "$*" >&2
  return 97
}

${step.run}
`;
  return spawnSync("/bin/bash", [], {
    encoding: "utf8",
    input: harness,
    env: {
      ...process.env,
      CHECKED_OUT_SHA: checkedOutSha,
      GITHUB_SHA: githubSha,
      REMOTE_OUTPUT: remoteOutput,
      REMOTE_STATUS: String(remoteStatus),
    },
  });
}

test("trusted deployment path is reusable through workflow_call only", () => {
  const workflow = deployWorkflowFixture();

  assert.deepEqual(Object.keys(workflow.on), ["workflow_call"]);
  assert.equal(workflow.on.push, undefined);
  assert.equal(workflow.on.workflow_dispatch, undefined);
  assert.deepEqual(workflow.on.workflow_call, {});
  assert.deepEqual(Object.keys(workflow.jobs), ["deploy"]);
});

test("separate trigger verifies both branches and calls deployment only from an enabled protected main push", () => {
  const workflow = triggerWorkflowFixture();
  const trigger = workflow.on;

  assert.deepEqual(trigger.push.branches, [
    "main",
    "feat/serverless-aws-deployment",
  ]);
  assert.deepEqual(trigger.workflow_dispatch, {});
  for (const requiredPath of [
    "console/**",
    "e2e/**",
    "infra/platform-registry/**",
    "infra/serverless-platform/**",
    ".github/workflows/deploy-serverless-platform.yml",
    ".github/workflows/verify-serverless-platform.yml",
    "package.json",
    "package-lock.json",
  ]) {
    assert.ok(
      trigger.push.paths.includes(requiredPath),
      `push paths must include ${requiredPath}`,
    );
  }

  const verify = workflow.jobs.verify;
  const deploy = workflow.jobs.deploy;
  assert.ok(verify);
  assert.ok(deploy);
  assert.equal(deploy.needs, "verify");
  assert.equal(deploy.if, DEPLOYMENT_GATE);
  assert.equal(
    deploy.uses,
    "./.github/workflows/deploy-serverless-platform.yml",
  );
  assert.equal(deploy.secrets, undefined);
});

test("manual dispatch is verification-only because deployment requires a push event", () => {
  const workflow = triggerWorkflowFixture();

  assert.deepEqual(workflow.on.workflow_dispatch, {});
  assert.equal(workflow.jobs.verify.if, undefined);
  assert.equal(workflow.jobs.deploy.if, DEPLOYMENT_GATE);
  assert.match(workflow.jobs.deploy.if, /github\.event_name == 'push'/);
  assert.doesNotMatch(workflow.jobs.deploy.if, /workflow_dispatch/);
});

test("feature pushes have verification only and cannot receive OIDC permission", () => {
  const workflow = triggerWorkflowFixture();
  const verify = workflow.jobs.verify;
  const deploy = workflow.jobs.deploy;

  assert.equal(verify.if, undefined);
  assert.equal(verify.permissions, undefined);
  assert.doesNotMatch(JSON.stringify(verify), /id-token/);
  assert.match(deploy.if, /refs\/heads\/main/);
  assert.doesNotMatch(deploy.if, /feat\/serverless/);
});

test("OIDC permission exists only on the deployment call and called deploy job", () => {
  const triggerWorkflow = triggerWorkflowFixture();
  const deployWorkflow = deployWorkflowFixture();

  assert.deepEqual(triggerWorkflow.permissions, { contents: "read" });
  assert.deepEqual(triggerWorkflow.jobs.deploy.permissions, {
    contents: "read",
    "id-token": "write",
  });
  assert.deepEqual(deployWorkflow.permissions, { contents: "read" });
  assert.deepEqual(deployWorkflow.jobs.deploy.permissions, {
    contents: "read",
    "id-token": "write",
  });
  assert.equal(deployWorkflow.jobs.deploy.if, DEPLOYMENT_GATE);
  assert.match(deployWorkflow.jobs.deploy.if, /github\.ref_protected == true/);
});

test("deployment passes exact repository and trusted-workflow audit metadata", () => {
  const workflow = deployWorkflowFixture();

  assert.deepEqual(workflow.env, {
    AWS_ACCOUNT_ID: "${{ vars.AWS_ACCOUNT_ID }}",
    AWS_REGION: "${{ vars.AWS_REGION }}",
    ENABLE_GITHUB_DEPLOYMENT: "${{ vars.ENABLE_GITHUB_DEPLOYMENT }}",
    BRANCH_PROTECTION_ATTESTED:
      "${{ vars.BRANCH_PROTECTION_ATTESTED }}",
    GITHUB_DEPLOY_ROLE_NAME: "${{ vars.GITHUB_DEPLOY_ROLE_NAME }}",
    CFN_EXECUTION_ROLE_NAME: "${{ vars.CFN_EXECUTION_ROLE_NAME }}",
    COGNITO_DOMAIN_PREFIX: "${{ vars.COGNITO_DOMAIN_PREFIX }}",
    GITHUB_REPOSITORY_ID: "${{ github.repository_id }}",
    GITHUB_REPOSITORY_OWNER_ID: "${{ github.repository_owner_id }}",
    AUDITED_GITHUB_WORKFLOW_REF: DEPLOY_WORKFLOW_REFERENCE,
    GITHUB_OIDC_SUBJECT_MODE: "${{ vars.GITHUB_OIDC_SUBJECT_MODE }}",
    GITHUB_OIDC_SUBJECT: "${{ vars.GITHUB_OIDC_SUBJECT }}",
    CONTROL_PLANE_MODE: "${{ vars.CONTROL_PLANE_MODE }}",
    CONTROL_PLANE_SHARED_REGISTRY_ID:
      "${{ vars.CONTROL_PLANE_SHARED_REGISTRY_ID }}",
    CONTROL_PLANE_REGISTRY_PLATFORM_ID:
      "${{ vars.CONTROL_PLANE_REGISTRY_PLATFORM_ID }}",
    CONTROL_PLANE_REGISTRY_CUSTOMER_SUPPORT_ID:
      "${{ vars.CONTROL_PLANE_REGISTRY_CUSTOMER_SUPPORT_ID }}",
    CONTROL_PLANE_REGISTRY_OPERATIONS_ID:
      "${{ vars.CONTROL_PLANE_REGISTRY_OPERATIONS_ID }}",
    CONTROL_PLANE_LLM_GATEWAY_ID:
      "${{ vars.CONTROL_PLANE_LLM_GATEWAY_ID }}",
    CONTROL_PLANE_LLM_GATEWAY_REGION:
      "${{ vars.CONTROL_PLANE_LLM_GATEWAY_REGION }}",
    CONTROL_PLANE_TOOLS_GATEWAY_ID:
      "${{ vars.CONTROL_PLANE_TOOLS_GATEWAY_ID }}",
    STARTER_BUILDER_MODEL_ID:
      "${{ vars.STARTER_BUILDER_MODEL_ID }}",
    JOURNEY_GITHUB_OAUTH_CLIENT_ID:
      "${{ vars.JOURNEY_GITHUB_OAUTH_CLIENT_ID }}",
    JOURNEY_GITHUB_OAUTH_CLIENT_SECRET_ARN:
      "${{ vars.JOURNEY_GITHUB_OAUTH_CLIENT_SECRET_ARN }}",
  });
  assert.equal(
    workflow.env.AUDITED_GITHUB_WORKFLOW_REF,
    DEPLOY_WORKFLOW_REFERENCE,
  );
  assert.doesNotMatch(
    workflow.env.AUDITED_GITHUB_WORKFLOW_REF,
    /verify-serverless-platform/,
  );
});

test("verification installs, tests, builds, audits, and synthesizes control plane before web", () => {
  const verify = triggerWorkflowFixture().jobs.verify;
  const stepNames = verify.steps.map((step) => step.name);

  assert.equal(verify["runs-on"], "ubuntu-latest");
  assert.equal(stepByName(verify, "Checkout repository").with["fetch-depth"], 0,
    "Pinned rollback-reader tests need historical commits in the checkout");
  assert.equal(stepByName(verify, "Set up Node.js").with["node-version"], 22);

  const verifyRuns = combinedRuns(verify);
  assert.match(verifyRuns, /npm ci(?:\s|$)/);
  assert.match(
    verifyRuns,
    /npm (?:--prefix infra\/platform-registry ci|ci --prefix infra\/platform-registry)/,
  );
  assert.match(
    verifyRuns,
    /npm (?:--prefix infra\/serverless-platform ci|ci --prefix infra\/serverless-platform)/,
  );
  assert.match(verifyRuns, /npm test/);
  assert.match(verifyRuns, /npm --prefix infra\/platform-registry test/);
  assert.match(
    verifyRuns,
    /npm --prefix infra\/platform-registry run build/,
  );
  assert.match(verifyRuns, /npm --prefix infra\/serverless-platform test/);
  assert.match(
    verifyRuns,
    /npm --prefix infra\/serverless-platform run build/,
  );
  assert.equal(
    (verifyRuns.match(/npm audit --audit-level=high/g) ?? []).length,
    1,
  );
  assert.match(
    verifyRuns,
    /npm --prefix infra\/platform-registry audit --audit-level=high/,
  );
  assert.match(
    verifyRuns,
    /npm --prefix infra\/serverless-platform audit --audit-level=high/,
  );

  const controlPlaneSynth = stepByName(
    verify,
    "Synthesize control plane",
  );
  assert.equal(
    controlPlaneSynth["working-directory"],
    "infra/platform-registry",
  );
  assert.match(
    controlPlaneSynth.run,
    /cdk synth AgenticPlatform-ControlPlane-Provisioned/,
  );
  assert.match(controlPlaneSynth.run, /mode=provision/);
  assert.doesNotMatch(
    controlPlaneSynth.run,
    /runtimePermissionsBoundaryArn/,
  );
  assert.doesNotMatch(
    controlPlaneSynth.run,
    /sharedRegistryId|registryPlatformId|llmGatewayId|toolsGatewayId/,
  );
  const controlPlaneApp = readFileSync(CONTROL_PLANE_APP_PATH, "utf8");
  assert.match(
    controlPlaneApp,
    /const stackName =[\s\S]+config\.mode === "provision"[\s\S]+PROVISIONED_CONTROL_PLANE_STACK_NAME[\s\S]+CONTROL_PLANE_STACK_NAME/,
  );
  assert.match(
    controlPlaneApp,
    /new PlatformRegistryStack\(app, stackName,/,
  );

  const webSynth = stepByName(
    verify,
    "Synthesize web with CDK Nag",
  );
  assert.equal(
    webSynth["working-directory"],
    "infra/serverless-platform",
  );
  assert.match(webSynth.run, /cdk synth PlatformWebStack/);
  assert.match(
    webSynth.run,
    /llmGatewayId=agentic-platform-ci-abcdefghij/,
  );
  assert.match(webSynth.run, /llmGatewayRegion=us-west-2/);
  assert.match(verifyRuns, /cognitoDomainPrefix/);
  assert.doesNotMatch(verifyRuns, /featureBranch/);
  assert.match(verifyRuns, /SYNTH_ACCOUNT_ID/);
  assert.ok(
    stepNames.indexOf(controlPlaneSynth.name)
      < stepNames.indexOf(webSynth.name),
  );
});

test("verification runs the targeted secretless browser authentication fixture", () => {
  const workflow = triggerWorkflowFixture();
  const verify = workflow.jobs.verify;
  const checkout = stepByName(verify, "Checkout repository");
  const setupNode = stepByName(verify, "Set up Node.js");
  const install = stepByName(verify, "Install locked dependencies");
  const audit = stepByName(
    verify,
    "Audit high and critical dependency findings",
  );
  const browserInstall = stepByName(
    verify,
    "Install Chromium headless shell",
  );
  const synth = stepByName(verify, "Synthesize web with CDK Nag");
  const fixture = stepByName(
    verify,
    "Run targeted browser authentication fixture",
  );
  const stepNames = verify.steps.map((step) => step.name);
  const verifyRuns = combinedRuns(verify);
  const deployWorkflowText = readFileSync(DEPLOY_WORKFLOW_PATH, "utf8");

  assert.equal(checkout.with["persist-credentials"], false);
  assert.deepEqual(
    setupNode.with["cache-dependency-path"].trim().split(/\s+/),
    [
      "package-lock.json",
      "e2e/package-lock.json",
      "infra/platform-registry/package-lock.json",
      "infra/serverless-platform/package-lock.json",
    ],
  );
  assert.equal(
    install.run.trim(),
    [
      "set -euo pipefail",
      "npm ci",
      "npm --prefix e2e ci",
      "npm --prefix infra/platform-registry ci",
      "npm --prefix infra/serverless-platform ci",
    ].join("\n"),
  );
  assert.equal(
    audit.run.trim(),
    [
      "set -euo pipefail",
      "npm audit --audit-level=high",
      "npm --prefix e2e audit --audit-level=high",
      "npm --prefix infra/platform-registry audit --audit-level=high",
      "npm --prefix infra/serverless-platform audit --audit-level=high",
    ].join("\n"),
  );
  assert.equal(
    browserInstall.run.trim(),
    [
      "set -euo pipefail",
      "npm --prefix e2e exec -- playwright install --with-deps --only-shell chromium",
    ].join("\n"),
  );
  assert.equal(browserInstall["timeout-minutes"], 10);
  assert.equal(
    fixture.run.trim(),
    [
      "set -euo pipefail",
      "node --test e2e/smoke-auth-integration.mjs",
    ].join("\n"),
  );
  assert.equal(fixture["timeout-minutes"], 5);
  assert.ok(stepNames.indexOf(synth.name) < stepNames.indexOf(fixture.name));

  assert.deepEqual(workflow.permissions, { contents: "read" });
  assert.equal(verify.permissions, undefined);
  assert.equal(verify.secrets, undefined);
  assert.equal(verify.env, undefined);
  assert.equal(fixture.env, undefined);
  assert.doesNotMatch(JSON.stringify(verify), /id-token|secrets|COGNITO_DEMO_USER_PASSWORDS_JSON/);

  assert.doesNotMatch(verifyRuns, /e2e\/run-all\.mjs/);
  assert.doesNotMatch(verifyRuns, /npm --prefix e2e test/);
  assert.doesNotMatch(verifyRuns, /npm --prefix e2e run e2e/);
  assert.doesNotMatch(JSON.stringify(verify.steps), /actions\/cache@/);
  assert.doesNotMatch(JSON.stringify(verify.steps), /PLAYWRIGHT_BROWSERS_PATH/);

  assert.match(
    deployWorkflowText,
    /npm --prefix e2e exec -- playwright install --with-deps --only-shell chromium/,
  );
  assert.match(
    deployWorkflowText,
    /node e2e\/hosted-control-plane-acceptance\.mjs/,
  );
  assert.doesNotMatch(
    deployWorkflowText,
    /smoke-auth-integration|e2e\/run-all|npm --prefix e2e test/i,
  );
});

test("main verification installs pytest before executing exported evaluation tests", () => {
  const verify = triggerWorkflowFixture().jobs.verify;
  const names = verify.steps.map((step) => step.name);
  const setup = stepByName(verify, "Set up Python for exported evaluation tests");
  const install = stepByName(verify, "Install exported evaluation test dependency");
  assert.match(setup.uses, /^actions\/setup-python@[a-f0-9]{40}$/);
  assert.equal(setup.with["python-version"], "3.12");
  assert.equal(install.run, 'python -m pip install "pytest>=8,<9"');
  assert.ok(names.indexOf(setup.name) < names.indexOf(install.name));
  assert.ok(names.indexOf(install.name) < names.indexOf("Run tests and TypeScript build"));
});

test("verification and protected-main deployment share one account-region concurrency group", () => {
  const workflow = triggerWorkflowFixture();

  assert.equal(
    workflow.concurrency.group,
    "deploy-agentic-platform-web-${{ vars.AWS_ACCOUNT_ID }}-${{ vars.AWS_REGION }}",
  );
  assert.doesNotMatch(workflow.concurrency.group, /github\.ref/);
  assert.equal(workflow.concurrency["cancel-in-progress"], false);
  assert.equal(deployWorkflowFixture().concurrency, undefined);
});

test("control-plane and web diff and deploy use the execution role from their infrastructure directories", () => {
  const deploy = deployWorkflowFixture().jobs.deploy;
  const expectations = [
    [
      "Review control-plane changes",
      "diff",
      "infra/platform-registry",
      /\$CONTROL_PLANE_STACK_NAME/,
    ],
    [
      "Deploy control-plane stack",
      "deploy",
      "infra/platform-registry",
      /\$CONTROL_PLANE_STACK_NAME/,
    ],
    [
      "Review web changes",
      "diff",
      "infra/serverless-platform",
      /PlatformWebStack/,
    ],
    [
      "Deploy PlatformWebStack",
      "deploy",
      "infra/serverless-platform",
      /PlatformWebStack/,
    ],
  ];

  for (const [stepName, command, workingDirectory, stackPattern] of expectations) {
    const step = stepByName(deploy, stepName);
    assert.equal(step["working-directory"], workingDirectory);
    assert.match(
      step.run,
      new RegExp(`npm exec -- cdk ${command}`),
    );
    assert.match(step.run, stackPattern);
    assert.match(step.run, /--role-arn "\$CFN_EXECUTION_ROLE_ARN"/);
  }

  assert.match(
    stepByName(deploy, "Deploy control-plane stack").run,
    /--outputs-file control-plane-outputs\.json/,
  );
  assert.match(
    stepByName(deploy, "Deploy PlatformWebStack").run,
    /--outputs-file deployment-outputs\.json/,
  );
});

test("deploy runs the same named audit directly before every diff and deploy", () => {
  const deploy = deployWorkflowFixture().jobs.deploy;
  const stepNames = deploy.steps.map((step) => step.name);
  const verificationIndex = stepNames.indexOf(
    "Verify AWS caller and CDK bootstrap",
  );
  const placements = [
    [
      "Run security audit before control-plane diff",
      "Review control-plane changes",
    ],
    [
      "Run security audit before control-plane deploy",
      "Deploy control-plane stack",
    ],
    [
      "Run security audit before web diff",
      "Review web changes",
    ],
    [
      "Run security audit before web deploy",
      "Deploy PlatformWebStack",
    ],
  ];

  assert.notEqual(verificationIndex, -1);
  for (const [auditName, guardedStepName] of placements) {
    const guardedStepIndex = stepNames.indexOf(guardedStepName);
    const auditIndex = stepNames.indexOf(auditName);
    assert.notEqual(auditIndex, -1, `missing workflow step ${auditName}`);
    assert.notEqual(
      guardedStepIndex,
      -1,
      `missing workflow step ${guardedStepName}`,
    );
    assert.equal(
      auditIndex + 1,
      guardedStepIndex,
      `${auditName} must run directly before ${stepNames[guardedStepIndex]}`,
    );
    assert.ok(verificationIndex < auditIndex);

    const audit = stepByName(deploy, auditName);
    assert.equal(audit["working-directory"], "infra/serverless-platform");
    assert.match(audit.run, /^set -euo pipefail$/m);
    assert.match(
      audit.run,
      /^GITHUB_WORKFLOW_REF="\$AUDITED_GITHUB_WORKFLOW_REF" \\$/m,
    );
    assert.match(
      audit.run,
      /^\s+SECURITY_AUDIT_MODE=deploy npm run security:audit$/m,
    );
  }
});

test("deploy runs the strict target-state audit immediately after PlatformWebStack deployment", () => {
  const deploy = deployWorkflowFixture().jobs.deploy;
  const stepNames = deploy.steps.map((step) => step.name);
  const deployIndex = stepNames.indexOf("Deploy PlatformWebStack");
  const auditIndex = stepNames.indexOf(
    "Validate security target after web deploy",
  );
  const outputsIndex = stepNames.indexOf("Parse deployment outputs");

  assert.notEqual(deployIndex, -1);
  assert.equal(auditIndex, deployIndex + 1);
  assert.equal(outputsIndex, auditIndex + 1);

  const audit = stepByName(
    deploy,
    "Validate security target after web deploy",
  );
  assert.equal(audit["working-directory"], "infra/serverless-platform");
  assert.equal(audit.env.SECURITY_AUDIT_WEB_TEMPLATE, "cdk.out/PlatformWebStack.template.json");
  assert.match(audit.run, /^set -euo pipefail$/m);
  assert.match(
    audit.run,
    /^GITHUB_WORKFLOW_REF="\$AUDITED_GITHUB_WORKFLOW_REF" \\$/m,
  );
  assert.match(
    audit.run,
    /^\s+SECURITY_AUDIT_MODE=postdeploy npm run security:audit$/m,
  );
});

test("deployment selects one physical control-plane stack with a safely quoted context array", () => {
  const deploy = deployWorkflowFixture().jobs.deploy;
  const validation = stepByName(
    deploy,
    "Validate deployment configuration",
  ).run;

  assert.match(validation, /CONTROL_PLANE_MODE/);
  assert.match(validation, /reference-existing/);
  assert.match(validation, /provision/);
  assert.match(validation, /AgenticPlatform-ControlPlane/);
  assert.match(validation, /AgenticPlatform-ControlPlane-Provisioned/);
  for (const variableName of [
    "CONTROL_PLANE_SHARED_REGISTRY_ID",
    "CONTROL_PLANE_REGISTRY_PLATFORM_ID",
    "CONTROL_PLANE_REGISTRY_CUSTOMER_SUPPORT_ID",
    "CONTROL_PLANE_REGISTRY_OPERATIONS_ID",
    "CONTROL_PLANE_LLM_GATEWAY_ID",
    "CONTROL_PLANE_LLM_GATEWAY_REGION",
    "CONTROL_PLANE_TOOLS_GATEWAY_ID",
  ]) {
    assert.match(validation, new RegExp(variableName));
  }
  assert.match(
    validation,
    /reference-existing[\s\S]+required/i,
  );
  assert.match(
    validation,
    /provision[\s\S]+must be empty/i,
  );

  for (const stepName of [
    "Review control-plane changes",
    "Deploy control-plane stack",
  ]) {
    const run = stepByName(deploy, stepName).run;
    assert.match(run, /CONTROL_PLANE_CONTEXT=\(/);
    assert.match(run, /"\$\{CONTROL_PLANE_CONTEXT\[@\]\}"/);
    assert.match(run, /mode=\$CONTROL_PLANE_MODE/);
    assert.match(run, /account=\$AWS_ACCOUNT_ID/);
    assert.match(run, /region=\$AWS_REGION/);
    assert.match(
      run,
      /llmGatewayRegion=\$CONTROL_PLANE_LLM_GATEWAY_REGION/,
    );
    assert.doesNotMatch(run, /\beval\b|\bxargs\b/);
    assert.doesNotMatch(run, /\$CONTROL_PLANE_CONTEXT(?:\s|$)/);
  }
});

test("web deployment passes the protected deployment contexts", () => {
  const deploy = deployWorkflowFixture().jobs.deploy;
  for (const stepName of [
    "Review web changes",
    "Deploy PlatformWebStack",
  ]) {
    const run = stepByName(deploy, stepName).run;
    assert.match(
      run,
      /starterBuilderModelId=\$STARTER_BUILDER_MODEL_ID/,
    );
    assert.match(
      run,
      /llmGatewayId=\$CONTROL_PLANE_LLM_GATEWAY_ID/,
    );
    assert.match(
      run,
      /llmGatewayRegion=\$CONTROL_PLANE_LLM_GATEWAY_REGION/,
    );
    assert.match(run, /JOURNEY_GITHUB_OAUTH_CONTEXT=\(/);
    assert.match(
      run,
      /githubOAuthClientId=\$JOURNEY_GITHUB_OAUTH_CLIENT_ID/,
    );
    assert.match(
      run,
      /githubOAuthClientSecretArn=\$JOURNEY_GITHUB_OAUTH_CLIENT_SECRET_ARN/,
    );
    assert.match(
      run,
      /"\$\{JOURNEY_GITHUB_OAUTH_CONTEXT\[@\]\}"/,
    );
  }
});

test("deployment no longer exposes reusable GitHub user-token setup", () => {
  const workflowText = readFileSync(DEPLOY_WORKFLOW_PATH, "utf8");
  const packageJson = JSON.parse(readFileSync(PLATFORM_PACKAGE_PATH, "utf8"));

  assert.doesNotMatch(
    workflowText,
    /JOURNEY_GITHUB_OWNER|JOURNEY_GITHUB_CREDENTIAL_SECRET_ARN/,
  );
  assert.equal(
    Object.hasOwn(packageJson.scripts, "configure:github-delivery"),
    false,
  );
  assert.equal(existsSync(LEGACY_GITHUB_SETUP_PATH), false);
  assert.equal(existsSync(LEGACY_GITHUB_SETUP_TEST_PATH), false);
});

test("provision deployment has no external runtime boundary input", () => {
  const deploy = deployWorkflowFixture().jobs.deploy;
  const validation = stepByName(
    deploy,
    "Validate deployment configuration",
  ).run;

  assert.doesNotMatch(
    validation,
    /CONTROL_PLANE_RUNTIME_PERMISSIONS_BOUNDARY_ARN/,
  );
  assert.doesNotMatch(
    JSON.stringify(deployWorkflowFixture().env),
    /CONTROL_PLANE_RUNTIME_PERMISSIONS_BOUNDARY_ARN/,
  );

  for (const stepName of [
    "Review control-plane changes",
    "Deploy control-plane stack",
  ]) {
    const run = stepByName(deploy, stepName).run;
    assert.doesNotMatch(run, /runtimePermissionsBoundaryArn/);
    assert.match(
      run,
      /if \[\[ "\$CONTROL_PLANE_MODE" == "reference-existing" \]\]; then[\s\S]+sharedRegistryId=/,
    );
  }
});

test("root clean-account command deploys control plane before web using generated Gateway outputs", async () => {
  assert.equal(
    existsSync(CLEAN_ACCOUNT_DEPLOY_PATH),
    true,
    "clean-account deployment script must exist",
  );
  const rootPackage = JSON.parse(readFileSync(ROOT_PACKAGE_PATH, "utf8"));
  assert.equal(
    rootPackage.scripts["platform:deploy:clean-account"],
    "node scripts/deploy-clean-account.mjs",
  );

  const { buildCleanAccountDeploymentPlan } =
    await import(CLEAN_ACCOUNT_DEPLOY_PATH);
  const plan = buildCleanAccountDeploymentPlan({
    account: "111122223333",
    region: "us-west-2",
    cognitoDomainPrefix: "customer-agentic-platform",
    starterBuilderModelId:
      "bedrock-claude/anthropic.claude-haiku-4-5",
    controlPlaneOutputs: {
      LlmGatewayId: "agentic-demo-llm-gateway-abcdefghij",
      LlmGatewayRegion: "us-west-2",
    },
  });

  assert.deepEqual(
    plan.map((step) => step.name),
    ["control-plane", "web", "domain-bootstrap"],
  );
  assert.doesNotMatch(
    plan[0].args.join(" "),
    /runtimePermissionsBoundaryArn/,
  );
  assert.match(
    plan[1].args.join(" "),
    /llmGatewayId=agentic-demo-llm-gateway-abcdefghij/,
  );
  assert.match(
    plan[1].args.join(" "),
    /llmGatewayRegion=us-west-2/,
  );
  // The domain-create wizard's routes live in the companion stack; a
  // clean-account deploy that stops at web ships a broken Domains page.
  assert.match(
    plan[2].args.join(" "),
    /bin\/domain-bootstrap\.ts/,
  );
  assert.equal(plan[2].env.AWS_ACCOUNT_ID, "111122223333");
  assert.equal(
    typeof plan[2].env.DOMAIN_BOOTSTRAP_TARGET_FILE,
    "string",
  );
});

test("deployment validates control-plane exports and project tags after ordered deploys", () => {
  const deploy = deployWorkflowFixture().jobs.deploy;
  const stepNames = deploy.steps.map((step) => step.name);
  const controlPlaneDeployIndex = stepNames.indexOf(
    "Deploy control-plane stack",
  );
  const controlPlaneValidationIndex = stepNames.indexOf(
    "Validate control-plane outputs and tags",
  );
  const webDiffIndex = stepNames.indexOf("Review web changes");
  const webDeployIndex = stepNames.indexOf("Deploy PlatformWebStack");
  const tagValidationIndex = stepNames.indexOf(
    "Validate deployed project tags",
  );
  const smokeIndex = stepNames.indexOf("Smoke test deployed application");
  const acceptanceIndex = stepNames.indexOf(
    "Run hosted control-plane acceptance",
  );
  const summaryIndex = stepNames.indexOf("Publish deployment summary");

  assert.ok(controlPlaneDeployIndex < controlPlaneValidationIndex);
  assert.ok(controlPlaneValidationIndex < webDiffIndex);
  assert.ok(webDiffIndex < webDeployIndex);
  assert.ok(webDeployIndex < tagValidationIndex);
  assert.ok(tagValidationIndex < smokeIndex);
  assert.ok(smokeIndex < acceptanceIndex);
  assert.ok(acceptanceIndex < summaryIndex);

  const outputs = stepByName(
    deploy,
    "Validate control-plane outputs and tags",
  ).run;
  assert.match(outputs, /cloudformation describe-stacks/);
  assert.match(outputs, /ExportName/);
  assert.match(outputs, /AgenticPlatform-ControlPlane-SharedRegistryId/);
  assert.match(outputs, /AgenticPlatform-ControlPlane-ToolsGatewayId/);
  assert.match(outputs, /reference-existing/);
  assert.match(outputs, /auto-delete/);
  assert.match(outputs, /managedBy/);
  assert.match(outputs, /project/);

  const tags = stepByName(
    deploy,
    "Validate deployed project tags",
  ).run;
  assert.match(
    tags,
    /node scripts\/validate-deployed-tags\.mjs/,
  );
  assert.match(
    tags,
    /--stack "\$CONTROL_PLANE_STACK_NAME"/,
  );
  assert.match(tags, /--stack "AgenticPlatform-Web"/);
  assert.match(tags, /--account-id "\$AWS_ACCOUNT_ID"/);
  assert.match(tags, /--region "\$AWS_REGION"/);
  assert.doesNotMatch(tags, /--tag-filters|Key=project/);
});

test("deployment retains validation, output parsing, and smoke contracts", () => {
  const deploy = deployWorkflowFixture().jobs.deploy;
  assert.equal(deploy["timeout-minutes"], 90);
  assert.equal(deploy["runs-on"], "ubuntu-latest");
  const setupNode = stepByName(deploy, "Set up Node.js");
  assert.equal(setupNode.with["node-version"], 22);
  assert.deepEqual(
    setupNode.with["cache-dependency-path"].trim().split(/\s+/),
    [
      "package-lock.json",
      "e2e/package-lock.json",
      "infra/platform-registry/package-lock.json",
      "infra/serverless-platform/package-lock.json",
    ],
  );
  assert.equal(
    stepByName(deploy, "Install locked deployment dependencies").run.trim(),
    [
      "set -euo pipefail",
      "npm ci",
      "npm --prefix e2e ci",
      "npm --prefix infra/platform-registry ci",
      "npm --prefix infra/serverless-platform ci",
    ].join("\n"),
  );
  const browserInstall = stepByName(
    deploy,
    "Install Chromium headless shell",
  );
  assert.equal(
    browserInstall.run.trim(),
    [
      "set -euo pipefail",
      "npm --prefix e2e exec -- playwright install --with-deps --only-shell chromium",
    ].join("\n"),
  );
  assert.equal(browserInstall["timeout-minutes"], 10);

  const validation = stepByName(
    deploy,
    "Validate deployment configuration",
  ).run;
  assert.match(validation, /\^\[0-9\]\{12\}\$/);
  assert.match(validation, /\$AWS_REGION" == "us-west-2"/);
  assert.match(
    validation,
    /\$GITHUB_DEPLOY_ROLE_NAME" == "AgenticPlatformGitHubDeployRole"/,
  );
  assert.match(
    validation,
    /\$CFN_EXECUTION_ROLE_NAME" == "AgenticPlatformCloudFormationExecutionRole"/,
  );
  assert.match(validation, /COGNITO_DOMAIN_PREFIX/);
  assert.match(validation, /\$ENABLE_GITHUB_DEPLOYMENT" == "true"/);
  assert.match(validation, /\$BRANCH_PROTECTION_ATTESTED" == "true"/);
  assert.match(validation, /CONTROL_PLANE_MODE/);

  const configureCredentials = stepByName(
    deploy,
    "Configure AWS credentials with GitHub OIDC",
  );
  assert.match(
    configureCredentials.uses,
    /^aws-actions\/configure-aws-credentials@[0-9a-f]{40}$/,
  );
  assert.match(
    configureCredentials.with["role-to-assume"],
    /GITHUB_DEPLOY_ROLE_NAME/,
  );
  assert.match(configureCredentials.with["aws-region"], /AWS_REGION/);

  const deployRuns = combinedRuns(deploy);
  assert.match(deployRuns, /aws sts get-caller-identity/);
  assert.match(deployRuns, /\/cdk-bootstrap\/hnb659fds\/version/);
  assert.match(deployRuns, /npm run security:audit/);
  assert.match(deployRuns, /--outputs-file deployment-outputs\.json/);
  assert.match(deployRuns, /--outputs-file control-plane-outputs\.json/);
  assert.doesNotMatch(deployRuns, /featureBranch/);

  const outputs = stepByName(deploy, "Parse deployment outputs");
  assert.equal(outputs.id, "deployment-outputs");
  assert.match(outputs.run, /JSON\.parse/);
  assert.match(outputs.run, /ApplicationUrl/);
  assert.match(outputs.run, /UserPoolId/);
  assert.match(outputs.run, /UserPoolClientId/);
  assert.match(outputs.run, /user_pool_client_id/);
  assert.doesNotMatch(outputs.run, /\beval\b|\bsource\b/);

  const stepNames = deploy.steps.map((step) => step.name);
  assert.equal(
    stepNames.includes("Validate Cognito demo-user seed configuration"),
    false,
  );
  assert.equal(stepNames.includes("Seed Cognito demo users"), false);
  assert.doesNotMatch(
    JSON.stringify(deploy),
    /COGNITO_DEMO_USERS_JSON|COGNITO_DEMO_USER_PASSWORDS_JSON/,
  );

  const smoke = stepByName(deploy, "Smoke test deployed application");
  assert.match(smoke.run, /\/api\/health/);
  assert.match(smoke.run, /\/api\/me/);
  assert.match(smoke.run, /401/);
  assert.doesNotMatch(smoke.run, /NOT_AUTHENTICATED|me\.code/);

  const assumeAcceptanceRole = stepByName(
    deploy,
    "Assume hosted acceptance role",
  );
  assert.match(
    assumeAcceptanceRole.uses,
    /^aws-actions\/configure-aws-credentials@[0-9a-f]{40}$/,
  );
  assert.equal(
    assumeAcceptanceRole.with["role-to-assume"],
    "arn:aws:iam::${{ env.AWS_ACCOUNT_ID }}:"
      + "role/AgenticPlatform-Web-HostedAcceptanceRole",
  );
  assert.equal(assumeAcceptanceRole.with["aws-region"], "${{ env.AWS_REGION }}");
  assert.equal(assumeAcceptanceRole.with["role-chaining"], true);
  assert.equal(assumeAcceptanceRole.with["role-duration-seconds"], 3600);
  assert.equal(
    stepNames.indexOf("Assume hosted acceptance role") + 1,
    stepNames.indexOf("Run hosted control-plane acceptance"),
  );
  assert.ok(
    stepNames.indexOf("Smoke test deployed application")
      < stepNames.indexOf("Assume hosted acceptance role"),
  );
  assert.ok(
    stepNames.indexOf("Validate deployed project tags")
      < stepNames.indexOf("Assume hosted acceptance role"),
  );
  const chainedSteps = deploy.steps.slice(
    stepNames.indexOf("Assume hosted acceptance role"),
    stepNames.indexOf("Run hosted control-plane acceptance") + 1,
  );
  assert.equal(
    chainedSteps.filter((step) =>
      String(step.uses ?? "").startsWith(
        "aws-actions/configure-aws-credentials@",
      )
    ).length,
    1,
  );

  const acceptance = stepByName(
    deploy,
    "Run hosted control-plane acceptance",
  );
  assert.equal(acceptance["working-directory"], undefined);
  assert.deepEqual(acceptance.env, {
    APPLICATION_URL:
      "${{ steps.deployment-outputs.outputs.application_url }}",
    COGNITO_USER_POOL_ID:
      "${{ steps.deployment-outputs.outputs.user_pool_id }}",
    COGNITO_USER_POOL_CLIENT_ID:
      "${{ steps.deployment-outputs.outputs.user_pool_client_id }}",
    HOSTED_ACCEPTANCE_RUN_ID: "${{ github.run_id }}",
    HOSTED_ACCEPTANCE_RUN_ATTEMPT: "${{ github.run_attempt }}",
    AWS_REGION: "${{ env.AWS_REGION }}",
  });
  assert.equal(
    acceptance.run.trim(),
    [
      "set -euo pipefail",
      "node e2e/hosted-control-plane-acceptance.mjs",
    ].join("\n"),
  );
  assert.equal(acceptance["timeout-minutes"], 20);
  assert.ok(
    acceptance["timeout-minutes"]
      < assumeAcceptanceRole.with["role-duration-seconds"] / 60,
  );
  assert.ok(acceptance["timeout-minutes"] < deploy["timeout-minutes"]);
  assert.doesNotMatch(
    `${acceptance.run}\n${JSON.stringify(acceptance.env)}`,
    /password|access[_-]?token|id[_-]?token|authenticationresult/i,
  );

  const reacquire = stepByName(
    deploy,
    "Reacquire GitHub deploy role for verifier cleanup",
  );
  const assumeCleanup = stepByName(
    deploy,
    "Assume hosted acceptance role for verifier cleanup",
  );
  const cleanup = stepByName(
    deploy,
    "Delete hosted acceptance verifier users",
  );
  for (const step of [reacquire, assumeCleanup, cleanup]) {
    assert.equal(step.if, "always()");
  }
  assert.equal(
    reacquire.with["role-to-assume"],
    "arn:aws:iam::${{ env.AWS_ACCOUNT_ID }}:"
      + "role/${{ env.GITHUB_DEPLOY_ROLE_NAME }}",
  );
  assert.equal(reacquire.with["role-duration-seconds"], 3600);
  assert.equal(
    assumeCleanup.with["role-to-assume"],
    "arn:aws:iam::${{ env.AWS_ACCOUNT_ID }}:"
      + "role/AgenticPlatform-Web-HostedAcceptanceRole",
  );
  assert.equal(assumeCleanup.with["role-chaining"], true);
  assert.equal(assumeCleanup.with["role-duration-seconds"], 3600);
  assert.equal(cleanup["timeout-minutes"], 20);
  assert.ok(
    cleanup["timeout-minutes"]
      < assumeCleanup.with["role-duration-seconds"] / 60,
  );
  assert.deepEqual(cleanup.env, {
    COGNITO_USER_POOL_ID:
      "${{ steps.deployment-outputs.outputs.user_pool_id }}",
    HOSTED_ACCEPTANCE_RUN_ID: "${{ github.run_id }}",
    HOSTED_ACCEPTANCE_RUN_ATTEMPT: "${{ github.run_attempt }}",
    AWS_REGION: "${{ env.AWS_REGION }}",
  });
  assert.equal(
    cleanup.run.trim(),
    [
      "set -euo pipefail",
      "node e2e/hosted-control-plane-acceptance.mjs --cleanup-only",
    ].join("\n"),
  );
  assert.doesNotMatch(
    JSON.stringify([reacquire, assumeCleanup, cleanup]),
    /password|access[_-]?token|id[_-]?token|authenticationresult/i,
  );
  assert.equal(
    stepNames.indexOf("Run hosted control-plane acceptance") + 1,
    stepNames.indexOf("Reacquire GitHub deploy role for verifier cleanup"),
  );
  assert.equal(
    stepNames.indexOf("Reacquire GitHub deploy role for verifier cleanup") + 1,
    stepNames.indexOf("Assume hosted acceptance role for verifier cleanup"),
  );
  assert.equal(
    stepNames.indexOf("Assume hosted acceptance role for verifier cleanup") + 1,
    stepNames.indexOf("Delete hosted acceptance verifier users"),
  );
  assert.ok(
    stepNames.indexOf("Delete hosted acceptance verifier users")
      < stepNames.indexOf("Publish deployment summary"),
  );

  const summary = stepByName(deploy, "Publish deployment summary");
  assert.doesNotMatch(
    summary.run,
    /password|access[_-]?token|id[_-]?token|user_pool_client_id/i,
  );
  assert.match(combinedRuns(deploy), /GITHUB_STEP_SUMMARY/);
});

test("current main head is verified immediately after checkout and before OIDC", () => {
  const deploy = deployWorkflowFixture().jobs.deploy;
  const stepNames = deploy.steps.map((step) => step.name);
  const checkoutIndex = stepNames.indexOf("Checkout repository");
  const currentMainIndex = stepNames.indexOf(
    "Verify checked commit is current main head",
  );
  const oidcIndex = stepNames.indexOf(
    "Configure AWS credentials with GitHub OIDC",
  );

  assert.notEqual(checkoutIndex, -1);
  assert.equal(currentMainIndex, checkoutIndex + 1);
  assert.ok(currentMainIndex < oidcIndex);
  assert.equal(
    stepByName(deploy, "Checkout repository").with["persist-credentials"],
    false,
  );

  const verification = stepByName(
    deploy,
    "Verify checked commit is current main head",
  );
  assert.match(verification.run, /git rev-parse HEAD/);
  assert.match(
    verification.run,
    /git ls-remote --exit-code origin refs\/heads\/main/,
  );
  assert.match(verification.run, /GITHUB_SHA/);
  assert.match(verification.run, /\^\[0-9a-f\]\{40\}\$/);
  assert.match(verification.run, /refs\/heads\/main/);
});

test("current main head verification succeeds only for one exact matching remote ref", () => {
  const verification = stepByName(
    deployWorkflowFixture().jobs.deploy,
    "Verify checked commit is current main head",
  );
  const result = runCurrentMainVerification(verification);

  assert.equal(
    result.status,
    0,
    `expected current main verification to pass:\n${result.stderr}${result.stdout}`,
  );
});

test("current main head verification fails closed on stale or malformed state", () => {
  const verification = stepByName(
    deployWorkflowFixture().jobs.deploy,
    "Verify checked commit is current main head",
  );
  const githubSha = "a".repeat(40);
  const otherSha = "b".repeat(40);
  const cases = [
    {
      label: "missing remote main",
      options: { remoteOutput: "", remoteStatus: 2 },
    },
    {
      label: "multiple remote main results",
      options: {
        remoteOutput:
          `${githubSha}\trefs/heads/main\n`
          + `${githubSha}\trefs/heads/main\n`,
      },
    },
    {
      label: "malformed remote SHA",
      options: { remoteOutput: `not-a-sha\trefs/heads/main\n` },
    },
    {
      label: "wrong remote ref",
      options: { remoteOutput: `${githubSha}\trefs/heads/not-main\n` },
    },
    {
      label: "remote main mismatch",
      options: { remoteOutput: `${otherSha}\trefs/heads/main\n` },
    },
    {
      label: "checked out commit mismatch",
      options: { checkedOutSha: otherSha },
    },
  ];

  for (const { label, options } of cases) {
    const result = runCurrentMainVerification(verification, options);
    assert.notEqual(
      result.status,
      0,
      `${label} must fail closed:\n${result.stderr}${result.stdout}`,
    );
  }
});

test("unauthenticated identity smoke retries transient failures up to a bound", () => {
  const smoke = stepByName(
    deployWorkflowFixture().jobs.deploy,
    "Smoke test deployed application",
  );
  const identityRetry = smoke.run.slice(smoke.run.indexOf('ME_STATUS=""'));

  assert.match(identityRetry, /^ME_STATUS=""/);
  assert.match(identityRetry, /for attempt in \{1\.\.12\}; do/);
  assert.match(identityRetry, /curl[\s\S]+\/api\/me[\s\S]+\|\| true/);
  assert.match(
    identityRetry,
    /if \[\[ "\$ME_STATUS" == "401" \]\]; then[\s\S]+break/,
  );
  assert.match(identityRetry, /\(\( attempt < 12 \)\)[\s\S]+sleep 10/);
  assert.match(
    identityRetry,
    /\[\[ "\$ME_STATUS" == "401" \]\] \|\| \{/,
  );
});

test("all external actions are approved and pinned while the local call uses the exact trusted path", () => {
  const deploySource = readFileSync(DEPLOY_WORKFLOW_PATH, "utf8");
  const triggerSource = readFileSync(TRIGGER_WORKFLOW_PATH, "utf8");
  const deploy = deployWorkflowFixture().jobs.deploy;
  const verify = triggerWorkflowFixture().jobs.verify;
  const actionReferences = [...verify.steps, ...deploy.steps]
    .flatMap((step) => (typeof step.uses === "string" ? [step.uses] : []));
  const approvedActionRepositories = new Set([
    "actions/checkout",
    "actions/setup-node",
    "actions/setup-python",
    "aws-actions/configure-aws-credentials",
  ]);
  const usedActionRepositories = new Set();

  assert.ok(actionReferences.length >= 5);
  for (const actionReference of actionReferences) {
    const match = actionReference.match(/^([^@]+)@[0-9a-f]{40}$/);
    assert.ok(match, `${actionReference} must use a full commit SHA`);
    assert.ok(
      approvedActionRepositories.has(match[1]),
      `${match[1]} is not an approved action repository`,
    );
    usedActionRepositories.add(match[1]);
  }
  assert.deepEqual(usedActionRepositories, approvedActionRepositories);

  for (
    const line of `${deploySource}\n${triggerSource}`
      .split("\n")
      .filter((line) =>
        line.includes("uses:") && !line.includes("uses: ./")
      )
  ) {
    assert.match(line, /# v[0-9]+(?:\.[0-9]+){0,2}\s*$/);
  }

  assert.match(
    triggerSource,
    /uses: \.\/\.github\/workflows\/deploy-serverless-platform\.yml/,
  );
  assert.doesNotMatch(
    `${deploySource}\n${triggerSource}`,
    /AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY/,
  );
  assert.doesNotMatch(`${deploySource}\n${triggerSource}`, /\b\d{12}\b/);
});

test("deployment uses Node 22 and locked root, e2e, control-plane, and web installs", () => {
  const deploy = deployWorkflowFixture().jobs.deploy;
  const setupNode = stepByName(deploy, "Set up Node.js");
  const install = stepByName(
    deploy,
    "Install locked deployment dependencies",
  );

  assert.equal(setupNode.with["node-version"], 22);
  assert.deepEqual(
    setupNode.with["cache-dependency-path"].trim().split(/\s+/),
    [
      "package-lock.json",
      "e2e/package-lock.json",
      "infra/platform-registry/package-lock.json",
      "infra/serverless-platform/package-lock.json",
    ],
  );
  assert.equal(
    install.run.trim(),
    [
      "set -euo pipefail",
      "npm ci",
      "npm --prefix e2e ci",
      "npm --prefix infra/platform-registry ci",
      "npm --prefix infra/serverless-platform ci",
    ].join("\n"),
  );
});
