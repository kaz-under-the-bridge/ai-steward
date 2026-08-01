# ai-steward アップグレード計画（2026-08）

2026-03 の MVP1〜7 完結時点から、モデル性能・Claude Code CLI の機能・類似ツール
（OpenClaw / Claude Tag / cc-connect / acip/slack-claude-agent 等）の水準が進んだことを受けた機能 refine 計画。

策定プロセス: Claude Fable 5 が起案（リポ棚卸し + 類似ツール Web 調査）→ GPT-5.6 sol による
cross-model レビュー 2 回 → CLI 双方向化 PoC（2026-08-01、実 VM で検証済み）を反映。

## 前提（確定事項）

- **Claude Code CLI の spawn 継続 + サブスク認証**。Agent SDK へは移行しない
  （SDK / API 直はサブスク枠と別の従量課金になるため。CLI 経由はサブスク枠で動くことを PoC で実測確認済み）
- 個人（kaz）専用・ai-commander VM・systemd 常駐という運用は維持
- マルチチャネル化（Discord 等）・HTTP API・独自 cron 基盤は対象外（YAGNI）

## 現状の弱点（2026-08-01 コード調査で確認）

1. **承認フローが脆い**: permission_denied 検知が `is_error: true` + `"Claude requested permissions"` の
   文字列マッチ。許可ツール抽出が `includes('write to')` 等のヒューリスティックで、フォールバックは
   Write+Edit を無条件許可。承認のたびに CLI を `--resume --allowedTools` で再起動し、
   MAX_APPROVAL_RETRIES=1 で 2 回目はターミナル誘導
2. 同一リポの複数スレッド同時実行不可（orchestrator の cwd 排他）
3. モデル指定が 4 系統に分散（CLI 引数固定 / Router・Formatter の Haiku ハードコード / Maintenance のデフォルト引数）
4. テスト 0 件、docs が実装と乖離（waiting_approval 未実装のまま記載等）
5. セッション状態が running/completed/failed のみ（承認待ち・キャンセルを表現できない）
6. /status /usage 相当の操作・可観測コマンドなし
7. ユーザー単位 allowlist なし（チャンネル単位のみ）

## 技術基盤: CLI 双方向 stream-json + 制御プロトコル（PoC 検証済み）

`claude -p --input-format stream-json --output-format stream-json --permission-prompt-tool stdio` で
CLI プロセスを常駐させると、以下が成立することを実 VM（CLI v2.1.220、サブスク認証）で確認した:

| 検証項目 | 結果 |
|----------|------|
| 常駐プロセスへの複数 user メッセージ投入 | 同一プロセス・同一 session_id で対話継続、文脈保持 |
| 権限要求の構造化受信 | `control_request`（subtype: `can_use_tool`）で tool_name・input 全文・`permission_suggestions` が届く |
| 承認 | `control_response` の `behavior: "allow"` でプロセスを生かしたままツール実行続行 |
| 拒否 | `behavior: "deny"` + メッセージで、本体が拒否理由を認識して応答継続 |
| プロセス再起動後の `--resume` | 履歴込みで復元（transcript は `~/.claude/projects/<encoded-cwd>` に保存、同一 cwd 前提） |
| 課金 | `rate_limit_event`（five_hour 枠）が流れており、サブスク枠で動作 |

リスクと対策:

- `--permission-prompt-tool stdio` は help 非掲載の隠しフラグ（Agent SDK が内部利用する経路）。
  CLI バージョン更新で挙動が変わりうるため、**CLI バージョンを固定**し、起動時に制御プロトコルの
  疎通チェック（canary）を行う
- 常駐プロセスはアイドルタイムアウトで終了し、次メッセージは `--resume` で再開する
  （メモリ・プロセス数の上限管理）

## ロードマップ

順序は sol レビューの推奨（並行化より先に認可・回復性を固める）を採用。

### Step 1: cli-manager 双方向化と承認フロー刷新

