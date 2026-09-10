import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

// Without credentials the trainer still runs; rows are simply dropped.
const client = url && anonKey ? createClient(url, anonKey) : null;

if (client === null) {
  console.warn(
    'Supabase is not configured. Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY in .env.local to persist telemetry.'
  );
}

let warnedNoAuth = false;

// The v2 schema grants `anon` nothing: every insert policy is `to authenticated`
// and keyed to current_subject_id(), which resolves only once an auth.users row
// has fired the handle_new_user() trigger that creates the subject and profile.
// Anonymous sign-in is the lightest identity that satisfies that with no login
// screen. supabase-js persists the session in localStorage, so a returning
// browser keeps the same subject. Memoised: one sign-in per page load.
let authPromise = null;

function ensureAuth() {
  if (client === null) return Promise.resolve(null);
  if (authPromise === null) authPromise = resolveSubject();
  return authPromise;
}

async function resolveSubject() {
  const { data: sessionData } = await client.auth.getSession();
  let user = sessionData.session?.user ?? null;

  if (user === null) {
    const { data, error } = await client.auth.signInAnonymously();
    if (error) {
      if (warnedNoAuth === false) {
        warnedNoAuth = true;
        console.warn(
          'Supabase anonymous sign-in failed; telemetry will be dropped. Enable ' +
            'Anonymous Sign-Ins in the Supabase dashboard (Authentication -> ' +
            'Sign In / Providers). ' +
            error.message
        );
      }
      authPromise = null; // let a later session retry the sign-in
      return null;
    }
    user = data.user;
  }

  // The trigger creates the profile in the same transaction as the auth user,
  // so it is normally present immediately; retry briefly against any lag.
  for (let attempt = 0; attempt < 3; attempt++) {
    const { data, error } = await client
      .from('profiles')
      .select('subject_id')
      .eq('user_id', user.id)
      .maybeSingle();

    if (error === null && data) return { userId: user.id, subjectId: data.subject_id };
    await new Promise((resolve) => setTimeout(resolve, 150));
  }

  console.warn('Supabase profile row not found for the signed-in user; telemetry dropped.');
  return null;
}

// Opens a session row and resolves to its id, or null when persistence is
// unavailable. Awaited by every segment, since each one references this id.
// subject_id is stamped here from the resolved profile so the RLS insert check
// (subject_id = current_subject_id()) passes; the RETURNING select is allowed by
// the sessions "select own" policy.
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

// Fire-and-forget. Awaits the session id, then inserts. segments has no select
// policy, so the insert must not chain .select() — requesting the row back would
// fail RLS even though the write itself is permitted.
export async function insertSegment(sessionIdPromise, payload) {
  if (client === null) return;

  const sessionId = await sessionIdPromise;
  if (sessionId === null) return;

  const { error } = await client.from('segments').insert({ ...payload, session_id: sessionId });

  if (error) console.warn('Segment insert failed:', error.message);
}
