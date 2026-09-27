"""
Custom Resource Lambda for AWS Agent Registry management.

The on-event handler starts creates, updates, and deletes. The is-complete
handler stabilizes asynchronous deletes. Physical IDs encode whether the stack
created a resource so referenced resources are never mutated or deleted.
"""
import hashlib
import os
import re
import time

import boto3


REGION = os.environ.get("REGISTRY_REGION", "us-west-2")
client = boto3.client("agent-registry-control", region_name=REGION)
iam_client = boto3.client("iam")

POLL_INTERVAL = 10
MAX_WAIT = 240
CLEANUP_WAIT = 30
CREATED = "created"
REFERENCED = "referenced"
DEFAULT_TAGS = {
    "project": "agentic-ai-platform-demo",
    "managedBy": "cdk",
    "auto-delete": "no",
}
REGISTRY_TRANSIENT_STATUSES = {"CREATING", "UPDATING"}
REGISTRY_TERMINAL_FAILURE_STATUSES = {
    "CREATE_FAILED",
    "UPDATE_FAILED",
    "DELETE_FAILED",
}
RECORD_ACTIONABLE_STATUSES = {"DRAFT", "PENDING_APPROVAL", "APPROVED"}
RECORD_TERMINAL_FAILURE_STATUSES = {
    "CREATE_FAILED",
    "UPDATE_FAILED",
    "DELETE_FAILED",
    "REJECTED",
}
SUPPORTED_STATUS_TARGETS = {"DRAFT", "PENDING_APPROVAL", "APPROVED"}
STATUS_TARGET_RANK = {
    "DRAFT": 0,
    "PENDING_APPROVAL": 1,
    "APPROVED": 2,
}
CONTROL_PLANE_BOUNDARY_ARN_PATTERN = re.compile(
    r"^arn:(aws|aws-cn|aws-us-gov):iam::\d{12}:policy/"
    r"AgenticPlatform-ControlPlane-RuntimePermissionsBoundary$"
)


def handler(event, context):
    """CDK Provider on-event handler."""
    request_type = event["RequestType"]
    props = event["ResourceProperties"]
    resource_type = props.get("ResourceType", "Registry")

    if resource_type == "Registry":
        return handle_registry(request_type, props, event)
    if resource_type == "RegistryRecord":
        return handle_registry_record(request_type, props, event)
    if resource_type == "ManagedPolicyTags":
        return handle_managed_policy_tags(request_type, props, event)
    raise ValueError(f"Unknown ResourceType: {resource_type}")


def is_complete_handler(event, context):
    """CDK Provider is-complete handler for asynchronous deletion."""
    if event.get("RequestType") != "Delete":
        return {"IsComplete": True}

    ownership, resource_key = parse_physical_id(
        event.get("PhysicalResourceId", "")
    )
    if ownership != CREATED:
        return {"IsComplete": True}

    resource_type = event.get("ResourceProperties", {}).get(
        "ResourceType",
        "Registry",
    )
    if resource_type == "ManagedPolicyTags":
        return {"IsComplete": True}
    try:
        if resource_type == "Registry":
            client.get_registry(registryId=resource_key)
        elif resource_type == "RegistryRecord":
            registry_id, record_id = parse_record_resource_key(resource_key)
            client.get_registry_record(
                registryId=registry_id,
                recordId=record_id,
            )
        else:
            raise ValueError(f"Unknown ResourceType: {resource_type}")
    except client.exceptions.ResourceNotFoundException:
        return {"IsComplete": True}

    return {"IsComplete": False}


def exact_managed_policy_tags(response):
    """Return one complete, unambiguous IAM managed-policy tag set."""
    if response.get("IsTruncated") is True:
        raise ValueError("Invalid managed policy tag response")
    raw_tags = response.get("Tags")
    if not isinstance(raw_tags, list):
        raise ValueError("Invalid managed policy tag response")

    tags = {}
    for tag in raw_tags:
        if (
            not isinstance(tag, dict)
            or set(tag) != {"Key", "Value"}
            or not isinstance(tag["Key"], str)
            or not isinstance(tag["Value"], str)
            or not tag["Key"]
            or tag["Key"] in tags
        ):
            raise ValueError("Invalid managed policy tag response")
        tags[tag["Key"]] = tag["Value"]
    return tags


