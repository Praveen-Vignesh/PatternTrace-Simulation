import { createClient } from '@supabase/supabase-js';
import { createOutbox, createIdbStore } from './outbox.js';
import { CONSENT_VERSION } from './constants.js';

const url = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

// Without credentials the trainer still runs; rows are simply dropped.
const client =
  url && anonKey
    ? createClient(url, anonKey, {
        // detectSessionInUrl handles the Google OAuth redirect back to the app:
        // supabase-js reads the code/tokens Google appended to the URL, exchanges
        // them for a session, then strips them from the URL. A no-op for the
        // email/password path, whose URLs never carry those params.
        auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
      })
    : null;

if (client === null) {
  console.warn(
    'Supabase is not configured. Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY in .env.local to persist telemetry.'
  );
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Authentication
// ---------------------------------------------------------------------------
// v2 collects data only from real accounts. Anonymous sign-in was removed: with
// no auth session, ensureAuth() resolves null and every write is dropped, so an
// unauthenticated (free) session persists nothing at all — the guarantee that no
// anonymous rows reach the table. The handle_new_user() trigger creates the
// subject + profile for a real email signup exactly as it did for anonymous
// users, so the schema needs no change for this.

let accessToken = null;
// { status: 'loading' | 'signed_in' | 'signed_out', email, userId, consented }
//
// `consented` mirrors profiles.consent_version: true once a version is stamped,
// false when the row says nothing, and null while it is still being read. It is
// deliberately SERVER state rather than a localStorage flag — the flag this
// replaced could not survive a magic link opened on a different device from the
// one that requested it, so consent silently went unrecorded while play
// continued. Gating on the column makes "no consent row, no play" unconditional.
let currentAuth = {
  status: client === null ? 'signed_out' : 'loading',
  email: null,
  userId: null,
  consented: null
};
const authListeners = new Set();

// Memoised subject resolution for the current auth user. Reset to null on any
// auth change so a new sign-in re-resolves against the right profile.
let subjectPromise = null;

export function getAuthState() {
  return { ...currentAuth };
}

// Subscribe to auth changes. The callback fires immediately with the current
// state and on every subsequent change; returns an unsubscribe function.
export function onAuthChange(callback) {
  authListeners.add(callback);
  callback(getAuthState());
  return () => authListeners.delete(callback);
}

function notifyAuth() {
  for (const callback of authListeners) callback(getAuthState());
}

if (client !== null) {
  // Fires INITIAL_SESSION on subscribe (supabase-js v2), so currentAuth leaves
  // 'loading' as soon as the persisted session is read from localStorage.
  client.auth.onAuthStateChange((_event, session) => {
    accessToken = session?.access_token ?? null;

    if (session?.user) {
      // TOKEN_REFRESHED fires roughly hourly, and supabase-js also re-emits for
      // the same account (INITIAL_SESSION then SIGNED_IN on a fresh load).
      // Re-resolving on those would drop `consented` back to null mid-session,
      // which applyStartGate() reads as "still checking" and uses to disable
      // Start under a player who is already signed in and agreed. Only a real
      // change of account re-resolves the profile.
      const sameUser =
        currentAuth.status === 'signed_in' && currentAuth.userId === session.user.id;

      if (sameUser) {
        currentAuth = { ...currentAuth, email: session.user.email ?? currentAuth.email };
        notifyAuth();
        return;
      }

      subjectPromise = null;
      currentAuth = {
        status: 'signed_in',
        email: session.user.email ?? null,
        userId: session.user.id,
        consented: null
      };
      notifyAuth();
      // Consent needs a round trip, so it lands in a second notification. The UI
      // treats null as "still checking" and keeps Start disabled meanwhile.
      //
      // Deferred out of this callback ON PURPOSE, and it must stay deferred.
      // supabase-js invokes auth state callbacks while holding its internal auth
      // lock, and refreshConsent() calls back into client.auth.getSession().
      // Calling a Supabase auth method from inside this callback contends with
      // that lock, so the profile read runs against a session that is not ready
      // and comes back empty. `consented` then publishes as false for an account
      // that HAS agreed — which is the consent prompt reappearing on every sign
      // in, with the correct value sitting in the database the whole time.
      // setTimeout lets the lock release first.
      setTimeout(refreshConsent, 0);
      return;
    }

    subjectPromise = null;
    currentAuth = { status: 'signed_out', email: null, userId: null, consented: null };
    notifyAuth();
  });
}

// Reads consent state for whoever is signed in now and republishes it.
async function refreshConsent() {
  const pending = currentAuth.userId;
  const auth = await ensureAuth();

  // A sign-out or a different sign-in may have landed while this was in flight;
  // publishing then would attach one account's consent to another's session.
  if (currentAuth.userId !== pending) return;

  // Compared against CONSENT_VERSION rather than merely checked for presence, so
  // bumping the version re-prompts everyone instead of silently accepting
  // agreement to superseded wording — which is the whole point of the constant.
  // Bumping it therefore blocks existing players until they agree again; that is
  // intended, and is why CONSENT_VERSION moves only on a material change.
  //
  // A null auth means no profile row resolved — the account cannot record consent
  // or telemetry at all. Reporting false (not null) stops the UI hanging on
  // "checking" forever and surfaces the failure when consent is attempted.
  currentAuth = { ...currentAuth, consented: auth !== null && auth.consentVersion === CONSENT_VERSION };
  notifyAuth();
}

function resolveSubjectFor(user) {
  // The trigger creates the profile in the same transaction as the auth user,
  // so it is normally present immediately; retry briefly against any lag.
  return (async () => {
    let lastError = null;
    for (let attempt = 0; attempt < 5; attempt++) {
      // consent_version rides along on the query that was already being made —
      // the `profiles select own` policy covers both columns.
      const { data, error } = await client
        .from('profiles')
        .select('subject_id, consent_version')
        .eq('user_id', user.id)
        .maybeSingle();

      if (error === null && data) {
        return {
          userId: user.id,
          subjectId: data.subject_id,
          consentVersion: data.consent_version ?? null
        };
      }
      lastError = error;
      await sleep(200);
    }

    // The specific failure is what distinguishes the two causes, and swallowing
    // it is why this was invisible: a 401/PGRST301 means the token was not
    // attached yet (transient, and the caller must not cache the null), while a
    // clean empty result means the on_auth_user_created trigger genuinely never
    // made a profile row for this account (permanent, needs a server-side fix).
    console.warn(
      'Supabase profile row not resolved for the signed-in user; telemetry dropped.',
      lastError
        ? `Last error: ${lastError.code ?? 'no code'} — ${lastError.message}`
        : 'No error, but no row returned — this account has no profiles row.'
    );
    return null;
  })();
}

// Resolves to { userId, subjectId, consentVersion } when a real account is
// signed in, or null. Null is the "drop this write" signal — no anonymous
// fallback exists.
function ensureAuth() {
  if (client === null) return Promise.resolve(null);
  if (subjectPromise === null) {
    const pending = (async () => {
      const { data } = await client.auth.getSession();
      const user = data.session?.user ?? null;
      if (user === null) return null;
      return resolveSubjectFor(user);
    })();

    subjectPromise = pending;

    // A null result is a FAILURE, not an answer, so it is deliberately not
    // memoised. This read can fail transiently — the session may still be
    // restoring, or the access token may not be attached yet — and caching that
    // null poisons every later call for the rest of the page's life: consent,
    // session inserts and segment writes all keep resolving null with no retry,
    // until an auth event happens to clear it. Only a real resolution sticks.
    pending.then((auth) => {
      if (auth === null && subjectPromise === pending) subjectPromise = null;
    });
  }
  return subjectPromise;
}

// Returns {} on success, { error } (a message) on failure, or { needsConfirmation:true }
// when the project requires email confirmation and no session was issued yet.
export async function signUp({ email, password }) {
  if (client === null) return { error: 'Supabase is not configured.' };
  const { data, error } = await client.auth.signUp({ email, password });
  if (error) return { error: error.message };

  // With "Confirm email" ON, Supabase does NOT reject a signup for an address
  // that already has an account — it returns a decoy success, so the endpoint
  // cannot be used to enumerate registered emails. The tell is an empty
  // `identities` array on the returned user; a genuine new signup always has
  // exactly one. Without this check the panel tells a returning player "Account
  // created, check your email" and no email ever arrives, because none was sent.
  //
  // Reporting it does make enumeration possible against this project. That is a
  // deliberate trade-off: the cohort is ~50 recruited participants, and silently
  // swallowing a returning player's signup costs a session, which is the scarce
  // resource here.
  if (data.user && Array.isArray(data.user.identities) && data.user.identities.length === 0) {
    return { error: 'That email already has an account — sign in instead.' };
  }

  return { needsConfirmation: data.session === null };
}

export async function signIn({ email, password }) {
  if (client === null) return { error: 'Supabase is not configured.' };
  const { error } = await client.auth.signInWithPassword({ email, password });
  if (error) return { error: error.message };
  return {};
}

// Redirects the browser to Google and never resolves on success (the page
// navigates away); a rejected promise here means the redirect itself couldn't
// start (e.g. the provider isn't configured in the Supabase dashboard).
export async function signInWithGoogle() {
  if (client === null) return { error: 'Supabase is not configured.' };
  const { error } = await client.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo: window.location.origin }
  });
  if (error) return { error: error.message };
  return {};
}

