# `model/` — offline pipeline design

**Status: no code exists yet.** `model/` currently holds only this file, `.env.example`,
`requirements.txt`, and the gitignored `data/` and `models/` directories. There is no
`src/`, no `__init__.py`, no `config.py`, no `fetch_telemetry.py` and no `features.py` —
the whole package is the next task.

This document records the design decisions already made, so whoever builds it implements
them consistently rather than re-deriving them. **Nothing below is code you can run
today.** Do not cite a `model/src/*.py` file as if it exists.

## What this is

An offline Python program that pulls telemetry back out of Supabase and trains a
human-vs-bot classifier. It is a separate program, not a backend: nothing in `src/`
imports it, nothing in it reaches the browser, and it runs by hand after the fact. The
PRD's "no Python backend" means the *game* has no server; it does not forbid `model/`.

`requirements.txt` is a separate dependency set from the browser app's and is not bound by
the app's two-dependency rule.

## Planned setup and commands

A `.venv` in `model/`, `pip install -r requirements.txt`, and a `model/.env` copied from
`model/.env.example`:

```powershell
cd model
.venv\Scripts\Activate.ps1
python -m src.fetch_telemetry --routine flick --out data/flick.parquet
python -m src.features --in data/flick.parquet --out data/flick_features.parquet
```

Both scripts run as modules (`python -m src.x`) from `model/`, because they use relative
imports; `python src/features.py` would fail. `data/` and `models/` are gitignored —
everything in them is regenerable.

## Credentials

`model/.env` holds `SUPABASE_URL` and `SUPABASE_SERVICE_KEY` — the **service_role** key,
which the pipeline needs precisely because `segments` has no select policy. This must
never cross with the browser's `.env.local`, whose `VITE_`-prefixed values are inlined
into the shipped bundle. The URL must be the bare origin; a `/rest/v1` suffix produces
404s, since the client appends the path itself.

## Two stages

Each is a module with a `--in`/`--out` CLI, so datasets are files on disk rather than
state in a notebook.

### `fetch_telemetry.py`

Pages through the **`v_training_segments`** view in 1000-row batches — PostgREST caps a
single response there, so the loop is not optional — filtered by `--routine` and
`--label`, writing `.parquet`, `.csv` or `.json` picked from the `--out` extension.

The view emits the **canonical** `subject_id` (`merged_into` collapsed) plus
`board_trajectory`/`duration_ms`, runs `security_invoker`, and also carries
`subject_kind_source`, `subject_cohort` and `subject_labeled_at`.

**`--label` must be three-state** (`human` | `synthetic` | `any`), not a boolean.
`is_human` is nullable — `true`/`false`/`NULL`, where `NULL` is an unlabelled subject (the
default state of every public signup). A two-state `--is-human` flag has no way to express
"exclude the unlabelled", which is mandatory before fitting. It must default to excluding
`NULL` rows, and they must be dropped with `where is_human is not null`, never coerced or
imputed. Silently training on unlabelled strangers is the exact bug the default-deny label
exists to prevent.

### `features.py`

Flattens one segment into one row. The parts that encode decisions already made:

- **Click-only fields stay NaN on non-click rows.** `time_to_click_ms`, `dwell_ms` and the
  click offsets do not exist on a `timeout` or `track` segment, and must not be imputed —
  a fabricated reaction time would teach the classifier a lie. The v2 schema already
  enforces the same thing as a check constraint.
- **Angular features come from `yaw`/`pitch`, input features from `dx`/`dy`.** The former
  are DPI-independent and comparable across users; the latter are raw counts and are only
  comparable once `sessions.dpi` is known.
- `_coerce_frames` must accept a list, a JSON string, or a Python `repr` string, because
  `to_csv()` stringifies nested structures with single quotes that `json.loads` rejects.

## Training

- **Split train/test by `subject_id` (GroupKFold), never by row.** The view's
  `merged_into`-collapsed `subject_id` exists to be that grouping key.
- **Train once with the hardware block (`dpi`/`refresh_hz`/`device_fingerprint`) and once
  without, then compare.** If bots and humans run on visibly different hardware, a model
  can score near-perfectly by learning the hardware rather than the aim, then collapse on
  real public users.
- A small initial human cohort (a handful of trusted contributors) will likely teach the
  first model "is this one of these few people" rather than "is this a human" — treat v1
  as a proof of concept, not a shippable classifier.
- **Never write a model prediction back into `subjects.kind`.** Ground truth is what a
  person decided; a retrain that consumes its predecessor's guesses amplifies its own
  errors, silently, across every future retrain. No predictions table exists yet — correct,
  it should only be built once a model exists, and it must never share a column with
  verified ground truth.

## Staying in sync with the game

Adding a field to `sampleFrame()` in `src/telemetry.js` without teaching `_segment_features`
about it would silently train on the old feature set. `SAMPLING_VERSION` (`src/constants.js`)
is stamped on every `sessions` row and is what stops a pull mixing rows from two different
samplers — filter on it rather than assuming one shape.

## Verifying this side

No database is needed to exercise it: `build_features()` should take a DataFrame, so a
handful of hand-built segment dicts (one per outcome — `hit`, `miss`, `timeout`, `track`)
is enough to check that click-only columns stay NaN off click rows and that a single-frame
segment does not divide by zero. Pull real rows only when the question is about the data
rather than the code.
