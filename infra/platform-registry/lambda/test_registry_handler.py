import json
import re
import sys
import types
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock, patch


fake_boto3 = types.ModuleType("boto3")
fake_boto3.client = MagicMock(return_value=MagicMock())
sys.modules["boto3"] = fake_boto3
sys.path.insert(0, str(Path(__file__).parent))

import registry_handler


class ConflictException(Exception):
    pass


class ResourceNotFoundException(Exception):
    pass


class RegistryHandlerOwnershipTests(unittest.TestCase):
    def setUp(self):
        self.client = MagicMock()
        self.client.exceptions = SimpleNamespace(
            ConflictException=ConflictException,
            ResourceNotFoundException=ResourceNotFoundException,
        )
        self.client.tag_resource.return_value = {}
        self.client.delete_registry.return_value = {}
        self.client.delete_registry_record.return_value = {}
        self.client.get_registry.side_effect = ResourceNotFoundException()
        self.client.get_registry_record.side_effect = (
            ResourceNotFoundException()
        )
        self.client_patch = patch.object(
            registry_handler,
            "client",
            self.client,
        )
        self.client_patch.start()
        self.addCleanup(self.client_patch.stop)
        self.iam_client = MagicMock()
        self.iam_client_patch = patch.object(
            registry_handler,
            "iam_client",
            self.iam_client,
            create=True,
        )
        self.iam_client_patch.start()
        self.addCleanup(self.iam_client_patch.stop)

    def registry_props(self):
        return {
            "RegistryName": "platform_shared",
            "Description": "Shared Registry",
            "Tags": {
                "auto-delete": "no",
                "managedBy": "cdk",
                "project": "agentic-ai-platform-demo",
            },
        }

    def create_event(
        self,
        logical_id="RegistryResource",
        request_id="request-123456",
    ):
        return {
            "StackId":
                "arn:aws:cloudformation:us-west-2:111122223333:"
                "stack/test/stack-id",
            "LogicalResourceId": logical_id,
            "RequestId": request_id,
        }

    def record_props(self, **overrides):
        props = {
            "RegistryId": "registry123456",
            "RecordName": "blueprint_test",
            "DisplayName": "Test Blueprint",
            "RecordType": "CUSTOM",
            "Descriptors": {"custom": {"data": "{}"}},
            "RecordVersion": "1.0.0",
            "StatusTarget": "DRAFT",
            "Description": "Test record",
        }
        props.update(overrides)
        return props

    def record_state(self, **overrides):
        state = {
            "registryId": "registry123456",
            "recordId": "record123456",
            "recordArn":
                "arn:aws:agent-registry:us-west-2:111122223333:"
                "registry/registry123456/record/record123456",
            "name": "blueprint_test",
            "displayName": "Test Blueprint",
            "recordType": "CUSTOM",
            "descriptors": {"custom": {"data": "{}"}},
            "recordVersion": "1.0.0",
            "description": "Test record",
            "status": "DRAFT",
        }
        state.update(overrides)
        return state

    def managed_policy_props(self):
        return {
            "ResourceType": "ManagedPolicyTags",
            "PolicyArn":
                "arn:aws:iam::111122223333:policy/"
                "AgenticPlatform-ControlPlane-RuntimePermissionsBoundary",
            "Tags": {
                "auto-delete": "no",
                "managedBy": "cdk",
                "project": "agentic-ai-platform-demo",
            },
        }

    def test_managed_policy_tags_are_reconciled_exactly(self):
        self.iam_client.list_policy_tags.side_effect = [
            {
                "Tags": [
                    {"Key": "legacy", "Value": "remove"},
                    {"Key": "managedBy", "Value": "old"},
                ],
            },
            {
                "Tags": [
                    {"Key": key, "Value": value}
                    for key, value in self.managed_policy_props()["Tags"].items()
                ],
            },
        ]

        result = registry_handler.handler(
            {
                "RequestType": "Create",
                "ResourceProperties": self.managed_policy_props(),
            },
            None,
        )

        self.iam_client.untag_policy.assert_called_once_with(
            PolicyArn=self.managed_policy_props()["PolicyArn"],
            TagKeys=["legacy"],
        )
        self.iam_client.tag_policy.assert_called_once_with(
            PolicyArn=self.managed_policy_props()["PolicyArn"],
            Tags=[
                {"Key": key, "Value": value}
                for key, value in self.managed_policy_props()["Tags"].items()
            ],
        )
        self.assertTrue(
            result["PhysicalResourceId"].startswith(
                "managed-policy-tags::",
            )
        )

    def test_managed_policy_tag_delete_is_a_noop(self):
        result = registry_handler.handler(
            {
                "RequestType": "Delete",
                "PhysicalResourceId": "managed-policy-tags::existing",
                "ResourceProperties": self.managed_policy_props(),
            },
            None,
        )

        self.assertEqual(
            result["PhysicalResourceId"],
            "managed-policy-tags::existing",
        )
        self.iam_client.tag_policy.assert_not_called()
        self.iam_client.untag_policy.assert_not_called()

    def test_managed_policy_tagging_rejects_an_unowned_policy(self):
        props = {
            **self.managed_policy_props(),
            "PolicyArn": "arn:aws:iam::111122223333:policy/OtherPolicy",
        }

        with self.assertRaisesRegex(ValueError, "PolicyArn"):
            registry_handler.handler(
                {
                    "RequestType": "Create",
                    "ResourceProperties": props,
                },
                None,
            )

    def test_managed_policy_tagging_rejects_ambiguous_tag_responses(self):
        cases = [
            {
                "IsTruncated": True,
                "Tags": [],
            },
            {
                "Tags": [
                    {"Key": "duplicate", "Value": "one"},
                    {"Key": "duplicate", "Value": "two"},
                ],
            },
            {
                "Tags": [{"Key": "missing-value"}],
            },
        ]

        for response in cases:
            with self.subTest(response=response):
                self.iam_client.reset_mock()
                self.iam_client.list_policy_tags.return_value = response
                with self.assertRaisesRegex(
                    ValueError,
                    "managed policy tag response",
                ):
                    registry_handler.handler(
                        {
                            "RequestType": "Create",
                            "ResourceProperties": self.managed_policy_props(),
                        },
                        None,
                    )
                self.iam_client.tag_policy.assert_not_called()
                self.iam_client.untag_policy.assert_not_called()

    def test_existing_ready_registry_requires_reference_mode(self):
        self.client.create_registry.side_effect = ConflictException()
        with (
            patch.object(
                registry_handler,
                "find_registry_by_name",
                return_value={
                    "status": "READY",
                    "registryId": "existing123456",
                },
            ),
            patch.object(registry_handler, "wait_for_registry_ready"),
        ):
            with self.assertRaisesRegex(
                RuntimeError,
                "already exists.*reference-existing",
            ):
                registry_handler.handle_registry(
                    "Create",
                    self.registry_props(),
                    {},
                )

        self.client.create_registry.assert_called_once()

    def test_existing_non_ready_registry_requires_reference_mode(self):
        for status in (
            "CREATING",
            "CREATE_FAILED",
            "DELETING",
            "UPDATING",
            "UNKNOWN",
            None,
        ):
            with self.subTest(status=status):
                self.client.reset_mock()
                self.client.create_registry.side_effect = ConflictException()
                with (
                    patch.object(
                        registry_handler,
                        "find_registry_by_name",
                        return_value={
                            "status": status,
                            "registryId": "existing123456",
                        },
                    ),
                    patch.object(registry_handler.time, "sleep"),
                ):
                    with self.assertRaisesRegex(
                        RuntimeError,
                        "already exists.*reference-existing",
                    ):
                        registry_handler.handle_registry(
                            "Create",
                            self.registry_props(),
                            {},
                        )

                self.client.create_registry.assert_called_once()

    def test_created_registry_uses_created_physical_id(self):
        self.client.create_registry.return_value = {
            "registryArn":
                "arn:aws:agent-registry:us-west-2:111122223333:"
                "registry/created123456",
        }
        with (
            patch.object(
                registry_handler,
                "find_registry_by_name",
                return_value=None,
            ),
            patch.object(
                registry_handler,
                "wait_for_registry_ready",
                return_value={
                    "registryArn":
                        "arn:aws:agent-registry:us-west-2:111122223333:"
                        "registry/created123456",
                },
            ),
        ):
            result = registry_handler.handle_registry(
                "Create",
                self.registry_props(),
                self.create_event(),
            )

        self.assertEqual(
            result["PhysicalResourceId"],
            "created::created123456",
        )

    def test_registry_create_sends_mandatory_tags_in_initial_request(self):
        self.client.create_registry.return_value = {
            "registryArn":
                "arn:aws:agent-registry:us-west-2:111122223333:"
                "registry/created123456",
        }
        with patch.object(
            registry_handler,
            "wait_for_registry_ready",
            return_value={
                "registryArn":
                    "arn:aws:agent-registry:us-west-2:111122223333:"
                    "registry/created123456",
            },
        ):
            registry_handler.handle_registry(
                "Create",
                self.registry_props(),
                self.create_event(),
            )

        self.assertEqual(
            self.client.create_registry.call_args.kwargs["tags"],
            self.registry_props()["Tags"],
        )

    def test_registry_create_retry_uses_same_token_and_retains_ownership(self):
        self.client.create_registry.return_value = {
            "registryArn":
                "arn:aws:agent-registry:us-west-2:111122223333:"
                "registry/created123456",
        }
        ready = {
            "registryArn":
                "arn:aws:agent-registry:us-west-2:111122223333:"
                "registry/created123456",
        }
        event = self.create_event()
        with (
            patch.object(
                registry_handler,
                "find_registry_by_name",
                return_value=None,
            ),
            patch.object(
                registry_handler,
                "wait_for_registry_ready",
                return_value=ready,
            ),
        ):
            first = registry_handler.handle_registry(
                "Create",
                self.registry_props(),
                event,
            )
            second = registry_handler.handle_registry(
                "Create",
                self.registry_props(),
                event,
            )

        self.assertEqual(first["PhysicalResourceId"], "created::created123456")
        self.assertEqual(second["PhysicalResourceId"], "created::created123456")
        calls = self.client.create_registry.call_args_list
        self.assertEqual(len(calls), 2)
        self.assertEqual(
            calls[0].kwargs["clientToken"],
            calls[1].kwargs["clientToken"],
        )
        self.assertEqual(len(calls[0].kwargs["clientToken"]), 64)

    def test_client_token_changes_with_resource_identity(self):
        event = self.create_event()
        first = registry_handler.create_client_token(
            event,
            "registry:platform_shared",
        )
        repeat = registry_handler.create_client_token(
            event,
            "registry:platform_shared",
        )
        different = registry_handler.create_client_token(
            event,
            "registry:domain_platform",
        )

        self.assertEqual(first, repeat)
        self.assertEqual(len(first), 64)
        self.assertRegex(first, r"^[0-9a-f]{64}$")
        self.assertNotEqual(first, different)

    def test_client_token_is_stable_per_request_and_changes_for_recreate(self):
        resource_key = "registry:platform_shared"
        first = registry_handler.create_client_token(
            self.create_event(request_id="request-create-1"),
            resource_key,
        )
        retry = registry_handler.create_client_token(
            self.create_event(request_id="request-create-1"),
            resource_key,
        )
        recreated = registry_handler.create_client_token(
            self.create_event(request_id="request-create-2"),
            resource_key,
        )

        self.assertEqual(first, retry)
        self.assertNotEqual(first, recreated)
        self.assertLessEqual(len(first), 64)
        self.assertLessEqual(len(recreated), 64)

    def test_registry_missing_arn_recovers_and_compensates(self):
        self.client.create_registry.return_value = {
            "status": "CREATING",
            "requestDetail": "SECRET response detail",
        }
        recovered = {
            "registryId": "created123456",
            "name": "platform_shared",
            "status": "CREATING",
        }
        with (
            patch.object(
                registry_handler,
                "find_registry_by_name",
                return_value=recovered,
            ),
            patch.object(
                registry_handler,
                "compensate_registry_creation",
                return_value=True,
            ) as compensate,
        ):
            with self.assertRaisesRegex(
                RuntimeError,
                "create response omitted registryArn; "
                "compensating delete succeeded",
            ) as raised:
                registry_handler.handle_registry(
                    "Create",
                    self.registry_props(),
                    self.create_event(),
                )

        self.assertNotIn("SECRET", str(raised.exception))
        compensate.assert_called_once_with(
            "created123456",
            "platform_shared",
        )
        self.client.tag_resource.assert_not_called()

    def test_registry_missing_arn_uses_returned_id_for_compensation(self):
        self.client.create_registry.return_value = {
            "registryId": "created123456",
            "status": "CREATING",
        }
        with (
            patch.object(
                registry_handler,
                "find_registry_by_name",
            ) as find,
            patch.object(
                registry_handler,
                "compensate_registry_creation",
                return_value=True,
            ) as compensate,
        ):
            with self.assertRaisesRegex(
                RuntimeError,
                "create response omitted registryArn; "
                "compensating delete succeeded",
            ):
                registry_handler.handle_registry(
                    "Create",
                    self.registry_props(),
                    self.create_event(),
                )

        find.assert_not_called()
        compensate.assert_called_once_with(
            "created123456",
            "platform_shared",
        )

    def test_registry_missing_arn_without_recovery_requires_manual_cleanup(self):
        self.client.create_registry.return_value = {}
        with patch.object(
            registry_handler,
            "find_registry_by_name",
            return_value=None,
        ):
            with self.assertRaisesRegex(
                RuntimeError,
                "create response omitted registryArn and the created "
                "resource could not be recovered; manual cleanup is required",
            ):
                registry_handler.handle_registry(
                    "Create",
                    self.registry_props(),
                    self.create_event(),
                )

        self.client.delete_registry.assert_not_called()
        self.client.tag_resource.assert_not_called()

    def test_registry_missing_arn_recovery_failure_is_sanitized(self):
        self.client.create_registry.return_value = {
            "status": "CREATING",
            "requestDetail": "SECRET create detail",
        }
        with patch.object(
            registry_handler,
            "find_registry_by_name",
            side_effect=RuntimeError("SECRET recovery detail"),
        ):
            with self.assertRaisesRegex(
                RuntimeError,
                "Registry platform_shared create response omitted registryArn "
                "and the created resource could not be recovered; manual "
                "cleanup is required before retry",
            ) as raised:
                registry_handler.handle_registry(
                    "Create",
                    self.registry_props(),
                    self.create_event(),
                )

        self.assertNotIn("SECRET", str(raised.exception))
        self.client.delete_registry.assert_not_called()
        self.client.tag_resource.assert_not_called()

    def test_created_registry_tagging_failure_is_compensated(self):
        self.client.create_registry.return_value = {
            "registryArn":
                "arn:aws:agent-registry:us-west-2:111122223333:"
                "registry/created123456",
        }
        self.client.tag_resource.side_effect = RuntimeError(
            "SECRET tagging detail",
        )
        with (
            patch.object(
                registry_handler,
                "find_registry_by_name",
                return_value=None,
            ),
            patch.object(
                registry_handler,
                "wait_for_registry_ready",
                return_value={
                    "registryArn":
                        "arn:aws:agent-registry:us-west-2:111122223333:"
                        "registry/created123456",
                },
            ),
        ):
            with self.assertRaisesRegex(
                RuntimeError,
                "Mandatory tagging failed for newly created Registry "
                "platform_shared; compensating delete succeeded",
            ) as raised:
                registry_handler.handle_registry(
                    "Create",
                    self.registry_props(),
                    {},
                )

        self.assertNotIn("SECRET", str(raised.exception))
        self.client.delete_registry.assert_called_once_with(
            registryId="created123456",
        )

    def test_created_registry_compensation_failure_is_explicit(self):
        self.client.create_registry.return_value = {
            "registryArn":
                "arn:aws:agent-registry:us-west-2:111122223333:"
                "registry/created123456",
        }
        self.client.tag_resource.side_effect = RuntimeError(
            "SECRET tagging detail",
        )
        self.client.delete_registry.side_effect = RuntimeError(
            "SECRET delete detail",
        )
        with (
            patch.object(
                registry_handler,
                "find_registry_by_name",
                return_value=None,
            ),
            patch.object(
                registry_handler,
                "wait_for_registry_ready",
                return_value={
                    "registryArn":
                        "arn:aws:agent-registry:us-west-2:111122223333:"
                        "registry/created123456",
                },
            ),
        ):
            with self.assertRaisesRegex(
                RuntimeError,
                "Mandatory tagging failed for newly created Registry "
                "platform_shared and compensating delete failed; "
                "manual cleanup is required before retry",
            ) as raised:
                registry_handler.handle_registry(
                    "Create",
                    self.registry_props(),
                    {},
                )

        self.assertNotIn("SECRET", str(raised.exception))
        self.client.delete_registry.assert_called_once_with(
            registryId="created123456",
        )

    def test_created_registry_ready_wait_failure_is_compensated(self):
        self.client.create_registry.return_value = {
            "registryArn":
                "arn:aws:agent-registry:us-west-2:111122223333:"
                "registry/created123456",
        }
        with (
            patch.object(
                registry_handler,
                "find_registry_by_name",
                return_value=None,
            ),
            patch.object(
                registry_handler,
                "wait_for_registry_ready",
                side_effect=TimeoutError("SECRET wait detail"),
            ),
        ):
            with self.assertRaisesRegex(
                RuntimeError,
                "Registry platform_shared provisioning failed; "
                "compensating delete succeeded",
            ) as raised:
                registry_handler.handle_registry(
                    "Create",
                    self.registry_props(),
                    {},
                )

        self.assertNotIn("SECRET", str(raised.exception))
        self.client.delete_registry.assert_called_once_with(
            registryId="created123456",
        )

    def test_registry_ready_response_missing_arn_is_compensated(self):
        self.client.create_registry.return_value = {
            "registryArn":
                "arn:aws:agent-registry:us-west-2:111122223333:"
                "registry/created123456",
        }
        with (
            patch.object(
                registry_handler,
                "wait_for_registry_ready",
                return_value={
                    "registryId": "created123456",
                    "name": "platform_shared",
                    "description": "Shared Registry",
                    "status": "READY",
                    "requestDetail": "SECRET response detail",
                },
            ),
            patch.object(
                registry_handler,
                "compensate_registry_creation",
                return_value=True,
            ) as compensate,
        ):
            with self.assertRaisesRegex(
                RuntimeError,
                "Registry platform_shared READY response omitted "
                "registryArn; compensating delete succeeded",
            ) as raised:
                registry_handler.handle_registry(
                    "Create",
                    self.registry_props(),
                    self.create_event(),
                )

        self.assertNotIn("SECRET", str(raised.exception))
        compensate.assert_called_once_with(
            "created123456",
            "platform_shared",
        )
        self.client.tag_resource.assert_not_called()

    def test_registry_update_failure_propagates(self):
        self.client.update_registry.side_effect = RuntimeError(
            "registry update failed",
        )
        props = self.registry_props()

        with self.assertRaisesRegex(
            RuntimeError,
            "registry update failed",
        ):
            registry_handler.handle_registry(
                "Update",
                props,
                {
                    "PhysicalResourceId": "created::created123456",
                    "OldResourceProperties": dict(props),
                },
            )

        self.client.get_registry.assert_not_called()

    def test_registry_update_reconciles_name_and_description(self):
        old_props = self.registry_props()
        new_props = {
            **old_props,
            "RegistryName": "platform_shared_renamed",
            "Description": "Renamed shared Registry",
        }
        with patch.object(
            registry_handler,
            "wait_for_registry_ready",
            return_value={
                "registryId": "created123456",
                "registryArn":
                    "arn:aws:agent-registry:us-west-2:111122223333:"
                    "registry/created123456",
                "name": "platform_shared_renamed",
                "description": "Renamed shared Registry",
                "status": "READY",
            },
        ):
            result = registry_handler.handle_registry(
                "Update",
                new_props,
                {
                    "PhysicalResourceId": "created::created123456",
                    "OldResourceProperties": old_props,
                },
            )

        self.client.update_registry.assert_called_once_with(
            registryId="created123456",
            name="platform_shared_renamed",
            description="Renamed shared Registry",
        )
        self.assertEqual(
            result["PhysicalResourceId"],
            "created::created123456",
        )
        self.assertEqual(
            result["Data"]["RegistryName"],
            "platform_shared_renamed",
        )

    def test_registry_rollback_reconciles_name_and_description(self):
        old_props = {
            **self.registry_props(),
            "RegistryName": "platform_shared_renamed",
            "Description": "Renamed shared Registry",
        }
        rollback_props = self.registry_props()
        with patch.object(
            registry_handler,
            "wait_for_registry_ready",
            return_value={
                "registryId": "created123456",
                "registryArn":
                    "arn:aws:agent-registry:us-west-2:111122223333:"
                    "registry/created123456",
                "name": "platform_shared",
                "description": "Shared Registry",
                "status": "READY",
            },
        ):
            result = registry_handler.handle_registry(
                "Update",
                rollback_props,
                {
                    "PhysicalResourceId": "created::created123456",
                    "OldResourceProperties": old_props,
                },
            )

        self.client.update_registry.assert_called_once_with(
            registryId="created123456",
            name="platform_shared",
            description="Shared Registry",
        )
        self.assertEqual(
            result["PhysicalResourceId"],
            "created::created123456",
        )
        self.assertEqual(result["Data"]["RegistryName"], "platform_shared")

    def test_registry_description_update_is_verified(self):
        old_props = self.registry_props()
        props = {**old_props, "Description": "Updated description"}
        with patch.object(
            registry_handler,
            "wait_for_registry_ready",
            return_value={
                "registryId": "created123456",
                "registryArn":
                    "arn:aws:agent-registry:us-west-2:111122223333:"
                    "registry/created123456",
                "name": "platform_shared",
                "description": "Updated description",
                "status": "READY",
            },
        ):
            result = registry_handler.handle_registry(
                "Update",
                props,
                {
                    "PhysicalResourceId": "created::created123456",
                    "OldResourceProperties": old_props,
                },
            )

        self.client.update_registry.assert_called_once_with(
            registryId="created123456",
            name="platform_shared",
            description="Updated description",
        )
        self.assertEqual(result["Data"]["RegistryName"], "platform_shared")

    def test_registry_update_fails_when_verified_state_drifted(self):
        old_props = self.registry_props()
        props = {**old_props, "Description": "Updated description"}
        with patch.object(
            registry_handler,
            "wait_for_registry_ready",
            return_value={
                "registryId": "created123456",
                "registryArn":
                    "arn:aws:agent-registry:us-west-2:111122223333:"
                    "registry/created123456",
                "name": "different_name",
                "description": "Old description",
                "status": "READY",
            },
        ):
            with self.assertRaisesRegex(
                RuntimeError,
                "verification failed.*name.*description",
            ):
                registry_handler.handle_registry(
                    "Update",
                    props,
                    {
                        "PhysicalResourceId": "created::created123456",
                        "OldResourceProperties": old_props,
                    },
                )

        self.client.tag_resource.assert_not_called()

    def test_referenced_registry_delete_is_skipped(self):
        result = registry_handler.handle_registry(
            "Delete",
            self.registry_props(),
            {"PhysicalResourceId": "referenced::existing123456"},
        )

        self.assertEqual(
            result["PhysicalResourceId"],
            "referenced::existing123456",
        )
        self.client.delete_registry.assert_not_called()
        self.client.tag_resource.assert_not_called()

    def test_created_registry_delete_calls_delete_once(self):
        registry_handler.handle_registry(
            "Delete",
            self.registry_props(),
            {"PhysicalResourceId": "created::created123456"},
        )

        self.client.delete_registry.assert_called_once_with(
            registryId="created123456",
        )
        self.client.tag_resource.assert_not_called()

    def test_created_registry_delete_propagates_generic_failure(self):
        self.client.delete_registry.side_effect = RuntimeError(
            "retryable registry delete failure",
        )

        with self.assertRaisesRegex(
            RuntimeError,
            "retryable registry delete failure",
        ):
            registry_handler.handle_registry(
                "Delete",
                self.registry_props(),
                {"PhysicalResourceId": "created::created123456"},
            )

    def test_created_registry_delete_treats_not_found_as_success(self):
        self.client.delete_registry.side_effect = ResourceNotFoundException()

        result = registry_handler.handle_registry(
            "Delete",
            self.registry_props(),
            {"PhysicalResourceId": "created::created123456"},
        )

        self.assertEqual(
            result["PhysicalResourceId"],
            "created::created123456",
        )

    def test_created_record_uses_created_physical_id(self):
        self.client.create_registry_record.return_value = {
            "recordArn":
                "arn:aws:agent-registry:us-west-2:111122223333:"
                "registry/registry123456/record/record123456",
            "status": "DRAFT",
        }

        result = registry_handler.handle_registry_record(
            "Create",
            self.record_props(),
            self.create_event("BlueprintRecord"),
        )

        self.assertEqual(
            result["PhysicalResourceId"],
            "created::registry123456/record123456",
        )

    def test_record_create_sends_mandatory_tags_in_initial_request(self):
        tags = {
            "auto-delete": "no",
            "managedBy": "cdk",
            "project": "agentic-ai-platform-demo",
        }
        self.client.create_registry_record.return_value = {
            "recordArn":
                "arn:aws:agent-registry:us-west-2:111122223333:"
                "registry/registry123456/record/record123456",
            "status": "DRAFT",
        }

        registry_handler.handle_registry_record(
            "Create",
            self.record_props(Tags=tags),
            self.create_event("BlueprintRecord"),
        )

        self.assertEqual(
            self.client.create_registry_record.call_args.kwargs["tags"],
            tags,
        )

    def test_record_create_retry_uses_same_token_and_retains_ownership(self):
        self.client.create_registry_record.return_value = {
            "recordArn":
                "arn:aws:agent-registry:us-west-2:111122223333:"
                "registry/registry123456/record/record123456",
            "status": "DRAFT",
        }
        event = self.create_event("BlueprintRecord")

        first = registry_handler.handle_registry_record(
            "Create",
            self.record_props(),
            event,
        )
        second = registry_handler.handle_registry_record(
            "Create",
            self.record_props(),
            event,
        )

        self.assertEqual(
            first["PhysicalResourceId"],
            "created::registry123456/record123456",
        )
        self.assertEqual(
            second["PhysicalResourceId"],
            "created::registry123456/record123456",
        )
        calls = self.client.create_registry_record.call_args_list
        self.assertEqual(len(calls), 2)
        self.assertEqual(
            calls[0].kwargs["clientToken"],
            calls[1].kwargs["clientToken"],
        )
        self.assertEqual(len(calls[0].kwargs["clientToken"]), 64)

    def test_record_missing_arn_recovers_and_compensates(self):
        self.client.create_registry_record.return_value = {
            "status": "CREATING",
            "requestDetail": "SECRET response detail",
        }
        with (
            patch.object(
                registry_handler,
                "find_record",
                return_value=self.record_state(status="CREATING"),
            ),
            patch.object(
                registry_handler,
                "compensate_record_creation",
                return_value=True,
            ) as compensate,
        ):
            with self.assertRaisesRegex(
                RuntimeError,
                "create response omitted recordArn; "
                "compensating delete succeeded",
            ) as raised:
                registry_handler.handle_registry_record(
                    "Create",
                    self.record_props(),
                    self.create_event("BlueprintRecord"),
                )

        self.assertNotIn("SECRET", str(raised.exception))
        compensate.assert_called_once_with(
            "registry123456",
            "record123456",
            "blueprint_test",
        )
        self.client.tag_resource.assert_not_called()

    def test_record_missing_arn_uses_returned_id_for_compensation(self):
        self.client.create_registry_record.return_value = {
            "recordId": "record123456",
            "status": "CREATING",
        }
        with (
            patch.object(registry_handler, "find_record") as find,
            patch.object(
                registry_handler,
                "compensate_record_creation",
                return_value=True,
            ) as compensate,
        ):
            with self.assertRaisesRegex(
                RuntimeError,
                "create response omitted recordArn; "
                "compensating delete succeeded",
            ):
                registry_handler.handle_registry_record(
                    "Create",
                    self.record_props(),
                    self.create_event("BlueprintRecord"),
                )

        find.assert_not_called()
        compensate.assert_called_once_with(
            "registry123456",
            "record123456",
            "blueprint_test",
        )

    def test_record_missing_arn_without_recovery_requires_manual_cleanup(self):
        self.client.create_registry_record.return_value = {}
        with patch.object(
            registry_handler,
            "find_record",
            side_effect=RuntimeError("SECRET recovery detail"),
        ):
            with self.assertRaisesRegex(
                RuntimeError,
                "create response omitted recordArn and the created "
                "resource could not be recovered; manual cleanup is required",
            ) as raised:
                registry_handler.handle_registry_record(
                    "Create",
                    self.record_props(),
                    self.create_event("BlueprintRecord"),
                )

        self.assertNotIn("SECRET", str(raised.exception))
        self.client.delete_registry_record.assert_not_called()
        self.client.tag_resource.assert_not_called()

    def test_created_record_tagging_failure_is_compensated(self):
        self.client.create_registry_record.return_value = {
            "recordArn":
                "arn:aws:agent-registry:us-west-2:111122223333:"
                "registry/registry123456/record/record123456",
            "status": "DRAFT",
        }
        self.client.tag_resource.side_effect = RuntimeError(
            "SECRET tagging detail",
        )

        with self.assertRaisesRegex(
            RuntimeError,
            "Mandatory tagging failed for newly created Registry record "
            "blueprint_test@1.0.0; compensating delete succeeded",
        ) as raised:
            registry_handler.handle_registry_record(
                "Create",
                self.record_props(),
                {},
            )

        self.assertNotIn("SECRET", str(raised.exception))
        self.client.delete_registry_record.assert_called_once_with(
            registryId="registry123456",
            recordId="record123456",
        )

    def test_created_record_compensation_failure_is_explicit(self):
        self.client.create_registry_record.return_value = {
            "recordArn":
                "arn:aws:agent-registry:us-west-2:111122223333:"
                "registry/registry123456/record/record123456",
            "status": "DRAFT",
        }
        self.client.tag_resource.side_effect = RuntimeError(
            "SECRET tagging detail",
        )
        self.client.delete_registry_record.side_effect = RuntimeError(
            "SECRET delete detail",
        )

        with self.assertRaisesRegex(
            RuntimeError,
            "Mandatory tagging failed for newly created Registry record "
            "blueprint_test@1.0.0 and compensating delete failed; "
            "manual cleanup is required before retry",
        ) as raised:
            registry_handler.handle_registry_record(
                "Create",
                self.record_props(),
                {},
            )

        self.assertNotIn("SECRET", str(raised.exception))
        self.client.delete_registry_record.assert_called_once_with(
            registryId="registry123456",
            recordId="record123456",
        )

    def test_record_conflict_uses_referenced_physical_id(self):
        self.client.create_registry_record.side_effect = ConflictException()
        with patch.object(
            registry_handler,
            "find_record",
            return_value=self.record_state(),
        ):
            result = registry_handler.handle_registry_record(
                "Create",
                self.record_props(),
                {},
            )

        self.assertEqual(
            result["PhysicalResourceId"],
            "referenced::registry123456/record123456",
        )

    def test_referenced_record_is_never_mutated(self):
        self.client.create_registry_record.side_effect = ConflictException()
        with patch.object(
            registry_handler,
            "find_record",
            return_value=self.record_state(),
        ):
            result = registry_handler.handle_registry_record(
                "Create",
                self.record_props(),
                {},
            )

        self.assertEqual(result["Data"]["Status"], "DRAFT")
        self.client.tag_resource.assert_not_called()
        self.client.submit_registry_record_for_approval.assert_not_called()
        self.client.update_registry_record_status.assert_not_called()
        self.client.delete_registry_record.assert_not_called()

    def test_referenced_record_requires_existing_target_status(self):
        self.client.create_registry_record.side_effect = ConflictException()
        with patch.object(
            registry_handler,
            "find_record",
            return_value=self.record_state(status="DRAFT"),
        ):
            with self.assertRaisesRegex(
                RuntimeError,
                "referenced Registry record.*status DRAFT.*requires APPROVED",
            ):
                registry_handler.handle_registry_record(
                    "Create",
                    self.record_props(StatusTarget="APPROVED"),
                    {},
                )

        self.client.tag_resource.assert_not_called()
        self.client.submit_registry_record_for_approval.assert_not_called()
        self.client.update_registry_record_status.assert_not_called()
        self.client.delete_registry_record.assert_not_called()

    def test_same_key_update_preserves_created_ownership_when_content_matches(self):
        props = self.record_props()
        self.client.get_registry_record.side_effect = None
        self.client.get_registry_record.return_value = self.record_state()

        result = registry_handler.handle_registry_record(
            "Update",
            props,
            {
                "PhysicalResourceId":
                    "created::registry123456/record123456",
                "OldResourceProperties": dict(props),
            },
        )

        self.assertEqual(
            result["PhysicalResourceId"],
            "created::registry123456/record123456",
        )
        self.client.create_registry_record.assert_not_called()
        self.client.tag_resource.assert_not_called()
        self.client.submit_registry_record_for_approval.assert_not_called()
        self.client.update_registry_record_status.assert_not_called()

    def test_same_key_update_requires_version_bump_when_content_changes(self):
        props = self.record_props(Description="Changed description")
        old_props = self.record_props()
        self.client.get_registry_record.side_effect = None
        self.client.get_registry_record.return_value = self.record_state()

        with self.assertRaisesRegex(
            RuntimeError,
            "immutable.*version bump",
        ):
            registry_handler.handle_registry_record(
                "Update",
                props,
                {
                    "PhysicalResourceId":
                        "created::registry123456/record123456",
                    "OldResourceProperties": old_props,
                },
            )

        self.client.create_registry_record.assert_not_called()
        self.client.tag_resource.assert_not_called()

    def test_same_key_update_rejects_unmet_status_minimum_before_mutation(self):
        old_props = self.record_props(StatusTarget="DRAFT")
        props = self.record_props(StatusTarget="APPROVED")
        self.client.get_registry_record.side_effect = None
        self.client.get_registry_record.return_value = self.record_state(
            status="DRAFT",
        )

        with self.assertRaisesRegex(
            RuntimeError,
            "actual status DRAFT does not satisfy minimum "
            "StatusTarget APPROVED.*version bump",
        ):
            registry_handler.handle_registry_record(
                "Update",
                props,
                {
                    "PhysicalResourceId":
                        "created::registry123456/record123456",
                    "OldResourceProperties": old_props,
                },
            )

        self.client.tag_resource.assert_not_called()
        self.client.submit_registry_record_for_approval.assert_not_called()
        self.client.update_registry_record_status.assert_not_called()

    def test_same_key_rollback_accepts_an_earlier_status_minimum(self):
        old_props = self.record_props(StatusTarget="APPROVED")
        props = self.record_props(StatusTarget="DRAFT")
        self.client.get_registry_record.side_effect = None
        self.client.get_registry_record.return_value = self.record_state(
            status="APPROVED",
        )

        result = registry_handler.handle_registry_record(
            "Update",
            props,
            {
                "PhysicalResourceId":
                    "created::registry123456/record123456",
                "OldResourceProperties": old_props,
            },
        )

        self.assertEqual(
            result["PhysicalResourceId"],
            "created::registry123456/record123456",
        )
        self.assertEqual(result["Data"]["Status"], "APPROVED")
        self.client.tag_resource.assert_not_called()
        self.client.submit_registry_record_for_approval.assert_not_called()
        self.client.update_registry_record_status.assert_not_called()

    def test_same_key_update_accepts_status_beyond_the_minimum(self):
        cases = (
            ("PENDING_APPROVAL", "DRAFT"),
            ("APPROVED", "PENDING_APPROVAL"),
        )
        for actual_status, desired_target in cases:
            with self.subTest(
                actual_status=actual_status,
                desired_target=desired_target,
            ):
                self.client.reset_mock()
                self.client.get_registry_record.side_effect = None
                self.client.get_registry_record.return_value = (
                    self.record_state(status=actual_status)
                )
                old_props = self.record_props(StatusTarget="APPROVED")
                props = self.record_props(StatusTarget=desired_target)

                result = registry_handler.handle_registry_record(
                    "Update",
                    props,
                    {
                        "PhysicalResourceId":
                            "created::registry123456/record123456",
                        "OldResourceProperties": old_props,
                    },
                )

                self.assertEqual(result["Data"]["Status"], actual_status)
                self.client.tag_resource.assert_not_called()
                self.client.submit_registry_record_for_approval.assert_not_called()
                self.client.update_registry_record_status.assert_not_called()

    def test_same_key_update_rejects_a_different_physical_record(self):
        props = self.record_props()
        self.client.get_registry_record.side_effect = None
        self.client.get_registry_record.return_value = self.record_state(
            name="different_record",
        )

        with self.assertRaisesRegex(
            RuntimeError,
            "physical record identity does not match",
        ):
            registry_handler.handle_registry_record(
                "Update",
                props,
                {
                    "PhysicalResourceId":
                        "created::registry123456/record123456",
                    "OldResourceProperties": dict(props),
                },
            )

        self.client.create_registry_record.assert_not_called()
        self.client.tag_resource.assert_not_called()

    def test_key_change_conflict_never_transfers_created_ownership(self):
        old_props = self.record_props(
            RecordName="blueprint_old",
            RecordVersion="1.0.0",
        )
        new_props = self.record_props(
            RecordName="blueprint_new",
            RecordVersion="2.0.0",
        )
        self.client.create_registry_record.side_effect = ConflictException()
        with patch.object(
            registry_handler,
            "find_record",
            return_value=self.record_state(
                recordId="different456789",
                recordArn=(
                    "arn:aws:agent-registry:us-west-2:111122223333:"
                    "registry/registry123456/record/different456789"
                ),
                name="blueprint_new",
                recordVersion="2.0.0",
            ),
        ):
            result = registry_handler.handle_registry_record(
                "Update",
                new_props,
                {
                    "PhysicalResourceId":
                        "created::registry123456/record/old123456",
                    "OldResourceProperties": old_props,
                },
            )

        self.assertEqual(
            result["PhysicalResourceId"],
            "referenced::registry123456/different456789",
        )
        self.client.tag_resource.assert_not_called()
        self.client.delete_registry_record.assert_not_called()

    def test_created_record_wait_failure_is_compensated(self):
        self.client.create_registry_record.return_value = {
            "recordArn":
                "arn:aws:agent-registry:us-west-2:111122223333:"
                "registry/registry123456/record/record123456",
            "status": "CREATING",
        }
        with patch.object(
            registry_handler,
            "wait_for_record_status",
            side_effect=TimeoutError("SECRET wait detail"),
        ):
            with self.assertRaisesRegex(
                RuntimeError,
                "Registry record blueprint_test@1.0.0 provisioning failed; "
                "compensating delete succeeded",
            ) as raised:
                registry_handler.handle_registry_record(
                    "Create",
                    self.record_props(),
                    {},
                )

        self.assertNotIn("SECRET", str(raised.exception))
        self.client.delete_registry_record.assert_called_once_with(
            registryId="registry123456",
            recordId="record123456",
        )

    def test_created_record_approval_failure_is_compensated(self):
        self.client.create_registry_record.return_value = {
            "recordArn":
                "arn:aws:agent-registry:us-west-2:111122223333:"
                "registry/registry123456/record/record123456",
            "status": "DRAFT",
        }
        self.client.submit_registry_record_for_approval.side_effect = (
            RuntimeError("SECRET approval detail")
        )

        with self.assertRaisesRegex(
            RuntimeError,
            "Registry record blueprint_test@1.0.0 provisioning failed; "
            "compensating delete succeeded",
        ) as raised:
            registry_handler.handle_registry_record(
                "Create",
                self.record_props(StatusTarget="APPROVED"),
                {},
            )

        self.assertNotIn("SECRET", str(raised.exception))
        self.client.delete_registry_record.assert_called_once_with(
            registryId="registry123456",
            recordId="record123456",
        )

    def test_pending_approval_record_is_approved_and_verified(self):
        self.client.create_registry_record.return_value = {
            "recordArn":
                "arn:aws:agent-registry:us-west-2:111122223333:"
                "registry/registry123456/record/record123456",
            "status": "PENDING_APPROVAL",
        }
        with patch.object(
            registry_handler,
            "wait_for_record_status",
            return_value=self.record_state(status="APPROVED"),
        ) as wait:
            result = registry_handler.handle_registry_record(
                "Create",
                self.record_props(StatusTarget="APPROVED"),
                {},
            )

        self.client.submit_registry_record_for_approval.assert_not_called()
        self.client.update_registry_record_status.assert_called_once()
        wait.assert_called_once()
        self.assertEqual(result["Data"]["Status"], "APPROVED")

    def test_pending_target_submits_and_verifies_without_approving(self):
        self.client.create_registry_record.return_value = {
            "recordArn":
                "arn:aws:agent-registry:us-west-2:111122223333:"
                "registry/registry123456/record/record123456",
            "status": "DRAFT",
        }
        with patch.object(
            registry_handler,
            "wait_for_record_status",
            return_value=self.record_state(status="PENDING_APPROVAL"),
        ) as wait:
            result = registry_handler.handle_registry_record(
                "Create",
                self.record_props(StatusTarget="PENDING_APPROVAL"),
                {
                    "StackId": "stack-123",
                    "LogicalResourceId": "ContractReviewRecord",
                },
            )

        self.client.submit_registry_record_for_approval.assert_called_once_with(
            registryId="registry123456",
            recordId="record123456",
        )
        self.client.update_registry_record_status.assert_not_called()
        wait.assert_called_once()
        self.assertEqual(result["Data"]["Status"], "PENDING_APPROVAL")

    def test_handler_accepts_all_real_seed_status_targets(self):
        for target in ("DRAFT", "PENDING_APPROVAL", "APPROVED"):
            with self.subTest(target=target):
                self.assertEqual(
                    registry_handler.validate_status_target(target),
                    target,
                )

    def test_all_23_real_seed_statuses_route_through_handler(self):
        repo_root = Path(__file__).resolve().parents[3]
        seed = json.loads(
            (repo_root / "console" / "registry-seed.json").read_text()
        )
        catalog = json.loads(
            (repo_root / "console" / "catalog.json").read_text()
        )
        cases = []
        for entry in seed:
            if entry["type"] not in ("Skill", "A2AAgent"):
                continue
            prefix = "skill" if entry["type"] == "Skill" else "a2a"
            record_name = re.sub(
                r"[^A-Za-z0-9]+",
                "_",
                f"{prefix}_{entry['id']}",
            ).strip("_")
            for version in entry.get("versions", []):
                target = version.get("status") or "APPROVED"
                if target == "IN_REVIEW":
                    target = "PENDING_APPROVAL"
                cases.append(
                    (
                        record_name,
                        version["semver"],
                        target,
                    )
                )
        cases.extend(
            (
                re.sub(
                    r"[^A-Za-z0-9]+",
                    "_",
                    f"blueprint_{blueprint['id']}",
                ).strip("_"),
                "1.0.0",
                "APPROVED",
            )
            for blueprint in catalog.get("blueprints", [])
        )

        self.assertEqual(len(cases), 23)
        self.assertIn(
            ("a2a_contract_review", "1.0.0", "PENDING_APPROVAL"),
            cases,
        )

        for index, (name, version, target) in enumerate(cases):
            with self.subTest(name=name, version=version, target=target):
                record_id = f"record{index:06d}"
                initial_status = (
                    "DRAFT"
                    if target == "PENDING_APPROVAL"
                    else target
                )
                self.client.create_registry_record.reset_mock(
                    return_value=True,
                    side_effect=True,
                )
                self.client.create_registry_record.return_value = {
                    "recordArn":
                        "arn:aws:agent-registry:us-west-2:111122223333:"
                        f"registry/registry123456/record/{record_id}",
                    "status": initial_status,
                }
                self.client.submit_registry_record_for_approval.reset_mock()
                self.client.update_registry_record_status.reset_mock()
                props = self.record_props(
                    RecordName=name,
                    DisplayName=name,
                    RecordVersion=version,
                    StatusTarget=target,
                )
                pending_record = {
                    "registryId": "registry123456",
                    "recordId": record_id,
                    "recordArn":
                        "arn:aws:agent-registry:us-west-2:111122223333:"
                        f"registry/registry123456/record/{record_id}",
                    "status": "PENDING_APPROVAL",
                }
                with patch.object(
                    registry_handler,
                    "wait_for_record_status",
                    return_value=pending_record,
                ):
                    result = registry_handler.handle_registry_record(
                        "Create",
                        props,
                        self.create_event(f"SeedRecord{index}"),
                    )

                self.assertEqual(result["Data"]["Status"], target)
                if target == "PENDING_APPROVAL":
                    self.client.submit_registry_record_for_approval\
                        .assert_called_once()
                    self.client.update_registry_record_status\
                        .assert_not_called()

    def test_record_never_claims_approved_without_observing_it(self):
        self.client.create_registry_record.return_value = {
            "recordArn":
                "arn:aws:agent-registry:us-west-2:111122223333:"
                "registry/registry123456/record/record123456",
            "status": "PENDING_APPROVAL",
        }
        with patch.object(
            registry_handler,
            "wait_for_record_status",
            side_effect=TimeoutError("APPROVED was never observed"),
        ):
            with self.assertRaisesRegex(
                RuntimeError,
                "provisioning failed; compensating delete succeeded",
            ):
                registry_handler.handle_registry_record(
                    "Create",
                    self.record_props(StatusTarget="APPROVED"),
                    {},
                )

        self.client.update_registry_record_status.assert_called_once()
        self.client.delete_registry_record.assert_called_once_with(
            registryId="registry123456",
            recordId="record123456",
        )

    def test_record_lifecycle_uses_one_total_deadline(self):
        self.client.create_registry_record.return_value = {
            "recordArn":
                "arn:aws:agent-registry:us-west-2:111122223333:"
                "registry/registry123456/record/record123456",
            "status": "CREATING",
        }
        observed_deadlines = []

        def wait_for_status(
            registry_id,
            record_id,
            name,
            target_statuses,
            deadline,
        ):
            observed_deadlines.append(deadline)
            if "DRAFT" in target_statuses:
                return self.record_state(status="DRAFT")
            return self.record_state(status="APPROVED")

        with (
            patch.object(
                registry_handler,
                "wait_for_record_status",
                side_effect=wait_for_status,
            ),
            patch.object(
                registry_handler.time,
                "monotonic",
                return_value=100.0,
            ),
        ):
            result = registry_handler.handle_registry_record(
                "Create",
                self.record_props(StatusTarget="APPROVED"),
                {},
            )

        self.assertEqual(result["Data"]["Status"], "APPROVED")
        self.assertGreaterEqual(len(observed_deadlines), 2)
        self.assertEqual(
            observed_deadlines,
            [observed_deadlines[0]] * len(observed_deadlines),
        )

    def test_record_polling_propagates_access_errors(self):
        self.client.get_registry_record.side_effect = PermissionError(
            "access denied",
        )

        with self.assertRaisesRegex(PermissionError, "access denied"):
            registry_handler.wait_for_record_status(
                "registry123456",
                "record123456",
                "blueprint_test",
                ["DRAFT"],
                200.0,
            )

    def test_record_polling_rejects_terminal_failure(self):
        self.client.get_registry_record.side_effect = None
        self.client.get_registry_record.return_value = self.record_state(
            status="CREATE_FAILED",
        )

        with self.assertRaisesRegex(
            RuntimeError,
            "entered terminal state CREATE_FAILED",
        ):
            registry_handler.wait_for_record_status(
                "registry123456",
                "record123456",
                "blueprint_test",
                ["DRAFT"],
                200.0,
            )

    def test_referenced_record_delete_is_skipped(self):
        result = registry_handler.handle_registry_record(
            "Delete",
            self.record_props(),
            {
                "PhysicalResourceId":
                    "referenced::registry123456/record123456",
            },
        )

        self.assertEqual(
            result["PhysicalResourceId"],
            "referenced::registry123456/record123456",
        )
        self.client.delete_registry_record.assert_not_called()
        self.client.tag_resource.assert_not_called()

    def test_created_record_delete_calls_delete_once(self):
        registry_handler.handle_registry_record(
            "Delete",
            self.record_props(),
            {
                "PhysicalResourceId":
                    "created::registry123456/record123456",
            },
        )

        self.client.delete_registry_record.assert_called_once_with(
            registryId="registry123456",
            recordId="record123456",
        )
        self.client.tag_resource.assert_not_called()

    def test_created_record_delete_propagates_generic_failure(self):
        self.client.delete_registry_record.side_effect = RuntimeError(
            "retryable record delete failure",
        )

        with self.assertRaisesRegex(
            RuntimeError,
            "retryable record delete failure",
        ):
            registry_handler.handle_registry_record(
                "Delete",
                self.record_props(),
                {
                    "PhysicalResourceId":
                        "created::registry123456/record123456",
                },
            )

    def test_created_record_delete_treats_not_found_as_success(self):
        self.client.delete_registry_record.side_effect = (
            ResourceNotFoundException()
        )

        result = registry_handler.handle_registry_record(
            "Delete",
            self.record_props(),
            {
                "PhysicalResourceId":
                    "created::registry123456/record123456",
            },
        )

        self.assertEqual(
            result["PhysicalResourceId"],
            "created::registry123456/record123456",
        )

    def test_referenced_delete_is_complete_immediately(self):
        result = registry_handler.is_complete_handler(
            {
                "RequestType": "Delete",
                "ResourceProperties": {
                    "ResourceType": "RegistryRecord",
                },
                "PhysicalResourceId":
                    "referenced::registry123456/record123456",
            },
            None,
        )

        self.assertEqual(result, {"IsComplete": True})
        self.client.get_registry_record.assert_not_called()

    def test_created_registry_delete_waits_until_absent(self):
        event = {
            "RequestType": "Delete",
            "ResourceProperties": {"ResourceType": "Registry"},
            "PhysicalResourceId": "created::created123456",
        }
        self.client.get_registry.side_effect = None
        self.client.get_registry.return_value = {"status": "DELETING"}

        self.assertEqual(
            registry_handler.is_complete_handler(event, None),
            {"IsComplete": False},
        )

        self.client.get_registry.side_effect = ResourceNotFoundException()
        self.assertEqual(
            registry_handler.is_complete_handler(event, None),
            {"IsComplete": True},
        )

    def test_created_record_delete_waits_until_absent(self):
        event = {
            "RequestType": "Delete",
            "ResourceProperties": {"ResourceType": "RegistryRecord"},
            "PhysicalResourceId":
                "created::registry123456/record123456",
        }
        self.client.get_registry_record.side_effect = None
        self.client.get_registry_record.return_value = self.record_state(
            status="DELETING",
        )

        self.assertEqual(
            registry_handler.is_complete_handler(event, None),
            {"IsComplete": False},
        )

        self.client.get_registry_record.side_effect = (
            ResourceNotFoundException()
        )
        self.assertEqual(
            registry_handler.is_complete_handler(event, None),
            {"IsComplete": True},
        )

    def test_delete_stabilization_propagates_generic_errors(self):
        self.client.get_registry.side_effect = RuntimeError(
            "registry lookup failed",
        )

        with self.assertRaisesRegex(
            RuntimeError,
            "registry lookup failed",
        ):
            registry_handler.is_complete_handler(
                {
                    "RequestType": "Delete",
                    "ResourceProperties": {
                        "ResourceType": "Registry",
                    },
                    "PhysicalResourceId": "created::created123456",
                },
                None,
            )

    def test_registry_compensation_waits_until_absent(self):
        self.client.get_registry.side_effect = [
            {"status": "DELETING"},
            ResourceNotFoundException(),
        ]
        with patch.object(registry_handler.time, "sleep"):
            result = registry_handler.compensate_registry_creation(
                "created123456",
                "platform_shared",
            )

        self.assertTrue(result)
        self.assertEqual(self.client.get_registry.call_count, 2)

    def test_registry_compensation_rejects_delete_failed(self):
        self.client.get_registry.side_effect = None
        self.client.get_registry.return_value = {"status": "DELETE_FAILED"}

        self.assertFalse(
            registry_handler.compensate_registry_creation(
                "created123456",
                "platform_shared",
            )
        )

    def test_registry_compensation_timeout_requires_manual_cleanup(self):
        self.client.get_registry.side_effect = None
        self.client.get_registry.return_value = {"status": "DELETING"}
        with (
            patch.object(
                registry_handler,
                "cleanup_deadline_after",
                return_value=100.0,
            ),
            patch.object(
                registry_handler.time,
                "monotonic",
                return_value=100.0,
            ),
        ):
            self.assertFalse(
                registry_handler.compensate_registry_creation(
                    "created123456",
                    "platform_shared",
                )
            )

    def test_record_compensation_waits_until_absent(self):
        self.client.get_registry_record.side_effect = [
            self.record_state(status="DELETING"),
            ResourceNotFoundException(),
        ]
        with patch.object(registry_handler.time, "sleep"):
            result = registry_handler.compensate_record_creation(
                "registry123456",
                "record123456",
                "blueprint_test",
            )

        self.assertTrue(result)
        self.assertEqual(self.client.get_registry_record.call_count, 2)

    def test_record_compensation_rejects_delete_failed(self):
        self.client.get_registry_record.side_effect = None
        self.client.get_registry_record.return_value = self.record_state(
            status="DELETE_FAILED",
        )

        self.assertFalse(
            registry_handler.compensate_record_creation(
                "registry123456",
                "record123456",
                "blueprint_test",
            )
        )


if __name__ == "__main__":
    unittest.main()
