# Incident: segments never reached Supabase while sessions did

What broke, why it looked the way it did, how it was found, and exactly what changed.
Written to be handed to an agent or a future reader with no other context — every claim
below was verified against a running database, not inferred from the schema alone.

Authoritative sources: [`src/outbox.js`](src/outbox.js) (delivery + retry policy),
[`src/supabase.js`](src/supabase.js) (the network calls and auth), [`schema.sql`](schema.sql)
(RLS policies), [`CLAUDE.md`](CLAUDE.md) (current architecture — the "Supabase" section
reflects the fixed state).

---

## 1. The symptom

The browser console filled with a repeating pair, once per retry cycle:

```
Failed to load resource: the server responded with a status of 403 ()
Segment batch delivery failed, will retry: new row violates row-level security policy
for table "segments"
```

`sessions` rows landed normally. `segments` rows never did — not one, from any account, on
any machine. The queue only grew.

## 2. Root cause

**PostgREST enters its upsert code path the moment a `Prefer: resolution=...` header is
present on the request — regardless of what the `on_conflict` query parameter says, and
even when `on_conflict` is absent entirely.** That upsert path requires the target row to be
selectable and updatable under RLS, because internally it has to determine whether a
matching row exists (`SELECT`) before deciding whether to skip or merge it (`UPDATE`).

`segments` grants neither, on purpose:

```sql
-- segments has no select policy at all — trajectories are the raw material of a
-- biometric template, and an account should not be able to download its own reference
-- data to replay it.
```

The client's delivery code, before this fix, sent every batch as:

```js
await client
  .from('segments')
  .upsert(rows, { onConflict: 'session_id,segment_index', ignoreDuplicates: true });
```

`ignoreDuplicates: true` is `ON CONFLICT DO NOTHING` at the SQL level — which genuinely
needs no `UPDATE` privilege — but supabase-js implements it by adding
`Prefer: resolution=ignore-duplicates` to the request. That header alone is what routes the
request into PostgREST's upsert handling before the `DO NOTHING` semantics ever get applied.
The row-level security engine checks table-level readability for the upsert path first, sees
no `SELECT` policy, and refuses the whole request with `42501` — **before it matters that the
actual conflict resolution would have needed no update rights at all.**

The `sessions` table has both `INSERT` and `SELECT` policies, which is why plain
`insertSession()` calls worked while every segment batch failed identically, for every
subject, on every machine, from the first row ever attempted.

### The failed hypotheses, and why they were tested first

The 403 body — `new row violates row-level security policy for table "segments"` — is
consistent with several different causes, and each was eliminated with a live probe before
the real one was found. This record exists so the same order of elimination is not repeated:

1. **Poison rows from a stale account.** Segments queued under a subject that was no longer
   signed in (confirmed real via IndexedDB inspection — see §4) were retried forever and sat
   at the head of the queue. This was real and worth fixing on its own (§3.2), but purging
   the poison rows did not fix delivery — the very next legitimate row failed the same way.
2. **A duplicate `auth.users` row from linking Google OAuth to an existing email/password
   account.** Also real (confirmed in `auth.users`), also worth knowing about, and also not
   the cause — a completely fresh database, fresh account, and a second person on a different
   PC and network hit the identical 403.
3. **The live policy not matching `schema.sql`.** Directly queried and confirmed identical
   to the file's `with_check` expression. Ruled out.
4. **Stale grants.** Queried `information_schema.role_table_grants` — the stock Supabase
   defaults, all standard, RLS the only real gate. Ruled out.

None of these were wrong to check — RLS-shaped errors are genuinely ambiguous from the
message alone. What finally isolated it was comparing the exact same row sent two ways.

## 3. Two bugs, not one

### 3.1 The real bug: upsert vs. append-only RLS (this section)

Confirmed by hand-posting the identical row shape to `/rest/v1/segments` with and without
an upsert `Prefer` header, using the browser's own JWT:

| # | Request | `on_conflict` param | `Prefer: resolution=...` | Result |
|---|---|---|---|---|
| 1 | plain object, single insert | absent | absent | **201** |
| 2 | array, single insert | absent | absent | **201** |
| 3 | array, upsert | present | `ignore-duplicates` | **403** (`42501`) |
| 4 | array, upsert | present | *absent* | **201** |
| 5 | array, upsert | present | `merge-duplicates` | **403** (`42501`) |
| 6 | array, upsert | *absent* | `ignore-duplicates` | **403** (`42501`) |

Rows 4 and 6 are the isolating pair. The `on_conflict` query parameter, on its own, changes
nothing (row 4 is a plain insert with an inert parameter attached — still `201`). The
`Prefer: resolution=...` header, on its own, is what flips the request into the refused
upsert path (row 6 fails with no `on_conflict` present at all). Rows 3 and 5 confirm both
resolution modes fail identically, so there is no variant of upsert that this policy shape
permits.

Row 7 of the same probe re-sent an already-landed plain insert and got back:

```json
{"code":"23505","message":"duplicate key value violates unique constraint \"segments_session_order\""}
```

