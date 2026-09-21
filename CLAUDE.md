# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 🚨 General Agent Rules 🚨
Before making any changes or decisions, you MUST read and follow the general agent rules located in `.claude/rules/rules.md`.
**CRITICAL: NEVER USE GIT OR VERSION CONTROL COMMANDS.**

## Scope & plan

`aim-simulator-prd.md` is the specification. v1 (§8's four phases) shipped and is verified
against §9. The project is now in **v2**: a multi-routine trainer with a home screen,
player-configurable sensitivity, and a difficulty manager — all marked **(v2)** in the
PRD's §3. Multiple concurrent targets, moving targets, and menus are **in** scope now;
the older text saying otherwise has been amended.

Alongside the game, an **offline Python pipeline is planned to live in `model/`**: it will
pull telemetry back out of Supabase and train a human-vs-bot classifier. It is a separate
program, not a backend — nothing in `src/` imports it, nothing in it reaches the browser,
and it runs by hand after the fact. The PRD's "no Python backend" means the *game* has no
server; it does not forbid `model/`. **The code for it does not exist yet** — see
"Implemented so far" below for exactly what does.

Still out of scope: no LLM integration, no coaching/archetyping, no leaderboards, no
sound, and no inference in the browser — the classifier will be trained and applied
offline, once it exists.

The **browser app's** runtime dependencies are **only** `three` and
`@supabase/supabase-js`. No frameworks — the home screen and overlays are plain HTML/CSS.
Adding a dependency or a framework *there* is a spec violation, not an improvement.
`model/requirements.txt` is a separate dependency set and is not bound by that rule.

## Implemented so far

**Game (`src/`) — complete for v2's current scope:**
- **Five routines shipped**: precision flick, static flicking (gridshot), dynamic reflex
  (spidershot), reactive strafing, and target switching. `src/routines/index.js` is both
  the catalogue and the factory — it gates each tile with `available`, and `isAvailable`
  also requires a registered factory, so a new routine needs both. `src/difficulty.js`
  holds every per-routine parameter.
- Timed runs (5/10/15 min) with a home screen, pause/resume via pointer lock, and a
  results screen. See "Architecture" below for the full session/segment model.
- Full v2 telemetry pipeline: session + segment tables, columnar per-frame trajectories,
  a durable IndexedDB-backed outbox with retry/backoff, and DPI-independent sensitivity
  tracking.
- Real email/password + Google OAuth accounts (`src/supabase.js`), consent stamping, and
  a hard sign-in gate — **playing requires an account; there is no free-run allowance**
  (the old `FREE_SESSION_LIMIT` trial was removed 2026-09-17, see "Architecture").
- The in-browser Bot Mode has been **removed entirely** — no `?bot=`, no `bot.js`.

**Database (`schema.sql`) — the v2 shape, plus a label-integrity fix layered on top:**
- Five tables (`subjects`, `profiles`, `sessions`, `segments`, `session_metrics`) plus the
  `v_training_segments` view, RLS on every client-facing table, append-only by design.
- **`subjects.kind` is now default-deny** (`'unknown'` by default, not `'human'`), with a
  provenance constraint and a three-valued label in the training view. This was a real
  bug — every signup used to enter the training set as a verified human — fixed across
  `schema.sql`, `CLAUDE.md`, and documented in full in **`LABELING.md`**. See "Label
  integrity" below for exactly how far this has been rolled out.

**Not yet started:**
- `model/` holds only `.env.example`, `requirements.txt`, and the gitignored `data/` and
  `models/` directories. `fetch_telemetry.py`, `features.py`, and the training code itself
  do not exist. Building bot accounts and recruiting trusted human contributors — the data
  this pipeline needs — also hasn't started.

## Commands

```powershell
npm install
npm run dev        # Vite dev server on :5173
npm run build      # static bundle to dist/
npm run preview    # serve the built dist/ on :4173
```

The offline pipeline will be a second program with its own virtualenv and its own entry
points, once it exists. Its planned one-time setup is a `.venv` in `model/`,
`pip install -r requirements.txt`, and a `model/.env` copied from `model/.env.example`:

```powershell
cd model
.venv\Scripts\Activate.ps1
python -m src.fetch_telemetry --routine flick --out data/flick.parquet
python -m src.features --in data/flick.parquet --out data/flick_features.parquet
```

Both scripts would run as modules (`python -m src.x`) from `model/`, because they'd use
relative imports; `python src/features.py` would fail. `data/` and `models/` are
gitignored — everything in them is regenerable.

> **Pipeline status: `model/src/` does not exist yet.** `model/` currently holds only
> `.env.example`, `requirements.txt`, and the gitignored `data/` and `models/` directories.
> There is no `model/README.md`, no `__init__.py`, no `config.py`, no `fetch_telemetry.py`
> and no `features.py` — the whole package is the next task. The commands above and the
> "offline pipeline" section below describe the design that rebuild targets, not code you
> can run today. Do not cite a `model/src/*.py` file as if it exists.

Windows/PowerShell is the primary dev environment; use forward slashes in code.

There is no test runner and no linter, on either side — adding one would mean adding
dependencies. See "Verifying changes" below for how this codebase is actually exercised.

## Architecture

Plain ES modules, one factory function per file, no classes and no shared mutable state
between modules. `main.js` is the only composition point: it builds the scene, controls
and HUD, injects them into `createGame()`, wires the account panel and the sign-in gate,
and owns the `requestAnimationFrame` loop.

Two scoring shapes exist, and each routine declares which with a `kind` field.
**Destructible** routines (`kind: 'destructible'` — flick, gridshot, spidershot, switching)
consume the target on a hit and spawn a replacement. **Tracking** routines
(`kind: 'tracking'` — strafing) deliberately do *not* — `resolveHit` is empty, because the
drill is staying on the target, and consuming it would turn it into a flick drill. `game.js`
branches on `kind` for both scoring and telemetry (see the segment model below).

**A timed run is the session boundary; pointer lock only pauses it.** The player picks
5/10/15 minutes on the home screen and `sessions.planned_duration_ms` records that choice.
`main.js` holds a three-state machine (`idle | running | paused`) because the `lock`/`unlock`
events alone can no longer say whether a lock starts a run or resumes one: lock either calls
`game.start()` (new session row, HUD reset, first spawn) or `game.resume()` (same session,
same `segment_index` sequence); unlock calls `game.pause()`, which freezes the clock. The run
ends when the timer expires (`onExpire` → `finishRun()`) or the player picks "End run",
and only then does a results screen appear. `game.stop()` no longer exists — it is
`pause()`/`resume()`/`end()`.

**Everything downstream of `game.update()` runs on the play clock** (`now - pausedTotalMs`),
never on raw `performance.now()`. This is a correctness requirement, not telemetry hygiene:
each routine holds its own deadline in the timestamps it was handed (`spidershot.js`'s
`expiresAt`, `strafing.js`'s `nextChangeAt`), so a raw clock after a 40-second pause expires
the target on the first resumed frame and writes a fabricated `timeout` row. One subtraction
in `game.js` means no routine needs to know pausing exists.

**A run reaching `SESSION_COMPLETE_FRACTION` (70%) of its planned duration counts as
completed** — but the client cannot record that. There is no update policy on `sessions`, so
the client stamps *intent* (`planned_duration_ms`) at insert and the verdict is **derived
offline**, exactly as `ended_at` is. The results screen shows a live figure as *progress*,
never as a saved record, and persists it nowhere: the offline number is computed from
delivered segments and legitimately differs (a segment still sitting in the outbox is not
yet a delivered row).

**One row is one *segment*, not one mesh — the unified telemetry shape.** A segment is a
span of play that closes with an `outcome`: destructible routines close on a click
(`hit`/`miss`) or a timeout (`timeout`); tracking routines have no click, so they close every
`TRACK_WINDOW_MS` (`track`), and once more when the run is paused or ends. This is what
makes one table fit
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

**Synthetic reference data is produced only under a subject provisioned server-side as
`kind='synthetic'`**, never by a client-controlled flag — Bot Mode was removed for exactly
this reason. `game.update()` samples the human's aim each frame; without a running session
it returns immediately.

**The home screen is the resting state.** `main.js` runs four screens — HOME, PLAYING,
PAUSED, RESULTS. Start requests the lock, `Esc` unlocks into PAUSED (clock frozen, Resume
continues the *same* run, "End run" finishes it), and a finished run lands on RESULTS.
`settings.js` owns `{dpi, sens, difficulty, routine, duration}` — `duration` in **minutes**,
converted once in `main.js`'s lock handler — persists to localStorage, sanitises everything
it reads back, and notifies subscribers; `src/ui/home.js` is the only module touching that
DOM.

`constants.js` holds defaults and every tunable (FOV, spawn volume, flick timing). Numbers
belong there or in `difficulty.js`, not inline.

**`style.css` opens with a `:root` token layer, and nothing below it may use a raw
colour.** Before it existed the palette was repeated by hand — `#ff5555` six times,
`#333333` seven, `#8c8c8c` five — so a brand change was a find-and-replace that could
silently miss one. Tokens cover surfaces, borders, text, accent, shot feedback, the font
stack and a six-step spacing scale.

**`main.js` publishes `BACKGROUND_COLOR` and `TARGET_COLOR` into that layer at boot**
(`publishColorTokens()`), overwriting `--color-bg` and `--color-accent`. Those two colours
exist in both worlds — Three needs numbers, CSS needs strings — and must agree or the panel
background disagrees with the scene behind it. `constants.js` is therefore the single
source; the literals in `:root` are only a pre-JS fallback. **Do not "simplify" this by
deleting either side.**

**Any rule giving an account-panel block its own `display` must pair with a `.x.hidden`
override.** `.hidden` is a bare class, so a competing `display` out-cascades it on source
order and the element becomes impossible to hide. `.screen.hidden` and `.account-row.hidden`
both exist for exactly this reason — `.account-row` is the collapsed signed-in row, which
needs `display: flex`.

**The build is multi-page, not routed.** `vite.config.js` declares three entries, and the
split is by payload, not by taste:

| Page | URL | Ships | Sign-in form |
|---|---|---|---|
| `index.html` | `/` | `landing.js` + Supabase (~57 kB gz) | **Yes** |
| `play.html` | `/play` | `main.js` + Three + Supabase (~139 kB gz) | **No** |
| `privacy.html` | `/privacy` | nothing — **no JS at all** | No |

`/` is the SEO target and the page a stranger lands on, so it must never pull in Three;
verified after every build by checking `dist/index.html`'s script tags. There is still no
router and none is wanted. `privacy.html` cannot import `style.css`, because `body {
overflow: hidden }` there exists for the game and would make a text page unscrollable.

**`play.html` has no sign-in form on purpose.** It is past the gate — you arrive already
signed in. A signed-out or unconsented visitor gets a notice linking back to `/` and a
disabled Start. Adding a third copy of the form here would mean three things to keep in
sync for a page nobody signs in on.

**`vercel.json` sets `cleanUrls: true` and `trailingSlash: false`,** which is what serves
`dist/play.html` at `/play` and 301s `/play.html` to it. `trailingSlash` is not optional
cosmetics: `/play/` would otherwise resolve relative asset paths one directory too deep.

`public/` holds `favicon.svg`, `robots.txt` and `sitemap.xml`, copied verbatim to `dist/`.
`og-image.html` sits at the repo root and is **deliberately excluded** from
`rollupOptions.input` — it is a 1200×630 template used to regenerate
`public/og-image.png` by screenshot, not a shipped page.

**`base` is `'/'`, not `'./'`, and must stay absolute.** Relative asset paths and clean
URLs are incompatible: at `/play/` a `./assets/x.js` resolves to `/play/assets/x.js` and
404s. The old rationale for `'./'` — "dist/ runs from any host or subpath" — no longer
applies, since the site is permanently at the root of `aimprint.vercel.app`. The only thing
this cost is opening `dist/index.html` over `file://`, which was never supported anyway.

**Open Graph URLs must stay absolute too**, for a different reason: crawlers do not resolve
relative `og:image`/`og:url`. Each page carries its own `canonical` and `og:url`. If the
hostname ever changes again, those tags and `robots.txt`/`sitemap.xml` are the places that
do **not** update themselves.

**Most of the other markdown in this repo predates v2 and is stale — CLAUDE.md and the
source are the authority.** **Correction, 2026-09-17: `README.md` is NOT among the stale
files.** This section previously claimed it still documented Bot Mode (`?bot=linear`), the
flat `telemetry_logs` table, a hardcoded sensitivity constant and "fire-and-forget"
inserts. All four claims were **false** — the README already describes Bot Mode's removal,
the five v2 tables, the durable outbox, and settings-based sensitivity. Treat `README.md`
as current. `TELEMETRY.md` (long, and useful for per-field semantics) still says the
client "signs in anonymously" and needs Anonymous Sign-Ins enabled (confirmed still present
at `TELEMETRY.md:13,19`), and links `model/src/features.py`, which does not exist; its
§3-4 are explicitly the v1 flat row, only §5 onward describes v2 — except that even within
§5 onward, `is_human` is still documented as a plain boolean (§551, §556-558, §717) and
several passages still discuss `telemetry_logs_v1` as a live table (§16, §291-292, §311,
§536, §588), which has since been **dropped** — see "Known defects" below.
`TELEMETRY_BY_ROUTINE.md` still references Bot Mode. `schema.sql`'s own header comment
correctly says "Five tables" — the "Four tables" claim belongs to `TELEMETRY.md:318`, not
to `schema.sql`. Read all of this for intent, never for current behaviour, and prefer
`src/telemetry.js` + `schema.sql` when they disagree.

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
- **Bump `SAMPLING_VERSION` whenever `sampleFrame()`'s shape _or clock meaning_ changes.**
  It is stamped on every `sessions` row and is the only thing that stops a training pull
  silently mixing rows produced by two different samplers. `APP_VERSION` comes free from
  `package.json` via `vite.config.js`; `SAMPLING_VERSION` is hand-maintained in
  `constants.js`, so it is the one that gets forgotten. It is **3**: at 3 the frame clock
  excludes paused time, so `t` and `started_at_ms` are active-play milliseconds.
- **A click in a tracking routine writes no row.** `trackingShot()` flashes the crosshair
  and moves the HUD's `hits`/`attempts`, but does not close a segment, does not touch
  `clicks`, and does not call `flushSegment` — tracking segments close only on the
  `TRACK_WINDOW_MS` boundary, on `pause()` and on `end()`. Routing a tracking click through
  `shoot()` would fabricate `time_to_click_ms` on a drill that has no reaction event.
- **Never reset `segmentIndex` outside `start()`.** Resetting it on resume makes the
  post-pause rows collide with the pre-pause ones, and a collision is indistinguishable
  from a redelivery: the outbox reads `23505` on `unique (session_id, segment_index)` as
  "this row already landed" and settles it. So the entire second half of every paused
  session is discarded with no error, no warning and no retry. The loudest failure in the
  codebase is the one that prints nothing.
- **Only `beginAttempt()` may reopen a segment buffer; `flushSegment()` does not clear it.**
  `segmentOpen` is what stops `pause()` and `end()` shipping the same frames twice under two
  `segment_index` values — legal rows that no constraint catches. A destructible attempt
  interrupted by a pause is **discarded**, never flushed: there is no honest `outcome` for
  it, and `timeout` would fabricate a failure (and make `timeout` reachable for `flick`,
  where it cannot occur).
- **`SESSION_COMPLETE_FRACTION` is mirrored by the offline derivation.** Change one without
  the other and the number the player sees disagrees with the number the pipeline records.
  The client's verdict is display-only and must never be persisted.
- **The play gate is duplicated on purpose and the two halves must agree.** `canPlay()`
  (`main.js`) guards the click path; `applyStartGate()` (`home.js`) disables the button.
  Neither may grow a condition alone — a gate that passes in one and fails in the other is
  either an unreachable button or a bypass. They are not collapsed into one because
  `home.js` deliberately does not import `supabase.js`; auth reaches it only as injected
  callbacks and rendered state.
- **`ui/auth-panel.js` resolves its controls by `data-auth`, scoped to the root it is
  given — never by global id.** That is what lets the landing pages style the form however
  they like while sharing one implementation, and what stops two panels colliding. The
  names are listed in `REQUIRED` at the top of that file and must match the markup; a
  missing one throws **at construction**, naming it, rather than failing on first click.
  It also sets block visibility with an **inline `display`**, deliberately, because it runs
  on pages whose CSS it does not control and a class-based toggle loses to any rule giving
  a block its own `display` (the `.x.hidden` trap below).
- **`subjects.kind` is default-deny; never write a model prediction back into it.** See
  "Label integrity" below. This is the newest invariant in the codebase and the easiest to
  violate by accident once the pipeline exists — a retrain that consumes its predecessor's
  guesses as ground truth amplifies its own errors, silently, across every future retrain.

## Supabase

**The client and the (future) pipeline both speak the v2 schema.** The earlier v1 flat
`telemetry_logs` path has been migrated and its table dropped outright:

- `src/supabase.js` requires a **real email + password account** (anonymous sign-in was
  removed), or Google OAuth. `ensureAuth()` resolves the caller's `subject_id` from
  `profiles` only when a session exists, and returns `null` otherwise — so an
  unauthenticated (free) session writes nothing at all, which is the guarantee that no
  anonymous rows reach the table. It writes a `sessions` row (`insertSession`, awaited for
  its id) and hands each closed segment to the **durable outbox** (`insertSegment`), never
  a bare fire-and-forget insert. `is_human` is gone from the client — the label is
  `subjects.kind`, set server-side, and it is **default-deny**: a new signup is
  `'unknown'`, never `'human'`.
- **A persisted session is not proof the account still exists.** `supabase-js` restores it
  from `localStorage` and fires `INITIAL_SESSION` with no server round-trip, so a deleted or
  revoked account still renders as signed in while silently writing nothing (`ensureAuth()`
  can resolve no `profiles` row for it). `validateSession()`, called once at boot from
  `main.js` before `initTelemetryOutbox()`, forces that round-trip with `auth.getUser()` and
  signs out locally (`{ scope: 'local' }`) only on a definitive `401`/`403` — a network
  failure or a `5xx` must never be treated the same way, on the identical permanent-vs-
  transient reasoning the outbox applies to delivery failures below.
- **Segment delivery goes through `src/outbox.js`**: batched, retried with backoff, and
  mirrored to **IndexedDB** (async — never localStorage, whose sync write would hitch the
  render loop the timing features are measured from). Delivery is a **plain INSERT, never an
  upsert** — PostgREST enters its upsert path on the `Prefer: resolution=...` header alone
  (the `on_conflict` query param is inert without it), and that path is refused with `42501`
  on `segments`, which grants neither SELECT nor UPDATE by design. Both `ignore-duplicates`
  and `merge-duplicates` fail; the identical row inserts fine without the header. Idempotency
  comes from the unique `(session_id, segment_index)` instead: a re-sent row raises `23505`,
  which the outbox settles as "already delivered", so a partly-landed batch is still retried
  whole. Failures are classified by SQLSTATE — classes `22`/`23`/`42` are permanent, so the
  batch is re-sent one row at a time and only the genuinely undeliverable rows are dropped;
  everything else keeps its backoff-and-retry. Without that split, one row whose session
  belongs to a subject that is no longer signed in blocks every row behind it forever. `flushTelemetryKeepalive()` sends the last batch on `pagehide` with a
  keepalive fetch; anything unsent replays from IndexedDB on the next load (`initTelemetryOutbox`).
- `src/telemetry.js` builds two payloads (`buildSessionPayload`, `buildSegmentPayload`)
  and stores streams **columnar** (parallel arrays keyed by field name): `trajectory`
  (per rendered frame), `input_events` (`{t, dx, dy}`, one per raw pointer sample), and
  `board_trajectory` (the non-engaged targets' per-frame paths, only for a multi-target
  moving routine). Each segment also carries `duration_ms` (lifted from the trajectory tail).
- `src/game.js` opens the session on `start()` and holds `sessionIdPromise`; each
  `flushSegment` assembles its row synchronously and hands the promise to `insertSegment`,
  so the network never blocks the loop. It stamps `segment_index`, `started_at_ms`
  (`attemptStart − sessionStartMs`, on the play clock, so paused time is excluded), and
  `engaged_index` — captured at segment start as
  `routine.targets.indexOf(aimTarget())`, no longer hardcoded to 0. `onPointerMove`
  (not `mousemove`) drains `getCoalescedEvents()` into both the per-frame trajectory and
  the segment's raw `input_events` buffer.
- `src/main.js` gathers the session hardware block (dpi/sens/`cm360`, `CAMERA_FOV`, a
  rolling `refresh_hz` estimate off the render loop, coarse device fingerprint, plus
  `app_version`/`sampling_version`) and passes it to `game.start({ session })` alongside
  `plannedDurationMs`. It also owns the account panel wiring and the **sign-in gate**:
  `canPlay()` is simply `authState.status === 'signed_in'`. The gate is **duplicated by
  design** — `canPlay()` guards the click path in `main.js`, `applyStartGate()` disables the
  button in `home.js` — and the two must agree, so neither may grow a condition alone.
  The `FREE_SESSION_LIMIT` trial that used to precede this was **removed 2026-09-17**: it
  wrote nothing (no auth session, no subject to attach to), so every run it granted was
  play the project could not learn from — roughly twenty minutes discarded per recruited
  participant. Since the telemetry is the deliverable, capturing the first session beats
  the conversion a try-before-signup hook buys. The underlying guarantee is unchanged and
  still enforced server-side: **no auth session, no write.**
- **Consent is server state, and it gates play.** `profiles.consent_version` is the single
  source of truth. `resolveSubjectFor()` reads it alongside `subject_id` (one query, the
  `profiles select own` policy covers both), and it is published on the auth state as
  `consented`. `canPlay()` in `main.js` is `signed_in && consented === true`;
  `applyStartGate()` in `home.js` mirrors it. `consented === null` means the read is still
  in flight and is treated as not-playable, never assumed either way.
  - **No sign-in path stamps consent.** It is collected once from the `#account-consent`
    block that appears after a session exists — the first moment it can actually be
    written. The previous design called `recordConsent()` on every successful sign-in
    while the checkbox only gated sign-**up** and Google, so consent was recorded for a
    path where nobody ever ticked anything. That is fixed, not merely mitigated.
  - **The localStorage `pending-google-consent` flag is gone.** It could not survive a
    magic link opened on a different device from the one that requested it: no flag, no
    stamp, and play continued regardless. Reading the column makes the rule unconditional.
  - `refreshConsent()` guards against a race — a sign-out or a different sign-in landing
    mid-flight would otherwise attach one account's consent to another's session.
  - **`consented` compares against `CONSENT_VERSION`, not merely null-checks.** Bumping the
    constant in `constants.js` therefore re-prompts every existing player. That is
    intended: it is what stops agreement to superseded wording being silently honoured. Do
    not weaken it to a presence check, and bump the version only on a material change.
- `model/src/fetch_telemetry.py` (**not yet written**) is meant to select from the
  **`v_training_segments`** view with the service key. The view emits the **canonical**
  `subject_id` (`merged_into` collapsed) plus `board_trajectory`/`duration_ms`, and runs
  `security_invoker`. **`is_human` is three-valued** — `true`/`false`/`NULL`, where `NULL`
  is an unlabelled subject (the default state of every public signup) and must be excluded
  with `where is_human is not null`, never coerced or imputed. The view also emits
  `subject_kind_source`, `subject_cohort` and `subject_labeled_at`.

**This requires the Email provider enabled in the Supabase dashboard.** **"Confirm email" is
ON as of 2026-09-17** (Authentication → Providers → Email) — a deliberate reversal of this
file's earlier advice to disable it, made once custom SMTP was working. Rationale: a
verified address is how a participant gets invited back for session 2, and
sessions-per-subject across separate days is the binding constraint on the biometric model,
so it is worth more than signup conversion.

Consequences, both of which are fine and neither of which loses data:
- A new signup has **no session** until the emailed link is clicked, so `signUp()` returns
  `needsConfirmation: true` and `recordConsent()` defers to the later sign-in.
- The player cannot start a run until confirmed. Combined with the removal of the free-run
  trial, this means **every run now belongs to an authenticated subject and is saved** —
  the old "first session cannot be saved" warning no longer applies, because there is no
  longer an unauthenticated run to lose.

Custom SMTP is live on `smtp.gmail.com:587` with a Gmail App Password. Note the built-in
Supabase mailer is capped at **2 emails/hour** and is not usable for real signups; custom
SMTP raises that to 30/hour by default (Authentication → Rate Limits). With no
credentials or no signed-in account the game still runs and simply drops rows.
`sessions.ended_at` and `poll_hz` are never written by the client: there is no update policy
(append-only), and both are derived offline with the service key.

**The v1 flat table has been dropped outright**, not merely renamed-and-ignored:
`telemetry_logs` was renamed `telemetry_logs_v1`, kept as a graveyard for a while, and has
since been deleted. `schema.sql` no longer renames or revokes on it — see "Known defects"
below for the live incident this caused, and never reinstate either statement: `REVOKE` has
no `IF EXISTS` form, so revoking on a table that no longer exists fails with `42P01` and,
because the whole file runs as one implicit transaction, rolls back the entire migration
run.

**The v2 shape (what `schema.sql` now defines).** Five tables, split because hardware and
settings are session-scoped while outcomes are segment-scoped:

- `subjects` — the pseudonymous person, deliberately *not* `auth.users`. Deleting an
  account drops the `profiles` row and so anonymises the telemetry rather than destroying
  it.
- `profiles` — the `auth.users` ↔ subject link. Created by an `on_auth_user_created`
  trigger, never by the client, so nobody can attach themselves to another subject.
- `sessions` — one timed run: routine, difficulty, resolved `routine_config`,
  `planned_duration_ms`, and the hardware block (`dpi`, `sens`, `cm_per_360`, `refresh_hz`, `poll_hz`). Those last are
  not optional metadata: `dx`/`dy` are raw device counts, so a cross-user model without
  them learns the hardware.
- `segments` — one span of play, the same unit `game.js` already flushes. Adds
  `input_events` (raw pointer samples from `getCoalescedEvents`, sub-frame timing)
  alongside `trajectory` (per-frame, carries world state). They are not interchangeable.
- `session_metrics` — derived aggregates, written offline with the service key, read by
  the player.

Rules the v2 design encodes, worth preserving in any migration:

- **`subjects.kind` is the authoritative human/synthetic label, not a per-row boolean —
  and it is default-deny.** A new signup is `kind='unknown'`; it used to default to
  `'human'`, which silently enrolled every stranger into the training set as a verified
  human. `'human'` and `'synthetic'` are set only by a deliberate service-key write, and
  `subjects_label_has_provenance` forces `kind_source` to move with them, so a label can
  never exist without its provenance. Synthetic reference data is produced by driving a bot
  in a real browser under a subject provisioned server-side as `kind='synthetic'`
  (`kind_source='provisioned'`), never by trusting a client flag. `sessions.bot_mode` is
  legacy and always null now. **Model predictions must never be written back into `kind`** —
  ground truth is what a person decided; a retrain that consumes its predecessor's guesses
  amplifies its own errors.
- **Append-only on every telemetry table: no update or delete policy on `subjects`,
  `sessions`, `segments` or `session_metrics`.** A behavioural reference set the account
  holder can rewrite is not a reference set. The one update policy in the schema is
  `profiles update own`, and its `with check` pins `subject_id` to `current_subject_id()`
  so only the two consent columns are actually writable — that is what `recordConsent()`
  in `supabase.js` uses. Do not widen it.
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

## Label integrity — rollout status

The default-deny fix to `subjects.kind` is a **schema change plus a manual operational
runbook**, and the two are at different stages of completion. `schema.sql` and this file are
both fully updated with the design; the checklist below is the actual database state and
must be kept current by hand as the remaining steps are run. **The full runbook, verification
queries, and the review log showing how the design was challenged and corrected, live in
`LABELING.md` — read it before doing any of the remaining steps, do not improvise them.**

- [x] `schema.sql` edited: `kind` default-deny, three-valued view, provenance constraint,
  labelling runbook, one-buffer warning.
- [x] `schema.sql` applied to the live database (the migration itself has been run).
- [x] View verified to expose `subject_cohort` / three-valued `is_human` post-migration.
- [x] **One-time backfill (`LABELING.md` §5.4) confirmed unnecessary — 2026-09-17.**
  Verified against the live database, not assumed: `select count(*) from public.subjects
  where kind <> 'unknown' and kind_source = 'default'` returned **0**, against 2 total
  subjects both sitting at `kind='unknown', kind_source='default'`. No row was ever
  mislabelled, so §5.4 is a no-op here. The earlier claim that "at least one known
  account that played a flick session" carried `kind='human'` was **wrong** — it
  predated the migration and was never re-checked. Re-run the §5.2 pre-flight query
  before trusting this if the database is ever restored from an older backup.
- [x] `subjects_label_has_provenance` **VALIDATED — 2026-09-17.**
  `alter table public.subjects validate constraint subjects_label_has_provenance;`
  ran clean; `select conname, convalidated from pg_constraint where
  conrelid='public.subjects'::regclass and conname='subjects_label_has_provenance'`
  confirms `convalidated = true`. Enforced against every existing row now, not just
  future writes.
- [ ] No bot accounts provisioned yet; no trusted human contributors labelled yet
  (`LABELING.md` §5.6 has the exact batch-`UPDATE` statements). This is the one
  remaining item, and it only closes once Phase 6 recruitment/bot-provisioning starts.
- [x] The `merged_into` divergence gate (`LABELING.md` §5.7) **run — 2026-09-17.**
  Returned 0 rows (trivial at 2 subjects, neither merged). Re-run after any future
  labelling batch, per §5.7's "not optional" warning.

**Update this checklist as each step is completed** — this is the one place in the repo
meant to answer "is the label fix actually live," as opposed to "has the SQL been written."

## The offline pipeline (`model/`) — planned design, not yet built

Two stages, each intended to be a module with a `--in`/`--out` CLI, so datasets are files
on disk rather than state in a notebook. **None of the following code exists yet** — this
section documents the design decisions already made so the next session implements them
consistently rather than re-deriving them, not code you can run today.

`fetch_telemetry.py` would page through the table in 1000-row batches — PostgREST caps a
single response there, so the loop is not optional — filtered by `--routine` and `--label`,
and write `.parquet`, `.csv` or `.json` picked from the `--out` extension.

`--label` must be **three-state** (`human` | `synthetic` | `any`), not a boolean: `is_human`
is nullable, and a two-state `--is-human` flag has no way to express "exclude the
unlabelled", which is mandatory before fitting. It must default to excluding `NULL` rows —
an unlabelled subject is a stranger nobody has verified, and silently training on them is
the exact bug the default-deny label exists to prevent.

`features.py` would flatten one segment into one row. The parts that encode decisions
already made:

- **Click-only fields stay NaN on non-click rows.** `time_to_click_ms`, `dwell_ms` and the
  click offsets do not exist on a `timeout` or `track` segment, and must not be imputed —
  a fabricated reaction time would teach the classifier a lie. The v2 schema already
  enforces the same thing as a check constraint.
- **Angular features come from `yaw`/`pitch`, input features from `dx`/`dy`.** The former
  are DPI-independent and comparable across users; the latter are raw counts and are only
  comparable once `sessions.dpi` is known.
- `_coerce_frames` would need to accept a list, a JSON string, or a Python `repr` string,
  because `to_csv()` stringifies nested structures with single quotes that `json.loads`
  rejects.

Keep the game's telemetry shape and this module in sync once it exists: adding a field to
`sampleFrame()` without teaching `_segment_features` about it would silently train on the
old feature set.

**When this pipeline is built, split train/test by `subject_id` (GroupKFold), never by
row** — the view's `merged_into`-collapsed `subject_id` exists to be that grouping key.
Also train once with the hardware block (`dpi`/`refresh_hz`/`device_fingerprint`) and once
without, and compare: if bots and humans run on visibly different hardware, a model can
score near-perfectly by learning the hardware rather than the aim, then collapse on real
public users. A small initial human cohort (a handful of trusted contributors) will likely
teach the first model "is this one of these few people" rather than "is this a human" —
treat v1 as a proof of concept, not a shippable classifier.

## Known defects — not yet fixed

- **`TELEMETRY.md` is stale in two ways that "read it for intent" doesn't excuse**, because
  both sit in the section the file itself claims is current (§5 onward): (1) `is_human` is
  documented as a plain boolean passed through unchanged into `features.py` (§551, §556-558,
  §717) — it is now three-valued and nullable, and code written against the old description
  would crash `sklearn.fit()` on the first unlabelled row; (2) an entire section, §5.6 "the
  graveyard", plus references at §16, §291-292, §311 and a row in the permissions table at
  §588, still describe `telemetry_logs_v1` as a live table kept for reading — it has been
  **dropped**. Flagged repeatedly during the label-integrity work and deliberately deferred
  each time pending a decision on scope; still unfixed as of this writing.
- **Seven pre-existing `pg_constraint` guards in `schema.sql` match on `conname` alone**,
  with no `conrelid` scoping (`subjects_kind_source_check`, `sessions_dpi_positive`,
  `sessions_sens_positive`, `segments_frame_count_positive`, `segments_target_count_positive`,
  `segments_segment_index_nonneg`, `segments_durations_nonneg`). This works today only
  because every constraint name in this database happens to be unique — it is not
  load-bearing yet, but it is inconsistent with the two constraints added for the label fix
  (`subjects_kind_allowed`, `subjects_label_has_provenance`), which are properly scoped by
  `conrelid`. Cosmetic; normalize if touching this area again.
- ~~**The label-integrity backfill/validate/labelling steps are not yet confirmed
  complete.**~~ **RESOLVED 2026-09-17** — verified against the live database, not assumed.
  The backfill was a no-op (0 rows mislabelled), `subjects_label_has_provenance` is now
  `convalidated = true`, and the `merged_into` divergence gate returned 0 rows. The old
  claim that "at least one real account's data sits mislabelled" was **false** and had
  simply never been re-checked after the migration. Only §5.6 (labelling bot accounts and
  trusted contributors) remains, and it cannot start before Phase 6. See the checklist in
  "Label integrity" above for the queries and results.
- **`model/` does not exist as code.** Not a defect in anything built — a reminder that
  "the offline pipeline" throughout this file is a design, not a working program, and
  should not be cited as if it runs.

**Deliberately not defects** (recorded so they aren't "discovered" again): no predictions
table exists yet — correct, it should only be built once a model exists, and it must never
share a column with verified ground truth; there is no labelling helper function or RPC
endpoint — rejected on purpose, since PostgREST would auto-expose it to the anon key inlined
in the browser bundle; there is no email-based auto-enrollment for trusted contributors —
labelling is deliberately manual, by design, per `LABELING.md`.

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

The `model/` side needs no database to exercise once built: `build_features()` should take
a DataFrame, so a handful of hand-built segment dicts (one per outcome — `hit`, `miss`,
`timeout`, `track`) will be enough to check that click-only columns stay NaN off click rows
and that a single-frame segment does not divide by zero. Pull real rows only when the
question is about the data rather than the code.

Browser-only criteria — pointer lock, `Esc` freezing the countdown and Resume continuing the
*same* run, the duration selector, the results screen, mouse feel, and rows actually landing
in the database — still need a human to confirm.

Database migrations (`schema.sql`) can only be verified against a live Supabase instance —
paste as one buffer (never in chunks, see the file's own header warning), then run the
verification queries in `LABELING.md` §6. There is no way to dry-run this locally.

## Conventions

Commit messages follow Conventional Commits (`feat:`, `fix:`, `chore:`, `docs:`). Keep
modules small and single-purpose; the largest is `game.js` at ~380 lines. No dead code,
no TODOs left behind, no `.env.local` in git.

**Naming is split across three tiers on purpose — do not "unify" it.**

| Tier | Value | Where |
|---|---|---|
| Consumer brand | **`Aimprint`** | `index.html` `<title>`/`<h1>`, `README.md`, `package.json` `name`, PRD title, Google consent-screen app name, OG tags |
| Repository | **`PatternTrace-Simulation`** | Git remote only. Deliberately not renamed. |
| Internal plumbing | **`aim-trainer*`** | Storage keys, IndexedDB, env vars, schema |

Two internal keys remain, and both are **load-bearing and must not be renamed**:
`'aim-trainer-outbox'` (`outbox.js`) and `'aim-trainer.settings'` (`settings.js`).

Two others were retired on 2026-09-17 and no longer exist anywhere in `src/`:
`'aim-trainer.free-sessions-used'` (with the free-run trial) and
`'aim-trainer.pending-google-consent'` (with the localStorage consent flag, replaced by
the `profiles.consent_version` gate). Values left behind in a returning visitor's
localStorage are inert and never read.
Renaming the IndexedDB database **orphans undelivered telemetry already queued in users'
browsers, unrecoverably**; renaming the settings key silently resets everyone's DPI/sens.
A future session seeing `Aimprint` in the UI and `aim-trainer` in storage is looking at a
deliberate decision, not an oversight.
