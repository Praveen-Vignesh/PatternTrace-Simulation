-- Aim Trainer telemetry schema (v2 — multi-user).
-- Run this in the Supabase SQL editor (or psql) before starting a session.
--
-- Four tables:
--   subjects  — a pseudonymous person. Survives account deletion.
--   profiles  — the link between an auth.users account and a subject. Deleted
--               with the account, which is what anonymises the telemetry.
--   sessions  — one pointer-lock session: one routine, one difficulty, one
--               hardware configuration.
--   segments  — one span of play closing with an outcome. The unit the model
--               consumes.
--
-- The split exists because hardware and settings are session-scoped, not
-- segment-scoped. Storing dpi/sens/refresh on every segment row would both
-- bloat the table and permit a session whose rows disagree about the DPI.

-- ---------------------------------------------------------------------------
-- Legacy
-- ---------------------------------------------------------------------------
-- v1 rows carry no identity at all, so they cannot be attached to a subject and
-- must not be mixed into a multi-user training set. They are kept, renamed, and
-- ignored. Drop the table by hand once you no longer want them.

alter table if exists public.telemetry_logs rename to telemetry_logs_v1;

-- ---------------------------------------------------------------------------
-- subjects
-- ---------------------------------------------------------------------------
-- The stable identity every session hangs off. Deliberately NOT auth.users:
-- deleting an account removes the profiles row that maps a person to their
-- subject_id, leaving the telemetry intact but no longer attributable.
--
-- `kind` is the authoritative human/synthetic label, and it lives here rather
-- than on a segment because a client can lie about a row but cannot change its
-- own subject. Synthetic data (a bot driven in a real browser) is kept out of
-- the human set by running it under a subject provisioned with the service key
-- as kind='synthetic' (kind_source='provisioned'), never by trusting a per-row
-- boolean the client controls.

create table if not exists public.subjects (
  subject_id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  kind text not null default 'human' check (kind in ('human', 'synthetic')),
  -- Consent is stamped here, not only on profiles, so the record of it survives
  -- account deletion along with the data it authorises.
  consent_version text,
  consented_at timestamptz,

  -- Deduplication. One human can land on more than one subject — a second
  -- browser, cleared storage, a new device each mints a fresh auth user and so
  -- a fresh subject via the trigger below. Point the duplicates at the survivor
  -- here (never merge the rows: append-only), and the training view collapses
  -- them to one identity. NULL means "this row is itself canonical". Left unset
  -- the ML grouping key (subject_id) would leak the same person across a
  -- train/test split and silently inflate accuracy.
  merged_into uuid references public.subjects(subject_id),

  -- How `kind` was decided, so a synthetic subject provisioned by hand is
  -- distinguishable from one that merely defaulted. 'default' is the trigger's
  -- value; flip to 'provisioned' (or 'reviewed') with the service key when you
  -- deliberately set kind.
  kind_source text not null default 'default'
    constraint subjects_kind_source_check
    check (kind_source in ('default', 'provisioned', 'reviewed'))
);

-- Additive migration for databases created before these columns existed.
-- `create table if not exists` above is a no-op on an existing table, so the
-- columns have to be added explicitly for a re-run to upgrade in place.
alter table public.subjects
  add column if not exists merged_into uuid references public.subjects(subject_id);
alter table public.subjects
  add column if not exists kind_source text not null default 'default';
-- The check constraint is added separately so a re-run does not error if it is
-- already present (Postgres has no "add constraint if not exists").
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'subjects_kind_source_check'
  ) then
    alter table public.subjects
      add constraint subjects_kind_source_check
      check (kind_source in ('default', 'provisioned', 'reviewed'));
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- profiles
-- ---------------------------------------------------------------------------
-- One row per signed-in account. Created by a trigger on auth.users, never by
-- the client, so a user cannot attach themselves to somebody else's subject.

create table if not exists public.profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  subject_id uuid not null unique references public.subjects(subject_id),
  created_at timestamptz not null default now(),
  display_name text,
  consent_version text,
  consented_at timestamptz
);

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  new_subject uuid;
begin
  insert into public.subjects default values returning subject_id into new_subject;
  insert into public.profiles (user_id, subject_id) values (new.id, new_subject);
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- The subject of the caller. STABLE so Postgres evaluates it once per statement
-- rather than once per row; SECURITY DEFINER so the RLS policies below can read
-- profiles without granting the client select on it.
create or replace function public.current_subject_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select subject_id from public.profiles where user_id = auth.uid();
$$;

