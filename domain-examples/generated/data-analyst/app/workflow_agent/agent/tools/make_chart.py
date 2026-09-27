"""Render a chart to PNG and print JSON (incl. inline base64) to stdout.

Two modes:
  helper  : --data-path <csv/parquet> --x <col> --y <col> [--kind bar|line]
            --title <t> --out-path <png>   (builds the chart from data)
  encode  : --png <path>                   (normalize an agent-made PNG -> base64)

Inline base64 keeps the M1 demo S3-free (the Streamlit UI can render bytes
directly). Emits: {ok, chart_path, chart_png_base64, title}.
"""

from __future__ import annotations

import argparse
import base64
import json
from pathlib import Path
from typing import Any


def emit(payload: dict[str, Any]) -> None:
    print(json.dumps(payload, indent=2, default=str))


def encode_png(path: Path) -> str:
    return base64.b64encode(path.read_bytes()).decode("ascii")


def build_chart(args: argparse.Namespace) -> Path:
    import matplotlib

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    import pandas as pd

    data_path = Path(args.data_path)
    if data_path.suffix == ".parquet":
        frame = pd.read_parquet(data_path)
    else:
        frame = pd.read_csv(data_path)

    out_path = Path(args.out_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    fig, ax = plt.subplots(figsize=(8, 4.5), dpi=110)
    if args.kind == "line":
        ax.plot(frame[args.x], frame[args.y], marker="o")
    else:
        ax.bar(frame[args.x].astype(str), frame[args.y])
    ax.set_title(args.title or f"{args.y} by {args.x}")
    ax.set_xlabel(args.x)
    ax.set_ylabel(args.y)
    fig.autofmt_xdate(rotation=30)
    fig.tight_layout()
    fig.savefig(out_path)
    plt.close(fig)
    return out_path


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--png", type=Path, help="encode mode: normalize+encode an existing PNG")
    parser.add_argument("--data-path", type=Path)
    parser.add_argument("--x")
    parser.add_argument("--y")
    parser.add_argument("--kind", choices=("bar", "line"), default="bar")
    parser.add_argument("--title", default="")
    parser.add_argument("--out-path", type=Path)
    args = parser.parse_args()

    try:
        if args.png is not None:
            chart_path = args.png
            if not chart_path.exists():
                raise FileNotFoundError(f"PNG not found: {chart_path}")
        else:
            if not (args.data_path and args.x and args.y and args.out_path):
                raise ValueError("helper mode requires --data-path --x --y --out-path")
            chart_path = build_chart(args)
        payload = {
            "ok": True,
            "chart_path": str(chart_path),
            "chart_png_base64": encode_png(chart_path),
            "title": args.title or chart_path.stem,
        }
    except Exception as error:  # noqa: BLE001
        emit({"ok": False, "error_type": error.__class__.__name__, "error": str(error)})
        return 1

    emit(payload)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
