import { spawn, ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { createChildLogger } from '../logger.js';
import type { CliSession } from '../types.js';
import type { RepoConfig } from '../config.js';

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
    repoConfig?: RepoConfig;
  }): Promise<CliSession> {
    const cwd = params.cwd || this.config.defaultCwd;
    const rc = params.repoConfig;

    // プロンプトはstdinで渡す（-pの引数に直接渡すと「-」始まりのテキストがオプション誤認される）
    const args = [
      '-p',
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

    // permission-mode: デフォルトbypassPermissions、RepoConfigで上書き可能
    const permissionMode = rc?.permissionMode || 'bypassPermissions';
    args.push('--permission-mode', permissionMode);

    // --add-dir: /tmp/ai-steward-files（常に）+ RepoConfigの追加分
    args.push('--add-dir', '/tmp/ai-steward-files');
    if (rc?.addDirs) {
      for (const dir of rc.addDirs) {
        args.push('--add-dir', dir);
      }
    }

    // その他の任意CLI引数
    if (rc?.extraArgs) {
      args.push(...rc.extraArgs);
    }

    log.info(
      {
        sessionId: params.sessionId,
        cwd,
        prompt: params.prompt.slice(0, 100),
        resume: params.resumeClaudeSessionId || null,
        allowedTools: params.allowedTools || null,
        repoConfig: rc || null,
      },
      params.resumeClaudeSessionId ? 'CLI再開（--resume）' : 'CLI起動',
    );

    // ANTHROPIC_API_KEYをCLIに渡さない（OAuthサブスクリプションを使わせる）
    const { ANTHROPIC_API_KEY: _, ...envWithoutApiKey } = process.env;

    // SSH_AUTH_SOCKを~/.ssh-agentから取得（systemdではシェル初期化されないため）
    const sshEnv = this.loadSshAgentEnv();

    const proc = spawn(this.config.claudePath, args, {
      cwd,
      env: {
        ...envWithoutApiKey,
        ...sshEnv,
        HOME: this.config.homeDir,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const session: CliSession = {
      sessionId: params.sessionId,
      claudeSessionId: null,
      pid: proc.pid || 0,
      createdAt: new Date(),
    };

    this.sessions.set(params.sessionId, { session, process: proc });

    // stdinにプロンプトを書き込んで閉じる
    proc.stdin?.write(params.prompt);
    proc.stdin?.end();

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

  /**
   * ~/.ssh-agentからSSH_AUTH_SOCKとSSH_AGENT_PIDを読み取る
   */
  private loadSshAgentEnv(): Record<string, string> {
    const env: Record<string, string> = {};
    try {
      const agentFile = readFileSync(`${this.config.homeDir}/.ssh-agent`, 'utf-8');
      const sockMatch = agentFile.match(/SSH_AUTH_SOCK=([^;]+)/);
      const pidMatch = agentFile.match(/SSH_AGENT_PID=([^;]+)/);
      if (sockMatch) env.SSH_AUTH_SOCK = sockMatch[1];
      if (pidMatch) env.SSH_AGENT_PID = pidMatch[1];
    } catch {
      log.warn('~/.ssh-agentの読み取りに失敗');
    }
    return env;
  }

  getActiveSessions(): CliSession[] {
    return Array.from(this.sessions.values()).map((e) => e.session);
  }
}
