# TODO — deferred database work

Deferred from the multi-user readiness audit (2026-09-23). The rest of that audit's
findings are already applied to `schema.sql`; what follows is what was consciously **not**
done. Each item is written to be executable as-is.

---

## 1. Orphan repair — stranded `auth.users` rows

**Status:** deferred by request. **Risk if skipped:** silent, permanent, total data loss
for affected accounts.

### Why it exists

Re-running `schema.sql` drops and recreates the `on_auth_user_created` trigger. A signup
landing between those two statements gets an `auth.users` row with **no `subjects` row and
no `profiles` row**. From then on `ensureAuth()` in `src/supabase.js` resolves a null
`subject_id`, and every session and segment that account ever produces is discarded
client-side before it reaches the network — no error, no console warning, no retry, and
nothing in `schema.sql` repairs it. The file's header (lines 8-18) documents the hazard and
supplies a detection query, but explicitly states "Nothing in this file repairs such a
user."

### Detection

```sql
select u.id, u.email, u.created_at
  from auth.users u
  left join public.profiles p on p.user_id = u.id
 where p.user_id is null;   -- expect zero rows
```

### The repair

Place **after** the `create trigger on_auth_user_created` statement and **before** the RLS
section. Idempotent — a run with no orphans is a no-op. Mirrors `handle_new_user()` exactly,
so repaired users land at the same default-deny `kind='unknown'`, `kind_source='default'`.

```sql
-- Repair any auth.users row that has no profile — see the header note about the
-- drop/create trigger window. Idempotent; safe to leave in the file permanently.
do $$
declare
  orphan record;
  new_subject uuid;
begin
  for orphan in
    select u.id from auth.users u
      left join public.profiles p on p.user_id = u.id
     where p.user_id is null
  loop
    insert into public.subjects default values returning subject_id into new_subject;
    insert into public.profiles (user_id, subject_id) values (orphan.id, new_subject);
  end loop;
end $$;
```

**Until this lands,** run the detection query by hand after every `schema.sql` execution,
and prefer a genuinely low-traffic moment: the trigger drop holds `ACCESS EXCLUSIVE` on
`auth.users`, so signups block (they do not fail) for the duration of the run.

---

## 2. BRIN index on `segments.created_at`

**Status:** deferred by request. **Blocks:** incremental training pulls and any retention
policy.

### Why it exists

Nothing currently indexes `created_at`, so two things are impossible without a full table
scan:

- **Incremental pull** — "every segment since the last fetch", which is the only way the
  training pull scales past a few million rows.
- **Age-based deletion** — the mechanism any retention policy needs.

BRIN rather than btree specifically: the table is append-only and `created_at` is therefore
perfectly correlated with physical row order, which is exactly the case BRIN is built for.
It costs a few KB instead of hundreds of MB, and adds near-zero insert cost. A btree here
would instead create another hot right-edge page contended by every concurrent writer —
the same problem that got `segments_outcome_idx` dropped.

```sql
create index if not exists segments_created_at_brin
  on public.segments using brin (created_at);
```

Place in the Indexes section of `schema.sql`.

---

## 3. Open question — `profiles.display_name`

Always NULL. Nothing writes it: `handle_new_user()` inserts only `(user_id, subject_id)`,
no UI collects it, and `UPDATE` on it is revoked from `authenticated` (the grant permits
only `consent_version`/`consented_at`). Nothing reads it either.

Either drop it or leave it as a deliberate placeholder — but decide, rather than letting it
sit as an unexplained always-empty column. Dropping is irreversible:

```sql
alter table public.profiles drop column display_name;
```

---

## 4. Not deferred — genuinely out of scope, needs a decision

These are the actual multi-user blockers. They are **not** fixable in `schema.sql` alone
and were excluded from the audit's agreed scope.

### 4a. Storage growth (the real blocker)

One 10-minute session writes **~9.6 MB**. At 50 users × 3 sessions/week that is
**~6.2 GB/month**: Supabase Free (500 MB) exhausts in ~2.4 days, Pro (8 GB) in ~5.5 weeks.
Nothing deletes, archives or partitions anything.

Two levers, both outside `schema.sql`:

- **Shrink the payload.** `input_events` is ~55% of every row and inflates ~4.5× in jsonb.
  `INPUT_TIME_PRECISION` (`src/telemetry.js:26`) is `1e2` — 0.01 ms resolution for a poll
  interval of ~1 ms. Dropping to `1e1` keeps 0.1 ms and roughly halves the largest stream.
  Delta-encoding `t` would save more.
- **Bound the lifetime.** Partition `segments` monthly and set a retention window, with
  cold data archived to parquet (the pipeline already emits parquet by design). Cheap while
  the table is near-empty; a full rewrite under `ACCESS EXCLUSIVE` once it is multi-GB.

**Partitioning has a trap.** A partitioned table requires the partition key in every unique
constraint, so `segments_session_order` would become
`(session_id, segment_index, created_at)` — and `created_at` defaults to `now()`, so a
**retried row would get a fresh timestamp and insert as a duplicate instead of raising
23505**. That silently destroys the outbox's whole idempotency contract
(`src/outbox.js:50-59`). Partition on a value that is deterministic per row — e.g. a
`session_started_at` copied from `sessions` by a BEFORE INSERT trigger — never on `now()`.

### 4b. A failed session insert discards the entire session

`src/supabase.js:435-438` logs a warning and returns `null` when the `sessions` insert
fails. `sessionIdPromise` then resolves null, and `insertSegment` (`:449-451`) returns
**before enqueuing** — so segments never reach the outbox, never reach IndexedDB, and are
never retried. The outbox makes segments durable but leaves the session row they depend on
fire-and-forget, and it fires at the start of play, which is exactly when many users would
contend. One transient 5xx costs a full ~9.6 MB participant-session for one `console.warn`.

`segmentIndex` also increments for discarded rows (`src/game.js:209`), so intermittent
failures leave permanent gaps in the sequence.

### 4c. No visibility into any of the above

Every failure path reports to `console.warn` in the user's own browser. There is no
server-side error record, no ingest-rate check, no database-size alert, no outbox-depth
metric. **Data loss is currently invisible by construction** — which matters more than
usual here, because the telemetry is the deliverable and cannot be regenerated.

### 4d. Other findings worth scheduling

- **`segments.id` is a random UUIDv4** — scatters every insert to a random index leaf page.
  At ~7M rows the two random-UUID btrees (~650 MB) will not fit in cache on a small
  instance, making each insert a random read plus a page split. UUIDv7 restores insert
  locality at no API cost.
- **Effective batch size is ~1 row, not 25.** Tracking emits one segment per second and
  `FLUSH_DEBOUNCE_MS` is 400 (`src/outbox.js:31`), so the debounce fires with a single row —
  ~600 HTTP POSTs per session. Raising it to 2000-5000 ms cuts request count 5-12× with no
  added risk, since IndexedDB persistence and the keepalive flush already cover the window.
- **The training pull cannot use an index.** `where is_human is not null` filters a `CASE`
  expression in the view, which is non-sargable, and Postgres falls back to a 0.5 default
  selectivity — so it plans a full scan of `segments` plus the entire TOAST table. Filter on
  `subject_kind in ('human','synthetic')` instead, which is sargable.
- **Planned offset pagination is unsafe.** The view has no `ORDER BY`, so `LIMIT/OFFSET`
  paging will both duplicate and skip rows, and is O(n²) besides. Needs keyset pagination
  ordered by `(created_at, id)`, which depends on item 2 above.
