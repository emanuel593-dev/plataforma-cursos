// Cross-tab attendance flush dedup.
//
// Problem: visibilitychange + beforeunload + reconnect handlers can each
// fire a flush within milliseconds of one another (same tab) or of each
// other across two tabs of the same user. Without dedup, all of them race
// to send overlapping deltas to the RPC and the cumulative total drifts.
//
// Mechanism:
// - Each flush call writes a timestamp into localStorage at a key derived
//   from `(lessonId, studentId)`. Other tabs see the write via `storage`
//   events; a same-tab call sees its own write.
// - `shouldSkipFlush()` returns true when a flush was registered within the
//   given window (default 5 s). Final flushes (lesson end / explicit leave)
//   bypass the window so the user-initiated action is never lost.
//
// Bounded keyspace: 1 entry per active lesson per student. Cleared when
// the lesson is left.

const KEY_PREFIX = 'iv_att_flush_';

function key(lessonId: string, studentId: string): string {
  return `${KEY_PREFIX}${lessonId}_${studentId}`;
}

/** True if a flush was registered for this lesson/student within `windowMs`. */
export function shouldSkipFlush(
  lessonId: string,
  studentId: string,
  windowMs = 5000,
): boolean {
  if (typeof localStorage === 'undefined') return false;
  try {
    const raw = localStorage.getItem(key(lessonId, studentId));
    if (!raw) return false;
    const last = Number(raw);
    if (!Number.isFinite(last)) return false;
    return Date.now() - last < windowMs;
  } catch {
    return false;
  }
}

/** Mark a flush as in-progress / just-completed for this lesson/student. */
export function markFlushed(lessonId: string, studentId: string): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(key(lessonId, studentId), String(Date.now()));
  } catch {
    /* quota / private mode — ignore */
  }
}

/** Clear the marker (call when leaving the lesson definitively). */
export function clearFlushMarker(lessonId: string, studentId: string): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.removeItem(key(lessonId, studentId));
  } catch {
    /* noop */
  }
}
