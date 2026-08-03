# CLI Manager モジュール設計

## 責務

- Claude Code CLIプロセスの起動と管理（1スレッド = 1常駐プロセス）
- 双方向stream-jsonでのメッセージ投入（userメッセージ、control_response）
- アイドルタイムアウトによるプロセス回収
- プロセス終了検知とクリーンアップ

## 境界

- CLIプロセスの生成と操作はこのモジュールに閉じる
- 出力データの解釈はStream Processorに委譲
- stdout/stderrのrawデータをEventEmitterで通知

## CLI実行方式

双方向stream-json方式。stdinを開いたまま維持し、複数のuserメッセージと承認応答を
同一プロセスに投入する。

```typescript
spawn('claude', [
  '-p',
  '--input-format', 'stream-json',
  '--output-format', 'stream-json',
  '--verbose',
  '--model', 'claude-fable-5',
  '--effort', 'low',
  // 権限要求をcontrol_request(can_use_tool)としてstdioで受ける（help非掲載フラグ）
  '--permission-prompt-tool', 'stdio',
  '--permission-mode', 'default',   // RepoConfigで上書き可
  // 再開時: '--resume', claudeSessionId
], { cwd, env: { ...envWithoutApiKey, HOME: homeDir } });
```

stdin投入メッセージ:

```json
{"type":"user","message":{"role":"user","content":[{"type":"text","text":"..."}]}}
{"type":"control_response","response":{"subtype":"success","request_id":"...","response":{"behavior":"allow","updatedInput":{...}}}}
```

## インターフェース

```typescript
interface CliManagerConfig {
  claudePath: string;      // default: 'claude'
  defaultCwd: string;
  homeDir: string;         // Claude認証情報のHOME
  idleTimeoutMs?: number;  // default: 600000 (10分)
}

type PermissionResponse =
  | { behavior: 'allow'; updatedInput: Record<string, unknown>; updatedPermissions?: unknown[] }
  | { behavior: 'deny'; message: string };

class CliManager extends EventEmitter {
  spawnSession(params: {
    sessionId: string;
    prompt: string;
    cwd?: string;
    resumeClaudeSessionId?: string;
    repoConfig?: RepoConfig;
  }): Promise<CliSession>;

  sendUserMessage(sessionId: string, text: string): boolean;       // 常駐プロセスへ追送
  sendControlResponse(sessionId: string, requestId: string, response: PermissionResponse): boolean;
  markIdle(sessionId: string): void;    // アイドルタイマー開始（result後・承認待ち）
  markBusy(sessionId: string): void;    // タイマー解除（送信時に自動で呼ばれる）
  terminate(sessionId: string): void;   // 意図的終了（exitはcode 0扱い）
  hasSession(sessionId: string): boolean;
  getActiveSessions(): CliSession[];

  on(event: 'data', listener: (sessionId: string, data: string) => void): void;
  on(event: 'exit', listener: (sessionId: string, exitCode: number) => void): void;
  on(event: 'error', listener: (sessionId: string, error: Error) => void): void;
}
```

## ライフサイクル

1. spawnSession → 最初のuserメッセージをstdin投入（stdinは閉じない）
2. result受信後もプロセスは常駐。orchestratorがmarkIdleを呼びタイマー開始
3. 同一スレッドの次メッセージはsendUserMessageで同一プロセスへ（タイマー解除）
4. アイドルタイムアウトでterminate → 次メッセージは `--resume <claudeSessionId>` で新規プロセス再開

## エラーハンドリング

| エラー | 対処 |
|--------|------|
| CLI起動失敗 | errorイベント発火、セッションをfailed状態に |
| CLI異常終了 | exitイベントにexitCode含めて通知 |
| 意図的終了（terminate） | exitイベントをcode 0で通知（エラー扱いしない） |
| 消滅済みセッションへの送信 | falseを返す（呼び出し元で--resume再開にフォールバック） |

## 依存関係

- 外部: `child_process`（Node.js標準）
- 内部: なし
