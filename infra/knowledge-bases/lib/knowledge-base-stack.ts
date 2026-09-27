import * as cdk from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as s3deploy from "aws-cdk-lib/aws-s3-deployment";
import * as opensearchserverless from "aws-cdk-lib/aws-opensearchserverless";
import * as bedrock from "aws-cdk-lib/aws-bedrock";
import * as cr from "aws-cdk-lib/custom-resources";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as path from "path";
import { Construct } from "constructs";

/** Stack name for CDK. */
export const KNOWLEDGE_BASES_STACK_NAME = "AgenticPlatform-KnowledgeBases";

/** Default titan-embed-text-v2 model (1024-dim). */
const EMBEDDING_MODEL_ARN =
  "arn:aws:bedrock:us-west-2::foundation-model/amazon.titan-embed-text-v2:0";

/** Vector index field names must match the Bedrock KB field mapping exactly. */
const VECTOR_FIELD = "bedrock-knowledge-base-default-vector";
const TEXT_FIELD = "AMAZON_BEDROCK_TEXT_CHUNK";
const METADATA_FIELD = "AMAZON_BEDROCK_METADATA";
const VECTOR_DIMENSION = 1024;

/** One project's knowledge-base configuration. */
export interface KbProjectConfig {
  /** Short lowercase name, e.g. "concierge". Used in resource names. */
  project: string;
  /** Domain tag value, e.g. "customer_support". */
  domain: string;
  /**
   * Path to the kb-docs directory relative to the REPO ROOT (not this package).
   * Example: "domain-examples/concierge/kb-docs"
   */
  docsPath: string;
}

/** Default project list — mirrors provision-kb.mjs PROJECTS. */
const DEFAULT_PROJECTS: KbProjectConfig[] = [
  {
    project: "concierge",
    domain: "customer_support",
    docsPath: "domain-examples/concierge/kb-docs",
  },
  {
    project: "it-helpdesk",
    domain: "platform",
    docsPath: "domain-examples/it-helpdesk/kb-docs",
  },
];

export interface KnowledgeBaseStackProps extends cdk.StackProps {
  /** Absolute path to the repository root. Defaults to ../../.. from this file. */
  repoRoot?: string;
  /** Override the project list (useful for testing or adding new kits). */
  projects?: KbProjectConfig[];
}

/**
 * AgenticPlatform-KnowledgeBases
 *
 * Optional CDK stack that provisions per-project Bedrock Knowledge Bases.
 * Each project gets:
 *   - S3 bucket (private, AES256 SSE) — named agentic-kb-<project>-<account>
 *   - BucketDeployment uploading kb-docs/*.md
 *   - IAM service role trusted by bedrock.amazonaws.com
 *   - OpenSearch Serverless collection (VECTORSEARCH) with encryption /
 *     network / data-access policies
 *   - OSS vector index (created via AwsCustomResource)
 *   - Bedrock CfnKnowledgeBase + CfnDataSource
 *   - Custom resource to StartIngestionJob after the data source exists
 *
 * All resources are tagged with the same five tags used by provision-kb.mjs.
 *
 * NAMING COLLISION NOTE
 * ---------------------
 * The script-created resources in account 217522444267 use the same names
 * (e.g. agentic-kb-concierge-217522444267, agentic-kb-concierge collection).
 * Deploying this stack into account 217 AS-IS will fail on those resource
 * creates.  This stack is intended for FRESH accounts.  If you are deploying
 * into 217, pass --context nameSuffix=v2 (or any string) to get distinct
 * names such as agentic-kb-concierge-v2-<account>.
 */
export class KnowledgeBaseStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: KnowledgeBaseStackProps = {}) {
    super(scope, id, props);

    const repoRoot = props.repoRoot ?? path.resolve(__dirname, "..", "..", "..");
    const projects = props.projects ?? DEFAULT_PROJECTS;

    // Optional suffix to avoid name collisions when deploying alongside
    // script-created resources (pass --context nameSuffix=v2).
    const nameSuffix: string = this.node.tryGetContext("nameSuffix") ?? "";
    const suffix = nameSuffix ? `-${nameSuffix}` : "";

