import { v4 as uuidv4 } from 'uuid';
import { writeFileSync, mkdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { createChildLogger } from './logger.js';
import { SlackBot } from './slack-bot/index.js';
import { CliManager } from './cli-manager/index.js';
import { StreamProcessor } from './stream-processor/index.js';
import { StateManager } from './state-manager/index.js';
import { Formatter, DEFAULT_FORMATTER_CONFIG } from './formatter/index.js';
import { Router } from './router/index.js';
import { Maintenance } from './maintenance/index.js';
import { resolveRepoByName, resolveRepoFromPrefix, getRepoNames } from './repo-resolver.js';
import type { AppConfig, RepoConfig } from './config.js';
import type { IncomingMessage, StreamEvent, ApprovalAction, SlackFile } from './types.js';

const log = createChildLogger('orchestrator');

// 承認待ち情報（key: "sessionId:requestId"）
interface PendingApproval {
  sessionId: string;
  requestId: string;
  channelId: string;
  threadTs: string;
  toolName: string;
  input: Record<string, unknown>;
  suggestions: unknown[];
  approvalMessageTs: string;
}

export class Orchestrator {
  private config: AppConfig;
  private slackBot: SlackBot;
  private cliManager: CliManager;
  private streamProcessor: StreamProcessor;
  private stateManager: StateManager;
  private formatter: Formatter | null;
  private router: Router | null;
  private maintenance: Maintenance | null;
  private outputBuffers: Map<string, string> = new Map();
  private runningThreads: Set<string> = new Set();
  // 実行中スレッドの現在のsessionId（kill用、key: threadKey）
  private runningSessionIds: Map<string, string> = new Map();
  // result後もアイドルで生きている常駐プロセスのsessionId（key: threadKey）
  private liveThreadProcesses: Map<string, string> = new Map();
  // メッセージキュー（key: threadKey）
  private messageQueues: Map<string, IncomingMessage[]> = new Map();
  // 承認待ち（key: "sessionId:requestId"）
  private pendingApprovals: Map<string, PendingApproval> = new Map();
  // セッション毎のダウンロードファイル（完了後に削除用）
  private sessionFiles: Map<string, string[]> = new Map();
  // 「実行中...」メッセージのTS（進捗更新用、key: sessionId）
  private progressMessageTs: Map<string, { channelId: string; ts: string }> = new Map();
  // 進捗更新のdebounceタイマー（key: sessionId）
  private progressTimers: Map<string, NodeJS.Timeout> = new Map();
  // 進捗表示用のツール使用履歴（key: sessionId）
  private toolHistory: Map<string, string[]> = new Map();
  // resumeで起動したセッションの情報（リトライ判定用、key: sessionId）
  private resumeSessions: Map<string, { cwd: string; prompt: string; repoConfig?: RepoConfig }> = new Map();

  constructor(config: AppConfig) {
    this.config = config;
    this.streamProcessor = new StreamProcessor();
    this.cliManager = new CliManager({
      claudePath: config.claude.path,
      defaultCwd: config.claude.defaultCwd,
      homeDir: config.claude.homeDir,
      defaultPermissionMode: config.claude.defaultPermissionMode,
    });
    this.stateManager = new StateManager(config.dbPath);
    this.formatter = config.anthropicApiKey
      ? new Formatter({ ...DEFAULT_FORMATTER_CONFIG, anthropicApiKey: config.anthropicApiKey })
      : null;
    this.router = config.anthropicApiKey
      ? new Router(config.anthropicApiKey, 'claude-haiku-4-5-20251001', getRepoNames(config.claude.defaultCwd))
      : null;
    this.maintenance = config.anthropicApiKey
      ? new Maintenance(config.anthropicApiKey)
      : null;
    this.slackBot = new SlackBot(
      {
        botToken: config.slack.botToken,
        appToken: config.slack.appToken,
        signingSecret: config.slack.signingSecret,
        allowedChannelIds: config.slack.allowedChannelIds,
        allowedUserIds: config.slack.allowedUserIds,
        mentionOnlyChannelIds: config.slack.mentionOnlyChannelIds,
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
      this.handleProcessExit(sessionId).catch((err) => {
        log.error({ err, sessionId }, 'プロセス終了処理でエラー');
      });
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

  private static readonly CANCEL_PATTERNS = /^(cancel|中止|キャンセル|stop|やめて|中断)$/i;
  private static readonly MAINTENANCE_PATTERN = /^(メンテ[:：]\s*|maintenance[:：]?\s*)/i;

  private async handleMessage(msg: IncomingMessage): Promise<void> {
    const threadKey = `${msg.channelId}:${msg.threadTs}`;

    // メンテナンスモード判定（キーワード起動 or 既存メンテスレッド）
    if (this.maintenance && msg.text) {
      const maintenanceMatch = msg.text.match(Orchestrator.MAINTENANCE_PATTERN);
      const isMaintenanceThread = this.maintenance.isActiveThread(threadKey);

      if (maintenanceMatch || isMaintenanceThread) {
        // キーワード部分を除去してメッセージを渡す
        const cleanText = maintenanceMatch
          ? msg.text.replace(Orchestrator.MAINTENANCE_PATTERN, '').trim()
          : msg.text;

        if (!cleanText) {
          await this.slackBot.postMessage({
            channelId: msg.channelId,
            threadTs: msg.threadTs,
            text: 'メンテナンスモードです。調査・復旧の指示を入力してください。',
          });
          return;
        }

        log.info({ threadKey, isNew: !isMaintenanceThread }, 'メンテナンスモード');

        await this.slackBot.postMessage({
          channelId: msg.channelId,
          threadTs: msg.threadTs,
          text: isMaintenanceThread ? '確認中...' : '🔧 メンテナンスモード開始',
        });

        try {
          const response = await this.maintenance.handle(threadKey, cleanText);
          // Slack文字数制限対応（分割投稿）
          const messages = this.splitMaintenanceResponse(response);
          for (const text of messages) {
            await this.slackBot.postMessage({
              channelId: msg.channelId,
              threadTs: msg.threadTs,
              text,
            });
          }
        } catch (err) {
          log.error({ err, threadKey }, 'メンテナンスモード処理エラー');
          await this.slackBot.postMessage({
            channelId: msg.channelId,
            threadTs: msg.threadTs,
            text: `メンテナンスモードでエラーが発生しました: ${(err as Error).message}`,
          });
        }
        return;
      }
    }

    if (this.runningThreads.has(threadKey)) {
      // 中断キーワードの判定
      if (msg.text && Orchestrator.CANCEL_PATTERNS.test(msg.text.trim())) {
        await this.handleCancel(threadKey, msg);
        return;
      }

      // キューに追加
      const queue = this.messageQueues.get(threadKey) || [];
      queue.push(msg);
      this.messageQueues.set(threadKey, queue);
      log.info({ threadKey, queueSize: queue.length }, 'メッセージをキューに追加');
      await this.slackBot.postMessage({
        channelId: msg.channelId,
        threadTs: msg.threadTs,
        text: `キューに追加しました (${queue.length}件待ち)`,
      });
      return;
    }

    // 「新規」キーワードで強制新セッション
    const forceNew = !!msg.text && /^(新規セッション|new session|reset session)$/i.test(msg.text.trim());

    // 常駐プロセスが生きていれば同一プロセスに追送（再起動なしの対話継続）
    const liveSessionId = this.liveThreadProcesses.get(threadKey);
    if (liveSessionId && !forceNew && this.cliManager.hasSession(liveSessionId)) {
      const sent = await this.continueLiveSession(liveSessionId, threadKey, msg);
      if (sent) return;
      // 追送失敗（プロセス消滅）→ 通常の起動フローへ
      this.liveThreadProcesses.delete(threadKey);
    }
    if (forceNew && liveSessionId) {
      this.cliManager.terminate(liveSessionId);
      this.liveThreadProcesses.delete(threadKey);
    }

    const existingSession = this.stateManager.getSessionByThread(msg.channelId, msg.threadTs);
    let resumeClaudeSessionId = existingSession?.claudeSessionId || undefined;
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
      } else if (msg.text) {
        // メッセージ冒頭のリポ名マッチを優先（高速・確実）
        const prefixMatch = resolveRepoFromPrefix(msg.text, this.config.claude.defaultCwd);
        if (prefixMatch) {
          resolvedCwd = prefixMatch;
        } else if (this.router) {
          // フォールバック: Haikuルーターでリポ名を解決
          // セッション中にcloneされたリポも見えるよう、毎回一覧を取り直す
          this.router.updateRepoNames(getRepoNames(this.config.claude.defaultCwd));
          const routeResult = await this.router.route(msg.text);
          if (routeResult.repoName) {
            const repoPath = resolveRepoByName(routeResult.repoName, this.config.claude.defaultCwd);
            resolvedCwd = repoPath || this.config.claude.defaultCwd;
          } else {
            resolvedCwd = this.config.claude.defaultCwd;
          }
        } else {
          resolvedCwd = this.config.claude.defaultCwd;
        }
      } else {
        resolvedCwd = this.config.claude.defaultCwd;
      }
    }

    // 同じcwdで別スレッドが実行中なら拒否（誤操作保護）
    // ただしデフォルトcwd（リポ未解決）の場合はスキップ（汎用チャンネルで複数会話が成立するため）
    if (!existingSession && resolvedCwd !== this.config.claude.defaultCwd) {
      const runningSession = this.stateManager.hasRunningSessionByCwd(resolvedCwd);
      if (runningSession && `${runningSession.channelId}:${runningSession.threadTs}` !== threadKey) {
        log.info({ cwd: resolvedCwd, runningThreadTs: runningSession.threadTs }, '同じcwdで別スレッドが実行中のため拒否');
        await this.slackBot.postMessage({
          channelId: msg.channelId,
          threadTs: msg.threadTs,
          text: `同じリポジトリで別スレッドが実行中です。完了後にもう一度お試しください。`,
        });
        return;
      }
    }

    // 同一スレッド内にセッションがない場合、同じcwdの直近completedセッションを引き継ぐ
    if (!resumeClaudeSessionId && !forceNew) {
      const prevSession = this.stateManager.getLatestCompletedSessionByCwd(resolvedCwd);
      if (prevSession?.claudeSessionId) {
        resumeClaudeSessionId = prevSession.claudeSessionId;
        log.info({ cwd: resolvedCwd, claudeSessionId: prevSession.claudeSessionId }, 'cwdベースでセッション引き継ぎ');
      }
    }

    if (forceNew) {
      resumeClaudeSessionId = undefined;
      log.info({ cwd: resolvedCwd }, '新規セッション（強制）');
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
    this.runningSessionIds.set(threadKey, sessionId);

    const cwdShort = resolvedCwd.split('/').slice(-2).join('/');
    const modeLabel = resumeClaudeSessionId ? '継続実行中' : '実行中';
    const { ts: progressTs } = await this.slackBot.postMessage({
      channelId: msg.channelId,
      threadTs: msg.threadTs,
      text: `${modeLabel}... (${cwdShort})`,
    });
    this.progressMessageTs.set(sessionId, { channelId: msg.channelId, ts: progressTs });
    this.toolHistory.set(sessionId, []);

    const prompt = await this.buildPromptWithFiles(sessionId, msg);

    // resumeで起動する場合、リトライ用に情報を記録
    if (resumeClaudeSessionId) {
      this.resumeSessions.set(sessionId, { cwd: resolvedCwd, prompt, repoConfig });
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
      this.resumeSessions.delete(sessionId);
    }
  }

  /**
   * 常駐プロセスへ追加メッセージを投入して対話を継続する
   */
  private async continueLiveSession(
    sessionId: string,
    threadKey: string,
    msg: IncomingMessage,
  ): Promise<boolean> {
    const session = this.stateManager.getSession(sessionId);
    if (!session) return false;

    const prompt = await this.buildPromptWithFiles(sessionId, msg);

    this.outputBuffers.set(sessionId, '');
    this.runningThreads.add(threadKey);
    this.runningSessionIds.set(threadKey, sessionId);
    this.stateManager.updateStatus(sessionId, 'running');

    const sent = this.cliManager.sendUserMessage(sessionId, prompt);
    if (!sent) {
      // プロセス消滅 → 呼び出し元で通常起動にフォールバック
      this.runningThreads.delete(threadKey);
      this.runningSessionIds.delete(threadKey);
      this.outputBuffers.delete(sessionId);
      this.cleanupSessionFiles(sessionId);
      return false;
    }

    const cwdShort = session.cwd.split('/').slice(-2).join('/');
    const { ts: progressTs } = await this.slackBot.postMessage({
      channelId: msg.channelId,
      threadTs: msg.threadTs,
      text: `継続実行中... (${cwdShort})`,
    });
    this.progressMessageTs.set(sessionId, { channelId: msg.channelId, ts: progressTs });
    this.toolHistory.set(sessionId, []);
    log.info({ sessionId, threadKey }, '常駐プロセスで対話継続');
    return true;
  }

  /**
   * ファイル添付をダウンロードしてプロンプトに反映する
   */
  private async buildPromptWithFiles(sessionId: string, msg: IncomingMessage): Promise<string> {
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
        const filePaths = downloadedFiles.join(', ');
        prompt = `${prompt || '添付ファイルを確認してください'}\n\n添付ファイル: ${filePaths}`;
      }
    }

    // セッション毎にダウンロードファイルを記録（後で削除用）
    if (downloadedFiles.length > 0) {
      const existing = this.sessionFiles.get(sessionId) || [];
      this.sessionFiles.set(sessionId, [...existing, ...downloadedFiles]);
    }

    return prompt;
  }

  private async handleApprovalAction(action: ApprovalAction): Promise<void> {
    const pending = this.pendingApprovals.get(action.approvalKey);
    if (!pending) {
      log.warn({ approvalKey: action.approvalKey }, '承認リクエストが見つかりません（期限切れ）');
      await this.slackBot.postMessage({
        channelId: action.channelId,
        threadTs: action.threadTs,
        text: 'この承認は期限切れです。同じスレッドで再依頼してください。',
      });
      return;
    }

    this.pendingApprovals.delete(action.approvalKey);

    if (action.actionId === 'reject') {
      await this.slackBot.updateMessage({
        channelId: pending.channelId,
        ts: pending.approvalMessageTs,
        text: `拒否されました (by <@${action.userId}>): ${pending.toolName}`,
      });
      const sent = this.cliManager.sendControlResponse(pending.sessionId, pending.requestId, {
        behavior: 'deny',
        message: 'ユーザーがSlack上で拒否しました。この操作は行わず、代替案があれば提示してください。',
      });
      if (!sent) await this.notifyApprovalProcessGone(pending);
      log.info({ approvalKey: action.approvalKey }, '承認拒否');
      return;
    }

    // 承認（今回のみ / 今後も許可）
    const alwaysLabel = action.actionId === 'approve_always' ? '・今後も許可' : '';
    await this.slackBot.updateMessage({
      channelId: pending.channelId,
      ts: pending.approvalMessageTs,
      text: `承認されました (by <@${action.userId}>${alwaysLabel}): ${pending.toolName}`,
    });

    const sent = this.cliManager.sendControlResponse(pending.sessionId, pending.requestId, {
      behavior: 'allow',
      updatedInput: pending.input,
      ...(action.actionId === 'approve_always' && pending.suggestions.length > 0
        ? { updatedPermissions: pending.suggestions }
        : {}),
    });
    if (!sent) await this.notifyApprovalProcessGone(pending);
    log.info({ approvalKey: action.approvalKey, actionId: action.actionId }, '承認OK、control_response送信');
  }

  private async notifyApprovalProcessGone(pending: PendingApproval): Promise<void> {
    await this.slackBot.postMessage({
      channelId: pending.channelId,
      threadTs: pending.threadTs,
      text: 'セッションのプロセスが既に終了していました。同じスレッドで再依頼すると続きから再開します。',
    });
  }

  /**
   * CLIプロセス終了時の後片付け（アイドルタイムアウト・承認期限切れの通知を含む）
   */
  private async handleProcessExit(sessionId: string): Promise<void> {
    const session = this.stateManager.getSession(sessionId);
    if (!session) return;
    const threadKey = `${session.channelId}:${session.threadTs}`;

    if (this.liveThreadProcesses.get(threadKey) === sessionId) {
      this.liveThreadProcesses.delete(threadKey);
    }

    // 承認待ちのままプロセスが終了した場合（アイドルタイムアウト）
    const expired = Array.from(this.pendingApprovals.entries()).filter(
      ([, p]) => p.sessionId === sessionId,
    );
    if (expired.length === 0) return;

    for (const [key, p] of expired) {
      this.pendingApprovals.delete(key);
      try {
        await this.slackBot.updateMessage({
          channelId: p.channelId,
          ts: p.approvalMessageTs,
          text: `承認待ちのままタイムアウトしました（期限切れ）: ${p.toolName}`,
        });
      } catch (err) {
        log.warn({ err, sessionId }, '承認メッセージ更新失敗');
      }
    }

    if (this.runningSessionIds.get(threadKey) === sessionId) {
      await this.slackBot.postMessage({
        channelId: session.channelId,
        threadTs: session.threadTs,
        text: '承認待ちのままタイムアウトしたため中断しました。同じスレッドで再依頼すると続きから再開します。',
      });
      this.stateManager.updateStatus(sessionId, 'failed');
      this.finishSession(threadKey, sessionId);
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
          this.resumeSessions.delete(event.sessionId); // resume成功、リトライ不要
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

      case 'permission_request': {
        const p = event.permission;
        if (!p) break;
        const approvalKey = `${event.sessionId}:${p.requestId}`;
        const inputSummary = this.truncateInput(JSON.stringify(p.input, null, 2));
        const context = `ツール: \`${p.toolName}\`\n\`\`\`${inputSummary}\`\`\``;

        const { ts } = await this.slackBot.postApprovalRequest({
          channelId: session.channelId,
          threadTs: session.threadTs,
          context,
          approvalKey,
          hasSuggestions: p.suggestions.length > 0,
        });

        this.pendingApprovals.set(approvalKey, {
          sessionId: event.sessionId,
          requestId: p.requestId,
          channelId: session.channelId,
          threadTs: session.threadTs,
          toolName: p.toolName,
          input: p.input,
          suggestions: p.suggestions,
          approvalMessageTs: ts,
        });

        // 承認待ちもアイドルタイムアウトの対象にする（放置でプロセス終了）
        this.cliManager.markIdle(event.sessionId);
        log.info({ approvalKey, toolName: p.toolName }, '承認ボタンを表示');
        break;
      }

      case 'result': {
        const result = event.content || this.outputBuffers.get(event.sessionId) || '(出力なし)';

        // stewardセッション（デフォルトcwd）はFormatterスキップ（短い回答が多い）
        // リポ指定セッションでFormatterがあれば要約
        let messages: string[];
        const isStewardSession = session.cwd === this.config.claude.defaultCwd;
        if (this.formatter && !isStewardSession) {
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
        this.finishSession(threadKey, event.sessionId);

        // プロセスは生かしたまま常駐させる（次メッセージは同一プロセスへ追送）
        if (this.cliManager.hasSession(event.sessionId)) {
          this.liveThreadProcesses.set(threadKey, event.sessionId);
          this.cliManager.markIdle(event.sessionId);
        }
        break;
      }

      case 'error': {
        // リトライ等で新セッションに置き換わった後に届いた旧セッションのエラーは通知しない
        // （旧プロセスのexitイベントが遅れて届き、新セッションのスレッド管理を壊すのを防ぐ）
        const currentSessionId = this.runningSessionIds.get(threadKey);
        if (currentSessionId && currentSessionId !== event.sessionId) {
          log.info(
            { sessionId: event.sessionId, currentSessionId, content: event.content },
            '置き換え済みセッションのエラーイベントを破棄',
          );
          this.outputBuffers.delete(event.sessionId);
          this.resumeSessions.delete(event.sessionId);
          break;
        }

        // --resume付きで起動したのにinitイベントが来ずに即死した場合、resumeなしでリトライ
        const resumeInfo = this.resumeSessions.get(event.sessionId);
        if (resumeInfo && !session.claudeSessionId) {
          this.resumeSessions.delete(event.sessionId);
          log.warn({ sessionId: event.sessionId, cwd: resumeInfo.cwd }, 'resumeセッション即死、resumeなしでリトライ');

          this.stateManager.updateStatus(event.sessionId, 'failed');
          this.outputBuffers.delete(event.sessionId);
          this.cleanupProgress(event.sessionId);

          // 新しいセッションをresumeなしで起動
          const retrySessionId = uuidv4();
          this.stateManager.createSession({
            sessionId: retrySessionId,
            channelId: session.channelId,
            threadTs: session.threadTs,
            cwd: resumeInfo.cwd,
          });
          this.outputBuffers.set(retrySessionId, '');
          this.runningSessionIds.set(threadKey, retrySessionId);

          const cwdShort = resumeInfo.cwd.split('/').slice(-2).join('/');
          const progressInfo = this.progressMessageTs.get(event.sessionId);
          if (progressInfo) {
            try {
              await this.slackBot.updateMessage({
                channelId: progressInfo.channelId,
                ts: progressInfo.ts,
                text: `セッション再起動中... (${cwdShort})`,
              });
            } catch { /* ignore */ }
            this.progressMessageTs.set(retrySessionId, progressInfo);
          }
          this.progressMessageTs.delete(event.sessionId);
          this.toolHistory.set(retrySessionId, []);
          this.toolHistory.delete(event.sessionId);

          try {
            await this.cliManager.spawnSession({
              sessionId: retrySessionId,
              prompt: resumeInfo.prompt,
              cwd: resumeInfo.cwd,
              repoConfig: resumeInfo.repoConfig,
            });
          } catch (err) {
            log.error({ err, sessionId: retrySessionId }, 'リトライ起動失敗');
            this.stateManager.updateStatus(retrySessionId, 'failed');
            this.finishSession(threadKey, retrySessionId);
          }
          break;
        }

        this.resumeSessions.delete(event.sessionId);
        await this.slackBot.postMessage({
          channelId: session.channelId,
          threadTs: session.threadTs,
          text: `エラー: ${event.content}`,
        });

        this.stateManager.updateStatus(event.sessionId, 'failed');
        this.finishSession(threadKey, event.sessionId);
        break;
      }
    }
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

  private async handleCancel(threadKey: string, msg: IncomingMessage): Promise<void> {
    const sessionId = this.runningSessionIds.get(threadKey);
    if (sessionId) {
      this.cliManager.terminate(sessionId);
      this.stateManager.updateStatus(sessionId, 'failed');
      log.info({ threadKey, sessionId }, '中断リクエスト');
    }

    // キューもクリア
    this.messageQueues.delete(threadKey);
    if (sessionId) {
      this.finishSession(threadKey, sessionId);
    }

    await this.slackBot.postMessage({
      channelId: msg.channelId,
      threadTs: msg.threadTs,
      text: '中断しました。',
    });
  }

  private finishSession(threadKey: string, sessionId: string): void {
    this.runningThreads.delete(threadKey);
    this.runningSessionIds.delete(threadKey);
    this.outputBuffers.delete(sessionId);
    this.resumeSessions.delete(sessionId);
    this.cleanupSessionFiles(sessionId);
    this.cleanupProgress(sessionId);

    // キューに待ちメッセージがあれば次を実行
    const queue = this.messageQueues.get(threadKey);
    if (queue && queue.length > 0) {
      const next = queue.shift()!;
      if (queue.length === 0) {
        this.messageQueues.delete(threadKey);
      }
      log.info({ threadKey, remaining: queue.length }, 'キューから次のメッセージを実行');
      // 非同期で次のメッセージを処理（awaitしない）
      this.handleMessage(next).catch((err) => {
        log.error({ err, threadKey }, 'キューメッセージ処理失敗');
      });
    }
  }

  private splitMaintenanceResponse(text: string): string[] {
    const MAX = 3900;
    if (text.length <= MAX) return [text];

    const messages: string[] = [];
    let remaining = text;
    while (remaining.length > 0) {
      if (remaining.length <= MAX) {
        messages.push(remaining);
        break;
      }
      let splitIndex = remaining.lastIndexOf('\n', MAX);
      if (splitIndex < MAX * 0.5) splitIndex = MAX;
      messages.push(remaining.slice(0, splitIndex));
      remaining = remaining.slice(splitIndex).replace(/^\n/, '');
    }
    return messages;
  }

  private truncateForSlack(text: string): string {
    const MAX = 3900;
    if (text.length <= MAX) return text;
    const head = text.slice(0, Math.floor(MAX * 0.6));
    const tail = text.slice(-Math.floor(MAX * 0.3));
    return `${head}\n\n... (${text.length - head.length - tail.length}文字省略) ...\n\n${tail}`;
  }

  private truncateInput(text: string): string {
    const MAX = 1500;
    if (text.length <= MAX) return text;
    return `${text.slice(0, MAX)}\n... (${text.length - MAX}文字省略)`;
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
