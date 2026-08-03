import { describe, it, expect } from 'vitest';
import { validateRouteResult } from '../router/index.js';

describe('validateRouteResult', () => {
  it('正しいtask出力を通す', () => {
    expect(validateRouteResult({ intent: 'task', repoName: 'ai-steward' })).toEqual({
      intent: 'task',
      repoName: 'ai-steward',
    });
  });

  it('repoName nullのgeneral出力を通す', () => {
    expect(validateRouteResult({ intent: 'general', repoName: null })).toEqual({
      intent: 'general',
      repoName: null,
    });
  });

  it('余分なフィールドを落とす', () => {
    expect(validateRouteResult({ intent: 'task', repoName: 'x', extra: 1 })).toEqual({
      intent: 'task',
      repoName: 'x',
    });
  });

  it('intent不正はthrow', () => {
    expect(() => validateRouteResult({ intent: 'chat', repoName: null })).toThrow('intent');
    expect(() => validateRouteResult({ repoName: null })).toThrow('intent');
  });

  it('repoName不正はthrow', () => {
    expect(() => validateRouteResult({ intent: 'task', repoName: 123 })).toThrow('repoName');
  });

  it('オブジェクト以外はthrow', () => {
    expect(() => validateRouteResult('task')).toThrow('オブジェクト');
    expect(() => validateRouteResult(null)).toThrow('オブジェクト');
  });
});
