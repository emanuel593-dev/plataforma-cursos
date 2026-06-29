// Regression tests for the Sprint 2 critical bug:
//
//   recordAttendanceJoin used to upsert { status: 'present', ... }
//   unconditionally. If the student left early and a final flush had set
//   status='absent', a later rejoin (e.g. accidental tab reopen) would
//   silently revert the decision back to 'present' \u2014 corrupting the
//   teacher's roster.
//
// The fix: only set status when no row exists yet (true first join).
// These tests pin that contract.

import { describe, it, expect, vi } from 'vitest';
import { recordAttendanceJoinCore } from './attendanceJoin';
import type { Attendance } from '../types';

const LESSON = 'lesson-1';
const STUDENT = 'student-1';

function makeAttendance(overrides: Partial<Attendance> = {}): Attendance {
  return {
    id: 'att-1',
    scheduled_lesson_id: LESSON,
    student_id: STUDENT,
    status: 'present',
    joined_at: '2026-05-02T13:00:00.000Z',
    left_at: null,
    duration_seconds: 0,
    verified_checks: 0,
    total_checks: 0,
    marked_by: STUDENT,
    notes: null,
    created_at: '2026-05-02T13:00:00.000Z',
    updated_at: '2026-05-02T13:00:00.000Z',
    ...overrides,
  } as Attendance;
}

describe('recordAttendanceJoinCore', () => {
  it('first join: creates the row with status=present and a fresh joined_at', async () => {
    const getAttendance = vi.fn().mockResolvedValue(null);
    const upsertAttendance = vi.fn(async (_lesson, _student, updates) => makeAttendance(updates));

    const result = await recordAttendanceJoinCore(
      { getAttendance, upsertAttendance },
      LESSON,
      STUDENT,
      '2026-05-02T13:00:00.000Z',
    );

    expect(result.firstJoin).toBe(true);
    expect(result.priorDurationSeconds).toBe(0);
    expect(result.priorVerifiedChecks).toBe(0);
    expect(result.priorTotalChecks).toBe(0);

    expect(upsertAttendance).toHaveBeenCalledTimes(1);
    const [, , updates] = upsertAttendance.mock.calls[0];
    expect(updates).toEqual({
      joined_at: '2026-05-02T13:00:00.000Z',
      marked_by: STUDENT,
      status: 'present',
    });
  });

  it('rejoin after final flush: does NOT overwrite status=absent', async () => {
    const existing = makeAttendance({
      status: 'absent',
      joined_at: '2026-05-02T13:00:00.000Z',
      duration_seconds: 240,
      verified_checks: 1,
      total_checks: 4,
    });
    const getAttendance = vi.fn().mockResolvedValue(existing);
    const upsertAttendance = vi.fn(async (_lesson, _student, updates) => ({ ...existing, ...updates }));

    const result = await recordAttendanceJoinCore(
      { getAttendance, upsertAttendance },
      LESSON,
      STUDENT,
    );

    expect(result.firstJoin).toBe(false);
    expect(result.priorDurationSeconds).toBe(240);
    expect(result.priorVerifiedChecks).toBe(1);
    expect(result.priorTotalChecks).toBe(4);

    const [, , updates] = upsertAttendance.mock.calls[0];
    // The whole point of the regression test:
    expect(updates).not.toHaveProperty('status');
    // joined_at must be preserved from the existing row, not overwritten.
    expect(updates.joined_at).toBe('2026-05-02T13:00:00.000Z');
    expect(updates.marked_by).toBe(STUDENT);
  });

  it('rejoin with status=justified: also preserved (does not silently flip to present)', async () => {
    const existing = makeAttendance({ status: 'justified' });
    const getAttendance = vi.fn().mockResolvedValue(existing);
    const upsertAttendance = vi.fn(async (_lesson, _student, updates) => ({ ...existing, ...updates }));

    await recordAttendanceJoinCore({ getAttendance, upsertAttendance }, LESSON, STUDENT);

    const [, , updates] = upsertAttendance.mock.calls[0];
    expect(updates).not.toHaveProperty('status');
  });

  it('propagates upsert errors so the caller can log them', async () => {
    const getAttendance = vi.fn().mockResolvedValue(null);
    const upsertAttendance = vi.fn().mockRejectedValue(new Error('network down'));

    await expect(
      recordAttendanceJoinCore({ getAttendance, upsertAttendance }, LESSON, STUDENT),
    ).rejects.toThrow('network down');
  });

  it('uses the injected nowIso for joined_at on a true first join', async () => {
    const getAttendance = vi.fn().mockResolvedValue(null);
    const upsertAttendance = vi.fn(async (_l, _s, u) => makeAttendance(u));

    await recordAttendanceJoinCore(
      { getAttendance, upsertAttendance },
      LESSON,
      STUDENT,
      '2099-01-01T00:00:00.000Z',
    );

    const [, , updates] = upsertAttendance.mock.calls[0];
    expect(updates.joined_at).toBe('2099-01-01T00:00:00.000Z');
  });
});
