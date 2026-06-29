// Tiny in-memory SWR-style cache for read-heavy reference lookups
// (classes, lessons, etc) shared across the app. Returns the cached
// value if fresh, otherwise awaits the loader. While stale-but-recent,
// returns the cached value AND fires an asynchronous refresh so the
// next caller sees the new data without paying the round-trip.
//
// Designed for collections that change rarely vs. how often they're
// read inside notification fan-out (every Realtime tick during peak).

interface CacheEntry<T> {
  value: T;
  loadedAt: number;
  inFlight?: Promise<T>;
}

const store = new Map<string, CacheEntry<unknown>>();

export interface SwrOptions {
  /** Hard expiry: beyond this age the cached value is NOT returned. */
  maxAgeMs: number;
  /** Soft expiry: beyond this age trigger a background refresh. */
  staleAfterMs?: number;
}

export async function swr<T>(
  key: string,
  loader: () => Promise<T>,
  opts: SwrOptions,
): Promise<T> {
  const now = Date.now();
  const entry = store.get(key) as CacheEntry<T> | undefined;

  if (entry && entry.loadedAt > 0 && now - entry.loadedAt < opts.maxAgeMs) {
    const stale = opts.staleAfterMs != null && now - entry.loadedAt > opts.staleAfterMs;
    if (stale && !entry.inFlight) {
      // Fire-and-forget background refresh; ignore errors so the cached
      // value still serves until next call.
      entry.inFlight = loader()
        .then((v) => {
          store.set(key, { value: v, loadedAt: Date.now() });
          return v;
        })
        .catch(() => entry.value)
        .finally(() => { entry.inFlight = undefined; });
    }
    return entry.value;
  }

  // Coalesce concurrent misses on the same key.
  if (entry?.inFlight) return entry.inFlight;

  // Cache miss \u2014 start a fresh load. We DO NOT stash a placeholder entry
  // with `value: undefined as T` (that would silently corrupt subsequent
  // reads if the loader rejects). Instead, only commit on success; on
  // failure, propagate the error and leave any prior good value untouched.
  const promise = loader()
    .then((value) => {
      store.set(key, { value, loadedAt: Date.now() });
      return value;
    })
    .catch((err) => {
      // Clear in-flight marker but keep prior good entry (if any) intact.
      const cur = store.get(key) as CacheEntry<T> | undefined;
      if (cur && cur.loadedAt > 0) {
        cur.inFlight = undefined;
      } else {
        store.delete(key);
      }
      throw err;
    });

  // Track the in-flight promise so concurrent callers join it. If we have a
  // prior good entry, decorate it; otherwise create a placeholder marked
  // loadedAt=0 so the freshness check above never returns its (undefined)
  // value as a real cache hit.
  if (entry && entry.loadedAt > 0) {
    entry.inFlight = promise;
  } else {
    store.set(key, { value: undefined as unknown as T, loadedAt: 0, inFlight: promise });
  }
  return promise;
}

/** Invalidate one or all keys (call from mutating service functions). */
export function invalidateSwr(key?: string): void {
  if (key) store.delete(key);
  else store.clear();
}
