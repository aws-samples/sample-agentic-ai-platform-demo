"""Reference/fallback cleaner: raw UCI Online Retail XLSX -> tidy fact Parquet (JSON stdout).

This exists so students can DIFF "agent-written pandas" vs "prebuilt cleaner".
The live M2 demo deliberately does NOT use this -- the agent must write its own
pandas. Kept only as a reference for the raw workbook's shape and the minimal
clean needed to get a tidy transactions fact.

Raw columns: InvoiceNo, StockCode, Description, Quantity, InvoiceDate, UnitPrice,
CustomerID, Country. Real dirty points: missing CustomerID, 'C'-prefix
cancellations, negative Quantity (returns), UnitPrice == 0.

For the full star-schema build (4 tables) see data/build_star_schema.py.

Emits: {ok, output_path, row_count, columns, source_table}
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

import pandas as pd


def emit(payload: dict[str, Any]) -> None:
    print(json.dumps(payload, indent=2, default=str))


def clean(frame: pd.DataFrame) -> pd.DataFrame:
    # Normalize headers (strip only; UCI uses CamelCase column names).
    frame = frame.rename(columns=lambda c: str(c).strip())
    # Trim string columns.
    for col in ("InvoiceNo", "StockCode", "Description", "Country"):
        if col in frame.columns:
            frame[col] = frame[col].astype(str).str.strip()
    # Numeric coercions.
    if "Quantity" in frame.columns:
        frame["Quantity"] = pd.to_numeric(frame["Quantity"], errors="coerce")
    if "UnitPrice" in frame.columns:
        frame["UnitPrice"] = pd.to_numeric(frame["UnitPrice"], errors="coerce")
    if "CustomerID" in frame.columns:
        frame["CustomerID"] = pd.to_numeric(frame["CustomerID"], errors="coerce").astype("Int64")
    if "InvoiceDate" in frame.columns:
        frame["InvoiceDate"] = pd.to_datetime(frame["InvoiceDate"], errors="coerce")
    # Flags for the real dirty points.
    if "InvoiceNo" in frame.columns:
        frame["is_cancellation"] = frame["InvoiceNo"].str.upper().str.startswith("C")
    if "Quantity" in frame.columns:
        frame["is_return"] = frame["Quantity"] < 0
    if {"is_cancellation", "Quantity", "UnitPrice"}.issubset(frame.columns):
        frame["is_valid_sale"] = (
            (~frame["is_cancellation"]) & (frame["Quantity"] > 0) & (frame["UnitPrice"] > 0)
        )
        frame["line_revenue"] = (frame["Quantity"] * frame["UnitPrice"]).round(2)
    # Drop rows missing the structural keys, then exact duplicates.
    frame = frame.dropna(subset=[c for c in ("InvoiceNo", "StockCode", "Quantity", "UnitPrice", "InvoiceDate") if c in frame.columns])
    frame = frame.drop_duplicates()
    return frame


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--workbook",
        type=Path,
        default=Path(__file__).resolve().parents[2] / "data/raw/uci_online_retail/Online Retail.xlsx",
    )
    parser.add_argument("--out-dir", type=Path, required=True)
    args = parser.parse_args()

    try:
        if args.workbook.suffix in (".xlsx", ".xls"):
            frame = pd.read_excel(args.workbook)
        else:
            frame = pd.read_csv(args.workbook)
        frame = clean(frame)
        args.out_dir.mkdir(parents=True, exist_ok=True)
        out_path = args.out_dir / "transactions_clean.parquet"
        frame.to_parquet(out_path, compression="snappy", index=False)
        payload = {
            "ok": True,
            "output_path": str(out_path),
            "row_count": int(len(frame)),
            "columns": list(frame.columns),
            "source_table": "uci_retail.transactions (cleaned reference)",
        }
    except Exception as error:  # noqa: BLE001
        emit({"ok": False, "error_type": error.__class__.__name__, "error": str(error)})
        return 1

    emit(payload)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
