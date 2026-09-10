from __future__ import annotations

import argparse
from pathlib import Path
from typing import Any

import pandas as pd
from supabase import Client

from .config import DATA_DIR, get_client

PAGE_SIZE = 1000
# The v2 training view (schema.sql): segments joined to sessions and subjects,
# with is_human derived from subjects.kind (which the client cannot forge). It is
# revoked from anon/authenticated and readable only with the service key, which
# bypasses RLS. Replaces the flat telemetry_logs table, now renamed _v1.
TABLE = "v_training_segments"


def fetch_all_segments(
    client: Client,
    *,
    routine: str | None = None,
    is_human: bool | None = None,
    page_size: int = PAGE_SIZE,
) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    start = 0
    while True:
        query = client.table(TABLE).select("*")
        if routine is not None:
            query = query.eq("routine", routine)
        if is_human is not None:
            # postgrest expects the lowercase literal, not Python's str(bool).
            query = query.eq("is_human", "true" if is_human else "false")

        page = query.range(start, start + page_size - 1).execute().data
        rows.extend(page)
        if len(page) < page_size:
            break
        start += page_size

    return rows


def save(rows: list[dict[str, Any]], out_path: Path) -> None:
    df = pd.DataFrame(rows)
    out_path.parent.mkdir(parents=True, exist_ok=True)

    if out_path.suffix == ".parquet":
        df.to_parquet(out_path, index=False)
    elif out_path.suffix == ".csv":
        df.to_csv(out_path, index=False)
    elif out_path.suffix == ".json":
        df.to_json(out_path, orient="records")
    else:
        raise ValueError(f"Unsupported output format: {out_path.suffix}")


def _parse_bool(value: str) -> bool:
    lowered = value.strip().lower()
    if lowered in ("true", "1", "yes"):
        return True
    if lowered in ("false", "0", "no"):
        return False
    raise argparse.ArgumentTypeError(f"expected a boolean, got {value!r}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--routine", help="filter to one routine id, e.g. flick")
    parser.add_argument("--is-human", type=_parse_bool, help="filter to true/false")
    parser.add_argument(
        "--out",
        type=Path,
        default=DATA_DIR / "telemetry.parquet",
        help="output path (.parquet, .csv, or .json)",
    )
    args = parser.parse_args()

    client = get_client()
    rows = fetch_all_segments(client, routine=args.routine, is_human=args.is_human)
    save(rows, args.out)
    print(f"Wrote {len(rows)} segments to {args.out}")


if __name__ == "__main__":
    main()
