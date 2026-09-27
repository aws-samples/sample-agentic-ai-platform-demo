"""Security and release-integrity checks without AWS credentials."""
import hashlib
import io
import importlib.util
import json
from pathlib import Path
import unittest
from types import SimpleNamespace
from unittest.mock import Mock, patch

ROOT = Path(__file__).resolve().parents[1]


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, ROOT / path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


deploy = load("deploy", "delivery/deploy.py")
service = load("service", "lambda/release-delivery/service.py")
configure = load("configure", "delivery/configure_repository.py")
audit = load("audit", "delivery/audit.py")
profile = load("runtime_profile", ROOT.parents[1] / "blueprints/chatagent/app/chat_agent/identity/profile.py")


class VerificationIdentity(unittest.TestCase):
    def test_native_actor_survives_sdk_reserved_header_filtering(self):
        context = SimpleNamespace(
            request_headers={"user-id": "legacy-actor"},
            request=SimpleNamespace(headers={
                "X-Amzn-Bedrock-AgentCore-Runtime-User-Id": "native-actor",
                "user-name": "must-not-be-forwarded",
            }),
        )
        resolved = profile.profile_from_context(context)
        self.assertEqual(resolved.user_id, "native-actor")
        self.assertEqual(resolved.name, "")

    def test_persistent_memory_rejects_anonymous_or_missing_actor(self):
        for actor in ("anonymous", "", " ", None):
            with self.assertRaises(ValueError):
                profile.require_memory_actor(actor)
        self.assertEqual(profile.require_memory_actor("release-probe-actor"), "release-probe-actor")

    def test_foundation_resolves_the_service_actor_before_legacy_headers(self):
        context = Mock(request_headers={
            "X-Amzn-Bedrock-AgentCore-Runtime-User-Id": "release-probe-actor",
            "user-id": "legacy-actor",
        })
        self.assertEqual(profile.profile_from_context(context).user_id, "release-probe-actor")
        self.assertEqual(
            profile.profile_from_context(Mock(request_headers={"USER-ID": "legacy-actor"})).user_id,
            "legacy-actor")

    def test_probes_isolate_memory_actors_across_sessions_and_environments(self):
        client = Mock()
        client.invoke_agent_runtime.side_effect = [
            {"response": io.BytesIO(b"first")},
            {"response": io.BytesIO(b"second")},
            {"response": io.BytesIO(b"third")},
        ]
        results = [deploy.invoke_verification(client, "runtime-arn", "safe prompt", env)
                   for env in ("dev", "dev", "preprod")]
        self.assertEqual([row[0] for row in results], [b"first", b"second", b"third"])
        self.assertEqual(len({row[1] for row in results}), 3)
        self.assertEqual(len({row[2] for row in results}), 3)
        for call, (_, actor, session) in zip(client.invoke_agent_runtime.call_args_list, results):
            self.assertEqual(call.kwargs["runtimeUserId"], actor)
            self.assertEqual(call.kwargs["runtimeSessionId"], session)
            self.assertNotEqual(actor, "anonymous")
            self.assertEqual(json.loads(call.kwargs["payload"]), {"prompt": "safe prompt"})
        for registration, removal, (_, actor, _) in zip(
                client.meta.events.register_first.call_args_list,
                client.meta.events.unregister.call_args_list, results):
            self.assertEqual(registration.args, removal.args)
            self.assertEqual(registration.args[0], "before-sign.bedrock-agentcore.InvokeAgentRuntime")
            request = SimpleNamespace(headers={})
            registration.args[1](request=request)
            self.assertEqual(request.headers, {deploy.ACTOR_HEADER: actor})

    def test_actor_signing_hook_is_removed_when_invocation_fails(self):
        client = Mock()
        client.invoke_agent_runtime.side_effect = RuntimeError("invoke failed")
        with self.assertRaisesRegex(RuntimeError, "invoke failed"):
            deploy.invoke_verification(client, "runtime", "prompt", "dev")
        self.assertEqual(client.meta.events.register_first.call_args.args,
                         client.meta.events.unregister.call_args.args)


class GuardrailVersionAudit(unittest.TestCase):
    def test_published_version_is_resolved_and_invalid_or_draft_rejected(self):
        self.assertEqual(audit.guardrail_version("example|12"), "12")
        for value in ("example", "example|DRAFT", "example|0", "example|1|2"):
            with self.assertRaises(ValueError):
                audit.guardrail_version(value)