def handle_managed_policy_tags(request_type, props, event):
    """Reconcile exact mandatory tags on the stack-owned IAM boundary."""
    physical_id = event.get("PhysicalResourceId", "")
    if request_type == "Delete":
        return {"PhysicalResourceId": physical_id}

    policy_arn = props.get("PolicyArn", "")
    if not CONTROL_PLANE_BOUNDARY_ARN_PATTERN.fullmatch(policy_arn):
        raise ValueError("PolicyArn is not the owned control-plane boundary")

    tags = props.get("Tags", DEFAULT_TAGS)
    if tags != DEFAULT_TAGS:
        raise ValueError("ManagedPolicyTags requires the exact mandatory tags")

    current = exact_managed_policy_tags(
        iam_client.list_policy_tags(PolicyArn=policy_arn)
    )
    removed_keys = sorted(set(current) - set(tags))
    if removed_keys:
        iam_client.untag_policy(
            PolicyArn=policy_arn,
            TagKeys=removed_keys,
        )
    iam_client.tag_policy(
        PolicyArn=policy_arn,
        Tags=[
            {"Key": key, "Value": value}
            for key, value in tags.items()
        ],
    )

    verified = exact_managed_policy_tags(
        iam_client.list_policy_tags(PolicyArn=policy_arn)
    )
    if verified != tags:
        raise RuntimeError(
            "Managed policy mandatory tag reconciliation failed"
        )

    digest = hashlib.sha256(policy_arn.encode("utf-8")).hexdigest()[:32]
    return {
        "PhysicalResourceId": f"managed-policy-tags::{digest}",
    }


def handle_registry(request_type, props, event):
    """Create, update, or start deleting a Registry."""
    name = props["RegistryName"]
    description = props.get("Description", f"Platform registry: {name}")
    tags = props.get("Tags", DEFAULT_TAGS)

    if request_type == "Create":
        client_token = create_client_token(event, f"registry:{name}")
        try:
            response = client.create_registry(
                name=name,
                description=description,
                clientToken=client_token,
                tags=tags,
            )
        except client.exceptions.ConflictException:
            existing = find_registry_by_name(name)
            if existing:
                registry_id = existing["registryId"]
                raise RuntimeError(
                    f"Registry {name} already exists ({registry_id}, "
                    f"status {existing.get('status', 'UNKNOWN')}); "
                    "use reference-existing mode instead of provision mode."
                ) from None
            raise RuntimeError(
                f"Registry {name} creation conflicted; use "
                "reference-existing mode if the Registry already exists."
            ) from None

        registry_arn = response.get("registryArn")
        if not registry_arn:
            registry_id = response.get("registryId")
            if not registry_id:
                try:
                    recovered = find_registry_by_name(name)
                    registry_id = (
                        recovered.get("registryId")
                        if isinstance(recovered, dict)
                        else None
                    )
                except Exception:
                    registry_id = None
            if registry_id:
                raise_compensated_registry_failure(
                    registry_id,
                    name,
                    f"Registry {name} create response omitted registryArn",
                )
            raise RuntimeError(
                f"Registry {name} create response omitted registryArn and "
                "the created resource could not be recovered; manual cleanup "
                "is required before retry."
            ) from None

        registry_id = registry_arn.split("/")[-1]
        deadline = deadline_after()
        print(f"Registry {name} created: {registry_id}")

        failure_message = f"Registry {name} provisioning failed"
        try:
            registry = wait_for_registry_ready(
                registry_id,
                name,
                deadline,
            )
            registry.setdefault("registryId", registry_id)
            registry_arn = registry.get("registryArn")
            if not registry_arn:
                failure_message = (
                    f"Registry {name} READY response omitted registryArn"
                )
                raise RuntimeError(failure_message)

            failure_message = (
                "Mandatory tagging failed for newly created Registry "
                f"{name}"
            )
            tag_resource(registry_arn, tags, f"registry {name}")

            return registry_result(
                owned_physical_id(CREATED, registry_id),
                registry,
                name,
            )
        except Exception:
            raise_compensated_registry_failure(
                registry_id,
                name,
                failure_message,
            )

    if request_type == "Update":
        physical_id = event.get("PhysicalResourceId", "")
        ownership, registry_id = parse_physical_id(physical_id)
        if ownership != CREATED:
            raise RuntimeError(
                f"Registry {name} update requires a created:: physical ID"
            )
        old_props = event.get("OldResourceProperties")
        if not isinstance(old_props, dict):
            raise RuntimeError(
                "Registry Update requires OldResourceProperties"
            )

        client.update_registry(
            registryId=registry_id,
            name=name,
            description=description,
        )
        registry = wait_for_registry_ready(
            registry_id,
            name,
            deadline_after(),
        )
        assert_registry_state(
            registry,
            registry_id,
            name,
            description,
        )
        tag_resource(registry.get("registryArn"), tags, f"registry {name}")
        return registry_result(physical_id, registry, name)

    if request_type == "Delete":
        physical_id = event.get("PhysicalResourceId", "")
        ownership, registry_id = parse_physical_id(physical_id)
        if ownership != CREATED:
            print(
                f"Skipping delete for Registry {name}: "
                f"resource is not stack-owned ({physical_id})."
            )
            return {"PhysicalResourceId": physical_id}

        if registry_id and registry_id != "FAILED":
            try:
                client.delete_registry(registryId=registry_id)
                print(f"Registry {name} ({registry_id}) deletion started.")
            except client.exceptions.ResourceNotFoundException:
                print(f"Registry {name} ({registry_id}) is already absent.")
        return {"PhysicalResourceId": physical_id}

    return {"PhysicalResourceId": event.get("PhysicalResourceId", "")}


