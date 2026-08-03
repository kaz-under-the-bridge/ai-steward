# State Manager モジュール設計

## 責務

- SQLiteによるセッション状態の永続化
- Thread TS ↔ セッション情報の紐付け管理
- 承認待ち（pending approval）の永続化（再起動復旧用）
- 順序付きスキーママイグレーション（`PRAGMA user_version`）

## 境界

- SQLiteアクセスは全てこのモジュールに閉じる
- 他モジュールはDBスキーマを意識しない

## インターフェース

```typescript
type SessionStatus =
  | 'queued'            // 予約（同時実行上限のキュー待ち、Step 2後半で使用予定）
  | 'running'
  | 'waiting_approval'  // Slack承認ボタン表示中
  | 'cancelled'         // ユーザーの中断キーワードによる停止
  | 'completed'
  | 'failed';

interface Session {
  sessionId: string;
  channelId: string;
  threadTs: string;
  status: SessionStatus;
  claudeSessionId: string | null;  // Claude CLIのセッションID（--resume用）
  cwd: string;
  createdAt: string;
  updatedAt: string;
}

interface PendingApprovalRecord {
  approvalKey: string;             // "sessionId:requestId"
  sessionId: string;
  requestId: string;
  channelId: string;
  threadTs: string;
  toolName: string;
  input: Record<string, unknown>;      // JSON列に保存
  suggestions: unknown[];              // permission_suggestions（JSON列に保存）
  approvalMessageTs: string;           // Slackボタンメッセージの更新用TS
  createdAt: string;
}

class StateManager {
  constructor(dbPath: string);

  // sessions
  createSession(params): Session;
  getSession(sessionId): Session | undefined;
  getSessionByThread(channelId, threadTs): Session | undefined;
  getActiveSessionByThread(channelId, threadTs): Session | undefined;  // running / waiting_approval
  hasRunningSessionByCwd(cwd): Session | undefined;                    // running / waiting_approval
  getLatestCompletedSessionByCwd(cwd): Session | undefined;
  updateStatus(sessionId, status): void;
  updateClaudeSessionId(sessionId, claudeSessionId): void;
  listSessionsByStatus(status): Session[];

  // pending approvals
  createPendingApproval(record): void;
  getPendingApproval(approvalKey): PendingApprovalRecord | undefined;
  listPendingApprovalsBySession(sessionId): PendingApprovalRecord[];
  deletePendingApproval(approvalKey): void;
  deletePendingApprovalsBySession(sessionId): void;

  close(): void;
}
```

## マイグレーション

`PRAGMA user_version` を適用済みマイグレーション数として使う。起動時に
`user_version` から `MIGRATIONS` 配列の末尾までを1トランザクションで適用する。

- 各マイグレーションSQLは冪等に書く（`IF NOT EXISTS`）。`user_version=0` の既存DB
  （マイグレーション導入前に作られたDB）にもそのまま適用できる
- v1: `sessions` テーブル + `idx_sessions_thread`
- v2: `pending_approvals` テーブル + `idx_pending_approvals_session`

## WALモード

```typescript
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 5000');
```

## Bot再起動時の処理

orchestrator の `recoverAfterRestart()` から利用される:

- `listSessionsByStatus('running')` → 中断をスレッドに通知して failed 化
- `listSessionsByStatus('waiting_approval')` → 承認レコードがあれば温存
  （ボタン押下時に `--resume` で復旧）、なければ failed 化して通知

## エラーハンドリング

| エラー | 対処 |
|--------|------|
| DBファイル作成失敗 | プロセス起動失敗（致命的） |
| SQLITE_BUSY | busy_timeout=5000msで自動リトライ |

## 依存関係

- 外部: `better-sqlite3`
- 内部: なし