class RepositoryConfiguration(unittest.TestCase):
    def test_pinned_portable_caller_and_no_repository_deploy_role(self):
        config = {"trustedWorkflowRef": "owner/platform/.github/workflows/agent-delivery.yml@" + "a"*40,
                  "accountId": "123456789012", "region": "us-west-2"}
        binding = {"id": "contract-demo", "domainId": "operations",
                   "projectId": "contracts", "agentId": "reviewer"}
        outputs = {"contractdemoArtifactBucket": "own-bucket",
                   "contractdemoUploaderRole": "arn:aws:iam::123456789012:role/uploader",
                   "contractdemoPipelineName": "own-pipeline"}
        files = configure.workflows(config, binding, outputs)
        self.assertIn(config["trustedWorkflowRef"], files["deploy-dev.yml"])
        self.assertIn('domain-id: "operations"', files["deploy-dev.yml"])
        self.assertNotIn("agentcore deploy", "".join(files.values()))
        self.assertNotIn("AWS_DEPLOY_ROLE_ARN", "".join(files.values()))
        outputs["contractdemoUploaderRole"] = "arn:aws:iam::999999999999:role/uploader"
        with self.assertRaises(ValueError):
            configure.workflows(config, binding, outputs)


class ReleaseIntegrity(unittest.TestCase):
    def test_probe_error_reports_type_without_leaking_response_content(self):
        body = b'data: {"error":"private prompt content","error_type":"AccessDeniedException"}'
        with self.assertRaisesRegex(RuntimeError, r"^Runtime returned an error \(AccessDeniedException\)$"):
            deploy.text_from_response(body)
    def setUp(self):
        self.package = b"an immutable agent package"
        self.evaluation = json.dumps({"status": "PASSED", "results": [{"score": 0.9}]}).encode()
        self.config = dict(repository="owner/agent", domainId="platform", projectId="foundation",
                           agentId="contract-review", evaluationThreshold=0.8)
        self.commit = "a" * 40
        self.digest = hashlib.sha256(self.package).hexdigest()
        self.release = {k: self.config[k] for k in ("repository", "domainId", "projectId", "agentId")}
        self.release.update(version=1, commitSha=self.commit, artifactSha256=self.digest,
                            evaluationSha256=hashlib.sha256(self.evaluation).hexdigest())

    def validate(self):
        deploy.validate_release(self.release, self.package, self.config,
                                self.commit, self.digest, self.evaluation)

    def test_valid_release(self):
        self.validate()

    def test_tampered_artifact(self):
        self.package += b"modified"
        with self.assertRaises(ValueError):
            self.validate()

    def test_cross_project_and_wrong_commit(self):
        for key in ("projectId", "domainId", "agentId", "repository", "commitSha"):
            with self.subTest(key=key):
                original = self.release[key]
                self.release[key] = "other"
                with self.assertRaises(ValueError):
                    self.validate()
                self.release[key] = original

    def test_evaluation_cannot_be_replaced(self):
        self.evaluation = b'{"status":"PASSED","results":[{"score":1}]}'
        with self.assertRaises(ValueError):
            self.validate()

    def test_failed_empty_and_below_platform_threshold(self):
        for report in ({"status": "FAILED", "results": [{"score": 1}]},
                       {"status": "PASSED", "results": []},
                       *({"status": "PASSED", "results": [{"score": score}]}
                         for score in (0.79, True, "1", float("nan"), 2))):
            with self.subTest(report=report):
                self.evaluation = json.dumps(report).encode()
                self.release["evaluationSha256"] = hashlib.sha256(self.evaluation).hexdigest()
                with self.assertRaises(ValueError):
                    self.validate()

    def test_runtime_probe_requires_actual_text(self):
        self.assertEqual(deploy.text_from_response(
            b'data: {"event":{"contentBlockDelta":{"delta":{"text":"Hello"}}}}\n'), "Hello")
        for body in (b"", b'{"status":"READY"}', b'{"error":"denied"}'):
            with self.assertRaises(RuntimeError):
                deploy.text_from_response(body)

    def test_guardrail_block_text_cannot_pass_as_a_model_response(self):
        blocked = (b'data: {"event":{"contentBlockDelta":{"delta":{"text":"Blocked"}}}}\n'
                   b'data: {"event":{"messageStop":{"stopReason":"guardrail_intervened"}}}\n')
        with self.assertRaisesRegex(RuntimeError, "blocked"):
            deploy.text_from_response(blocked, require_model_usage=True)
        text = b'data: {"event":{"contentBlockDelta":{"delta":{"text":"Agent answer"}}}}\n'
        with self.assertRaisesRegex(RuntimeError, "output-token"):
            deploy.text_from_response(text, require_model_usage=True)
        usage = b'data: {"event":{"metadata":{"usage":{"outputTokens":5}}}}\n'
        self.assertEqual(deploy.text_from_response(text + usage, require_model_usage=True), "Agent answer")

    def test_probe_cannot_accept_a_ready_endpoint_serving_an_old_release(self):
        control = Mock()
        control.get_agent_runtime_endpoint.return_value = {
            "status": "READY", "liveVersion": "1"}
        with patch.object(deploy.time, "sleep"):
            with self.assertRaises(TimeoutError):
                deploy.wait_endpoint(control, "runtime", "2", attempts=1)
        control.get_agent_runtime_endpoint.return_value = {
            "status": "READY", "liveVersion": "2", "agentRuntimeEndpointArn": "endpoint"}
        self.assertEqual(deploy.wait_endpoint(control, "runtime", "2")["liveVersion"], "2")


