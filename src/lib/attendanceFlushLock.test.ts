import { describe, it, expect } from 'vitest';
import { shouldSkipFlush, markFlushed, clearFlushMarker } from './attendanceFlushLock';

const LESSON = 'lesson-1';
const STUDENT = 'student-1';

describe('attendanceFlushLock', () => {
  it('returns false when no flush has been registered', () => {
    expect(shouldSkipFlush(LESSON, STUDENT)).toBe(false);
  });

  it('returns true immediately after markFlushed', () => {
    markFlushed(LESSON, STUDENT);
    expect(shouldSkipFlush(LESSON, STUDENT)).toBe(true);
  });

  it('respects the windowMs argument (0 ms window never skips)', () => {
    markFlushed(LESSON, STUDENT);
    expect(shouldSkipFlush(LESSON, STUDENT, 0)).toBe(false);
  });

  it('isolates markers per (lesson, student)', () => {
    markFlushed(LESSON, STUDENT);
    expect(shouldSkipFlush('other-lesson', STUDENT)).toBe(false);
    expect(shouldSkipFlush(LESSON, 'other-student')).toBe(false);
  });

  it('clearFlushMarker removes the dedup window', () => {
    markFlushed(LESSON, STUDENT);
    clearFlushMarker(LESSON, STUDENT);
    expect(shouldSkipFlush(LESSON, STUDENT)).toBe(false);
  });

  it('treats stale (out-of-window) markers as expired', () => {
    // Manually plant a marker timestamped 10s in the past.
    localStorage.setItem(`iv_att_flush_${LESSON}_${STUDENT}`, String(Date.now() - 10_000));
    expect(shouldSkipFlush(LESSON, STUDENT, 5000)).toBe(false);
  });
});
