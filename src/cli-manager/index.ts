import { spawn, ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { createChildLogger } from '../logger.js';
import type { CliSession } from '../types.js';
import type { RepoConfig } from '../config.js';

const log = createChildLogger('cli-manager');

// アイドル（result後・承認待ち）のプロセスを終了するまでの時間
const DEFAULT_IDLE_TIMEOUT_MS = 10 * 60 * 1000;

export interface CliManagerConfig {
  claudePath: string;
  defaultCwd: string;
  homeDir: string;
  idleTimeoutMs?: number;
}

// 承認応答（control_response の response.response 部分）
export type PermissionResponse =
  | { behavior: 'allow'; updatedInput: Record<string, unknown>; updatedPermissions?: unknown[] }
  | { behavior: 'deny'; message: string };

interface SessionEntry {
  session: CliSession;
  process: ChildProcess;
  idleTimer: NodeJS.Timeout | null;
  // terminate()による意図的終了（exit時にエラー扱いしない）
  terminating: boolean;
}

export class CliManager extends EventEmitter {
  private config: CliManagerConfig;
  private sessions: Map<string, SessionEntry> = new Map();

  constructor(config: CliManagerConfig) {
    super();
    this.config = config;
  }

  async spawnSession(params: {
    sessionId: string;
    prompt: string;
    cwd?: string;
    resumeClaudeSessionId?: string;
    repoConfig?: RepoConfig;
  }): Promise<CliSession> {
    const cwd = params.cwd || this.config.defaultCwd;
    const rc = params.repoConfig;

    // 双方向stream-json: stdinを開いたまま複数のuserメッセージ・control_responseを投入する
    const args = [
      '-p',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--verbose',
      // settings.jsonのmodel設定に依存させず、bot用のモデル/effortを固定する
      '--model',
      'claude-fable-5',
      '--effort',
      'low',
      // 権限要求をcontrol_request(can_use_tool)としてstdioで受ける（help非掲載フラグ、CLI v2.1.220で検証済み）
      '--permission-prompt-tool',
      'stdio',
    ];

    if (params.resumeClaudeSessionId) {
      args.push('--resume', params.resumeClaudeSessionId);
    }

    // permission-mode: デフォルトは default（読み取り自動 + 書込等は承認）、RepoConfigで上書き可能
    const permissionMode = rc?.permissionMode || 'default';
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
        permissionMode,
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

    const entry: SessionEntry = { session, process: proc, idleTimer: null, terminating: false };
    this.sessions.set(params.sessionId, entry);

    // 最初のuserメッセージを投入（stdinは閉じない）
    this.writeLine(entry, {
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: params.prompt }] },
    });

    proc.stdout?.on('data', (data: Buffer) => {
      this.emit('data', params.sessionId, data.toString());
    });

    proc.stderr?.on('data', (data: Buffer) => {
      log.warn({ sessionId: params.sessionId, stderr: data.toString().trim() }, 'CLI stderr');
    });

    proc.on('exit', (code) => {
      const wasTerminating = this.sessions.get(params.sessionId)?.terminating ?? false;
      log.info({ sessionId: params.sessionId, exitCode: code, terminating: wasTerminating }, 'CLI終了');
      this.clearIdleTimer(params.sessionId);
      this.sessions.delete(params.sessionId);
      // 意図的終了（アイドルタイムアウト・中断）はエラー扱いさせない
      this.emit('exit', params.sessionId, wasTerminating ? 0 : (code ?? 1));
    });

    proc.on('error', (err) => {
      log.error({ sessionId: params.sessionId, err }, 'CLI起動エラー');
      this.clearIdleTimer(params.sessionId);
      this.sessions.delete(params.sessionId);
      this.emit('error', params.sessionId, err);
    });

    return session;
  }

  /**
   * 常駐プロセスに追加のuserメッセージを投入する（同一スレッドの2通目以降）
   */
  sendUserMessage(sessionId: string, text: string): boolean {
    const entry = this.sessions.get(sessionId);
    if (!entry) return false;
    this.markBusy(sessionId);
    log.info({ sessionId, prompt: text.slice(0, 100) }, '常駐プロセスへメッセージ投入');
    return this.writeLine(entry, {
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text }] },
    });
  }

  /**
   * control_request(can_use_tool)への承認/拒否応答を返す
   */
  sendControlResponse(sessionId: string, requestId: string, response: PermissionResponse): boolean {
    const entry = this.sessions.get(sessionId);
    if (!entry) return false;
    this.markBusy(sessionId);
    log.info({ sessionId, requestId, behavior: response.behavior }, 'control_response送信');
    return this.writeLine(entry, {
      type: 'control_response',
      response: { subtype: 'success', request_id: requestId, response },
    });
  }

  hasSession(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  /**
   * アイドル状態に入った（result受信・承認待ち開始）。タイムアウトで終了させる
   */
  markIdle(sessionId: string): void {
    const entry = this.sessions.get(sessionId);
    if (!entry) return;
    this.clearIdleTimer(sessionId);
    const timeout = this.config.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    entry.idleTimer = setTimeout(() => {
      log.info({ sessionId, timeoutMs: timeout }, 'アイドルタイムアウト、プロセス終了');
      this.terminate(sessionId);
    }, timeout);
  }

  /**
   * 処理再開（メッセージ投入・承認応答）。アイドルタイマーを解除する
   */
  markBusy(sessionId: string): void {
    this.clearIdleTimer(sessionId);
  }

  /**
   * 意図的にプロセスを終了する（exit時にエラー扱いしない）
   */
  terminate(sessionId: string): void {
    const entry = this.sessions.get(sessionId);
    if (entry) {
      entry.terminating = true;
      entry.process.kill('SIGTERM');
    }
  }

  updateClaudeSessionId(sessionId: string, claudeSessionId: string): void {
    const entry = this.sessions.get(sessionId);
    if (entry) {
      entry.session.claudeSessionId = claudeSessionId;
    }
  }

  kill(sessionId: string): void {
    this.terminate(sessionId);
  }

  private writeLine(entry: SessionEntry, obj: unknown): boolean {
    const stdin = entry.process.stdin;
    if (!stdin || stdin.destroyed) return false;
    stdin.write(JSON.stringify(obj) + '\n');
    return true;
  }

  private clearIdleTimer(sessionId: string): void {
    const entry = this.sessions.get(sessionId);
    if (entry?.idleTimer) {
      clearTimeout(entry.idleTimer);
      entry.idleTimer = null;
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