class HumanDecision(unittest.TestCase):
    def setUp(self):
        self.binding = dict(id="contract", domainId="platform", projectId="foundation",
                            agentId="contract", repository="owner/contract",
                            pipelineName="delivery", accountId="123456789012",
                            region="us-west-2", requesterSubject="builder", evaluationThreshold=0.8)
        self.execution = dict(pipelineName="delivery",
                              pipelineExecutionId="12345678-1234-1234-1234-123456789012",
                              status="InProgress", variables=[
                                  dict(name="CommitSha", resolvedValue="a"*40),
                                  dict(name="ArtifactSha256", resolvedValue="b"*64)])
        self.cp, self.table, self.projects, self.cognito = Mock(), Mock(), Mock(), Mock()
        self.projects.get_item.return_value = {"Item": {
            "status": "ACTIVE", "domainId": "platform", "ownerSubject": "builder"}}
        self.table.get_item.return_value = {}
        self.cp.get_pipeline_execution.return_value = {"pipelineExecution": self.execution}
        self.state = {"stageStates": [{
            "stageName": "ProductionApproval",
            "latestExecution": {"pipelineExecutionId": self.execution["pipelineExecutionId"]},
            "actionStates": [{"actionName": "HumanDecision",
                              "latestExecution": {"status": "InProgress", "token": "private-token"}}]}]}
        self.cp.get_pipeline_state.return_value = self.state
        self.svc = service.ReleaseService([self.binding], self.cp, self.table,
                                         self.projects, self.cognito, "pool")
        self.svc.evidence = Mock(return_value={
            env: {"evaluation": {"minimumScore": 1}} for env in ("dev", "preprod")})
        self.identity = {"subject": "human-admin", "groups": {"platform-admin"}}
        self.payload = {**service.review_identity(self.binding, self.execution),
                        "decision": "APPROVE", "reason": "Reviewed deployment and evaluation evidence."}

    def test_exact_release_human_decision(self):
        result = self.svc.decide(self.identity, self.payload)
        self.assertTrue(result["ok"])
        self.assertNotIn("private-token", json.dumps(result))
        self.assertEqual(self.cp.put_approval_result.call_args.kwargs["token"], "private-token")
        self.table.put_item.assert_called_once()

    def test_changed_release_target_rejected_before_native_approval(self):
        for key in ("commitSha", "artifactSha256", "accountId", "region", "environment"):
            with self.subTest(key=key), self.assertRaises(service.Rejected):
                self.svc.decide(self.identity, {**self.payload, key: "different"})
        self.cp.put_approval_result.assert_not_called()

    def test_long_reason_is_preserved_without_exceeding_native_summary_limit(self):
        reason = "Reviewed all release evidence. " * 30
        result = self.svc.decide(self.identity, {**self.payload, "reason": reason})
        self.assertTrue(result["ok"])
        saved = self.table.put_item.call_args.kwargs["Item"]
        self.assertEqual(saved["reason"], reason.strip())
        self.assertEqual(saved["actor"], self.identity["subject"])
        summary = self.cp.put_approval_result.call_args.kwargs["result"]["summary"]
        self.assertLessEqual(len(summary), 512)
        reference = json.loads(summary)
        for key in ("executionId", "commitSha", "artifactSha256", "decision"):
            self.assertEqual(reference[key], self.payload[key])

    def test_requester_and_builder_cannot_approve(self):
        for identity in ({"subject": "builder", "groups": {"platform-admin"}},
                         {"subject": "builder", "groups": {"domain-builder", "domain-platform"}}):
            with self.assertRaises(service.Rejected):
                self.svc.decide(identity, self.payload)
        self.cp.put_approval_result.assert_not_called()

    def test_another_execution_pending_is_not_approval_for_this_release(self):
        self.state["stageStates"][0]["latestExecution"]["pipelineExecutionId"] = "different"
        with self.assertRaises(service.Rejected):
            self.svc.decide(self.identity, self.payload)
        self.cp.put_approval_result.assert_not_called()

    def test_archived_project_denied_even_to_admin(self):
        self.projects.get_item.return_value["Item"]["status"] = "ARCHIVED"
        with self.assertRaises(service.Rejected):
            self.svc.decide(self.identity, self.payload)
        self.cp.put_approval_result.assert_not_called()

    def test_missing_preprod_evidence_cannot_approve(self):
        self.svc.evidence.return_value = {"dev": {}}
        with self.assertRaises(service.Rejected):
            self.svc.decide(self.identity, self.payload)
        self.cp.put_approval_result.assert_not_called()

    def test_completed_decision_retry_does_not_resubmit_native_token(self):
        self.table.get_item.return_value = {"Item": {
            **self.payload, "actor": "human-admin", "status": "SUBMITTED",
            "decidedAt": "2026-09-20T00:00:00Z"}}
        self.assertTrue(self.svc.decide(self.identity, self.payload)["ok"])
        self.cp.put_approval_result.assert_not_called()

    def test_tighter_evaluation_requirement_blocks_approval_but_allows_rejection(self):
        self.svc.evidence.return_value["preprod"]["evaluation"]["minimumScore"] = 0.7
        with self.assertRaises(service.Rejected):
            self.svc.decide(self.identity, self.payload)
        self.cp.put_approval_result.assert_not_called()
        result = self.svc.decide(self.identity, {**self.payload, "decision": "REJECT"})
        self.assertEqual(result["decision"], "REJECT")

    def test_transient_failure_retries_only_identical_intent(self):
        self.table.get_item.return_value = {"Item": {
            **self.payload, "pk": "DECISION#contract",
            "sk": self.execution["pipelineExecutionId"],
            "actor": "human-admin", "status": "SUBMISSION_UNCONFIRMED",
            "decidedAt": "2026-09-20T00:00:00Z"}}
        self.assertTrue(self.svc.decide(self.identity, self.payload)["ok"])
        self.assertEqual(self.table.update_item.call_args_list[0].kwargs["ConditionExpression"],
                         "#s = :previous")
        with self.assertRaises(service.Rejected):
            self.svc.decide(self.identity, {**self.payload, "decision": "REJECT"})
        self.cp.put_approval_result.assert_called_once()

    def test_only_original_human_can_retry_an_unconfirmed_decision(self):
        self.cp.list_pipeline_executions.return_value = {
            "pipelineExecutionSummaries": [{"pipelineExecutionId": self.execution["pipelineExecutionId"]}]}
        record = {**self.payload, "actor": self.identity["subject"],
                  "status": "SUBMISSION_UNCONFIRMED"}
        self.table.get_item.return_value = {"Item": record}
        self.assertTrue(self.svc.list(self.identity)["pipelines"][0]["releases"][0]["canRetryDecision"])
        other = {**self.identity, "subject": "another-human"}
        self.assertFalse(self.svc.list(other)["pipelines"][0]["releases"][0]["canRetryDecision"])
        record["status"] = "SUBMITTED"
        self.assertFalse(self.svc.list(self.identity)["pipelines"][0]["releases"][0]["canRetryDecision"])
        self.cp.put_approval_result.assert_not_called()

    def test_evidence_must_match_release_and_does_not_expose_answers(self):
        self.svc.s3 = Mock()
        self.binding["bucket"] = "artifacts"
        review = service.review_identity(self.binding, self.execution)
        def stored(**kwargs):
            env = kwargs["Key"].split("/")[-1].split(".")[0]
            item = {**review, "environment": env, "repository": self.binding["repository"],
                    "status": "VERIFIED", "runtimeArn": "runtime", "runtimeVersion": "1",
                    "verifiedAt": "now", "evaluationSha256": "c"*64,
                    "answer": "private response", "evaluation": {"status": "PASSED", "results": [{"score": 1}]}}
            return {"Body": io.BytesIO(json.dumps(item).encode())}
        self.svc.s3.get_object.side_effect = stored
        evidence = service.ReleaseService.evidence(self.svc, self.binding, review)
        self.assertEqual(evidence["preprod"]["evaluation"]["caseCount"], 1)
        self.assertNotIn("private response", json.dumps(evidence))
        self.assertNotIn("results", json.dumps(evidence))
        self.assertEqual(evidence["preprod"]["evaluation"]["requiredScore"], 0.8)
        self.svc.s3.get_object.side_effect = lambda **kwargs: {
            "Body": io.BytesIO(json.dumps({"commitSha": "wrong"}).encode())}
        with self.assertRaises(service.Rejected):
            service.ReleaseService.evidence(self.svc, self.binding, review)

    def test_fresh_membership_replaces_jwt_group_claim(self):
        self.cognito.admin_get_user.return_value = {
            "Enabled": True, "UserAttributes": [{"Name": "sub", "Value": "human-admin"}]}
        self.cognito.admin_list_groups_for_user.return_value = {"Groups": []}
        identity = self.svc.identity({"token_use": "access", "sub": "human-admin",
                                     "username": "admin", "cognito:groups": ["platform-admin"]})
        self.assertEqual(identity["groups"], set())
        with self.assertRaises(service.Rejected):
            self.svc.decide(identity, self.payload)


if __name__ == "__main__":
    unittest.main()