def handle_registry_record(request_type, props, event):
    """Create, reconcile, or start deleting a versioned Registry record."""
    desired = desired_record(props)
    registry_id = desired["registryId"]
    name = desired["name"]
    record_version = desired["recordVersion"]
    status_target = props.get("StatusTarget", "APPROVED")
    tags = props.get("Tags", DEFAULT_TAGS)

    validate_status_target(status_target)

    if request_type == "Update":
        previous = previous_record_identity(event)
        desired_key = record_property_key(props)
        if previous["propertyKey"] == desired_key:
            record = client.get_registry_record(
                registryId=previous["registryId"],
                recordId=previous["recordId"],
            )
            record.setdefault("registryId", previous["registryId"])
            record.setdefault("recordId", previous["recordId"])
            assert_record_identity(
                record,
                desired,
                previous["recordId"],
            )
            assert_record_content_unchanged(record, desired)

            if previous["ownership"] not in (CREATED, REFERENCED):
                raise RuntimeError(
                    f"Record {name}@{record_version} update requires an "
                    "explicit created:: or referenced:: physical ID"
                )

            actual_status = record.get("status", "UNKNOWN")
            if not status_satisfies_minimum(
                actual_status,
                status_target,
            ):
                raise RuntimeError(
                    f"Registry record {name}@{record_version} actual status "
                    f"{actual_status} does not satisfy minimum StatusTarget "
                    f"{status_target}; publish a version bump."
                )

            return record_result(
                event["PhysicalResourceId"],
                record,
                desired,
            )

    if request_type in ("Create", "Update"):
        return create_or_reference_record(
            desired,
            status_target,
            tags,
            event,
            request_type == "Update",
        )

    if request_type == "Delete":
        physical_id = event.get("PhysicalResourceId", "")
        ownership, record_key = parse_physical_id(physical_id)
        if ownership != CREATED:
            print(
                f"Skipping delete for record {name}: "
                f"resource is not stack-owned ({physical_id})."
            )
            return {"PhysicalResourceId": physical_id}

        delete_registry_id, record_id = parse_record_resource_key(record_key)
        try:
            client.delete_registry_record(
                registryId=delete_registry_id,
                recordId=record_id,
            )
            print(
                f"Registry record {name} ({record_id}) deletion started."
            )
        except client.exceptions.ResourceNotFoundException:
            print(f"Registry record {name} ({record_id}) is already absent.")
        return {"PhysicalResourceId": physical_id}

    return {"PhysicalResourceId": event.get("PhysicalResourceId", "")}


