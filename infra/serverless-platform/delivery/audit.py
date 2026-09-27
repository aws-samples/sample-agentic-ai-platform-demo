"""Read-only verification of a deployed Agent delivery stack against its template."""
import argparse
import json
import re
from pathlib import Path
from datetime import datetime, timezone
from concurrent.futures import ThreadPoolExecutor


def guardrail_version(identifier):
    match = re.fullmatch(r"[^|]+\|([1-9][0-9]*)", identifier)
    if not match:
        raise ValueError("Unexpected GuardrailVersion physical identifier")
    return match.group(1)


def audit(config, template):
    import boto3
    session = boto3.Session(region_name=config["region"])
    account = session.client("sts").get_caller_identity()["Account"]
    if account != config["accountId"]:
        raise ValueError("Wrong AWS account")
    cf, iam = session.client("cloudformation"), session.client("iam")
    name = "AgenticPlatform-AgentDelivery"
    stack = cf.describe_stacks(StackName=name)["Stacks"][0]
    if stack["StackStatus"] not in ("CREATE_COMPLETE", "UPDATE_COMPLETE"):
        raise ValueError("Delivery stack is not stable")
    if not stack.get("EnableTerminationProtection"):
        raise ValueError("Delivery stack must have termination protection")
    live = cf.get_template(StackName=name, TemplateStage="Original")["TemplateBody"]
    if isinstance(live, str):
        live = json.loads(live)
    if live != template:
        raise ValueError("Deployed template differs from reviewed source")
    physical = {r["LogicalResourceId"]: r["PhysicalResourceId"]
                for page in cf.get_paginator("list_stack_resources").paginate(StackName=name)
                for r in page["StackResourceSummaries"]}
    resources = template["Resources"]

    def resolve(value):
        if isinstance(value, list):
            return [resolve(v) for v in value]
        if not isinstance(value, dict):
            return value
        if "Ref" in value:
            return {"AWS::AccountId": account, "AWS::Region": config["region"],
                    "AWS::Partition": "aws", **physical}[value["Ref"]]
        if "Fn::Join" in value:
            separator, parts = value["Fn::Join"]
            return separator.join(resolve(parts))
        if "Fn::GetAtt" in value:
            logical, attr = value["Fn::GetAtt"]
            kind, identifier = resources[logical]["Type"], physical[logical]
            prefix = f'arn:aws:{{service}}:{config["region"]}:{account}:'
            if kind == "AWS::IAM::OIDCProvider" and attr == "Arn":
                return identifier
            if kind == "AWS::IAM::Role" and attr == "Arn":
                return f"arn:aws:iam::{account}:role/{identifier}"
            if kind == "AWS::S3::Bucket" and attr == "Arn":
                return "arn:aws:s3:::" + identifier
            if kind == "AWS::Logs::LogGroup" and attr == "Arn":
                return prefix.format(service="logs") + "log-group:" + identifier + ":*"
            if kind == "AWS::CodeBuild::Project" and attr == "Arn":
                return prefix.format(service="codebuild") + "project/" + identifier
            if kind == "AWS::DynamoDB::Table" and attr == "Arn":
                return prefix.format(service="dynamodb") + "table/" + identifier
            if kind == "AWS::BedrockAgentCore::Memory" and attr == "MemoryArn":
                return identifier if identifier.startswith("arn:") else prefix.format(service="bedrock-agentcore") + "memory/" + identifier
            if kind == "AWS::Bedrock::Guardrail" and attr == "GuardrailArn":
                return identifier if identifier.startswith("arn:") else prefix.format(service="bedrock") + "guardrail/" + identifier
            if kind == "AWS::Bedrock::GuardrailVersion" and attr == "Version":
                return guardrail_version(identifier)
            raise ValueError(f"Unsupported audit attribute: {logical}.{attr}")
        return {k: resolve(v) for k, v in value.items()}

    def canonical(document):
        result = dict(document)
        result["Statement"] = sorted(
            (json.dumps(statement, sort_keys=True) for statement in document["Statement"]))
        return result

    def check_role(logical):
        props = resources[logical]["Properties"]
        role_name = physical[logical]
        role = iam.get_role(RoleName=role_name)["Role"]
        tags = {tag["Key"]: tag["Value"] for tag in role.get("Tags", [])}
        if any(tags.get(tag["Key"]) != resolve(tag["Value"]) for tag in props.get("Tags", [])):
            raise ValueError("Role tag drift: " + role_name)
        expected_boundary = resolve(props["PermissionsBoundary"])
        if role.get("PermissionsBoundary", {}).get("PermissionsBoundaryArn") != expected_boundary:
            raise ValueError("Unexpected permissions boundary: " + role_name)
        if canonical(role["AssumeRolePolicyDocument"]) != canonical(resolve(props["AssumeRolePolicyDocument"])):
            raise ValueError("Unexpected role trust: " + role_name)
        if iam.list_attached_role_policies(RoleName=role_name)["AttachedPolicies"]:
            raise ValueError("Unexpected attached policy: " + role_name)
        expected = {p["Properties"]["PolicyName"]: resolve(p["Properties"]["PolicyDocument"])
                    for p in resources.values() if p["Type"] == "AWS::IAM::Policy"
                    and {"Ref": logical} in p["Properties"].get("Roles", [])}
        names = iam.list_role_policies(RoleName=role_name)["PolicyNames"]
        if set(names) != set(expected):
            raise ValueError("Unexpected inline policy inventory: " + role_name)
        for policy_name in names:
            policy = iam.get_role_policy(RoleName=role_name, PolicyName=policy_name)["PolicyDocument"]
            if canonical(policy) != canonical(expected[policy_name]):
                raise ValueError("Inline policy drift: " + role_name)
        boundary_logical = props["PermissionsBoundary"]["Ref"]
        policy = iam.get_policy(PolicyArn=expected_boundary)["Policy"]
        doc = iam.get_policy_version(PolicyArn=expected_boundary,
                                     VersionId=policy["DefaultVersionId"])["PolicyVersion"]["Document"]
        if canonical(doc) != canonical(resolve(resources[boundary_logical]["Properties"]["PolicyDocument"])):
            raise ValueError("Boundary policy drift: " + role_name)
        return {"role": role_name, "boundary": expected_boundary, "status": "MATCHED"}

    roles = [key for key, resource in resources.items() if resource["Type"] == "AWS::IAM::Role"]
    with ThreadPoolExecutor(max_workers=4) as workers:
        results = list(workers.map(check_role, roles))
    return {"accountId": account, "region": config["region"], "stack": name,
            "templateMatches": True, "roles": results, "verifiedAt": datetime.now(timezone.utc).isoformat()}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--template", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    result = audit(json.loads(args.config.read_text()), json.loads(args.template.read_text()))
    args.output.write_text(json.dumps(result, indent=2))
    print(f'Verified deployed template and {len(result["roles"])} bounded IAM roles.')


if __name__ == "__main__":
    main()
