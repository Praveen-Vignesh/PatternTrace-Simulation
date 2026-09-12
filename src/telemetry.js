// Per-segment sample buffer and Supabase row assembly. Nothing here talks to
// the network.
//
// A row is one *segment* of play, not one mesh. Destructible routines close a
// segment on a click (hit/miss) or a timeout; tracking routines close one every
// fixed window (see TRACK_WINDOW_MS). Every segment carries a per-frame stream
// of the player's aim *and* the world state, so tracking error is recoverable
// for every mode from one uniform shape.
//
// Session-scoped metadata (hardware, sensitivity, routine) lives on the
// `sessions` row, built once per timed run; per-frame play lives on the
// `segments` rows, one per closed segment. See schema.sql for why the split.
//
// Every timestamp reaching this module is on the PLAY clock — paused time is
// already subtracted by game.js — so nothing here needs to know about pausing.

// Camera pitch/yaw are stored to this many decimal places of a radian
// (~0.0006°); target positions to this many of a world unit (~1 mm). Enough to
// reconstruct the aim and the target path without bloating the row.
const ANGLE_PRECISION = 1e5;
const POSITION_PRECISION = 1e3;
// input_events carry sub-frame timing — the whole reason to record them apart
// from the per-frame trajectory — so their timestamps keep 0.01 ms resolution
// rather than the whole-millisecond rounding trajectory `t` uses. At a 1000 Hz
// poll rate samples land ~1 ms apart, which whole-ms rounding would collapse.
const INPUT_TIME_PRECISION = 1e2;

function roundTo(value, precision) {
  return value === null ? null : Math.round(value * precision) / precision;
}

function roundAngle(radians) {
  return roundTo(radians, ANGLE_PRECISION);
}

function roundPos(units) {
  return roundTo(units, POSITION_PRECISION);
}

export function createTelemetry() {
  let frames = [];
  let inputs = [];
  let boardFrames = [];
  let board = [];
  let segmentStart = 0;

  return {
    // Opens a fresh segment. New arrays are allocated rather than emptied in
    // place, because the previous segment's arrays may still be on their way to
    // Supabase. `boardSnapshot` is the layout of every live target at the start
    // of the segment: [{x, y, z, r}].
    beginSegment(timestamp, boardSnapshot) {
      segmentStart = timestamp;
      frames = [];
      inputs = [];
      boardFrames = [];
      board = boardSnapshot;
    },

    // One sample per rendered frame. `dx`/`dy` are the raw device counts since
    // the last frame (DPI-dependent); `yaw`/`pitch` are the camera's absolute
    // angles (DPI-independent); `tx`/`ty`/`tz` are the engaged target's world
    // position (null if none); `on` is whether the crosshair sat on any target.
    sample(now, { dx, dy, yaw, pitch, tx, ty, tz, on }) {
      frames.push({
        t: Math.round(now - segmentStart),
        dx,
        dy,
        yaw: roundAngle(yaw),
        pitch: roundAngle(pitch),
        tx: roundPos(tx),
        ty: roundPos(ty),
        tz: roundPos(tz),
        on: on ? 1 : 0
      });
    },

    // The world position of every live target this frame, in routine.targets
    // order, so a multi-target moving routine's non-engaged paths are not lost
    // (trajectory only carries the engaged target). Called every frame in
    // lockstep with sample() when the routine opts in, so its frame count
    // matches. Within one segment the target set and order are stable — targets
    // are only released at segment close — so index i is the same physical
    // target every frame and aligns with the `targets` snapshot.
    sampleBoard(positions) {
      const row = new Array(positions.length);
      for (let i = 0; i < positions.length; i++) {
        row[i] = {
          x: roundPos(positions[i].x),
          y: roundPos(positions[i].y),
          z: roundPos(positions[i].z)
        };
      }
      boardFrames.push(row);
    },

    // One entry per raw pointer sample (getCoalescedEvents), at the native
    // polling rate — sub-frame timing that the per-frame trajectory destroys.
    // `eventTime` is the sample's own DOMHighResTimeStamp, off the same clock as
    // segmentStart, so inter-arrival gaps survive.
    recordInput(eventTime, dx, dy) {
      inputs.push({
        t: Math.round((eventTime - segmentStart) * INPUT_TIME_PRECISION) / INPUT_TIME_PRECISION,
        dx,
        dy
      });
    },

    frames() {
      return frames;
    },

    inputs() {
      return inputs;
    },

    boardFrames() {
      return boardFrames;
    },

    board() {
      return board;
    }
  };
}

// Turns the per-frame buffer into the COLUMNAR shape schema.sql stores: parallel
// arrays keyed by field name rather than an array of per-sample objects. Roughly
// a third of the size (no repeated keys) and it loads straight into numpy.
function toColumnar(frames) {
  const n = frames.length;
  const columns = {
    t: new Array(n),
    dx: new Array(n),
    dy: new Array(n),
    yaw: new Array(n),
    pitch: new Array(n),
    tx: new Array(n),
    ty: new Array(n),
    tz: new Array(n),
    on: new Array(n)
  };

  for (let i = 0; i < n; i++) {
    const frame = frames[i];
    columns.t[i] = frame.t;
    columns.dx[i] = frame.dx;
    columns.dy[i] = frame.dy;
    columns.yaw[i] = frame.yaw;
    columns.pitch[i] = frame.pitch;
    columns.tx[i] = frame.tx;
    columns.ty[i] = frame.ty;
    columns.tz[i] = frame.tz;
    columns.on[i] = frame.on;
  }

  return columns;
}