def create_or_reference_record(
    desired,
    status_target,
    tags,
    event,
    is_update=False,
):
    """Create a new version, or safely reference an identical conflict."""
    registry_id = desired["registryId"]
    name = desired["name"]
    record_version = desired["recordVersion"]
    deadline = deadline_after()
    created_now = False
    client_token = create_client_token(
        event,
        f"record:{registry_id}/{name}@{record_version}",
    )

    try:
        response = client.create_registry_record(
            registryId=registry_id,
            clientToken=client_token,
            tags=tags,
            **record_create_input(desired),
        )
        created_now = True
        record_arn = response.get("recordArn")
        if not record_arn:
            record_id = response.get("recordId")
            if not record_id:
                try:
                    recovered = find_record(
                        registry_id,
                        name,
                        record_version,
                    )
                    assert_record_content_unchanged(recovered, desired)
                    record_id = recovered.get("recordId")
                except Exception:
                    record_id = None
            if record_id:
                raise_compensated_record_failure(
                    registry_id,
                    record_id,
                    name,
                    record_version,
                    f"Registry record {name}@{record_version} create "
                    "response omitted recordArn",
                )
            raise RuntimeError(
                f"Registry record {name}@{record_version} create response "
                "omitted recordArn and the created resource could not be "
                "recovered; manual cleanup is required before retry."
            ) from None

        record_id = record_arn.split("/")[-1]
        record = {
            **response,
            "registryId": registry_id,
            "recordId": record_id,
        }
        ownership = CREATED
        print(
            f"Record {name}@{record_version} created: "
            f"{record_id} ({record.get('status', 'CREATING')})"
        )
    except client.exceptions.ConflictException:
        record = find_record(registry_id, name, record_version)
        assert_record_content_unchanged(record, desired)
        ownership = conflict_ownership(
            event if is_update else None,
            record,
            desired,
        )
        if ownership == REFERENCED:
            assert_referenced_status(record, status_target, name)
            return record_result(
                owned_physical_id(
                    REFERENCED,
                    f"{registry_id}/{record['recordId']}",
                ),
                record,
                desired,
            )

    try:
        tag_resource(
            record.get("recordArn"),
            tags,
            f"record {name}@{record_version}",
        )
    except Exception:
        if created_now:
            raise_compensated_record_failure(
                registry_id,
                record["recordId"],
                name,
                record_version,
                "Mandatory tagging failed for newly created Registry record "
                f"{name}@{record_version}",
            )
        raise

    try:
        verified = reconcile_created_record_status(
            record,
            desired,
            status_target,
            deadline,
        )
    except Exception:
        if created_now:
            raise_compensated_record_failure(
                registry_id,
                record["recordId"],
                name,
                record_version,
            )
        raise

    return record_result(
        owned_physical_id(
            ownership,
            f"{registry_id}/{record['recordId']}",
        ),
        verified,
        desired,
    )


def desired_record(props):
    return {
        "registryId": props["RegistryId"],
        "name": props["RecordName"],
        "displayName": props.get("DisplayName", props["RecordName"]),
        "recordType": props.get("RecordType", "CUSTOM"),
        "descriptors": props.get("Descriptors", {}),
        "recordVersion": props.get("RecordVersion", "1.0"),
        "description": props.get("Description", ""),
    }


def record_create_input(desired):
    return {
        "name": desired["name"],
        "displayName": desired["displayName"],
        "recordType": desired["recordType"],
        "descriptors": desired["descriptors"],
        "recordVersion": desired["recordVersion"],
        "description": desired["description"],
    }


def record_property_key(props):
    return (
        props.get("RegistryId"),
        props.get("RecordName"),
        props.get("RecordVersion", "1.0"),
    )


def previous_record_identity(event):
    ownership, resource_key = parse_physical_id(
        event.get("PhysicalResourceId", "")
    )
    registry_id, record_id = parse_record_resource_key(resource_key)
    old_props = event.get("OldResourceProperties")
    if not isinstance(old_props, dict):
        raise RuntimeError(
            "Registry record Update requires OldResourceProperties"
        )
    property_key = record_property_key(old_props)
    if property_key[0] != registry_id:
        raise RuntimeError(
            "Registry record Update physical ID does not match the previous "
            "RegistryId"
        )
    return {
        "ownership": ownership,
        "registryId": registry_id,
        "recordId": record_id,
        "propertyKey": property_key,
    }


