// Durable, batched, idempotent delivery of segment rows to Supabase.
//
// The old path inserted each segment fire-and-forget and logged a warning on
// failure — so a network blip or a tab closed mid-session silently dropped the
// play it had just recorded. Since the whole project exists to collect that
// data, the loss is the bug. Three properties make delivery safe here:
//
//   - Idempotent. A batch is delivered as a plain INSERT, and the unique
//     (session_id, segment_index) turns a re-sent row into a 23505, which is
//     read as "already delivered" rather than as a failure. An upsert would be
//     the obvious way to say this, but PostgREST enters its upsert path on the
//     Prefer: resolution=... header alone, and that path needs SELECT/UPDATE
//     policies `segments` deliberately withholds — both resolutions are refused
//     with 42501 while the identical plain INSERT succeeds. A partially
//     delivered batch can therefore still be retried whole.
//   - Persistent. The pending queue is mirrored to IndexedDB, which is async and
//     off the main thread — unlike localStorage, whose synchronous write would
//     hitch the render loop that the timing features are measured from. A reload
//     replays whatever had not been acknowledged.
//   - Flushed on exit. flushKeepalive() sends the last batch with a keepalive
//     fetch, which an unloading page is still allowed to complete.
//
// The senders and the store are injected so the module runs headlessly in a
// Node harness with plain stubs.

// Exponential backoff between failed flush attempts, capped. Reset on success.
const INITIAL_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 30000;
// Rows accumulate for this long before a flush, so a burst of segments becomes
// one request instead of one request each. A full batch flushes immediately.
const FLUSH_DEBOUNCE_MS = 400;
const DEFAULT_BATCH_SIZE = 25;

function keyOf(row) {
  return `${row.session_id}:${row.segment_index}`;
}

// SQLSTATE classes a retry can never fix: 22 (data exception), 23 (integrity
// constraint violation) and 42 (access rule violation — an RLS rejection lands
// here as 42501). A queued row's payload is frozen, so re-sending it reproduces
// the identical rejection forever while blocking every row behind it. Anything
// else — a dropped connection with no code at all, a 5xx, an expired JWT
// (PGRST301) — is transient and keeps its backoff-and-retry.
const PERMANENT_SQLSTATE = /^(22|23|42)\d/;

function isPermanent(error) {
  return typeof error?.code === 'string' && PERMANENT_SQLSTATE.test(error.code);
}

// unique_violation on (session_id, segment_index): this row already landed on an
// earlier attempt. It is inside the permanent class above, but it means the
// opposite of the rest of that class — delivery succeeded, just not on this
// request — so it settles the row instead of discarding it. This is what keeps
// a retried batch idempotent now that delivery is a plain INSERT.
const DUPLICATE_SQLSTATE = '23505';

function isDuplicate(error) {
  return error?.code === DUPLICATE_SQLSTATE;
}

