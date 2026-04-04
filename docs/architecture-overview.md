# ai-steward アーキテクチャ概要

## 概要

ai-stewardは、SlackメッセージをトリガーにClaude Code CLIを実行し、結果をSlackスレッドに返すエージェントブリッジ。OpenClaw（サードパーティ製、セキュリティリスクで2026-02-20廃止）の自作代替。

「Steward（執事長）」の名の通り、Slackから指示を出すだけで自律的にコード作業を遂行する。

## 実装状況

| コンポーネント | 状態 | 備考 |
|---------------|------|------|
| Slack Bot (Socket Mode) | 実装済み | メッセージ受信・スレッド返信・Block Kitアクション・ファイル添付対応 |
| CLI Manager (stream-json) | 実装済み | ワンショット実行・`--resume`対話継続・`--allowedTools`承認後再実行 |
| Stream Processor | 実装済み | NDJSONパース、init/assistant/tool_use/permission_denied/result分類 |
| Repo Resolver | 実装済み | メッセージからリポジトリ名を自動解決（findキャッシュ） |
| State Manager (SQLite) | 実装済み | セッション永続化、対話継続用session ID保持 |
| Orchestrator | 実装済み | モジュール間接続、重複排除、承認フロー、画像対応、進捗更新 |
| Approval Flow (Block Kit) | 実装済み | 権限エラー検知→承認ボタン→`--resume --allowedTools`で再実行 |
| 画像対応 (Slack→Claude) | 実装済み | Slackファイル添付→`/tmp/ai-steward-files/`にダウンロード→`--add-dir`でClaude Code Read |
| 進捗ストリーミング | 実装済み | tool_useイベントで「実行中...」メッセージを逐次更新（2秒debounce） |
| Formatter (Haiku API) | 実装済み | `claude-haiku-4-5-20251001`で500文字以上を要約、フォールバック付き |
| systemdデプロイ | 実装済み | Ansibleロール`ai_steward`、`make local`で適用 |

## システムアーキテクチャ

```
┌─────────────┐  Socket Mode   ┌──────────────────────────────────────────────┐
│   Slack      │ ◄────────────► │  ai-commander VM (192.168.1.221)             │
│              │                │                                              │
│  ユーザー     │                │  ai-steward (systemd service)                │
│  メッセージ   │                │  ┌──────────────────────────────────────────┐ │
│              │                │  │           Slack Bot                      │ │
│  スレッド返信  │                │  │    (@slack/bolt, Socket Mode)            │ │
│              │                │  └─────┬──────────────────────▲─────────────┘ │
│  Block Kit   │                │        │                     │               │
│  承認ボタン   │                │        ▼                     │               │
└─────────────┘                │  ┌──────────────┐  ┌─────────┴─────────────┐ │
                               │  │ Repo         │  │    Formatter          │ │
                               │  │ Resolver     │  │  (Haiku API 要約)     │ │
                               │  └──────┬───────┘  └─────────▲─────────────┘ │
                               │         │                    │               │
                               │         ▼                    │               │
                               │  ┌────────────────────────────────────────┐  │
                               │  │         CLI Manager                    │  │
                               │  │  (child_process.spawn, stream-json)    │  │
                               │  │  新規: claude -p --output-format ...   │  │
                               │  │  継続: claude -p --resume <session_id> │  │
                               │  └─────┬──────────────────────────────────┘  │
                               │        │                                     │
                               │        ▼                                     │
                               │  ┌────────────────────────────────────────┐  │
                               │  │       Stream Processor                 │  │
                               │  │  (NDJSONパース, イベント分類)           │  │
                               │  └────────────────────────────────────────┘  │
                               │                                              │
                               │  ┌────────────────────────────────────────┐  │
                               │  │       State Manager (SQLite)           │  │
                               │  │  (セッション永続化, --resume用ID保持)   │  │
                               │  └────────────────────────────────────────┘  │
                               └──────────────────────────────────────────────┘
```

## データフロー

### 通常フロー（実装済み）

1. ユーザーがSlackチャンネルにメッセージ投稿
2. Slack Bot がSocket Mode経由で受信、許可チャンネルをフィルタ
3. Repo Resolver がメッセージ中のリポジトリ名を解決（「ouchi-serverで〜」→ cwdを決定）
4. State Manager でスレッドTSに対応する過去セッションを検索
   - 新規: CLI Manager が `claude -p "<prompt>" --output-format stream-json --verbose` を起動
   - 既存: `--resume <claude_session_id>` を付与して対話継続
5. Stream Processor がstream-json出力をパース（NDJSON、1行1JSON）
   - init → Claude CLIセッションIDを取得・永続化
   - assistant → テキスト出力をバッファに蓄積
   - result → 最終結果をSlackスレッドに投稿
