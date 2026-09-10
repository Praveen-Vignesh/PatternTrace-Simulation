"""Turns raw telemetry_logs segments into one flat feature row per segment.

Every segment always has a non-empty `trajectory` (game.js never ships an
empty one), so features derived from it apply uniformly across every
routine and outcome. time_to_click_ms, dwell_ms, and click_offset_x/y only
exist on hit/miss rows (a timeout or a track window never had a click) and
are left NaN elsewhere rather than imputed — a fabricated reaction time
would teach the classifier a lie.
"""

from __future__ import annotations

import argparse
import ast
import json
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd

from .config import DATA_DIR

CLICK_OUTCOMES = {"hit", "miss"}

PASSTHROUGH_COLUMNS = [
    "session_id",
    "is_human",
    "bot_mode",
    "routine",
    "difficulty",
    "outcome",
    "target_count",
    "time_to_click_ms",
    "dwell_ms",
    "click_offset_x",
    "click_offset_y",
]

EMPTY_SEGMENT_FEATURES = {
    "n_frames": 0,
    "duration_ms": np.nan,
    "input_speed_mean": np.nan,
    "input_speed_std": np.nan,
    "input_speed_max": np.nan,
    "angular_speed_mean": np.nan,
    "angular_speed_std": np.nan,
    "angular_speed_max": np.nan,
    "direction_change_rate": np.nan,
    "path_efficiency": np.nan,
    "on_target_ratio": np.nan,
    "time_to_first_on_ms": np.nan,
    "target_speed_mean": np.nan,
}


def _coerce_columns(value: Any) -> dict[str, list[Any]]:
    # trajectory is stored COLUMNAR (schema.sql): a dict of parallel arrays keyed
    # by field name, not an array of per-frame objects.
    if isinstance(value, np.ndarray):
        value = value.tolist()
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except json.JSONDecodeError:
            # to_csv() stringifies nested structures with Python repr (single
            # quotes), which json.loads rejects but literal_eval accepts.
            value = ast.literal_eval(value)
    return value or {}


def _segment_features(cols: dict[str, list[Any]]) -> dict[str, float]:
    t = np.asarray(cols.get("t", []), dtype=float)
    n = t.size
    if n == 0:
        return dict(EMPTY_SEGMENT_FEATURES)

    dx = np.asarray(cols.get("dx", []), dtype=float)
    dy = np.asarray(cols.get("dy", []), dtype=float)
    yaw = np.asarray(cols.get("yaw", []), dtype=float)
    pitch = np.asarray(cols.get("pitch", []), dtype=float)
    on = np.asarray(cols.get("on", []), dtype=float)
    tx = np.asarray(cols.get("tx", []), dtype=float)
    ty = np.asarray(cols.get("ty", []), dtype=float)
    tz = np.asarray(cols.get("tz", []), dtype=float)

    input_speed = np.hypot(dx, dy)

    dt_ms = np.diff(t)
    dt_safe = np.where(dt_ms <= 0, np.nan, dt_ms)

    with np.errstate(invalid="ignore"):
        angular_step = np.hypot(np.diff(yaw), np.diff(pitch))
        angular_speed = angular_step / dt_safe * 1000.0  # rad/s

        direction_changes = np.sum(np.diff(np.sign(dx)) != 0) + np.sum(
            np.diff(np.sign(dy)) != 0
        )
        direction_change_rate = direction_changes / max(n - 2, 1)

        total_path = np.nansum(angular_step)
        straight_line = float(np.hypot(yaw[-1] - yaw[0], pitch[-1] - pitch[0]))
        path_efficiency = straight_line / total_path if total_path > 0 else np.nan

        target_step = np.sqrt(np.diff(tx) ** 2 + np.diff(ty) ** 2 + np.diff(tz) ** 2)
        target_speed_mean = float(np.nanmean(target_step / dt_safe * 1000.0))

    on_indices = np.nonzero(on)[0]
    time_to_first_on_ms = float(t[on_indices[0]]) if on_indices.size > 0 else np.nan

    return {
        "n_frames": n,
        "duration_ms": float(t[-1]),
        "input_speed_mean": float(np.mean(input_speed)),
        "input_speed_std": float(np.std(input_speed)),
        "input_speed_max": float(np.max(input_speed)),
        "angular_speed_mean": float(np.nanmean(angular_speed)) if n > 1 else np.nan,
        "angular_speed_std": float(np.nanstd(angular_speed)) if n > 1 else np.nan,
        "angular_speed_max": float(np.nanmax(angular_speed)) if n > 1 else np.nan,
        "direction_change_rate": float(direction_change_rate),
        "path_efficiency": path_efficiency,
        "on_target_ratio": float(np.mean(on)),
        "time_to_first_on_ms": time_to_first_on_ms,
        "target_speed_mean": target_speed_mean if np.isfinite(target_speed_mean) else np.nan,
    }


def build_features(df: pd.DataFrame) -> pd.DataFrame:
    trajectory_rows = df["trajectory"].apply(_coerce_columns).apply(_segment_features)
    trajectory_df = pd.DataFrame(trajectory_rows.tolist(), index=df.index)

    passthrough = df.reindex(columns=PASSTHROUGH_COLUMNS).copy()
    is_click = passthrough["outcome"].isin(CLICK_OUTCOMES)
    passthrough["is_click_outcome"] = is_click
    passthrough["click_offset_magnitude"] = np.hypot(
        passthrough["click_offset_x"], passthrough["click_offset_y"]
    ).where(is_click)

    return pd.concat([passthrough, trajectory_df], axis=1)


def _load(path: Path) -> pd.DataFrame:
    if path.suffix == ".parquet":
        return pd.read_parquet(path)
    if path.suffix == ".csv":
        return pd.read_csv(path)
    if path.suffix == ".json":
        return pd.read_json(path)
    raise ValueError(f"Unsupported input format: {path.suffix}")


def _save(df: pd.DataFrame, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.suffix == ".parquet":
        df.to_parquet(path, index=False)
    elif path.suffix == ".csv":
        df.to_csv(path, index=False)
    elif path.suffix == ".json":
        df.to_json(path, orient="records")
    else:
        raise ValueError(f"Unsupported output format: {path.suffix}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--in",
        dest="in_path",
        type=Path,
        default=DATA_DIR / "telemetry.parquet",
        help="raw segments pulled by fetch_telemetry.py (.parquet, .csv, or .json)",
    )
    parser.add_argument(
        "--out",
        type=Path,
        default=DATA_DIR / "features.parquet",
        help="output path (.parquet, .csv, or .json)",
    )
    args = parser.parse_args()

    df = _load(args.in_path)
    features = build_features(df)
    _save(features, args.out)
    print(f"Wrote {len(features)} feature rows to {args.out}")


if __name__ == "__main__":
    main()
