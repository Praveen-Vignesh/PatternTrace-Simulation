import './style.css';
import { createScene } from './scene.js';
import { createControls, applySensitivity, requestLock } from './controls.js';
import { createGame } from './game.js';
import { createHud } from './hud.js';
import { readBotMode, createBot } from './bot.js';
import { createSettings } from './settings.js';
import { createSensitivity } from './sensitivity.js';
import { configFor } from './difficulty.js';
import { routineById } from './routines/index.js';
import { createHome } from './ui/home.js';
import { MOUSE_COUNT_SCALE, CAMERA_FOV } from './constants.js';

const crosshair = document.getElementById('crosshair');

const { scene, camera, renderer, resize } = createScene(document.getElementById('scene'));
const settings = createSettings();

let sensitivity = createSensitivity({ ...settings.get(), countScale: MOUSE_COUNT_SCALE });

const controls = createControls(camera, document.body, sensitivity);
const hud = createHud();

const botMode = readBotMode();
const bot = botMode === null ? null : createBot(botMode, sensitivity.radiansPerMovementUnit);

// The bot owns the camera, so real mouse movement must not rotate it.
if (bot !== null) controls.enabled = false;

const game = createGame({ scene, camera, crosshair, hud, bot });

const home = createHome({
  settings,
  onStart: () => requestLock(controls),
  onResume: () => requestLock(controls),
  onMenu: () => home.setScreen('home')
});

// One sensitivity value, two consumers. The bot has to move with the player or
// its synthetic deltas stop describing the rotation it performed.
settings.subscribe((state) => {
  sensitivity = createSensitivity({ ...state, countScale: MOUSE_COUNT_SCALE });
  applySensitivity(controls, sensitivity);
  if (bot !== null) bot.setRadiansPerMovementUnit(sensitivity.radiansPerMovementUnit);
  home.render(state);
});

home.render(settings.get());
home.setScreen('home');

// Pointer lock is still the play boundary; the home screen is the new resting
// state in front of it.
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
    devicePixelRatio: window.devicePixelRatio
  };
}

controls.addEventListener('lock', () => {
  const { routine, difficulty } = settings.get();

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
  home.setScreen('paused');
});

window.addEventListener('resize', resize);

function frame(now) {
  requestAnimationFrame(frame);
  sampleRefreshHz(now);
  game.update(now);
  renderer.render(scene, camera);
}

requestAnimationFrame(frame);
