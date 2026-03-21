# Approval Flow モジュール設計

## 責務

- 承認プロンプトのコンテキスト抽出
- Block Kitボタンの内容生成
- ユーザー応答の処理とCLI入力への変換
- 承認タイムアウト管理

## 境界

- Stream Processorからの承認イベントを受ける
- Slack BotへBlock Kit送信を依頼（直接Slack API不使用）
- CLI Managerへstdin書き込みを依頼

## インターフェース

```typescript
interface ApprovalFlowConfig {
  timeoutMs: number;  // default: 300000 (5分)
}

interface PendingApproval {
  sessionId: string;
  channelId: string;
  threadTs: string;
  context: string;
  messageTs: string;     // Block KitメッセージTS
  createdAt: Date;
  timer: NodeJS.Timeout;
}

interface ApprovalFlow {
  requestApproval(params: {
    sessionId: string;
    channelId: string;
    threadTs: string;
    promptContent: string;
  }): Promise<void>;

  handleResponse(params: {
    sessionId: string;
    approved: boolean;
    userId: string;
  }): Promise<void>;

  cancelPending(sessionId: string): void;
  getPending(sessionId: string): PendingApproval | undefined;
}
```

## 承認タイムアウト

タイムアウト時は自動拒否（N）を送信し、Slack上のボタンを「タイムアウト（自動拒否）」に更新。

## ユーザー応答処理

1. タイマーキャンセル
2. CLI Managerにy/N送信
3. State Manager状態更新
4. Slackメッセージ更新（ボタン→結果テキスト）

## 承認イベントの検知方法

stream-jsonモードでの承認イベントの形式はMVP4で実機検証して確定する。
考えられるパターン:
- 専用のJSONイベント型（permission_request等）
- assistantメッセージ内のテキストパターン（(y/N)等）

## エラーハンドリング

| エラー | 対処 |
|--------|------|
| 応答時にセッション不在 | Slackメッセージを「終了済み」に更新 |
| ボタン二重クリック | pending不在なら無視 |
| タイムアウト+応答の競合 | Map.deleteで排他（シングルスレッド） |

## 依存関係

- 外部: なし
- 内部: Slack Bot, CLI Manager, State Manager（依存注入で受け取る）