def conflict_ownership(update_event, record, desired):
    if update_event is None:
        return REFERENCED

    previous = previous_record_identity(update_event)
    conflict_key = (
        record.get("registryId"),
        record.get("recordId"),
    )
    previous_key = (
        previous["registryId"],
        previous["recordId"],
    )
    if (
        previous["ownership"] == CREATED
        and previous["propertyKey"]
        == (
            desired["registryId"],
            desired["name"],
            desired["recordVersion"],
        )
        and conflict_key == previous_key
    ):
        return CREATED
    return REFERENCED


def assert_record_content_unchanged(record, desired):
    fields = (
        "displayName",
        "description",
        "recordType",
        "recordVersion",
        "descriptors",
    )
    changed = [
        field
        for field in fields
        if record.get(field, "" if field == "description" else None)
        != desired[field]
    ]
    if changed:
        raise RuntimeError(
            f"Registry record {desired['name']}@"
            f"{desired['recordVersion']} is immutable; fields "
            f"{', '.join(changed)} differ. Publish a version bump."
        )


def assert_record_identity(record, desired, expected_record_id):
    if (
        record.get("registryId") != desired["registryId"]
        or record.get("recordId") != expected_record_id
        or record.get("name") != desired["name"]
        or record.get("recordVersion") != desired["recordVersion"]
    ):
        raise RuntimeError(
            f"Registry record {desired['name']}@"
            f"{desired['recordVersion']} physical record identity does not "
            "match the previous CloudFormation resource"
        )


def assert_referenced_status(record, status_target, name):
    actual_status = record.get("status", "UNKNOWN")
    if actual_status != status_target:
        raise RuntimeError(
            f"referenced Registry record {name} has status "
            f"{actual_status}, but StatusTarget requires {status_target}"
        )


def assert_registry_state(
    registry,
    expected_registry_id,
    expected_name,
    expected_description,
):
    changed = []
    if registry.get("registryId") != expected_registry_id:
        changed.append("registryId")
    if registry.get("name") != expected_name:
        changed.append("name")
    if registry.get("description") != expected_description:
        changed.append("description")
    if registry.get("status") != "READY":
        changed.append("status")
    if changed:
        raise RuntimeError(
            f"Registry {expected_name} update verification failed; "
            f"{', '.join(changed)} did not match the requested READY state."
        )


def validate_status_target(status_target):
    if status_target not in SUPPORTED_STATUS_TARGETS:
        expected = ", ".join(sorted(SUPPORTED_STATUS_TARGETS))
        raise ValueError(
            f"Unsupported StatusTarget {status_target}; expected {expected}"
        )
    return status_target


def status_satisfies_minimum(actual_status, desired_target):
    validate_status_target(desired_target)
    actual_rank = STATUS_TARGET_RANK.get(actual_status)
    if actual_rank is None:
        return False
    return actual_rank >= STATUS_TARGET_RANK[desired_target]


def reconcile_created_record_status(
    record,
    desired,
    status_target,
    deadline,
):
    registry_id = desired["registryId"]
    record_id = record["recordId"]
    name = desired["name"]
    status = record.get("status", "CREATING")

    if status == "CREATING":
        record = wait_for_record_status(
            registry_id,
            record_id,
            name,
            RECORD_ACTIONABLE_STATUSES,
            deadline,
        )
        status = record.get("status")

    if status_target == "DRAFT":
        if status != "DRAFT":
            raise RuntimeError(
                f"Registry record {name} reached {status}; "
                "StatusTarget requires DRAFT"
            )
        return record

    if status == "DRAFT":
        client.submit_registry_record_for_approval(
            registryId=registry_id,
            recordId=record_id,
        )
        record = wait_for_record_status(
            registry_id,
            record_id,
            name,
            {"PENDING_APPROVAL", "APPROVED"},
            deadline,
        )
        status = record.get("status")

    if status_target == "PENDING_APPROVAL":
        if status != "PENDING_APPROVAL":
            raise RuntimeError(
                f"Registry record {name} reached {status}; "
                "StatusTarget requires PENDING_APPROVAL"
            )
        return record

    if status == "PENDING_APPROVAL":
        client.update_registry_record_status(
            registryId=registry_id,
            recordId=record_id,
            status="APPROVED",
            statusReason="Platform seed - auto-approved.",
        )
        record = wait_for_record_status(
            registry_id,
            record_id,
            name,
            {"APPROVED"},
            deadline,
        )
        status = record.get("status")

    if status != "APPROVED":
        raise RuntimeError(
            f"Registry record {name} reached {status}; "
            "StatusTarget requires APPROVED"
        )
    return record