6. State Manager がセッション状態を更新（completed / failed）

### 対話継続フロー（実装済み）

```
スレッド内1通目: claude -p "..." --output-format stream-json --verbose
  → init event から claude_session_id を取得
  → SQLiteに channelId:threadTs ↔ claude_session_id を保存

スレッド内2通目: claude -p "..." --resume <claude_session_id> --output-format stream-json --verbose
  → 前回の文脈を引き継いで応答
```

### リポジトリ解決フロー（実装済み）

```
「ouchi-serverのREADMEを教えて」
  → /home/kaz/git 配下を find で探索（起動時キャッシュ）
  → ディレクトリ名 "ouchi-server" にマッチ
  → cwd = /home/kaz/git/github.com/under-the-bridge-hq/ouchi-server
  → Claude CodeがそのリポのCLAUDE.mdやgitコンテキストで動作
```

### 承認フロー（実装済み）

`-p`モードでは対話的な(y/N)プロンプトは発生しない。代わりに権限エラーとして処理：

1. Claude Codeがツール使用を試みる（Write, Bash等）
2. 権限不足で`type=user`, `is_error: true`, `"Claude requested permissions to ..."`が返る
3. Claude Codeが数回リトライ後、「権限を許可して」で終了
4. Stream Processorが`permission_denied`イベントとして検知
5. OrchestratorがSlackにBlock Kit承認/拒否ボタンを投稿
6. ユーザーが承認 → `--resume <session_id> --allowedTools <tool>`で再実行
7. ユーザーが拒否 → ボタンを更新して終了

### セッションライフサイクル

```
メッセージ受信 → セッション作成(running) → CLI起動
    ↓
出力受信中(running) ←→ 承認待ち(waiting_approval) [未実装]
    ↓
CLI終了検知 → セッション終了(completed / failed)
    ↓
同一スレッドで追加メッセージ → --resume で対話継続（新セッション作成）
```

## モジュール構成

| モジュール | 責務 | 状態 | 主要依存 |
|-----------|------|------|---------|
| Slack Bot | Slack通信、メッセージルーティング | 実装済み | @slack/bolt |
| CLI Manager | CLIプロセス管理、--resume対話継続 | 実装済み | child_process |
| Stream Processor | NDJSONパース、イベント分類 | 実装済み | なし |
| Repo Resolver | メッセージ中のリポ名→cwdパス解決 | 実装済み | child_process (find) |
| State Manager | SQLiteセッション永続化 | 実装済み | better-sqlite3 |
| Orchestrator | モジュール間接続、重複排除 | 実装済み | 全モジュール |
| Formatter | Haiku APIによる出力要約 | 未実装 | @anthropic-ai/sdk |
| Approval Flow | 承認検知、Block Kit、ユーザー応答 | 未実装 | なし |

## 技術選定

| 技術 | 選定理由 |
|------|---------|
| TypeScript / Node.js 22.x | ai-commanderに環境あり。@slack/boltの第一言語 |
| @slack/bolt (Socket Mode) | NAT内から動作。Webhook/ポート開放不要 |
| child_process.spawn | `--output-format stream-json`で構造化JSON取得。node-pty不要 |
| better-sqlite3 | 同期API、WALモード対応、サーバーレス |
| systemd | ai-commanderで直接実行。Docker不使用 |

### CLI実行方式: stream-json

Claude CLIの`-p --output-format stream-json --verbose`モードを採用。

利点:
- 構造化JSONで出力（ANSI除去不要）
- `--resume <session_id>`で対話継続
- child_process.spawnで十分（node-ptyのネイティブビルド不要）
- イベント型（system, assistant, result等）で出力を分類済み

## PoC検証結果

1. **Claude Code認証**: `~/.claude/.credentials.json` をHOME環境変数で差し替えて動作OK
2. **stream-json出力**: 構造化JSONで取得可能。init/assistant/tool_use/user/result等のイベント型あり
3. **対話継続**: `--resume <session_id>`で過去セッション継続 → 実装済み・動作確認済み
4. **リポジトリ解決**: メッセージ中の「〜で」「〜の」パターンからcwd自動決定 → 実装済み
5. **画像読み取り**: Slack画像→tmpファイル保存→Claude Code Read toolで読み取り → 実装済み（`files:read`スコープ必須）
6. **承認フロー**: `-p`モードでは(y/N)プロンプトなし。権限エラー検知→Block Kit承認→`--allowedTools`で再実行 → 実装済み
7. **Docker不使用**: ai-commander自体がIaCで再構築可能な使い捨てVMのため、直接実行で十分
8. **localhost Ansible**: `make local`で動作確認済み