-- ---------------------------------------------------------------------------
-- sessions
-- ---------------------------------------------------------------------------
-- One pointer lock. A routine is built fresh per session (game.js start()), so
-- routine and difficulty are genuinely session-scoped and belong here.
--
-- The hardware block is not optional metadata. dx/dy are raw device counts, so
-- they are meaningless across users without dpi; frame cadence scales with
-- refresh_hz; event cadence scales with poll_hz. Without these three, a model
-- trained across users learns the hardware. cm_per_360 is the DPI-independent
-- ground truth and is stored rather than derived so a later change to
-- sensitivity.js cannot silently reinterpret old rows.

create table if not exists public.sessions (
  id uuid primary key default gen_random_uuid(),
  subject_id uuid not null references public.subjects(subject_id) on delete cascade,

  -- Server clock. Never client-supplied: a client-set timestamp is forgeable,
  -- and ordering matters for both fatigue effects and replay detection.
  started_at timestamptz not null default now(),
  -- SERVICE-WRITTEN, never by the client. The session row is inserted at
  -- game.start(), when the end is by definition unknown, and there is no update
  -- policy (append-only, by design), so the client cannot close it later. It is
  -- filled offline from started_at + the last segment's (started_at_ms +
  -- trajectory tail) — a server-anchored, monotonic figure, more trustworthy
  -- than a forgeable client wall-clock. Do NOT "fix" this with an update policy.
  ended_at timestamptz,

  routine text not null,
  difficulty text not null,
  -- The resolved difficulty.js entry for this session, so a later retune of
  -- ROUTINE_CONFIG does not retroactively mislabel what was actually played.
  routine_config jsonb,

  -- Sensitivity. See sensitivity.js — one value, two consumers.
  dpi int not null,
  sens double precision not null,
  cm_per_360 double precision,

  -- Rendering and input rates. refresh_hz is a rolling client estimate off the
  -- render loop. poll_hz is SERVICE-WRITTEN: the client leaves it null and it is
  -- derived offline from input_events inter-arrival gaps, which measure the true
  -- pointer polling rate more accurately than anything the page can sample.
  fov_deg double precision,
  refresh_hz double precision,
  poll_hz double precision,

  -- Hardware/browser fingerprint. Coarse on purpose: enough to hold out a
  -- device and check whether a biometric model generalises across hardware,
  -- not enough to be a tracking identifier of its own.
  device_fingerprint text,
  user_agent text,
  platform text,
  screen_width int,
  screen_height int,
  device_pixel_ratio double precision,

  -- LEGACY. The in-browser Bot Mode was removed, so the client no longer writes
  -- this and it is always null on new rows. Kept as a column so old rows still
  -- parse. Synthetic data is now produced only under a subject explicitly
  -- flagged kind='synthetic' (kind_source='provisioned'); the label lives on the
  -- subject, never on a client-controlled per-session field.
  bot_mode text,

  -- Stamp of the code that produced the session. Without it, a change to the
  -- sampler or to difficulty.js silently mixes incomparable rows into one set.
  app_version text not null default 'unknown',
  sampling_version int not null default 2
);

-- ---------------------------------------------------------------------------
-- segments
-- ---------------------------------------------------------------------------
-- One row is one segment, not one mesh. Destructible routines close a segment
-- on a click (hit/miss) or a timeout; tracking routines close one every
-- TRACK_WINDOW_MS (track) and once more on stop().
--
-- Both streams are stored COLUMNAR — parallel arrays keyed by field name, not
-- an array of per-sample objects. Roughly a third of the size (no repeated
-- keys) and it loads straight into numpy without a Python-level loop.
--
--   trajectory   {t, dx, dy, yaw, pitch, tx, ty, tz, on}  — one entry per
--                rendered frame. Carries the world state (target position,
--                crosshair-on-target), which only exists at render time.
--   input_events {t, dx, dy}                              — one entry per raw
--                pointer sample (getCoalescedEvents), at native polling rate.
--                Carries sub-frame timing, which render-cadence sampling
--                destroys. Nullable: a session may run without raw capture.
--
-- These are not interchangeable. trajectory without input_events loses the
-- biometric signal; input_events without trajectory loses tracking error.

