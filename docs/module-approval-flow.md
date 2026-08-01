# Approval Flow 設計

承認フローは独立モジュールではなくorchestrator内に実装されている
（pendingApprovals管理 + Slack Bot / CLI Managerへの依頼）。

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

## タイムアウト

承認待ちはアイドルタイムアウト（10分）の対象。放置するとプロセスが終了し、

- 承認ボタンは「タイムアウトしました（期限切れ）」に更新
- スレッドに中断通知（同一スレッドで再依頼すると `--resume` で続きから再開）
- 期限切れ後にボタンを押した場合は「期限切れです」と案内

## エラーハンドリング

| エラー | 対処 |
|--------|------|
| 応答時にプロセス消滅 | 「プロセスが終了していました。再依頼で再開」を通知 |
| ボタン二重クリック | pending不在なら期限切れ案内 |
| タイムアウト+応答の競合 | Map.deleteで排他（シングルスレッド） |
