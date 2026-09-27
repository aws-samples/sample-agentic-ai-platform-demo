"""Materialize a reviewed platform delivery binding into an exported repository.

This writes source files only. It never changes GitHub settings, grants access,
starts a pipeline, approves a release, or commits on behalf of a developer.
"""
import argparse
import json
from pathlib import Path
import re


def workflows(config, binding, outputs):
    reference = config["trustedWorkflowRef"]
    if not re.fullmatch(r"[\w-]+/[\w.-]+/\.github/workflows/[\w.-]+\.yml@[a-f0-9]{40}", reference):
        raise ValueError("The platform workflow must be pinned to a commit")
    prefix = binding["id"].replace("-", "")
    bucket = outputs[prefix + "ArtifactBucket"]
    role = outputs[prefix + "UploaderRole"]
    pipeline = outputs[prefix + "PipelineName"]
    if not role.startswith(f'arn:aws:iam::{config["accountId"]}:role/'):
        raise ValueError("Uploader role belongs to a different account")
    inputs = {
        "domain-id": binding["domainId"], "project-id": binding["projectId"],
        "agent-id": binding["agentId"], "artifact-bucket": bucket,
        "uploader-role": role, "pipeline-name": pipeline, "aws-region": config["region"],
    }
    delivery = """# platform-gate: v1
name: Governed Agent delivery
on:
  push:
    branches: [main]
  workflow_dispatch:
permissions:
  contents: read
  actions: read
  id-token: write
jobs:
  delivery:
    uses: """ + json.dumps(reference) + "\n    with:\n" + "".join(
        f"      {key}: {json.dumps(value)}\n" for key, value in inputs.items())
    review = """# platform-gate: v1
name: Production review guidance
on:
  workflow_dispatch:
permissions:
  contents: read
jobs:
  review-in-platform:
    runs-on: ubuntu-latest
    steps:
      - name: Open the pending release in Governance
        run: |
          echo 'Production is controlled by the platform CodePipeline manual approval action.' >> "$GITHUB_STEP_SUMMARY"
          echo 'In the platform Console, open Governance, Approval requests, then Agent releases.' >> "$GITHUB_STEP_SUMMARY"
          echo 'Review the exact commit, artifact and dev/preprod evidence. An eligible human reviewer must decide there.' >> "$GITHUB_STEP_SUMMARY"
          echo 'This guidance workflow does not deploy or approve anything.' >> "$GITHUB_STEP_SUMMARY"
"""
    return {"deploy-dev.yml": delivery, "promote.yml": review}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", required=True, type=Path)
    parser.add_argument("--outputs", required=True, type=Path)
    parser.add_argument("--binding", required=True)
    parser.add_argument("--repository", required=True, type=Path)
    args = parser.parse_args()
    config = json.loads(args.config.read_text())
    binding = next(b for b in config["bindings"] if b["id"] == args.binding)
    outputs = json.loads(args.outputs.read_text())["AgenticPlatform-AgentDelivery"]
    root = args.repository.resolve()
    if not (root / "domain-harness.json").is_file():
        raise ValueError("Expected an exported Agent repository")
    harness = json.loads((root / "domain-harness.json").read_text())
    if any(harness.get(key) != binding[field] for key, field in (
            ("domain", "domainId"), ("project", "projectId"), ("agent", "agentId"))):
        raise ValueError("Agent repository ownership differs from the reviewed binding")
    files = workflows(config, binding, outputs)
    folder = root / ".github/workflows"
    folder.mkdir(parents=True, exist_ok=True)
    for name, content in files.items():
        target = folder / name
        if target.exists() and not target.read_text().startswith("# platform-gate: v1"):
            raise ValueError("Refusing to replace an unrelated workflow: " + name)
    for name, content in files.items():
        (folder / name).write_text(content)
    print("Prepared delivery and production-review workflows. Review the diff, run CI, then commit.")


if __name__ == "__main__":
    main()
