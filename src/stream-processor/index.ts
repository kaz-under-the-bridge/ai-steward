import { EventEmitter } from 'node:events';
import { createChildLogger } from '../logger.js';
import type { StreamEvent, StreamEventType } from '../types.js';

const log = createChildLogger('stream-processor');

export class StreamProcessor extends EventEmitter {
  // セッション毎の不完全行バッファ
  private buffers: Map<string, string> = new Map();

  feed(sessionId: string, rawData: string): void {
    const existing = this.buffers.get(sessionId) || '';
    const combined = existing + rawData;
    const lines = combined.split('\n');

    // 最後の不完全行はバッファに残す
    this.buffers.set(sessionId, lines.pop() || '');

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      try {
        const parsed = JSON.parse(trimmed) as Record<string, unknown>;
        const event = this.classify(sessionId, parsed);
        if (event) {
          this.emit('stream', event);
        }
      } catch {
        log.warn({ sessionId, line: trimmed.slice(0, 200) }, 'JSONパース失敗');
      }
    }
  }

  notifyExit(sessionId: string, exitCode: number): void {
    // 残りのバッファをフラッシュ
    const remaining = this.buffers.get(sessionId)?.trim();
    if (remaining) {
      try {
        const parsed = JSON.parse(remaining) as Record<string, unknown>;
        const event = this.classify(sessionId, parsed);
        if (event) this.emit('stream', event);
      } catch {
        // 無視
      }
    }
    this.buffers.delete(sessionId);

    if (exitCode !== 0) {
      this.emit('stream', {
        sessionId,
        type: 'error' as StreamEventType,
        content: `CLIが終了コード ${exitCode} で終了しました`,
        raw: { exitCode },
        timestamp: new Date(),
      } satisfies StreamEvent);
    }
  }

  clear(sessionId: string): void {
    this.buffers.delete(sessionId);
  }

  private classify(sessionId: string, parsed: Record<string, unknown>): StreamEvent | null {
    const type = parsed.type as string;
    const subtype = parsed.subtype as string | undefined;

    let eventType: StreamEventType;
    let content = '';

    switch (type) {
      case 'system':
        if (subtype === 'init') {
          eventType = 'init';
          content = '';
          // セッションIDを抽出
          const claudeSessionId = parsed.session_id as string | undefined;
          if (claudeSessionId) {
            content = claudeSessionId;
          }
        } else {
          return null; // その他のsystemイベントはスキップ
        }
        break;

      case 'assistant': {
        const message = parsed.message as Record<string, unknown> | undefined;
        if (!message?.content || !Array.isArray(message.content)) return null;

        const contentArr = message.content as Array<Record<string, unknown>>;

        // tool_useイベントを優先チェック
        const toolUse = contentArr.find((c) => c.type === 'tool_use');
        if (toolUse) {
          eventType = 'tool_use';
          const toolName = toolUse.name as string || '';
          const input = toolUse.input as Record<string, unknown> || {};
          // ツール名と主要な引数を要約
          const inputSummary = input.file_path || input.command || input.pattern || '';
          content = `${toolName}: ${inputSummary}`;
          break;
        }

        // テキスト応答
        eventType = 'assistant_text';
        content = contentArr
          .filter((c) => c.type === 'text')
          .map((c) => c.text as string)
          .join('');
        if (!content) return null;
        break;
      }

      case 'result': {
        eventType = 'result';
        content = (parsed.result as string) || '';
        const isError = parsed.is_error as boolean;
        if (isError) eventType = 'error';
        break;
      }

      case 'user': {
        // 権限エラーの検知: "Claude requested permissions to ..."
        const userMessage = parsed.message as Record<string, unknown> | undefined;
        if (userMessage?.content && Array.isArray(userMessage.content)) {
          const toolResults = userMessage.content as Array<Record<string, unknown>>;
          for (const tr of toolResults) {
            if (tr.is_error && typeof tr.content === 'string' && tr.content.includes('Claude requested permissions')) {
              eventType = 'permission_denied';
              content = tr.content as string;
              return {
                sessionId,
                type: eventType,
                content,
                raw: parsed,
                timestamp: new Date(),
              };
            }
          }
        }
        return null;
      }

      default:
        return null; // rate_limit_event等はスキップ
    }

    return {
      sessionId,
      type: eventType,
      content,
      raw: parsed,
      timestamp: new Date(),
    };
  }
}
