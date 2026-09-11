import { Euler, Raycaster, Vector2, Vector3 } from 'three';
import { createRoutine } from './routines/index.js';
import { configFor } from './difficulty.js';
import { createTelemetry, buildSegmentPayload, buildSessionPayload } from './telemetry.js';
import { insertSession, insertSegment } from './supabase.js';
import {
  FEEDBACK_FLASH_MS,
  TRACK_WINDOW_MS,
  DEFAULT_ROUTINE,
  DEFAULT_DIFFICULTY
} from './constants.js';

const SCREEN_CENTER = new Vector2(0, 0);
const WORLD_UP = new Vector3(0, 1, 0);

// Scratch objects, reused so a click allocates nothing.
const _forward = new Vector3();
const _right = new Vector3();
const _up = new Vector3();
const _point = new Vector3();
const _intersections = [];
// YXZ so .y is yaw and .x is pitch, matching how the camera is rotated.
const _euler = new Euler(0, 0, 0, 'YXZ');

function round3(value) {
  return Math.round(value * 1e3) / 1e3;
}

// Hosts whichever routine is active: it owns the session, the raycast, the HUD
// counters and telemetry, and asks the routine what to do with a hit or a miss.
export function createGame({ scene, camera, crosshair, hud }) {
  const raycaster = new Raycaster();
  const telemetry = createTelemetry();

  let routine = null;
  let running = false;
  // The DB session id arrives asynchronously; every segment awaits this promise
  // so it can be assembled synchronously in the game loop while the id is still
  // in flight. Resolves to null when persistence is unavailable.
  let sessionIdPromise = Promise.resolve(null);
  let sessionStartMs = 0;
  let segmentIndex = 0;
  let routineId = DEFAULT_ROUTINE;
  let difficulty = DEFAULT_DIFFICULTY;
  let kind = 'destructible';
  let attemptStart = 0;
  let dwellStart = 0;
  // Index of the engaged target within the segment's `targets` snapshot,
  // captured at segment start and shipped with the row. Not hardcoded: the
  // moment a routine's aimTarget() stops being targets[0] a hardcoded 0 would
  // silently mislabel every row with no error.
  let engagedIndexAtStart = null;
  // Raw mouse counts accumulated between rendered frames, flushed into one
  // sample per frame so the trajectory has a steady cadence.
  let pendingDx = 0;
  let pendingDy = 0;
  let flashTimer = 0;
  let hits = 0;
  let attempts = 0;
  let clicks = 0;
  let totalTimeMs = 0;

  function pushHud() {
    hud.update({ hits, attempts, clicks, totalTimeMs });
  }

  // The camera's absolute yaw/pitch, read off the camera quaternion — so
  // telemetry is DPI-independent, comparable across sensitivities and users.
  function cameraAngles() {
    _euler.setFromQuaternion(camera.quaternion, 'YXZ');
    return { yaw: _euler.y, pitch: _euler.x };
  }

  // Cast the crosshair ray at the current aim and return the nearest live
  // target hit, or null. Three only recomposes the camera's world matrix during
  // render(), so recompose it here or the ray reflects last frame's aim.
  function raycastCenter() {
    camera.updateMatrixWorld();
    raycaster.setFromCamera(SCREEN_CENTER, camera);
    _intersections.length = 0;
    raycaster.intersectObjects(routine.targets, false, _intersections);
    return _intersections.length > 0 ? _intersections[0] : null;
  }

  // The engaged target is the one whose position each frame records — for a
  // single-target routine it is simply the target.
  function engagedTarget() {
    return routine.aimTarget();
  }

  function engagedDistance() {
    const engaged = engagedTarget();
    return engaged === null ? null : camera.position.distanceTo(engaged.position);
  }

  // The layout of every live target at the start of a segment: positions and
  // radii, so target selection and the ignored targets can be studied later.
  function snapshotBoard() {
    return routine.targets.map((target) => ({
      x: round3(target.position.x),
      y: round3(target.position.y),
      z: round3(target.position.z),
      r: target.userData.radius
    }));
  }

  // One telemetry sample per rendered frame: the player's aim and the world
  // state together, so tracking error is recoverable for every routine.
  function sampleFrame(now, dx, dy) {
    const { yaw, pitch } = cameraAngles();
    const engaged = engagedTarget();
    const on = raycastCenter() !== null;

    // dwell_ms is the span from the crosshair first settling on a target until
    // the click, so it is stamped the first frame contact is made.
    if (on && dwellStart === 0) dwellStart = now;

    telemetry.sample(now, {
      dx,
      dy,
      yaw,
      pitch,
      tx: engaged === null ? null : engaged.position.x,
      ty: engaged === null ? null : engaged.position.y,
      tz: engaged === null ? null : engaged.position.z,
      on
    });

    // Multi-target moving routines also record every live target's position, in
    // lockstep with the frame above so the two streams share a frame count.
    if (routine.tracksBoardTrajectory === true) {
      telemetry.sampleBoard(routine.targets.map((target) => target.position));
    }
  }

  // A segment is one row. It opens on spawn/re-arm, on a click, or on a window
  // boundary, and always begins with a fresh board snapshot and buffer.
  function beginAttempt(now) {
    attemptStart = now;
    dwellStart = 0;

    // Capture which target in the snapshot is the engaged one, before any of
    // this segment's frames are sampled. targets is the routine's live active
    // array, which snapshotBoard() records in order, so the index lines up.
    const engaged = engagedTarget();
    const index = engaged === null ? -1 : routine.targets.indexOf(engaged);
    engagedIndexAtStart = index === -1 ? null : index;

    telemetry.beginSegment(now, snapshotBoard());
  }

  // Ships the segment that just closed. The frames/board references are read
  // before beginAttempt() swaps in fresh ones, so an in-flight insert keeps its
  // own array. An empty segment (no frame sampled yet) is never shipped.
  function flushSegment(outcome, fields = {}) {
    const frames = telemetry.frames();
    if (frames.length === 0) return;

    const board = telemetry.board();
    const inputs = telemetry.inputs();
    const boardFrames = telemetry.boardFrames();
    const {
      targetDistance = null,
      timeToClickMs = null,
      dwellMs = null,
      clickOffset = null
    } = fields;

    insertSegment(
      sessionIdPromise,
      buildSegmentPayload({
        segmentIndex: segmentIndex++,
        startedAtMs: Math.round(attemptStart - sessionStartMs),
        outcome,
        targetDistance,
        timeToClickMs,
        dwellMs,
        clickOffset,
        targetCount: board.length,
        targets: board,
        engagedIndex: engagedIndexAtStart,
        frames,
        inputs,
        boardFrames
      })
    );
  }

  function flash(result) {
    crosshair.classList.remove('hit', 'miss');
    crosshair.classList.add(result);
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => crosshair.classList.remove(result), FEEDBACK_FLASH_MS);
  }

  // Click offset from target center, measured on the plane perpendicular to the
  // camera-to-target vector, in world units. Targets are never rotated or
  // scaled, so their local axes stay world-aligned.
  function computeClickOffset(target, worldPoint) {
    _forward.subVectors(target.position, camera.position).normalize();
    _right.crossVectors(_forward, WORLD_UP).normalize();
    _up.crossVectors(_right, _forward).normalize();

    _point.copy(worldPoint);
    target.worldToLocal(_point);

    return { x: _point.dot(_right), y: _point.dot(_up) };
  }

  // A miss reports the closest target that was on screen rather than nothing.
  function nearestTargetDistance() {
    let nearest = null;

    for (const target of routine.targets) {
      const distance = camera.position.distanceTo(target.position);
      if (nearest === null || distance < nearest) nearest = distance;
    }

    return nearest;
  }

  // A click in a destructible routine: closes the current segment as hit or
  // miss and re-arms the next.
  function shoot(now) {
    const timeToClickMs = Math.round(now - attemptStart);
    // Null when the crosshair never touched a target this attempt (a pure
    // miss, or a click before settling on one).
    const dwellMs = dwellStart === 0 ? null : Math.round(now - dwellStart);

    const struck = raycastCenter();
    const isHit = struck !== null;
    const targetDistance = isHit
      ? camera.position.distanceTo(struck.object.position)
      : nearestTargetDistance();
    const clickOffset = isHit ? computeClickOffset(struck.object, struck.point) : null;

    // Resolve and re-arm first — everything below is off the latency path.
    flash(isHit ? 'hit' : 'miss');
    if (isHit) routine.resolveHit(struck.object, now);
    else routine.resolveMiss(now);

    flushSegment(isHit ? 'hit' : 'miss', { targetDistance, timeToClickMs, dwellMs, clickOffset });
    beginAttempt(now);

    attempts += 1;
    clicks += 1;
    if (isHit) hits += 1;
    totalTimeMs += timeToClickMs;
    pushHud();
  }

  // A click in a tracking routine gives feedback and an on-target score, but
  // does not end a segment (segments are time-windowed) or write a row.
  function trackingShot(now) {
    const isHit = raycastCenter() !== null;
    flash(isHit ? 'hit' : 'miss');

    attempts += 1;
    if (isHit) hits += 1;
    pushHud();
  }

  // Pointer events (not mouse events) expose getCoalescedEvents(): the raw
  // sub-frame samples the browser merged into this one, at the native poll rate.
  // Each is accumulated into the per-frame trajectory AND recorded individually
  // into the segment's input stream, whose finer timing the frame sampler loses.
  // The coalesced deltas sum to the merged event's, so trajectory dx/dy are
  // unchanged; the fallback covers browsers without the API.
  function onPointerMove(event) {
    const coalesced =
      typeof event.getCoalescedEvents === 'function' ? event.getCoalescedEvents() : null;

    if (coalesced !== null && coalesced.length > 0) {
      for (const sample of coalesced) {
        pendingDx += sample.movementX;
        pendingDy += sample.movementY;
        telemetry.recordInput(sample.timeStamp, sample.movementX, sample.movementY);
      }
      return;
    }

    pendingDx += event.movementX;
    pendingDy += event.movementY;
    telemetry.recordInput(event.timeStamp, event.movementX, event.movementY);
  }

  function onMouseDown(event) {
    if (running === false || event.button !== 0) return;

    const now = performance.now();
    if (kind === 'tracking') trackingShot(now);
    else shoot(now);
  }

  document.addEventListener('mousedown', onMouseDown);

  return {
    update(now) {
      if (running === false) return;

      const events = routine.update(now);
      if (events.expired > 0) {
        // The clock took the target. It counts against accuracy, and its search
        // trajectory is a labeled failure worth keeping — so the segment is
        // shipped as a timeout before re-arming, without counting a click.
        attempts += events.expired;
        flushSegment('timeout');
        beginAttempt(now);
        pushHud();
      }

      const dx = pendingDx;
      const dy = pendingDy;
      pendingDx = 0;
      pendingDy = 0;
      sampleFrame(now, dx, dy);

      // Tracking has no click to end a segment, so cut it into fixed windows:
      // one row per window keeps the buffer bounded and the rows uniform.
      if (kind === 'tracking' && now - attemptStart >= TRACK_WINDOW_MS) {
        flushSegment('track', { targetDistance: engagedDistance() });
        beginAttempt(now);
      }
    },

    // A fresh routine is built per session, so a mode or difficulty change on
    // the home screen always takes effect on the next start.
    start(options = {}) {
      routineId = options.routineId ?? DEFAULT_ROUTINE;
      difficulty = options.difficulty ?? DEFAULT_DIFFICULTY;
      const config = options.config ?? configFor(routineId, difficulty);

      if (routine !== null) routine.stop();
      routine = createRoutine(routineId, { scene, camera, config });
      kind = routine.kind ?? 'destructible';

      const now = performance.now();
      sessionStartMs = now;
      segmentIndex = 0;

      // Open the session row. Its id is awaited by every segment insert, so the
      // network round-trip never blocks the game loop. options.session carries
      // the hardware block (dpi/sens/cm360, fov, refresh, device) from main.js.
      sessionIdPromise = insertSession(
        buildSessionPayload({
          routine: routineId,
          difficulty,
          routineConfig: config,
          ...(options.session ?? {})
        })
      );

      hits = 0;
      attempts = 0;
      clicks = 0;
      totalTimeMs = 0;
      pendingDx = 0;
      pendingDy = 0;
      pushHud();

      running = true;
      document.addEventListener('pointermove', onPointerMove);

      routine.start(now);
      beginAttempt(now);
    },

    stop() {
      running = false;
      document.removeEventListener('pointermove', onPointerMove);

      if (routine !== null) {
        // A tracking session may hold an unflushed partial window — keep it, or
        // a no-click drill would write nothing at all. Flush before disposing,
        // while the target still exists.
        if (kind === 'tracking') flushSegment('track', { targetDistance: engagedDistance() });
        routine.stop();
      }
    }
  };
}