That is the fix's other half: idempotency does not require upsert. The table's own unique
constraint on `(session_id, segment_index)` already turns a redelivered row into a
`23505`, which is a **normal, expected** outcome of a retried batch, not a failure —
so the client can treat it as one.

### 3.2 The amplifier: permanent failures retried forever, and blocked everything behind them

Independent of §3.1, `outbox.js`'s drain loop treated every failure the same way:

```js
try {
  await send(rows);
} catch (error) {
  onError(error);
  scheduleRetry();
  return; // <- exits the whole drain, leaving every row behind this batch untouched
}
```

An `RLS` rejection is not transient — resending the identical row reproduces the identical
rejection forever. But the loop couldn't tell that apart from a dropped connection, so it
backed off and retried indefinitely, and `return` meant **the first failing batch blocked
every row queued after it**, including rows from sessions that would have inserted
successfully on their own.

This is what turned a clean, deterministic server-side rejection into the visible symptom: a
console that never stopped repeating, and 390 stuck rows in one observed case, of which only
a handful were actually the ones causing the failure — the rest were healthy rows trapped
behind them. Confirmed directly: a diagnostic script read the browser's own queued
IndexedDB rows, took the JWT `supabase-js` had persisted, and asked the server (via
`sessions`, which does have a `SELECT` policy) which of the queued rows' parent sessions the
signed-in account still owned. One session, out of two present in the queue, was not owned
by the current subject — orphaned by an earlier account switch — and its rows sat at the
head of the queue, blocking a second, perfectly healthy session's rows behind them
indefinitely.

## 4. How each hypothesis was actually tested

No fix was written until each of the following returned a real result:

- **Live policy dump.** Queried `pg_policies` directly for `segments` and `sessions`
  side by side (`policyname`, `cmd`, `roles`, `with_check`, `qual`) — confirmed the insert
  policy exists, targets `authenticated`, and its `with_check` text is what `schema.sql`
  declares.
- **IndexedDB inspection.** A pasted browser script opened the `aim-trainer-outbox`
  database, read every pending row's key (`session_id:segment_index`), and cross-referenced
  the distinct `session_id`s against `GET /rest/v1/sessions` (which *does* carry a `SELECT`
  policy) using the same JWT `supabase-js` had stored. This is what separated "rows pointing
  at a session you own" from "rows pointing at a session you don't" without ever needing a
  `SELECT` policy on `segments` itself.
- **Direct REST probe, bypassing the app entirely.** Six hand-built POSTs (the table in
  §3.1) isolated the header, not the query parameter, as the trigger — and a seventh POST
  confirmed the replacement idempotency mechanism (`23505`) before it was relied on.
- **A deployed-bundle check, when the fix appeared not to work.** The failing request URL
  still carried `?on_conflict=...` after the source no longer produced it anywhere, and the
  loaded script's hash (`index-ChXJRJNR.js`) matched the pre-fix build, not the one just
  built locally (`index-OORj3jHP.js`). The fix had not actually shipped — the working tree's
  changes were never committed, so Vercel kept serving the old bundle. This is recorded
  because it is a distinct, unglamorous failure mode worth ruling out early next time: before
  re-diagnosing a fix that "isn't working," confirm which bundle is actually loaded.

## 5. The fix

### `src/supabase.js` — plain `insert`, never `upsert`

```js
async function sendSegments(rows) {
  const { error } = await client.from('segments').insert(rows);

  if (error) {
    // The SQLSTATE is what tells the outbox whether a retry can ever succeed: an
    // RLS rejection (42501) is permanent, a dropped connection is not.
    const failure = new Error(error.message);
    failure.code = error.code;
    failure.details = error.details;
    throw failure;
  }
}
```

Two more places carried the same upsert shape and were changed identically: the keepalive
`fetch()` used on `pagehide` (dropped `?on_conflict=` from the URL and
`resolution=ignore-duplicates` from its `Prefer` header), and the error path, which
previously discarded `error.code`/`error.details` down to a bare `Error(message)` — that
alone made it impossible for `outbox.js` to ever distinguish a permanent failure from a
transient one.

### `src/outbox.js` — classify failures by SQLSTATE; isolate and drop only the genuinely bad rows

```js
// 22 = data exception, 23 = integrity constraint violation, 42 = access rule violation
// (RLS lands here as 42501). A queued row's payload is frozen, so re-sending it reproduces
// the identical rejection forever while blocking every row behind it. Anything else — no
// code at all, a 5xx, an expired JWT (PGRST301) — is transient and keeps its retry.
const PERMANENT_SQLSTATE = /^(22|23|42)\d/;

// unique_violation on (session_id, segment_index): this row already landed on an earlier
// attempt. It means the opposite of the rest of the permanent class — delivery succeeded,
// just not on this request — so it settles the row instead of discarding it.
const DUPLICATE_SQLSTATE = '23505';
```

The drain loop now branches on that classification. A transient failure keeps the original
behaviour exactly — stop, back off, retry the whole batch later. A permanent failure re-sends
the same batch **one row at a time** to find out which specific row is bad, so one poison row
can no longer take a batch of healthy ones down with it; each row that fails alone is either
settled (if the failure is `23505`, i.e. already delivered) or dropped and reported via a new
`onDrop(row, error)` callback (anything else in the permanent class — e.g. a session that
belongs to a subject no longer signed in).

