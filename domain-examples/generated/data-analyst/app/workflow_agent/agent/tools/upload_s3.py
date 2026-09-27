"""Upload a local file or directory to S3 with SSE-S3 and print JSON to stdout."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Iterable
from urllib.parse import urlparse

import boto3


REPO_ROOT = Path(__file__).resolve().parents[2]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))


DEFAULT_REGION = "us-west-2"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--local-path", type=Path, required=True)
    parser.add_argument("--s3-uri", required=True)
    parser.add_argument("--aws-region", default=DEFAULT_REGION)
    parser.add_argument(
        "--allowed-prefix",
        action="append",
        default=[],
        help="Optional s3://bucket/prefix guard. May be passed multiple times.",
    )
    return parser.parse_args()


def emit(payload: dict[str, object]) -> None:
    print(json.dumps(payload, indent=2))


def parse_s3_uri(uri: str) -> tuple[str, str]:
    parsed = urlparse(uri)
    if parsed.scheme != "s3" or not parsed.netloc:
        raise ValueError(f"Expected S3 URI, got {uri!r}")
    return parsed.netloc, parsed.path.lstrip("/")


def s3_uri_startswith(uri: str, allowed_prefix_uri: str) -> bool:
    uri_bucket, uri_key = parse_s3_uri(uri)
    allowed_bucket, allowed_key = parse_s3_uri(allowed_prefix_uri)
    normalized_allowed_key = allowed_key.rstrip("/")
    if normalized_allowed_key:
        normalized_allowed_key += "/"
    return uri_bucket == allowed_bucket and uri_key.startswith(normalized_allowed_key)


def validate_allowed_prefixes(target_uris: Iterable[str], allowed_prefixes: list[str]) -> None:
    if not allowed_prefixes:
        return
    for target_uri in target_uris:
        if any(s3_uri_startswith(target_uri, allowed_prefix) for allowed_prefix in allowed_prefixes):
            continue
        raise PermissionError(
            f"Refusing to upload outside allowed prefixes: {target_uri} not under {allowed_prefixes!r}"
        )


def build_upload_plan(local_path: Path, s3_uri: str) -> list[tuple[Path, str]]:
    bucket, key = parse_s3_uri(s3_uri)
    normalized_key = key.rstrip("/")
    if local_path.is_file():
        if s3_uri.endswith("/"):
            object_key = f"{normalized_key}/{local_path.name}" if normalized_key else local_path.name
        else:
            object_key = key
        return [(local_path, f"s3://{bucket}/{object_key}")]

    files = sorted(path for path in local_path.rglob("*") if path.is_file())
    uploads: list[tuple[Path, str]] = []
    for file_path in files:
        relative_key = file_path.relative_to(local_path).as_posix()
        object_key = f"{normalized_key}/{relative_key}" if normalized_key else relative_key
        uploads.append((file_path, f"s3://{bucket}/{object_key}"))
    return uploads


def main() -> int:
    args = parse_args()
    local_path = args.local_path
    if not local_path.is_absolute():
        local_path = (REPO_ROOT / local_path).resolve()

    try:
        if not local_path.exists():
            raise FileNotFoundError(f"Local path does not exist: {local_path}")
        plan = build_upload_plan(local_path, args.s3_uri)
        if not plan:
            raise ValueError(f"No files found under {local_path}")
        validate_allowed_prefixes([target_uri for _, target_uri in plan], args.allowed_prefix)
        s3 = boto3.client("s3", region_name=args.aws_region)
        uploaded: list[str] = []
        for file_path, target_uri in plan:
            bucket, key = parse_s3_uri(target_uri)
            s3.upload_file(
                str(file_path),
                bucket,
                key,
                ExtraArgs={"ServerSideEncryption": "AES256"},
            )
            uploaded.append(target_uri)
    except Exception as error:
        emit(
            {
                "ok": False,
                "error_type": error.__class__.__name__,
                "error": str(error),
                "local_path": str(local_path),
                "s3_uri": args.s3_uri,
                "aws_region": args.aws_region,
            }
        )
        return 1

    emit(
        {
            "ok": True,
            "local_path": str(local_path),
            "s3_uri": args.s3_uri,
            "aws_region": args.aws_region,
            "file_count": len(uploaded),
            "uploaded_files": uploaded[:50],
            "uploaded_files_truncated": len(uploaded) > 50,
        }
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
