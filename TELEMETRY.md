# Telemetry reference

How the aim trainer is wired, every field it records, and how those fields change
meaning per routine. Written to be handed to an agent or a notebook with no other
context.

Authoritative sources, in order: [`src/game.js`](src/game.js) (what is measured),
[`src/telemetry.js`](src/telemetry.js) (what is written),
[`schema.sql`](schema.sql) (where it is meant to go),
[`model/src/features.py`](model/src/features.py) (what is derived).

> **State of the world.** The client and the pipeline now both write and read the
> multi-user **v2** schema: `supabase.js` signs in anonymously and writes `sessions` +
> `segments` (columnar `trajectory`), and the pipeline reads `v_training_segments`.
> **Section 5 is the live shape.** Sections 3 and 4 document the legacy **v1** flat row
> (`telemetry_logs`, now renamed `telemetry_logs_v1`) — kept here because those rows
> still exist and because the per-field semantics (nullability, precision, per-frame
> fields) carried over unchanged into v2's `segments.trajectory`. The v2 write path needs
> **Anonymous Sign-Ins enabled in the Supabase dashboard**, or every row is dropped.

---

## 1. The wiring

### Composition

[`main.js`](src/main.js) is the only place modules meet. Everything else is a factory
taking dependencies as arguments — no sibling imports, no shared mutable state.

```
index.html  - #scene, #crosshair, #hud, #home, #pause   (plain DOM, no framework)
     |
main.js
     |-- createScene(#scene)                -> { scene, camera, renderer, resize }
     |-- createSettings()                   -> localStorage {dpi, sens, difficulty, routine}
     |-- createSensitivity(settings)        -> pure math, no DOM
     |-- createControls(camera, body, sens) -> PointerLockControls
     |-- createHud()
     |-- readBotMode() / createBot()        -> only when ?bot=linear|smoothed
     |-- createGame({scene, camera, crosshair, hud, bot})
     `-- createHome({settings, onStart, onResume, onMenu})
```

The render loop is four lines and owns the ordering everything depends on:

```js
game.update(now);              // routines move targets, telemetry samples
renderer.render(scene, camera);
```

### The world

The camera sits at `(0, 0, 0)` and **only ever rotates** — there is no movement.
So `target_distance` is always just `|target.position|`, and world coordinates are
camera-relative by construction.

| | value | source |
|---|---|---|
| Camera FOV | 90 deg vertical | `CAMERA_FOV` |
| Spawn volume | x +/-8, y +/-4, z -25..-8 | `SPAWN_VOLUME` |
| Min spawn distance | 5 world units | `MIN_SPAWN_DISTANCE` |
| Target radii | 0.3 - 0.9 by routine/difficulty | [`difficulty.js`](src/difficulty.js) |

A target of radius `r` at distance `d` subtends approximately `r/d` radians. At r=0.5,
d=15 that is ~0.033 rad ~= 1.9 deg. Use this to convert world-unit click offsets into
angles.

### Sensitivity — one value, two consumers

[`sensitivity.js`](src/sensitivity.js) is the only place DPI and in-game sens become
an angle. `degPerCount = sens * 0.07` (Valorant scale) -> radians ->

| output | consumer | purpose |
|---|---|---|
| `pointerSpeed` | `controls.pointerSpeed` | human camera rotation |
| `radiansPerMovementUnit` | `bot.setRadiansPerMovementUnit` | inverted to fake mouse counts |
| `cm360` | home screen readout | the only externally checkable value |

If these two drift apart, the game still looks correct while every synthetic bot row
silently describes the wrong rotation.

### Session boundary

Pointer lock **is** the session. `lock` -> `game.start()` (fresh
`crypto.randomUUID()`, new routine instance, counters reset). `unlock` -> `game.stop()`.
Re-locking always starts a new session; it never resumes. A difficulty or routine
change therefore cannot take effect mid-session.

### One frame, in order

[`game.js:259-297`](src/game.js#L259-L297):

```
1. routine.update(now)         -> targets move; may return {expired: n}
2. if expired: flushSegment('timeout'); beginAttempt(now)
3. resolve dx,dy               -> bot: bot.advance() drives camera, returns synthetic step
                                  human: drain pendingDx/pendingDy from mousemove