export async function signOut() {
  if (client === null) return;
  await client.auth.signOut();
}

// supabase-js restores the persisted session from localStorage and emits
// INITIAL_SESSION without asking the server whether it is still valid, so a
// deleted or revoked account still renders as signed in — and then silently
// records nothing, because ensureAuth() can resolve no profile for it.
// getUser() is the round-trip getSession() deliberately skips, and is what
// corrects the state on boot.
//
// Only a definitive rejection signs out. A network failure leaves the session
// alone: discarding a good session because the wifi dropped would be worse than
// the bug this fixes. Same permanent-vs-transient split the outbox makes on
// SQLSTATE — a retryable fetch error carries no 401/403 and so falls through.
export async function validateSession() {
  if (client === null) return;

  const { data } = await client.auth.getSession();
  if (data.session === null) return;

  const { error } = await client.auth.getUser();
  if (error === null || error === undefined) return;
  if (error.status !== 401 && error.status !== 403) return;

  console.warn('Stored session is no longer valid; signing out:', error.message);
  // Local scope only. The server-side session is already gone in this case, so a
  // global sign-out would call an endpoint that rejects it.
  await client.auth.signOut({ scope: 'local' });
}

// Stamps consent on the caller's profile. The profiles update policy permits the
// two consent columns (not the subject link), so this passes RLS. The value is
// copied to subjects offline so it survives account deletion (see schema.sql).
//
// Returns {} or { error } like the other auth calls: this gates play now, so a
// silent failure would leave the player stuck on a consent screen with no reason
// given. On success the resolved subject is re-read, because the memoised one
// still carries the pre-consent value.
export async function recordConsent(version = CONSENT_VERSION) {
  if (client === null) return { error: 'Supabase is not configured.' };

  const auth = await ensureAuth();
  if (auth === null) return { error: 'No profile is linked to this account.' };

  // The .select() is what makes this verifiable, and it is not optional.
  // PostgREST answers an UPDATE that matched NO rows with a plain 200 and no
  // error, so without asking for the row back an RLS refusal, a missing profile
  // and a real write are indistinguishable. The client would report success,
  // flip `consented` locally, let the player run — and then prompt for consent
  // again on the next sign-in, because the column was never written. Consent
  // that silently fails to persist is the one failure this project cannot ship.
  const { data, error } = await client
    .from('profiles')
    .update({ consent_version: version, consented_at: new Date().toISOString() })
    .eq('user_id', auth.userId)
    .select('consent_version');

  if (error) {
    console.warn('Consent update failed:', error.message);
    return { error: error.message };
  }

  if (Array.isArray(data) === false || data.length === 0) {
    console.warn('Consent update matched no profile row for user', auth.userId);
    return { error: 'Your agreement could not be saved. Sign out, sign in again, and retry.' };
  }

  subjectPromise = null;
  // Read back from what the database stored rather than assumed from intent: if
  // the write ever lands while storing something else, the gate must follow the
  // stored value, exactly as refreshConsent() does.
  currentAuth = { ...currentAuth, consented: data[0].consent_version === CONSENT_VERSION };
  notifyAuth();
  return {};
}

