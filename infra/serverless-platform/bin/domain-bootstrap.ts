import * as fs from "node:fs";
import * as cdk from "aws-cdk-lib";
import { DomainBootstrapStack, DomainBootstrapTarget } from "../lib/domain-bootstrap-stack";

const file = process.env.DOMAIN_BOOTSTRAP_TARGET_FILE;
if (!file) throw new Error("DOMAIN_BOOTSTRAP_TARGET_FILE must contain freshly discovered deployment bindings.");
const target: DomainBootstrapTarget = JSON.parse(fs.readFileSync(file, "utf8"));
if (!/^\d{12}$/.test(target.accountId) || target.region !== "us-west-2"
  || target.accountId !== process.env.AWS_ACCOUNT_ID || !/^[a-z0-9]+$/.test(target.apiId)
  || !target.authorizerId || !target.tableName || !target.userPoolId
  || !target.functions?.admin || !target.functions?.catalog
  || !target.catalogRoleArn?.startsWith(`arn:aws:iam::${target.accountId}:role/`)) throw new Error("Invalid domain bootstrap deployment target.");
new DomainBootstrapStack(new cdk.App(), "DomainBootstrapStack", target);
