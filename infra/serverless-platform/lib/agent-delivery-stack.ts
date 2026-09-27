import * as fs from "node:fs";
import * as path from "node:path";
import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as iam from "aws-cdk-lib/aws-iam";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as logs from "aws-cdk-lib/aws-logs";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as codebuild from "aws-cdk-lib/aws-codebuild";
import * as codepipeline from "aws-cdk-lib/aws-codepipeline";
import * as actions from "aws-cdk-lib/aws-codepipeline-actions";
import * as apigateway from "aws-cdk-lib/aws-apigatewayv2";
import * as bedrock from "aws-cdk-lib/aws-bedrock";
import * as agentcore from "aws-cdk-lib/aws-bedrockagentcore";

export interface AgentDeliveryBinding {
  id: string; domainId: string; projectId: string; agentId: string;
  repository: string; repositoryId: string; requesterSubject: string;
  runtimeName: string; modelId: string; inferenceProfileId: string;
  entrypoint: string; pythonRuntime: string;
  evaluationThreshold: number;
  verificationPrompt?: string;
}
export interface AgentDeliveryTarget {
  accountId: string; region: string; apiId: string; authorizerId: string;
  tableName: string; userPoolId: string; githubOidcProviderArn?: string;
  trustedWorkflowRef: string; bindings: AgentDeliveryBinding[];
}

