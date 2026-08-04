import { v4 as uuidv4 } from 'uuid';
import { writeFileSync, mkdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { createChildLogger } from './logger.js';
import { SlackBot } from './slack-bot/index.js';
import { CliManager } from './cli-manager/index.js';
import { StreamProcessor } from './stream-processor/index.js';
import { StateManager } from './state-manager/index.js';
import type { PendingApprovalRecord } from './state-manager/index.js';
import { Formatter, DEFAULT_FORMATTER_CONFIG } from './formatter/index.js';
import { Router } from './router/index.js';
import { Maintenance } from './maintenance/index.js';
import { resolveRepoByName, resolveRepoFromPrefix, getRepoNames } from './repo-resolver.js';
import { redactSecrets } from './redaction.js';
import { formatElapsed, formatTokenCount, elapsedSinceSqliteUtc } from './format-utils.js';
import { getGitTaskInfo } from './git-info.js';
import type { AppConfig, RepoConfig } from './config.js';
import type {
  IncomingMessage,
  StreamEvent,
  ApprovalAction,
  QuestionAction,
  AskUserQuestionInput,
  SlackFile,
} from './types.js';

const log = createChildLogger('orchestrator');

// 直近タスクのusage（resultイベントのrawから収集、key: threadKey）
interface TaskUsage {
  model: string;
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
  finishedAt: Date;
}

// 再起動復旧時の自動承認（key: 復旧後のsessionId）
interface AutoApproval {
  toolName: string;
  always: boolean;
  suggestions: unknown[];
  expiresAt: number;
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
  // 全体同時実行上限の順番待ちキュー
  private globalQueue: IncomingMessage[] = [];
  // 直近タスクのusage（key: threadKey）と起動後の累計
  private lastUsageByThread: Map<string, TaskUsage> = new Map();
  // AskUserQuestionの回答収集（key: approvalKey）。questionMessageTsは各質問メッセージの更新用
  private questionAnswers: Map<string, { answers: Record<string, string>; questionMessageTs: string[] }> =
    new Map();
  private usageTotals = { tasks: 0, inputTokens: 0, outputTokens: 0, durationMs: 0 };
  // wall-clockタイムアウトタイマー（key: sessionId）
  private wallClockTimers: Map<string, NodeJS.Timeout> = new Map();
  // タスク開始時刻（PRリンクの誤検出防止用、key: sessionId）
  private taskStartedAt: Map<string, Date> = new Map();
  // 再起動復旧後のセッションで、最初に一致したツール要求を自動承認する（key: sessionId）
  private autoApprovals: Map<string, AutoApproval> = new Map();
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
      defaultModel: config.models.main.model,
      defaultEffort: config.models.main.effort,
    });
    this.stateManager = new StateManager(config.dbPath);
    this.formatter = config.anthropicApiKey
      ? new Formatter({ ...DEFAULT_FORMATTER_CONFIG, anthropicApiKey: config.anthropicApiKey, model: config.models.light })
      : null;
    this.router = config.anthropicApiKey
      ? new Router(config.anthropicApiKey, config.models.light, getRepoNames(config.claude.defaultCwd))
      : null;
    this.maintenance = config.anthropicApiKey
      ? new Maintenance(config.anthropicApiKey, config.models.maintenance)
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
        onQuestionAction: this.handleQuestionAction.bind(this),
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

    // 「!」prefixの操作コマンド（通常依頼と衝突しない予約形式）
    if (msg.text && msg.text.trim().startsWith('!')) {
      await this.handleCommand(msg.text.trim(), msg, threadKey);
      return;
    }

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

    // 全体同時実行上限: 実行中タスク数が上限なら順番待ちキューへ
    const maxConcurrent = this.config.claude.maxConcurrentSessions;
    if (this.runningSessionIds.size >= maxConcurrent) {
      this.globalQueue.push(msg);
      log.info({ threadKey, queueSize: this.globalQueue.length }, '同時実行上限のため全体キューに追加');
      await this.slackBot.postMessage({
        channelId: msg.channelId,
        threadTs: msg.threadTs,
        text: `同時実行上限（${maxConcurrent}件）に達しています。順番待ちに追加しました (${this.globalQueue.length}件待ち)`,
      });
      return;
    }
    // プロセス数が上限に達している場合、アイドル常駐プロセスを1つ終了して枠を空ける
    if (this.cliManager.getActiveSessions().length >= maxConcurrent) {
      this.evictIdleResident();
    }

    const existingSession = this.stateManager.getSessionByThread(msg.channelId, msg.threadTs);

    // 承認待ちのまま残った旧セッションは、新しい依頼で置き換える（ボタンは期限切れに）
    if (existingSession?.status === 'waiting_approval') {
      await this.expireApprovals(existingSession.sessionId, '新しい依頼により期限切れ');
      this.stateManager.updateStatus(existingSession.sessionId, 'failed');
    }

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
    log.info(this.ctx(sessionId), 'タスク開始');

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
      this.startWallClockTimer(sessionId, threadKey);
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
   * ログ相関用コンテキスト: sessionIdからthreadKey / cwdを引く
   */
  private ctx(sessionId: string): Record<string, string> {
    const s = this.stateManager.getSession(sessionId);
    return s ? { sessionId, threadKey: `${s.channelId}:${s.threadTs}`, cwd: s.cwd } : { sessionId };
  }

  /**
   * アイドル状態の常駐プロセスを1つ終了してプロセス枠を空ける
   */
  private evictIdleResident(): void {
    for (const [threadKey, sessionId] of this.liveThreadProcesses) {
      if (!this.runningThreads.has(threadKey)) {
        this.cliManager.terminate(sessionId);
        this.liveThreadProcesses.delete(threadKey);
        log.info({ threadKey, sessionId }, 'プロセス枠確保のためアイドル常駐プロセスを終了');
        return;
      }
    }
  }

  /**
   * 「!」prefixの操作コマンドを処理する（!status / !stop / !restart / !usage）
   */
  private async handleCommand(text: string, msg: IncomingMessage, threadKey: string): Promise<void> {
    const command = text.split(/\s+/)[0].toLowerCase();
    const reply = (replyText: string) =>
      this.slackBot.postMessage({ channelId: msg.channelId, threadTs: msg.threadTs, text: replyText });

    log.info({ threadKey, command }, '操作コマンド受信');

    switch (command) {
      case '!status': {
        const active = [
          ...this.stateManager.listSessionsByStatus('running'),
          ...this.stateManager.listSessionsByStatus('waiting_approval'),
        ];
        if (active.length === 0 && this.globalQueue.length === 0) {
          await reply('実行中のタスクはありません。');
          return;
        }
        const lines = active.map((s) => {
          const cwdShort = s.cwd.split('/').slice(-2).join('/');
          const elapsed = formatElapsed(elapsedSinceSqliteUtc(s.createdAt));
          const statusLabel = s.status === 'waiting_approval' ? '承認待ち' : '実行中';
          const here = `${s.channelId}:${s.threadTs}` === threadKey ? '（このスレッド）' : '';
          return `• ${cwdShort} — ${statusLabel} — 経過 ${elapsed}${here}`;
        });
        if (this.globalQueue.length > 0) {
          lines.push(`• 順番待ち: ${this.globalQueue.length}件`);
        }
        await reply(`実行中セッション (${active.length}件):\n${lines.join('\n')}`);
        return;
      }

      case '!stop': {
        if (!this.runningThreads.has(threadKey)) {
          await reply('このスレッドに実行中のタスクはありません。');
          return;
        }
        await this.handleCancel(threadKey, msg);
        return;
      }

      case '!restart': {
        // 常駐プロセスを終了する（claudeSessionIdはDBに残るため、次のメッセージは--resumeで文脈を引き継ぐ）
        let terminated = false;

        const runningSessionId = this.runningSessionIds.get(threadKey);
        if (runningSessionId) {
          this.cliManager.terminate(runningSessionId);
          this.stateManager.updateStatus(runningSessionId, 'cancelled');
          await this.expireApprovals(runningSessionId, '再起動により期限切れ');
          this.messageQueues.delete(threadKey);
          this.finishSession(threadKey, runningSessionId);
          log.info({ threadKey, sessionId: runningSessionId }, '!restart: 実行中タスクを中断');
          terminated = true;
        }

        const liveSessionId = this.liveThreadProcesses.get(threadKey);
        if (liveSessionId) {
          this.cliManager.terminate(liveSessionId);
          this.liveThreadProcesses.delete(threadKey);
          log.info({ threadKey, sessionId: liveSessionId }, '!restart: 常駐プロセスを終了');
          terminated = true;
        }

        const existing = this.stateManager.getSessionByThread(msg.channelId, msg.threadTs);
        if (existing?.claudeSessionId) {
          await reply(
            terminated
              ? 'セッションを再起動しました。次のメッセージは文脈を引き継いで再開します。'
              : '常駐プロセスは既に終了しています。次のメッセージは文脈を引き継いで再開します。',
          );
        } else {
          await reply('このスレッドに再起動対象のセッションはありません。次のメッセージは新規セッションとして起動します。');
        }
        return;
      }

      case '!usage': {
        const last = this.lastUsageByThread.get(threadKey);
        const lines: string[] = [];
        if (last) {
          lines.push(
            'このスレッドの直近タスク:',
            `• モデル: ${last.model}`,
            `• 実行時間: ${formatElapsed(last.durationMs)}`,
            `• トークン: 入力 ${formatTokenCount(last.inputTokens)} / 出力 ${formatTokenCount(last.outputTokens)}`,
          );
        } else {
          lines.push('このスレッドの完了タスクはまだありません。');
        }
        const t = this.usageTotals;
        lines.push(
          '',
          `起動後の累計 (${t.tasks}タスク):`,
          `• 実行時間: ${formatElapsed(t.durationMs)}`,
          `• トークン: 入力 ${formatTokenCount(t.inputTokens)} / 出力 ${formatTokenCount(t.outputTokens)}`,
          `• 実行中セッション: ${this.runningSessionIds.size}件`,
        );
        await reply(lines.join('\n'));
        return;
      }

      default:
        await reply(
          `不明なコマンドです: ${command}\n使えるコマンド: \`!status\`（実行中一覧） \`!stop\`（このスレッドのタスクを中断） \`!restart\`（文脈維持でプロセス再起動） \`!usage\`（トークン・実行時間）`,
        );
        return;
    }
  }

  /**
   * resultイベントのrawからusage情報を収集する
   */
  private collectUsage(threadKey: string, raw: Record<string, unknown>): void {
    const usage = (raw.usage as Record<string, unknown>) || {};
    const modelUsage = (raw.modelUsage as Record<string, unknown>) || {};
    const taskUsage: TaskUsage = {
      model: Object.keys(modelUsage)[0] || 'claude-fable-5',
      durationMs: (raw.duration_ms as number) || 0,
      inputTokens: (usage.input_tokens as number) || 0,
      outputTokens: (usage.output_tokens as number) || 0,
      finishedAt: new Date(),
    };
    this.lastUsageByThread.set(threadKey, taskUsage);
    this.usageTotals.tasks += 1;
    this.usageTotals.inputTokens += taskUsage.inputTokens;
    this.usageTotals.outputTokens += taskUsage.outputTokens;
    this.usageTotals.durationMs += taskUsage.durationMs;
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
    this.startWallClockTimer(sessionId, threadKey);
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
    const pending = this.stateManager.getPendingApproval(action.approvalKey);
    if (!pending) {
      log.warn({ approvalKey: action.approvalKey }, '承認リクエストが見つかりません（期限切れ）');
      await this.slackBot.postMessage({
        channelId: action.channelId,
        threadTs: action.threadTs,
        text: 'この承認は期限切れです。同じスレッドで再依頼してください。',
      });
      return;
    }

    this.stateManager.deletePendingApproval(action.approvalKey);

    // プロセスが既に居ない（再起動 or アイドル終了）→ --resumeで復旧
    if (!this.cliManager.hasSession(pending.sessionId)) {
      await this.resumeInterruptedApproval(pending, action);
      return;
    }

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
      else this.stateManager.updateStatus(pending.sessionId, 'running');
      log.info({ ...this.ctx(pending.sessionId), approvalKey: action.approvalKey }, '承認拒否');
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
    else this.stateManager.updateStatus(pending.sessionId, 'running');
    log.info(
      { ...this.ctx(pending.sessionId), approvalKey: action.approvalKey, actionId: action.actionId },
      '承認OK、control_response送信',
    );
  }

  /**
   * AskUserQuestionの各質問をSlackの選択肢ボタンとして投稿し、承認レコードに永続化する
   */
  private async postQuestionsToSlack(
    sessionId: string,
    session: { channelId: string; threadTs: string },
    approvalKey: string,
    requestId: string,
    input: Record<string, unknown>,
  ): Promise<void> {
    const questions = (input as unknown as AskUserQuestionInput).questions || [];
    if (questions.length === 0) {
      // 質問なし → そのまま許可（実質no-op）
      this.cliManager.sendControlResponse(sessionId, requestId, {
        behavior: 'allow',
        updatedInput: input,
      });
      return;
    }

    const messageTs: string[] = [];
    for (let i = 0; i < questions.length; i++) {
      const q = questions[i];
      const { ts } = await this.slackBot.postQuestion({
        channelId: session.channelId,
        threadTs: session.threadTs,
        header: q.header,
        question: q.question,
        options: q.options,
        approvalKey,
        questionIndex: i,
      });
      messageTs.push(ts);
    }

    this.questionAnswers.set(approvalKey, { answers: {}, questionMessageTs: messageTs });
    this.stateManager.createPendingApproval({
      approvalKey,
      sessionId,
      requestId,
      channelId: session.channelId,
      threadTs: session.threadTs,
      toolName: 'AskUserQuestion',
      input,
      suggestions: [],
      approvalMessageTs: messageTs[0],
    });
    this.stateManager.updateStatus(sessionId, 'waiting_approval');
    this.cliManager.markIdle(sessionId);
    log.info(
      { ...this.ctx(sessionId), approvalKey, questionCount: questions.length },
      '質問ボタンを表示',
    );
  }

  /**
   * AskUserQuestionの選択肢ボタン押下。全質問に回答が揃ったらanswersを注入して続行する
   */
  private async handleQuestionAction(action: QuestionAction): Promise<void> {
    const pending = this.stateManager.getPendingApproval(action.approvalKey);
    if (!pending) {
      await this.slackBot.postMessage({
        channelId: action.channelId,
        threadTs: action.threadTs,
        text: 'この質問は期限切れです。同じスレッドで再依頼してください。',
      });
      return;
    }

    // プロセス消滅（アイドルタイムアウト・再起動）後の回答は期限切れ扱い
    // （AskUserQuestionはツール実行前の状態を復元できないため、再依頼を案内する）
    if (!this.cliManager.hasSession(pending.sessionId)) {
      await this.expireApprovals(pending.sessionId, '質問が期限切れ');
      this.stateManager.updateStatus(pending.sessionId, 'failed');
      await this.slackBot.postMessage({
        channelId: pending.channelId,
        threadTs: pending.threadTs,
        text: '質問が期限切れになりました（プロセス終了）。同じスレッドで再依頼してください。',
      });
      return;
    }

    const questions = (pending.input as unknown as AskUserQuestionInput).questions || [];
    const q = questions[action.questionIndex];
    const option = q?.options?.[action.optionIndex];
    if (!q || !option) {
      log.warn({ approvalKey: action.approvalKey, action }, '質問回答のindexが不正');
      return;
    }

    const state = this.questionAnswers.get(action.approvalKey) || {
      answers: {},
      questionMessageTs: [],
    };
    state.answers[q.question] = option.label;
    this.questionAnswers.set(action.approvalKey, state);

    // 回答済み表示に更新
    const msgTs = state.questionMessageTs[action.questionIndex];
    if (msgTs) {
      try {
        await this.slackBot.updateMessage({
          channelId: pending.channelId,
          ts: msgTs,
          text: `❓ ${q.question} → *${option.label}* (by <@${action.userId}>)`,
        });
      } catch (err) {
        log.warn({ err, approvalKey: action.approvalKey }, '質問メッセージ更新失敗');
      }
    }

    // 全質問に回答が揃うまで待つ
    if (Object.keys(state.answers).length < questions.length) {
      log.info(
        { approvalKey: action.approvalKey, answered: Object.keys(state.answers).length, total: questions.length },
        '質問回答を受付（残りあり）',
      );
      return;
    }

    // answersを注入して許可 → ツールが回答を本体に返す（PoCで検証済みの方式）
    this.stateManager.deletePendingApproval(action.approvalKey);
    this.questionAnswers.delete(action.approvalKey);
    const sent = this.cliManager.sendControlResponse(pending.sessionId, pending.requestId, {
      behavior: 'allow',
      updatedInput: { ...pending.input, answers: state.answers },
    });
    if (!sent) {
      await this.notifyApprovalProcessGone(pending);
      return;
    }
    this.stateManager.updateStatus(pending.sessionId, 'running');
    log.info({ ...this.ctx(pending.sessionId), approvalKey: action.approvalKey }, '全質問回答、answersを注入');
  }

  private async notifyApprovalProcessGone(pending: PendingApprovalRecord): Promise<void> {
    await this.slackBot.postMessage({
      channelId: pending.channelId,
      threadTs: pending.threadTs,
      text: 'セッションのプロセスが既に終了していました。同じスレッドで再依頼すると続きから再開します。',
    });
  }

  /**
   * プロセス消滅後（再起動・アイドル終了）に押された承認ボタンを--resumeで復旧する。
   * 承認時は復旧セッションの最初の同名ツール要求を自動承認し、ボタンの二度押しなしで続行させる。
   */
  private async resumeInterruptedApproval(
    pending: PendingApprovalRecord,
    action: ApprovalAction,
  ): Promise<void> {
    const session = this.stateManager.getSession(pending.sessionId);
    const threadKey = `${pending.channelId}:${pending.threadTs}`;

    if (!session?.claudeSessionId) {
      await this.slackBot.updateMessage({
        channelId: pending.channelId,
        ts: pending.approvalMessageTs,
        text: `この承認は期限切れです: ${pending.toolName}`,
      });
      await this.slackBot.postMessage({
        channelId: pending.channelId,
        threadTs: pending.threadTs,
        text: 'セッションを復元できませんでした。同じスレッドで再依頼してください。',
      });
      this.stateManager.updateStatus(pending.sessionId, 'failed');
      return;
    }

    const approved = action.actionId !== 'reject';
    const alwaysLabel = action.actionId === 'approve_always' ? '・今後も許可' : '';
    await this.slackBot.updateMessage({
      channelId: pending.channelId,
      ts: pending.approvalMessageTs,
      text: approved
        ? `承認されました (by <@${action.userId}>${alwaysLabel})・セッション復旧中: ${pending.toolName}`
        : `拒否されました (by <@${action.userId}>): ${pending.toolName}`,
    });

    // 旧セッションを閉じて、--resumeで新セッションとして続きを実行
    this.stateManager.updateStatus(pending.sessionId, 'failed');
    this.stateManager.deletePendingApprovalsBySession(pending.sessionId);

    const prompt = approved
      ? `（中断復旧）先ほど承認待ちだった \`${pending.toolName}\` の実行が承認されました。中断したタスクを続きから実行してください。`
      : `（中断復旧）先ほど承認待ちだった \`${pending.toolName}\` の実行は拒否されました。この操作は行わず、代替案があれば提示してください。`;

    const repoName = session.cwd.split('/').pop() || '';
    const repoConfig = this.config.repoConfigs.get(repoName);
    const sessionId = uuidv4();

    this.stateManager.createSession({
      sessionId,
      channelId: pending.channelId,
      threadTs: pending.threadTs,
      cwd: session.cwd,
    });
    this.outputBuffers.set(sessionId, '');
    this.runningThreads.add(threadKey);
    this.runningSessionIds.set(threadKey, sessionId);
    this.resumeSessions.set(sessionId, { cwd: session.cwd, prompt, repoConfig });

    if (approved) {
      this.autoApprovals.set(sessionId, {
        toolName: pending.toolName,
        always: action.actionId === 'approve_always',
        suggestions: pending.suggestions,
        expiresAt: Date.now() + 5 * 60 * 1000,
      });
    }

    const cwdShort = session.cwd.split('/').slice(-2).join('/');
    const { ts: progressTs } = await this.slackBot.postMessage({
      channelId: pending.channelId,
      threadTs: pending.threadTs,
      text: `セッション復旧中... (${cwdShort})`,
    });
    this.progressMessageTs.set(sessionId, { channelId: pending.channelId, ts: progressTs });
    this.toolHistory.set(sessionId, []);

    try {
      await this.cliManager.spawnSession({
        sessionId,
        prompt,
        cwd: session.cwd,
        resumeClaudeSessionId: session.claudeSessionId,
        repoConfig,
      });
      this.startWallClockTimer(sessionId, threadKey);
      log.info({ sessionId, approvalKey: pending.approvalKey, approved }, '承認からセッション復旧');
    } catch (err) {
      log.error({ err, sessionId }, '復旧セッション起動失敗');
      this.stateManager.updateStatus(sessionId, 'failed');
      this.autoApprovals.delete(sessionId);
      this.finishSession(threadKey, sessionId);
      await this.slackBot.postMessage({
        channelId: pending.channelId,
        threadTs: pending.threadTs,
        text: 'セッションの復旧に失敗しました。同じスレッドで再依頼してください。',
      });
    }
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
    // 承認レコードはDBに残し、ボタン押下時に--resumeで復旧できるようにする
    const expired = this.stateManager.listPendingApprovalsBySession(sessionId);
    if (expired.length === 0) return;

    if (this.runningSessionIds.get(threadKey) === sessionId) {
      await this.slackBot.postMessage({
        channelId: session.channelId,
        threadTs: session.threadTs,
        text: '承認待ちのままアイドルタイムアウトしました。承認ボタンを押せば復旧して続行します。',
      });
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

        // AskUserQuestionはSlackの選択肢ボタンで中継する（承認ボタンではなく回答UI）
        if (p.toolName === 'AskUserQuestion') {
          await this.postQuestionsToSlack(event.sessionId, session, approvalKey, p.requestId, p.input);
          break;
        }

        // 再起動復旧セッション: 承認済みツールの最初の要求は自動承認（二度押し不要）
        const auto = this.autoApprovals.get(event.sessionId);
        if (auto && auto.toolName === p.toolName && Date.now() < auto.expiresAt) {
          this.autoApprovals.delete(event.sessionId);
          this.cliManager.sendControlResponse(event.sessionId, p.requestId, {
            behavior: 'allow',
            updatedInput: p.input,
            ...(auto.always && auto.suggestions.length > 0
              ? { updatedPermissions: auto.suggestions }
              : {}),
          });
          log.info({ approvalKey, toolName: p.toolName }, '復旧セッションの承認済みツールを自動承認');
          break;
        }

        const inputSummary = redactSecrets(this.truncateInput(JSON.stringify(p.input, null, 2)));
        const context = `ツール: \`${p.toolName}\`\n\`\`\`${inputSummary}\`\`\``;

        const { ts } = await this.slackBot.postApprovalRequest({
          channelId: session.channelId,
          threadTs: session.threadTs,
          context,
          approvalKey,
          hasSuggestions: p.suggestions.length > 0,
        });

        // 再起動後もボタンを有効にするためSQLiteに永続化
        this.stateManager.createPendingApproval({
          approvalKey,
          sessionId: event.sessionId,
          requestId: p.requestId,
          channelId: session.channelId,
          threadTs: session.threadTs,
          toolName: p.toolName,
          input: p.input,
          suggestions: p.suggestions,
          approvalMessageTs: ts,
        });
        this.stateManager.updateStatus(event.sessionId, 'waiting_approval');

        // 承認待ちもアイドルタイムアウトの対象にする（放置でプロセス終了）
        this.cliManager.markIdle(event.sessionId);
        log.info({ ...this.ctx(event.sessionId), approvalKey, toolName: p.toolName }, '承認ボタンを表示');
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
            text: redactSecrets(msg),
          });
        }

        // PRを作ったタスクにはgitの確定情報からPRリンクを添える（応答テキストの正規表現に頼らない）
        const startedAt = this.taskStartedAt.get(event.sessionId);
        if (startedAt && !isStewardSession) {
          const gitInfo = await getGitTaskInfo(session.cwd, startedAt);
          if (gitInfo?.prUrl) {
            await this.slackBot.postMessage({
              channelId: session.channelId,
              threadTs: session.threadTs,
              text: `🔗 PR: ${gitInfo.prUrl} (\`${gitInfo.branch}\` @ ${gitInfo.shortSha})`,
            });
          }
        }

        this.collectUsage(threadKey, event.raw);
        log.info(this.ctx(event.sessionId), 'タスク完了');
        this.stateManager.updateStatus(event.sessionId, 'completed');
        this.stateManager.deletePendingApprovalsBySession(event.sessionId);
        this.autoApprovals.delete(event.sessionId);
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
            this.startWallClockTimer(retrySessionId, threadKey);
          } catch (err) {
            log.error({ err, sessionId: retrySessionId }, 'リトライ起動失敗');
            this.stateManager.updateStatus(retrySessionId, 'failed');
            this.finishSession(threadKey, retrySessionId);
          }
          break;
        }

        this.resumeSessions.delete(event.sessionId);
        log.warn({ ...this.ctx(event.sessionId), content: event.content }, 'タスクエラー');
        await this.slackBot.postMessage({
          channelId: session.channelId,
          threadTs: session.threadTs,
          text: redactSecrets(`エラー: ${event.content}`),
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
      this.stateManager.updateStatus(sessionId, 'cancelled');
      await this.expireApprovals(sessionId, 'キャンセルにより期限切れ');
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

  /**
   * セッションの承認待ちボタンをすべて期限切れ表示にしてDBから削除する
   */
  private async expireApprovals(sessionId: string, reason: string): Promise<void> {
    const pendings = this.stateManager.listPendingApprovalsBySession(sessionId);
    for (const p of pendings) {
      try {
        await this.slackBot.updateMessage({
          channelId: p.channelId,
          ts: p.approvalMessageTs,
          text: `${reason}: ${p.toolName}`,
        });
      } catch (err) {
        log.warn({ err, sessionId }, '承認メッセージ更新失敗');
      }
    }
    this.stateManager.deletePendingApprovalsBySession(sessionId);
  }

  /**
   * wall-clockタイムアウト: タスク開始からの総経過時間で打ち切る（アイドルタイムアウトとは独立）
   */
  private startWallClockTimer(sessionId: string, threadKey: string): void {
    this.clearWallClockTimer(sessionId);
    // すべてのタスク開始経路がここを通るため、タスク開始時刻もここで記録する
    this.taskStartedAt.set(sessionId, new Date());
    const timeoutMinutes = this.config.claude.sessionTimeoutMinutes;
    const timer = setTimeout(() => {
      this.wallClockTimers.delete(sessionId);
      // 既に完了・置き換え済みなら何もしない
      if (this.runningSessionIds.get(threadKey) !== sessionId) return;
      this.handleWallClockTimeout(sessionId, threadKey, timeoutMinutes).catch((err) => {
        log.error({ err, sessionId }, 'wall-clockタイムアウト処理でエラー');
      });
    }, timeoutMinutes * 60 * 1000);
    this.wallClockTimers.set(sessionId, timer);
  }

  private clearWallClockTimer(sessionId: string): void {
    const timer = this.wallClockTimers.get(sessionId);
    if (timer) clearTimeout(timer);
    this.wallClockTimers.delete(sessionId);
  }

  private async handleWallClockTimeout(
    sessionId: string,
    threadKey: string,
    timeoutMinutes: number,
  ): Promise<void> {
    const session = this.stateManager.getSession(sessionId);
    log.warn({ sessionId, threadKey, timeoutMinutes }, 'wall-clockタイムアウト、タスク打ち切り');
    this.cliManager.terminate(sessionId);
    this.stateManager.updateStatus(sessionId, 'failed');
    await this.expireApprovals(sessionId, 'タイムアウトにより期限切れ');
    if (session) {
      await this.slackBot.postMessage({
        channelId: session.channelId,
        threadTs: session.threadTs,
        text: `実行時間の上限（${timeoutMinutes}分）に達したため打ち切りました。同じスレッドで再依頼すると続きから再開します。`,
      });
    }
    this.finishSession(threadKey, sessionId);
  }

  private finishSession(threadKey: string, sessionId: string): void {
    this.runningThreads.delete(threadKey);
    this.runningSessionIds.delete(threadKey);
    this.outputBuffers.delete(sessionId);
    this.resumeSessions.delete(sessionId);
    this.cleanupSessionFiles(sessionId);
    this.cleanupProgress(sessionId);
    this.clearWallClockTimer(sessionId);
    this.taskStartedAt.delete(sessionId);

    // スレッド内キューに待ちメッセージがあれば次を実行
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
      return;
    }

    // 全体キューに順番待ちがあれば次を実行（上限内かはhandleMessageで再判定される）
    if (this.globalQueue.length > 0 && this.runningSessionIds.size < this.config.claude.maxConcurrentSessions) {
      const next = this.globalQueue.shift()!;
      log.info({ remaining: this.globalQueue.length }, '全体キューから次のメッセージを実行');
      this.handleMessage(next).catch((err) => {
        log.error({ err }, '全体キューメッセージ処理失敗');
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

    await this.slackBot.start();
    await this.recoverAfterRestart();
    log.info('Orchestrator 起動完了');
  }

  /**
   * 再起動時の復旧: 実行中だったセッションは中断を通知してfailed化し、
   * 承認待ちセッションはレコードを残してボタン押下での--resume復旧を可能にする
   */
  private async recoverAfterRestart(): Promise<void> {
    for (const session of this.stateManager.listSessionsByStatus('running')) {
      this.stateManager.updateStatus(session.sessionId, 'failed');
      try {
        await this.slackBot.postMessage({
          channelId: session.channelId,
          threadTs: session.threadTs,
          text: 'ai-stewardの再起動により実行中のタスクが中断されました。同じスレッドで再依頼すると続きから再開します。',
        });
      } catch (err) {
        log.warn({ err, sessionId: session.sessionId }, '中断通知の投稿失敗');
      }
      log.warn({ sessionId: session.sessionId }, '再起動により実行中セッションをfailed化');
    }

    for (const session of this.stateManager.listSessionsByStatus('waiting_approval')) {
      const pendings = this.stateManager.listPendingApprovalsBySession(session.sessionId);
      if (pendings.length === 0) {
        // 承認レコードなし（旧バージョンからの残骸など）→ 復旧できないのでfailed化
        this.stateManager.updateStatus(session.sessionId, 'failed');
        try {
          await this.slackBot.postMessage({
            channelId: session.channelId,
            threadTs: session.threadTs,
            text: '再起動により承認待ちのタスクが失われました。同じスレッドで再依頼してください。',
          });
        } catch (err) {
          log.warn({ err, sessionId: session.sessionId }, '中断通知の投稿失敗');
        }
        continue;
      }
      // 承認レコードあり → ボタンは押下可能なまま（押下時に--resumeで復旧）
      log.info(
        { sessionId: session.sessionId, pendingCount: pendings.length },
        '承認待ちセッションを復旧待機（ボタン押下で--resume）',
      );
    }
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
