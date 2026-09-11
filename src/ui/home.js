import { ROUTINES } from '../routines/index.js';
import { DIFFICULTY_LEVELS } from '../difficulty.js';
import { createSensitivity } from '../sensitivity.js';

// Owns the home and pause screens: renders the routine catalogue, sensitivity
// settings and the account panel, writes setting changes straight back into the
// store, and gates Start on the account state. `auth` supplies the three async
// account actions (onSignIn/onSignUp/onSignOut), each resolving to a result
// object ({ error } / { needsConfirmation } / {}) that this module displays.
export function createHome({ settings, auth, onStart, onResume, onMenu }) {
  const homeScreen = document.getElementById('home');
  const pauseScreen = document.getElementById('pause');
  const modeGrid = document.getElementById('mode-grid');
  const difficultyRow = document.getElementById('difficulty-row');
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
  const signoutButton = document.getElementById('signout-button');
  const authMessage = document.getElementById('auth-message');
  const accountEmail = document.getElementById('account-email');
  const startButton = document.getElementById('start-button');
  const startNote = document.getElementById('start-note');

  const modeButtons = new Map();
  const difficultyButtons = new Map();

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

  signinButton.addEventListener('click', handleSignIn);
  signupButton.addEventListener('click', handleSignUp);
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
      startNote.textContent = 'Esc pauses. Left click to shoot.';
    } else if (lastFreeRemaining > 0) {
      const plural = lastFreeRemaining === 1 ? 'session' : 'sessions';
      startNote.textContent = `${lastFreeRemaining} free ${plural} left — create an account to save your training data.`;
    } else {
      startNote.textContent = 'Create an account to keep training — free sessions used up.';
    }
  }

  startButton.addEventListener('click', () => {
    if (startButton.disabled) return;
    onStart();
  });
  document.getElementById('resume-button').addEventListener('click', onResume);
  document.getElementById('menu-button').addEventListener('click', onMenu);

  return {
    render(state) {
      for (const [id, tile] of modeButtons) {
        tile.classList.toggle('selected', id === state.routine);
      }
      for (const [level, button] of difficultyButtons) {
        button.classList.toggle('selected', level === state.difficulty);
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

    setScreen(screen) {
      homeScreen.classList.toggle('hidden', screen !== 'home');
      pauseScreen.classList.toggle('hidden', screen !== 'paused');
    }
  };
}