create table if not exists public.segments (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.sessions(id) on delete cascade,

  -- Position within the session. Warmup, fatigue and any sequence model need
  -- ordering, and created_at cannot supply it: inserts are fire-and-forget and
  -- can land out of order.
  segment_index int not null,
  created_at timestamptz not null default now(),
  -- Milliseconds from session start to segment start, from the same
  -- performance.now() clock the frames use.
  started_at_ms int,

  outcome text not null check (outcome in ('hit', 'miss', 'timeout', 'track')),

  -- Engaged target distance at segment end. Null for a timeout — the target is
  -- already gone; the per-frame positions still carry it.
  target_distance double precision,

  -- Click segments only (hit/miss); null on timeout and track. dwell_ms may
  -- also be null on a hit or miss when the crosshair never registered contact
  -- before the click, which is why only one direction is enforced below.
  time_to_click_ms int,
  dwell_ms int,
  click_offset_x double precision,
  click_offset_y double precision,

  -- Board layout at segment start: [{x, y, z, r}].
  target_count int not null,
  targets jsonb not null,
  -- Index into `targets` of the engaged target — the one aimTarget() returned
  -- and the one tx/ty/tz tracks. Without it the engaged target is only
  -- recoverable by matching coordinates, which breaks once two targets overlap.
  engaged_index int,

  trajectory jsonb not null,
  input_events jsonb,

  -- The paths of the NON-engaged targets, per rendered frame, for a routine
  -- that holds several MOVING targets at once (switching). trajectory only
  -- carries the engaged target's tx/ty/tz, so without this the other targets'
  -- motion is unrecoverable — and "how far was the next target, did they switch
  -- to the nearest" is exactly the signal that routine exists to measure. NULL
  -- for single-target and static routines (flick, gridshot, spidershot,
  -- strafing), where `targets` at segment start already describes the board.
  -- Columnar and aligned to `targets`: {x: [[per-frame] per target], y, z}.
  board_trajectory jsonb,

  -- Lengths lifted out of the jsonb so segments can be filtered and sanity
  -- checked without parsing either blob.
  frame_count int not null,
  event_count int,
  -- Segment wall-time, lifted out of the trajectory's last `t` so "how long was
  -- this segment" is a column query, not a blob parse. This is a per-segment
  -- duration; whole-session end is derived offline (see sessions.ended_at).
  duration_ms int,

  constraint segments_session_order unique (session_id, segment_index),

  -- A non-click outcome can never carry click-derived fields. This is the
  -- constraint that stops a fabricated reaction time entering the training set.
  constraint segments_click_fields_match_outcome check (
    outcome in ('hit', 'miss')
    or (
      time_to_click_ms is null
      and dwell_ms is null
      and click_offset_x is null
      and click_offset_y is null
    )
  )
);

-- Additive migration for databases created before these columns existed.
alter table public.segments add column if not exists board_trajectory jsonb;
alter table public.segments add column if not exists duration_ms int;

-- ---------------------------------------------------------------------------
-- session_metrics
-- ---------------------------------------------------------------------------
-- Derived per-session aggregates for skill/weakness profiling: written offline
-- by the Python pipeline with the service key, read by the player. Regenerable,
-- so it is safe to recompute wholesale. The open `metrics` blob absorbs new
-- measures without a migration; promote one to a column when you want to index
-- or sort on it.

create table if not exists public.session_metrics (
  session_id uuid primary key references public.sessions(id) on delete cascade,
  computed_at timestamptz not null default now(),
  metrics_version int not null default 1,
  accuracy double precision,
  mean_time_to_click_ms double precision,
  mean_dwell_ms double precision,
  on_target_ratio double precision,
  metrics jsonb
);

-- ---------------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------------
-- The training pull is "every segment for these subjects, in order"; the app
-- reads "this subject's recent sessions".

create index if not exists sessions_subject_started_idx
  on public.sessions (subject_id, started_at desc);
create index if not exists sessions_routine_difficulty_idx
  on public.sessions (routine, difficulty);
create index if not exists segments_session_idx
  on public.segments (session_id, segment_index);
create index if not exists segments_outcome_idx
  on public.segments (outcome);
create index if not exists subjects_kind_idx
  on public.subjects (kind);
-- Resolving a subject to its canonical identity in the training view, and
-- listing everything merged into a survivor.
create index if not exists subjects_merged_into_idx
  on public.subjects (merged_into);

-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------
-- Append-only for the client. There is no update or delete policy anywhere: a
-- behavioural reference set an account holder can rewrite is not a reference
-- set. Corrections are made with the service key.
--
-- anon has no privileges at all — inserting requires a signed-in user whose
-- subject the row already belongs to.

