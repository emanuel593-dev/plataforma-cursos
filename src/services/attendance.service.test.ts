// Tests for the localStorage fallback branch of flushAttendanceProgress.
// In test environment Supabase env vars are unset, so isSupabaseConfigured
// is false and the additive in-memory branch is exercised.
//
// Production race-safety is enforced server-side by the SQL function
// `attendance_increment_duration` (migration 015) and is covered by manual
// /diag verification + the existing audit trail; we don't double-test the
// RPC here.

import { describe, it, expect, beforeEach } from 'vitest';
import { flushAttendanceProgress } from './attendance.service';

const LESSON = '00000000-0000-0000-0000-000000000001';
const STUDENT = '00000000-0000-0000-0000-000000000002';

describe('flushAttendanceProgress (localStorage fallback)', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('creates a new attendance row on first flush', async () => {
    const row = await flushAttendanceProgress(LESSON, STUDENT, {
      deltaSeconds: 120,
      verifiedChecksDelta: 1,
      totalChecksDelta: 1,
      joinedAt: '2025-01-01T10:00:00.000Z',
    });
    expect(row.duration_seconds).toBe(120);
    expect(row.verified_checks).toBe(1);
    expect(row.total_checks).toBe(1);
    expect(row.status).toBe('present');
  });

  it('sums deltas across multiple flushes (incremental)', async () => {
    await flushAttendanceProgress(LESSON, STUDENT, { deltaSeconds: 60 });
    await flushAttendanceProgress(LESSON, STUDENT, { deltaSeconds: 90 });
    const row = await flushAttendanceProgress(LESSON, STUDENT, { deltaSeconds: 30 });
    expect(row.duration_seconds).toBe(180);
  });

  it('sums verified/total check deltas across flushes', async () => {
    await flushAttendanceProgress(LESSON, STUDENT, {
      deltaSeconds: 0, verifiedChecksDelta: 1, totalChecksDelta: 1,
    });
    const row = await flushAttendanceProgress(LESSON, STUDENT, {
      deltaSeconds: 0, verifiedChecksDelta: 0, totalChecksDelta: 1,
    });
    expect(row.verified_checks).toBe(1);
    expect(row.total_checks).toBe(2);
  });

  it('rounds non-integer deltaSeconds and clamps negatives to zero', async () => {
    const row = await flushAttendanceProgress(LESSON, STUDENT, { deltaSeconds: -50 });
    expect(row.duration_seconds).toBe(0);
    const row2 = await flushAttendanceProgress(LESSON, STUDENT, { deltaSeconds: 12.7 });
    expect(row2.duration_seconds).toBe(13);
  });

  it('preserves earliest joined_at when later flush carries a newer one', async () => {
    await flushAttendanceProgress(LESSON, STUDENT, {
      deltaSeconds: 30, joinedAt: '2025-01-01T10:00:00.000Z',
    });
    const row = await flushAttendanceProgress(LESSON, STUDENT, {
      deltaSeconds: 30, joinedAt: '2025-01-01T10:30:00.000Z',
    });
    expect(row.joined_at).toBe('2025-01-01T10:00:00.000Z');
  });

  it('only overwrites status when a status is explicitly provided', async () => {
    // First flush: explicit absent
    await flushAttendanceProgress(LESSON, STUDENT, {
      deltaSeconds: 60, status: 'absent', notes: 'note A',
    });
    // Intermediate flush: status null → must NOT overwrite
    const mid = await flushAttendanceProgress(LESSON, STUDENT, { deltaSeconds: 30 });
    expect(mid.status).toBe('absent');
    expect(mid.notes).toBe('note A');
    // Final flush: explicit present → overwrites
    const fin = await flushAttendanceProgress(LESSON, STUDENT, {
      deltaSeconds: 0, status: 'present', notes: null,
    });
    expect(fin.status).toBe('present');
    expect(fin.notes).toBeNull();
  });
});
