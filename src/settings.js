import {
  DEFAULT_DPI,
  DEFAULT_SENSITIVITY,
  DEFAULT_DIFFICULTY,
  DEFAULT_ROUTINE,
  DEFAULT_SESSION_DURATION_MIN,
  SESSION_DURATIONS_MIN
} from './constants.js';
import { DIFFICULTY_LEVELS } from './difficulty.js';
import { isAvailable } from './routines/index.js';

const STORAGE_KEY = 'aim-trainer.settings';

const DPI_MIN = 100;
const DPI_MAX = 32000;
const SENS_MIN = 0.01;
const SENS_MAX = 10;

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

// Anything off the wire — localStorage, a hand-edited value — is coerced back
// into range here, so no other module has to defend against a bad number.
function sanitise(candidate, previous) {
  const dpi = Number(candidate.dpi);
  const sens = Number(candidate.sens);

  return {
    dpi: Number.isFinite(dpi) ? clamp(Math.round(dpi), DPI_MIN, DPI_MAX) : DEFAULT_DPI,
    sens: Number.isFinite(sens) ? clamp(sens, SENS_MIN, SENS_MAX) : DEFAULT_SENSITIVITY,
    difficulty: DIFFICULTY_LEVELS.includes(candidate.difficulty)
      ? candidate.difficulty
      : DEFAULT_DIFFICULTY,
    routine: pickRoutine(candidate.routine, previous),
    // Minutes, not milliseconds: it is what the UI shows, and the single
    // conversion happens where the session starts. Coerced BEFORE the
    // membership test because a hand-edited localStorage value round-trips as
    // the string "10", which includes() would reject.
    duration: SESSION_DURATIONS_MIN.includes(Number(candidate.duration))
      ? Number(candidate.duration)
      : DEFAULT_SESSION_DURATION_MIN
  };
}

function pickRoutine(candidate, previous) {
  if (isAvailable(candidate)) return candidate;
  if (previous !== undefined && isAvailable(previous.routine)) return previous.routine;
  return DEFAULT_ROUTINE;
}

function read() {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    return stored === null ? {} : JSON.parse(stored);
  } catch {
    // Private mode, disabled storage, or corrupt JSON — fall back to defaults.
    return {};
  }
}

function write(state) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Persistence is a convenience; failing to save must never break play.
  }
}

export const SETTINGS_LIMITS = { DPI_MIN, DPI_MAX, SENS_MIN, SENS_MAX };

export function createSettings() {
  let state = sanitise(read());
  const listeners = [];

  return {
    get() {
      return { ...state };
    },

    update(patch) {
      state = sanitise({ ...state, ...patch }, state);
      write(state);
      for (const listener of listeners) listener(this.get());
    },

    subscribe(listener) {
      listeners.push(listener);
    }
  };
}
