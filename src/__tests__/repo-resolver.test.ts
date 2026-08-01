import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, rmSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveRepoByName, resolveRepoFromPrefix, getRepoNames } from '../repo-resolver.js';

// characterization test: repo-resolver の解決挙動を固定する

let gitRoot: string;

beforeAll(() => {
  gitRoot = mkdtempSync(join(tmpdir(), 'ai-steward-test-'));
  // github.com/org/repo 形式と直下形式の両方を作る
  mkdirSync(join(gitRoot, 'github.com/under-the-bridge-hq/ai-steward/.git'), { recursive: true });
  mkdirSync(join(gitRoot, 'github.com/under-the-bridge-hq/llm-wiki/.git'), { recursive: true });
  mkdirSync(join(gitRoot, 'github.com/under-the-bridge-hq/llm-wiki-tools/.git'), { recursive: true });
  mkdirSync(join(gitRoot, 'loglass/sysdig-vuls-utils/.git'), { recursive: true });
});

afterAll(() => {
  rmSync(gitRoot, { recursive: true, force: true });
});

describe('getRepoNames', () => {
  it('github.com 配下は org/repo 形式で返す', () => {
    const names = getRepoNames(gitRoot);
    expect(names).toContain('under-the-bridge-hq/ai-steward');
    expect(names).toContain('loglass/sysdig-vuls-utils');
  });
});

describe('resolveRepoByName', () => {
  it('リポ名のみで完全一致解決する', () => {
    expect(resolveRepoByName('ai-steward', gitRoot)).toBe(
      join(gitRoot, 'github.com/under-the-bridge-hq/ai-steward'),
    );
  });

  it('org/repo 形式でパス末尾一致解決する', () => {
    expect(resolveRepoByName('loglass/sysdig-vuls-utils', gitRoot)).toBe(
      join(gitRoot, 'loglass/sysdig-vuls-utils'),
    );
  });

  it('存在しないリポは null を返す', () => {
    expect(resolveRepoByName('no-such-repo', gitRoot)).toBeNull();
  });

  it('部分文字列では一致しない（llm-wiki は llm-wiki-tools に解決されない）', () => {
    expect(resolveRepoByName('llm-wiki', gitRoot)).toBe(
      join(gitRoot, 'github.com/under-the-bridge-hq/llm-wiki'),
    );
  });
});

describe('resolveRepoFromPrefix', () => {
  it('メッセージ冒頭のリポ名を解決する', () => {
    expect(resolveRepoFromPrefix('ai-stewardの調査をして', gitRoot)).toBe(
      join(gitRoot, 'github.com/under-the-bridge-hq/ai-steward'),
    );
  });

  it('冒頭がリポ名でなければ null', () => {
    expect(resolveRepoFromPrefix('READMEを見せて', gitRoot)).toBeNull();
  });
});
