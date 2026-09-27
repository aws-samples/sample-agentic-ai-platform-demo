#!/usr/bin/env node
/**
 * provision-kb.mjs
 *
 * Idempotent provisioning of Bedrock Knowledge Bases for concierge and it-helpdesk.
 * Uses OpenSearch Serverless as the vector store.
 *
 * Run: AWS_PROFILE=account-217 node scripts/provision-kb.mjs
 *
 * NOTE: This script is the quick/manual alternative to the CDK stack.
 * For reproducible IaC deployments on fresh accounts, use:
 *   infra/knowledge-bases/  (AgenticPlatform-KnowledgeBases CDK stack)
 *   See infra/knowledge-bases/README.md for full instructions.
 *
 * The resources created by this script already exist in account 217522444267.
 * Running this script is idempotent — it will skip resources that exist.
 */

import { execSync } from 'child_process';
import { readFileSync, readdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const REGION = 'us-west-2';
const ACCOUNT_ID = '217522444267';
const EMBEDDING_MODEL_ARN = `arn:aws:bedrock:${REGION}::foundation-model/amazon.titan-embed-text-v2:0`;
const AWS_PROFILE = process.env.AWS_PROFILE || 'account-217';

const PROJECTS = [
  {
    name: 'concierge',
    domain: 'customer_support',
    smokeQuery: 'what is the return window',
    kbDocDir: resolve(REPO_ROOT, 'domain-examples/concierge/kb-docs'),
  },
  {
    name: 'it-helpdesk',
    domain: 'platform',
    smokeQuery: 'how do I reset a password',
    kbDocDir: resolve(REPO_ROOT, 'domain-examples/it-helpdesk/kb-docs'),
  },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function cli(cmd, opts = {}) {
  const env = { ...process.env, AWS_PROFILE, AWS_DEFAULT_REGION: REGION };
  // Run all subprocesses from HOME to avoid isengardcli crashing on os.getcwd()
  // when the working directory is a restricted git worktree path.
  const safeCwd = process.env.HOME || '/tmp';
  try {
    const out = execSync(cmd, { env, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], cwd: safeCwd, ...opts });
    return out.trim();
  } catch (err) {
    if (opts.allowFail) return null;
    console.error(`CMD FAILED: ${cmd}`);
    console.error(err.stderr || err.message);
    throw err;
  }
}

function cliJson(cmd, opts = {}) {
  const raw = cli(cmd, opts);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function bucketName(project) { return `agentic-kb-${project}-${ACCOUNT_ID}`; }
function roleName(project) { return `agentic-kb-${project}-role`; }
function collectionName(project) { return `agentic-kb-${project}`; }
function kbName(project) { return `kb-${project}`; }

const TAGS = (domain, project) => [
  `domain-id=${domain}`,
  `project-id=${project}`,
  `managedBy=cdk`,
  `project=agentic-ai-platform-demo`,
  `auto-delete=no`,
].join(' ');

// ---------------------------------------------------------------------------
// S3 Bucket
// ---------------------------------------------------------------------------

async function ensureBucket(project, domain) {
  const bucket = bucketName(project);
  console.log(`\n[S3] Ensuring bucket ${bucket}...`);

  // Check existence
  const exists = cliJson(
    `aws s3api head-bucket --bucket ${bucket} --region ${REGION} 2>&1 || echo "NOT_FOUND"`,
    { allowFail: true }
  );
  const headRaw = cli(
    `aws s3api head-bucket --bucket ${bucket} --region ${REGION} 2>&1; echo "EXIT:$?"`,
    { allowFail: true }
  );
  const found = !headRaw.includes('404') && !headRaw.includes('NoSuchBucket') && !headRaw.includes('Not Found');

  if (!found) {
    console.log(`  Creating bucket ${bucket}...`);
    cli(`aws s3api create-bucket --bucket ${bucket} --region ${REGION} --create-bucket-configuration LocationConstraint=${REGION}`);
  } else {
    console.log(`  Bucket ${bucket} already exists.`);
  }

  // Apply settings idempotently
  cli(`aws s3api put-bucket-encryption --bucket ${bucket} --server-side-encryption-configuration '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"}}]}'`);
  cli(`aws s3api put-public-access-block --bucket ${bucket} --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true`);

  // Tag bucket
  const tagSet = [
    { Key: 'domain-id', Value: domain },
    { Key: 'project-id', Value: project },
    { Key: 'managedBy', Value: 'cdk' },
    { Key: 'project', Value: 'agentic-ai-platform-demo' },
    { Key: 'auto-delete', Value: 'no' },
  ];
  cli(`aws s3api put-bucket-tagging --bucket ${bucket} --tagging '{"TagSet":${JSON.stringify(tagSet)}}'`);

  console.log(`  Bucket ${bucket} ready.`);
  return `arn:aws:s3:::${bucket}`;
}

// ---------------------------------------------------------------------------
// Upload kb-docs
// ---------------------------------------------------------------------------

async function uploadDocs(project, kbDocDir) {
  const bucket = bucketName(project);
  console.log(`\n[S3] Uploading kb-docs for ${project}...`);
  const files = readdirSync(kbDocDir).filter(f => f.endsWith('.md'));
  for (const file of files) {
    const localPath = resolve(kbDocDir, file);
    cli(`aws s3 cp "${localPath}" "s3://${bucket}/${file}" --content-type "text/plain"`);
    console.log(`  Uploaded ${file}`);
  }
  return `s3://${bucket}/`;
}

// ---------------------------------------------------------------------------
// IAM Role
// ---------------------------------------------------------------------------

async function ensureIamRole(project, domain, bucketArn) {
  const role = roleName(project);
  console.log(`\n[IAM] Ensuring role ${role}...`);

  const existing = cliJson(`aws iam get-role --role-name ${role}`, { allowFail: true });
  if (!existing) {
    const trustPolicy = JSON.stringify({
      Version: '2012-10-17',
      Statement: [{
        Effect: 'Allow',
        Principal: { Service: 'bedrock.amazonaws.com' },
        Action: 'sts:AssumeRole',
        Condition: {
          StringEquals: { 'aws:SourceAccount': ACCOUNT_ID },
        },
      }],
    });
    cli(`aws iam create-role --role-name ${role} --assume-role-policy-document '${trustPolicy}'`);
    console.log(`  Created role ${role}.`);
  } else {
    console.log(`  Role ${role} already exists.`);
  }

  // Apply / overwrite inline policy
  const inlinePolicy = JSON.stringify({
    Version: '2012-10-17',
    Statement: [
      {
        Effect: 'Allow',
        Action: ['s3:GetObject', 's3:ListBucket'],
        Resource: [bucketArn, `${bucketArn}/*`],
      },
      {
        Effect: 'Allow',
        Action: ['bedrock:InvokeModel'],
        Resource: [EMBEDDING_MODEL_ARN],
      },
      {
        Effect: 'Allow',
        Action: ['aoss:APIAccessAll'],
        Resource: [`arn:aws:aoss:${REGION}:${ACCOUNT_ID}:collection/*`],
      },
    ],
  });
  cli(`aws iam put-role-policy --role-name ${role} --policy-name kb-access --policy-document '${inlinePolicy}'`);

  // Tag role
  const tags = [
    { Key: 'domain-id', Value: domain },
    { Key: 'project-id', Value: project },
    { Key: 'managedBy', Value: 'cdk' },
    { Key: 'project', Value: 'agentic-ai-platform-demo' },
    { Key: 'auto-delete', Value: 'no' },
  ];
  cli(`aws iam tag-role --role-name ${role} --tags '${JSON.stringify(tags)}'`);

  const roleData = cliJson(`aws iam get-role --role-name ${role}`);
  return roleData.Role.Arn;
}

// ---------------------------------------------------------------------------
// OpenSearch Serverless
// ---------------------------------------------------------------------------

async function ensureOssCollection(project, roleArn, callerArn) {
  const colName = collectionName(project);
  console.log(`\n[OSS] Ensuring collection ${colName}...`);

  // CRITICAL: data access policy must exist BEFORE the collection is created.
  // If created after, AOSS caches a "no policy" state and ignores updates for
  // several minutes even after propagation. Always create/update policy first.
  const dataPolicy = JSON.stringify([{
    Rules: [
      {
        ResourceType: 'collection',
        Resource: [`collection/${colName}`],
        Permission: ['aoss:CreateCollectionItems', 'aoss:DeleteCollectionItems', 'aoss:UpdateCollectionItems', 'aoss:DescribeCollectionItems'],
      },
      {
        ResourceType: 'index',
        Resource: [`index/${colName}/*`],
        Permission: ['aoss:CreateIndex', 'aoss:DeleteIndex', 'aoss:UpdateIndex', 'aoss:DescribeIndex', 'aoss:ReadDocument', 'aoss:WriteDocument'],
      },
    ],
    Principal: [roleArn, callerArn],
  }]);

  const existingPolicies = cliJson(
    `aws opensearchserverless list-access-policies --type data --region ${REGION}`,
    { allowFail: true }
  );
  const existingPolicy = (existingPolicies?.accessPolicySummaries || []).find(p => p.name === `${colName}-access`);
  if (existingPolicy) {
    const policyVersion = existingPolicy.policyVersion;
    console.log(`  Updating data access policy (version ${policyVersion})...`);
    cli(`aws opensearchserverless update-access-policy --name ${colName}-access --type data --policy '${dataPolicy}' --policy-version "${policyVersion}" --region ${REGION}`, { allowFail: true });
  } else {
    console.log(`  Creating data access policy BEFORE collection...`);
    cli(`aws opensearchserverless create-access-policy --name ${colName}-access --type data --policy '${dataPolicy}' --region ${REGION}`);
  }

  // Encryption policy
  const encPolicy = JSON.stringify({
    Rules: [{ ResourceType: 'collection', Resource: [`collection/${colName}`] }],
    AWSOwnedKey: true,
  });
  cli(`aws opensearchserverless create-security-policy --name ${colName}-enc --type encryption --policy '${encPolicy}' --region ${REGION}`, { allowFail: true });

  // Network policy — public access
  const netPolicy = JSON.stringify([{
    Rules: [
      { ResourceType: 'collection', Resource: [`collection/${colName}`] },
      { ResourceType: 'dashboard', Resource: [`collection/${colName}`] },
    ],
    AllowFromPublic: true,
  }]);
  cli(`aws opensearchserverless create-security-policy --name ${colName}-net --type network --policy '${netPolicy}' --region ${REGION}`, { allowFail: true });

  // Check existing collection
  const listResult = cliJson(`aws opensearchserverless list-collections --region ${REGION}`);
  const existing = (listResult?.collectionSummaries || []).find(c => c.name === colName);

  let collectionId, collectionArn, collectionEndpoint;

  if (!existing) {
    console.log(`  Creating OSS collection ${colName}...`);
    const createResult = cliJson(
      `aws opensearchserverless create-collection --name ${colName} --type VECTORSEARCH --region ${REGION}`
    );
    collectionId = createResult.createCollectionDetail.id;
    collectionArn = createResult.createCollectionDetail.arn;
  } else {
    collectionId = existing.id;
    collectionArn = existing.arn;
    console.log(`  Collection ${colName} already exists (id=${collectionId}).`);
  }

  // Wait for ACTIVE
  console.log(`  Waiting for collection ${colName} to become ACTIVE...`);
  const timeout = Date.now() + 6 * 60 * 1000;
  while (Date.now() < timeout) {
    const detail = cliJson(`aws opensearchserverless batch-get-collection --ids ${collectionId} --region ${REGION}`);
    const col = detail?.collectionDetails?.[0];
    if (col?.status === 'ACTIVE') {
      collectionEndpoint = col.collectionEndpoint;
      collectionArn = col.arn;
      console.log(`  Collection ACTIVE. Endpoint: ${collectionEndpoint}`);
      break;
    }
    console.log(`  Status: ${col?.status || 'unknown'}. Waiting 15s...`);
    await sleep(15000);
  }

  if (!collectionEndpoint) {
    const detail = cliJson(`aws opensearchserverless batch-get-collection --ids ${collectionId} --region ${REGION}`);
    collectionEndpoint = detail?.collectionDetails?.[0]?.collectionEndpoint;
    if (!collectionEndpoint) throw new Error(`Collection ${colName} did not become ACTIVE within timeout`);
  }

  return { collectionArn, collectionEndpoint };
}

// ---------------------------------------------------------------------------
// Create OSS vector index via Python botocore SigV4
// ---------------------------------------------------------------------------

async function ensureOssIndex(project, collectionEndpoint) {
  const indexName = `${project}-index`;
  console.log(`\n[OSS Index] Ensuring index ${indexName} on ${collectionEndpoint}...`);

  const pyScript = `
import boto3, requests, json, sys
from botocore.auth import SigV4Auth
from botocore.awsrequest import AWSRequest

profile = '${AWS_PROFILE}'
region = '${REGION}'
endpoint = '${collectionEndpoint}'
index_name = '${indexName}'

session = boto3.Session(profile_name=profile, region_name=region)
creds = session.get_credentials().get_frozen_credentials()

def signed_request(method, url, body=None):
    headers = {'Content-Type': 'application/json'} if body else {}
    req = AWSRequest(method=method, url=url, data=body, headers=headers)
    SigV4Auth(creds, 'aoss', region).add_auth(req)
    if method == 'GET':
        return requests.get(url, headers=dict(req.headers))
    elif method == 'PUT':
        return requests.put(url, data=body, headers=dict(req.headers))

# Check if index exists
url = f'{endpoint}/{index_name}'
resp = signed_request('GET', url)
if resp.status_code == 200:
    print('EXISTS')
    sys.exit(0)
if resp.status_code not in (404, 403):
    print(f'CHECK_ERROR:{resp.status_code}:{resp.text[:200]}')
    sys.exit(1)

# Create index
mapping = json.dumps({
    "settings": {"index": {"knn": True, "knn.algo_param.ef_search": 512}},
    "mappings": {"properties": {
        "bedrock-knowledge-base-default-vector": {
            "type": "knn_vector", "dimension": 1024,
            "method": {"name": "hnsw", "space_type": "l2", "engine": "faiss",
                       "parameters": {"ef_construction": 512, "m": 16}}
        },
        "AMAZON_BEDROCK_TEXT_CHUNK": {"type": "text", "index": True},
        "AMAZON_BEDROCK_METADATA": {"type": "text", "index": False},
    }}
})
resp = signed_request('PUT', url, mapping)
print(f'HTTP:{resp.status_code}:{resp.text[:300]}')
if resp.status_code not in (200, 201):
    sys.exit(1)
`;

  const tmpFile = `/tmp/oss-index-${project}.py`;
  const { writeFileSync } = await import('fs');
  writeFileSync(tmpFile, pyScript);

  const result = cli(`python3 "${tmpFile}"`, { allowFail: true });
  console.log(`  Index result: ${result}`);

  if (!result || result.includes('sys.exit(1)') || (result.includes('HTTP:') && !result.match(/HTTP:(200|201)/))) {
    throw new Error(`Failed to create OSS index ${indexName}: ${result}`);
  }

  return indexName;
}

// ---------------------------------------------------------------------------
// Knowledge Base
// ---------------------------------------------------------------------------

async function ensureKnowledgeBase(project, roleArn, collectionArn, indexName) {
  const name = kbName(project);
  console.log(`\n[KB] Ensuring Knowledge Base ${name}...`);

  // List and find by name
  const listResult = cliJson(
    `aws bedrock-agent list-knowledge-bases --region ${REGION}`
  );
  const existing = (listResult?.knowledgeBaseSummaries || []).find(kb => kb.name === name);

  if (existing) {
    console.log(`  KB ${name} already exists (id=${existing.knowledgeBaseId}).`);
    return existing.knowledgeBaseId;
  }

  const vectorIndexName = indexName;
  const storageConfig = {
    type: 'OPENSEARCH_SERVERLESS',
    opensearchServerlessConfiguration: {
      collectionArn,
      vectorIndexName,
      fieldMapping: {
        vectorField: 'bedrock-knowledge-base-default-vector',
        textField: 'AMAZON_BEDROCK_TEXT_CHUNK',
        metadataField: 'AMAZON_BEDROCK_METADATA',
      },
    },
  };
  const knowledgeBaseConfig = {
    type: 'VECTOR',
    vectorKnowledgeBaseConfiguration: {
      embeddingModelArn: EMBEDDING_MODEL_ARN,
    },
  };

  const createResult = cliJson(
    `aws bedrock-agent create-knowledge-base \
      --name "${name}" \
      --description "Knowledge base for ${project} agent" \
      --role-arn "${roleArn}" \
      --knowledge-base-configuration '${JSON.stringify(knowledgeBaseConfig)}' \
      --storage-configuration '${JSON.stringify(storageConfig)}' \
      --region ${REGION}`
  );

  const kbId = createResult?.knowledgeBase?.knowledgeBaseId;
  if (!kbId) throw new Error(`Failed to create KB for ${project}: ${JSON.stringify(createResult)}`);
  console.log(`  Created KB ${name} (id=${kbId}).`);

  // Wait for ACTIVE
  console.log(`  Waiting for KB to become ACTIVE...`);
  for (let i = 0; i < 24; i++) {
    await sleep(5000);
    const detail = cliJson(`aws bedrock-agent get-knowledge-base --knowledge-base-id ${kbId} --region ${REGION}`);
    const status = detail?.knowledgeBase?.status;
    if (status === 'ACTIVE') { console.log(`  KB ACTIVE.`); break; }
    console.log(`  KB status: ${status}. Waiting...`);
  }

  return kbId;
}

// ---------------------------------------------------------------------------
// Data Source
// ---------------------------------------------------------------------------

async function ensureDataSource(project, kbId, s3Prefix) {
  const dsName = `ds-${project}`;
  console.log(`\n[DS] Ensuring data source ${dsName}...`);

  const listResult = cliJson(
    `aws bedrock-agent list-data-sources --knowledge-base-id ${kbId} --region ${REGION}`
  );
  const existing = (listResult?.dataSourceSummaries || []).find(ds => ds.name === dsName);

  if (existing) {
    console.log(`  Data source already exists (id=${existing.dataSourceId}).`);
    return existing.dataSourceId;
  }

  const dsConfig = {
    type: 'S3',
    s3Configuration: {
      bucketArn: `arn:aws:s3:::${bucketName(project)}`,
    },
  };

  const createResult = cliJson(
    `aws bedrock-agent create-data-source \
      --knowledge-base-id ${kbId} \
      --name "${dsName}" \
      --data-source-configuration '${JSON.stringify(dsConfig)}' \
      --region ${REGION}`
  );

  const dsId = createResult?.dataSource?.dataSourceId;
  if (!dsId) throw new Error(`Failed to create data source: ${JSON.stringify(createResult)}`);
  console.log(`  Created data source (id=${dsId}).`);
  return dsId;
}

// ---------------------------------------------------------------------------
// Ingestion
// ---------------------------------------------------------------------------

async function runIngestion(kbId, dsId) {
  console.log(`\n[Ingest] Starting ingestion job for KB ${kbId}...`);

  const startResult = cliJson(
    `aws bedrock-agent start-ingestion-job \
      --knowledge-base-id ${kbId} \
      --data-source-id ${dsId} \
      --region ${REGION}`
  );

  const jobId = startResult?.ingestionJob?.ingestionJobId;
  if (!jobId) throw new Error(`Failed to start ingestion: ${JSON.stringify(startResult)}`);

  // Poll until COMPLETE
  const timeout = Date.now() + 3 * 60 * 1000;
  let status = 'STARTING';
  while (Date.now() < timeout && !['COMPLETE', 'FAILED'].includes(status)) {
    await sleep(5000);
    const detail = cliJson(
      `aws bedrock-agent get-ingestion-job \
        --knowledge-base-id ${kbId} \
        --data-source-id ${dsId} \
        --ingestion-job-id ${jobId} \
        --region ${REGION}`
    );
    status = detail?.ingestionJob?.status || 'UNKNOWN';
    console.log(`  Ingestion status: ${status}`);
  }

  return status;
}

// ---------------------------------------------------------------------------
// Smoke test
// ---------------------------------------------------------------------------

async function smokeTest(kbId, query) {
  console.log(`\n[Smoke] Querying KB ${kbId}: "${query}"...`);
  try {
    const result = cliJson(
      `aws bedrock-agent-runtime retrieve \
        --knowledge-base-id ${kbId} \
        --retrieval-query '{"text":"${query}"}' \
        --retrieval-configuration '{"vectorSearchConfiguration":{"numberOfResults":3}}' \
        --region ${REGION}`,
      { allowFail: true }
    );
    const chunks = result?.retrievalResults || [];
    if (chunks.length === 0) return '(no results)';
    const first = chunks[0]?.content?.text || '';
    const snippet = first.slice(0, 150);
    console.log(`  First chunk (150 chars): ${snippet}`);
    return snippet;
  } catch (err) {
    return `ERROR: ${err.message}`;
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log('=== Bedrock Knowledge Base Provisioning ===');
  console.log(`Account: ${ACCOUNT_ID} | Region: ${REGION} | Profile: ${AWS_PROFILE}`);

  // Get caller identity
  const callerIdentity = cliJson('aws sts get-caller-identity');
  const callerArn = callerIdentity?.Arn;
  console.log(`Caller ARN: ${callerArn}`);

  const results = {};

  for (const proj of PROJECTS) {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`PROJECT: ${proj.name}`);
    console.log('='.repeat(60));

    try {
      // Step 1: S3 bucket
      const bucketArn = await ensureBucket(proj.name, proj.domain);

      // Step 2: Upload docs
      const s3Prefix = await uploadDocs(proj.name, proj.kbDocDir);

      // Step 3: IAM role
      const roleArn = await ensureIamRole(proj.name, proj.domain, bucketArn);
      console.log(`  Role ARN: ${roleArn}`);

      // Brief pause for IAM propagation
      console.log('  Waiting 10s for IAM propagation...');
      await sleep(10000);

      // Step 4: OSS collection
      const { collectionArn, collectionEndpoint } = await ensureOssCollection(proj.name, roleArn, callerArn);

      // Step 5: OSS index
      const indexName = await ensureOssIndex(proj.name, collectionEndpoint);

      // Brief pause for index propagation
      await sleep(5000);

      // Step 6: Knowledge Base
      const kbId = await ensureKnowledgeBase(proj.name, roleArn, collectionArn, indexName);

      // Step 7: Data source
      const dsId = await ensureDataSource(proj.name, kbId, s3Prefix);

      // Step 8: Ingestion
      const ingestionStatus = await runIngestion(kbId, dsId);

      // Step 9: Smoke test
      const smokeResult = await smokeTest(kbId, proj.smokeQuery);

      results[proj.name] = {
        knowledgeBaseId: kbId,
        dataSourceId: dsId,
        s3Bucket: bucketName(proj.name),
        collectionArn,
        roleArn,
        ingestionStatus,
        smokeTest: smokeResult,
        domain: proj.domain,
      };

      console.log(`\n  DONE: ${proj.name} | KB ID: ${kbId} | Ingestion: ${ingestionStatus}`);
    } catch (err) {
      console.error(`\n  FAILED: ${proj.name}: ${err.message}`);
      results[proj.name] = { error: err.message };
    }
  }

  // Write results
  const outPath = '/tmp/kb-provision-results.json';
  const { writeFileSync } = await import('fs');
  writeFileSync(outPath, JSON.stringify(results, null, 2));
  console.log(`\n\nResults written to ${outPath}`);
  console.log(JSON.stringify(results, null, 2));

  return results;
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
