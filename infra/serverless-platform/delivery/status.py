"""Read actual delivery state without exposing native approval tokens or answers."""
import argparse
import json
from datetime import datetime, timezone
from pathlib import Path


def read_status(config, binding, outputs, execution_id=None):
    import boto3
    session = boto3.Session(region_name=config["region"])
    account = session.client("sts").get_caller_identity()["Account"]
    if account != config["accountId"]:
        raise ValueError("Wrong AWS account")
    prefix = binding["id"].replace("-", "")
    pipeline = outputs[prefix + "PipelineName"]
    cp = session.client("codepipeline")
    if execution_id is None:
        latest = cp.list_pipeline_executions(pipelineName=pipeline, maxResults=1)
        entries = latest.get("pipelineExecutionSummaries", [])
        if not entries:
            raise ValueError("No pipeline execution")
        execution_id = entries[0]["pipelineExecutionId"]
    execution = cp.get_pipeline_execution(
        pipelineName=pipeline, pipelineExecutionId=execution_id)["pipelineExecution"]
    report = {
        "observedAt": datetime.now(timezone.utc).isoformat(),
        "accountId": account, "region": config["region"],
        "repository": binding["repository"],
        "pipelineName": pipeline, "executionId": execution_id,
        "status": execution["status"],
        "variables": {v["name"]: v["resolvedValue"] for v in execution.get("variables", [])},
        "actions": [], "environments": {},
    }
    for page in cp.get_paginator("list_action_executions").paginate(
            pipelineName=pipeline, filter={"pipelineExecutionId": execution_id}):
        for action in page["actionExecutionDetails"]:
            result = action.get("output", {}).get("executionResult", {})
            report["actions"].append({
                "stage": action["stageName"], "action": action["actionName"],
                "status": action["status"],
                "startedAt": action.get("startTime"),
                "externalExecutionId": result.get("externalExecutionId"),
                "summary": result.get("externalExecutionSummary"),
            })
    s3 = session.client("s3")
    for environment in ("dev", "preprod", "prod"):
        try:
            obj = s3.get_object(Bucket=outputs[prefix + "ArtifactBucket"],
                                Key=f"evidence/{execution_id}/{environment}.json")
        except s3.exceptions.NoSuchKey:
            continue
        evidence = json.loads(obj["Body"].read())
        if (evidence.get("commitSha") != report["variables"].get("CommitSha")
                or evidence.get("artifactSha256") != report["variables"].get("ArtifactSha256")
                or evidence.get("repository") != binding["repository"]
                or evidence.get("environment") != environment):
            raise ValueError("Deployment evidence does not match this release")
        report["environments"][environment] = {key: evidence[key] for key in (
            "status", "runtimeArn", "runtimeVersion", "verifiedAt", "evaluationSha256")}
        results = evidence.get("evaluation", {}).get("results", [])
        report["environments"][environment]["evaluationCases"] = len(results)
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--outputs", type=Path, required=True)
    parser.add_argument("--binding", required=True)
    parser.add_argument("--execution")
    parser.add_argument("--output", type=Path)
    parser.add_argument("--summary", action="store_true")
    args = parser.parse_args()
    config = json.loads(args.config.read_text())
    binding = next(b for b in config["bindings"] if b["id"] == args.binding)
    outputs = json.loads(args.outputs.read_text())["AgenticPlatform-AgentDelivery"]
    report = read_status(config, binding, outputs, args.execution)
    text = json.dumps(report, indent=2, default=str)
    if args.output:
        args.output.write_text(text + "\n")
    if not args.summary:
        print(text)
        return
    print(f'{report["repository"]}\nAWS {report["accountId"]} / {report["region"]}')
    print(f'Commit   {report["variables"].get("CommitSha", "unavailable")}')
    print(f'Artifact {report["variables"].get("ArtifactSha256", "unavailable")}')
    print(f'Pipeline {report["executionId"]} — {report["status"]}')
    for stage in ("Source", "Dev", "Preprod", "ProductionApproval", "Production"):
        action = next((a for a in report["actions"] if a["stage"] == stage), None)
        print(f'{stage:20} {action["status"] if action else "Not started"}')
    for environment, evidence in report["environments"].items():
        print(f'{environment}: {evidence["status"]}, runtime version '
              f'{evidence["runtimeVersion"]}, {evidence["evaluationCases"]} evaluation cases')
        print(f'  {evidence["runtimeArn"]}')


if __name__ == "__main__":
    main()
