"""Trusted CodeBuild deploy step. Never executes code from the source artifact.

The project buildspec installs this script from the platform stack. The source
repository supplies only the reviewed Agent zip and a constrained release manifest.
"""
import hashlib
import json
import os
import re
import time
import uuid
from pathlib import Path

ACTOR_HEADER = "X-Amzn-Bedrock-AgentCore-Runtime-Custom-User-Id"


def invoke_verification(client, runtime_arn, prompt, environment):
    """Use a fresh memory actor as well as a fresh session for each smoke probe."""
    session_id = str(uuid.uuid4())
    actor_id = f"platform-verification-{environment}-{uuid.uuid4().hex}"
    # runtimeUserId identifies the IAM invocation but its reserved header is
    # not propagated to agent code. Send the same actor in one allowlisted,
    # SigV4-signed custom header, as required by the Runtime header contract.
    event = "before-sign.bedrock-agentcore.InvokeAgentRuntime"
    def add_actor(request, **kwargs):
        request.headers[ACTOR_HEADER] = actor_id
    client.meta.events.register_first(event, add_actor)
    try:
        response = client.invoke_agent_runtime(
            agentRuntimeArn=runtime_arn,
            qualifier="DEFAULT",
            runtimeUserId=actor_id,
            runtimeSessionId=session_id,
            payload=json.dumps({"prompt": prompt}).encode(),
            contentType="application/json")
    finally:
        client.meta.events.unregister(event, add_actor)
    return response["response"].read(), actor_id, session_id


def validate_release(release, package, config, commit, digest, evaluation):
    if not isinstance(release, dict) or set(release) != {
            "version", "repository", "commitSha", "artifactSha256", "evaluationSha256",
            "domainId", "projectId", "agentId"}:
        raise ValueError("Invalid release manifest")
    if release["version"] != 1:
        raise ValueError("Unsupported release manifest")
    for key in ("repository", "domainId", "projectId", "agentId"):
        if release[key] != config[key]:
            raise ValueError("Release ownership differs from platform binding")
    if release["commitSha"] != commit or release["artifactSha256"] != digest:
        raise ValueError("Release differs from the pipeline execution")
    if not re.fullmatch(r"[a-f0-9]{40}", commit) or not re.fullmatch(r"[a-f0-9]{64}", digest):
        raise ValueError("Invalid release identity")
    if hashlib.sha256(package).hexdigest() != digest:
        raise ValueError("Agent artifact digest differs from approved release")
    if hashlib.sha256(evaluation).hexdigest() != release["evaluationSha256"]:
        raise ValueError("Evaluation evidence differs from release manifest")
    report = json.loads(evaluation)
    if report.get("status") != "PASSED" or not report.get("results"):
        raise ValueError("Passing business evaluation evidence is required")
    for row in report["results"]:
        score = row.get("score")
        if (isinstance(score, bool) or not isinstance(score, (int, float))
                or not config["evaluationThreshold"] <= score <= 1):
            raise ValueError("Business evaluation fails the platform-bound threshold")


def wait_ready(control, runtime_id):
    for _ in range(120):
        state = control.get_agent_runtime(agentRuntimeId=runtime_id)
        if state["status"] == "READY":
            return state
        if state["status"] in ("CREATE_FAILED", "UPDATE_FAILED", "DELETING"):
            raise RuntimeError("Runtime failed: " + state["status"])
        time.sleep(5)
    raise TimeoutError("Runtime did not reach READY")


def wait_endpoint(control, runtime_id, version, attempts=120):
    """Prove the invoked endpoint serves this release's exact Runtime version."""
    for _ in range(attempts):
        endpoint = control.get_agent_runtime_endpoint(
            agentRuntimeId=runtime_id, endpointName="DEFAULT")
        if endpoint["status"] == "READY" and endpoint["liveVersion"] == version:
            return endpoint
        if endpoint["status"] in ("CREATE_FAILED", "UPDATE_FAILED", "DELETING"):
            raise RuntimeError("Runtime endpoint failed: " + endpoint["status"])
        time.sleep(5)
    raise TimeoutError("DEFAULT endpoint did not reach the release Runtime version")


def text_from_response(body, *, require_model_usage=False):
    """Collect actual streamed text deltas; errors never count as a healthy probe."""
    text = []
    output_tokens = 0
    for line in body.decode("utf-8").splitlines():
        if line.startswith("data:"):
            line = line[5:].strip()
        if not line or line == "[DONE]":
            continue
        try:
            value = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(value, dict):
            if value.get("error") or value.get("errorMessage"):
                kind = value.get("error_type", "")
                safe_kind = kind if isinstance(kind, str) and re.fullmatch(r"[A-Za-z][A-Za-z0-9_]{0,80}", kind) else "unspecified"
                raise RuntimeError("Runtime returned an error (" + safe_kind + ")")
            event = value.get("event", value)
            if isinstance(event, dict):
                if event.get("messageStop", {}).get("stopReason") in ("guardrail_intervened", "content_filtered"):
                    raise RuntimeError("Runtime probe was blocked by the model safety controls")
                usage = event.get("metadata", {}).get("usage", {}).get("outputTokens", 0)
                if isinstance(usage, int) and not isinstance(usage, bool) and usage > 0:
                    output_tokens += usage
            delta = event.get("contentBlockDelta", {}).get("delta", {}) if isinstance(event, dict) else {}
            if isinstance(delta.get("text"), str):
                text.append(delta["text"])
            elif isinstance(value.get("response"), str):
                text.append(value["response"])
    if not "".join(text).strip():
        raise RuntimeError("Runtime probe returned no Agent answer")
    if require_model_usage and not output_tokens:
        raise RuntimeError("Runtime probe returned no model output-token evidence")
    return "".join(text)


