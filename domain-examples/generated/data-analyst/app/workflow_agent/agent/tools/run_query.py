"""Run a single read-only SQL statement over the UCI Online Retail warehouse on Athena.

The data plane is S3 + Glue + Athena: the star-schema parquet tables live under
s3://data-analyst-agent-820242898417-us-west-2/athena/data/uci_retail/ and are
registered in the Glue database `uci_retail` (provisioned platform-side; the
provisioning script is not shipped in this repo). This tool provides a "write SQL -> get a cited
number" workflow with read-only guardrails, and prints PURE JSON to stdout.

Athena speaks Presto/Trino SQL. Star schema: transactions (fact), invoices,
products, customers. Dataset: UCI Online Retail (real UK ecommerce, CC BY 4.0).

Emits: {ok, engine, rows, query:{row_count,source_tables,duration_ms}, source_table}
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
from pathlib import Path
from typing import Any

TABLES = ["transactions", "invoices", "products", "customers"]

AWS_REGION = os.environ.get("ATHENA_REGION", os.environ.get("AWS_REGION", "us-west-2"))
ATHENA_WORKGROUP = os.environ.get("ATHENA_WORKGROUP", "data_analyst_agent")
ATHENA_DATABASE = os.environ.get("ATHENA_DATABASE", "uci_retail")
POLL_INTERVAL_SECONDS = 0.5
QUERY_TIMEOUT_SECONDS = 120

ALLOWED_START_KEYWORDS = {"SELECT", "WITH", "SHOW", "DESCRIBE", "EXPLAIN"}
BLOCKED_SQL_PATTERN = re.compile(
    r"\b("
    r"ALTER|CALL|COPY|CREATE|DELETE|DROP|GRANT|INSERT|MERGE|MSCK|OPTIMIZE|"
    r"REPAIR|REVOKE|TRUNCATE|UNLOAD|UPDATE|UPSERT|VACUUM|ATTACH|INSTALL|LOAD|PRAGMA|SET"
    r")\b",
    re.IGNORECASE,
)
BLOCK_COMMENT_PATTERN = re.compile(r"/\*.*?\*/", re.DOTALL)
LINE_COMMENT_PATTERN = re.compile(r"--.*?$", re.MULTILINE)

# Athena result cells are strings; coerce back to JSON types by column type.
INT_TYPES = {"tinyint", "smallint", "integer", "int", "bigint"}
FLOAT_TYPES = {"double", "float", "real", "decimal"}
BOOL_TYPES = {"boolean"}


class SqlGuardrailError(RuntimeError):
    """Raised when a query violates a read-only guardrail."""


def strip_sql_comments(sql: str) -> str:
    without_block = BLOCK_COMMENT_PATTERN.sub("", sql)
    return LINE_COMMENT_PATTERN.sub("", without_block)


def normalize_sql(sql: str) -> str:
    normalized = strip_sql_comments(sql).strip()
    if not normalized:
        raise SqlGuardrailError("SQL is empty after removing comments.")
    if normalized.count(";") > 1 or (normalized.endswith(";") is False and ";" in normalized):
        raise SqlGuardrailError("Only a single SQL statement is allowed per call.")
    normalized = normalized.rstrip(";").strip()
    if BLOCKED_SQL_PATTERN.search(normalized):
        raise SqlGuardrailError("Only read-only SQL is allowed (SELECT/WITH/SHOW/DESCRIBE/EXPLAIN).")
    first_token = normalized.split(None, 1)[0].upper()
    if first_token not in ALLOWED_START_KEYWORDS:
        raise SqlGuardrailError(
            f"SQL must start with one of {sorted(ALLOWED_START_KEYWORDS)}, got {first_token!r}."
        )
    return normalized


def referenced_tables(sql: str) -> list[str]:
    lowered = sql.lower()
    return [t for t in TABLES if re.search(rf"\b{t}\b", lowered)]


def emit(payload: dict[str, Any]) -> None:
    print(json.dumps(payload, indent=2, default=str))


def coerce_cell(value: str | None, column_type: str) -> Any:
    if value is None:
        return None
    base_type = column_type.lower().split("(")[0]
    if base_type in INT_TYPES:
        return int(value)
    if base_type in FLOAT_TYPES:
        return float(value)
    if base_type in BOOL_TYPES:
        return value.lower() == "true"
    return value


def run_athena_query(sql: str, max_rows: int) -> tuple[list[dict[str, Any]], int]:
    import boto3

    athena = boto3.client("athena", region_name=AWS_REGION)
    query_id = athena.start_query_execution(
        QueryString=sql,
        QueryExecutionContext={"Database": ATHENA_DATABASE},
        WorkGroup=ATHENA_WORKGROUP,
    )["QueryExecutionId"]

    deadline = time.monotonic() + QUERY_TIMEOUT_SECONDS
    while True:
        execution = athena.get_query_execution(QueryExecutionId=query_id)["QueryExecution"]
        state = execution["Status"]["State"]
        if state == "SUCCEEDED":
            break
        if state in {"FAILED", "CANCELLED"}:
            reason = execution["Status"].get("StateChangeReason", state)
            raise RuntimeError(f"Athena query {state}: {reason}")
        if time.monotonic() > deadline:
            athena.stop_query_execution(QueryExecutionId=query_id)
            raise TimeoutError(f"Athena query timed out after {QUERY_TIMEOUT_SECONDS}s.")
        time.sleep(POLL_INTERVAL_SECONDS)

    duration_ms = execution.get("Statistics", {}).get("EngineExecutionTimeInMillis", 0)

    rows: list[dict[str, Any]] = []
    columns: list[tuple[str, str]] = []
    next_token: str | None = None
    first_page = True
    while len(rows) < max_rows:
        kwargs: dict[str, Any] = {"QueryExecutionId": query_id, "MaxResults": 1000}
        if next_token:
            kwargs["NextToken"] = next_token
        page = athena.get_query_results(**kwargs)
        if first_page:
            columns = [
                (c["Name"], c.get("Type", "varchar"))
                for c in page["ResultSet"]["ResultSetMetadata"]["ColumnInfo"]
            ]
        data_rows = page["ResultSet"]["Rows"]
        if first_page and data_rows:
            header = [d.get("VarCharValue") for d in data_rows[0].get("Data", [])]
            if header == [name for name, _ in columns]:
                data_rows = data_rows[1:]
        first_page = False
        for raw in data_rows:
            cells = raw.get("Data", [])
            rows.append(
                {
                    name: coerce_cell(
                        cells[i].get("VarCharValue") if i < len(cells) else None, col_type
                    )
                    for i, (name, col_type) in enumerate(columns)
                }
            )
            if len(rows) >= max_rows:
                break
        next_token = page.get("NextToken")
        if not next_token:
            break
    return rows, duration_ms


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--sql")
    group.add_argument("--sql-file", type=Path)
    parser.add_argument("--max-rows", type=int, default=1000)
    args = parser.parse_args()

    sql = args.sql if args.sql is not None else args.sql_file.read_text(encoding="utf-8")

    try:
        normalized = normalize_sql(sql)
        rows, duration_ms = run_athena_query(normalized, args.max_rows)
        src = referenced_tables(normalized)
    except Exception as error:  # noqa: BLE001
        emit(
            {
                "ok": False,
                "error_type": error.__class__.__name__,
                "error": str(error),
                "sql": sql,
                "engine": "athena",
            }
        )
        return 1

    emit(
        {
            "ok": True,
            "engine": "athena",
            "sql": normalized,
            "query": {"row_count": len(rows), "source_tables": src, "duration_ms": duration_ms},
            "source_table": ", ".join(f"uci_retail.{t}" for t in src) or "uci_retail",
            "rows": rows,
        }
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