4. sampleFrame(now, dx, dy)    -> AFTER targets moved (aim and world recorded together)
5. bot only: if step.done && kind !== 'tracking' -> shoot(now)
6. tracking only: if now - attemptStart >= 1000ms -> flushSegment('track'); beginAttempt(now)
```

Step 4 sitting after step 1 is the whole reason tracking data is usable. `sampleFrame`
also raycasts every frame purely to compute `on`, and that raycast stamps `dwellStart`
on first contact.

### One click, in order

`mousedown` -> [`shoot()`](src/game.js#L202-L228) for destructible routines:

```
timeToClickMs = now - attemptStart
dwellMs       = dwellStart === 0 ? null : now - dwellStart
struck        = raycastCenter()             <- camera.updateMatrixWorld() first, always
targetDistance= hit ? dist(struck) : nearestTargetDistance()
clickOffset   = hit ? computeClickOffset() : null
-- resolve and re-arm first, off the latency path --
flash(); routine.resolveHit() | resolveMiss()
flushSegment('hit'|'miss', {...}); beginAttempt(now)
HUD counters
```

Tracking routines route to [`trackingShot()`](src/game.js#L232-L239) instead: flash and
HUD only. **No row is written for a click during tracking.**

### The routine contract

```js
{ kind, targets, start(now), update(now), resolveHit(t, now), resolveMiss(now), aimTarget(), stop() }
```

`kind` is `'destructible'` (consume the target on hit, spawn a replacement) or
`'tracking'` (`resolveHit` is deliberately empty — consuming the target would turn a
tracking drill into a flick drill). `game.js` branches on it for both scoring and
telemetry. `update()` returns `{expired}`. A routine is built fresh per session, so
`stop()` must dispose its pool.

### The bot

[`bot.js`](src/bot.js) is a camera driver, not a player. `beginFlick` computes yaw/pitch
to the target's position **at that instant** (no leading) and a duration of
`150ms + rand * (350 + angularDistance * 120 - 150)`. `advance` sets rotation absolutely
from the flick start so frames cannot accumulate drift, then back-computes the mouse
counts that rotation implies, rounds to integers, and carries the rounding error into
the next frame so emitted deltas sum to exactly the rotation performed. `linear` uses
raw progress; `smoothed` uses `3t^2 - 2t^3`.

In bot mode the `mousemove` listener is never attached and human clicks are ignored, so
a synthetic row cannot be contaminated.

---

## 2. The data model in one paragraph

**One row is one _segment_, not one target.** A segment is a span of play that closes
with an `outcome`. Destructible routines close a segment on a click (`hit`/`miss`) or a
timeout (`timeout`); tracking routines have no click, so they close every 1000 ms
(`track`) and once more on `stop()`. Every segment carries the board layout at segment
start, a per-frame stream of aim *and* world state, and — only if a click landed — the
click-derived fields. That is what makes one table fit all five routines.

Explained plainly: every try is one index card. The card says how the try ended, has a
photo of where the balloons were at the start, a flipbook with one snapshot per rendered
frame (your hand, your eyes, the balloon, and whether they are touching), and a few
extra numbers that exist only if you actually clicked. Hand and eyes are recorded
separately on purpose: `dx/dy` is what your hand did and depends on your DPI, so it is
not comparable between players; `yaw/pitch` is where you ended up looking and is.

---

## 3. Complete field reference — what is collected today (v1)

The v1 table's DDL is no longer in the repo (`schema.sql` was rewritten for v2), so
[`buildPayload()`](src/telemetry.js) is the authoritative column list. It writes
**14 columns** to `telemetry_logs`, plus whatever server-side defaults that table
carries (`id`, `created_at`).

### 3.1 Row columns

| column | type | value | notes |
|---|---|---|---|
| `session_id` | uuid | `crypto.randomUUID()` at `game.start()` | one per pointer-lock session. Not orderable — see Trap 9 |
| `is_human` | bool | `bot === null` | **client-computed, forgeable.** v2 replaces this with `subjects.kind` |
| `bot_mode` | text | `null` for human, `'linear'` or `'smoothed'` for bot | debugging hint only |
| `routine` | text | `flick`, `gridshot`, `spidershot`, `strafing`, `switching` | |
| `difficulty` | text | `easy`, `medium`, `hard` | resolves to a [`difficulty.js`](src/difficulty.js) entry **not stored on the row** |
| `outcome` | text | `hit`, `miss`, `timeout`, `track` | which outcomes are reachable depends on routine — see §6 |
| `target_distance` | float | world units from camera (= origin) | semantics vary by outcome, see §3.4 |
| `time_to_click_ms` | int | `now - attemptStart` | **click only**, null otherwise |
| `dwell_ms` | int | `now - dwellStart` | **click only**, and null even then if the crosshair never touched a target |
| `click_offset_x` | float | world units, camera-plane right axis | **hit only** — null on `miss` too |
| `click_offset_y` | float | world units, camera-plane up axis | **hit only** |
| `target_count` | int | `targets.length` at segment start | constant per (routine, difficulty) — see Trap 3 |
| `targets` | jsonb | board snapshot at segment start | array of `{x, y, z, r}`, see §3.3 |
| `trajectory` | jsonb | per-frame stream | array of frame objects, see §3.2 |

`click_offset_*` is measured on the plane perpendicular to the camera-to-target vector
(`forward = target - camera`, `right = forward x worldUp`, `up = right x forward`), in
world units. It stays valid only because targets are never rotated or scaled — radius
changes rebuild the geometry ([`target.js:29`](src/target.js#L29)).

### 3.2 `trajectory[]` — one entry per **rendered frame**

Sampled in `sampleFrame()`, once per `requestAnimationFrame`, *after* the routine has
moved its targets. Cadence therefore equals the display refresh rate.

| field | type | meaning | precision |
|---|---|---|---|
| `t` | int | ms since **this segment** started (not the session) | rounded to 1 ms |
| `dx` | number | raw horizontal device counts this frame | human: summed `event.movementX`, unrounded. bot: integer |
| `dy` | number | raw vertical device counts this frame | same |
| `yaw` | float | camera absolute yaw, radians, from `camera.quaternion` as YXZ `.y` | 5 dp (~0.0006 deg) |
| `pitch` | float | camera absolute pitch, radians, YXZ `.x` | 5 dp |
| `tx` | float | engaged target world x | 3 dp (~1 mm) |
| `ty` | float | engaged target world y | 3 dp |
| `tz` | float | engaged target world z | 3 dp |
| `on` | 0 or 1 | crosshair intersects **any** live target | integer, not bool |

- `dx/dy` are DPI-dependent **and** refresh-dependent (accumulated per frame).
  `yaw/pitch` are neither — prefer them for cross-user features.
- `tx/ty/tz` are `null` when no target exists. They track `routine.aimTarget()`, which
  is `pool.active[0]` — **not necessarily the target the player is engaging.** See Trap 1.
- `on` is true for *any* target, not the engaged one. See Trap 2.

### 3.3 `targets[]` — board snapshot at segment start

| field | type | meaning |
|---|---|---|
| `x`, `y`, `z` | float | target world position, 3 dp |
| `r` | float | target radius, world units, from the active difficulty |

Taken once in `beginAttempt()`. For moving routines (strafing, switching) it describes
frame 0 only and is stale immediately. There is **no index identifying which entry was
engaged** — v2 adds `engaged_index` for exactly this.

### 3.4 Nullability by outcome

| column | `hit` | `miss` | `timeout` | `track` |
|---|---|---|---|---|
| `target_distance` | distance to struck target | distance to **nearest** target | `null` | distance to `aimTarget()` |
| `time_to_click_ms` | value | value | `null` | `null` |
| `dwell_ms` | value, or `null` if never on target | value, or `null` | `null` | `null` |
| `click_offset_x/y` | value | **`null`** | `null` | `null` |
| `targets` / `target_count` | always | always | always | always |
| `trajectory` | always non-empty | always | always | always |

An empty segment (no frame sampled yet) is never shipped.

Note the asymmetry: the schema comment calls the offsets "click segments only
(hit/miss)", but the code sets them **only on a hit**. Treat `click_offset_*` as
hit-only.

---

## 4. Invariants that keep this data honest

Violating any of these corrupts telemetry silently — the game still looks fine.

- **`camera.updateMatrixWorld()` before every raycast.** Three only recomposes that
  matrix during `render()`; without it a click is judged against the previous frame's aim.
- **The telemetry buffer is replaced, never emptied in place.** `beginSegment()` assigns
  a new array because the previous segment's array is still travelling to Supabase.
  `length = 0` would ship an empty trajectory.
- **Moving targets must `updateMatrixWorld()` after they move**, for the same reason —
  the click raycast reads `matrixWorld`, not `position`.
- **Target radius never scales with distance**, and is changed by rebuilding geometry,
  never by scaling the mesh — a non-unit scale distorts `worldToLocal` and corrupts every
  recorded click offset.
- **Spawn inside the inset bounds before moving**, or the first `bounce()` snaps a target
  inward by up to a radius in one frame (a real bug, caught as a speed spike of 12.34
  against a configured 5).
- **Only live targets are passed to the raycaster.** Three does not skip invisible meshes.
- **Bot deltas are integers with the rounding error carried between frames**, so they
  look like real mouse counts and still sum to exactly the rotation performed.
- **Never call Supabase from `mousemove`.** Buffer only; inserts are fire-and-forget.

---

## 5. What the v2 schema defines but nothing writes yet

[`schema.sql`](schema.sql) — five tables plus a training view. The client and
`fetch_telemetry.py` both still target the flat v1 table, so running this schema breaks
logging in both directions until they are migrated. It also **renames `telemetry_logs`
to `telemetry_logs_v1`** and revokes `anon` entirely.

### 5.0 The shape of it

The chain is: **a person** -> **their account** -> **one play session** -> **the moments
inside it**, plus scores derived afterwards.

```
subjects          the pseudonymous person          survives account deletion
    ^
