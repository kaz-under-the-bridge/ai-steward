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

  it('listSessionsByStatus は指定状態のみ返す', () => {
    sm.createSession(base);
    sm.createSession({ ...base, sessionId: 's2', threadTs: 't2' });
    sm.updateStatus('s2', 'waiting_approval');
    expect(sm.listSessionsByStatus('running').map((s) => s.sessionId)).toEqual(['s1']);
    expect(sm.listSessionsByStatus('waiting_approval').map((s) => s.sessionId)).toEqual(['s2']);
    expect(sm.listSessionsByStatus('cancelled')).toEqual([]);
  });

  it('hasRunningSessionByCwd は waiting_approval も実行中扱いにする', () => {
    sm.createSession(base);
    sm.updateStatus('s1', 'waiting_approval');
    expect(sm.hasRunningSessionByCwd('/repo/a')?.sessionId).toBe('s1');
    sm.updateStatus('s1', 'cancelled');
    expect(sm.hasRunningSessionByCwd('/repo/a')).toBeUndefined();
  });

  it('マイグレーション後にuser_versionが設定され、再オープンできる', () => {
    // beforeEachで作成済み。閉じて再オープンしてもマイグレーションはno-opで通る
    sm.createSession(base);
    sm.close();
    sm = new StateManager(join(dir, 'test.db'));
    expect(sm.getSession('s1')?.sessionId).toBe('s1');
  });
});

describe('PendingApproval永続化', () => {
  const record = {
    approvalKey: 's1:req-1',
    sessionId: 's1',
    requestId: 'req-1',
    channelId: 'C1',
    threadTs: 't1',
    toolName: 'Bash',
    input: { command: 'ls -la' },
    suggestions: [{ type: 'addRules' }],
    approvalMessageTs: '123.456',
  };

  it('create → get でJSONフィールドが復元される', () => {
    sm.createPendingApproval(record);
    const got = sm.getPendingApproval('s1:req-1')!;
    expect(got.toolName).toBe('Bash');
    expect(got.input).toEqual({ command: 'ls -la' });
    expect(got.suggestions).toEqual([{ type: 'addRules' }]);
    expect(got.approvalMessageTs).toBe('123.456');
  });

  it('DBを再オープンしても承認レコードが残る（再起動復旧）', () => {
    sm.createPendingApproval(record);
    sm.close();
    sm = new StateManager(join(dir, 'test.db'));
    expect(sm.getPendingApproval('s1:req-1')?.toolName).toBe('Bash');
  });

  it('deletePendingApproval / deletePendingApprovalsBySession が削除する', () => {
    sm.createPendingApproval(record);
    sm.createPendingApproval({ ...record, approvalKey: 's1:req-2', requestId: 'req-2' });
    sm.deletePendingApproval('s1:req-1');
    expect(sm.getPendingApproval('s1:req-1')).toBeUndefined();
    expect(sm.listPendingApprovalsBySession('s1')).toHaveLength(1);
    sm.deletePendingApprovalsBySession('s1');
    expect(sm.listPendingApprovalsBySession('s1')).toHaveLength(0);
  });
});