def main():
    import boto3
    config = json.loads(os.environ["PLATFORM_DEPLOYMENT"])
    region, environment = config["region"], os.environ["TARGET_ENVIRONMENT"]
    if environment not in ("dev", "preprod", "prod"):
        raise ValueError("Unknown deployment target")
    if boto3.client("sts").get_caller_identity()["Account"] != config["accountId"]:
        raise ValueError("Wrong AWS deployment account")
    release = json.loads(Path("release.json").read_text())
    package = Path("agent.zip").read_bytes()
    commit, digest = os.environ["SOURCE_COMMIT"], os.environ["ARTIFACT_SHA256"]
    evaluation = Path("evaluation-report.json").read_bytes()
    validate_release(release, package, config, commit, digest, evaluation)
    s3 = boto3.client("s3", region_name=region)
    control = boto3.client("bedrock-agentcore-control", region_name=region)
    bucket, key = config["bucket"], "runtime/" + digest + ".zip"
    # Versioned object identity is passed to Runtime; overwrites cannot change it.
    stored = s3.put_object(Bucket=bucket, Key=key, Body=package,
                           ServerSideEncryption="AES256")
    version = stored.get("VersionId")
    if not version:
        raise RuntimeError("Runtime artifacts must use S3 versioning")
    name = config["runtimeName"] + "_" + environment
    runtime_id = None
    token = None
    while True:
        page = control.list_agent_runtimes(**({"nextToken": token} if token else {}))
        for runtime in page.get("agentRuntimes", []):
            if runtime["agentRuntimeName"] == name:
                runtime_id = runtime["agentRuntimeId"]
        token = page.get("nextToken")
        if not token:
            break
    params = {
        "agentRuntimeArtifact": {"codeConfiguration": {
            "code": {"s3": {"bucket": bucket, "prefix": key, "versionId": version}},
            "runtime": config["pythonRuntime"],
            "entryPoint": ["opentelemetry-instrument", config["entrypoint"]],
        }},
        "roleArn": config["runtimeRoleArn"],
        "networkConfiguration": {"networkMode": "PUBLIC"},
        "protocolConfiguration": {"serverProtocol": "HTTP"},
        "requestHeaderConfiguration": {"requestHeaderAllowlist": [ACTOR_HEADER]},
        "environmentVariables": {
            "AWS_REGION": region,
            "AGENTCORE_MEMORY_ID": config["memoryId"],
            "PLATFORM_GUARDRAIL_ID": config["guardrailId"],
            "PLATFORM_GUARDRAIL_VERSION": config["guardrailVersion"],
            "PLATFORM_RELEASE_SHA": commit,
            "PLATFORM_ARTIFACT_SHA256": digest,
            "AGENT_METRICS_AGENT_NAME": config["agentId"] + "-" + environment,
            "AGENT_METRICS_DOMAIN": config["domainId"],
            "AGENT_METRICS_MODEL_ID": config["inferenceProfileId"],
        },
    }
    if runtime_id:
        params["environmentVariables"]["AGENT_METRICS_AGENT_RUNTIME_ID"] = runtime_id
        previous = control.get_agent_runtime(agentRuntimeId=runtime_id)
        if previous["roleArn"] != config["runtimeRoleArn"]:
            raise RuntimeError("Existing Runtime ownership differs from platform binding")
        control.update_agent_runtime(agentRuntimeId=runtime_id, **params)
    else:
        created = control.create_agent_runtime(
            agentRuntimeName=name, description="Platform-governed Agent release",
            tags={**config["tags"], "environment": environment}, **params)
        runtime_id = created["agentRuntimeId"]
        wait_ready(control, runtime_id)
        params["environmentVariables"]["AGENT_METRICS_AGENT_RUNTIME_ID"] = runtime_id
        control.update_agent_runtime(agentRuntimeId=runtime_id, **params)
    runtime = wait_ready(control, runtime_id)
    endpoint = wait_endpoint(control, runtime_id, runtime["agentRuntimeVersion"])
    # A real invocation is required after each deployment, before promotion.
    body, probe_actor, probe_session = invoke_verification(
        boto3.client("bedrock-agentcore", region_name=region),
        runtime["agentRuntimeArn"],
        config.get("verificationPrompt", "Hello. What can you help with?"),
        environment)
    execution = os.environ["PIPELINE_EXECUTION_ID"]
    try:
        answer = text_from_response(body, require_model_usage=True)
    except RuntimeError:
        # Keep failure details in the same private, encrypted evidence bucket.
        # Never print arbitrary Agent errors or response contents in build logs.
        s3.put_object(Bucket=bucket, Key=f"evidence/{execution}/{environment}-failed-probe.txt",
                      Body=body, ContentType="text/plain", ServerSideEncryption="AES256")
        raise
    evidence = {
        "version": 1, "environment": environment, "repository": config["repository"],
        "commitSha": commit, "artifactSha256": digest, "runtimeArn": runtime["agentRuntimeArn"],
        "runtimeVersion": runtime["agentRuntimeVersion"], "status": "VERIFIED",
        "runtimeEndpointArn": endpoint["agentRuntimeEndpointArn"],
        "probeActorId": probe_actor, "probeSessionId": probe_session,
        "evaluationSha256": release["evaluationSha256"],
        "evaluation": json.loads(evaluation),
        "answer": answer, "verifiedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }
    s3.put_object(Bucket=bucket, Key=f"evidence/{execution}/{environment}.json",
                  Body=json.dumps(evidence).encode(), ContentType="application/json",
                  ServerSideEncryption="AES256")
    print(json.dumps(evidence))


if __name__ == "__main__":
    main()
