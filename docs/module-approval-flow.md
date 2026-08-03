# Approval Flow 設計

承認フローは独立モジュールではなくorchestrator内に実装されている
（Slack Bot / CLI Manager / State Managerへの依頼）。承認待ちはSQLiteの
`pending_approvals` テーブルに永続化され、再起動やアイドルタイムアウト後も
ボタン押下で復旧できる。セッション状態は承認待ちの間 `waiting_approval` になる。

## 仕組み

`--permission-prompt-tool stdio` により、権限が必要なツール実行はCLIが
`control_request`（subtype: `can_use_tool`）として構造化通知してくる。
プロセスは応答が来るまでツール実行を保留したまま生存する。

```
CLI ──control_request──▶ Stream Processor ──permission_request──▶ Orchestrator
                                                                      │ Block Kit投稿
Slack ◀───────────────────────────────────────────────────────────────┘
  │ ボタン押下
  ▼
Orchestrator ──sendControlResponse(allow/deny)──▶ CLI Manager ──stdin──▶ CLI（実行続行）
```

## 承認要求の内容

`control_request` には以下が含まれ、Slackの承認ボタンにツール名とinput全文
（1500字で切り詰め）を表示する:

- `tool_name`: ツール名（Write / Bash 等）
- `input`: ツール入力の全文
- `permission_suggestions`: CLIが提示する許可ルール候補

## ボタンと応答

| ボタン | control_response |
|--------|------------------|
| 承認 | `{behavior: "allow", updatedInput: <元のinput>}` |
| 今後も許可（suggestionsがある場合のみ表示） | 上記 + `updatedPermissions: <permission_suggestions>` |
| 拒否 | `{behavior: "deny", message: "ユーザーがSlack上で拒否しました..."}` |

拒否してもプロセスは生きたままで、本体が拒否を認識して代替案を応答する。
1タスク中に承認が複数回発生しても、その都度ボタンが出る
（key: `sessionId:requestId` で個別管理）。

## タイムアウトとプロセス消滅後の復旧

承認待ちはアイドルタイムアウト（10分）の対象。放置するとプロセスは終了するが、
承認レコードはDBに残り、ボタンは押下可能なまま:

- タイムアウト時: スレッドに「承認ボタンを押せば復旧して続行します」と通知
- その後ボタン押下: 旧セッションをfailed化し、`--resume <claudeSessionId>` で
  新セッションを起動して「承認/拒否された」旨の継続プロンプトを投入
- 承認の場合は復旧セッションの**最初の同名ツール要求を自動承認**
  （autoApprovals、有効期限5分）し、ボタンの二度押しなしで続行させる
- 「今後も許可」だった場合は自動承認時に `updatedPermissions` も送る

ai-steward自体の再起動でも同じ仕組みで復旧する（`recoverAfterRestart()` が
`waiting_approval` セッションを温存する）。claudeSessionId未取得などで復元
できない場合は「再依頼してください」と明示して failed 化する。

同一スレッドに新しい依頼が来た場合、残っていた承認ボタンは
「新しい依頼により期限切れ」に更新して破棄する。キャンセルキーワードでも同様。

## エラーハンドリング

| エラー | 対処 |
|--------|------|
| 応答時にプロセス消滅 | `--resume` で復旧して継続（上記） |
| 復旧失敗（claudeSessionId欠落・起動失敗） | 「再依頼してください」を通知しfailed化 |
| ボタン二重クリック | pending不在（DB削除済み）なら期限切れ案内 |
| タイムアウト+応答の競合 | DBレコード削除で排他（シングルスレッド） |
