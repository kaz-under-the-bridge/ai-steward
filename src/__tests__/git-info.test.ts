import { describe, it, expect } from 'vitest';
import { pickRecentPr } from '../git-info.js';

describe('pickRecentPr', () => {
  const start = new Date('2026-08-03T05:00:00Z');

  it('タスク開始以降に更新されたPRのURLを返す', () => {
    const prs = [{ url: 'https://github.com/o/r/pull/1', updatedAt: '2026-08-03T05:10:00Z' }];
    expect(pickRecentPr(prs, start)).toBe('https://github.com/o/r/pull/1');
  });

  it('タスク開始より前のPRは対象外', () => {
    const prs = [{ url: 'https://github.com/o/r/pull/1', updatedAt: '2026-08-03T04:00:00Z' }];
    expect(pickRecentPr(prs, start)).toBeNull();
  });

  it('空リストはnull', () => {
    expect(pickRecentPr([], start)).toBeNull();
  });
});
