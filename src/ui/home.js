import { ROUTINES, routineById } from '../routines/index.js';
import { DIFFICULTY_LEVELS } from '../difficulty.js';
import { createSensitivity } from '../sensitivity.js';
import { formatClock } from '../hud.js';
import { SESSION_DURATIONS_MIN, SESSION_COMPLETE_FRACTION } from '../constants.js';

// Owns the home, pause and results screens: renders the routine catalogue,
// sensitivity settings and the account panel, writes setting changes straight
// back into the store, and gates Start on the account state. `auth` supplies the
// three async account actions (onSignIn/onSignUp/onSignOut), each resolving to a
// result object ({ error } / { needsConfirmation } / {}) that this module
// displays. `onEndRun` finishes a run for good; `onMenu` only changes screen.
export function createHome({ settings, auth, onStart, onResume, onEndRun, onMenu }) {
  const homeScreen = document.getElementById('home');
  const pauseScreen = document.getElementById('pause');
  const resultsScreen = document.getElementById('results');
  const pauseTimeLeft = document.getElementById('pause-time-left');
  const modeGrid = document.getElementById('mode-grid');
  const difficultyRow = document.getElementById('difficulty-row');
  const durationRow = document.getElementById('duration-row');
  const dpiInput = document.getElementById('dpi-input');
  const sensInput = document.getElementById('sens-input');
  const edpiReadout = document.getElementById('edpi-readout');
  const cm360Readout = document.getElementById('cm360-readout');

  // Account panel.
  const signedOutBlock = document.getElementById('account-signed-out');
  const signedInBlock = document.getElementById('account-signed-in');
  const emailInput = document.getElementById('email-input');
  const passwordInput = document.getElementById('password-input');
  const consentCheckbox = document.getElementById('consent-checkbox');
  const signinButton = document.getElementById('signin-button');
  const signupButton = document.getElementById('signup-button');
  const googleButton = document.getElementById('google-signin-button');
  const signoutButton = document.getElementById('signout-button');
  const authMessage = document.getElementById('auth-message');
  const accountEmail = document.getElementById('account-email');
  const startButton = document.getElementById('start-button');
  const startNote = document.getElementById('start-note');

  // Results screen.
  const resultRoutine = document.getElementById('result-routine');
  const resultTime = document.getElementById('result-time');
  const resultScore = document.getElementById('result-score');
  const resultAccuracy = document.getElementById('result-accuracy');
  const resultAvgTime = document.getElementById('result-avg-time');
  const resultNote = document.getElementById('result-note');

  const modeButtons = new Map();
  const difficultyButtons = new Map();
  const durationButtons = new Map();

  // Latest inputs to the Start gate, so a settings-only re-render does not need
  // them threaded through.
  let lastAuthState = { status: 'loading', email: null };
  let lastFreeRemaining = 0;

  for (const routine of ROUTINES) {
    const tile = document.createElement('button');
    tile.className = 'mode-tile';
    tile.disabled = routine.available === false;
    tile.innerHTML =
      `<span class="mode-name">${routine.name}</span>` +
      `<span class="mode-blurb">${routine.blurb}</span>` +
      `<span class="mode-tag">${routine.available ? 'Ready' : `Phase ${routine.phase}`}</span>`;
    tile.addEventListener('click', () => settings.update({ routine: routine.id }));
    modeGrid.appendChild(tile);
    modeButtons.set(routine.id, tile);
  }

  for (const level of DIFFICULTY_LEVELS) {
    const button = document.createElement('button');
    button.className = 'segment';
    button.textContent = level;
    button.addEventListener('click', () => settings.update({ difficulty: level }));
    difficultyRow.appendChild(button);
    difficultyButtons.set(level, button);
  }

  for (const minutes of SESSION_DURATIONS_MIN) {
    const button = document.createElement('button');
    button.className = 'segment';
    button.textContent = `${minutes} min`;
    button.addEventListener('click', () => settings.update({ duration: minutes }));
    durationRow.appendChild(button);
    durationButtons.set(minutes, button);
  }

  function renderReadout(dpi, sens) {
    if (Number.isFinite(dpi) === false || Number.isFinite(sens) === false || dpi <= 0 || sens <= 0) {
      edpiReadout.textContent = '—';
      cm360Readout.textContent = '—';
      return;
    }

    const sensitivity = createSensitivity({ dpi, sens });
    edpiReadout.textContent = Math.round(sensitivity.eDPI);
    cm360Readout.textContent = `${sensitivity.cm360.toFixed(1)} cm`;
  }

  // Preview while typing, without committing: clamping a half-typed "8" on its
  // way to "800" would fight the player's keystrokes. Commit lands on change.
  dpiInput.addEventListener('input', () =>
    renderReadout(Number(dpiInput.value), Number(sensInput.value))
  );
  sensInput.addEventListener('input', () =>
    renderReadout(Number(dpiInput.value), Number(sensInput.value))
  );

  const commit = () =>
    settings.update({ dpi: Number(dpiInput.value), sens: Number(sensInput.value) });

  dpiInput.addEventListener('change', commit);
  sensInput.addEventListener('change', commit);

  // --- account actions -----------------------------------------------------

  function setAuthMessage(text, isError = false) {
    authMessage.textContent = text ?? '';
    authMessage.classList.toggle('error', isError === true && Boolean(text));
  }

  function setAuthBusy(busy) {
    signinButton.disabled = busy;
    signupButton.disabled = busy;
    googleButton.disabled = busy;
  }

  async function handleSignIn() {
    const email = emailInput.value.trim();
    const password = passwordInput.value;
    if (email === '' || password === '') {
      setAuthMessage('Enter your email and password.', true);
      return;
    }

    setAuthBusy(true);
    setAuthMessage('Signing in…');
    const result = await auth.onSignIn({ email, password });
    setAuthBusy(false);

    if (result && result.error) setAuthMessage(result.error, true);
    else setAuthMessage('');
  }

  async function handleSignUp() {
    const email = emailInput.value.trim();
    const password = passwordInput.value;
    if (email === '' || password === '') {
      setAuthMessage('Enter an email and password to create an account.', true);
      return;
    }
    if (consentCheckbox.checked === false) {
      setAuthMessage('Please agree to telemetry collection before creating an account.', true);
      return;
    }

    setAuthBusy(true);
    setAuthMessage('Creating your account…');
    const result = await auth.onSignUp({ email, password });
    setAuthBusy(false);

    if (result && result.error) setAuthMessage(result.error, true);
    else if (result && result.needsConfirmation) {
      setAuthMessage('Account created. Check your email to confirm, then sign in.');
    } else setAuthMessage('');
  }

  async function handleGoogleSignIn() {
    if (consentCheckbox.checked === false) {
      setAuthMessage('Please agree to telemetry collection before continuing.', true);
      return;
    }

    setAuthBusy(true);
    setAuthMessage('Redirecting to Google…');
    const result = await auth.onGoogleSignIn();
    setAuthBusy(false);

    if (result && result.error) setAuthMessage(result.error, true);
  }

  signinButton.addEventListener('click', handleSignIn);
  signupButton.addEventListener('click', handleSignUp);
  googleButton.addEventListener('click', handleGoogleSignIn);
  signoutButton.addEventListener('click', () => auth.onSignOut());

  // Start is gated: signed-in players always may; signed-out players may until
  // their free sessions run out, and those persist nothing.
  function applyStartGate() {
    const signedIn = lastAuthState.status === 'signed_in';
    const loading = lastAuthState.status === 'loading';
    const canStart = signedIn || lastFreeRemaining > 0;

    startButton.disabled = loading || canStart === false;

    if (loading) {
      startNote.textContent = 'Checking your session…';
    } else if (signedIn) {
      startNote.textContent = 'Esc pauses the clock. Left click to shoot.';
    } else if (lastFreeRemaining > 0) {
      const plural = lastFreeRemaining === 1 ? 'run' : 'runs';
      startNote.textContent = `${lastFreeRemaining} free ${plural} left — create an account to save your training data.`;
    } else {
      startNote.textContent = 'Create an account to keep training — free runs used up.';
    }
  }

  startButton.addEventListener('click', () => {
    if (startButton.disabled) return;
    onStart();
  });
  document.getElementById('resume-button').addEventListener('click', onResume);
  // Ends the run rather than just changing screen: leaving a paused session open
  // would orphan it, and its telemetry would never be flushed.
  document.getElementById('menu-button').addEventListener('click', onEndRun);
  document.getElementById('results-menu-button').addEventListener('click', onMenu);

  return {
    render(state) {
      for (const [id, tile] of modeButtons) {
        tile.classList.toggle('selected', id === state.routine);
      }
      for (const [level, button] of difficultyButtons) {
        button.classList.toggle('selected', level === state.difficulty);
      }
      for (const [minutes, button] of durationButtons) {
        button.classList.toggle('selected', minutes === state.duration);
      }

      dpiInput.value = state.dpi;
      sensInput.value = state.sens;
      renderReadout(state.dpi, state.sens);
    },

    // Re-renders the account panel and the Start gate. Called on every auth
    // change and whenever the free-session count moves.
    renderAccount({ authState, freeSessionsRemaining }) {
      lastAuthState = authState;
      lastFreeRemaining = freeSessionsRemaining;

      const signedIn = authState.status === 'signed_in';
      signedOutBlock.classList.toggle('hidden', signedIn);
      signedInBlock.classList.toggle('hidden', signedIn === false);
      if (signedIn) {
        accountEmail.textContent = authState.email ?? 'your account';
        setAuthMessage('');
      }

      applyStartGate();
    },

    // The pause clock is static: the countdown is frozen while paused, so this
    // is written once on entry rather than ticking.
    renderPause({ remainingMs }) {
      pauseTimeLeft.textContent = formatClock(remainingMs);
    },

    // Worded as progress, never as a saved record. The authoritative completion
    // verdict is derived offline from delivered segments and will legitimately
    // differ — most starkly on a free run, which writes no rows at all.
    renderResults(summary) {
      if (summary === null) return;

      const { routineId, difficulty, plannedMs, activeMs } = summary;
      const { hits, attempts, clicks, totalTimeMs, completed } = summary;
      const name = routineById(routineId)?.name ?? routineId;
      const timed = clicks === 0 ? attempts : clicks;

      resultRoutine.textContent = `${name} · ${difficulty}`;
      resultTime.textContent = `${formatClock(activeMs)} of ${formatClock(plannedMs)}`;
      resultScore.textContent = hits;
      resultAccuracy.textContent =
        attempts === 0 ? '0%' : `${Math.round((hits / attempts) * 100)}%`;
      resultAvgTime.textContent = timed === 0 ? '0 ms' : `${Math.round(totalTimeMs / timed)} ms`;

      const percent = Math.round(SESSION_COMPLETE_FRACTION * 100);
      resultNote.textContent = completed
        ? `Session complete — you passed the ${percent}% mark.`
        : `Under the ${percent}% mark, so this run does not count as complete.`;
    },

    setScreen(screen) {
      homeScreen.classList.toggle('hidden', screen !== 'home');
      pauseScreen.classList.toggle('hidden', screen !== 'paused');
      resultsScreen.classList.toggle('hidden', screen !== 'results');
    }
  };
}
