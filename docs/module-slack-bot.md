# Slack Bot モジュール設計

## 責務

- @slack/bolt によるSlackイベント受信（Socket Mode）
- メッセージの種類判定（新規セッション or 既存スレッド継続）
- Slackスレッドへのメッセージ投稿（テキスト、Block Kit）
- Block Kit action（承認ボタン）の受信とルーティング

## 境界

- Slack APIとの通信は全てこのモジュールに閉じる
- 他モジュールはSlack APIを直接呼ばない
- メッセージ内容のビジネスロジック（要約、承認判定等）は持たない

## インターフェース

### 初期化

```typescript
interface SlackBotConfig {
  botToken: string;        // xoxb-...
  appToken: string;        // xapp-...
  signingSecret: string;
  allowedChannelIds: string[];
}
```

### イベントハンドラ（外部から注入）

```typescript
interface SlackEventHandlers {
  onMessage(event: IncomingMessage): Promise<void>;
  onApprovalAction(event: ApprovalAction): Promise<void>;
}

interface IncomingMessage {
  channelId: string;
  threadTs: string;       // スレッドの親TS（新規の場合はメッセージ自体のTS）
  messageTs: string;
  userId: string;
  text: string;
}

interface ApprovalAction {
  channelId: string;
  threadTs: string;
  userId: string;
  actionId: 'approve' | 'reject';
  messageTs: string;      // ボタンメッセージTS（更新用）
  sessionId: string;
}
```

### 送信API

```typescript
interface SlackBot {
  start(): Promise<void>;
  stop(): Promise<void>;

  postMessage(params: {
    channelId: string;
    threadTs: string;
    text: string;
    blocks?: Block[];
  }): Promise<{ ts: string }>;

  updateMessage(params: {
    channelId: string;
    ts: string;
    text: string;
    blocks?: Block[];
  }): Promise<void>;

  postApprovalRequest(params: {
    channelId: string;
    threadTs: string;
    context: string;
    sessionId: string;
  }): Promise<{ ts: string }>;
}
```

## Slackイベントのフィルタリング

- Bot自身のメッセージ（subtype: 'bot_message'）は無視
- `allowedChannelIds`に含まれないチャンネルは無視
- スレッド外メッセージ → 新規セッション開始
- スレッド内メッセージ → 既存セッション継続（不在時は無視）

## Block Kit: 承認ボタン

```typescript
function buildApprovalBlocks(context: string, sessionId: string): Block[] {
  return [
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `*承認が必要です*\n${context}` }
    },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: '承認 (y)' },
          style: 'primary',
          action_id: 'approve',
          value: sessionId
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: '拒否 (N)' },
          style: 'danger',
          action_id: 'reject',
          value: sessionId
        }
      ]
    }
  ];
}
```

## エラーハンドリング

| エラー | 対処 |
|--------|------|
| Socket Mode切断 | @slack/boltの自動再接続。失敗時はプロセス終了（systemd再起動） |
| Slack API rate limit | @slack/bolt組み込みの指数バックオフリトライ |
| メッセージ投稿失敗 | ログ出力、処理継続 |
| action受信時にセッション不在 | ボタンを「セッション終了済み」に更新 |

## 依存関係

- 外部: `@slack/bolt`
- 内部: なし（ハンドラ注入で疎結合）
