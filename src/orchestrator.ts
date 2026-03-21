import { v4 as uuidv4 } from 'uuid';
import { writeFileSync, mkdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { createChildLogger } from './logger.js';
import { SlackBot } from './slack-bot/index.js';
import { CliManager } from './cli-manager/index.js';
import { StreamProcessor } from './stream-processor/index.js';
import { StateManager } from './state-manager/index.js';
import { Formatter, DEFAULT_FORMATTER_CONFIG } from './formatter/index.js';
import { resolveRepo } from './repo-resolver.js';
import type { AppConfig } from './config.js';
import type { IncomingMessage, StreamEvent, ApprovalAction, SlackFile } from './types.js';

const log = createChildLogger('orchestrator');

// 承認待ち情報
interface PendingApproval {
  sessionId: string;
  channelId: string;
  threadTs: string;
  claudeSessionId: string;
  cwd: string;
  permissionContent: string; // "Claude requested permissions to write to /path/to/file"
  approvalMessageTs: string; // 承認ボタンメッセージのTS（更新用）
}

export class Orchestrator {
  private config: AppConfig;
  private slackBot: SlackBot;
  private cliManager: CliManager;
  private streamProcessor: StreamProcessor;
  private stateManager: StateManager;
  private formatter: Formatter | null;
  private outputBuffers: Map<string, string> = new Map();
  private runningThreads: Set<string> = new Set();
  // 承認待ちセッション（key: sessionId）
  private pendingApprovals: Map<string, PendingApproval> = new Map();
  // セッション毎の権限エラー蓄積（複数回発生するため最初のものだけ使う）
  private permissionErrors: Map<string, string> = new Map();
  // セッション毎のダウンロードファイル（完了後に削除用）
  private sessionFiles: Map<string, string[]> = new Map();
  // 「実行中...」メッセージのTS（進捗更新用、key: sessionId）
  private progressMessageTs: Map<string, { channelId: string; ts: string }> = new Map();
  // 進捗更新のdebounceタイマー（key: sessionId）
  private progressTimers: Map<string, NodeJS.Timeout> = new Map();
  // 進捗表示用のツール使用履歴（key: sessionId）
  private toolHistory: Map<string, string[]> = new Map();

  constructor(config: AppConfig) {
    this.config = config;
    this.streamProcessor = new StreamProcessor();
    this.cliManager = new CliManager({
      claudePath: config.claude.path,
      defaultCwd: config.claude.defaultCwd,
      homeDir: config.claude.homeDir,
    });
    this.stateManager = new StateManager(config.dbPath);
    this.formatter = config.anthropicApiKey
      ? new Formatter({ ...DEFAULT_FORMATTER_CONFIG, anthropicApiKey: config.anthropicApiKey })
      : null;
    this.slackBot = new SlackBot(
      {
        botToken: config.slack.botToken,
        appToken: config.slack.appToken,
        signingSecret: config.slack.signingSecret,
        allowedChannelIds: config.slack.allowedChannelIds,
      },
      {
        onMessage: this.handleMessage.bind(this),
        onApprovalAction: this.handleApprovalAction.bind(this),
      },
    );

    this.wireEvents();
  }

  private wireEvents(): void {
    this.cliManager.on('data', (sessionId: string, data: string) => {
      this.streamProcessor.feed(sessionId, data);
    });

    this.cliManager.on('exit', (sessionId: string, exitCode: number) => {
      this.streamProcessor.notifyExit(sessionId, exitCode);
    });

    this.cliManager.on('error', (sessionId: string, err: Error) => {
      const session = this.stateManager.getSession(sessionId);
      if (session) {
        this.stateManager.updateStatus(sessionId, 'failed');
        this.runningThreads.delete(`${session.channelId}:${session.threadTs}`);
        this.slackBot.postMessage({
          channelId: session.channelId,
          threadTs: session.threadTs,
          text: `Claude Code起動エラー: ${err.message}`,
        });
      }
    });

    this.streamProcessor.on('stream', async (event: StreamEvent) => {
      await this.handleStreamEvent(event);
    });
  }

  private async handleMessage(msg: IncomingMessage): Promise<void> {
    const threadKey = `${msg.channelId}:${msg.threadTs}`;

    if (this.runningThreads.has(threadKey)) {
      log.info({ threadKey }, '実行中のため待機メッセージ');
      await this.slackBot.postMessage({
        channelId: msg.channelId,
        threadTs: msg.threadTs,
        text: '前の処理が実行中です。完了後にもう一度メッセージを送ってください。',
      });
      return;
    }

    const existingSession = this.stateManager.getSessionByThread(msg.channelId, msg.threadTs);
    const resumeClaudeSessionId = existingSession?.claudeSessionId || undefined;
    const cwd = existingSession?.cwd || undefined;

    let resolvedCwd: string;
    if (cwd) {
      resolvedCwd = cwd;
    } else {
      // チャンネル→リポバインディングを優先
      const boundRepo = this.config.channelRepoBindings.get(msg.channelId);
      if (boundRepo) {
        resolvedCwd = boundRepo;
        log.info({ channelId: msg.channelId, cwd: boundRepo }, 'チャンネルバインディングでcwd決定');
      } else {
        const resolved = resolveRepo(msg.text, this.config.claude.defaultCwd, this.config.claude.defaultCwd);
        resolvedCwd = resolved.cwd;
      }
    }

    // リポ名からRepoConfigを解決
    const repoName = resolvedCwd.split('/').pop() || '';
    const repoConfig = this.config.repoConfigs.get(repoName);

    const sessionId = uuidv4();

    this.stateManager.createSession({
      sessionId,
      channelId: msg.channelId,
      threadTs: msg.threadTs,
      cwd: resolvedCwd,
    });

    this.outputBuffers.set(sessionId, '');
    this.runningThreads.add(threadKey);

    const cwdShort = resolvedCwd.split('/').slice(-2).join('/');
    const modeLabel = resumeClaudeSessionId ? '継続実行中' : '実行中';
    const { ts: progressTs } = await this.slackBot.postMessage({
      channelId: msg.channelId,
      threadTs: msg.threadTs,
      text: `${modeLabel}... (${cwdShort})`,
    });
    this.progressMessageTs.set(sessionId, { channelId: msg.channelId, ts: progressTs });
    this.toolHistory.set(sessionId, []);

    // ファイル添付の処理（画像等）
    let prompt = msg.text;
    const downloadedFiles: string[] = [];

    if (msg.files.length > 0) {
      const tmpDir = '/tmp/ai-steward-files';
      mkdirSync(tmpDir, { recursive: true });

      for (const file of msg.files) {
        try {
          const localPath = await this.downloadSlackFile(file, tmpDir);
          downloadedFiles.push(localPath);
          log.info({ fileName: file.name, localPath }, 'ファイルダウンロード完了');
        } catch (err) {
          log.error({ err, fileName: file.name }, 'ファイルダウンロード失敗');
        }
      }

      if (downloadedFiles.length > 0) {
        const filePaths = downloadedFiles.map((p) => p).join(', ');
        prompt = `${prompt || '添付ファイルを確認してください'}\n\n添付ファイル: ${filePaths}`;
      }
    }

    // セッション毎にダウンロードファイルを記録（後で削除用）
    if (downloadedFiles.length > 0) {
      this.sessionFiles.set(sessionId, downloadedFiles);
    }

    try {
      await this.cliManager.spawnSession({
        sessionId,
        prompt,
        cwd: resolvedCwd,
        resumeClaudeSessionId,
        repoConfig,
      });
    } catch (err) {
      log.error({ err, sessionId }, 'セッション起動失敗');
      this.stateManager.updateStatus(sessionId, 'failed');
      this.runningThreads.delete(threadKey);
      this.outputBuffers.delete(sessionId);
      this.cleanupSessionFiles(sessionId);
    }
  }

  private async handleApprovalAction(action: ApprovalAction): Promise<void> {
    const pending = this.pendingApprovals.get(action.sessionId);
    if (!pending) {
      log.warn({ sessionId: action.sessionId }, '承認リクエストが見つかりません');
      return;
    }

    this.pendingApprovals.delete(action.sessionId);

    if (action.actionId === 'reject') {
      // 拒否 → ボタンを更新して終了
      await this.slackBot.updateMessage({
        channelId: pending.channelId,
        ts: pending.approvalMessageTs,
        text: `拒否されました (by <@${action.userId}>)`,
      });
      log.info({ sessionId: action.sessionId }, '承認拒否');
      return;
    }

    // 承認 → ボタンを更新
    await this.slackBot.updateMessage({
      channelId: pending.channelId,
      ts: pending.approvalMessageTs,
      text: `承認されました (by <@${action.userId}>)`,
    });

    log.info({ sessionId: action.sessionId }, '承認OK、--allowedTools付きで再実行');

    // 許可するツールを権限エラーメッセージから抽出
    const allowedTools = this.extractAllowedTools(pending.permissionContent);

    // 新しいセッションを作成して--resume + --allowedToolsで再実行
    const newSessionId = uuidv4();
    const threadKey = `${pending.channelId}:${pending.threadTs}`;

    this.stateManager.createSession({
      sessionId: newSessionId,
      channelId: pending.channelId,
      threadTs: pending.threadTs,
      cwd: pending.cwd,
    });

    this.outputBuffers.set(newSessionId, '');
    this.runningThreads.add(threadKey);

    await this.slackBot.postMessage({
      channelId: pending.channelId,
      threadTs: pending.threadTs,
      text: '承認済み、再実行中...',
    });

    try {
      await this.cliManager.spawnSession({
        sessionId: newSessionId,
        prompt: '先ほどの作業を続けてください。権限が許可されました。',
        cwd: pending.cwd,
        resumeClaudeSessionId: pending.claudeSessionId,
        allowedTools,
      });
    } catch (err) {
      log.error({ err, sessionId: newSessionId }, '再実行失敗');
      this.stateManager.updateStatus(newSessionId, 'failed');
      this.runningThreads.delete(threadKey);
      this.outputBuffers.delete(newSessionId);
    }
  }

  private async handleStreamEvent(event: StreamEvent): Promise<void> {
    const session = this.stateManager.getSession(event.sessionId);
    if (!session) return;

    const threadKey = `${session.channelId}:${session.threadTs}`;

    switch (event.type) {
      case 'init':
        if (event.content) {
          this.stateManager.updateClaudeSessionId(event.sessionId, event.content);
          this.cliManager.updateClaudeSessionId(event.sessionId, event.content);
          log.info({ sessionId: event.sessionId, claudeSessionId: event.content }, 'CLIセッションID取得');
        }
        break;

      case 'assistant_text': {
        const buf = this.outputBuffers.get(event.sessionId) || '';
        this.outputBuffers.set(event.sessionId, buf + event.content);
        break;
      }

      case 'tool_use': {
        // 進捗更新: ツール使用履歴に追加してdebounce更新
        const history = this.toolHistory.get(event.sessionId) || [];
        history.push(event.content);
        // 直近5件のみ保持
        if (history.length > 5) history.shift();
        this.toolHistory.set(event.sessionId, history);
        this.scheduleProgressUpdate(event.sessionId);
        break;
      }

      case 'permission_denied': {
        // 最初の権限エラーだけ記録（CLIが複数回リトライするため）
        if (!this.permissionErrors.has(event.sessionId)) {
          this.permissionErrors.set(event.sessionId, event.content);
          log.info({ sessionId: event.sessionId, content: event.content }, '権限エラー検知');
        }
        break;
      }

      case 'result': {
        // 権限エラーがあった場合は承認フローに移行
        const permError = this.permissionErrors.get(event.sessionId);
        if (permError) {
          this.permissionErrors.delete(event.sessionId);

          const claudeSessionId = session.claudeSessionId;
          if (claudeSessionId) {
            // Slack に承認ボタンを投稿
            const { ts } = await this.slackBot.postApprovalRequest({
              channelId: session.channelId,
              threadTs: session.threadTs,
              context: permError,
              sessionId: event.sessionId,
            });

            this.pendingApprovals.set(event.sessionId, {
              sessionId: event.sessionId,
              channelId: session.channelId,
              threadTs: session.threadTs,
              claudeSessionId,
              cwd: session.cwd,
              permissionContent: permError,
              approvalMessageTs: ts,
            });

            this.stateManager.updateStatus(event.sessionId, 'completed');
            this.runningThreads.delete(threadKey);
            this.outputBuffers.delete(event.sessionId);
            log.info({ sessionId: event.sessionId }, '承認ボタンを表示');
            break;
          }
        }

        // 通常完了
        const result = event.content || this.outputBuffers.get(event.sessionId) || '(出力なし)';

        // Formatterがあれば要約、なければそのまま
        let messages: string[];
        if (this.formatter) {
          const formatted = await this.formatter.format({ content: result, type: 'output' });
          messages = formatted.messages;
          if (formatted.wasSummarized) {
            log.info({ sessionId: event.sessionId, original: formatted.originalLength, summary: messages.join('').length }, '出力を要約');
          }
        } else {
          messages = [this.truncateForSlack(result)];
        }

        for (const msg of messages) {
          await this.slackBot.postMessage({
            channelId: session.channelId,
            threadTs: session.threadTs,
            text: msg,
          });
        }

        this.stateManager.updateStatus(event.sessionId, 'completed');
        this.runningThreads.delete(threadKey);
        this.outputBuffers.delete(event.sessionId);
        this.cleanupSessionFiles(event.sessionId);
        this.cleanupProgress(event.sessionId);
        break;
      }

      case 'error': {
        this.permissionErrors.delete(event.sessionId);
        await this.slackBot.postMessage({
          channelId: session.channelId,
          threadTs: session.threadTs,
          text: `エラー: ${event.content}`,
        });

        this.stateManager.updateStatus(event.sessionId, 'failed');
        this.runningThreads.delete(threadKey);
        this.outputBuffers.delete(event.sessionId);
        this.cleanupSessionFiles(event.sessionId);
        this.cleanupProgress(event.sessionId);
        break;
      }
    }
  }

  /**
   * 権限エラーメッセージからツール名を抽出
   * "Claude requested permissions to write to /path/to/file" → ["Write"]
   * "Claude requested permissions to run Bash command" → ["Bash"]
   */
  private extractAllowedTools(permissionContent: string): string[] {
    const tools: string[] = [];
    if (permissionContent.includes('write to') || permissionContent.includes('Write')) {
      tools.push('Write');
    }
    if (permissionContent.includes('edit') || permissionContent.includes('Edit')) {
      tools.push('Edit');
    }
    if (permissionContent.includes('Bash') || permissionContent.includes('run')) {
      tools.push('Bash');
    }
    if (permissionContent.includes('Read')) {
      tools.push('Read');
    }
    // フォールバック: ツールが特定できなかった場合はWrite+Editを許可
    if (tools.length === 0) {
      tools.push('Write', 'Edit');
    }
    return tools;
  }

  private async downloadSlackFile(file: SlackFile, tmpDir: string): Promise<string> {
    const localName = `${uuidv4().slice(0, 8)}-${file.name}`;
    const localPath = join(tmpDir, localName);

    // Slack APIのリダイレクトをフォローし、認証ヘッダを保持
    const response = await fetch(file.url, {
      headers: { Authorization: `Bearer ${this.config.slack.botToken}` },
      redirect: 'follow',
    });

    if (!response.ok) {
      // リダイレクト先でも認証が必要な場合がある
      // Slack files APIはリダイレクト時にCookieベースの認証に切り替わることがある
      // その場合はレスポンスからリダイレクトURLを取得して再リクエスト
      throw new Error(`Slack file download failed: ${response.status} ${response.statusText}`);
    }

    const buffer = Buffer.from(await response.arrayBuffer());

    // ダウンロードしたファイルがHTMLでないか検証
    const head = buffer.slice(0, 20).toString('utf-8');
    if (head.startsWith('<') || head.startsWith('<!')) {
      // HTMLが返ってきた場合、Locationヘッダからリダイレクト先を取得して再試行
      log.warn({ fileName: file.name }, 'Slack file download returned HTML, trying with redirect');

      // 代替方法: curlでリダイレクトフォロー + Cookie処理
      const { execFileSync } = await import('node:child_process');
      execFileSync('curl', [
        '-sL',
        '-H', `Authorization: Bearer ${this.config.slack.botToken}`,
        '-o', localPath,
        file.url,
      ], { timeout: 30000 });

      // それでもHTMLなら失敗
      const { readFileSync } = await import('node:fs');
      const downloaded = readFileSync(localPath);
      const downloadedHead = downloaded.slice(0, 20).toString('utf-8');
      if (downloadedHead.startsWith('<') || downloadedHead.startsWith('<!')) {
        throw new Error('Downloaded file is HTML, not an image. Check files:read scope.');
      }

      return localPath;
    }

    writeFileSync(localPath, buffer);
    return localPath;
  }

  private cleanupSessionFiles(sessionId: string): void {
    const files = this.sessionFiles.get(sessionId);
    if (!files) return;
    for (const filePath of files) {
      try {
        unlinkSync(filePath);
      } catch {
        // 無視
      }
    }
    this.sessionFiles.delete(sessionId);
  }

  private scheduleProgressUpdate(sessionId: string): void {
    // 既存タイマーをクリア（debounce）
    const existing = this.progressTimers.get(sessionId);
    if (existing) clearTimeout(existing);

    const timer = setTimeout(async () => {
      this.progressTimers.delete(sessionId);
      const msgInfo = this.progressMessageTs.get(sessionId);
      const history = this.toolHistory.get(sessionId);
      if (!msgInfo || !history || history.length === 0) return;

      const progressText = `実行中...\n${history.map((h) => `  → ${h}`).join('\n')}`;

      try {
        await this.slackBot.updateMessage({
          channelId: msgInfo.channelId,
          ts: msgInfo.ts,
          text: progressText,
        });
      } catch (err) {
        log.warn({ err, sessionId }, '進捗メッセージ更新失敗');
      }
    }, 2000); // 2秒debounce

    this.progressTimers.set(sessionId, timer);
  }

  private cleanupProgress(sessionId: string): void {
    const timer = this.progressTimers.get(sessionId);
    if (timer) clearTimeout(timer);
    this.progressTimers.delete(sessionId);
    this.progressMessageTs.delete(sessionId);
    this.toolHistory.delete(sessionId);
  }

  private truncateForSlack(text: string): string {
    const MAX = 3900;
    if (text.length <= MAX) return text;
    const head = text.slice(0, Math.floor(MAX * 0.6));
    const tail = text.slice(-Math.floor(MAX * 0.3));
    return `${head}\n\n... (${text.length - head.length - tail.length}文字省略) ...\n\n${tail}`;
  }

  async start(): Promise<void> {
    // tmpディレクトリを起動時に作成（/tmp がリフレッシュされた場合に備える）
    mkdirSync('/tmp/ai-steward-files', { recursive: true });

    const stale = this.stateManager.markStaleSessionsFailed();
    if (stale > 0) {
      log.warn({ count: stale }, '残存セッションをfailedに変更');
    }

    await this.slackBot.start();
    log.info('Orchestrator 起動完了');
  }

  async stop(): Promise<void> {
    for (const session of this.cliManager.getActiveSessions()) {
      this.cliManager.kill(session.sessionId);
    }
    await this.slackBot.stop();
    this.stateManager.close();
    log.info('Orchestrator 停止');
  }
}