profiles          login account -> person          dies with the account
    ^
sessions          one pointer lock: one routine, one difficulty, one mouse setup
    ^
segments          one shot / one timeout / one tracking window   <- the model's unit
    ^
session_metrics   aggregates computed offline, read by the player
```

Alongside them sit `telemetry_logs_v1` (the renamed v1 table, kept and ignored) and
`v_training_segments` (a saved query, not a table).

The split exists because hardware and settings are **session**-scoped while outcomes are
**segment**-scoped. Storing dpi/sens/refresh on every segment row would both bloat the
table and permit a session whose rows disagree about the DPI.

> Two stale bits in the file itself: the header comment says "Four tables" (there are
> five — `session_metrics` was added later) and it does not mention the view.

### 5.1 `subjects` — the pseudonymous person

Who you are, with no name attached. Deliberately **not** `auth.users`: deleting an account
drops the `profiles` row that maps a person to their `subject_id`, leaving the telemetry
intact but no longer attributable — it anonymises the data rather than destroying it.

| column | type | meaning |
|---|---|---|
| `subject_id` | uuid pk | the permanent random ID for this person; everything else points here |
| `created_at` | timestamptz | when this person first appeared |
| `kind` | text | `'human'` or `'synthetic'` — **the one authoritative label** |
| `consent_version` | text | which version of the consent text they agreed to |
| `consented_at` | timestamptz | when they agreed |

`kind` lives here rather than on a segment because a client can lie about a row but cannot
change its own subject. Bot Mode runs (`?bot=linear`) execute in a real browser, so the
browser genuinely does produce synthetic data — the way to keep that out of the human set
is to run it under a subject flagged `synthetic` with the service key, never to trust a
per-row boolean. There is **no client write policy of any kind** on this table; `kind` in
particular must stay unwritable, or a synthetic run could relabel itself human.

Consent is stamped here, not only on `profiles`, so the record of permission survives
account deletion along with the data it authorises.

### 5.2 `profiles` — the bridge from login to person

One row per signed-in account. Its whole job is to say "this login = that subject."

| column | type | meaning |
|---|---|---|
| `user_id` | uuid pk -> `auth.users` | the Supabase auth account. Deleting it cascades here, severing the link |
| `subject_id` | uuid, not null, **unique** | which person this account is. Unique, so two accounts cannot claim the same subject. Readable by the user, never writable |
| `created_at` | timestamptz | when the account was made |
| `display_name` | text | optional nickname for the UI |
| `consent_version` | text | account-side copy of the consent version |
| `consented_at` | timestamptz | account-side copy of the timestamp; dies with the account |

Created by an `on_auth_user_created` trigger (`handle_new_user()`), never by the client, so
a user cannot attach themselves to somebody else's subject. `current_subject_id()` is a
`stable security definer` helper the RLS policies call, so they can read `profiles` without
the client being granted select on it.

### 5.3 `sessions` — one pointer lock

One row every time the mouse is captured. `Esc` and re-lock makes a **new** session; it
never resumes (§1, Session boundary). A routine is built fresh per session, so routine and
difficulty are genuinely session-scoped and belong here.

**Identity and timing**

| column | type | meaning |
|---|---|---|
| `id` | uuid pk | this session's ID |
| `subject_id` | uuid -> `subjects` | whose session it was; cascades on subject delete |
| `started_at` | timestamptz | when it began — **server clock, never client-supplied**: a client-set timestamp is forgeable, and ordering matters for both fatigue effects and replay detection |
| `ended_at` | timestamptz | when it stopped |

**What was played**

| column | type | meaning |
|---|---|---|
| `routine` | text | which drill: flick, gridshot, spidershot, strafing, switching |
| `difficulty` | text | easy / medium / hard |
| `routine_config` | jsonb | the **resolved** [`difficulty.js`](src/difficulty.js) entry for this session — target radius, speed, TTL — frozen so a later retune of `ROUTINE_CONFIG` does not retroactively mislabel what was actually played |

**Sensitivity** — see §1, "one value, two consumers"

| column | type | meaning |
|---|---|---|
| `dpi` | int | mouse DPI |
| `sens` | double | in-game sensitivity (Valorant scale, `0.07` deg/count) |
| `cm_per_360` | double | cm of desk for a full turn — the DPI-independent ground truth, **stored rather than derived** so a later change to [`sensitivity.js`](src/sensitivity.js) cannot silently reinterpret old rows |

Why this matters: `dx`/`dy` are raw **mouse counts**, not degrees. A count of 10 is a
different rotation at 400 DPI than at 1600.

**Rendering and input rates** — measured client-side over the session

| column | type | meaning |
|---|---|---|
| `fov_deg` | double | field of view; changes how far a target *feels* in degrees |
| `refresh_hz` | double | display refresh — sets how densely `trajectory` is sampled, since a frame is sampled once per rendered frame |
| `poll_hz` | double | mouse polling rate — sets how densely `input_events` is sampled |

The hardware block is not optional metadata — `dx/dy` are raw counts and are meaningless
across users without `dpi`; frame cadence scales with `refresh_hz`; event cadence with
`poll_hz`. Without these three, a model trained across users learns the hardware.
**These are the columns whose absence makes v1 `input_speed_*` features uncomparable
between users.**

**Machine fingerprint** — coarse on purpose: enough to hold out a device and check whether
a biometric model generalises across hardware, not enough to be a tracking identifier of
its own

| column | type | meaning |
|---|---|---|
| `device_fingerprint` | text | rough hash of the machine |
| `user_agent` | text | browser string |
| `platform` | text | OS |
| `screen_width` / `screen_height` | int | screen size in pixels |
| `device_pixel_ratio` | double | display scaling factor — the cause of Trap 8's fractional human `dx/dy` |

**Bookkeeping**

| column | type | meaning |
|---|---|---|
| `bot_mode` | text | Bot Mode as the client reports it (`linear`/`smoothed`). **A hint for debugging only** — client-controlled, and must never be used as a training label. Use `subjects.kind` instead |
| `app_version` | text | stamp of the code that produced the session. Without it, a change to the sampler or to `difficulty.js` silently mixes incomparable rows into one set |
| `sampling_version` | int | which frame-sampling format was used (currently `2`) |

### 5.4 `segments` — one moment of play

The main table, and the unit the model consumes. Same definition as §2: one row is one
segment, not one mesh. Destructible routines close a segment on a click (`hit`/`miss`) or a
timeout; tracking routines close one every `TRACK_WINDOW_MS` (`track`) and once more on
`stop()`.

**Where it sits**

| column | type | meaning |
|---|---|---|
| `id` | uuid pk | this segment's ID |
| `session_id` | uuid -> `sessions` | which session it belongs to; cascades |
| `segment_index` | int | 1st, 2nd, 3rd… within the session. Warmup, fatigue and any sequence model need ordering, and `created_at` cannot supply it: inserts are fire-and-forget and can land out of order |
| `created_at` | timestamptz | when the database received it |
| `started_at_ms` | int | ms from session start to segment start, from the same `performance.now()` clock the frames use |

`segments_session_order` is a unique constraint on `(session_id, segment_index)` — one
session cannot contain two segment #4s.

**What happened**

| column | type | meaning |
|---|---|---|
| `outcome` | text | `hit`, `miss`, `timeout` or `track`, restricted to exactly those four by a check constraint |
| `target_distance` | double | engaged target distance at segment end. Null for a timeout — the target is already gone; the per-frame positions still carry it |

**Click segments only** (`hit`/`miss`) — null on `timeout` and `track`, because there was no
landed shot

| column | type | meaning |
|---|---|---|
| `time_to_click_ms` | int | reaction time: target appeared -> you clicked |
| `dwell_ms` | int | how long the crosshair rested on a target before firing. May also be null on a hit or miss when the crosshair never registered contact before the click — which is why only one direction is enforced by the constraint below. See Trap 2 and Trap 4 |
| `click_offset_x` | double | where on the target you landed, camera-plane right axis |
| `click_offset_y` | double | camera-plane up axis. Together they say whether you overshoot left, undershoot high, etc. |

**The board**

| column | type | meaning |
|---|---|---|
| `target_count` | int | how many targets were on screen at segment start |
| `targets` | jsonb, not null | their positions and sizes: `[{x, y, z, r}]` |
| `engaged_index` | int | index into `targets` of the engaged target — the one `aimTarget()` returned and the one `tx/ty/tz` tracks. Without it the engaged target is only recoverable by matching coordinates, which breaks once two targets overlap |

**The streams**

| column | type | meaning |
|---|---|---|
| `trajectory` | jsonb, not null | one entry per **rendered frame**: `{t, dx, dy, yaw, pitch, tx, ty, tz, on}`. Carries the **world state** (target position, crosshair-on-target), which only exists at render time |
| `input_events` | jsonb, nullable | one entry per **raw pointer sample** (`getCoalescedEvents`), at native polling rate: `{t, dx, dy}`. Carries **sub-frame timing**, which render-cadence sampling destroys. Nullable: a session may run without raw capture |
| `frame_count` | int, not null | length of `trajectory` |
| `event_count` | int | length of `input_events` |

The two lengths are lifted out of the jsonb so segments can be filtered and sanity checked
("drop everything under 5 frames") without parsing either blob.

The two streams are **not interchangeable**: `trajectory` without `input_events` loses the
biometric signal; `input_events` without `trajectory` loses tracking error, because it has
no idea where the target was.

Four additions matter for modelling:

- `segment_index` + `started_at_ms` make segments orderable within a session (v1 cannot be).
- `engaged_index` identifies which entry of `targets` was engaged — fixes Trap 1.
- `input_events` `{t, dx, dy}` are raw pointer samples at native polling rate via
  `getCoalescedEvents`, carrying **sub-frame timing that render-cadence sampling
  destroys** — the strongest biometric signal. **Now captured** (`onPointerMove` in
  `game.js`, buffered per segment in `telemetry.js`); `t` keeps 0.01 ms resolution.
  Nullable by design: it is `null` on a Bot Mode segment (no pointer listener) and on any
  browser without the coalesced-events API, which keeps "not captured" distinct from
  "captured nothing". `features.py` does not derive from it yet — that is the open work.
- `frame_count` / `event_count` are lifted out of the jsonb so segments can be filtered
  without parsing either blob.

Both streams are stored **columnar** in v2 (parallel arrays keyed by field name), not as
an array of per-sample objects — roughly a third of the size (no key repeated thousands of
times) and it loads straight into numpy without a Python-level loop. `features.py`
currently expects the row-oriented v1 shape.

A check constraint (`segments_click_fields_match_outcome`) enforces that a non-click
outcome can never carry click-derived fields — the same rule §3.4 documents, in the
database. It is what stops a fabricated reaction time entering the training set.

### 5.5 `session_metrics` — the scoreboard

Derived per-session aggregates for skill/weakness profiling: written offline by the Python
pipeline with the service key, read by the player. Nothing here is original data — it is
all recomputable from `segments`, so it is safe to recompute wholesale.

| column | type | meaning |
|---|---|---|
| `session_id` | uuid pk -> `sessions` | which session these numbers describe; one row per session |
| `computed_at` | timestamptz | when they were calculated |
| `metrics_version` | int | which version of the calculation produced them — tells stale numbers from fresh |
| `accuracy` | double | hit rate |
| `mean_time_to_click_ms` | double | average reaction time |
| `mean_dwell_ms` | double | average settle-before-firing time |
| `on_target_ratio` | double | fraction of frames the crosshair was on a target — the tracking score (Trap 6: on strafing this *is* the drill) |
| `metrics` | jsonb | open blob that absorbs new measures without a migration; promote one to a column when you want to index or sort on it |

This table also exists because `segments` has **no select policy at all** — the player
cannot read their own raw trajectories. Aggregates reach them here instead.

### 5.6 `telemetry_logs_v1` — the graveyard

The v1 table, renamed. Those rows carry no identity at all, so they cannot be attached to a
subject and must not be mixed into a multi-user training set. They are kept, renamed,
stripped of all `anon` privileges, and ignored. Drop the table by hand once you no longer
want them.

### 5.7 `v_training_segments` — the training window

Not a table — a saved query. It pre-joins `segments` -> `sessions` -> `subjects` so
`fetch_telemetry.py` reads one flat thing and never has to join by hand or re-derive the
label. It exposes every segment column, the session columns that matter for normalisation
(`routine`, `difficulty`, `routine_config`, `dpi`, `sens`, `cm_per_360`, `fov_deg`,
`refresh_hz`, `poll_hz`, `device_fingerprint`, `app_version`, `sampling_version`, and
`started_at` as `session_started_at`), plus `subject_id`, `subject_kind` and `is_human`.

`is_human` comes from `subjects.kind`, which the client cannot write — unlike the v1
per-row boolean, which it could. Access is revoked from **both** `anon` and
`authenticated`; service-key reads bypass RLS, so the view stays invisible to the browser.

### 5.8 Indexes

The training pull is "every segment for these subjects, in order"; the app reads "this
subject's recent sessions". Hence `sessions (subject_id, started_at desc)`,
`sessions (routine, difficulty)`, `segments (session_id, segment_index)`,
`segments (outcome)` and `subjects (kind)`.

### 5.9 RLS posture — the three rules the design encodes

**Append-only**: there is no update or delete policy anywhere. A behavioural reference set
an account holder can rewrite is not a reference set; corrections are made with the service
key. **`segments` has no select policy at all**, so an account cannot download its own
trajectories to replay them — trajectories are the raw material of a biometric template;
aggregates reach the player through `session_metrics`, and training pulls go through the
view with the service key. And **the human/synthetic label lives on the subject, not the
row**: `subjects.kind` has no client write policy, while `sessions.bot_mode` is a debugging
hint only.

`anon` has no privileges at all — inserting requires a signed-in user whose subject the row
already belongs to:

| table | what a signed-in client may do |
|---|---|
| `subjects` | nothing — no policy of any kind |
| `profiles` | select own row; update own row, but the `with check` pins `subject_id` to `current_subject_id()`, so the subject link is not rewritable |
| `sessions` | insert and select own (`subject_id = current_subject_id()`) |
| `segments` | **insert only**, and only into a session that is already yours. No select |
| `session_metrics` | select own. Writes are service-key only |
| `telemetry_logs_v1` | nothing — `anon` revoked |
| `v_training_segments` | nothing — revoked from `anon` and `authenticated` |

---

## 6. Per-routine differences

### 6.1 Structural

| | `kind` | outcomes reachable | segment closes on | targets move | `target_count` (e/m/h) | click fields |
|---|---|---|---|---|---|---|
| **flick** | destructible | hit, miss | every click | no | 1 / 1 / 1 | present |
| **gridshot** | destructible | hit, miss | every click | no | 3 / 3 / 4 | present |
| **spidershot** | destructible | hit, miss, **timeout** | click **or** TTL expiry | no | 1 / 1 / 1 | null on timeout |
| **strafing** | tracking | **track only** | every 1000 ms + `stop()` | **yes** | 1 / 1 / 1 | **always null** |
| **switching** | destructible | hit, miss | every click | **yes** | 2 / 3 / 5 | present |

### 6.2 Behaviour that shapes the data

| | on hit | on miss | notes |
|---|---|---|---|
| flick | respawn elsewhere | **also respawns** | a miss moves the target — makes it a pure flick drill, not retry-until-you-hit |
| gridshot | replace that one | no-op | replacements avoid overlap (`minSeparation = 3r`); `boundaryScale` widens x/y spread only, never z |
| spidershot | replace | **no-op, target survives** | only the clock takes it (`ttlMs` = 1500 / 900 / 400) |
| strafing | **no-op** | no-op | abrupt cuts on a random timer (`dirChangeMin/MaxMs`), speed 4 / 7 / 10 |
| switching | replace that one | no-op | all targets keep moving, speed 2 / 4 / 6 |

### 6.3 Segment duration is a different distribution per routine

- **flick / gridshot / switching** — player-controlled, click to click.
- **spidershot** — **censored** at `ttlMs` (400 / 900 / 1500 ms by difficulty).
- **strafing** — ~1000 ms by construction, plus exactly one short partial window per
  session from the `stop()` flush.

`n_frames` is approximately `duration x refresh_hz`, so it encodes hardware as much as
behaviour.

---

## 7. Traps — read before building features

**1. `tx/ty/tz` is not the engaged target on multi-target modes.** Every routine
implements `aimTarget()` as `pool.active[0]` — the first pool slot. Unambiguous for
flick, spidershot and strafing (one target). On **gridshot and switching** the player is
very likely engaging a different target, so every crosshair-to-target error feature is
measuring a target being ignored — on exactly the two modes where target *selection* is
the skill. Identity is at least stable within a segment (releases only happen at segment
boundaries), so it is noisy rather than corrupt. `engaged_index` in v2 fixes this and
cannot be back-filled onto v1 rows.

**2. `on` means "touching any target".** Two consequences on gridshot/switching:
`on_target_ratio` counts frames on targets you are flicking past; and **`dwell_ms` is
stamped on first contact with any target and never reset**, so sweeping across a
bystander inflates it by hundreds of ms. `dwell_ms` is trustworthy on flick and
spidershot only. Note it means "time since first touching anything", not "time resting
on the thing I shot", on every mode.

**3. Three features are routine/difficulty labels in disguise.**
`target_speed_mean` is exactly **0** for flick, gridshot and spidershot (static targets
within a segment), ~4/7/10 for strafing and ~2/4/6 for switching. `target_count` is
constant per (routine, difficulty). `duration_ms`/`n_frames` are ~1000 for strafing and
censored for spidershot. Together `(target_count, target_speed_mean)` nearly uniquely
identifies (routine, difficulty) — and if subjects do not play an identical mix, the
subject too. Train per-routine, or treat these as strata rather than features.

**4. The bot's `dwell_ms` is an artifact.** At the frame the flick finishes,
`sampleFrame` runs *before* `shoot`, the bot is on target centre, so `on` is true and
`dwellStart = now`; `shoot` then computes `now - dwellStart`. Result: **static modes give
bot `dwell_ms` ~= 0** (a few ms at most, from frames where the ray clips the target edge
on approach — `smoothed` shows slightly more than `linear` because easing decelerates
into the target). **Moving modes give `null`**, because the bot aims where the target
*was* when the flick began and the ray misses on arrival. A near-constant 0 versus a
human's variable dwell is trivially separable and teaches nothing.

**5. `path_efficiency` ~= 1.0 for the bot on static modes by construction** — it travels
a geodesic in yaw/pitch space. Like Trap 4, that detects *this bot*, not bots. On
strafing the denominator is largely the *target's* path length, so the feature is close
to meaningless there.

**6. Several features invert meaning between modes.**

| feature | flick / gridshot / spidershot | strafing |
|---|---|---|
| `path_efficiency` | did you go straight to it — skill, high is good | follows a randomly-cutting target; near-meaningless |
| `on_target_ratio` | approximately `1 - flight fraction`, mostly a speed measure | **the actual score of the drill** |
| `time_to_first_on_ms` | arrival / reaction time | usually 0 — you start on target |

The feature strafing actually needs does not exist yet: **angular tracking error**, the
per-frame angle between the crosshair ray and `(tx, ty, tz)`. It is computable from what
is already recorded, for all five routines.

**7. `direction_change_rate` counts zeros as a direction.** `np.sign(0) == 0`, so a
stationary hand emitting `dx = 0, 1, 0, -1, 0` scores four reversals. Humans pause; the
linear bot never emits a zero mid-flick, but the *smoothed* bot does at both ends of its
ease. The feature is partly measuring stillness. Threshold it (`|dx| > eps`) or count
reversals in `yaw`/`pitch` instead.

**8. Human `dx/dy` can be fractional; bot `dx/dy` never are.** Human values are summed
`event.movementX`, which is CSS-pixel based and non-integer on scaled or HiDPI displays.
Bot values are integers by construction. On such a display this alone separates the
classes. Check for it before trusting any input-magnitude feature.

**9. v1 rows cannot be ordered.** No `segment_index`, no session-relative timestamp, and
`created_at` cannot substitute because inserts are fire-and-forget and land out of order.
`t` restarts at 0 every segment. No warmup effect, no fatigue curve, no sequence model on
v1 data.

**10. Clicks during tracking are invisible.** `trackingShot()` flashes the crosshair and
updates the HUD, then returns — nothing is written. Strafing rows carry no click
timestamps at all, so trigger discipline and click cadence, usually among the strongest
human/bot signals, are absent. Fixing this is a client change.

**11. Cross-user normalisation is impossible on v1.** `dx/dy` scale with DPI *and*
refresh rate (a 144 Hz player has ~2.4x smaller per-frame deltas than a 60 Hz player at
identical physical speed). `yaw/pitch`-derived features have neither problem —
`angular_speed` in rad/s is hardware-independent. v1 rows carry no DPI and no refresh
column, which is what `sessions.dpi / refresh_hz / poll_hz / cm_per_360` exists to fix.

**12. Bot Mode aims at where a target was when the flick began**, so against the moving
routines it misses often. Synthetic rows are only trustworthy for the static routines
until the bot learns to lead a target.

---

## 8. The feature layer

[`model/src/features.py`](model/src/features.py) flattens one segment into one row:
`build_features(df) -> DataFrame`, **26 columns**.

**Passed through unchanged (11):** `session_id`, `is_human`, `bot_mode`, `routine`,
`difficulty`, `outcome`, `target_count`, `time_to_click_ms`, `dwell_ms`,
`click_offset_x`, `click_offset_y`.

**Derived from the row (2):** `is_click_outcome` (`outcome in {hit, miss}`),
`click_offset_magnitude` (`hypot(x, y)`, masked to click outcomes — NaN on miss anyway,
since offsets are hit-only).

**Derived from `trajectory` (13):** `n_frames`, `duration_ms`, `input_speed_mean`,
`input_speed_std`, `input_speed_max` (from `dx/dy`), `angular_speed_mean`,
`angular_speed_std`, `angular_speed_max` (rad/s from `yaw/pitch`),
`direction_change_rate`, `path_efficiency`, `on_target_ratio`, `time_to_first_on_ms`,
`target_speed_mean`.

**Collected but not consumed at all:** `target_distance` and `targets`. Both are on every
row and neither reaches the feature table — `target_distance` is a free difficulty/effort
covariate, and `targets` is the only record of the targets the player *chose not* to
shoot.

Design rules it follows, worth preserving:

- **Click-only fields stay NaN on non-click rows**, never imputed — a fabricated reaction
  time would teach the classifier a lie. The v2 schema enforces the same as a constraint.
- `_coerce_frames` accepts a list, a JSON string, or a Python `repr` string, because
  `to_csv()` stringifies nested structures with single quotes that `json.loads` rejects.
- `duration_ms` is `t[-1]` — the last frame *before* the click, so it is up to one frame
  short of `time_to_click_ms`.

---

## 9. Recommendations

1. **Train per-routine, or at minimum per `kind`.** Destructible and tracking are not one
   population.
2. **Drop `target_speed_mean`, `target_count` and raw `duration_ms`**, or use them as
   strata. They label the drill, not the player.
3. **Add angular tracking error** (crosshair ray vs `tx/ty/tz`). It is the missing feature
   and is derivable from existing rows for all five routines.
4. **Fix `engaged_index` and engaged-vs-any `on` before trusting gridshot/switching**, or
   exclude those two from target-relative features.
5. **Use `target_distance` and `targets`** — currently collected and thrown away.
6. **Treat the current bot as a negative control, not a bot model.** A classifier
   separating it at 99% has learned `path_efficiency == 1.0` and `dwell_ms == 0`.
7. **Derive features from `input_events`** — the sub-frame pointer stream is now captured
   (`getCoalescedEvents`), but `features.py` still reads only `trajectory`. Inter-arrival
   timing, per-sample speed distribution, and poll-rate regularity are the strongest
   human/bot discriminators and remain unextracted.

---

## 10. Running the pipeline

```powershell
cd model
.venv\Scripts\Activate.ps1
python -m src.fetch_telemetry --routine flick --out data/flick.parquet
python -m src.features --in data/flick.parquet --out data/flick_features.parquet
```

Both are run as modules from `model/` (relative imports; `python src/features.py` fails).
`fetch_telemetry.py` pages in 1000-row batches because PostgREST caps a single response
there.

Credentials: the browser uses `.env.local` with a publishable/anon key; the pipeline uses
`model/.env` with the **service_role** key, which it needs because no select policy
exists. Never cross them — `VITE_` values are inlined into the browser bundle.

`build_features()` takes a DataFrame, so it needs no database to exercise: a handful of
hand-built segment dicts, one per outcome, is enough to check that click-only columns
stay NaN off click rows and that a single-frame segment does not divide by zero.