// The board trajectory columnar: outer index is the target (aligned to the
// segment's `targets` snapshot), inner index is the frame. {x, y, z} arrays of
// per-target arrays. A cell can be null if a frame ever carried fewer targets;
// within a segment that does not happen, but the guard keeps the shape total.
function toBoardColumnar(boardFrames) {
  const frameCount = boardFrames.length;
  if (frameCount === 0) return null;

  const targetCount = boardFrames[0].length;
  const x = [];
  const y = [];
  const z = [];

  for (let target = 0; target < targetCount; target++) {
    const xi = new Array(frameCount);
    const yi = new Array(frameCount);
    const zi = new Array(frameCount);

    for (let frame = 0; frame < frameCount; frame++) {
      const cell = boardFrames[frame][target];
      xi[frame] = cell ? cell.x : null;
      yi[frame] = cell ? cell.y : null;
      zi[frame] = cell ? cell.z : null;
    }

    x.push(xi);
    y.push(yi);
    z.push(zi);
  }

  return { x, y, z };
}

// Same columnar shape for the raw input stream: {t, dx, dy} parallel arrays.
function inputsToColumnar(inputs) {
  const n = inputs.length;
  const columns = { t: new Array(n), dx: new Array(n), dy: new Array(n) };

  for (let i = 0; i < n; i++) {
    const input = inputs[i];
    columns.t[i] = input.t;
    columns.dx[i] = input.dx;
    columns.dy[i] = input.dy;
  }

  return columns;
}

// Assembles the `sessions` row: everything scoped to one timed run.
// app_version and sampling_version are sent explicitly (not left to the table
// defaults) so a row records the exact code that produced it — the whole point
// of the columns. poll_hz stays null: it is derived offline from input_events.
// subject_id is stamped in supabase.js from the resolved profile.
export function buildSessionPayload({
  routine,
  difficulty,
  routineConfig = null,
  plannedDurationMs = null,
  dpi,
  sens,
  cmPer360 = null,
  fovDeg = null,
  refreshHz = null,
  pollHz = null,
  deviceFingerprint = null,
  userAgent = null,
  platform = null,
  screenWidth = null,
  screenHeight = null,
  devicePixelRatio = null,
  appVersion = 'dev',
  samplingVersion = null
}) {
  const payload = {
    routine,
    difficulty,
    routine_config: routineConfig,
    // Intent recorded at start. Sent unconditionally — the column is nullable,
    // so unlike sampling_version there is no table default to protect.
    planned_duration_ms: plannedDurationMs,
    dpi,
    sens,
    cm_per_360: cmPer360,
    fov_deg: fovDeg,
    refresh_hz: refreshHz,
    poll_hz: pollHz,
    device_fingerprint: deviceFingerprint,
    user_agent: userAgent,
    platform,
    screen_width: screenWidth,
    screen_height: screenHeight,
    device_pixel_ratio: devicePixelRatio,
    app_version: appVersion
  };

  // sampling_version is NOT NULL with a table default; omit the key when unset
  // so the default applies rather than sending a null that violates it.
  if (samplingVersion !== null && samplingVersion !== undefined) {
    payload.sampling_version = samplingVersion;
  }

  return payload;
}

// Assembles one `segments` row. Fields that do not apply to a segment's outcome
// are passed as null: a `track` window has no click, so time_to_click_ms /
// dwell_ms / click offsets are null; a `timeout` has no landed shot either. The
// schema's check constraint rejects any non-click row that carries them.
// session_id is stamped in supabase.js once the session insert resolves.
export function buildSegmentPayload({
  segmentIndex,
  startedAtMs = null,
  outcome,
  targetDistance = null,
  timeToClickMs = null,
  dwellMs = null,
  clickOffset = null,
  targetCount,
  targets,
  engagedIndex = null,
  frames,
  inputs = [],
  boardFrames = []
}) {
  // Nullable by design: a session may run without raw capture. Store null rather
  // than an empty stream so "not captured" is distinct from "captured nothing".
  const hasInputs = inputs.length > 0;
  // Only recorded for multi-target moving routines; otherwise the per-frame
  // board array is empty and the column stays null.
  const hasBoard = boardFrames.length > 0;

  return {
    segment_index: segmentIndex,
    started_at_ms: startedAtMs,
    outcome,
    target_distance: targetDistance,
    time_to_click_ms: timeToClickMs,
    dwell_ms: dwellMs,
    click_offset_x: clickOffset === null ? null : clickOffset.x,
    click_offset_y: clickOffset === null ? null : clickOffset.y,
    target_count: targetCount,
    targets,
    engaged_index: engagedIndex,
    trajectory: toColumnar(frames),
    input_events: hasInputs ? inputsToColumnar(inputs) : null,
    board_trajectory: hasBoard ? toBoardColumnar(boardFrames) : null,
    frame_count: frames.length,
    event_count: hasInputs ? inputs.length : null,
    // Segment wall-time: the last frame's t is milliseconds from segment start,
    // which is the duration up to the closing frame. 0 for a one-frame segment.
    duration_ms: frames.length > 0 ? frames[frames.length - 1].t : 0
  };
}
