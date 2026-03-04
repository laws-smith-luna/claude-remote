/**
 * Offline storage — IndexedDB wrapper for caching sessions, history, and queuing outgoing messages.
 *
 * Object stores:
 *   sessions: keyPath "sessionId", index on "machineName"
 *   histories: keyPath "sessionId" → { sessionId, entries, cachedAt }
 *   outgoing: autoIncrement, index on "machineUrl" → { machineUrl, message, queuedAt }
 */

const DB_NAME = "claude-remote";
const DB_VERSION = 1;

let dbPromise = null;

/** Open (or get cached) IndexedDB connection */
export function openOfflineDb() {
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve, reject) => {
    if (!window.indexedDB) {
      reject(new Error("IndexedDB not supported"));
      return;
    }

    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains("sessions")) {
        const store = db.createObjectStore("sessions", { keyPath: "sessionId" });
        store.createIndex("machineName", "machineName", { unique: false });
      }
      if (!db.objectStoreNames.contains("histories")) {
        db.createObjectStore("histories", { keyPath: "sessionId" });
      }
      if (!db.objectStoreNames.contains("outgoing")) {
        const store = db.createObjectStore("outgoing", { autoIncrement: true });
        store.createIndex("machineUrl", "machineUrl", { unique: false });
      }
    };

    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

  return dbPromise;
}

// Auto-open on import
openOfflineDb().catch(() => { /* IndexedDB may not be available */ });

/** Cache sessions for offline browsing */
export async function cacheSessions(sessions) {
  try {
    const db = await openOfflineDb();
    const tx = db.transaction("sessions", "readwrite");
    const store = tx.objectStore("sessions");

    // Clear old and write new
    store.clear();
    for (const s of sessions) {
      store.put(s);
    }
  } catch { /* ignore offline store errors */ }
}

/** Get cached sessions */
export async function getCachedSessions() {
  try {
    const db = await openOfflineDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("sessions", "readonly");
      const req = tx.objectStore("sessions").getAll();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return [];
  }
}

/** Cache history entries for a session */
export async function cacheHistory(sessionId, entries) {
  try {
    const db = await openOfflineDb();
    const tx = db.transaction("histories", "readwrite");
    tx.objectStore("histories").put({
      sessionId,
      entries,
      cachedAt: Date.now(),
    });
  } catch { /* ignore */ }
}

/** Get cached history for a session */
export async function getCachedHistory(sessionId) {
  try {
    const db = await openOfflineDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("histories", "readonly");
      const req = tx.objectStore("histories").get(sessionId);
      req.onsuccess = () => resolve(req.result?.entries || null);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return null;
  }
}

/** Queue an outgoing message for later delivery */
export async function queueOutgoing(machineUrl, message) {
  try {
    const db = await openOfflineDb();
    const tx = db.transaction("outgoing", "readwrite");
    tx.objectStore("outgoing").add({
      machineUrl,
      message,
      queuedAt: Date.now(),
    });
  } catch { /* ignore */ }
}

/** Flush all queued outgoing messages for a machine */
export async function flushOutgoing(machineUrl, sendFn) {
  try {
    const db = await openOfflineDb();
    const tx = db.transaction("outgoing", "readwrite");
    const store = tx.objectStore("outgoing");
    const index = store.index("machineUrl");

    return new Promise((resolve) => {
      const req = index.openCursor(IDBKeyRange.only(machineUrl));
      let flushed = 0;

      req.onsuccess = (e) => {
        const cursor = e.target.result;
        if (cursor) {
          try {
            sendFn(cursor.value.message);
            flushed++;
          } catch { /* skip failed sends */ }
          cursor.delete();
          cursor.continue();
        } else {
          resolve(flushed);
        }
      };

      req.onerror = () => resolve(0);
    });
  } catch {
    return 0;
  }
}
