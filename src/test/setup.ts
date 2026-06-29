// Vitest setup. jsdom provides window/localStorage; we just clear state
// between tests so dedup-marker tests start with a clean slate.
import { afterEach } from 'vitest';

afterEach(() => {
  try { localStorage.clear(); } catch { /* noop */ }
});
