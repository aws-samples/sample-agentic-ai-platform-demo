# Account 820 reinstallation verification — 2026-09-24

## Scope and outcome

The owner authorized removing the old platform installation in AWS account
820242898417, us-west-2, and reinstalling according to the GitHub instructions.
Application/infrastructure source was main `607ab2d`; the first-user seed utility
needed the small CLI compatibility fix accompanying this report.

The documented `npm run platform:deploy:clean-account` completed with exit 0.
ControlPlane, Web and DomainBootstrap are all new stacks in CREATE_COMPLETE.
Console: https://d35q3a338iunvm.cloudfront.net

This was a fresh platform installation within an existing account, not an empty
AWS account. Unrelated stacks and shared CDKToolkit were preserved. Old retained
application data was not restored into the new installation.

## Verified live

- Three baseline domains; six project records: Platform 1, Customer Support 3,
  Operations 2. Counts include any archived records.
- Thirteen model policies and all five domain-bootstrap API routes.
- Health endpoint returns 200; deployed HTML, JS and CSS match the tested source.
- Normal Cognito login with a temporary verifier, scoped project/model selection,
  Generate HTTP 201 and repository preview HTTP 201.
- Preview contains 59 files, including AGENTS.md, evaluation configuration and
  test/evaluation CI workflows. Evaluation remains NOT_RUN for the undeployed
  construct. Repository name matches the Agent build name.
- No project was created during browser acceptance; no uncaught browser errors.
- GitHub capability API returns 200 and tokenSupported=true; Export to GitHub is
  visible after asynchronous rendering. The first probe sampled the button too
  early; a second normal-login run confirmed both the API and the visible entry.
  OAuth is not configured by the default installation. No GitHub repository was
  created and no Agent delivery pipeline or production approval was exercised.
- Temporary verifier identities and generated undeployed constructs were removed;
  baseline projects were preserved.

## Issues encountered

1. **Old ControlPlane deletion failed on a retained descriptor.** Web intentionally
   retains its platform Agent descriptor on Delete. After verifying the exact
   Registry/record ownership, tags, name and version, the built-in descriptor was
   removed and stack deletion retried successfully. The new
   [reinstallation procedure](../platform-reinstallation.md) documents this and
   the verified unused boundary/empty-log-group collision cleanup.
2. **First-user initialization failed on actual AWS CLI stderr.** A leading blank
   line before the exact AdminGetUser UserNotFoundException was not recognized.
   The utility now accepts that exact additional format for lookup and cleanup;
   it still rejects other exit codes, operations, warnings and permission errors.
   The new cases failed before the fix; all 98 seed tests pass afterwards. The
   corrected documented seed flow was exercised successfully in the new pool.
3. **Strict postdeployment audit fails.** It reports ControlPlane runtime boundary
   drift, although the live policy equals the committed boundary rendered by CDK
   (including singleton action/resource normalization). The audit renderer omits
   PROVISIONED_NAME_PREFIX substitution and replaces the source Registry-read
   statements with a different action/resource contract. The audit was not bypassed
   or changed, and no IAM permissions were modified to make it pass. Later audit
   gates remain unverified. Shared CDK execution configuration was not changed.
4. **Main's serverless verification has an existing failing assertion.** 3015 tests
   pass and one fails on six Gateway callers versus the expected five. Open PR #64
   addresses this known test issue. It was not silently merged into this baseline.

## Verification boundary

Locked root, Registry and serverless dependency installs succeeded. ControlPlane
verification passed; serverless TypeScript build and both source syntheses passed.
Browser acceptance proves bootstrap/Generate/repository-preview behavior only.
The strict audit remains a release-readiness gap. Neither full security acceptance
nor GitHub-to-production delivery is claimed by this report.

Private runtime logs and sanitized screenshots/JSON are retained in the owner's
workspace artifacts/account820-reinstallation-20260924 directory. Credentials,
Cognito sessions and user content are excluded from committed evidence.
