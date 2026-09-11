import './style.css';
import { createScene } from './scene.js';
import { createControls, applySensitivity, requestLock } from './controls.js';
import { createGame } from './game.js';
import { createHud } from './hud.js';
import { createSettings } from './settings.js';
import { createSensitivity } from './sensitivity.js';
import { configFor } from './difficulty.js';
import { routineById } from './routines/index.js';
import { createHome } from './ui/home.js';
import {
  getAuthState,
  onAuthChange,
  signIn,
  signUp,
  signOut,
  recordConsent,
  initTelemetryOutbox,
  flushTelemetry,
  flushTelemetryKeepalive
} from './supabase.js';
import {
  MOUSE_COUNT_SCALE,
  CAMERA_FOV,
  APP_VERSION,
  SAMPLING_VERSION,
  FREE_SESSION_LIMIT
} from './constants.js';

const crosshair = document.getElementById('crosshair');

const { scene, camera, renderer, resize } = createScene(document.getElementById('scene'));
const settings = createSettings();

let sensitivity = createSensitivity({ ...settings.get(), countScale: MOUSE_COUNT_SCALE });

const controls = createControls(camera, document.body, sensitivity);
const hud = createHud();

const game = createGame({ scene, camera, crosshair, hud });

// ---------------------------------------------------------------------------
// Accounts and free sessions
// ---------------------------------------------------------------------------
// Data collection requires a real account. A visitor may play FREE_SESSION_LIMIT
// sessions first; those never authenticate, so insertSession() drops and no rows
// are written. The count is per-browser in localStorage — a soft funnel, not a
// security boundary (the data guarantee comes from "no auth = no writes").

const FREE_SESSIONS_KEY = 'aim-trainer.free-sessions-used';

function freeSessionsUsed() {
  try {
    return Number(window.localStorage.getItem(FREE_SESSIONS_KEY)) || 0;
  } catch {
    return 0;
  }
}

function consumeFreeSession() {
  try {
    window.localStorage.setItem(FREE_SESSIONS_KEY, String(freeSessionsUsed() + 1));
  } catch {
    // A browser that refuses storage simply gets unlimited free sessions; still
    // no data is written, so the collection guarantee holds regardless.
  }
}

function freeSessionsRemaining() {
  return Math.max(0, FREE_SESSION_LIMIT - freeSessionsUsed());
}

let authState = getAuthState();

function canPlay() {
  return authState.status === 'signed_in' || freeSessionsRemaining() > 0;
}

function gatedLock() {
  if (canPlay() === false) {
    home.renderAccount({ authState, freeSessionsRemaining: freeSessionsRemaining() });
    return;
  }
  requestLock(controls);
}

const home = createHome({
  settings,
  auth: {
    // Consent is stamped after a session exists. signIn re-affirms it; signUp
    // stamps immediately when a session is issued, or on the later signIn if the
    // project requires email confirmation.
    async onSignIn({ email, password }) {
      const result = await signIn({ email, password });
      if (result.error === undefined) recordConsent();
      return result;
    },
    async onSignUp({ email, password }) {
      const result = await signUp({ email, password });
      if (result.error === undefined && result.needsConfirmation !== true) recordConsent();
      return result;
    },
    onSignOut() {
      return signOut();
    }
  },
  onStart: gatedLock,
  onResume: gatedLock,
  onMenu: () => home.setScreen('home')
});

onAuthChange((state) => {
  authState = state;
  home.renderAccount({ authState, freeSessionsRemaining: freeSessionsRemaining() });
});

// One sensitivity value, two consumers historically; now just the player. Kept
// as a live update so a settings change applies without a reload.
settings.subscribe((state) => {
  sensitivity = createSensitivity({ ...state, countScale: MOUSE_COUNT_SCALE });
  applySensitivity(controls, sensitivity);
  home.render(state);
});

home.render(settings.get());
home.renderAccount({ authState, freeSessionsRemaining: freeSessionsRemaining() });
home.setScreen('home');

// Replay any telemetry a previous page load could not deliver.
initTelemetryOutbox();

// Rolling refresh-rate estimate, sampled off the render loop (which runs on the
// home screen too), so a session opened at pointer lock already has a value. The
// sessions row stores it because per-frame cadence scales with refresh_hz.
let lastFrameTs = 0;
let fpsEstimate = 0;

function sampleRefreshHz(now) {
  if (lastFrameTs !== 0) {
    const dt = now - lastFrameTs;
    if (dt > 0) {
      const instant = 1000 / dt;
      fpsEstimate = fpsEstimate === 0 ? instant : fpsEstimate * 0.9 + instant * 0.1;
    }
  }
  lastFrameTs = now;
}

// Coarse, stable, non-identifying: enough to hold out a device, not enough to
// track one. Mirrors the intent of sessions.device_fingerprint in schema.sql.
function deviceFingerprint() {
  const raw = [
    navigator.platform,
    `${screen.width}x${screen.height}`,
    window.devicePixelRatio,
    navigator.hardwareConcurrency
  ].join('|');

  let hash = 0;
  for (let i = 0; i < raw.length; i++) hash = (hash * 31 + raw.charCodeAt(i)) | 0;
  return `fp_${(hash >>> 0).toString(16)}`;
}

// The session-scoped hardware block. cm360 is the DPI-independent ground truth;
// dpi/sens are stored raw because dx/dy are meaningless across users without them.
// app_version/sampling_version stamp the code that produced the row.
function sessionInfo() {
  return {
    dpi: sensitivity.dpi,
    sens: sensitivity.sens,
    cmPer360: sensitivity.cm360,
    fovDeg: CAMERA_FOV,
    refreshHz: fpsEstimate > 0 ? Math.round(fpsEstimate) : null,
    pollHz: null,
    deviceFingerprint: deviceFingerprint(),
    userAgent: navigator.userAgent,
    platform: navigator.platform,
    screenWidth: screen.width,
    screenHeight: screen.height,
    devicePixelRatio: window.devicePixelRatio,
    appVersion: APP_VERSION,
    samplingVersion: SAMPLING_VERSION
  };
}

controls.addEventListener('lock', () => {
  const { routine, difficulty } = settings.get();
  const signedIn = authState.status === 'signed_in';

  // A signed-out player spends one free session here; it persists nothing since
  // insertSession() has no subject to attach to.
  if (signedIn === false) {
    consumeFreeSession();
    home.renderAccount({ authState, freeSessionsRemaining: freeSessionsRemaining() });
  }

  home.setScreen('playing');
  hud.setMode(routineById(routine).name + ' · ' + difficulty);
  game.start({
    routineId: routine,
    difficulty,
    config: configFor(routine, difficulty),
    session: sessionInfo()
  });
});

controls.addEventListener('unlock', () => {
  game.stop();
  // Push whatever the session buffered promptly, rather than waiting for the
  // debounce or the next page load.
  flushTelemetry();
  home.setScreen('paused');
});

// A closing or backgrounded tab gets one last best-effort delivery; anything it
// cannot send stays in IndexedDB for the next load to replay.
window.addEventListener('pagehide', flushTelemetryKeepalive);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') flushTelemetryKeepalive();
});

window.addEventListener('resize', resize);

function frame(now) {
  requestAnimationFrame(frame);
  sampleRefreshHz(now);
  game.update(now);
  renderer.render(scene, camera);
}

requestAnimationFrame(frame);
