// The account panel, wherever it appears. The markup stays in each page so the
// landing pages can style it however they like; this module finds its controls
// by `data-auth` *inside the root it is handed*, never by global id. That is
// what lets two differently-styled pages share one implementation, and what
// stops a second panel on a page from colliding with the first.
//
// `auth` supplies the async account actions (onSignIn / onSignUp /
// onGoogleSignIn / onConsent / onSignOut), each resolving to a result object
// ({ error } / { needsConfirmation } / {}) that this module displays. The seam
// is deliberate: this file never imports supabase.js, so it stays drivable from
// a test harness with plain stubs.
//
// `onReady` fires when the account becomes both signed in and consented — the
// landing pages use it to move the player on to the game.

const REQUIRED = [
  'signed-out',
  'consent',
  'signed-in',
  'email',
  'password',
  'signin',
  'signup',
  'google',
  'message',
  'consent-checkbox',
  'consent-submit',
  'consent-message',
  'consent-email',
  'consent-signout',
  'account-email',
  'signout'
];

export function createAuthPanel({ root, auth, onReady = null }) {
  const el = {};
  const missing = [];

  for (const key of REQUIRED) {
    const node = root.querySelector(`[data-auth="${key}"]`);
    if (node === null) missing.push(key);
    el[key] = node;
  }

  // Fails at construction, not on the first click. A page that drops a hook
  // would otherwise render a panel that looks complete and throws only when
  // somebody tries to use it — which, for a sign-up form, means finding out
  // from a user rather than from a page load.
  if (missing.length > 0) {
    throw new Error(
      `createAuthPanel: markup is missing data-auth hooks: ${missing.join(', ')}`
    );
  }

  // Visibility is set inline rather than with a class. This module runs on
  // pages whose stylesheets it does not control, and a class-based toggle loses
  // to any rule that gives the block its own `display` (the `.x.hidden` pairing
  // trap documented in CLAUDE.md). An inline style out-cascades all of them, so
  // a page cannot accidentally make a block unhideable.
  function show(node, visible) {
    node.style.display = visible ? '' : 'none';
  }

  function setMessage(text, isError = false) {
    el.message.textContent = text ?? '';
    el.message.classList.toggle('error', isError === true && Boolean(text));
  }

  function setBusy(busy) {
    el.signin.disabled = busy;
    el.signup.disabled = busy;
    el.google.disabled = busy;
  }

  function credentials() {
    return { email: el.email.value.trim(), password: el.password.value };
  }

  async function handleSignIn() {
    const { email, password } = credentials();
    if (email === '' || password === '') {
      setMessage('Enter your email and password.', true);
      return;
    }

    setBusy(true);
    setMessage('Signing in…');
    const result = await auth.onSignIn({ email, password });
    setBusy(false);

    if (result && result.error) setMessage(result.error, true);
    else setMessage('');
  }

  async function handleSignUp() {
    const { email, password } = credentials();
    if (email === '' || password === '') {
      setMessage('Enter an email and password to create an account.', true);
      return;
    }

    setBusy(true);
    setMessage('Creating your account…');
    const result = await auth.onSignUp({ email, password });
    setBusy(false);

    if (result && result.error) setMessage(result.error, true);
    else if (result && result.needsConfirmation) {
      setMessage('Account created. Check your email to confirm, then sign in.');
    } else setMessage('');
  }

  async function handleGoogleSignIn() {
    setBusy(true);
    setMessage('Redirecting to Google…');
    const result = await auth.onGoogleSignIn();
    setBusy(false);

    if (result && result.error) setMessage(result.error, true);
  }

  // Consent is collected here, after a session exists, because this is the first
  // point at which it can actually be written to profiles. Asking before signup
  // would only have produced a promise nothing recorded.
  async function handleConsent() {
    if (el['consent-checkbox'].checked === false) {
      el['consent-message'].textContent = 'Tick the box to agree before continuing.';
      el['consent-message'].classList.add('error');
      return;
    }

    el['consent-submit'].disabled = true;
    el['consent-message'].classList.remove('error');
    el['consent-message'].textContent = 'Saving…';
    const result = await auth.onConsent();
    el['consent-submit'].disabled = false;

    if (result && result.error) {
      el['consent-message'].textContent = result.error;
      el['consent-message'].classList.add('error');
      return;
    }
    el['consent-message'].textContent = '';
  }

  el.signin.addEventListener('click', handleSignIn);
  el.signup.addEventListener('click', handleSignUp);
  el.google.addEventListener('click', handleGoogleSignIn);
  el['consent-submit'].addEventListener('click', handleConsent);
  el.signout.addEventListener('click', () => auth.onSignOut());
  el['consent-signout'].addEventListener('click', () => auth.onSignOut());

  // Enter submits, because a two-field form that ignores Enter feels broken.
  // Sign in rather than sign up: it is the non-destructive of the two, and a
  // returning player is the common case on a form already holding an address.
  for (const field of [el.email, el.password]) {
    field.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') handleSignIn();
    });
  }

  // Only a *transition* into ready fires onReady. Firing on every render would
  // bounce an already-signed-in visitor off the landing page the moment it
  // loaded, so they could never look at it again.
  let wasReady = null;

  return {
    render(authState) {
      const signedIn = authState.status === 'signed_in';
      // While consent is still being read, show the ready block rather than
      // flashing the consent prompt at someone who has already agreed.
      const needsConsent = signedIn && authState.consented === false;
      const ready = signedIn && authState.consented !== false;

      show(el['signed-out'], signedIn === false);
      show(el.consent, needsConsent);
      show(el['signed-in'], ready);

      if (signedIn) {
        const label = authState.email ?? 'your account';
        el['account-email'].textContent = label;
        el['consent-email'].textContent = label;
        setMessage('');
      }

      const fullyReady = signedIn && authState.consented === true;
      if (fullyReady && wasReady === false && onReady !== null) onReady();
      wasReady = fullyReady;
    }
  };
}
