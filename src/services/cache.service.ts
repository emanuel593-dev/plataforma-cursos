/**
 * cache.service — generic key/value cache with TTL.
 *
 * Backends (auto-selected at runtime):
 *   • IndexedDB (preferred — survives more, larger quota, async non-blocking)
 *   • localStorage (fallback when indexedDB is unavailable / blocked, e.g. private mode)
 *
 * Usage pattern (stale-while-revalidate):
 *   const cached = await cacheGet<ScheduledLesson[]>('schedule:all');
 *   if (cached) setScheduled(cached);
 *   const fresh = await listScheduledLessons();
 *   await cacheSet('schedule:all', fresh, 5 * 60_000);
 *   setScheduled(fresh);
 *
 * All operations are best-effort: failures resolve to null/void, never throw.
 */

const DB_NAME = 'iv_cache';
const STORE_NAME = 'kv';
const DB_VERSION = 1;
const LS_PREFIX = 'iv_cache:';

interface CacheEntry<T> {
  value: T;
  expiresAt: number; // epoch ms; Infinity = no expiry
}

// ── IndexedDB backend ───────────────────────────────────────────────────────

let dbPromise: Promise<IDBDatabase | null> | null = null;

function openDB(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    if (typeof indexedDB === 'undefined') {
      resolve(null);
      return;
    }
    try {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME);
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return dbPromise;
}

async function idbGet<T>(key: string): Promise<CacheEntry<T> | null> {
  const db = await openDB();
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const req = store.get(key);
      req.onsuccess = () => resolve((req.result as CacheEntry<T> | undefined) ?? null);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

async function idbSet<T>(key: string, entry: CacheEntry<T>): Promise<void> {
  const db = await openDB();
  if (!db) return;
  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      store.put(entry, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    } catch {
      resolve();
    }
  });
}

async function idbDelete(key: string): Promise<void> {
  const db = await openDB();
  if (!db) return;
  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).delete(key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    } catch {
      resolve();
    }
  });
}

async function idbClearPrefix(prefix: string): Promise<void> {
  const db = await openDB();
  if (!db) return;
  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const req = store.openCursor();
      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor) {
          resolve();
          return;
        }
        if (typeof cursor.key === 'string' && cursor.key.startsWith(prefix)) {
          cursor.delete();
        }
        cursor.continue();
      };
      req.onerror = () => resolve();
    } catch {
      resolve();
    }
  });
}

// ── localStorage fallback ───────────────────────────────────────────────────

function lsGet<T>(key: string): CacheEntry<T> | null {
  try {
    const raw = localStorage.getItem(LS_PREFIX + key);
    if (!raw) return null;
    return JSON.parse(raw) as CacheEntry<T>;
  } catch {
    return null;
  }
}

function lsSet<T>(key: string, entry: CacheEntry<T>): void {
  try {
    localStorage.setItem(LS_PREFIX + key, JSON.stringify(entry));
  } catch {
    /* quota exceeded or storage disabled */
  }
}

function lsDelete(key: string): void {
  try {
    localStorage.removeItem(LS_PREFIX + key);
  } catch { /* ignore */ }
}

function lsClearPrefix(prefix: string): void {
  try {
    const full = LS_PREFIX + prefix;
    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(full)) keys.push(k);
    }
    for (const k of keys) localStorage.removeItem(k);
  } catch { /* ignore */ }
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Read a cached value. Returns null if missing or expired.
 * Expired entries are deleted in the background (best-effort).
 */
export async function cacheGet<T>(key: string): Promise<T | null> {
  let entry = await idbGet<T>(key);
  if (!entry) entry = lsGet<T>(key);
  if (!entry) return null;
  if (entry.expiresAt !== Infinity && entry.expiresAt < Date.now()) {
    // Fire-and-forget eviction
    void cacheInvalidate(key);
    return null;
  }
  return entry.value;
}

/**
 * Persist a value with a TTL (ms). Pass Infinity to skip expiry.
 * Best-effort: failures (quota, missing IDB) are silently dropped.
 */
export async function cacheSet<T>(
  key: string,
  value: T,
  ttlMs: number = 5 * 60_000,
): Promise<void> {
  const entry: CacheEntry<T> = {
    value,
    expiresAt: ttlMs === Infinity ? Infinity : Date.now() + ttlMs,
  };
  await idbSet(key, entry);
  // Also mirror to LS as a defensive fallback for tiny payloads.
  // Skip if value is a large array to avoid quota churn.
  if (Array.isArray(value) && value.length > 200) return;
  lsSet(key, entry);
}

/** Remove a single key from both backends. */
export async function cacheInvalidate(key: string): Promise<void> {
  await idbDelete(key);
  lsDelete(key);
}

/** Remove all keys starting with a given prefix from both backends. */
export async function cacheInvalidatePrefix(prefix: string): Promise<void> {
  await idbClearPrefix(prefix);
  lsClearPrefix(prefix);
}