- cli-manager を双方向 stream-json 方式に変更（1 スレッド = 1 常駐プロセス + アイドルタイムアウト + `--resume` 再開）
- 承認フロー刷新: 文字列マッチ検知・extractAllowedTools ヒューリスティック・`--allowedTools` 再起動・
  MAX_APPROVAL_RETRIES を廃止し、`can_use_tool` → Slack ボタン → `control_response` の構造化承認に置換
- `permission_suggestions` を Slack ボタンの選択肢に反映（今回のみ許可 / acceptEdits へ切替 等）
- permission-mode の既定を bypassPermissions から「読み取り自動 + 書込は承認」に変更（RepoConfig で bypass 選択可）
- 着手前に現行承認フロー・状態遷移・repo 解決の characterization test を最小限追加し、移行差分を検出可能にする

### Step 2: 認可・回復性の強化

- ユーザー allowlist（`ALLOWED_USER_IDS`）。操作系コマンド（Step 3）の前提条件
- セッション状態機械の拡張: `queued / running / waiting_approval / cancelled / completed / failed` +
  再起動時の復旧規則（承認待ちを SQLite に永続化し、再起動後に `--resume` で復元）
- 全体同時実行上限とキュー、セッション wall-clock timeout
- SQLite schema migration の仕組み
- 構造化ログに thread/session/repo の correlation ID
- Slack 出力に tool input・ファイル内容・秘密情報を出さない redaction 方針

### Step 3: Slack UX

- `!status`（実行中セッション一覧）・`!stop`（キャンセル: プロセス停止 + 状態遷移 + 後片付けまで一貫）
- AskUserQuestion の Slack 中継（ボタン/ラジオ回答。タイムアウトと再起動時の未回答状態を定義）
- `!usage` はトークン数・実行時間・モデル・セッション数の表示に留める（ドル換算はサブスクと不一致のため出さない)
- PR/commit リンクは応答テキストの正規表現でなく git の確定情報（branch/SHA/PR URL）から生成
- コマンドは予約 prefix（`!`）で通常依頼と衝突しない形式にする
- 見送り: `mode yolo`（allowlist 完備まで）、逐次 tool_use のライブ表示（status/stop/質問中継を優先）

### Step 4: モデル戦略の一元化

- `MODEL_MAIN` / `MODEL_LIGHT` / `MODEL_MAINTENANCE` + effort を config モジュールに集約
  （既定値・RepoConfig override・起動時 validation。動的モデル選択基盤は作らない）
- Router: スキーマ検証 + 限定リトライで JSON 保証（```json フェンス除去ハックの置換）
- Formatter: 500 字閾値・要約プロンプトは実際の Slack 出力サンプルを集めてから見直す
- effort 自動判定は導入せず、固定値 + RepoConfig override で運用データを集める

### Step 5: worktree 分離（並行需要が実際に出てから）

- スレッドごとに session ID 正規化名で worktree + 一意ブランチを作成（基準 ref は RepoConfig 指定）
- 起動時 reconciliation・保持期限・dirty worktree 保護・手動回収コマンドをセットで実装
- worktree 作成失敗はセッション開始失敗として明示

### Step 6: 定期実行（需要発生時・最小構成）

- 独自 cron 基盤は作らず、systemd timer から orchestrator を直接呼ぶ内部入口を用意する

### 継続事項（Step にしない）

- docs の実装追随は即時修正（waiting_approval 記述、approval-flow/formatter docs）
- テストは各 Step の完了条件に組み込む（最後にまとめない）

## 検討して見送った案

- **Agent SDK 移行**: サブスク枠と別の従量課金になるため見送り。構造化承認は CLI の制御プロトコルで代替（PoC 済み）
- **OpenClaw 乗り換え**: ai-steward は OpenClaw 代替として意図的に自作した経緯があり、
  外部大型コードベースの VM 常駐セキュリティトレードオフもあるため見送り
- **HTTP API / webhook / 独自 cron / マルチチャネル / effort 自動判定 / mode yolo**: YAGNI または前提条件未達で見送り
  （需要・前提が揃った時点で再検討）
