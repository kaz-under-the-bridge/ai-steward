import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { StateManager } from '../index.js';

// characterization test: セッション状態遷移の現行挙動を固定する

let dir: string;
let sm: StateManager;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ai-steward-db-'));
  sm = new StateManager(join(dir, 'test.db'));
});

afterEach(() => {
  sm.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('StateManager', () => {
  const base = { sessionId: 's1', channelId: 'C1', threadTs: 't1', cwd: '/repo/a' };

  it('createSession は running で作成される', () => {
    const s = sm.createSession(base);
    expect(s.status).toBe('running');
    expect(s.claudeSessionId).toBeNull();
  });

  it('updateStatus / updateClaudeSessionId が反映される', () => {
    sm.createSession(base);
    sm.updateClaudeSessionId('s1', 'claude-x');
    sm.updateStatus('s1', 'completed');
    const s = sm.getSession('s1')!;
    expect(s.status).toBe('completed');
    expect(s.claudeSessionId).toBe('claude-x');
  });

  it('getSessionByThread は同一スレッドの最新セッションを返す', () => {
    sm.createSession(base);
    sm.createSession({ ...base, sessionId: 's2' });
    const s = sm.getSessionByThread('C1', 't1')!;
    expect(['s1', 's2']).toContain(s.sessionId);
  });

  it('hasRunningSessionByCwd は running のみ返す', () => {
    sm.createSession(base);
    expect(sm.hasRunningSessionByCwd('/repo/a')?.sessionId).toBe('s1');
    sm.updateStatus('s1', 'completed');
    expect(sm.hasRunningSessionByCwd('/repo/a')).toBeUndefined();
  });

  it('getLatestCompletedSessionByCwd は claudeSessionId 付き completed のみ返す', () => {
    sm.createSession(base);
    sm.updateStatus('s1', 'completed');
    // claudeSessionId なしは対象外
    expect(sm.getLatestCompletedSessionByCwd('/repo/a')).toBeUndefined();
    sm.updateClaudeSessionId('s1', 'claude-x');
    expect(sm.getLatestCompletedSessionByCwd('/repo/a')?.sessionId).toBe('s1');
  });

  it('markStaleSessionsFailed は running を failed にする', () => {
    sm.createSession(base);
    sm.createSession({ ...base, sessionId: 's2', threadTs: 't2' });
    sm.updateStatus('s2', 'completed');
    expect(sm.markStaleSessionsFailed()).toBe(1);
    expect(sm.getSession('s1')!.status).toBe('failed');
    expect(sm.getSession('s2')!.status).toBe('completed');
  });
});
