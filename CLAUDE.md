# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 🚨 General Agent Rules 🚨
Before making any changes or decisions, you MUST read and follow the general agent rules located in `.claude/rules/rules.md`.
**CRITICAL: NEVER USE GIT OR VERSION CONTROL COMMANDS.**

## Scope discipline

`aim-simulator-prd.md` is the specification. v1 (§8's four phases) shipped and is verified
against §9. The project is now in **v2**: a multi-routine trainer with a home screen,
player-configurable sensitivity, and a difficulty manager — all marked **(v2)** in the
PRD's §3. Multiple concurrent targets, moving targets, and menus are **in** scope now;
the older text saying otherwise has been amended.

Alongside the game, an **offline Python pipeline now lives in `model/`**: it pulls
telemetry back out of Supabase and trains a human-vs-bot classifier. It is a separate
program, not a backend — nothing in `src/` imports it, nothing in it reaches the browser,
and it runs by hand after the fact. The PRD's "no Python backend" means the *game* has no
server; it does not forbid `model/`.

Still out of scope: no LLM integration, no coaching/archetyping, no leaderboards, no
sound, and no inference in the browser — the classifier is trained and applied offline.

The **browser app's** runtime dependencies are **only** `three` and
`@supabase/supabase-js`. No frameworks — the home screen and overlays are plain HTML/CSS.
Adding a dependency or a framework *there* is a spec violation, not an improvement.
`model/requirements.txt` is a separate dependency set and is not bound by that rule.

**Five routines have shipped**: precision flick, static flicking (gridshot), dynamic
reflex (spidershot), reactive strafing, and target switching.
`src/routines/index.js` is both the catalogue and the factory — it gates each tile with
`available`, and `isAvailable` also requires a registered factory, so a new routine needs
both. `src/difficulty.js` holds every per-routine parameter. Never mark a routine
available before its factory exists; the home screen renders straight from that flag.

Two scoring shapes exist, and each routine declares which with a `kind` field.
**Destructible** routines (`kind: 'destructible'` — flick, gridshot, spidershot, switching)
consume the target on a hit and spawn a replacement. **Tracking** routines
(`kind: 'tracking'` — strafing) deliberately do *not* — `resolveHit` is empty, because the
drill is staying on the target, and consuming it would turn it into a flick drill. `game.js`
branches on `kind` for both scoring and telemetry (see the segment model below).

## Commands

```powershell
npm install
npm run dev        # Vite dev server on :5173
npm run build      # static bundle to dist/
npm run preview    # serve the built dist/ on :4173
```

The offline pipeline is a second program with its own virtualenv and its own entry
points (`model/README.md` has the one-time setup, including `model/.env`):

```powershell
cd model
.venv\Scripts\Activate.ps1
python -m src.fetch_telemetry --routine flick --out data/flick.parquet
python -m src.features --in data/flick.parquet --out data/flick_features.parquet
```

Both scripts are run as modules (`python -m src.x`) from `model/`, because they use
relative imports; `python src/features.py` fails. `data/` and `models/` are gitignored —
everything in them is regenerable.

> **Pipeline status (in flux).** `model/src/` currently holds only `fetch_telemetry.py`;
> `config.py`, `features.py` and `__init__.py` were deleted and are being rebuilt as the
> next task. `fetch_telemetry.py` still `import`s `from .config import DATA_DIR, get_client`,
> so it will not run until `config.py` (and the package `__init__.py`) are restored. The
> sections below document the intended pipeline design that rebuild targets.

Windows/PowerShell is the primary dev environment; use forward slashes in code.

There is no test runner and no linter, on either side — adding one would mean adding
dependencies. See "Verifying changes" below for how this codebase is actually exercised.

## Architecture

Plain ES modules, one factory function per file, no classes and no shared mutable state
between modules. `main.js` is the only composition point: it builds the scene, controls
and HUD, injects them into `createGame()`, wires the account panel and free-session gate,
and owns the `requestAnimationFrame` loop.

**Pointer lock is the session boundary.** `PointerLockControls` `lock`/`unlock` events
drive everything: lock switches to the PLAYING screen and calls `game.start()` with the
active difficulty's target radius (fresh `crypto.randomUUID()` session id, HUD counters
reset, first spawn); unlock calls `game.stop()` and shows PAUSED. Re-locking always
starts a new session — it never resumes the old one.

