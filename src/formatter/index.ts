import Anthropic from '@anthropic-ai/sdk';
import { createChildLogger } from '../logger.js';

const log = createChildLogger('formatter');

export interface FormatterConfig {
  anthropicApiKey: string;
  model: string;
  maxOutputTokens: number;
  summaryThreshold: number; // この文字数以上なら要約
  slackMaxLength: number;
}

export interface FormattedOutput {
  messages: string[];
  wasSummarized: boolean;
  originalLength: number;
}

const SUMMARY_SYSTEM_PROMPT = `あなたはClaude Code CLIの出力を要約するアシスタントです。
ルール:
- 日本語で要約
- 重要な結果（成功/失敗、変更ファイル、エラー等）を優先
- Slack mrkdwn形式（*太字*, \`コード\`, \`\`\`コードブロック\`\`\`）
- 3000文字以内に収める
- 余計な前置きは不要。要約だけを出力`;

export class Formatter {
  private client: Anthropic;
  private config: FormatterConfig;

  constructor(config: FormatterConfig) {
    this.config = config;
    this.client = new Anthropic({ apiKey: config.anthropicApiKey });
  }

  async format(params: {
    content: string;
    type: 'output' | 'error' | 'timeout';
  }): Promise<FormattedOutput> {
    const { content, type } = params;
    const originalLength = content.length;

    // エラーやタイムアウトはそのまま
    if (type !== 'output') {
      return {
        messages: this.splitForSlack(content),
        wasSummarized: false,
        originalLength,
      };
    }

    // 閾値未満ならそのまま
    if (content.length < this.config.summaryThreshold) {
      return {
        messages: this.splitForSlack(content),
        wasSummarized: false,
        originalLength,
      };
    }

    // Haiku APIで要約
    try {
      const summary = await this.summarize(content);
      log.info({ originalLength, summaryLength: summary.length }, '要約完了');
      return {
        messages: this.splitForSlack(summary),
        wasSummarized: true,
        originalLength,
      };
    } catch (err) {
      log.warn({ err, originalLength }, '要約失敗、フォールバック');
      const fallback = this.fallbackFormat(content);
      return {
        messages: this.splitForSlack(fallback),
        wasSummarized: false,
        originalLength,
      };
    }
  }

  private async summarize(content: string): Promise<string> {
    // 入力が長すぎる場合は切り詰める（Haiku入力上限対策）
    const maxInput = 50000;
    const truncated = content.length > maxInput
      ? content.slice(0, maxInput) + '\n\n... (以降省略)'
      : content;

    const response = await this.client.messages.create({
      model: this.config.model,
      max_tokens: this.config.maxOutputTokens,
      system: SUMMARY_SYSTEM_PROMPT,
      messages: [
        {
          role: 'user',
          content: `以下のClaude Code CLI出力を要約してください:\n\n${truncated}`,
        },
      ],
    });

    const text = response.content
      .filter((c): c is Anthropic.TextBlock => c.type === 'text')
      .map((c) => c.text)
      .join('');

    return text || content;
  }

  private fallbackFormat(content: string): string {
    const max = this.config.slackMaxLength;
    if (content.length <= max) return content;

    const headSize = Math.floor(max * 0.6);
    const tailSize = Math.floor(max * 0.3);
    const head = content.slice(0, headSize);
    const tail = content.slice(-tailSize);
    const omitted = content.length - headSize - tailSize;

    return `${head}\n\n... (${omitted}文字省略) ...\n\n${tail}`;
  }

  private splitForSlack(text: string): string[] {
    const max = this.config.slackMaxLength;
    if (text.length <= max) return [text];

    const messages: string[] = [];
    let remaining = text;

    while (remaining.length > 0) {
      if (remaining.length <= max) {
        messages.push(remaining);
        break;
      }

      // 改行位置で分割
      let splitIndex = remaining.lastIndexOf('\n', max);
      if (splitIndex < max * 0.5) {
        // 良い分割点がなければ強制分割
        splitIndex = max;
      }

      messages.push(remaining.slice(0, splitIndex));
      remaining = remaining.slice(splitIndex).replace(/^\n/, '');
    }

    return messages;
  }
}

export const DEFAULT_FORMATTER_CONFIG: Omit<FormatterConfig, 'anthropicApiKey'> = {
  model: 'claude-haiku-4-5-20251001',
  maxOutputTokens: 1024,
  summaryThreshold: 500,
  slackMaxLength: 3900,
};