// IndexedDB-backed store. Returns null if IndexedDB is unavailable or errors on
// open, so the outbox degrades to memory-only rather than breaking play — the
// same posture settings.js takes with localStorage.
export function createIdbStore(dbName = 'aim-trainer-outbox', storeName = 'segments') {
  if (typeof indexedDB === 'undefined') return null;

  let dbPromise = null;

  function open() {
    if (dbPromise !== null) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(dbName, 1);
      request.onupgradeneeded = () => {
        if (request.result.objectStoreNames.contains(storeName) === false) {
          request.result.createObjectStore(storeName);
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    return dbPromise;
  }

  function run(mode, fn) {
    return open().then(
      (db) =>
        new Promise((resolve, reject) => {
          const transaction = db.transaction(storeName, mode);
          const store = transaction.objectStore(storeName);
          const outcome = fn(store);
          transaction.oncomplete = () => resolve(outcome());
          transaction.onerror = () => reject(transaction.error);
          transaction.onabort = () => reject(transaction.error);
        })
    );
  }

  return {
    put(key, row) {
      return run('readwrite', (store) => {
        store.put(row, key);
        return () => undefined;
      });
    },

    delete(keys) {
      return run('readwrite', (store) => {
        for (const key of keys) store.delete(key);
        return () => undefined;
      });
    },

    loadAll() {
      return run('readonly', (store) => {
        const keysRequest = store.getAllKeys();
        const valuesRequest = store.getAll();
        return () => {
          const keys = keysRequest.result;
          const values = valuesRequest.result;
          const entries = [];
          for (let i = 0; i < keys.length; i++) {
            entries.push({ key: keys[i], row: values[i] });
          }
          return entries;
        };
      });
    }
  };
}

// send(rows)         -> Promise, resolves on success, rejects to trigger retry.
// sendKeepalive(rows)-> best-effort synchronous send for page unload (optional).
// store              -> { put, delete, loadAll } persistence (optional).
export function createOutbox({
  send,
  sendKeepalive = null,
  store = null,
  batchSize = DEFAULT_BATCH_SIZE,
  onError = () => {},
  onDrop = () => {}
}) {
  const pending = new Map();
  let flushing = false;
  let backoffMs = INITIAL_BACKOFF_MS;
  let flushTimer = null;
  let retryTimer = null;

  function persistPut(key, row) {
    if (store === null) return;
    Promise.resolve(store.put(key, row)).catch(() => {});
  }

  function persistDelete(keys) {
    if (store === null || keys.length === 0) return;
    Promise.resolve(store.delete(keys)).catch(() => {});
  }

  function scheduleFlush() {
    if (pending.size >= batchSize) {
      flush();
      return;
    }
    if (flushTimer !== null || typeof setTimeout === 'undefined') return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      flush();
    }, FLUSH_DEBOUNCE_MS);
  }

  function scheduleRetry() {
    if (typeof setTimeout === 'undefined') return;
    if (retryTimer !== null) clearTimeout(retryTimer);
    retryTimer = setTimeout(() => {
      retryTimer = null;
      flush();
    }, backoffMs);
    backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
  }

  // Drains the queue in batches. A TRANSIENT failure stops the drain and
  // schedules a backed-off retry, leaving the rest (and the failed one) in
  // `pending` and in the store so nothing is lost.
  //
  // A PERMANENT rejection cannot be waited out, so it gets the opposite
  // treatment: the batch is re-sent one row at a time to find which rows are
  // actually bad, and those are dropped. Without this, one undeliverable row —
  // in practice a segment whose session belongs to a subject that is no longer
  // signed in, replayed from IndexedDB at the head of the queue — blocks every
  // row behind it for the life of the browser profile, retrying forever and
  // landing nothing.
  async function flush() {
    if (flushing || pending.size === 0) return;
    flushing = true;
    // Isolation persists for the rest of this drain: bad rows arrive in runs
    // (one orphaned session's segments are contiguous), so returning to full
    // batches after each drop would re-fail a whole batch once per bad row.
    let isolating = false;

    try {
      while (pending.size > 0) {
        const limit = isolating ? 1 : batchSize;
        const keys = [];
        const rows = [];
        for (const [key, row] of pending) {
          keys.push(key);
          rows.push(row);
          if (rows.length >= limit) break;
        }

        try {
          await send(rows);
        } catch (error) {
          if (isPermanent(error) === false) {
            onError(error);
            scheduleRetry();
            return;
          }
          if (rows.length > 1) {
            isolating = true;
            continue;
          }
          // Alone and still rejected. A unique violation means the row is
          // already in the table, which is delivery, not loss. Anything else is
          // genuinely undeliverable, and discarding it is the only way the rows
          // behind it can ever move.
          if (isDuplicate(error) === false) onDrop(rows[0], error);
        }

        for (const key of keys) pending.delete(key);
        persistDelete(keys);
        backoffMs = INITIAL_BACKOFF_MS;
      }
    } finally {
      flushing = false;
    }
  }

  return {
    // Queue one already-assembled segment row (session_id resolved). Callers
    // must not enqueue rows without a session_id — there would be no valid row
    // to insert and no way to replay it.
    enqueue(row) {
      if (row === null || row === undefined || row.session_id === null) return;
      const key = keyOf(row);
      pending.set(key, row);
      persistPut(key, row);
      scheduleFlush();
    },

    // Rehydrate anything a previous page load left unacknowledged, then flush.
    async init() {
      if (store === null) return;
      let entries = [];
      try {
        entries = await store.loadAll();
      } catch {
        return;
      }
      for (const { key, row } of entries) {
        if (pending.has(key) === false) pending.set(key, row);
      }
      if (pending.size > 0) flush();
    },

    flush,

    // Best-effort synchronous send on page unload. Uses the keepalive sender if
    // one was injected; the rows stay in the store either way, so a reload
    // replays them if the beacon does not make it.
    flushKeepalive() {
      if (pending.size === 0 || sendKeepalive === null) return;
      const rows = Array.from(pending.values());
      try {
        sendKeepalive(rows);
      } catch {
        // Rows remain persisted; next load retries them.
      }
    },

    size() {
      return pending.size;
    }
  };
}
