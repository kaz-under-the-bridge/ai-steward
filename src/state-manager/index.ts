import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createChildLogger } from '../logger.js';

const log = createChildLogger('state-manager');

export type SessionStatus = 'running' | 'completed' | 'failed';

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

export class StateManager {
  private db: Database.Database;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 5000');
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
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
    `);
    log.info('DBマイグレーション完了');
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
        "SELECT * FROM sessions WHERE cwd = ? AND status = 'running' LIMIT 1",
      )
      .get(cwd) as Record<string, unknown> | undefined;
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
        "SELECT * FROM sessions WHERE channel_id = ? AND thread_ts = ? AND status = 'running' LIMIT 1",
      )
      .get(channelId, threadTs) as Record<string, unknown> | undefined;
    return row ? this.toSession(row) : undefined;
  }

  markStaleSessionsFailed(): number {
    const result = this.db
      .prepare("UPDATE sessions SET status = 'failed', updated_at = datetime('now') WHERE status = 'running'")
      .run();
    return result.changes;
  }

  close(): void {
    this.db.close();
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
