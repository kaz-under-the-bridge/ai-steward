# Formatter モジュール設計

## 責務

- Claude Haiku APIによるCLI出力の要約
- Slack投稿向けのテキスト整形（mrkdwn形式）
- 長文出力の分割（Slackメッセージ上限: 4000文字）

## 境界

- 入力: Stream Processorからの抽出済みテキスト
- 出力: Slack投稿用の整形済みテキスト
- Slack APIの呼び出しは行わない（テキスト生成のみ）

## インターフェース

```typescript
interface FormatterConfig {
  anthropicApiKey: string;
  model: string;               // default: 'claude-haiku-4-5-20251001'
  maxOutputTokens: number;     // default: 1024
  summaryThreshold: number;    // 要約する最小文字数 (default: 500)
  slackMaxLength: number;      // Slackメッセージ上限 (default: 3900)
}

interface FormattedOutput {
  messages: string[];           // 分割済みメッセージ
  wasSummarized: boolean;
  originalLength: number;
}

interface Formatter {
  format(params: {
    content: string;
    type: 'output' | 'error' | 'timeout';
  }): Promise<FormattedOutput>;
}
```

## 要約ロジック

```
入力テキスト
  ├─ 500文字未満 → そのまま整形（要約なし）
  └─ 500文字以上 → Haiku APIで要約
                     ├─ 成功 → 要約テキストを整形
                     └─ 失敗 → 先頭+末尾切り出し（フォールバック）
```

## Haiku APIプロンプト

```typescript
const SUMMARY_SYSTEM_PROMPT = `あなたはClaude Code CLIの出力を要約するアシスタントです。
ルール:
- 日本語で要約
- 重要な結果（成功/失敗、変更ファイル、エラー等）を優先
- Slack mrkdwn形式（*太字*, \`コード\`, \`\`\`コードブロック\`\`\`）
- 3000文字以内`;
```

## フォールバック整形

```typescript
function fallbackFormat(content: string, maxLength: number): string {
  if (content.length <= maxLength) return content;
  const head = content.slice(0, Math.floor(maxLength * 0.6));
  const tail = content.slice(-Math.floor(maxLength * 0.3));
  return `${head}\n\n... (${content.length - head.length - tail.length}文字省略) ...\n\n${tail}`;
}
```

## メッセージ分割

Slack上限（4000文字）超過時は改行位置で分割。コードブロック内での分割を避ける。

## エラーハンドリング

| エラー | 対処 |
|--------|------|
| Haiku API呼び出し失敗 | フォールバック整形 |
| Haiku APIレート制限 | 指数バックオフ最大3回→フォールバック |
| 要約結果がSlack上限超過 | 分割 |

## 依存関係

- 外部: `@anthropic-ai/sdk`
- 内部: なし
