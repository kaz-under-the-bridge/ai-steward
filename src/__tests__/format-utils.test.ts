import { describe, it, expect } from 'vitest';
import { formatElapsed, formatTokenCount, elapsedSinceSqliteUtc } from '../format-utils.js';

describe('formatElapsed', () => {
  it('秒・分・時間の各表記になる', () => {
    expect(formatElapsed(12_000)).toBe('12秒');
    expect(formatElapsed(4 * 60_000 + 5_000)).toBe('4分5秒');
    expect(formatElapsed(83 * 60_000)).toBe('1時間23分');
  });

  it('負値は0秒', () => {
    expect(formatElapsed(-100)).toBe('0秒');
  });
});

describe('formatTokenCount', () => {
  it('カンマ区切りになる', () => {
    expect(formatTokenCount(12345)).toBe('12,345');
    expect(formatTokenCount(0)).toBe('0');
  });
});

describe('elapsedSinceSqliteUtc', () => {
  it('SQLiteのUTC日時から経過ミリ秒を計算する', () => {
    const now = new Date('2026-08-03T05:10:00Z');
    expect(elapsedSinceSqliteUtc('2026-08-03 05:00:00', now)).toBe(10 * 60_000);
  });
});
