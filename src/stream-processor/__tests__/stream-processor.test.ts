import { describe, it, expect, beforeEach } from 'vitest';
import { StreamProcessor } from '../index.js';
import type { StreamEvent } from '../../types.js';

// characterization test: stream-processor の分類挙動を固定する

describe('StreamProcessor', () => {
  let processor: StreamProcessor;
  let events: StreamEvent[];

  beforeEach(() => {
    processor = new StreamProcessor();
    events = [];
    processor.on('stream', (e: StreamEvent) => events.push(e));
  });

  const feedLine = (obj: unknown) => processor.feed('s1', JSON.stringify(obj) + '\n');

  it('system/init から claudeSessionId を抽出する', () => {
    feedLine({ type: 'system', subtype: 'init', session_id: 'claude-abc' });
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('init');
    expect(events[0].content).toBe('claude-abc');
  });

  it('assistant のテキスト応答を assistant_text として通知する', () => {
    feedLine({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'こんにちは' }] },
    });
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('assistant_text');
    expect(events[0].content).toBe('こんにちは');
  });

  it('assistant の tool_use をツール名+主要引数の要約で通知する', () => {
    feedLine({
      type: 'assistant',
      message: {
        content: [{ type: 'tool_use', name: 'Read', input: { file_path: '/tmp/a.txt' } }],
      },
    });
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('tool_use');
    expect(events[0].content).toBe('Read: /tmp/a.txt');
  });

  it('result を result イベントとして通知する', () => {
    feedLine({ type: 'result', result: '完了しました', is_error: false });
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('result');
    expect(events[0].content).toBe('完了しました');
  });

  it('is_error: true の result は error イベントになる', () => {
    feedLine({ type: 'result', result: '失敗', is_error: true });
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('error');
  });

  it('分割チャンクでも1行単位でパースする', () => {
    const line = JSON.stringify({ type: 'result', result: 'ok', is_error: false }) + '\n';
    processor.feed('s1', line.slice(0, 10));
    expect(events).toHaveLength(0);
    processor.feed('s1', line.slice(10));
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('result');
  });

  it('control_request(can_use_tool) を permission_request として構造化通知する', () => {
    feedLine({
      type: 'control_request',
      request_id: 'req-1',
      request: {
        subtype: 'can_use_tool',
        tool_name: 'Write',
        input: { file_path: '/tmp/a.txt', content: 'x' },
        permission_suggestions: [{ type: 'addRules' }],
      },
    });
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('permission_request');
    expect(events[0].permission).toEqual({
      requestId: 'req-1',
      toolName: 'Write',
      input: { file_path: '/tmp/a.txt', content: 'x' },
      suggestions: [{ type: 'addRules' }],
    });
  });

  it('can_use_tool 以外の control_request は無視する', () => {
    feedLine({ type: 'control_request', request_id: 'req-2', request: { subtype: 'other' } });
    expect(events).toHaveLength(0);
  });

  it('rate_limit_event 等の未知イベントは無視する', () => {
    feedLine({ type: 'rate_limit_event', foo: 1 });
    expect(events).toHaveLength(0);
  });

  it('notifyExit で非0終了コードなら error イベントを出す', () => {
    processor.notifyExit('s1', 1);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('error');
    expect(events[0].content).toContain('1');
  });

  it('notifyExit で0終了コードなら error イベントを出さない', () => {
    processor.notifyExit('s1', 0);
    expect(events).toHaveLength(0);
  });
});