// ---------------------------------------------------------------------------
// Telemetry delivery
// ---------------------------------------------------------------------------

// The segment insert: a plain INSERT, deliberately NOT an upsert. PostgREST
// switches to its upsert path on the Prefer: resolution=... header alone (the
// on_conflict query param is inert without it), and that path is refused with
// 42501 on this table under both resolutions — it needs SELECT/UPDATE policies
// that `segments` withholds on purpose, since a trajectory is the raw material
// of a biometric template. The identical row inserts fine without the header.
//
// Idempotency comes from the unique (session_id, segment_index) instead: a
// re-sent row raises 23505, which the outbox reads as "already delivered". No
// .select() either — segments has no read policy, so asking for the rows back
// would fail even though the write is allowed.
async function sendSegments(rows) {
  const { error } = await client.from('segments').insert(rows);

  if (error) {
    // The SQLSTATE is what tells the outbox whether a retry can ever succeed: an
    // RLS rejection (42501) is permanent, a dropped connection is not. Flattening
    // this to a bare message is what let one undeliverable row retry forever.
    const failure = new Error(error.message);
    failure.code = error.code;
    failure.details = error.details;
    throw failure;
  }
}

// Best-effort delivery during page unload. supabase-js does not expose keepalive,
// so this hits PostgREST directly with keepalive:true, which an unloading page is
// still allowed to finish. The token is cached from onAuthStateChange because
// this must run synchronously — no await on getSession().
function sendSegmentsKeepalive(rows) {
  if (accessToken === null || typeof fetch === 'undefined') return;

  fetch(`${url}/rest/v1/segments`, {
    method: 'POST',
    keepalive: true,
    headers: {
      'Content-Type': 'application/json',
      apikey: anonKey,
      Authorization: `Bearer ${accessToken}`,
      Prefer: 'return=minimal'
    },
    body: JSON.stringify(rows)
  }).catch(() => {});
}