**One row is one *segment*, not one mesh — the unified telemetry shape.** A segment is a
span of play that closes with an `outcome`: destructible routines close on a click
(`hit`/`miss`) or a timeout (`timeout`); tracking routines have no click, so they close every
`TRACK_WINDOW_MS` (`track`) and once more on `stop()`. This is what makes one table fit
every mode — every row carries `routine`, `difficulty`, `outcome`, the board layout at
segment start (`targets` + `target_count`), and a per-frame stream. `beginAttempt()` opens a
segment: stamps the clock, resets dwell, snapshots the board, and records `engaged_index`
(`routine.targets.indexOf(aimTarget())`). `flushSegment(outcome, fields)` ships the one that closed — read its
`frames`/`board` **before** `beginAttempt()` swaps in fresh arrays, so an in-flight insert
keeps its own array (the buffer is replaced, never emptied in place). An empty segment (no
frame sampled yet) is never shipped.

**A frame is sampled once per rendered frame, not per mousemove: `{t, dx, dy, yaw, pitch,
tx, ty, tz, on}`.** `update()` calls `sampleFrame()` every frame *after* `routine.update()`
has moved the targets, so the aim and the world state are recorded together — the fix for
tracking and moving-target modes, where the target moves even when the mouse is still.
`dx`/`dy` are the raw device counts for that frame (accumulated from the pointer stream into
`pendingDx/Dy` and drained here). `yaw`/`pitch` are the camera's absolute angles read off
`camera.quaternion` as a `YXZ` Euler (`.y` yaw, `.x` pitch) — DPI-independent. `tx/ty/tz` are
the engaged (`aimTarget()`) target's world position that frame; `on` is whether the crosshair
sat on any live target (`raycastCenter()`), which also stamps `dwellStart` on first contact.
A multi-target moving routine (`tracksBoardTrajectory`) additionally records every live
target's position that frame into `board_trajectory`, in lockstep so the frame counts match.
Angles are rounded to 5 decimals, positions to 3, in `telemetry.js`.

**`dwell_ms`, `time_to_click_ms`, and `click_offset` are click-only.** They are non-null on
`hit`/`miss` rows; `null` on `timeout` and `track` rows, which have no landed shot. `dwell_ms`
is `now - dwellStart` (the crosshair first settling on a target until the click), or `null`
when it never registered (a pure miss, or a click before the crosshair touched a target).

A target that expires on its own (spidershot) still writes a row: `flushSegment('timeout')`
ships the failed attempt's search trajectory as a labeled miss before re-arming, and it
counts against accuracy but not against the average click time (the `clicks` HUD counter).

**Routines own their targets; `game.js` owns everything else.** Each routine exposes the
same shape: a live `targets` array to raycast against, `start`/`update`/`stop`,
`resolveHit`/`resolveMiss`, and `aimTarget()` (the engaged target each telemetry frame
records; multi-target moving routines also set `tracksBoardTrajectory`). `update()` returns
`{expired}` using frozen module-level constants, since it runs every frame. A routine is
built fresh per session, so mode and difficulty changes always take effect on the next
start — which means `stop()` must dispose its pool or meshes accumulate in the scene.
Targets are pooled (`createTargetPool` in `target.js`): allocating geometry mid-session
would stutter the frame. The moving routines (spidershot, strafing, switching) share
`routines/motion.js` for this: `frameDelta()` caps a single frame's elapsed time at 50ms
so a backgrounded tab doesn't teleport a target on return, and `clampInside`/`bounce`
implement the inset-spawn and wall-reflection invariants below.

**The in-browser Bot Mode was removed** (no `?bot=`, no `bot.js`). Synthetic reference data
is now produced only under a subject provisioned server-side as `kind='synthetic'`, never by
a client-controlled flag. `game.update()` samples the human's aim each frame; without a
running session it returns immediately.

**The home screen is the resting state.** `main.js` runs three screens — HOME, PLAYING,
PAUSED. Pointer lock still bounds a session, but HOME sits in front of it: Start requests
the lock, `Esc` unlocks into PAUSED, and PAUSED can return to HOME. `settings.js` owns
`{dpi, sens, difficulty, routine}`, persists to localStorage, sanitises everything it
reads back, and notifies subscribers; `src/ui/home.js` is the only module touching that DOM.

