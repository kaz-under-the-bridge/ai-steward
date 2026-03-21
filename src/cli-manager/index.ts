import { spawn, ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createChildLogger } from '../logger.js';
import type { CliSession } from '../types.js';

const log = createChildLogger('cli-manager');

export interface CliManagerConfig {
  claudePath: string;
  defaultCwd: string;
  homeDir: string;
}

export class CliManager extends EventEmitter {
  private config: CliManagerConfig;
  private sessions: Map<string, { session: CliSession; process: ChildProcess }> = new Map();

  constructor(config: CliManagerConfig) {
    super();
    this.config = config;
  }

  async spawnSession(params: {
    sessionId: string;
    prompt: string;
    cwd?: string;
    resumeClaudeSessionId?: string;
    allowedTools?: string[];
  }): Promise<CliSession> {
    const cwd = params.cwd || this.config.defaultCwd;

    const args = [
      '-p',
      params.prompt,
      '--output-format',
      'stream-json',
      '--verbose',
    ];

    if (params.resumeClaudeSessionId) {
      args.push('--resume', params.resumeClaudeSessionId);
    }

    if (params.allowedTools && params.allowedTools.length > 0) {
      args.push('--allowedTools', ...params.allowedTools);
    }

    // /tmp/ai-steward-files を追加ディレクトリとして許可（画像等のtmpファイル用）
    args.push('--add-dir', '/tmp/ai-steward-files');

    log.info(
      {
        sessionId: params.sessionId,
        cwd,
        prompt: params.prompt.slice(0, 100),
        resume: params.resumeClaudeSessionId || null,
        allowedTools: params.allowedTools || null,
      },
      params.resumeClaudeSessionId ? 'CLI再開（--resume）' : 'CLI起動',
    );

    // ANTHROPIC_API_KEYをCLIに渡さない（OAuthサブスクリプションを使わせる）
    const { ANTHROPIC_API_KEY: _, ...envWithoutApiKey } = process.env;
    const proc = spawn(this.config.claudePath, args, {
      cwd,
      env: {
        ...envWithoutApiKey,
        HOME: this.config.homeDir,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const session: CliSession = {
      sessionId: params.sessionId,
      claudeSessionId: null,
      pid: proc.pid || 0,
      createdAt: new Date(),
    };

    this.sessions.set(params.sessionId, { session, process: proc });

    proc.stdout?.on('data', (data: Buffer) => {
      this.emit('data', params.sessionId, data.toString());
    });

    proc.stderr?.on('data', (data: Buffer) => {
      log.warn({ sessionId: params.sessionId, stderr: data.toString().trim() }, 'CLI stderr');
    });

    proc.on('exit', (code) => {
      log.info({ sessionId: params.sessionId, exitCode: code }, 'CLI終了');
      this.sessions.delete(params.sessionId);
      this.emit('exit', params.sessionId, code ?? 1);
    });

    proc.on('error', (err) => {
      log.error({ sessionId: params.sessionId, err }, 'CLI起動エラー');
      this.sessions.delete(params.sessionId);
      this.emit('error', params.sessionId, err);
    });

    return session;
  }

  updateClaudeSessionId(sessionId: string, claudeSessionId: string): void {
    const entry = this.sessions.get(sessionId);
    if (entry) {
      entry.session.claudeSessionId = claudeSessionId;
    }
  }

  kill(sessionId: string): void {
    const entry = this.sessions.get(sessionId);
    if (entry) {
      entry.process.kill('SIGTERM');
    }
  }

  getActiveSessions(): CliSession[] {
    return Array.from(this.sessions.values()).map((e) => e.session);
  }
}
