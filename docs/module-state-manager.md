# State Manager モジュール設計

## 責務

- SQLiteによるセッション状態の永続化
- Thread TS ↔ セッション情報の紐付け管理
- Bot再起動時の状態参照

## 境界

- SQLiteアクセスは全てこのモジュールに閉じる
- 他モジュールはDBスキーマを意識しない

## インターフェース

```typescript
interface StateManagerConfig {
  dbPath: string;  // default: './data/steward.db'
}

type SessionStatus =
  | 'running'
  | 'waiting_approval'
  | 'completed'
  | 'failed'
  | 'timeout';

interface Session {
  sessionId: string;
  channelId: string;
  threadTs: string;
  status: SessionStatus;
  prompt: string;
  cwd: string;
  pid: number | null;
  claudeSessionId: string | null;  // Claude CLIのセッションID
  createdAt: string;               // ISO 8601
  updatedAt: string;
  completedAt: string | null;
}

interface StateManager {
  initialize(): Promise<void>;

  createSession(params: {
    sessionId: string;
    channelId: string;
    threadTs: string;
    prompt: string;
    cwd: string;
    pid: number;
  }): Session;

  getSession(sessionId: string): Session | undefined;
  getSessionByThread(channelId: string, threadTs: string): Session | undefined;
  updateStatus(sessionId: string, status: SessionStatus): void;
  updateClaudeSessionId(sessionId: string, claudeSessionId: string): void;

  getActiveSessions(): Session[];
  markStaleSessionsFailed(): number;

  close(): void;
}
```

## SQLiteスキーマ

```sql
CREATE TABLE IF NOT EXISTS sessions (
  session_id         TEXT PRIMARY KEY,
  channel_id         TEXT NOT NULL,
  thread_ts          TEXT NOT NULL,
  status             TEXT NOT NULL DEFAULT 'running',
  prompt             TEXT NOT NULL,
  cwd                TEXT NOT NULL,
  pid                INTEGER,
  claude_session_id  TEXT,
  created_at         TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at         TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at       TEXT
);

CREATE INDEX IF NOT EXISTS idx_sessions_thread
  ON sessions (channel_id, thread_ts);

CREATE INDEX IF NOT EXISTS idx_sessions_status
  ON sessions (status);
```

## WALモード

```typescript
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 5000');
```

## Bot再起動時の処理

`initialize()`で残存するrunningセッションをfailedに変更（ptyプロセスは消滅済み）。

## エラーハンドリング

| エラー | 対処 |
|--------|------|
| DBファイル作成失敗 | プロセス起動失敗（致命的） |
| SQLITE_BUSY | busy_timeout=5000msで自動リトライ |

## 依存関係

- 外部: `better-sqlite3`
- 内部: なし
