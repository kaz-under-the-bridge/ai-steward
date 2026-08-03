import { describe, it, expect, beforeAll } from 'vitest';
import { chmodSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { CliManager } from '../index.js';

// fake-claude.mjs を claude CLI の代わりに起動して双方向プロトコルを検証する

const fakeClaudePath = join(dirname(fileURLToPath(import.meta.url)), 'fake-claude.mjs');

beforeAll(() => {
  chmodSync(fakeClaudePath, 0o755);
});

function createManager(idleTimeoutMs?: number) {
  const manager = new CliManager({
    claudePath: fakeClaudePath,
    defaultCwd: tmpdir(),
    homeDir: tmpdir(),
    idleTimeoutMs,
  });
  const lines: Record<string, unknown>[] = [];
  let buf = '';
  manager.on('data', (_sessionId: string, data: string) => {
    buf += data;
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      if (line.trim()) lines.push(JSON.parse(line));
    }
  });
  return { manager, lines };
}

function waitFor(cond: () => boolean, timeoutMs = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const timer = setInterval(() => {
      if (cond()) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() - start > timeoutMs) {
        clearInterval(timer);
        reject(new Error('waitFor timeout'));
      }
    }, 20);
  });
}

describe('CliManager 双方向stream-json', () => {
  it('起動 → control_request受信 → 承認応答 → result → 追加メッセージ → result', async () => {
    const { manager, lines } = createManager();
    await manager.spawnSession({ sessionId: 's1', prompt: 'ファイルを作って' });

    // init + control_request が届く
    await waitFor(() => lines.some((l) => l.type === 'control_request'));
    const req = lines.find((l) => l.type === 'control_request')!;
    expect((req.request as Record<string, unknown>).tool_name).toBe('Write');

    // 承認応答 → result
    const sent = manager.sendControlResponse('s1', req.request_id as string, {
      behavior: 'allow',
      updatedInput: { file_path: '/tmp/x.txt' },
    });
    expect(sent).toBe(true);
    await waitFor(() => lines.some((l) => l.type === 'result' && l.result === 'done-1'));

    // 同一プロセスに追加メッセージ → 2つ目のresult
    expect(manager.sendUserMessage('s1', '続けて')).toBe(true);
    await waitFor(() => lines.some((l) => l.type === 'result' && l.result === 'done-2'));

    expect(manager.hasSession('s1')).toBe(true);
    manager.terminate('s1');
    await waitFor(() => !manager.hasSession('s1'));
  });

  it('markIdle でアイドルタイムアウト後にプロセスが終了し exit code 0 を通知する', async () => {
    const { manager } = createManager(100);
    const exits: number[] = [];
    manager.on('exit', (_sessionId: string, code: number) => exits.push(code));

    await manager.spawnSession({ sessionId: 's2', prompt: 'test' });
    manager.markIdle('s2');
    await waitFor(() => exits.length > 0);
    expect(exits[0]).toBe(0);
    expect(manager.hasSession('s2')).toBe(false);
  });

  it('markBusy でアイドルタイマーが解除される', async () => {
    const { manager } = createManager(100);
    const exits: number[] = [];
    manager.on('exit', (_sessionId: string, code: number) => exits.push(code));

    await manager.spawnSession({ sessionId: 's3', prompt: 'test' });
    manager.markIdle('s3');
    manager.markBusy('s3');
    await new Promise((r) => setTimeout(r, 300));
    expect(exits).toHaveLength(0);
    expect(manager.hasSession('s3')).toBe(true);

    manager.terminate('s3');
    await waitFor(() => !manager.hasSession('s3'));
  });

  it('存在しないセッションへの送信は false を返す', () => {
    const { manager } = createManager();
    expect(manager.sendUserMessage('nope', 'x')).toBe(false);
    expect(
      manager.sendControlResponse('nope', 'r1', { behavior: 'deny', message: 'no' }),
    ).toBe(false);
  });
});
