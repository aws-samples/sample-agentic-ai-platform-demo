# infra/knowledge-bases — Optional Knowledge Base CDK Stack

**This stack creates AWS resources and incurs costs.  It is OPTIONAL.**
The platform runs without it; you only need it when you want Bedrock Knowledge
Base RAG attached to the concierge and it-helpdesk agents.

---

## What gets created

Per project (`concierge`, `it-helpdesk` by default):

| Resource | Name pattern |
| --- | --- |
| S3 bucket | `agentic-kb-<project>-<account>` |
| IAM role | `AmazonBedrockExecutionRoleForKnowledgeBase-<project>` |
| OpenSearch Serverless collection | `agentic-kb-<project>` (VECTORSEARCH) |
| OSS encryption / network / data-access policies | `agentic-kb-<project>-enc/net/access` |
| OSS vector index | `kb-<project>-index` |
| Bedrock Knowledge Base | `kb-<project>` |
| Bedrock S3 Data Source | `ds-<project>-s3` |
| Ingestion job (custom resource) | triggered on deploy |

All resources carry five tags: `domain-id`, `project-id`, `managedBy=cdk`,
`project=agentic-ai-platform-demo`, `auto-delete=no`.

---

## Cost warning — OpenSearch Serverless OCUs

OpenSearch Serverless charges for **OpenSearch Compute Units (OCUs)** even when
idle.  Each collection requires a minimum of **0.5 OCU for indexing** and **0.5
OCU for search** — billed at roughly **$0.24 / OCU-hour**.  Two collections
(concierge + it-helpdesk) therefore cost approximately **$0.48/hour (~$350/month)**
at minimum, regardless of query volume.

**Tear down the stack when the demo is done** (see below).

---

## Prerequisites

1. AWS CDK bootstrapped in the target account and region:
   ```bash
   npx cdk bootstrap aws://<account>/<region>
   ```
2. The deploying IAM principal needs permissions to create IAM roles, S3 buckets,
   OpenSearch Serverless collections and policies, and Bedrock Knowledge Bases.
3. Bedrock model `amazon.titan-embed-text-v2:0` enabled in the target region
   (us-west-2 by default).

---

## Deploy

```bash
cd infra/knowledge-bases
npm install
npx cdk synth --context account=<account-id> --context region=us-west-2
npx cdk deploy --context account=<account-id> --context region=us-west-2
```

Or from the repo root (after adding `kb:*` scripts — see root `package.json`):

```bash
npm run kb:install
npm run kb:synth   # requires KB_ACCOUNT env var or pass --context account=...
npm run kb:deploy
```

### Name-collision note for account 217522444267

If you deploy into account 217, the stack will conflict with the resources
already created by `scripts/provision-kb.mjs` (same bucket names, same
collection names).  **This stack is intended for fresh accounts.**

To deploy alongside the existing script-created resources, pass a suffix:

```bash
npx cdk deploy --context account=217522444267 --context region=us-west-2 \
               --context nameSuffix=v2
```

That creates `agentic-kb-concierge-v2-217522444267`, etc.

---

## After deploy — wire the IDs

The stack outputs the Knowledge Base ID and Data Source ID for each project.
Write them into the live-resources files so the agents pick them up:

```bash
# Concierge
cat > domain-examples/concierge/agentcore/live-resources.json <<EOF
{
  "_comment": "Managed by infra/knowledge-bases CDK stack.",
  "knowledgeBase": {
    "id": "<ConciergeKnowledgeBaseId output>",
    "dataSourceId": "<ConciergeDataSourceId output>"
  }
}
EOF

# IT Helpdesk
cat > domain-examples/it-helpdesk/agentcore/live-resources.json <<EOF
{
  "_comment": "Managed by infra/knowledge-bases CDK stack.",
  "knowledgeBase": {
    "id": "<ItHelpdeskKnowledgeBaseId output>",
    "dataSourceId": "<ItHelpdeskDataSourceId output>"
  }
}
EOF
```

Then set the `KB_ID` environment variable on the running agent runtime (or
re-deploy the agent) so it can call `bedrock-agent-runtime:Retrieve`.

---

## Customising the project list

Pass a JSON array via CDK context to override the default two projects:

```bash
npx cdk deploy \
  --context account=<account-id> \
  --context region=us-west-2 \
  --context 'projects=[{"project":"my-kit","domain":"ops","docsPath":"domain-examples/my-kit/kb-docs"}]'
```

Or edit the `DEFAULT_PROJECTS` constant in `lib/knowledge-base-stack.ts`.

---

## Teardown

```bash
cd infra/knowledge-bases
npx cdk destroy --context account=<account-id> --context region=us-west-2
```

> **Note:** All resources are tagged `auto-delete=no` as a reminder that the
> S3 buckets use `RemovalPolicy.RETAIN`.  You will need to empty and delete
> the S3 buckets manually after `cdk destroy` if you want a full clean-up.

---

## Relationship to `scripts/provision-kb.mjs`

`scripts/provision-kb.mjs` is the quick, idempotent CLI script used to
create the resources in account 217 originally.  This CDK stack is the
reproducible, IaC equivalent for fresh deployments.  Both target the same
resource shapes; the script is kept as a convenient manual alternative.
