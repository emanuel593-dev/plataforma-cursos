// Regression tests for src/lib/swrCache.ts
//
// These tests pin down the contract of the SWR helper used by
// notifications.service to throttle Supabase round-trips. The most
// important guarantee is that a rejected loader MUST NOT pollute the
// cache with `undefined`; that bug was caught in the Sprint 3 audit.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { swr, invalidateSwr } from './swrCache';

beforeEach(() => {
  invalidateSwr();
});

describe('swr()', () => {
  it('returns the loader result on first call (cache miss)', async () => {
    const loader = vi.fn().mockResolvedValue('hello');
    const v = await swr('k1', loader, { maxAgeMs: 60_000 });
    expect(v).toBe('hello');
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it('serves a cached value within maxAgeMs without re-invoking loader', async () => {
    const loader = vi.fn().mockResolvedValue(42);
    await swr('k2', loader, { maxAgeMs: 60_000 });
    const v = await swr('k2', loader, { maxAgeMs: 60_000 });
    expect(v).toBe(42);
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it('coalesces concurrent misses into a single loader call', async () => {
    let resolve!: (v: number) => void;
    const loader = vi.fn(() => new Promise<number>((r) => { resolve = r; }));
    const p1 = swr('k3', loader, { maxAgeMs: 60_000 });
    const p2 = swr('k3', loader, { maxAgeMs: 60_000 });
    const p3 = swr('k3', loader, { maxAgeMs: 60_000 });
    expect(loader).toHaveBeenCalledTimes(1);
    resolve(7);
    await expect(p1).resolves.toBe(7);
    await expect(p2).resolves.toBe(7);
    await expect(p3).resolves.toBe(7);
  });

  it('does NOT cache a rejected loader result; next call retries cleanly', async () => {
    const loader = vi.fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce('ok');

    await expect(swr('k4', loader, { maxAgeMs: 60_000 })).rejects.toThrow('boom');
    // Critical: a buggy implementation would have stored {value: undefined,
    // loadedAt: 0} and returned undefined here without re-invoking loader.
    const v = await swr('k4', loader, { maxAgeMs: 60_000 });
    expect(v).toBe('ok');
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it('preserves a previously-cached value when a refresh loader rejects', async () => {
    let call = 0;
    const loader = vi.fn(() => {
      call += 1;
      if (call === 1) return Promise.resolve('first');
      return Promise.reject(new Error('refresh-failed'));
    });

    // Seed the cache.
    await swr('k5', loader, { maxAgeMs: 60_000 });

    // Force expiry by invalidating only the freshness; simplest path is to
    // call with maxAgeMs=0 so the helper treats it as a miss but a prior
    // good entry exists. Implementation should keep the old entry on error.
    await expect(swr('k5', loader, { maxAgeMs: 0 })).rejects.toThrow('refresh-failed');

    // Prior good value should still serve under a normal maxAge.
    const v = await swr('k5', loader, { maxAgeMs: 60_000 });
    expect(v).toBe('first');
    // Only the seed + the failed retry should have run; the third call hits cache.
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it('triggers a background refresh when value is stale-but-fresh', async () => {
    // Seed with an old value.
    const loader1 = vi.fn().mockResolvedValue('old');
    await swr('k6', loader1, { maxAgeMs: 60_000 });

    // Ensure measurable elapsed time so `now - loadedAt > staleAfterMs(0)`.
    await new Promise((r) => setTimeout(r, 5));

    // Use staleAfterMs=0 so the very next call sees it as stale
    // but still under maxAge.
    const loader2 = vi.fn().mockResolvedValue('new');
    const v = await swr('k6', loader2, { maxAgeMs: 60_000, staleAfterMs: 0 });
    // Stale path returns the cached value synchronously.
    expect(v).toBe('old');
    // Background refresh should have been scheduled.
    expect(loader2).toHaveBeenCalledTimes(1);

    // After the microtask flush, a fresh call should see the refreshed value.
    await new Promise((r) => setTimeout(r, 0));
    const v2 = await swr('k6', loader2, { maxAgeMs: 60_000 });
    expect(v2).toBe('new');
  });

  it('invalidateSwr() clears a specific key', async () => {
    const loader = vi.fn().mockResolvedValue('a');
    await swr('k7', loader, { maxAgeMs: 60_000 });
    invalidateSwr('k7');
    await swr('k7', loader, { maxAgeMs: 60_000 });
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it('invalidateSwr() with no arg clears every key', async () => {
    const a = vi.fn().mockResolvedValue('a');
    const b = vi.fn().mockResolvedValue('b');
    await swr('kA', a, { maxAgeMs: 60_000 });
    await swr('kB', b, { maxAgeMs: 60_000 });
    invalidateSwr();
    await swr('kA', a, { maxAgeMs: 60_000 });
    await swr('kB', b, { maxAgeMs: 60_000 });
    expect(a).toHaveBeenCalledTimes(2);
    expect(b).toHaveBeenCalledTimes(2);
  });
});
