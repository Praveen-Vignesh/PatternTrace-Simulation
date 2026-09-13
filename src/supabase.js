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
// { status: 'loading' | 'signed_in' | 'signed_out', email, userId }
let currentAuth = { status: client === null ? 'signed_out' : 'loading', email: null, userId: null };
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
    subjectPromise = null;

    if (session?.user) {
      currentAuth = { status: 'signed_in', email: session.user.email ?? null, userId: session.user.id };
    } else {
      currentAuth = { status: 'signed_out', email: null, userId: null };
    }

    notifyAuth();
  });
}

function resolveSubjectFor(user) {
  // The trigger creates the profile in the same transaction as the auth user,
  // so it is normally present immediately; retry briefly against any lag.
  return (async () => {
    for (let attempt = 0; attempt < 5; attempt++) {
      const { data, error } = await client
        .from('profiles')
        .select('subject_id')
        .eq('user_id', user.id)
        .maybeSingle();

      if (error === null && data) return { userId: user.id, subjectId: data.subject_id };
      await sleep(200);
    }

    console.warn('Supabase profile row not found for the signed-in user; telemetry dropped.');
    return null;
  })();
}

// Resolves to { userId, subjectId } when a real account is signed in, or null.
// Null is the "drop this write" signal — there is no anonymous fallback.
function ensureAuth() {
  if (client === null) return Promise.resolve(null);
  if (subjectPromise === null) {
    subjectPromise = (async () => {
      const { data } = await client.auth.getSession();
      const user = data.session?.user ?? null;
      if (user === null) return null;
      return resolveSubjectFor(user);
    })();
  }
  return subjectPromise;
}

// Returns {} on success, { error } (a message) on failure, or { needsConfirmation:true }
// when the project requires email confirmation and no session was issued yet.
export async function signUp({ email, password }) {
  if (client === null) return { error: 'Supabase is not configured.' };
  const { data, error } = await client.auth.signUp({ email, password });
  if (error) return { error: error.message };
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

// Stamps consent on the caller's profile. The profiles update policy permits the
// two consent columns (not the subject link), so this passes RLS. The value is
// copied to subjects offline so it survives account deletion (see schema.sql).
export async function recordConsent(version = CONSENT_VERSION) {
  const auth = await ensureAuth();
  if (auth === null) return;

  const { error } = await client
    .from('profiles')
    .update({ consent_version: version, consented_at: new Date().toISOString() })
    .eq('user_id', auth.userId);

  if (error) console.warn('Consent update failed:', error.message);
}

// ---------------------------------------------------------------------------
// Telemetry delivery
// ---------------------------------------------------------------------------

// The segment insert: an upsert with ignoreDuplicates, so a retried batch that
// partly landed is a no-op on the rows already there (ON CONFLICT DO NOTHING on
// the unique (session_id, segment_index)). DO NOTHING takes no UPDATE privilege,
// so this stays within the append-only RLS. No .select(): segments has no read
// policy, and requesting the rows back would fail even though the write is
// allowed.
async function sendSegments(rows) {
  const { error } = await client
    .from('segments')
    .upsert(rows, { onConflict: 'session_id,segment_index', ignoreDuplicates: true });

  if (error) throw new Error(error.message);
}

// Best-effort delivery during page unload. supabase-js does not expose keepalive,
// so this hits PostgREST directly with keepalive:true, which an unloading page is
// still allowed to finish. The token is cached from onAuthStateChange because
// this must run synchronously — no await on getSession().
function sendSegmentsKeepalive(rows) {
  if (accessToken === null || typeof fetch === 'undefined') return;

  fetch(`${url}/rest/v1/segments?on_conflict=session_id,segment_index`, {
    method: 'POST',
    keepalive: true,
    headers: {
      'Content-Type': 'application/json',
      apikey: anonKey,
      Authorization: `Bearer ${accessToken}`,
      Prefer: 'resolution=ignore-duplicates,return=minimal'
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
        onError: (error) => console.warn('Segment batch delivery failed, will retry:', error.message)
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
// session id (dropped, or unauthenticated free session) discards the row.
export async function insertSegment(sessionIdPromise, payload) {
  if (outbox === null) return;

  const sessionId = await sessionIdPromise;
  if (sessionId === null) return;

  outbox.enqueue({ ...payload, session_id: sessionId });
}
