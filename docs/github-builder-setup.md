# Connect Builder export to GitHub

Builder exports a reviewed development repository. This integration creates a
private repository through the builder's GitHub authorization. It does not deploy
an Agent or enable the platform's separate GitHub-to-AWS deployment role.

## Export with your GitHub account

The default installation supports a caller-owned classic GitHub token with
`repo` and `workflow` permissions. Review the files, confirm the private repository
name, enter the token and select **Export to GitHub**. The token exists only in
the export request; it is not saved in the browser's draft store, DynamoDB,
Secrets Manager or exported files. It is not revoked automatically because it
belongs to the user. The user can revoke it in GitHub after export.

New repositories receive the complete reviewed source directly on `main`.
The name defaults to the Agent name entered during Compose, independently of
the owning Project name. Subsequent development uses local branches, PRs and CI.
Older partially delivered PR-based exports retain their recovery path.

## Optional browser OAuth installation

1. Read the existing Web stack outputs `ApplicationUrl` and `HttpApiUrl`.
   Create a dedicated GitHub **OAuth App** at
   https://github.com/settings/applications/new.
   Set Homepage URL to `ApplicationUrl` and Authorization callback URL to
   `HttpApiUrl` followed by `/oauth/github/callback`. Do not use an AgentCore
   Identity callback or reuse an OAuth App belonging to another application.
2. Save its secret in the deployment account's regional Secrets Manager as
   exactly `{"clientSecret":"<the OAuth App client secret>"}`. The secret value
   must not enter Git, CDK context, workflow variables, logs or chat.
3. Keep the existing deployment's reviewed configuration and add CDK contexts
   `githubOAuthClientId` and `githubOAuthClientSecretArn`. Supply the corresponding
   `JOURNEY_GITHUB_OAUTH_CLIENT_ID` and `JOURNEY_GITHUB_OAUTH_CLIENT_SECRET_ARN`
   values to the security audit. These are identifiers, not the secret.
   The existing deployment workflow supports these repository variables.
4. Follow the Web runbook's caller verification, predeployment audit, diff,
   deployment and postdeployment audit. The change grants Journey Lambda read
   access to this exact secret. Do not enable `ENABLE_GITHUB_DEPLOYMENT` merely
   to enable repository export.
5. Sign in to Console. `GET /api/delivery/github` should report
   `github.configured: true`. This proves
   OAuth configuration presence only; complete browser authorization to verify
   the secret and callback. `github.tokenSupported` independently describes
   caller-owned token export availability.

For the existing test deployment, the last inspected URLs are:

- Homepage: `https://d2s9ypdbjcdxm7.cloudfront.net`
- Callback: `https://mfqq96hrh7.execute-api.us-west-2.amazonaws.com/oauth/github/callback`

Re-read stack outputs before configuring a different account or recreated stack.

## Builder acceptance

Select an existing authorized project; choose its Blueprint and model, compose
the construct, configure evaluation assets or defer them, and generate the
repository preview. Inspect the actual file contents before authorization.

Type the exact repository name, acknowledge private repository creation, and
authorize GitHub. When OAuth is configured, it requests `repo workflow`; the platform applies the token
only to the named repository and revokes that token after the delivery attempt.
Authorization is per export, not a permanently connected GitHub session.
The current exporter creates repositories in the authorizing user's account;
organization destination selection is not implemented.

After return, check the completed delivery, repository URL, `main` commit and
exported files, including `AGENTS.md`, inherited controls and evaluation assets.
Clone the repository using the displayed commands. Implement the Domain Harness
and local Agent adapter, then configure datasets/evaluators and run the workflows.
Deferred evaluation must report unconfigured; it must not appear to have passed.
AWS targets, runtime deployment and production human approval remain subsequent
delivery steps.

Test cancellation, stale preview rejection and interrupted-delivery recovery
without silently creating another repository. Record the exact repository and
commit verified. ZIP download remains an optional copy of the reviewed files.
ZIP delivery, mocked GitHub HTTP tests, OAuth configuration
presence and real GitHub delivery are separate evidence.

## Test data

The hosted evaluation acceptance script requires `TEST_PROJECT_ID` and reuses an
existing authorized workspace. It no longer creates `compose-proof-*` projects.
Use a named synthetic Agent and remove or archive that test record after review;
preserve immutable delivery and approval evidence.
