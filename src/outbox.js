// Durable, batched, idempotent delivery of segment rows to Supabase.
//
// The old path inserted each segment fire-and-forget and logged a warning on
// failure — so a network blip or a tab closed mid-session silently dropped the
// play it had just recorded. Since the whole project exists to collect that
// data, the loss is the bug. Three properties make delivery safe here:
//
//   - Idempotent. A batch is delivered as an upsert with ignoreDuplicates
//     (ON CONFLICT DO NOTHING on the unique (session_id, segment_index)), so
//     re-sending a row that already landed is a no-op — and DO NOTHING needs no
//     UPDATE privilege, so it respects the append-only schema (no update policy
//     anywhere). A partially delivered batch can therefore be retried whole.
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
  onError = () => {}
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

  // Drains the queue in batches. Stops and schedules a backed-off retry on the
  // first failed batch, leaving the rest (and the failed one) in `pending` and
  // in the store so nothing is lost.
  async function flush() {
    if (flushing || pending.size === 0) return;
    flushing = true;

    try {
      while (pending.size > 0) {
        const keys = [];
        const rows = [];
        for (const [key, row] of pending) {
          keys.push(key);
          rows.push(row);
          if (rows.length >= batchSize) break;
        }

        try {
          await send(rows);
        } catch (error) {
          onError(error);
          scheduleRetry();
          return;
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