`constants.js` holds defaults and every tunable (FOV, spawn volume, flick timing). Numbers
belong there or in `difficulty.js`, not inline.

## Invariants that break silently if violated

- **`camera.updateMatrixWorld()` before every raycast.** Three only recomposes that matrix
  during `render()`, so without it a click is judged against the previous frame's aim.
  This was a real bug (commit `3c8c1c2`).
- **The telemetry buffer is replaced, never emptied in place.** `beginAttempt()` assigns a
  new array because the previous attempt's array is still travelling to Supabase; clearing
  it with `length = 0` would ship an empty `trajectory`.
- **Target radius must never scale with distance.** Depth variance in `SPAWN_VOLUME` is the
  whole point — constant screen size would make the Z axis cosmetic (PRD §5.3).
- **Sensitivity is one value; `main.js` must push a settings change into `applySensitivity`.**
  `sensitivity.js` converts DPI + in-game sens (Valorant scale, 0.07°/count) into
  `controls.pointerSpeed`, and stores `cm_per_360` on the session row as the DPI-independent
  ground truth. The `0.002` in `sensitivity.js` mirrors a PointerLockControls internal.
- **Target radius is changed by rebuilding geometry, never by scaling the mesh.** A non-unit
  scale would distort `worldToLocal` and corrupt every recorded click offset (`target.js`).
- **Never call Supabase from the pointer stream.** `onPointerMove` buffers into
  `pendingDx/Dy` and the segment's `input_events` only; the network is touched by the outbox,
  never inline.
- **Moving targets must `updateMatrixWorld()` after they move.** The routine runs before
  `renderer.render()`, and the click raycast reads `matrixWorld`, not `position`. Skip it
  and shots are judged against where the target was a frame ago.
- **Spawn inside the inset bounds before moving.** Targets spawn anywhere in
  `SPAWN_VOLUME`, but a moving one lives in that volume inset by its radius, so
  `clampInside` must run at launch or the first `bounce()` snaps it inward by up to a
  radius in one frame. This was a real bug, caught as a speed spike of 12.34 against a
  configured 5.
- **Only pass live targets to the raycaster.** Three does not skip invisible meshes, so a
  released target still in `scene.children` would register hits if it reached the ray. The
  pool keeps `active` to exactly what is on screen.

## Supabase

**The client and the pipeline now both speak the v2 schema.** The earlier v1 flat
`telemetry_logs` path has been migrated:

- `src/supabase.js` requires a **real email + password account** (anonymous sign-in was
  removed). `ensureAuth()` resolves the caller's `subject_id` from `profiles` only when a
  session exists, and returns `null` otherwise — so an unauthenticated (free) session writes
  nothing at all, which is the guarantee that no anonymous rows reach the table. It writes a
  `sessions` row (`insertSession`, awaited for its id) and hands each closed segment to the
  **durable outbox** (`insertSegment`), never a bare fire-and-forget insert. `is_human` is
  gone from the client — the label is `subjects.kind`, set server-side.
- **Segment delivery goes through `src/outbox.js`**: batched, retried with backoff, and
  mirrored to **IndexedDB** (async — never localStorage, whose sync write would hitch the
  render loop the timing features are measured from). Delivery is an idempotent upsert with
  `ignoreDuplicates` (ON CONFLICT DO NOTHING on `unique (session_id, segment_index)`), which
  needs no update privilege, so it respects append-only RLS and a partly-landed batch can be
  retried whole. `flushTelemetryKeepalive()` sends the last batch on `pagehide` with a
  keepalive fetch; anything unsent replays from IndexedDB on the next load (`initTelemetryOutbox`).
- `src/telemetry.js` builds two payloads (`buildSessionPayload`, `buildSegmentPayload`)
  and stores streams **columnar** (parallel arrays keyed by field name): `trajectory`
  (per rendered frame), `input_events` (`{t, dx, dy}`, one per raw pointer sample), and
  `board_trajectory` (the non-engaged targets' per-frame paths, only for a multi-target
  moving routine). Each segment also carries `duration_ms` (lifted from the trajectory tail).
