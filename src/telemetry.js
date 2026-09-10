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
// `sessions` row, built once per pointer lock; per-frame play lives on the
// `segments` rows, one per closed segment. See schema.sql for why the split.

// Camera pitch/yaw are stored to this many decimal places of a radian
// (~0.0006°); target positions to this many of a world unit (~1 mm). Enough to
// reconstruct the aim and the target path without bloating the row.
const ANGLE_PRECISION = 1e5;
const POSITION_PRECISION = 1e3;

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
  let board = [];
  let segmentStart = 0;

  return {
    // Opens a fresh segment. A new array is allocated rather than emptied in
    // place, because the previous segment's array may still be on its way to
    // Supabase. `boardSnapshot` is the layout of every live target at the start
    // of the segment: [{x, y, z, r}].
    beginSegment(timestamp, boardSnapshot) {
      segmentStart = timestamp;
      frames = [];
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

    frames() {
      return frames;
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

// Assembles the `sessions` row: everything scoped to one pointer lock. app_version
// and sampling_version are left to the table defaults, so they are not sent here.
// subject_id is stamped in supabase.js from the resolved profile.
export function buildSessionPayload({
  routine,
  difficulty,
  routineConfig = null,
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
  botMode = null
}) {
  return {
    routine,
    difficulty,
    routine_config: routineConfig,
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
    bot_mode: botMode
  };
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
  frames
}) {
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
    // Raw sub-frame pointer capture (getCoalescedEvents) is not wired yet.
    input_events: null,
    frame_count: frames.length,
    event_count: null
  };
}
