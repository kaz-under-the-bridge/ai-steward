import { App, LogLevel } from '@slack/bolt';
import { createChildLogger } from '../logger.js';
import type { IncomingMessage, ApprovalAction, SlackFile } from '../types.js';

const log = createChildLogger('slack-bot');

export interface SlackBotConfig {
  botToken: string;
  appToken: string;
  signingSecret: string;
  allowedChannelIds: string[];
  mentionOnlyChannelIds: string[];
}

export interface SlackEventHandlers {
  onMessage(event: IncomingMessage): Promise<void>;
  onApprovalAction(event: ApprovalAction): Promise<void>;
}

export class SlackBot {
  private app: App;
  private config: SlackBotConfig;
  private botUserId: string | null = null;

  constructor(config: SlackBotConfig, handlers: SlackEventHandlers) {
    this.config = config;
    this.app = new App({
      token: config.botToken,
      appToken: config.appToken,
      signingSecret: config.signingSecret,
      socketMode: true,
      logLevel: LogLevel.WARN,
    });

    this.setupEventHandlers(handlers);
  }

  private setupEventHandlers(handlers: SlackEventHandlers): void {
    // メッセージイベント
    this.app.message(async ({ message, say }) => {
      if ('bot_id' in message) return;
      // file_shareサブタイプは画像添付メッセージなので許可、その他のサブタイプは無視
      if (message.subtype && message.subtype !== 'file_share') return;

      const channelId = message.channel;
      if (!this.config.allowedChannelIds.includes(channelId)) return;

      const text = ('text' in message ? message.text : '') || '';
      const isInThread = 'thread_ts' in message && !!message.thread_ts;
      const threadTs = ('thread_ts' in message && message.thread_ts) || message.ts;

      // メンション必須チャンネル: トップレベルメッセージはメンション必須、スレッド内は不要
      if (this.config.mentionOnlyChannelIds.includes(channelId) && !isInThread) {
        const mentionPattern = this.botUserId ? `<@${this.botUserId}>` : null;
        if (!mentionPattern || !text.includes(mentionPattern)) {
          return; // メンションなし → 無視
        }
      }

      // ファイル添付の抽出
      const files: SlackFile[] = [];
      if ('files' in message && Array.isArray(message.files)) {
        for (const f of message.files) {
          if (f.url_private_download && f.name && f.mimetype) {
            files.push({
              id: f.id,
              name: f.name,
              mimetype: f.mimetype,
              url: f.url_private_download,
            });
          }
        }
      }

      // テキストもファイルもない場合はスキップ
      if (!text && files.length === 0) return;

      const incoming: IncomingMessage = {
        channelId,
        threadTs,
        messageTs: message.ts,
        userId: 'user' in message ? (message.user ?? '') : '',
        text,
        files,
      };

      log.info({ channelId, threadTs, userId: incoming.userId }, 'メッセージ受信');

      try {
        await handlers.onMessage(incoming);
      } catch (err) {
        log.error({ err }, 'メッセージ処理でエラー');
        await say({
          text: 'エラーが発生しました。ログを確認してください。',
          thread_ts: threadTs,
        });
      }
    });

    // 承認ボタンアクション
    this.app.action('approval_approve', async ({ body, ack }) => {
      await ack();
      if (body.type !== 'block_actions') return;
      const action = body.actions[0];
      const sessionId = ('value' in action ? action.value : '') || '';
      const channelId = body.channel?.id || '';
      const threadTs = body.message?.thread_ts || body.message?.ts || '';
      const userId = body.user.id;

      log.info({ sessionId, userId }, '承認ボタン押下');
      await handlers.onApprovalAction({
        channelId,
        threadTs,
        userId,
        actionId: 'approve',
        sessionId,
      });
    });

    this.app.action('approval_reject', async ({ body, ack }) => {
      await ack();
      if (body.type !== 'block_actions') return;
      const action = body.actions[0];
      const sessionId = ('value' in action ? action.value : '') || '';
      const channelId = body.channel?.id || '';
      const threadTs = body.message?.thread_ts || body.message?.ts || '';
      const userId = body.user.id;

      log.info({ sessionId, userId }, '拒否ボタン押下');
      await handlers.onApprovalAction({
        channelId,
        threadTs,
        userId,
        actionId: 'reject',
        sessionId,
      });
    });
  }

  async start(): Promise<void> {
    await this.app.start();

    // Bot User IDを取得（メンションフィルタ用）
    try {
      const auth = await this.app.client.auth.test();
      this.botUserId = auth.user_id || null;
      log.info({ botUserId: this.botUserId }, 'Bot User ID取得');
    } catch (err) {
      log.warn({ err }, 'Bot User ID取得失敗（メンションフィルタ無効）');
    }

    log.info('Slack Bot 起動完了 (Socket Mode)');
  }

  async stop(): Promise<void> {
    await this.app.stop();
    log.info('Slack Bot 停止');
  }

  async postMessage(params: {
    channelId: string;
    threadTs: string;
    text: string;
  }): Promise<{ ts: string }> {
    const result = await this.app.client.chat.postMessage({
      channel: params.channelId,
      thread_ts: params.threadTs,
      text: params.text,
    });
    return { ts: result.ts || '' };
  }

  async postApprovalRequest(params: {
    channelId: string;
    threadTs: string;
    context: string;
    sessionId: string;
  }): Promise<{ ts: string }> {
    const result = await this.app.client.chat.postMessage({
      channel: params.channelId,
      thread_ts: params.threadTs,
      text: `承認が必要です: ${params.context}`,
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `*権限の承認が必要です*\n${params.context}`,
          },
        },
        {
          type: 'actions',
          elements: [
            {
              type: 'button',
              text: { type: 'plain_text', text: '承認' },
              style: 'primary',
              action_id: 'approval_approve',
              value: params.sessionId,
            },
            {
              type: 'button',
              text: { type: 'plain_text', text: '拒否' },
              style: 'danger',
              action_id: 'approval_reject',
              value: params.sessionId,
            },
          ],
        },
      ],
    });
    return { ts: result.ts || '' };
  }

  async updateMessage(params: {
    channelId: string;
    ts: string;
    text: string;
  }): Promise<void> {
    await this.app.client.chat.update({
      channel: params.channelId,
      ts: params.ts,
      text: params.text,
      blocks: [],
    });
  }
}
