import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createChildLogger } from '../logger.js';

const log = createChildLogger('state-manager');

export type SessionStatus =
  | 'queued'
  | 'running'
  | 'waiting_approval'
  | 'cancelled'
  | 'completed'
  | 'failed';

// 「実行中扱い」の状態（スレッド排他・cwd排他・再起動復旧の対象）
const ACTIVE_STATUSES = ['running', 'waiting_approval'] as const;

export interface Session {
  sessionId: string;
  channelId: string;
  threadTs: string;
  status: SessionStatus;
  claudeSessionId: string | null;
  cwd: string;
  createdAt: string;
  updatedAt: string;
}

// 承認待ちの永続化レコード（key: "sessionId:requestId"）
export interface PendingApprovalRecord {
  approvalKey: string;
  sessionId: string;
  requestId: string;
  channelId: string;
  threadTs: string;
  toolName: string;
  input: Record<string, unknown>;
  suggestions: unknown[];
  approvalMessageTs: string;
  createdAt: string;
}

export class StateManager {
  private db: Database.Database;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 5000');
    this.migrate();
  }

  // 順序付きマイグレーション。user_versionが指す位置から末尾まで適用する。
  // 既存DB（user_version=0でsessionsテーブルあり）にも適用できるよう、各SQLは冪等に書く
  private static readonly MIGRATIONS: string[] = [
    // v1: sessionsテーブル（初期スキーマ）
    `
      CREATE TABLE IF NOT EXISTS sessions (
        session_id        TEXT PRIMARY KEY,
        channel_id        TEXT NOT NULL,
        thread_ts         TEXT NOT NULL,
        status            TEXT NOT NULL DEFAULT 'running',
        claude_session_id TEXT,
        cwd               TEXT NOT NULL,
        created_at        TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_sessions_thread
        ON sessions (channel_id, thread_ts);
    `,
    // v2: 承認待ちの永続化（再起動復旧用）
    `
      CREATE TABLE IF NOT EXISTS pending_approvals (
        approval_key        TEXT PRIMARY KEY,
        session_id          TEXT NOT NULL,
        request_id          TEXT NOT NULL,
        channel_id          TEXT NOT NULL,
        thread_ts           TEXT NOT NULL,
        tool_name           TEXT NOT NULL,
        input_json          TEXT NOT NULL,
        suggestions_json    TEXT NOT NULL,
        approval_message_ts TEXT NOT NULL,
        created_at          TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_pending_approvals_session
        ON pending_approvals (session_id);
    `,
  ];

  private migrate(): void {
    const current = this.db.pragma('user_version', { simple: true }) as number;
    const migrations = StateManager.MIGRATIONS;
    if (current >= migrations.length) return;

    const apply = this.db.transaction(() => {
      for (let v = current; v < migrations.length; v++) {
        this.db.exec(migrations[v]);
      }
      this.db.pragma(`user_version = ${migrations.length}`);
    });
    apply();
    log.info({ from: current, to: migrations.length }, 'DBマイグレーション完了');
  }

  createSession(params: {
    sessionId: string;
    channelId: string;
    threadTs: string;
    cwd: string;
  }): Session {
    const stmt = this.db.prepare(`
      INSERT INTO sessions (session_id, channel_id, thread_ts, cwd)
      VALUES (?, ?, ?, ?)
    `);
    stmt.run(params.sessionId, params.channelId, params.threadTs, params.cwd);
    return this.getSession(params.sessionId)!;
  }

  getSession(sessionId: string): Session | undefined {
    const row = this.db.prepare('SELECT * FROM sessions WHERE session_id = ?').get(sessionId) as
      | Record<string, unknown>
      | undefined;
    return row ? this.toSession(row) : undefined;
  }

  getSessionByThread(channelId: string, threadTs: string): Session | undefined {
    const row = this.db
      .prepare(
        'SELECT * FROM sessions WHERE channel_id = ? AND thread_ts = ? ORDER BY created_at DESC LIMIT 1',
      )
      .get(channelId, threadTs) as Record<string, unknown> | undefined;
    return row ? this.toSession(row) : undefined;
  }

  hasRunningSessionByCwd(cwd: string): Session | undefined {
    const row = this.db
      .prepare(
        `SELECT * FROM sessions WHERE cwd = ? AND status IN (${ACTIVE_STATUSES.map(() => '?').join(',')}) LIMIT 1`,
      )
      .get(cwd, ...ACTIVE_STATUSES) as Record<string, unknown> | undefined;
    return row ? this.toSession(row) : undefined;
  }

  getLatestCompletedSessionByCwd(cwd: string): Session | undefined {
    const row = this.db
      .prepare(
        "SELECT * FROM sessions WHERE cwd = ? AND status = 'completed' AND claude_session_id IS NOT NULL ORDER BY created_at DESC LIMIT 1",
      )
      .get(cwd) as Record<string, unknown> | undefined;
    return row ? this.toSession(row) : undefined;
  }

  updateStatus(sessionId: string, status: SessionStatus): void {
    this.db
      .prepare("UPDATE sessions SET status = ?, updated_at = datetime('now') WHERE session_id = ?")
      .run(status, sessionId);
  }

  updateClaudeSessionId(sessionId: string, claudeSessionId: string): void {
    this.db
      .prepare(
        "UPDATE sessions SET claude_session_id = ?, updated_at = datetime('now') WHERE session_id = ?",
      )
      .run(claudeSessionId, sessionId);
  }

  getActiveSessionByThread(channelId: string, threadTs: string): Session | undefined {
    const row = this.db
      .prepare(
        `SELECT * FROM sessions WHERE channel_id = ? AND thread_ts = ? AND status IN (${ACTIVE_STATUSES.map(() => '?').join(',')}) LIMIT 1`,
      )
      .get(channelId, threadTs, ...ACTIVE_STATUSES) as Record<string, unknown> | undefined;
    return row ? this.toSession(row) : undefined;
  }

  listSessionsByStatus(status: SessionStatus): Session[] {
    const rows = this.db
      .prepare('SELECT * FROM sessions WHERE status = ? ORDER BY created_at')
      .all(status) as Record<string, unknown>[];
    return rows.map((row) => this.toSession(row));
  }

  // --- 承認待ちの永続化 ---

  createPendingApproval(record: Omit<PendingApprovalRecord, 'createdAt'>): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO pending_approvals
           (approval_key, session_id, request_id, channel_id, thread_ts,
            tool_name, input_json, suggestions_json, approval_message_ts)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.approvalKey,
        record.sessionId,
        record.requestId,
        record.channelId,
        record.threadTs,
        record.toolName,
        JSON.stringify(record.input),
        JSON.stringify(record.suggestions),
        record.approvalMessageTs,
      );
  }

  getPendingApproval(approvalKey: string): PendingApprovalRecord | undefined {
    const row = this.db
      .prepare('SELECT * FROM pending_approvals WHERE approval_key = ?')
      .get(approvalKey) as Record<string, unknown> | undefined;
    return row ? this.toPendingApproval(row) : undefined;
  }

  listPendingApprovalsBySession(sessionId: string): PendingApprovalRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM pending_approvals WHERE session_id = ? ORDER BY created_at')
      .all(sessionId) as Record<string, unknown>[];
    return rows.map((row) => this.toPendingApproval(row));
  }

  deletePendingApproval(approvalKey: string): void {
    this.db.prepare('DELETE FROM pending_approvals WHERE approval_key = ?').run(approvalKey);
  }

  deletePendingApprovalsBySession(sessionId: string): void {
    this.db.prepare('DELETE FROM pending_approvals WHERE session_id = ?').run(sessionId);
  }

  close(): void {
    this.db.close();
  }

  private toPendingApproval(row: Record<string, unknown>): PendingApprovalRecord {
    return {
      approvalKey: row.approval_key as string,
      sessionId: row.session_id as string,
      requestId: row.request_id as string,
      channelId: row.channel_id as string,
      threadTs: row.thread_ts as string,
      toolName: row.tool_name as string,
      input: JSON.parse(row.input_json as string) as Record<string, unknown>,
      suggestions: JSON.parse(row.suggestions_json as string) as unknown[],
      approvalMessageTs: row.approval_message_ts as string,
      createdAt: row.created_at as string,
    };
  }

  private toSession(row: Record<string, unknown>): Session {
    return {
      sessionId: row.session_id as string,
      channelId: row.channel_id as string,
      threadTs: row.thread_ts as string,
      status: row.status as SessionStatus,
      claudeSessionId: (row.claude_session_id as string) || null,
      cwd: row.cwd as string,
      createdAt: row.created_at as string,
      updatedAt: row.updated_at as string,
    };
  }
}
