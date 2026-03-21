# ai-steward

Slack連携のClaude Codeエージェントブリッジ。OpenClawの自作代替ツール。

Slackチャンネルにメッセージを送るだけで、自宅サーバー上のClaude Code CLIが自律的にコード作業を遂行し、結果をスレッドに返す。

## 機能

- Slackメッセージ → Claude Code実行 → スレッド返信
- メッセージ中のリポジトリ名を自動解決（「ouchi-serverで〜」→ cwd決定）
- スレッド内での対話継続（`--resume`でセッション維持）
- SQLiteによるセッション永続化（Bot再起動後も対話継続可能）
- Block Kit承認フロー（ファイル編集等の権限承認をSlackボタンで操作）
- 画像対応（Slackに貼った画像をClaude CodeがOCR/読み取り）
- 進捗ストリーミング（ツール使用状況を「実行中...」メッセージにリアルタイム表示）

## 技術スタック

- TypeScript / Node.js 22.x
- @slack/bolt (Socket Mode)
- child_process.spawn (Claude CLI stream-json)
- better-sqlite3 (SQLite)

## セットアップ

```bash
npm install
cp .env.example .env
# .env に Slack App のトークンを設定
npm run dev
```

詳細は [CLAUDE.md](CLAUDE.md) を参照。

