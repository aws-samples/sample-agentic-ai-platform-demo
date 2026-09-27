"""Project-scoped CodePipeline releases and human production decisions.

AWS CodePipeline owns the waiting approval token and deployment ordering.
Neither a browser nor the source repository receives production credentials.
"""
import json
import re
from datetime import datetime, timezone


class Rejected(Exception):
    def __init__(self, code, status=409):
        self.code, self.status = code, status


def variables(execution):
    values = {v["name"]: v["resolvedValue"] for v in execution.get("variables", [])}
    if not re.fullmatch(r"[a-f0-9]{40}", values.get("CommitSha", "")):
        raise Rejected("INVALID_RELEASE")
    if not re.fullmatch(r"[a-f0-9]{64}", values.get("ArtifactSha256", "")):
        raise Rejected("INVALID_RELEASE")
    return values


def review_identity(binding, execution):
    values = variables(execution)
    return {
        "pipelineId": binding["id"],
        "executionId": execution["pipelineExecutionId"],
        "commitSha": values["CommitSha"],
        "artifactSha256": values["ArtifactSha256"],
        "accountId": binding["accountId"],
        "region": binding["region"],
        "environment": "prod",
    }


def pending_approval(state, execution_id):
    for stage in state.get("stageStates", []):
        if stage["stageName"] != "ProductionApproval":
            continue
        if stage.get("latestExecution", {}).get("pipelineExecutionId") != execution_id:
            return None
        for action in stage.get("actionStates", []):
            latest = action.get("latestExecution", {})
            if action["actionName"] == "HumanDecision" and latest.get("status") == "InProgress":
                return latest.get("token")
    return None


