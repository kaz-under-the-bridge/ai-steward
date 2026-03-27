import Anthropic from '@anthropic-ai/sdk';
import { createChildLogger } from '../logger.js';

const log = createChildLogger('router');

export interface RouteResult {
  intent: 'task' | 'general';  // task=リポ指定の深い作業, general=stewardセッション
  repoName: string | null;     // 解決されたリポ名（null=未特定）
}

const SYSTEM_PROMPT = `あなたはSlackメッセージを分類するルーターです。
ユーザーのメッセージとリポジトリ一覧を見て、以下をJSON形式で返してください。

{
  "intent": "task" または "general",
  "repoName": "リポ名" または null
}

分類ルール:
- "task": 特定のリポジトリに対するコード変更、調査、分析など深い作業
- "general": git pull/clone/status、簡単な質問、複数リポを跨ぐ操作、リポ不明

repoName:
- リポジトリ一覧のディレクトリ名でマッチしてください
- メッセージ中にリポ名やその一部が含まれていれば特定してください
- 略称やパスの一部（例: "ouchi"→"ouchi-server"）も判定してください
- 特定できなければnull

JSONのみ出力。説明不要。`;

export class Router {
  private client: Anthropic;
  private model: string;
  private repoNames: string[];

  constructor(apiKey: string, model: string, repoNames: string[]) {
    this.client = new Anthropic({ apiKey });
    this.model = model;
    this.repoNames = repoNames;
  }

  updateRepoNames(repoNames: string[]): void {
    this.repoNames = repoNames;
  }

  async route(message: string): Promise<RouteResult> {
    try {
      const response = await this.client.messages.create({
        model: this.model,
        max_tokens: 100,
        system: SYSTEM_PROMPT,
        messages: [
          {
            role: 'user',
            content: `リポジトリ一覧: ${this.repoNames.join(', ')}\n\nメッセージ: ${message}`,
          },
        ],
      });

      const text = response.content
        .filter((c): c is Anthropic.TextBlock => c.type === 'text')
        .map((c) => c.text)
        .join('');

      const parsed = JSON.parse(text) as RouteResult;
      log.info({ intent: parsed.intent, repoName: parsed.repoName, message: message.slice(0, 80) }, 'ルーティング結果');
      return parsed;
    } catch (err) {
      log.warn({ err, message: message.slice(0, 80) }, 'ルーティング失敗、generalにフォールバック');
      return { intent: 'general', repoName: null };
    }
  }
}
