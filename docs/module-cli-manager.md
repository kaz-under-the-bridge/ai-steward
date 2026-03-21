# CLI Manager モジュール設計

## 責務

- Claude Code CLIプロセスの起動と管理
- セッション単位でのプロセス管理
- stdin書き込み（承認応答、追加入力）
- プロセス終了検知とクリーンアップ

## 境界

- CLIプロセスの生成と操作はこのモジュールに閉じる
- 出力データの解釈はStream Processorに委譲
- stdout/stderrのrawデータをEventEmitterで通知

## CLI実行方式

stream-json方式を採用。`child_process.spawn`でCLIを起動し、構造化JSONで入出力。

```typescript
// 新規セッション
spawn('claude', [
  '-p', prompt,
  '--output-format', 'stream-json',
  '--verbose',
], { cwd, env: { ...process.env, HOME: homeDir } });

// 対話継続
spawn('claude', [
  '-p', prompt,
  '--output-format', 'stream-json',
  '--verbose',
  '--continue',
  // または: '--resume', sessionId
], { cwd, env: { ...process.env, HOME: homeDir } });
```

## インターフェース

```typescript
interface CliManagerConfig {
  claudePath: string;              // default: 'claude'
  defaultCwd: string;
  homeDir: string;                 // Claude認証情報のHOME
  maxConcurrentSessions: number;   // default: 5
  idleTimeoutMs: number;           // default: 300000 (5分)
}

interface CliSession {
  sessionId: string;
  claudeSessionId: string | null;  // Claude CLIのセッションID（stream-jsonのinit eventから取得）
  pid: number;
  createdAt: Date;
  lastActivityAt: Date;
}

interface CliManager {
  spawn(params: {
    sessionId: string;
    prompt: string;
    cwd?: string;
    resumeSessionId?: string;      // 対話継続時
  }): Promise<CliSession>;

  write(sessionId: string, data: string): void;
  kill(sessionId: string): void;
  getSession(sessionId: string): CliSession | undefined;
  getActiveSessions(): CliSession[];

  on(event: 'data', listener: (sessionId: string, data: string) => void): void;
  on(event: 'exit', listener: (sessionId: string, exitCode: number) => void): void;
  on(event: 'error', listener: (sessionId: string, error: Error) => void): void;
}
```

## 対話継続

Claude CLIのセッションIDはstream-jsonの`init`イベントで取得:

```json
{"type":"system","subtype":"init","session_id":"36b2196c-..."}
```

このIDを保存し、次回メッセージで`--resume <session_id>`または`--continue`で継続。

## エラーハンドリング

| エラー | 対処 |
|--------|------|
| CLI起動失敗 | errorイベント発火、セッションをfailed状態に |
| CLI異常終了 | exitイベントにexitCode含めて通知 |
| 同時セッション上限超過 | エラーを返す |
| アイドルタイムアウト | プロセスkill、タイムアウト終了として通知 |

## 依存関係

- 外部: `child_process`（Node.js標準）
- 内部: なし