def registry_result(physical_id, registry, name):
    return {
        "PhysicalResourceId": physical_id,
        "Data": {
            "RegistryId": registry["registryId"],
            "RegistryArn": registry.get("registryArn"),
            "RegistryName": name,
            "Status": registry.get("status"),
        },
    }


def record_result(physical_id, record, desired):
    return {
        "PhysicalResourceId": physical_id,
        "Data": {
            "RegistryId": desired["registryId"],
            "RecordId": record["recordId"],
            "RecordArn": record.get("recordArn"),
            "RecordName": desired["name"],
            "Status": record.get("status"),
        },
    }


def owned_physical_id(ownership, resource_id):
    """Encode explicit CloudFormation ownership in a physical ID."""
    if ownership not in (CREATED, REFERENCED):
        raise ValueError(f"Unknown ownership: {ownership}")
    return f"{ownership}::{resource_id}"


def create_client_token(event, immutable_resource_key):
    material = "|".join(
        (
            str(event.get("StackId", "")),
            str(event.get("LogicalResourceId", "")),
            str(event.get("RequestId", "")),
            immutable_resource_key,
        )
    )
    return hashlib.sha256(material.encode("utf-8")).hexdigest()


def parse_physical_id(physical_id):
    """Return (ownership, resource ID), failing closed for legacy IDs."""
    if not physical_id or "::" not in physical_id:
        return None, physical_id
    ownership, resource_id = physical_id.split("::", 1)
    if ownership not in (CREATED, REFERENCED):
        return None, physical_id
    return ownership, resource_id


def parse_record_resource_key(resource_key):
    if "/" not in resource_key:
        raise RuntimeError(
            "Registry record physical ID must contain registryId/recordId"
        )
    return resource_key.split("/", 1)


def deadline_after(seconds=MAX_WAIT):
    return time.monotonic() + seconds


def cleanup_deadline_after():
    return deadline_after(CLEANUP_WAIT)


def sleep_for_poll(deadline, timeout_message):
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise TimeoutError(timeout_message)
    time.sleep(min(POLL_INTERVAL, remaining))


def find_registry_by_name(name):
    """Find a Registry by exact name."""
    paginator = client.get_paginator("list_registries")
    for page in paginator.paginate():
        for registry in page.get("registries", []):
            if registry["name"] == name:
                return registry
    return None


def wait_for_registry_ready(registry_id, name, deadline=None):
    """Poll until a Registry reaches READY."""
    deadline = deadline if deadline is not None else deadline_after()
    timeout_message = (
        f"Registry {name} did not reach READY within the lifecycle deadline"
    )
    while True:
        try:
            response = client.get_registry(registryId=registry_id)
        except client.exceptions.ResourceNotFoundException:
            response = None

        if response is not None:
            status = response.get("status")
            if status == "READY":
                return response
            if status in REGISTRY_TERMINAL_FAILURE_STATUSES:
                raise RuntimeError(
                    f"Registry {name} entered terminal state {status}"
                )
            if status not in REGISTRY_TRANSIENT_STATUSES:
                raise RuntimeError(
                    f"Registry {name} entered unexpected state {status}"
                )

        sleep_for_poll(deadline, timeout_message)


def find_record(registry_id, name, record_version):
    """Find and fetch a record by exact name and version."""
    paginator = client.get_paginator("list_registry_records")
    for page in paginator.paginate(registryId=registry_id):
        for summary in page.get("registryRecords", []):
            if (
                summary.get("name") == name
                and summary.get("recordVersion") == record_version
            ):
                record = client.get_registry_record(
                    registryId=registry_id,
                    recordId=summary["recordId"],
                )
                record.setdefault("registryId", registry_id)
                record.setdefault("recordId", summary["recordId"])
                return record
    raise RuntimeError(
        f"Record {name}@{record_version} not found after ConflictException"
    )