- `src/game.js` opens the session on `start()` and holds `sessionIdPromise`; each
  `flushSegment` assembles its row synchronously and hands the promise to `insertSegment`,
  so the network never blocks the loop. It stamps `segment_index`, `started_at_ms`
  (`attemptStart − sessionStartMs`), and `engaged_index` — captured at segment start as
  `routine.targets.indexOf(aimTarget())`, no longer hardcoded to 0. `onPointerMove`
  (not `mousemove`) drains `getCoalescedEvents()` into both the per-frame trajectory and
  the segment's raw `input_events` buffer.
- `src/main.js` gathers the session hardware block (dpi/sens/`cm360`, `CAMERA_FOV`, a
  rolling `refresh_hz` estimate off the render loop, coarse device fingerprint, plus
  `app_version`/`sampling_version`) and passes it to `game.start({ session })`. It also owns
  the account panel wiring and the free-session gate (`FREE_SESSION_LIMIT` plays before the
  signup wall; those persist nothing).
- `model/src/fetch_telemetry.py` selects from the **`v_training_segments`** view with the
  service key. The view now emits the **canonical** `subject_id` (`merged_into` collapsed)
  plus `board_trajectory`/`duration_ms`, and runs `security_invoker`.

**This requires the Email provider enabled in the Supabase dashboard**, and for instant play
"Confirm email" disabled (Authentication → Providers → Email) — otherwise a new signup has no
session until the emailed link is clicked, and its first session cannot be saved. With no
credentials or no signed-in account the game still runs and simply drops rows.
`sessions.ended_at` and `poll_hz` are never written by the client: there is no update policy
(append-only), and both are derived offline with the service key.

The renamed `telemetry_logs_v1` table still holds the old flat rows; the service key can
read it, but nothing in the app writes there any more.

**The v2 shape (what `schema.sql` now defines).** Five tables, split because hardware and
settings are session-scoped while outcomes are segment-scoped:

- `subjects` — the pseudonymous person, deliberately *not* `auth.users`. Deleting an
  account drops the `profiles` row and so anonymises the telemetry rather than destroying
  it.
- `profiles` — the `auth.users` ↔ subject link. Created by an `on_auth_user_created`
  trigger, never by the client, so nobody can attach themselves to another subject.
- `sessions` — one pointer lock: routine, difficulty, resolved `routine_config`, and the
  hardware block (`dpi`, `sens`, `cm_per_360`, `refresh_hz`, `poll_hz`). Those last are
  not optional metadata: `dx`/`dy` are raw device counts, so a cross-user model without
  them learns the hardware.
- `segments` — one span of play, the same unit `game.js` already flushes. Adds
  `input_events` (raw pointer samples from `getCoalescedEvents`, sub-frame timing)
  alongside `trajectory` (per-frame, carries world state). They are not interchangeable.
- `session_metrics` — derived aggregates, written offline with the service key, read by
  the player.

Three rules the v2 design encodes, worth preserving in any migration:

- **`subjects.kind` is the authoritative human/synthetic label, not a per-row boolean.**
  Synthetic reference data is produced by driving a bot in a real browser under a subject
  provisioned server-side as `kind='synthetic'` (`kind_source='provisioned'`), never by
  trusting a client flag. `sessions.bot_mode` is legacy and always null now.
- **Append-only: there is no update or delete policy anywhere.** A behavioural reference
  set the account holder can rewrite is not a reference set.
- **`segments` has no `select` policy at all.** Trajectories are the raw material of a
  biometric template, so an account cannot download its own reference data to replay it.
  Aggregates reach the player through `session_metrics`, and the training pull goes
  through the `v_training_segments` view with the service key.

**Two sets of credentials, and they must not cross.** The browser reads `.env.local`
(`VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`) — a publishable key (`sb_publishable_...`)
or a legacy anon key, **never** a secret/service_role key, since `VITE_` values are inlined
into the bundle. The pipeline reads `model/.env` (`SUPABASE_URL`, `SUPABASE_SERVICE_KEY`) —
the service_role key, which it needs precisely because no select policy exists. In both,
the URL must be the bare origin; a `/rest/v1` suffix produces 404s, since the client
appends the path itself.

