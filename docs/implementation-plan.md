# ai-steward 実装計画

## 開発方針

MVP駆動の反復開発。各MVPで実機Slack操作テストを行い、手触りを確認してからフィードバック→設計修正→次のMVPへ進む。

## 完了済み

### MVP1: 最小限のSlack→Claude Code→Slack (2026-03-21完了)

**実装内容:**
- プロジェクト基盤（package.json, tsconfig.json, .env.example）
- Slack Bot（Socket Mode、メッセージ受信・スレッド返信）
- CLI Manager（`claude -p --output-format stream-json --verbose` ワンショット実行）
- Stream Processor（NDJSONパース、init/assistant/result イベント分類）
- Orchestrator（モジュール間接続）
- Repo Resolver（メッセージ中のリポジトリ名→cwd自動解決）

**検証結果:**
- Slackメッセージ→Claude Code実行→スレッド返信: OK
- 「ouchi-serverで〜」でリポジトリ自動解決: OK
- 応答速度: 約3〜20秒（プロンプト内容による）
- stdinのno-data警告: `stdio: ['ignore', ...]`で解消済み
- find Permission denied: execFileSync + stderr catch で解消済み

---

### MVP2: 対話継続 + SQLite永続化 (2026-03-21完了)

**実装内容:**
- State Manager（better-sqlite3、WALモード、セッションCRUD）
- `--resume <claude_session_id>` による対話継続
- 実行中スレッドの重複排除（runningThreads Set）
- Bot再起動時のstaleセッションクリーンアップ

**検証結果:**
- スレッド内で連続質問→前回の文脈を維持して回答: OK
- 「継続実行中...」表示: OK
- SQLite永続化（`data/steward.db`）: OK

---

### MVP3: 承認フロー (2026-03-21完了)

**実装内容:**
- `-p`モードでは(y/N)プロンプトが発生しないことを実機検証で確認
- 権限エラー（`type=user`, `is_error: true`, `"Claude requested permissions"`）の検知
- Stream Processorに`permission_denied`イベント型を追加
- Block Kit承認/拒否ボタン表示
- 承認時: `--resume <session_id> --allowedTools <tool>`で再実行
- 拒否時: ボタンを更新して終了

**設計判断:** stdinへの(y/N)送信ではなく、権限エラー検知→承認→`--allowedTools`付き再実行方式を採用。`-p`モードの制約に合わせた設計。

**検証結果:** ファイル作成依頼→権限エラー→承認ボタン→承認→ファイル実際に作成: OK

---

### MVP4: 画像対応 (2026-03-21完了)

**実装内容:**
- Slackメッセージの`file_share`サブタイプ対応（サブタイプフィルタ修正）
- `files`配列からファイル情報抽出（id, name, mimetype, url_private_download）
- Slack API（Bearer token + `files:read`スコープ）で画像ダウンロード
- cwd内`.steward-tmp/`に一時保存、プロンプトにファイルパスを追加
- セッション完了/エラー時にtmpファイル自動削除

**注意:** Slack Appに`files:read`スコープが必須。スコープ追加後はReinstall Appが必要。

**検証結果:** Slack画像貼り付け→OCR+内容説明がスレッドに返信: OK

---

### MVP5: 進捗ストリーミング表示 (2026-03-21完了)

**実装内容:**
- Stream Processorにtool_useイベント分類を追加（ツール名+主要引数を抽出）
- 「実行中...」メッセージのTSを保持し、tool_useイベントで`chat.update`で逐次更新
- 直近5件のツール使用履歴を表示（`→ Read: /path/to/file`等）
- 2秒debounceでSlack API rate limit回避
- セッション完了時にタイマー・履歴をクリーンアップ

**検証結果:** 複数ファイル読み取りタスクで「実行中...」が都度更新: OK

---

### MVP6: Formatter（要約） (2026-03-21完了)

**実装内容:**
- Formatter（@anthropic-ai/sdk、`claude-haiku-4-5-20251001`）
- 要約閾値判定（500文字以上で要約、未満はそのまま）
- フォールバック（API失敗時は先頭60%+末尾30%切り出し）
- Slackメッセージ分割（3900文字上限で改行位置分割）
- API Key未設定時は従来動作（truncateのみ）

**検証結果:** Opus出力3,387文字 → Haiku要約1,338文字（約60%圧縮）: OK

---

### MVP7: 安定化・デプロイ (2026-03-21完了)

**実装内容:**
- ouchi-serverにAnsibleロール`ai_steward`追加
  - systemdサービス定義（`ai-steward.service`）
  - 環境変数ファイル（`~/.config/ai-steward/env`、初回は`.env`からコピー）
  - npm install + TypeScriptビルド
  - PATH設定（`~/.local/bin`をsystemd環境に追加）
- `make local`でlocalhost適用
- graceful shutdown（SIGTERM/SIGINT）
- `/tmp/ai-steward-files/`を起動時に作成（tmpディレクトリのリフレッシュ対策）

**検証結果:** systemdサービスとして稼働、Slackから画像付きPR作成まで一連のフローが動作: OK