def wait_for_record_status(
    registry_id,
    record_id,
    name,
    target_statuses,
    deadline,
):
    """Poll for one of the requested statuses using a shared deadline."""
    targets = set(target_statuses)
    timeout_message = (
        f"Registry record {name} did not reach {sorted(targets)} "
        "within the lifecycle deadline"
    )
    while True:
        try:
            response = client.get_registry_record(
                registryId=registry_id,
                recordId=record_id,
            )
        except client.exceptions.ResourceNotFoundException:
            response = None

        if response is not None:
            response.setdefault("registryId", registry_id)
            response.setdefault("recordId", record_id)
            status = response.get("status")
            if status in targets:
                return response
            if status in RECORD_TERMINAL_FAILURE_STATUSES:
                raise RuntimeError(
                    f"Registry record {name} entered terminal state {status}"
                )

        sleep_for_poll(deadline, timeout_message)


def tag_resource(resource_arn, tags, label):
    if not resource_arn:
        raise RuntimeError(f"Cannot tag {label}: resource ARN is missing")
    client.tag_resource(resourceArn=resource_arn, tags=tags)
    print(f"Tagged {label}")


def compensate_registry_creation(registry_id, name):
    try:
        client.delete_registry(registryId=registry_id)
        print(
            f"Compensating delete started for Registry {name} "
            f"({registry_id})."
        )
    except client.exceptions.ResourceNotFoundException:
        return True
    except Exception:
        print(
            f"Compensating delete failed for Registry {name} "
            f"({registry_id})."
        )
        return False
    return wait_for_registry_absent(
        registry_id,
        name,
        cleanup_deadline_after(),
    )


def compensate_record_creation(registry_id, record_id, name):
    try:
        client.delete_registry_record(
            registryId=registry_id,
            recordId=record_id,
        )
        print(
            f"Compensating delete started for Registry record {name} "
            f"({record_id})."
        )
    except client.exceptions.ResourceNotFoundException:
        return True
    except Exception:
        print(
            f"Compensating delete failed for Registry record {name} "
            f"({record_id})."
        )
        return False
    return wait_for_record_absent(
        registry_id,
        record_id,
        name,
        cleanup_deadline_after(),
    )


def wait_for_registry_absent(registry_id, name, deadline):
    timeout_message = (
        f"Compensating delete for Registry {name} did not stabilize"
    )
    while True:
        try:
            registry = client.get_registry(registryId=registry_id)
        except client.exceptions.ResourceNotFoundException:
            return True
        except Exception:
            return False

        if registry.get("status") == "DELETE_FAILED":
            return False
        try:
            sleep_for_poll(deadline, timeout_message)
        except TimeoutError:
            return False


def wait_for_record_absent(
    registry_id,
    record_id,
    name,
    deadline,
):
    timeout_message = (
        f"Compensating delete for Registry record {name} did not stabilize"
    )
    while True:
        try:
            record = client.get_registry_record(
                registryId=registry_id,
                recordId=record_id,
            )
        except client.exceptions.ResourceNotFoundException:
            return True
        except Exception:
            return False

        if record.get("status") == "DELETE_FAILED":
            return False
        try:
            sleep_for_poll(deadline, timeout_message)
        except TimeoutError:
            return False


def raise_compensated_registry_failure(
    registry_id,
    name,
    failure_message,
):
    if compensate_registry_creation(registry_id, name):
        raise RuntimeError(
            f"{failure_message}; compensating delete succeeded."
        ) from None
    raise RuntimeError(
        f"{failure_message} and compensating delete failed; "
        "manual cleanup is required before retry."
    ) from None


def raise_compensated_record_failure(
    registry_id,
    record_id,
    name,
    record_version,
    failure_message=None,
):
    if failure_message is None:
        failure_message = (
            f"Registry record {name}@{record_version} provisioning failed"
        )
    if compensate_record_creation(registry_id, record_id, name):
        raise RuntimeError(
            f"{failure_message}; compensating delete succeeded."
        ) from None
    raise RuntimeError(
        f"{failure_message} and compensating delete failed; "
        "manual cleanup is required before retry."
    ) from None