### `src/main.js` + `src/supabase.js` — a third, related gap found while re-testing: `validateSession()`

While intentionally wiping test accounts to confirm the fix from a cold start, deleting every
row from `auth.users` did **not** sign the app out — it kept rendering "Signed in as
[email]" and silently dropped every session and segment from that point on, because
`ensureAuth()` could resolve no `profiles` row for the (now nonexistent) user and returned
`null`. This is the same failure shape as the main incident — the app looks like it's
working while writing nothing — caused by a different mechanism: `supabase-js` restores a
persisted session from `localStorage` and fires `INITIAL_SESSION` **without asking the server
whether that session is still valid**. A signed, unexpired JWT for a deleted account is
therefore trusted at face value.

```js
export async function validateSession() {
  if (client === null) return;

  const { data } = await client.auth.getSession(); // local only, no network call
  if (data.session === null) return;

  const { error } = await client.auth.getUser();    // forces a round-trip to the server
  if (error === null || error === undefined) return;
  if (error.status !== 401 && error.status !== 403) return; // network/5xx: leave it alone

  console.warn('Stored session is no longer valid; signing out:', error.message);
  await client.auth.signOut({ scope: 'local' }); // local: the server session is already gone
}
```

Called once at boot from `main.js`, before `initTelemetryOutbox()`. A `401`/`403` from
`getUser()` is a definitive "this account is gone or this token is revoked" and triggers a
local-only sign-out, which flows back through the existing `onAuthChange` listener and
re-renders the account panel with no new UI code. Anything else — no network, a `5xx`, a rate
limit — is deliberately left alone, on the same reasoning as §3.2: a transient failure must
never be treated as a permanent one, or a dropped wifi connection would silently sign out a
perfectly valid session.

## 6. Verification

**Headless, before any browser was touched:**

- A regression harness reproduced the exact failure shape: one row whose delivery always
  throws an RLS-shaped error (`code: '42501'`), enqueued ahead of five healthy rows. Against
  the pre-fix drain loop: **0 delivered, 6 stuck** — matching the production symptom
  precisely. Against the fixed loop: **5 delivered, 1 dropped, queue empty**.
- A ten-case behavioural suite covering the properties the outbox is documented to guarantee,
  run against the fixed code: batching a burst into few requests, a transient failure
  retrying without dropping anything, dedupe by `(session_id, segment_index)`, a permanent
  failure dropping only the actually-bad rows, `23xxx` integrity violations classified as
  permanent, IndexedDB replay on `init()` with store cleanup on success, the keepalive path
  sending everything pending, rows with no `session_id` never being queued, a `23505` settling
  as delivered rather than being dropped, and a partly-delivered batch retried whole landing
  every row exactly once. All ten passed.
- A separate nine-case table exercised `validateSession()`'s decision logic in isolation
  against a stubbed auth client: no persisted session, a healthy session, a deleted user
  (`403`), a revoked token (`401`), a network failure, a `500`, and a `429` — confirming the
  sign-out fires only for the two definitive-rejection cases and that `signOut` is always
  called with `{ scope: 'local' }`. All nine passed.
- `npm run build` succeeded after every change; the bundle was also grepped afterward to
  confirm no `on_conflict` or `resolution=` string remained anywhere outside
  `@supabase/supabase-js`'s own library code.

**Live, confirmed in the browser against the deployed build:**

- The direct REST probe in §3.1/§4, run from the actual signed-in session.
- After the poison rows were purged (a script deleting only the IndexedDB keys prefixed with
  the orphaned `session_id`, leaving the healthy session's rows untouched) and the corrected
  bundle was actually deployed: the remaining queued rows delivered successfully with no
  further console errors.
- After a full database wipe and a brand-new account: sessions and segments both populate
  from a cold start, with the `validateSession()` fix additionally confirmed to catch and
  correct a stale "signed in" state left over from deleting `auth.users` out from under an
  open tab.

## 7. What to watch for next time

- **An RLS-shaped 403 does not mean the policy is wrong.** It can equally mean the *request
  shape* — specifically any `Prefer: resolution=...` header — routed the call through a
  code path (upsert) that needs privileges the table intentionally does not grant. Test the
  same row both ways before touching the policy.
- **`ON CONFLICT DO NOTHING` at the SQL level and `ignoreDuplicates` in supabase-js are not
  the same privilege story.** The former genuinely needs no `UPDATE` right; the latter is
  implemented via a header that engages RLS's upsert-path privilege check regardless.
- **Before re-diagnosing a fix that "isn't working," confirm which bundle is actually
  live** — compare the hashed filename the browser loaded against what a fresh local build
  produces, or check whether the working tree was ever committed and deployed at all.
- **A persisted client-side session is not proof the account still exists.** Anything that
  can delete or revoke a user out from under a running tab needs a server round-trip
  (`getUser()`, not `getSession()`) to be noticed — and that round-trip must fail closed
  only on a definitive rejection, never on a network hiccup, using the identical
  permanent-vs-transient reasoning as the outbox's own retry classification.