Two behaviours worth knowing: with no credentials the app still runs, logging one warning
and dropping rows; and because Vite inlines `import.meta.env` at build time, `.env.local`
must exist **before** `npm run build` or the Supabase client is tree-shaken out of the
bundle entirely.

## The offline pipeline (`model/`)

Two stages, each a module with a `--in`/`--out` CLI, so datasets are files on disk rather
than state in a notebook:

`fetch_telemetry.py` pages through the table in 1000-row batches — PostgREST caps a single
response there, so the loop is not optional — filtered by `--routine`/`--is-human`, and
writes `.parquet`, `.csv` or `.json` picked from the `--out` extension.

`features.py` flattens one segment into one row. The parts that encode real decisions:

- **Click-only fields stay NaN on non-click rows.** `time_to_click_ms`, `dwell_ms` and the
  click offsets do not exist on a `timeout` or `track` segment, and are deliberately *not*
  imputed — a fabricated reaction time would teach the classifier a lie. The v2 schema
  enforces the same thing as a check constraint.
- **Angular features come from `yaw`/`pitch`, input features from `dx`/`dy`.** The former
  are DPI-independent and comparable across users; the latter are raw counts and are only
  comparable once `sessions.dpi` is known.
- `_coerce_frames` accepts a list, a JSON string, or a Python `repr` string, because
  `to_csv()` stringifies nested structures with single quotes that `json.loads` rejects.

Keep the game's telemetry shape and this module in sync: adding a field to `sampleFrame()`
without teaching `_segment_features` about it silently trains on the old feature set.

## Verifying changes

`scene.js` needs WebGL and only runs in a browser, but `game.js`, `telemetry.js`,
`target.js` and `outbox.js` are DOM-light enough to drive headlessly in Node, which is how
the game logic has been validated (spawn distribution, hit/miss geometry, payload shape,
buffer isolation, outbox delivery). To do that:

- Stub `globalThis.document` with `addEventListener`/`removeEventListener` that capture
  handlers, then invoke them directly. Pass plain objects for `hud` and `crosshair`.
- `supabase.js` reads `import.meta.env`, which does not exist in Node and throws. Redirect
  the module to a capturing stub with a `node:module` resolve hook rather than changing the
  source.
- A harness outside the project cannot resolve the bare `three` specifier. Register a
  `node:module` resolve hook (via `register()` from an `--import`ed shim — on Windows pass it
  a `file://` URL) that maps `three` to `node_modules/three/build/three.module.js` and any
  `.../supabase.js` to a capturing stub; then drive `game.js` with a stub `document` that
  records handlers by type. This is how the segment-payload shape (`engaged_index`,
  `board_trajectory`, `duration_ms`) is validated headlessly.
- `src/outbox.js` is pure and injectable: pass a `send`/`store` stub to check batching,
  idempotent dedupe, retry-on-failure, keepalive, and IndexedDB replay with no browser.
- `settings.js` needs `globalThis.window.localStorage` stubbed; a `Map` is enough.
  `createControls` needs a fake element carrying `ownerDocument` with add/removeEventListener.
- Sensitivity has a known-good reference: Valorant sens `0.4` @ `800` DPI is `40.8 cm/360`.

Movement is best checked by driving a routine directly on **synthetic timestamps**
(`routine.update(i * 8)`) rather than through the game and real sleeps: it is instant and
deterministic. Sample positions per frame, then derive speed and per-frame turn angle from
the displacement vectors. That is how "constant speed", "smooth arcs" and "abrupt cuts"
are verified as numbers rather than impressions.

The `model/` side needs no database to exercise: `build_features()` takes a DataFrame, so
a handful of hand-built segment dicts (one per outcome — `hit`, `miss`, `timeout`, `track`)
is enough to check that click-only columns stay NaN off click rows and that a
single-frame segment does not divide by zero. Pull real rows only when the question is
about the data rather than the code.

Browser-only criteria — pointer lock, `Esc` pausing, mouse feel, and rows actually landing
in the database — still need a human to confirm.

## Conventions

Commit messages follow Conventional Commits (`feat:`, `fix:`, `chore:`, `docs:`). Keep
modules small and single-purpose; the largest is `game.js` at ~340 lines. No dead code,
no TODOs left behind, no `.env.local` in git.