const outbox =
  client === null
    ? null
    : createOutbox({
        send: sendSegments,
        sendKeepalive: sendSegmentsKeepalive,
        store: createIdbStore(),
        onError: (error) => console.warn('Segment batch delivery failed, will retry:', error.message),
        onDrop: (row, error) =>
          console.warn(
            `Segment ${row.session_id}:${row.segment_index} was rejected permanently ` +
              `(${error.code}) and has been dropped:`,
            error.message
          )
      });

// Replays anything a previous page load left unacknowledged in IndexedDB.
export function initTelemetryOutbox() {
  if (outbox !== null) outbox.init();
}

// A prompt flush (e.g. at session end) and a keepalive flush (page unload).
export function flushTelemetry() {
  if (outbox !== null) return outbox.flush();
}

export function flushTelemetryKeepalive() {
  if (outbox !== null) outbox.flushKeepalive();
}

// Opens a session row and resolves to its id, or null when persistence is
// unavailable (not configured, or not signed in). Awaited by every segment,
// since each references this id. subject_id is stamped here from the resolved
// profile so the RLS insert check (subject_id = current_subject_id()) passes.
export async function insertSession(payload) {
  const auth = await ensureAuth();
  if (auth === null) return null;

  const { data, error } = await client
    .from('sessions')
    .insert({ ...payload, subject_id: auth.subjectId })
    .select('id')
    .single();

  if (error) {
    console.warn('Session insert failed:', error.message);
    return null;
  }

  return data.id;
}

// Awaits the session id, then hands the row to the durable outbox. Never blocks
// the game loop: the caller passes the still-in-flight session promise. A null
// session id (the insert was dropped, or no auth session resolved) discards the row.
export async function insertSegment(sessionIdPromise, payload) {
  if (outbox === null) return;

  const sessionId = await sessionIdPromise;
  if (sessionId === null) return;

  outbox.enqueue({ ...payload, session_id: sessionId });
}
