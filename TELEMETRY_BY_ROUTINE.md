# Telemetry by Routine

How each telemetry field is used across the five game modes, and what event
creates a new `segments` row in each. Grounded in `src/game.js`,
`src/telemetry.js`, and the routine files under `src/routines/`.

## The shared shape (same for all 5 modes)

Every mode writes the **same row shape** — one `segments` row per closed
segment. What changes between modes is (a) **which fields are
meaningful/populated** and (b) **what event closes a segment**. The fields
themselves do not change per mode; only their relevance does.

Per-segment fields (`buildSegmentPayload`, `src/telemetry.js`):

| Field | What it is | Null when… |
|---|---|---|
| `outcome` | `hit` / `miss` / `timeout` / `track` | never |
| `trajectory` | per-frame columnar stream: `{t, dx, dy, yaw, pitch, tx, ty, tz, on}` | never (empty segments aren't shipped) |
| `input_events` | raw sub-frame pointer samples `{t, dx, dy}` | Bot Mode, or no pointer support |
| `targets` + `target_count` | board layout at segment start | never |
| `engaged_index` | which board target `aimTarget()` points at (0 or null) | empty board |
| `target_distance` | camera→target distance | context-dependent (per mode below) |
| `time_to_click_ms` | `now − attemptStart` | non-click rows (`timeout`, `track`) |
| `dwell_ms` | crosshair-settle → click | non-click rows, or crosshair never landed |
| `click_offset_x/y` | hit point vs. target center | miss / timeout / track |

Per-frame `trajectory` fields:

- **`dx/dy`** — raw device counts. DPI-dependent, only comparable once
  `sessions.dpi` is known.
- **`yaw/pitch`** — absolute camera angles off `camera.quaternion`.
  DPI-independent, cross-user comparable.
- **`tx/ty/tz`** — the *engaged* target's world position that frame
  (`game.js`, `sampleFrame`).
- **`on`** — was the crosshair on any live target this frame
  (`raycastCenter()`).

---

## The 5 modes

### 1. Precision Flick (`flick`, destructible)

**One target.** Hit or miss, it respawns wherever (`flick.js`,
`resolveHit`/`resolveMiss`).

- **Row created:** on every **click** — `hit` or `miss` (`game.js`, `shoot`).
  No timer, no timeout. One click = one row.
- **Telemetry emphasis:** the full click set is populated —
  `time_to_click_ms`, `dwell_ms`, `click_offset`. `trajectory` is the flick arc
  from spawn to click. `target_count` is always 1, `engaged_index` always 0.
  `tx/ty/tz` are constant within a segment (target is static). Cleanest mode for
  reaction time + landing accuracy.

### 2. Static Flicking / gridshot (`gridshot`, destructible)

**3–4 static targets held on screen.** Clicking one replaces it elsewhere;
missing disturbs nothing (`gridshot.js`, `resolveHit`/`resolveMiss`).

- **Row created:** on every **click**, `hit` or `miss`. Same trigger as flick.
- **Telemetry emphasis:** same click fields as flick, **but** `target_count` is
  3–4 and `targets[]` records the whole board — so target *selection* (which of
  several you flicked to, and which you ignored) is recoverable. `engaged_index`
  is still 0 because `aimTarget()` is `active[0]`. `tx/ty/tz` track only the
  engaged target, static within the segment.

### 3. Dynamic Reflex / spidershot (`spidershot`, destructible)

**One target on a countdown** (`config.ttlMs`). Hit it or it vanishes
(`spidershot.js`, `update`).

- **Row created:** two ways —
  - on a **click** → `hit`/`miss` (like flick), or
  - on **timeout** when the TTL expires before you click (`game.js`, `update`
    handling `events.expired`). `update()` returns `{expired: 1}`, and the
    failed search trajectory is shipped as a `timeout` row *before* re-arming.
- **Telemetry emphasis:** the mode where `timeout` rows matter. A `timeout` row
  has a full `trajectory` (the failed search) but
  `time_to_click_ms`/`dwell_ms`/`click_offset` are **null** — no shot landed. It
  counts against accuracy but **not** against the `clicks` HUD counter. Static
  target within a segment (spawns, sits, expires), so `tx/ty/tz` are constant.

### 4. Reactive Strafing (`strafing`, **tracking**)

**One moving target you stay on**; hits don't consume it (`strafing.js`,
`resolveHit(){}`).

- **Row created:** on a **time window**, not a click. Every `TRACK_WINDOW_MS`
  the segment closes as `track` and re-opens (`game.js`, `update`); plus one
  final `track` flush on `stop()` for the partial window. Clicks give
  feedback/score but write **no row** (`game.js`, `trackingShot`).
- **Telemetry emphasis:** the `trajectory` is the whole point — `yaw/pitch` vs.
  moving `tx/ty/tz` per frame gives **tracking error over time**. `on` tells you
  what fraction of the window you held the target.
  `time_to_click_ms`/`dwell_ms`/`click_offset` are always **null** (no click
  closes a segment). `target_distance` is stamped from `engagedDistance()` at
  flush. `tx/ty/tz` genuinely move frame-to-frame here — the reason
  `sampleFrame()` runs *after* `routine.update()`.

### 5. Target Switching (`switching`, destructible)

**Several moving targets at once**; destroy one, acquire the next
(`switching.js`, `resolveHit`).

- **Row created:** on every **click**, `hit` or `miss`. Destructible, so it's
  click-driven like flick/gridshot — no timeout.
- **Telemetry emphasis:** combines gridshot's multi-target board
  (`target_count` > 1, full `targets[]`, so switching *decisions* are visible)
  with strafing's motion (`tx/ty/tz` move within the segment — the engaged
  target is `active[0]` and it's traveling). Full click set populated. The only
  destructible mode where both the board is multi-target **and** the engaged
  target is moving during the flick.

---

## The pattern in one line

- **Click closes a row** → flick, gridshot, spidershot, switching (all
  `destructible`). Full click fields (`time_to_click_ms`, `dwell_ms`,
  `click_offset`) populated.
- **Timer closes a row** → spidershot's `timeout` (target expired) and
  strafing's `track` window. Click fields **null**.
- **Static `tx/ty/tz` within a segment** → flick, gridshot, spidershot.
  **Moving** `tx/ty/tz` → strafing, switching.
- **Multi-target board** → gridshot, switching. Single target → flick,
  spidershot, strafing.

## Bot Mode (all five)

The bot pulls the trigger instead of a human, `input_events` is always `null`
(no pointer listener attached), and `dwell_ms` is usually null on bot hits since
the synthetic flick often lands without a settle frame.
