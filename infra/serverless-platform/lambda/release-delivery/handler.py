import json
import os
from service import ReleaseService, Rejected

_service = None


def service():
    global _service
    if _service is None:
        import boto3
        db = boto3.resource("dynamodb")
        _service = ReleaseService(
            json.loads(os.environ["PIPELINES"]),
            boto3.client("codepipeline"),
            db.Table(os.environ["DECISION_TABLE"]),
            db.Table(os.environ["PROJECT_TABLE"]),
            boto3.client("cognito-idp"),
            os.environ["USER_POOL_ID"],
            boto3.client("s3"))
    return _service


def handler(event, context):
    headers = {"content-type": "application/json", "cache-control": "no-store"}
    try:
        request = event.get("requestContext", {})
        claims = request.get("authorizer", {}).get("jwt", {}).get("claims", {})
        current = service()
        identity = current.identity(claims)
        method, path = request.get("http", {}).get("method"), request.get("http", {}).get("path")
        if method == "GET" and path == "/api/release-delivery":
            result = current.list(identity, (event.get("queryStringParameters") or {}).get("domainId"))
        elif method == "POST" and path == "/api/release-decisions":
            if event.get("isBase64Encoded") or len(event.get("body") or "") > 8192:
                raise Rejected("INVALID_REQUEST", 400)
            result = current.decide(identity, json.loads(event.get("body") or "null"))
        else:
            raise Rejected("NOT_FOUND", 404)
        return {"statusCode": 200, "headers": headers, "body": json.dumps(result)}
    except Rejected as error:
        return {"statusCode": error.status, "headers": headers,
                "body": json.dumps({"ok": False, "code": error.code})}
    except (ValueError, TypeError, KeyError):
        return {"statusCode": 400, "headers": headers,
                "body": json.dumps({"ok": False, "code": "INVALID_REQUEST"})}
    except Exception:
        # Never log the approval token, JWT, request body or customer content.
        print(json.dumps({"event": "release_api_unavailable",
                          "requestId": getattr(context, "aws_request_id", "unknown")}))
        return {"statusCode": 503, "headers": headers,
                "body": json.dumps({"ok": False, "code": "RELEASE_SERVICE_UNAVAILABLE"})}
