// Tests for the pure helpers extracted from useWebRTC: chat RAM cap and
// the auto-degrade decision (Sprint 4 audit fixes).

import { describe, it, expect } from 'vitest';
import {
  appendChat,
  CHAT_RAM_SOFT_CAP,
  shouldAutoDegrade,
  AUTO_DEGRADE_COOLDOWN_MS,
  AUTO_DEGRADE_JOIN_GRACE_MS,
  AUTO_DEGRADE_THRESHOLD,
} from './mediaQuality';

interface Msg { id: string }
const m = (id: string): Msg => ({ id });

describe('appendChat', () => {
  it('appends a message when under the cap', () => {
    const out = appendChat([m('a'), m('b')], m('c'));
    expect(out.map((x) => x.id)).toEqual(['a', 'b', 'c']);
  });

  it('does not mutate the input array', () => {
    const prev = [m('a')];
    const out = appendChat(prev, m('b'));
    expect(prev).toEqual([m('a')]);
    expect(out).not.toBe(prev);
  });

  it('drops oldest messages once the soft cap is exceeded (FIFO)', () => {
    const prev = Array.from({ length: CHAT_RAM_SOFT_CAP }, (_, i) => m(String(i)));
    const out = appendChat(prev, m('NEW'));
    expect(out).toHaveLength(CHAT_RAM_SOFT_CAP);
    // First message ('0') must be evicted; tail must be the new one.
    expect(out[0].id).toBe('1');
    expect(out[out.length - 1].id).toBe('NEW');
  });

  it('keeps a single most-recent slice if the input is already over cap', () => {
    // Hypothetical pre-existing oversize array (defensive — current callers
    // never produce this, but the helper must still bound RAM growth).
    const prev = Array.from({ length: CHAT_RAM_SOFT_CAP + 50 }, (_, i) => m(String(i)));
    const out = appendChat(prev, m('NEW'));
    expect(out).toHaveLength(CHAT_RAM_SOFT_CAP);
    expect(out[out.length - 1].id).toBe('NEW');
  });
});

describe('shouldAutoDegrade', () => {
  const baseline = {
    consecutivePoor: AUTO_DEGRADE_THRESHOLD,
    videoEnabled: true,
    lastManualVideoEnableMs: 0,
    joinedAtMs: 0,                           // joined long ago — outside grace
    nowMs: AUTO_DEGRADE_COOLDOWN_MS + 1_000, // outside cooldown
  };

  it('degrades after threshold consecutive poor samples on a stale enable', () => {
    expect(shouldAutoDegrade(baseline)).toBe(true);
  });

  it('does not degrade when video is already off', () => {
    expect(shouldAutoDegrade({ ...baseline, videoEnabled: false })).toBe(false);
  });

  it('does not degrade when poor sample count is below threshold', () => {
    expect(shouldAutoDegrade({ ...baseline, consecutivePoor: AUTO_DEGRADE_THRESHOLD - 1 })).toBe(false);
  });

  it('respects the cooldown after a manual re-enable', () => {
    // User re-enabled video 5 s ago; cooldown is 30 s → must NOT degrade.
    const ctx = {
      ...baseline,
      lastManualVideoEnableMs: 100_000,
      nowMs: 100_000 + 5_000,
    };
    expect(shouldAutoDegrade(ctx)).toBe(false);
  });

  it('degrades again once the cooldown window has elapsed', () => {
    const ctx = {
      ...baseline,
      lastManualVideoEnableMs: 100_000,
      nowMs: 100_000 + AUTO_DEGRADE_COOLDOWN_MS + 1,
    };
    expect(shouldAutoDegrade(ctx)).toBe(true);
  });

  it('treats the boundary itself as still inside cooldown (>= not strict)', () => {
    // nowMs - lastManualVideoEnableMs == cooldown exactly. The contract is
    // "at least cooldown has passed", but the implementation uses `<=`
    // to be defensive — test pins that decision so a future edit to `<`
    // is a deliberate, reviewed change.
    const ctx = {
      ...baseline,
      lastManualVideoEnableMs: 100_000,
      nowMs: 100_000 + AUTO_DEGRADE_COOLDOWN_MS,
    };
    expect(shouldAutoDegrade(ctx)).toBe(false);
  });

  it('does not degrade within the join grace period', () => {
    // User just joined 10 s ago; even with 2 poor samples, grace prevents degrade.
    const joinedAt = 50_000;
    const ctx = {
      ...baseline,
      joinedAtMs: joinedAt,
      nowMs: joinedAt + 10_000,
    };
    expect(shouldAutoDegrade(ctx)).toBe(false);
  });

  it('degrades normally once the join grace period has elapsed', () => {
    const joinedAt = 50_000;
    const ctx = {
      ...baseline,
      joinedAtMs: joinedAt,
      nowMs: joinedAt + AUTO_DEGRADE_JOIN_GRACE_MS + 1,
    };
    expect(shouldAutoDegrade(ctx)).toBe(true);
  });
});