alter table public.subjects        enable row level security;
alter table public.profiles        enable row level security;
alter table public.sessions        enable row level security;
alter table public.segments        enable row level security;
alter table public.session_metrics enable row level security;

revoke all on public.telemetry_logs_v1 from anon;

-- subjects: no client policy of any kind. `kind` in particular must stay
-- unwritable, or a synthetic run could relabel itself human.

-- profiles: a user may read their own row (display name, consent state) and
-- update the two consent columns. The subject link is not writable.
drop policy if exists "profiles select own" on public.profiles;
create policy "profiles select own"
  on public.profiles for select to authenticated
  using (user_id = auth.uid());

drop policy if exists "profiles update own" on public.profiles;
create policy "profiles update own"
  on public.profiles for update to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid() and subject_id = public.current_subject_id());

-- sessions: insert and read your own.
drop policy if exists "sessions insert own" on public.sessions;
create policy "sessions insert own"
  on public.sessions for insert to authenticated
  with check (subject_id = public.current_subject_id());

drop policy if exists "sessions select own" on public.sessions;
create policy "sessions select own"
  on public.sessions for select to authenticated
  using (subject_id = public.current_subject_id());

-- segments: insert into your own session only. Deliberately NO select policy —
-- trajectory and input_events are the raw material of the biometric template,
-- and a compromised account should not be able to download its own reference
-- data to replay it. Aggregates reach the player through session_metrics.
drop policy if exists "segments insert own" on public.segments;
create policy "segments insert own"
  on public.segments for insert to authenticated
  with check (
    exists (
      select 1 from public.sessions s
      where s.id = session_id
        and s.subject_id = public.current_subject_id()
    )
  );

-- session_metrics: read your own. Writes are service-key only.
drop policy if exists "session metrics select own" on public.session_metrics;
create policy "session metrics select own"
  on public.session_metrics for select to authenticated
  using (
    exists (
      select 1 from public.sessions s
      where s.id = session_id
        and s.subject_id = public.current_subject_id()
    )
  );

-- ---------------------------------------------------------------------------
-- Training view
-- ---------------------------------------------------------------------------
-- What fetch_telemetry.py should select, so the pipeline never has to join by
-- hand or re-derive the label. `is_human` comes from subjects.kind, which the
-- client cannot write — unlike the v1 per-row boolean, which it could.
-- Service-key reads bypass RLS, so this stays invisible to the browser.
--
-- security_invoker so the view runs with the caller's privileges, not the
-- owner's. The real protection is the revoke below (only the service key, which
-- bypasses RLS, can read it); security_invoker removes the footgun where a
-- single future GRANT would otherwise expose every subject's trajectories
-- through an owner-privileged view.
--
-- subject_id is the CANONICAL identity: merged duplicates collapse onto their
-- survivor via merged_into, so this is the correct grouping key for a
-- train/test split. raw_subject_id keeps the un-collapsed value for auditing a
-- merge. Collapsing here means a later merge is a single UPDATE with zero
-- pipeline changes.
--
-- Dropped and recreated rather than CREATE OR REPLACE: replace can only append
-- columns to the end of an existing view, and this revision inserts
-- raw_subject_id mid-list, which replace rejects as a rename. The view holds no
-- data, so dropping it is free.

drop view if exists public.v_training_segments;

create view public.v_training_segments
with (security_invoker = true) as
select
  g.id                              as segment_id,
  s.id                              as session_id,
  coalesce(sub.merged_into, sub.subject_id) as subject_id,
  sub.subject_id                    as raw_subject_id,
  sub.kind = 'human'  as is_human,
  sub.kind            as subject_kind,
  s.routine,
  s.difficulty,
  s.routine_config,
  s.dpi,
  s.sens,
  s.cm_per_360,
  s.fov_deg,
  s.refresh_hz,
  s.poll_hz,
  s.device_fingerprint,
  s.app_version,
  s.sampling_version,
  s.started_at        as session_started_at,
  g.segment_index,
  g.started_at_ms,
  g.outcome,
  g.target_distance,
  g.time_to_click_ms,
  g.dwell_ms,
  g.click_offset_x,
  g.click_offset_y,
  g.target_count,
  g.targets,
  g.engaged_index,
  g.trajectory,
  g.input_events,
  g.board_trajectory,
  g.frame_count,
  g.event_count,
  g.duration_ms
from public.segments g
join public.sessions s   on s.id = g.session_id
join public.subjects sub on sub.subject_id = s.subject_id;

revoke all on public.v_training_segments from anon, authenticated;