    for (const cfg of projects) {
      this.buildProjectResources(cfg, suffix, repoRoot);
    }
  }

  private buildProjectResources(cfg: KbProjectConfig, suffix: string, repoRoot: string): void {
    const { project, domain } = cfg;
    const account = cdk.Stack.of(this).account;
    const region = cdk.Stack.of(this).region;

    // Logical ID prefix — scoped per project so multiple can coexist.
    const p = project.charAt(0).toUpperCase() + project.slice(1).replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());

    const commonTags: Record<string, string> = {
      "domain-id": domain,
      "project-id": project,
      "managedBy": "cdk",
      "project": "agentic-ai-platform-demo",
      "auto-delete": "no",
    };

    // -------------------------------------------------------------------------
    // S3 Bucket
    // -------------------------------------------------------------------------
    // Name: agentic-kb-<project>[suffix]-<account>
    // Matches provision-kb.mjs: bucketName = project => `agentic-kb-${project}-${ACCOUNT_ID}`
    const bucketName = `agentic-kb-${project}${suffix}-${account}`;

    const bucket = new s3.Bucket(this, `${p}KbBucket`, {
      bucketName,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    this.applyTags(bucket, commonTags);

    // Upload kb-docs
    const docsAbsPath = path.join(repoRoot, cfg.docsPath);
    new s3deploy.BucketDeployment(this, `${p}KbDocs`, {
      sources: [s3deploy.Source.asset(docsAbsPath)],
      destinationBucket: bucket,
      prune: false,
    });

    // -------------------------------------------------------------------------
    // IAM Role — trusted by bedrock.amazonaws.com
    // -------------------------------------------------------------------------
    const roleName = `AmazonBedrockExecutionRoleForKnowledgeBase-${project}${suffix}`;

    const kbRole = new iam.Role(this, `${p}KbRole`, {
      roleName,
      assumedBy: new iam.ServicePrincipal("bedrock.amazonaws.com", {
        conditions: {
          StringEquals: { "aws:SourceAccount": account },
        },
      }),
    });
    kbRole.addToPolicy(
      new iam.PolicyStatement({
        sid: "S3Read",
        actions: ["s3:GetObject", "s3:ListBucket"],
        resources: [bucket.bucketArn, `${bucket.bucketArn}/*`],
      }),
    );
    kbRole.addToPolicy(
      new iam.PolicyStatement({
        sid: "AOSSAccess",
        actions: ["aoss:APIAccessAll"],
        resources: [`arn:aws:aoss:${region}:${account}:collection/*`],
      }),
    );
    this.applyTags(kbRole, commonTags);

    // -------------------------------------------------------------------------
    // OpenSearch Serverless — policies + collection
    // -------------------------------------------------------------------------
    const colName = `agentic-kb-${project}${suffix}`;
    // AOSS names: max 32 chars, lowercase letters/numbers/hyphens.
    // "agentic-kb-it-helpdesk" = 22 chars — within limit.

    const encPolicy = new opensearchserverless.CfnSecurityPolicy(this, `${p}OssEncPolicy`, {
      name: `${colName}-enc`,
      type: "encryption",
      policy: JSON.stringify({
        Rules: [{ Resource: [`collection/${colName}`], ResourceType: "collection" }],
        AWSOwnedKey: true,
      }),
    });
    this.applyTags(encPolicy, commonTags);

    const netPolicy = new opensearchserverless.CfnSecurityPolicy(this, `${p}OssNetPolicy`, {
      name: `${colName}-net`,
      type: "network",
      policy: JSON.stringify([{
        Rules: [
          { Resource: [`collection/${colName}`], ResourceType: "collection" },
          { Resource: [`collection/${colName}`], ResourceType: "dashboard" },
        ],
        AllowFromPublic: true,
      }]),
    });
    this.applyTags(netPolicy, commonTags);

    // Data-access policy: grant the KB role (and the CDK deployer role) access.
    // Note: AOSS data-access policies accept IAM role ARNs; the deployer role is
    // referenced via the CDK execution role ARN token.
    const deployerArn = `arn:aws:iam::${account}:root`;
    const dataPolicy = new opensearchserverless.CfnAccessPolicy(this, `${p}OssDataPolicy`, {
      name: `${colName}-access`,
      type: "data",
      policy: JSON.stringify([{
        Rules: [
          {
            ResourceType: "collection",
            Resource: [`collection/${colName}`],
            Permission: [
              "aoss:CreateCollectionItems",
              "aoss:DeleteCollectionItems",
              "aoss:UpdateCollectionItems",
              "aoss:DescribeCollectionItems",
            ],
          },
          {
            ResourceType: "index",
            Resource: [`index/${colName}/*`],
            Permission: [
              "aoss:CreateIndex",
              "aoss:DeleteIndex",
              "aoss:UpdateIndex",
              "aoss:DescribeIndex",
              "aoss:ReadDocument",
              "aoss:WriteDocument",
            ],
          },
        ],
        Principal: [kbRole.roleArn, deployerArn],
      }]),
    });
    this.applyTags(dataPolicy, commonTags);

    // Collection (create AFTER policies per provision-kb.mjs comment)
    const collection = new opensearchserverless.CfnCollection(this, `${p}OssCollection`, {
      name: colName,
      type: "VECTORSEARCH",
    });
    collection.addDependency(encPolicy);
    collection.addDependency(netPolicy);
    collection.addDependency(dataPolicy);
    this.applyTags(collection, commonTags);

    // -------------------------------------------------------------------------
    // OSS Vector Index — created via AwsCustomResource (HTTP PUT to AOSS endpoint)
    // -------------------------------------------------------------------------
    const indexName = `kb-${project}${suffix}-index`;

    // The index mapping mirrors provision-kb.mjs exactly:
    //   dimension=1024, hnsw/faiss, l2 space, ef_construction=512, m=16
    const indexBody = JSON.stringify({
      settings: { index: { knn: true, "knn.algo_param.ef_search": 512 } },
      mappings: {
        properties: {
          [VECTOR_FIELD]: {
            type: "knn_vector",
            dimension: VECTOR_DIMENSION,
            method: {
              name: "hnsw",
              space_type: "l2",
              engine: "faiss",
              parameters: { ef_construction: 512, m: 16 },
            },
          },
          [TEXT_FIELD]: { type: "text", index: true },
          [METADATA_FIELD]: { type: "text", index: false },
        },
      },
    });

    // sdk call: PUT <collectionEndpoint>/<indexName>
    // AwsCustomResource uses the aws-sdk v3 under the hood; we use the
    // opensearchserverless HttpClient via the "opensearch" domain in the
    // fetch wrapper.  The standard approach for AOSS index creation in CDK
    // is an AwsCustomResource that calls the AOSS HttpClient endpoint.
    // However, the standard CDK CR does not expose raw HTTP PUT to an AOSS
    // endpoint natively; instead we use a Lambda-backed CR inline to avoid
    // adding a separate Lambda file.
    //
    // The Lambda uses the @aws-sdk/client-opensearchserverless signing built
    // into the Lambda execution role; it signs an HTTP PUT with SigV4 to
    // create the index.
    const indexCreatorFn = new lambda.Function(this, `${p}OssIndexFn`, {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: "index.handler",
      timeout: cdk.Duration.minutes(5),
      code: lambda.Code.fromInline(/* javascript */ `
const https = require('https');
const { defaultProvider } = require('@aws-sdk/credential-provider-node');
const { SignatureV4 } = require('@smithy/signature-v4');
const { Sha256 } = require('@aws-crypto/sha256-js');

async function signedFetch(method, url, body) {
  const parsed = new URL(url);
  const signer = new SignatureV4({
    credentials: defaultProvider(),
    region: process.env.AWS_REGION || 'us-west-2',
    service: 'aoss',
    sha256: Sha256,
  });
  const request = {
    method,
    hostname: parsed.hostname,
    path: parsed.pathname,
    headers: {
      'Content-Type': 'application/json',
      host: parsed.hostname,
    },
    body,
  };
  const signed = await signer.sign(request);
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: signed.hostname,
      path: signed.path,
      method: signed.method,
      headers: signed.headers,
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

exports.handler = async (event) => {
  console.log('Event:', JSON.stringify(event));
  const { CollectionEndpoint, IndexName, IndexBody, RequestType } = event.ResourceProperties;
  const url = \`\${CollectionEndpoint}/\${IndexName}\`;
  if (RequestType === 'Delete') {
    const r = await signedFetch('DELETE', url, undefined).catch(e => ({ status: 500, body: e.message }));
    console.log('DELETE', r.status, r.body);
    return { PhysicalResourceId: IndexName };
  }
  // Create or Update
  const r = await signedFetch('PUT', url, IndexBody);
  console.log('PUT', r.status, r.body);
  if (![200, 201].includes(r.status)) {
    // 400 with "resource_already_exists_exception" is OK on Update
    if (r.status === 400 && r.body.includes('resource_already_exists')) {
      return { PhysicalResourceId: IndexName };
    }
    throw new Error(\`Index PUT failed: HTTP \${r.status}: \${r.body}\`);
  }
  return { PhysicalResourceId: IndexName };
};
      `),
      environment: {
        AWS_NODEJS_CONNECTION_REUSE_ENABLED: "1",
      },
    });

    // Grant the Lambda permission to call AOSS
    indexCreatorFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["aoss:APIAccessAll"],
        resources: [`arn:aws:aoss:${region}:${account}:collection/*`],
      }),
    );
    indexCreatorFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["aoss:DescribeCollectionItems", "aoss:CreateIndex"],
        resources: ["*"],
      }),
    );
    this.applyTags(indexCreatorFn, commonTags);

    const ossIndexCr = new cdk.CustomResource(this, `${p}OssIndex`, {
      serviceToken: indexCreatorFn.functionArn,
      properties: {
        CollectionEndpoint: collection.attrCollectionEndpoint,
        IndexName: indexName,
        IndexBody: indexBody,
        // Changing this forces re-create if the mapping changes
        IndexBodyHash: Buffer.from(indexBody).toString("base64").slice(0, 32),
      },
    });
    ossIndexCr.node.addDependency(collection);
    ossIndexCr.node.addDependency(dataPolicy);

    // -------------------------------------------------------------------------
    // Bedrock Knowledge Base
    // -------------------------------------------------------------------------
    const kbName = `kb-${project}${suffix}`;

    const cfnKb = new bedrock.CfnKnowledgeBase(this, `${p}KnowledgeBase`, {
      name: kbName,
      roleArn: kbRole.roleArn,
      knowledgeBaseConfiguration: {
        type: "VECTOR",
        vectorKnowledgeBaseConfiguration: {
          embeddingModelArn: EMBEDDING_MODEL_ARN,
        },
      },
      storageConfiguration: {
        type: "OPENSEARCH_SERVERLESS",
        opensearchServerlessConfiguration: {
          collectionArn: collection.attrArn,
          vectorIndexName: indexName,
          fieldMapping: {
            vectorField: VECTOR_FIELD,
            textField: TEXT_FIELD,
            metadataField: METADATA_FIELD,
          },
        },
      },
      tags: commonTags,
    });
    cfnKb.node.addDependency(ossIndexCr);

    // -------------------------------------------------------------------------
    // Bedrock Data Source (S3)
    // -------------------------------------------------------------------------
    const cfnDs = new bedrock.CfnDataSource(this, `${p}DataSource`, {
      knowledgeBaseId: cfnKb.attrKnowledgeBaseId,
      name: `ds-${project}${suffix}-s3`,
      dataSourceConfiguration: {
        type: "S3",
        s3Configuration: {
          bucketArn: bucket.bucketArn,
        },
      },
    });

    // -------------------------------------------------------------------------
    // Start Ingestion Job (custom resource — fires after data source exists)
    // -------------------------------------------------------------------------
    const ingestProvider = new cr.AwsCustomResource(this, `${p}StartIngestion`, {
      onCreate: {
        service: "bedrock-agent",
        action: "startIngestionJob",
        parameters: {
          knowledgeBaseId: cfnKb.attrKnowledgeBaseId,
          dataSourceId: cfnDs.attrDataSourceId,
        },
        physicalResourceId: cr.PhysicalResourceId.fromResponse(
          "ingestionJob.ingestionJobId",
        ),
      },
      // On update (re-deploy), start a fresh ingestion so new docs are indexed.
      onUpdate: {
        service: "bedrock-agent",
        action: "startIngestionJob",
        parameters: {
          knowledgeBaseId: cfnKb.attrKnowledgeBaseId,
          dataSourceId: cfnDs.attrDataSourceId,
        },
        physicalResourceId: cr.PhysicalResourceId.fromResponse(
          "ingestionJob.ingestionJobId",
        ),
      },
      policy: cr.AwsCustomResourcePolicy.fromStatements([
        new iam.PolicyStatement({
          actions: ["bedrock:StartIngestionJob"],
          resources: [cfnKb.attrKnowledgeBaseArn],
        }),
      ]),
    });
    ingestProvider.node.addDependency(cfnDs);

    // -------------------------------------------------------------------------
    // Stack Outputs
    // -------------------------------------------------------------------------
    new cdk.CfnOutput(this, `${p}KnowledgeBaseId`, {
      exportName: `AgenticPlatform-KB-${project}${suffix}-KnowledgeBaseId`,
      value: cfnKb.attrKnowledgeBaseId,
      description: `Bedrock Knowledge Base ID for ${project}`,
    });

    new cdk.CfnOutput(this, `${p}DataSourceId`, {
      exportName: `AgenticPlatform-KB-${project}${suffix}-DataSourceId`,
      value: cfnDs.attrDataSourceId,
      description: `Bedrock Knowledge Base data source ID for ${project}`,
    });

    new cdk.CfnOutput(this, `${p}BucketName`, {
      exportName: `AgenticPlatform-KB-${project}${suffix}-BucketName`,
      value: bucket.bucketName,
      description: `S3 bucket containing kb-docs for ${project}`,
    });
  }

  private applyTags(resource: Construct, tags: Record<string, string>): void {
    for (const [key, value] of Object.entries(tags)) {
      cdk.Tags.of(resource).add(key, value);
    }
  }
}
