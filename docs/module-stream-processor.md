# Stream Processor モジュール設計

## 責務

- stream-json出力のパース（行単位のJSONオブジェクト）
- イベント型による分類（system, assistant, tool_use, result等）
- debounce処理（出力安定待機）
- 承認プロンプト等の特定パターン検知

## 境界

- 入力: CLI Managerからのstdout文字列（NDJSON形式）
- 出力: パース済みイベントの通知
- 出力の「意味」の解釈（要約等）はFormatterに委譲

## stream-jsonイベント型

Claude CLIの`--output-format stream-json --verbose`が出力するイベント:

```
{"type":"system","subtype":"init",...}       → セッション初期化
{"type":"assistant","message":{...}}         → アシスタント応答（テキスト、ツール使用）
{"type":"rate_limit_event",...}              → レート制限情報
{"type":"result","subtype":"success",...}    → 実行完了
```

## インターフェース

```typescript
interface StreamProcessorConfig {
  debounceMs: number;           // default: 2000
  maxBufferSize: number;        // default: 1048576 (1MB)
}

type StreamEventType =
  | 'init'              // セッション初期化
  | 'assistant_text'    // テキスト応答
  | 'tool_use'          // ツール使用
  | 'result'            // 実行完了
  | 'error'             // エラー
  | 'approval_prompt';  // 承認要求

interface StreamEvent {
  sessionId: string;
  type: StreamEventType;
  content: string;          // 抽出されたテキスト
  raw: Record<string, any>; // 元のJSONオブジェクト
  timestamp: Date;
}

interface StreamProcessor {
  feed(sessionId: string, rawData: string): void;
  notifyExit(sessionId: string, exitCode: number): void;
  clear(sessionId: string): void;
  on(event: 'stream', listener: (event: StreamEvent) => void): void;
}
```

## JSONパース処理

stream-json出力は1行1JSONオブジェクト（NDJSON形式）:

```typescript
class JsonLineParser {
  private buffer: string = '';

  feed(data: string): Record<string, any>[] {
    this.buffer += data;
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() || '';  // 不完全な最終行はバッファに残す

    const parsed: Record<string, any>[] = [];
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        parsed.push(JSON.parse(trimmed));
      } catch {
        // 不正なJSON行はスキップ（ログ出力）
      }
    }
    return parsed;
  }
}
```

## テキスト抽出

```typescript
function extractText(event: Record<string, any>): string {
  switch (event.type) {
    case 'assistant':
      // message.content[].text を結合
      return event.message?.content
        ?.filter((c: any) => c.type === 'text')
        .map((c: any) => c.text)
        .join('') || '';
    case 'result':
      return event.result || '';
    default:
      return '';
  }
}
```

## debounce処理

stream-jsonモードではイベント単位で区切りが明確なため、debounceの役割が変わる:

- `result`イベント受信 → 即時通知（完了）
- `assistant`イベント → debounce（連続するテキストチャンクを集約）
- 承認プロンプト検知 → 即時通知

## エラーハンドリング

| エラー | 対処 |
|--------|------|
| JSON パース失敗 | 行をスキップ、ログ出力 |
| バッファ上限超過 | 古いデータ切り捨て、警告ログ |

## 依存関係

- 外部: なし
- 内部: なし（EventEmitterパターンで通知）