class ReleaseService:
    def __init__(self, pipelines, codepipeline, table, project_table, cognito, pool_id, s3=None):
        self.pipelines = {p["id"]: p for p in pipelines}
        self.cp, self.table, self.projects = codepipeline, table, project_table
        self.cognito, self.pool_id = cognito, pool_id
        self.s3 = s3

    def evidence(self, binding, review):
        if self.s3 is None:
            raise Rejected("EVIDENCE_UNAVAILABLE", 503)
        result = {}
        for environment in ("dev", "preprod", "prod"):
            try:
                response = self.s3.get_object(
                    Bucket=binding["bucket"],
                    Key=f'evidence/{review["executionId"]}/{environment}.json')
            except Exception as error:
                if getattr(error, "response", {}).get("Error", {}).get("Code") == "NoSuchKey":
                    continue
                raise
            item = json.loads(response["Body"].read())
            if (item.get("commitSha") != review["commitSha"]
                    or item.get("artifactSha256") != review["artifactSha256"]
                    or item.get("environment") != environment
                    or item.get("repository") != binding["repository"]
                    or item.get("status") != "VERIFIED"):
                raise Rejected("INVALID_DEPLOYMENT_EVIDENCE")
            # Do not expose runtime answers or individual dataset rows in oversight.
            result[environment] = {k: item[k] for k in (
                "status", "runtimeArn", "runtimeVersion", "verifiedAt", "evaluationSha256")}
            report = item.get("evaluation", {})
            scores = [row.get("score") for row in report.get("results", [])]
            if report.get("status") != "PASSED" or not scores or any(
                    isinstance(score, bool) or not isinstance(score, (int, float))
                    or not 0 <= score <= 1 for score in scores):
                raise Rejected("INVALID_EVALUATION_EVIDENCE")
            result[environment]["evaluation"] = {
                "status": report["status"], "caseCount": len(scores),
                "minimumScore": min(scores), "requiredScore": binding["evaluationThreshold"]}
        return result

    def identity(self, claims):
        if claims.get("token_use") != "access" or not claims.get("sub"):
            raise Rejected("UNAUTHENTICATED", 401)
        username = claims.get("username") or claims.get("cognito:username")
        if not username:
            raise Rejected("UNAUTHENTICATED", 401)
        # Re-read current membership: a stale JWT must not retain approval power.
        user = self.cognito.admin_get_user(UserPoolId=self.pool_id, Username=username)
        attributes = {a["Name"]: a["Value"] for a in user.get("UserAttributes", [])}
        if not user.get("Enabled") or attributes.get("sub") != claims["sub"]:
            raise Rejected("FORBIDDEN", 403)
        groups, token = set(), None
        for _ in range(10):
            page = self.cognito.admin_list_groups_for_user(
                UserPoolId=self.pool_id, Username=username,
                **({"NextToken": token} if token else {}))
            groups.update(g["GroupName"] for g in page.get("Groups", []))
            token = page.get("NextToken")
            if not token:
                return {"subject": claims["sub"], "groups": groups}
        raise Rejected("FORBIDDEN", 403)

    def accessible(self, identity, binding):
        project = self.projects.get_item(Key={
            "pk": "PROJECT#" + binding["domainId"],
            "sk": "PROJECT#" + binding["projectId"],
        }, ConsistentRead=True).get("Item")
        if not project or project.get("status") != "ACTIVE":
            return False
        if project.get("domainId") != binding["domainId"]:
            return False
        groups = identity["groups"]
        if "platform-admin" in groups:
            return True
        domain_group = "domain-" + binding["domainId"].replace("_", "-")
        if domain_group not in groups:
            return False
        return ("domain-lead" in groups or (
            "domain-builder" in groups and identity["subject"] in
            [project.get("ownerSubject"), *project.get("memberSubjects", [])]))

    def binding(self, identity, pipeline_id):
        binding = self.pipelines.get(pipeline_id)
        if not binding or not self.accessible(identity, binding):
            raise Rejected("NOT_FOUND", 404)
        return binding

    def execution(self, binding, execution_id):
        execution = self.cp.get_pipeline_execution(
            pipelineName=binding["pipelineName"],
            pipelineExecutionId=execution_id)["pipelineExecution"]
        if (execution["pipelineName"] != binding["pipelineName"]
                or execution["pipelineExecutionId"] != execution_id):
            raise Rejected("INVALID_RELEASE")
        return execution

    def list(self, identity, domain=None):
        result = []
        for binding in self.pipelines.values():
            if domain and domain != binding["domainId"]:
                continue
            if not self.accessible(identity, binding):
                continue
            state = self.cp.get_pipeline_state(name=binding["pipelineName"])
            summaries = self.cp.list_pipeline_executions(
                pipelineName=binding["pipelineName"], maxResults=10).get("pipelineExecutionSummaries", [])
            releases = []
            for summary in summaries:
                execution = self.execution(binding, summary["pipelineExecutionId"])
                try:
                    review = review_identity(binding, execution)
                except Rejected:
                    # Malformed starts remain visible but can never be approved.
                    releases.append({"executionId": execution["pipelineExecutionId"],
                                     "status": "INVALID_RELEASE", "canApprove": False})
                    continue
                pending = bool(pending_approval(state, execution["pipelineExecutionId"]))
                evidence = self.evidence(binding, review)
                audit = self.table.get_item(Key={
                    "pk": "DECISION#" + binding["id"], "sk": execution["pipelineExecutionId"],
                }, ConsistentRead=True).get("Item")
                releases.append({
                    **review, "status": "AWAITING_APPROVAL" if pending else execution["status"],
                    "evidence": evidence,
                    "requesterSubject": binding["requesterSubject"],
                    "canDecide": pending and "platform-admin" in identity["groups"]
                    and identity["subject"] != binding["requesterSubject"]
                    and all(env in evidence for env in ("dev", "preprod")),
                    "canApprove": pending and "platform-admin" in identity["groups"]
                    and identity["subject"] != binding["requesterSubject"]
                    and all(env in evidence and evidence[env]["evaluation"]["minimumScore"]
                            >= binding["evaluationThreshold"] for env in ("dev", "preprod")),
                    "canRetryDecision": bool(audit) and pending
                    and audit.get("status") == "SUBMISSION_UNCONFIRMED"
                    and audit.get("actor") == identity["subject"]
                    and "platform-admin" in identity["groups"]
                    and identity["subject"] != binding["requesterSubject"],
                    "decision": {k: audit[k] for k in ("decision", "actor", "reason", "decidedAt", "status")
                                 if k in audit} if audit else None,
                })
            result.append({
                **{k: binding[k] for k in ("id", "domainId", "projectId", "agentId", "repository",
                                          "pipelineName", "accountId", "region")},
                "releases": releases,
            })
        return {"ok": True, "pipelines": result}

    def decide(self, identity, payload):
        keys = {"pipelineId", "executionId", "commitSha", "artifactSha256",
                "accountId", "region", "environment", "decision", "reason"}
        if not isinstance(payload, dict) or set(payload) != keys:
            raise Rejected("INVALID_REQUEST", 400)
        if (payload["decision"] not in ("APPROVE", "REJECT")
                or not isinstance(payload["reason"], str)
                or not 10 <= len(payload["reason"].strip()) <= 1000):
            raise Rejected("DECISION_REASON_REQUIRED", 400)
        if not isinstance(payload["executionId"], str) or not re.fullmatch(
                r"[a-f0-9-]{36}", payload["executionId"]):
            raise Rejected("INVALID_REQUEST", 400)
        binding = self.binding(identity, payload["pipelineId"])
        if "platform-admin" not in identity["groups"]:
            raise Rejected("FORBIDDEN", 403)
        if identity["subject"] == binding["requesterSubject"]:
            raise Rejected("REQUESTER_CANNOT_APPROVE", 403)
        execution = self.execution(binding, payload["executionId"])
        expected = review_identity(binding, execution)
        if any(payload[k] != v for k, v in expected.items()):
            raise Rejected("RELEASE_CHANGED")
        evidence = self.evidence(binding, expected)
        if not all(env in evidence for env in ("dev", "preprod")):
            raise Rejected("DEPLOYMENT_EVIDENCE_REQUIRED")
        key = {"pk": "DECISION#" + binding["id"], "sk": execution["pipelineExecutionId"]}
        previous = self.table.get_item(Key=key, ConsistentRead=True).get("Item")
        if previous:
            if any(previous.get(k) != v for k, v in {
                    **expected, "actor": identity["subject"], "decision": payload["decision"],
                    "reason": payload["reason"].strip()}.items()):
                raise Rejected("DECISION_ALREADY_RECORDED")
            if previous["status"] == "SUBMITTED":
                return {"ok": True, "release": expected, "decision": previous["decision"],
                        "actor": previous["actor"], "decidedAt": previous["decidedAt"]}
            if previous["status"] != "SUBMISSION_UNCONFIRMED":
                raise Rejected("DECISION_IN_PROGRESS")
        if payload["decision"] == "APPROVE" and any(
                evidence[env]["evaluation"]["minimumScore"] < binding["evaluationThreshold"]
                for env in ("dev", "preprod")):
            raise Rejected("EVALUATION_THRESHOLD_CHANGED")
        state = self.cp.get_pipeline_state(name=binding["pipelineName"])
        token = pending_approval(state, execution["pipelineExecutionId"])
        if not token:
            raise Rejected("APPROVAL_NOT_PENDING")
        now = datetime.now(timezone.utc).isoformat()
        item = {"pk": "DECISION#" + binding["id"], "sk": execution["pipelineExecutionId"],
                **expected, "actor": identity["subject"], "decision": payload["decision"],
                "reason": payload["reason"].strip(), "decidedAt": now, "status": "SUBMITTING"}
        # Conditional durable intent prevents two humans racing to replace a decision.
        try:
            if previous:
                item = {**previous, "status": "SUBMITTING"}
                self.table.update_item(
                    Key=key, UpdateExpression="SET #s = :next",
                    ConditionExpression="#s = :previous",
                    ExpressionAttributeNames={"#s": "status"},
                    ExpressionAttributeValues={":next": "SUBMITTING",
                                               ":previous": "SUBMISSION_UNCONFIRMED"})
            else:
                self.table.put_item(Item=item, ConditionExpression="attribute_not_exists(pk)")
        except Exception as error:
            if getattr(error, "response", {}).get("Error", {}).get("Code") == "ConditionalCheckFailedException":
                raise Rejected("DECISION_IN_PROGRESS") from error
            raise
        try:
            self.cp.put_approval_result(
                pipelineName=binding["pipelineName"], stageName="ProductionApproval",
                actionName="HumanDecision", token=token,
                result={"status": "Approved" if payload["decision"] == "APPROVE" else "Rejected",
                        # CodePipeline allows only 512 characters. The complete
                        # actor and reason remain in the durable decision above;
                        # send a bounded reference, never truncated JSON.
                        "summary": json.dumps({
                            "decision": payload["decision"],
                            "executionId": expected["executionId"],
                            "commitSha": expected["commitSha"],
                            "artifactSha256": expected["artifactSha256"],
                        }, separators=(",", ":"))})
        except Exception:
            self.table.update_item(Key={"pk": item["pk"], "sk": item["sk"]},
                                   UpdateExpression="SET #s = :s",
                                   ExpressionAttributeNames={"#s": "status"},
                                   ExpressionAttributeValues={":s": "SUBMISSION_UNCONFIRMED"})
            raise
        self.table.update_item(Key={"pk": item["pk"], "sk": item["sk"]},
                               UpdateExpression="SET #s = :s",
                               ExpressionAttributeNames={"#s": "status"},
                               ExpressionAttributeValues={":s": "SUBMITTED"})
        return {"ok": True, "release": expected, "decision": payload["decision"],
                "actor": identity["subject"], "decidedAt": item["decidedAt"]}
