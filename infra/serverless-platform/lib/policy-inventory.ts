import { lambdaReservedConcurrency } from "./lambda-concurrency";
import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';

// A dedicated read role avoids enlarging the shared write-capable runtime ceiling.
export function addPolicyInventory(stack: cdk.Stack, props: {userPoolArn:string;userPoolId:string;gateways:{arn:string;label:string}[];api:apigwv2.CfnApi;authorizer:apigwv2.CfnAuthorizer}) {
 const log = new logs.LogGroup(stack,'PolicyInventoryLogs',{retention:logs.RetentionDays.THREE_MONTHS,removalPolicy:cdk.RemovalPolicy.RETAIN});
 const engineArn=stack.formatArn({service:'bedrock-agentcore',resource:'policy-engine',resourceName:'*',arnFormat:cdk.ArnFormat.SLASH_RESOURCE_NAME});
 const document=new iam.PolicyDocument({statements:[
  new iam.PolicyStatement({actions:['logs:CreateLogStream','logs:PutLogEvents'],resources:[log.logGroupArn]}),
  new iam.PolicyStatement({actions:['cognito-idp:AdminGetUser','cognito-idp:AdminListGroupsForUser'],resources:[props.userPoolArn]}),
  new iam.PolicyStatement({actions:['bedrock-agentcore:GetGateway'],resources:props.gateways.map(g=>g.arn)}),
  new iam.PolicyStatement({actions:['bedrock-agentcore:GetPolicyEngine','bedrock-agentcore:ListPolicies'],resources:[engineArn]}),
 ]});
 const boundary=new iam.ManagedPolicy(stack,'PolicyInventoryBoundary',{managedPolicyName:'AgenticPlatform-Web-PolicyInventoryBoundary',document});boundary.applyRemovalPolicy(cdk.RemovalPolicy.RETAIN);
 const role=new iam.Role(stack,'PolicyInventoryRole',{roleName:'AgenticPlatform-Web-PolicyInventoryRole',assumedBy:new iam.ServicePrincipal('lambda.amazonaws.com'),permissionsBoundary:boundary,inlinePolicies:{PolicyInventory:document}});
 // The role and its independent boundary permit inspection only. The reader follows
 // validated same-account engine ARNs obtained from the two configured Gateways.
 const reason='Policy engines are discovered only from configured Gateway attachments; the reader validates account/region and exposes no client-selected engine or mutation operation.';
 for(const resource of [role,boundary]) resource.node.addMetadata(cdk.Validations.ACKNOWLEDGED_RULES_METADATA_KEY,{[`AwsSolutions-IAM5[Resource::arn:<AWS::Partition>:bedrock-agentcore:${stack.region}:${stack.account}:policy-engine/*]`]:reason});
 const fn=new nodejs.NodejsFunction(stack,'PolicyInventoryFunction',{runtime:lambda.Runtime.NODEJS_24_X,architecture:lambda.Architecture.ARM_64,entry:path.join(__dirname,'..','lambda','policy-inventory','index.mjs'),handler:'handler',role,logGroup:log,timeout:cdk.Duration.seconds(30),memorySize:256,reservedConcurrentExecutions: lambdaReservedConcurrency(stack, 5),environment:{COGNITO_USER_POOL_ID:props.userPoolId,POLICY_GATEWAYS_JSON:JSON.stringify(props.gateways)},depsLockFilePath:path.join(__dirname,'..','package-lock.json'),bundling:{bundleAwsSDK:true}});
 const integration=new apigwv2.CfnIntegration(stack,'PolicyInventoryIntegration',{apiId:props.api.ref,integrationType:'AWS_PROXY',integrationUri:fn.functionArn,payloadFormatVersion:'2.0',timeoutInMillis:29000});
 const route=new apigwv2.CfnRoute(stack,'PolicyInventoryRoute',{apiId:props.api.ref,routeKey:'GET /api/governance/runtime-policies',authorizationType:'JWT',authorizerId:props.authorizer.ref,target:`integrations/${integration.ref}`});route.addResourceDependency(props.authorizer);route.addResourceDependency(integration);
 fn.addPermission('AllowPolicyInventoryInvoke',{principal:new iam.ServicePrincipal('apigateway.amazonaws.com'),sourceArn:`arn:${stack.partition}:execute-api:${stack.region}:${stack.account}:${props.api.ref}/*/GET/api/governance/runtime-policies`});
 return {role,boundary};
}
