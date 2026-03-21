# ai-steward

Slack連携のClaude Codeエージェントブリッジ。Slackメッセージをトリガーに
Claude Code CLIをstream-jsonモードで実行し、結果をSlackスレッドに返す。

## 技術スタック

- TypeScript / Node.js 22.x
- @slack/bolt (Socket Mode)
- child_process.spawn (claude CLI, stream-json入出力)
- better-sqlite3 (SQLite, WALモード, セッション永続化)
- 実行環境: ai-commander VM (Ubuntu 24.04, systemd)

## プロジェクト構成

```
src/
├── index.ts              エントリーポイント（dotenv読み込み、graceful shutdown）
├── orchestrator.ts       モジュール間接続、承認フロー、画像対応、進捗更新
├── config.ts             環境変数読み込み・バリデーション
├── logger.ts             pino ロガー
├── types.ts              共通型定義（IncomingMessage, StreamEvent, SlackFile, ApprovalAction）
├── repo-resolver.ts      メッセージ中のリポ名→cwdパス解決（findでgit root探索）
├── slack-bot/
│   └── index.ts          @slack/bolt Socket Mode、メッセージ・ファイル添付受信、Block Kitアクション
├── cli-manager/
│   └── index.ts          child_process.spawn、--resume対話継続、--allowedTools承認後再実行
├── stream-processor/
│   └── index.ts          NDJSONパース、init/assistant/tool_use/permission_denied/result分類
├── formatter/
│   └── index.ts          @anthropic-ai/sdk Haiku API要約、フォールバック、メッセージ分割
└── state-manager/
    └── index.ts          better-sqlite3、セッションCRUD、staleクリーンアップ
```

### デプロイ構成

- systemdサービス: `/etc/systemd/system/ai-steward.service`
- 環境変数: `~/.config/ai-steward/env`
- Ansibleロール: ouchi-server `ansible/roles/ai_steward/`
- 適用: `cd ouchi-server/ansible && make local`
- ログ: `sudo journalctl -u ai-steward -f`

## 開発ガイドライン

### コーディング規約

- TypeScript strict mode
- ESM (`"type": "module"` in package.json)
- フォーマッター: prettier（デフォルト設定）
- テスト: vitest

### モジュール設計

- 各モジュールは `index.ts` でクラスまたはファクトリ関数をexport
- モジュール間の依存は orchestrator.ts 経由の依存注入
- モジュール同士を直接importしない
- 非同期通知はEventEmitterパターン
- repo-resolver.ts は例外的にスタンドアロン関数（orchestratorから直接呼び出し）

### CLI実行方式

Claude Code CLIは `child_process.spawn` で起動。`node-pty` は不使用。

```bash
# 新規セッション
claude -p "<prompt>" --output-format stream-json --verbose

# 対話継続（同一Slackスレッド内の2通目以降）
claude -p "<prompt>" --resume <claude_session_id> --output-format stream-json --verbose
```

stream-json出力はNDJSON形式（1行1JSONオブジェクト）。主要イベント型:
- `{"type":"system","subtype":"init","session_id":"..."}` → セッションID取得
- `{"type":"assistant","message":{"content":[{"type":"text","text":"..."}]}}` → テキスト応答
- `{"type":"result","result":"...","is_error":false}` → 実行完了

### 日本語

- コミットメッセージ: 日本語
- コメント: 日本語
- 変数名/関数名: 英語
- ログメッセージ: 日本語

### 環境変数

| 変数 | 必須 | 説明 |
|------|------|------|
| SLACK_BOT_TOKEN | Yes | Slack Bot Token (xoxb-...) |
| SLACK_APP_TOKEN | Yes | Slack App Token (xapp-...) |
| SLACK_SIGNING_SECRET | Yes | Slack Signing Secret |
| ALLOWED_CHANNEL_IDS | Yes | 許可チャンネルID（カンマ区切り） |
| ANTHROPIC_API_KEY | No | Anthropic API Key (Formatter用、MVP3以降) |
| CLAUDE_HOME | No | Claude認証情報のHOMEパス (default: $HOME) |
| CLAUDE_CWD | No | デフォルト作業ディレクトリ (default: /home/kaz/git) |
| DB_PATH | No | SQLiteファイルパス (default: ./data/steward.db) |
| LOG_LEVEL | No | ログレベル (default: info) |

### ビルド・実行

```bash
npm install         # 依存インストール
npm run build       # TypeScriptビルド
npm run dev         # 開発モード（tsx watch）
npm run test        # テスト実行
npm start           # 本番実行
```

### デプロイ

ouchi-serverリポジトリのAnsibleロールでデプロイ（MVP7で構築予定）。

## 設計ドキュメント

- [アーキテクチャ概要](docs/architecture-overview.md)
- [実装計画](docs/implementation-plan.md)
- [Slack Bot](docs/module-slack-bot.md)
- [CLI Manager](docs/module-cli-manager.md)
- [Stream Processor](docs/module-stream-processor.md)
- [Formatter](docs/module-formatter.md)
- [State Manager](docs/module-state-manager.md)
- [Approval Flow](docs/module-approval-flow.md)