export class AgentDeliveryStack extends cdk.Stack {
  constructor(scope: Construct, id: string, target: AgentDeliveryTarget) {
    super(scope, id, {stackName: "AgenticPlatform-AgentDelivery",
      env: {account: target.accountId, region: target.region}, terminationProtection: true});
    if (!/^\d{12}$/.test(target.accountId) || target.region !== "us-west-2")
      throw new Error("An explicit supported deployment account and region are required");
    if (!/^[\w-]+\/[\w.-]+\/\.github\/workflows\/[\w.-]+\.yml@[a-f0-9]{40}$/.test(target.trustedWorkflowRef))
      throw new Error("Delivery workflow must be pinned to an immutable platform commit");
    for (const [key, value] of Object.entries({
      "auto-delete": "no", project: "agentic-ai-platform-demo", managedBy: "cdk",
    })) cdk.Tags.of(this).add(key, value);
    const providerArn = target.githubOidcProviderArn
      ?? new iam.CfnOIDCProvider(this, "GitHubOidc", {
        url: "https://token.actions.githubusercontent.com", clientIdList: ["sts.amazonaws.com"],
      }).attrArn;
    const decisions = new dynamodb.Table(this, "Decisions", {
      partitionKey: {name: "pk", type: dynamodb.AttributeType.STRING},
      sortKey: {name: "sk", type: dynamodb.AttributeType.STRING},
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: {pointInTimeRecoveryEnabled: true},
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    const bindings: Record<string, unknown>[] = [];
    const pipelineArns: string[] = [];
    const seen = new Set<string>();
    const deploySource = fs.readFileSync(path.join(__dirname, "../delivery/deploy.py")).toString("base64");
    for (const binding of target.bindings) {
      if (!/^[a-z][a-z0-9-]{0,40}$/.test(binding.id) || seen.has(binding.id)
        || !/^[a-z][a-z0-9_]{0,63}$/.test(binding.domainId)
        || !/^[a-z][a-z0-9-]{0,63}$/.test(binding.projectId)
        || !/^[a-z][a-z0-9-]{0,63}$/.test(binding.agentId)
        || !/^[\w-]+\/[\w.-]+$/.test(binding.repository)
        || !/^\d+$/.test(binding.repositoryId)
        || !binding.requesterSubject
        || !/^[a-z0-9][a-z0-9.:-]+$/.test(binding.modelId)
        || !/^[a-z0-9][a-z0-9.:-]+$/.test(binding.inferenceProfileId)
        || !/^[A-Za-z][A-Za-z0-9_]{0,30}$/.test(binding.runtimeName)
        || !/^[\w./-]+\.py$/.test(binding.entrypoint) || binding.entrypoint.includes("..")
        || !["PYTHON_3_12", "PYTHON_3_13", "PYTHON_3_14"].includes(binding.pythonRuntime)
        || !(binding.evaluationThreshold >= 0.5 && binding.evaluationThreshold <= 1)
        || (binding.verificationPrompt !== undefined &&
          (typeof binding.verificationPrompt !== "string" || !binding.verificationPrompt.trim()
            || binding.verificationPrompt.length > 2000 || binding.verificationPrompt.includes("\0"))))
        throw new Error("Invalid or duplicate Agent delivery binding");
      seen.add(binding.id);
      const owner = new Construct(this, binding.id);
      const tags = {"auto-delete": "no", "domain-id": binding.domainId,
        "project-id": binding.projectId, component: "agent-delivery", "managed-by": "agentic-platform"};
      for (const [key, value] of Object.entries(tags)) cdk.Tags.of(owner).add(key, value);
      const bucket = new s3.Bucket(owner, "Artifacts", {
        versioned: true, encryption: s3.BucketEncryption.S3_MANAGED,
        blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL, enforceSSL: true,
        removalPolicy: cdk.RemovalPolicy.RETAIN,
      });
      const guardrail = new bedrock.CfnGuardrail(owner, "Guardrail", {
        name: `platform-${binding.id}`,
        blockedInputMessaging: "This request is blocked by the platform safety policy.",
        blockedOutputsMessaging: "This response is blocked by the platform safety policy.",
        contentPolicyConfig: {filtersConfig: ["SEXUAL", "VIOLENCE", "HATE", "INSULTS", "MISCONDUCT", "PROMPT_ATTACK"]
          .map(type => ({type, inputStrength: "HIGH", outputStrength: type === "PROMPT_ATTACK" ? "NONE" : "HIGH"}))},
        sensitiveInformationPolicyConfig: {piiEntitiesConfig: [
          {type: "US_SOCIAL_SECURITY_NUMBER", action: "BLOCK"},
          {type: "CREDIT_DEBIT_CARD_NUMBER", action: "BLOCK"},
        ]},
      });
      const guardrailVersion = new bedrock.CfnGuardrailVersion(owner, "GuardrailVersion", {
        guardrailIdentifier: guardrail.attrGuardrailId,
        description: "Platform-controlled baseline for this Agent delivery",
      });
      const pipelineBoundary = new iam.ManagedPolicy(owner, "PipelineBoundary", {statements: [
        new iam.PolicyStatement({actions: ["s3:GetObject", "s3:GetObjectVersion", "s3:PutObject"],
          resources: [bucket.arnForObjects("*")]}),
        new iam.PolicyStatement({actions: ["s3:GetBucketLocation", "s3:GetBucketVersioning", "s3:GetBucketAcl",
          "s3:ListBucket", "s3:ListBucketVersions"],
          resources: [bucket.bucketArn]}),
      ]});
      const pipelineRole = new iam.Role(owner, "PipelineRole", {
        assumedBy: new iam.ServicePrincipal("codepipeline.amazonaws.com"),
        permissionsBoundary: pipelineBoundary,
      });
      const pipeline = new codepipeline.Pipeline(owner, "Pipeline", {
        pipelineName: `AgenticPlatform-Agent-${binding.id}`,
        pipelineType: codepipeline.PipelineType.V2,
        executionMode: codepipeline.ExecutionMode.QUEUED,
        artifactBucket: bucket, crossAccountKeys: false,
        role: pipelineRole, usePipelineRoleForActions: true,
        variables: [
          new codepipeline.Variable({variableName: "CommitSha"}),
          new codepipeline.Variable({variableName: "ArtifactSha256"}),
        ],
      });
      const source = new codepipeline.Artifact("Release");
      pipeline.addStage({stageName: "Source", actions: [
        new actions.S3SourceAction({actionName: "ReleaseArtifact", bucket,
          bucketKey: "source/release.zip", output: source, trigger: actions.S3Trigger.NONE}),
      ]});
      const uploaderStatements = [
        new iam.PolicyStatement({actions: ["s3:PutObject"], resources: [bucket.arnForObjects("source/release.zip")]}),
        new iam.PolicyStatement({actions: ["codepipeline:StartPipelineExecution", "codepipeline:GetPipelineExecution"],
          resources: [pipeline.pipelineArn]}),
      ];
      const uploaderBoundary = new iam.ManagedPolicy(owner, "UploaderBoundary", {statements: uploaderStatements});
      const uploader = new iam.Role(owner, "GitHubArtifactUploader", {
        assumedBy: new iam.FederatedPrincipal(providerArn, {
          StringEquals: {
            "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
            "token.actions.githubusercontent.com:sub":
              `repository_id:${binding.repositoryId}:job_workflow_ref:${target.trustedWorkflowRef}`,
          },
        }, "sts:AssumeRoleWithWebIdentity"),
        permissionsBoundary: uploaderBoundary,
      });
      uploaderStatements.forEach(statement => uploader.addToPolicy(statement));
      for (const environment of ["dev", "preprod", "prod"]) {
        if (environment === "prod") pipeline.addStage({
          stageName: "ProductionApproval", actions: [
            new actions.ManualApprovalAction({actionName: "HumanDecision",
              additionalInformation: `Approve only in the platform Console. Commit #{variables.CommitSha}; artifact #{variables.ArtifactSha256}; target ${target.accountId}/${target.region}/prod.`}),
          ],
        });
        const env = new Construct(owner, environment);
        cdk.Tags.of(env).add("environment", environment);
        const memory = new agentcore.CfnMemory(env, "Memory", {
          name: binding.runtimeName + "_" + environment + "_memory", eventExpiryDuration: 30,
          memoryStrategies: [
            {semanticMemoryStrategy: {name: "facts", namespaces: ["/users/{actorId}/facts"]}},
            {userPreferenceMemoryStrategy: {name: "preferences", namespaces: ["/users/{actorId}/preferences"]}},
            {summaryMemoryStrategy: {name: "summaries", namespaces: ["/summaries/{actorId}/{sessionId}"]}},
            {episodicMemoryStrategy: {name: "episodes",
              namespaces: ["/episodes/{actorId}/{sessionId}"],
              reflectionConfiguration: {namespaceTemplates: ["/episodes/{actorId}"]}}},
          ],
        });
        memory.applyRemovalPolicy(cdk.RemovalPolicy.RETAIN);
        const profileArn = `arn:aws:bedrock:${target.region}:${target.accountId}:inference-profile/${binding.inferenceProfileId}`;
        const modelArn = `arn:aws:bedrock:*::foundation-model/${binding.modelId}`;
        const runtimeStatements = [
          new iam.PolicyStatement({actions: ["s3:GetObject", "s3:GetObjectVersion"],
            resources: [bucket.arnForObjects("runtime/*")]}),
          new iam.PolicyStatement({actions: ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"],
            resources: [profileArn, modelArn],
            conditions: {StringEquals: {"bedrock:GuardrailIdentifier":
              `${guardrail.attrGuardrailArn}:${guardrailVersion.attrVersion}`}}}),
          new iam.PolicyStatement({actions: ["bedrock:ApplyGuardrail"], resources: [guardrail.attrGuardrailArn]}),
          new iam.PolicyStatement({actions: ["bedrock:GetInferenceProfile"], resources: [profileArn]}),
          new iam.PolicyStatement({actions: ["bedrock-agentcore:GetMemory", "bedrock-agentcore:CreateEvent",
            "bedrock-agentcore:GetEvent", "bedrock-agentcore:DeleteEvent", "bedrock-agentcore:ListEvents", "bedrock-agentcore:RetrieveMemoryRecords",
            "bedrock-agentcore:ListMemoryRecords"], resources: [memory.attrMemoryArn, `${memory.attrMemoryArn}/*`]}),
          new iam.PolicyStatement({actions: ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents",
            "logs:DescribeLogStreams"],
            resources: [`arn:aws:logs:${target.region}:${target.accountId}:log-group:/aws/bedrock-agentcore/runtimes/${binding.runtimeName}_${environment}*`]}),
          new iam.PolicyStatement({actions: ["xray:PutTraceSegments", "xray:PutTelemetryRecords"], resources: ["*"]}),
          new iam.PolicyStatement({actions: ["cloudwatch:PutMetricData"], resources: ["*"],
            conditions: {StringEquals: {"cloudwatch:namespace": "AgenticPlatform/Agents"}}}),
        ];
        const runtimeBoundary = new iam.ManagedPolicy(env, "RuntimeBoundary", {statements: runtimeStatements});
        const runtimeRole = new iam.Role(env, "RuntimeRole", {
          assumedBy: new iam.ServicePrincipal("bedrock-agentcore.amazonaws.com", {
            conditions: {StringEquals: {"aws:SourceAccount": target.accountId}},
          }), permissionsBoundary: runtimeBoundary,
        });
        runtimeStatements.forEach(statement => runtimeRole.addToPolicy(statement));
        const buildLogs = new logs.LogGroup(env, "DeployLogs", {
          retention: logs.RetentionDays.ONE_MONTH, removalPolicy: cdk.RemovalPolicy.RETAIN,
        });
        const runtimeArn = `arn:aws:bedrock-agentcore:${target.region}:${target.accountId}:runtime/${binding.runtimeName}_${environment}-*`;
        const deployStatements = [
          new iam.PolicyStatement({actions: ["logs:CreateLogStream", "logs:PutLogEvents"],
            resources: [`${buildLogs.logGroupArn}:*`]}),
          new iam.PolicyStatement({actions: ["s3:GetObject", "s3:GetObjectVersion"],
            resources: [bucket.arnForObjects("*")]}),
          new iam.PolicyStatement({actions: ["s3:PutObject"], resources: [
            bucket.arnForObjects("runtime/*"), bucket.arnForObjects(`evidence/*/${environment}.json`),
            bucket.arnForObjects(`evidence/*/${environment}-failed-probe.txt`),
          ]}),
          new iam.PolicyStatement({actions: ["s3:GetBucketLocation", "s3:GetBucketVersioning", "s3:GetBucketAcl",
            "s3:ListBucket"], resources: [bucket.bucketArn]}),
          // Runtime creation also authorizes its default endpoint. Both
          // creation operations retain the same owning-scope request tags.
          new iam.PolicyStatement({actions: ["bedrock-agentcore:CreateAgentRuntime",
            "bedrock-agentcore:CreateAgentRuntimeEndpoint"], resources: ["*"],
            conditions: {StringEquals: {"aws:RequestTag/domain-id": binding.domainId,
              "aws:RequestTag/project-id": binding.projectId, "aws:RequestTag/environment": environment}}}),
          // AWS tags both the Runtime and its automatically created workload
          // identity before assigning final IDs. Keep both creation dependencies
          // in this account and require the same owning-scope tags.
          new iam.PolicyStatement({actions: ["bedrock-agentcore:TagResource"],
            resources: [
              `arn:aws:bedrock-agentcore:${target.region}:${target.accountId}:runtime/*`,
              `arn:aws:bedrock-agentcore:${target.region}:${target.accountId}:workload-identity-directory/default`,
              `arn:aws:bedrock-agentcore:${target.region}:${target.accountId}:workload-identity-directory/default/workload-identity/*`,
            ],
            conditions: {StringEquals: {"aws:RequestTag/domain-id": binding.domainId,
              "aws:RequestTag/project-id": binding.projectId, "aws:RequestTag/environment": environment}}}),
          new iam.PolicyStatement({actions: ["bedrock-agentcore:CreateWorkloadIdentity"],
            resources: [
              `arn:aws:bedrock-agentcore:${target.region}:${target.accountId}:workload-identity-directory/default`,
              `arn:aws:bedrock-agentcore:${target.region}:${target.accountId}:workload-identity-directory/default/workload-identity/*`,
            ],
            conditions: {StringEquals: {"aws:RequestTag/domain-id": binding.domainId,
              "aws:RequestTag/project-id": binding.projectId, "aws:RequestTag/environment": environment}}}),
          new iam.PolicyStatement({actions: ["bedrock-agentcore:TagResource", "bedrock-agentcore:GetAgentRuntime",
            "bedrock-agentcore:GetAgentRuntimeEndpoint", "bedrock-agentcore:UpdateAgentRuntime",
            "bedrock-agentcore:InvokeAgentRuntime", "bedrock-agentcore:InvokeAgentRuntimeForUser"],
            resources: [runtimeArn, `${runtimeArn}/*`]}),
          new iam.PolicyStatement({actions: ["bedrock-agentcore:ListAgentRuntimes"], resources: ["*"]}),
          new iam.PolicyStatement({actions: ["iam:PassRole"], resources: [runtimeRole.roleArn],
            conditions: {StringEquals: {"iam:PassedToService": "bedrock-agentcore.amazonaws.com"}}}),
        ];
        const deployBoundary = new iam.ManagedPolicy(env, "DeployBoundary", {statements: deployStatements});
        const deployRole = new iam.Role(env, "DeployRole", {
          assumedBy: new iam.ServicePrincipal("codebuild.amazonaws.com"),
          permissionsBoundary: deployBoundary,
        });
        deployStatements.forEach(statement => deployRole.addToPolicy(statement));
        const project = new codebuild.PipelineProject(env, "Deploy", {
          role: deployRole, environment: {buildImage: codebuild.LinuxBuildImage.STANDARD_7_0},
          timeout: cdk.Duration.minutes(20),
          logging: {cloudWatch: {logGroup: buildLogs}},
          environmentVariables: {
            TARGET_ENVIRONMENT: {value: environment},
            PLATFORM_DEPLOYMENT: {value: JSON.stringify({...binding, ...target,
              bindings: undefined, tags, bucket: bucket.bucketName,
              runtimeRoleArn: runtimeRole.roleArn, memoryId: memory.attrMemoryId,
              guardrailId: guardrail.attrGuardrailArn, guardrailVersion: guardrailVersion.attrVersion})},
          },
          buildSpec: codebuild.BuildSpec.fromObject({
            version: "0.2", phases: {build: {commands: [
              "python3 -m pip install --quiet 'boto3>=1.42,<2'",
              `python3 -c "import base64;open('/tmp/platform-deploy.py','wb').write(base64.b64decode('${deploySource}'))"`,
              "python3 /tmp/platform-deploy.py",
            ]}},
          }),
        });
        pipelineBoundary.addStatements(new iam.PolicyStatement({
          actions: ["codebuild:StartBuild", "codebuild:BatchGetBuilds", "codebuild:StopBuild"], resources: [project.projectArn],
        }));
        pipeline.addStage({stageName: environment === "dev" ? "Dev" : environment === "preprod" ? "Preprod" : "Production",
          actions: [new actions.CodeBuildAction({
            actionName: "DeployAndVerify", project, input: source,
            environmentVariables: {
              SOURCE_COMMIT: {value: "#{variables.CommitSha}"},
              ARTIFACT_SHA256: {value: "#{variables.ArtifactSha256}"},
              PIPELINE_EXECUTION_ID: {value: "#{codepipeline.PipelineExecutionId}"},
            },
          })]});
      }
      pipelineArns.push(pipeline.pipelineArn);
      bindings.push({...binding, accountId: target.accountId, region: target.region,
        pipelineName: pipeline.pipelineName, bucket: bucket.bucketName});
      new cdk.CfnOutput(this, `${binding.id}ArtifactBucket`, {value: bucket.bucketName});
      new cdk.CfnOutput(this, `${binding.id}UploaderRole`, {value: uploader.roleArn});
      new cdk.CfnOutput(this, `${binding.id}PipelineName`, {value: pipeline.pipelineName});
    }
    if (!bindings.length) throw new Error("Configure at least one actual Agent repository");
    const apiLogs = new logs.LogGroup(this, "ApiLogs", {
      retention: logs.RetentionDays.ONE_MONTH, removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    const apiStatements = [
      new iam.PolicyStatement({actions: ["logs:CreateLogStream", "logs:PutLogEvents"], resources: [`${apiLogs.logGroupArn}:*`]}),
      new iam.PolicyStatement({actions: ["codepipeline:GetPipelineState", "codepipeline:GetPipelineExecution",
        "codepipeline:ListPipelineExecutions"], resources: pipelineArns}),
      new iam.PolicyStatement({actions: ["codepipeline:PutApprovalResult"],
        resources: pipelineArns.map(arn => `${arn}/ProductionApproval/HumanDecision`)}),
      new iam.PolicyStatement({actions: ["s3:GetObject"], resources:
        bindings.map(binding => `arn:aws:s3:::${binding.bucket}/evidence/*`)}),
      new iam.PolicyStatement({actions: ["s3:ListBucket"], resources:
        bindings.map(binding => `arn:aws:s3:::${binding.bucket}`)}),
      new iam.PolicyStatement({actions: ["dynamodb:GetItem"], resources: [
        `arn:aws:dynamodb:${target.region}:${target.accountId}:table/${target.tableName}`],
      conditions: {"ForAllValues:StringLike": {"dynamodb:LeadingKeys": ["PROJECT#*"]}}}),
      new iam.PolicyStatement({actions: ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem"],
        resources: [decisions.tableArn],
        conditions: {"ForAllValues:StringLike": {"dynamodb:LeadingKeys": ["DECISION#*"]}}}),
      new iam.PolicyStatement({actions: ["cognito-idp:AdminGetUser", "cognito-idp:AdminListGroupsForUser"],
        resources: [`arn:aws:cognito-idp:${target.region}:${target.accountId}:userpool/${target.userPoolId}`]}),
    ];
    const apiBoundary = new iam.ManagedPolicy(this, "ApiBoundary", {statements: apiStatements});
    const apiRole = new iam.Role(this, "ApiRole", {
      assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"), permissionsBoundary: apiBoundary,
    });
    apiStatements.forEach(statement => apiRole.addToPolicy(statement));
    const fn = new lambda.Function(this, "Api", {
      runtime: lambda.Runtime.PYTHON_3_12, handler: "handler.handler",
      code: lambda.Code.fromAsset(path.join(__dirname, "../lambda/release-delivery"),
        {exclude: ["__pycache__", "**/*.pyc"]}),
      role: apiRole, logGroup: apiLogs, timeout: cdk.Duration.seconds(28), memorySize: 256,
      environment: {PIPELINES: JSON.stringify(bindings), DECISION_TABLE: decisions.tableName,
        PROJECT_TABLE: target.tableName, USER_POOL_ID: target.userPoolId},
    });
    const integration = new apigateway.CfnIntegration(this, "Integration", {
      apiId: target.apiId, integrationType: "AWS_PROXY", integrationUri: fn.functionArn,
      payloadFormatVersion: "2.0", timeoutInMillis: 29000,
    });
    for (const [method, route] of [["GET", "release-delivery"], ["POST", "release-decisions"]]) {
      new apigateway.CfnRoute(this, route, {
        apiId: target.apiId, routeKey: `${method} /api/${route}`, authorizationType: "JWT",
        authorizerId: target.authorizerId, target: `integrations/${integration.ref}`,
      });
      fn.addPermission(route, {principal: new iam.ServicePrincipal("apigateway.amazonaws.com"),
        sourceArn: `arn:aws:execute-api:${target.region}:${target.accountId}:${target.apiId}/*/${method}/api/${route}`});
    }
    new cdk.CfnOutput(this, "GitHubOidcProviderArn", {value: providerArn});
  }
}
