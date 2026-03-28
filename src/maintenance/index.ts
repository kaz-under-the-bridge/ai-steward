import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import Anthropic from '@anthropic-ai/sdk';
import { createChildLogger } from '../logger.js';

const execFileAsync = promisify(execFile);
const log = createChildLogger('maintenance');

// コマンド許可リスト（正規表現）
const ALLOWED_COMMANDS: RegExp[] = [
  // ログ確認
  /^journalctl\s/,
  // サービス操作
  /^sudo\s+systemctl\s+(status|restart|stop|start)\s+ai-steward/,
  /^systemctl\s+(status|is-active)\s+ai-steward/,
  // ファイル・ディレクトリ参照
  /^cat\s+/,
  /^ls\s/,
  /^head\s/,
  /^tail\s/,
  // プロセス・リソース確認
  /^ps\s/,
  /^df\s/,
  /^free\s/,
  /^dmesg\b/,
  /^fuser\s/,
  // Git（読み取りのみ）
  /^git\s+(status|log|diff|branch|show)/,
  /^cd\s+.*&&\s*git\s+(status|log|diff|branch|show)/,
  // npm（ビルド・テスト）
  /^cd\s+.*&&\s*npm\s+(run\s+build|test|start)/,
  /^npm\s+(run\s+build|test|start)/,
  // grep / find（調査用）
  /^grep\s/,
  /^find\s/,
  // SQLite読み取り
  /^sqlite3\s+.*\.(db|sqlite)/,
  // rm は特定ファイルのみ（lock系）
  /^rm\s+-?f?\s+.*\.(lock|wal|shm)$/,
];

// ツール定義
const TOOLS: Anthropic.Tool[] = [
  {
    name: 'run_command',
    description:
      'サーバー上でシェルコマンドを実行する。許可リストに含まれるコマンドのみ実行可能。',
    input_schema: {
      type: 'object' as const,
      properties: {
        command: {
          type: 'string',
          description: '実行するシェルコマンド',
        },
      },
      required: ['command'],
    },
  },
  {
    name: 'read_file',
    description: 'ファイルの内容を読む。設定ファイルやログの確認に使用。',
    input_schema: {
      type: 'object' as const,
      properties: {
        path: {
          type: 'string',
          description: 'ファイルの絶対パス',
        },
        max_lines: {
          type: 'number',
          description: '読み取る最大行数（省略時は200行）',
        },
      },
      required: ['path'],
    },
  },
];

interface ConversationMessage {
  role: 'user' | 'assistant';
  content: Anthropic.MessageParam['content'];
}

const MAX_HISTORY = 20; // スレッド毎の最大ターン数
const COMMAND_TIMEOUT = 30000; // コマンドタイムアウト（30秒）

export class Maintenance {
  private client: Anthropic;
  private model: string;
  private systemPrompt: string;
  // スレッド毎の会話履歴（key: threadKey）
  private conversations: Map<string, ConversationMessage[]> = new Map();
  // メンテモードがアクティブなスレッド
  private activeThreads: Set<string> = new Set();

  constructor(apiKey: string, model: string = 'claude-sonnet-4-20250514') {
    this.client = new Anthropic({ apiKey });
    this.model = model;
    this.systemPrompt = this.loadSystemPrompt();
  }

  private loadSystemPrompt(): string {
    const parts: string[] = [];

    // Runbook（メイン）
    try {
      const runbookPath = resolve(process.cwd(), 'docs/maintenance-runbook.md');
      parts.push(readFileSync(runbookPath, 'utf-8'));
    } catch {
      parts.push('# Runbookが見つかりません。基本的な障害対応を行ってください。');
    }

    // プロジェクトCLAUDE.md
    try {
      const claudeMdPath = resolve(process.cwd(), 'CLAUDE.md');
      const content = readFileSync(claudeMdPath, 'utf-8');
      parts.push('\n\n---\n# プロジェクト設定 (CLAUDE.md)\n\n' + content);
    } catch {
      // なくても問題ない
    }

    return parts.join('');
  }

  /** メンテモードがアクティブなスレッドかどうか */
  isActiveThread(threadKey: string): boolean {
    return this.activeThreads.has(threadKey);
  }

  /** メンテモードのメッセージ処理 */
  async handle(
    threadKey: string,
    userMessage: string,
  ): Promise<string> {
    this.activeThreads.add(threadKey);

    // 会話履歴を取得・追加
    const history = this.conversations.get(threadKey) || [];
    history.push({ role: 'user', content: userMessage });

    // 古いターンを切り捨て
    while (history.length > MAX_HISTORY * 2) {
      history.shift();
    }
    this.conversations.set(threadKey, history);

    // Anthropic API呼び出し（tool useループ）
    const response = await this.runConversation(history);

    return response;
  }

  private async runConversation(
    history: ConversationMessage[],
  ): Promise<string> {
    const messages = history.map((h) => ({
      role: h.role as 'user' | 'assistant',
      content: h.content,
    }));

    let response = await this.client.messages.create({
      model: this.model,
      max_tokens: 4096,
      system: this.systemPrompt,
      tools: TOOLS,
      messages,
    });

    // tool useループ: LLMがtool_useを返す限り繰り返す
    while (response.stop_reason === 'tool_use') {
      const assistantContent = response.content;
      history.push({ role: 'assistant', content: assistantContent });

      const toolResults: Anthropic.ToolResultBlockParam[] = [];
      for (const block of assistantContent) {
        if (block.type === 'tool_use') {
          const result = await this.executeTool(block.name, block.input as Record<string, unknown>);
          toolResults.push({
            type: 'tool_result',
            tool_use_id: block.id,
            content: result,
          });
        }
      }

      history.push({ role: 'user', content: toolResults });

      const nextMessages = history.map((h) => ({
        role: h.role as 'user' | 'assistant',
        content: h.content,
      }));

      response = await this.client.messages.create({
        model: this.model,
        max_tokens: 4096,
        system: this.systemPrompt,
        tools: TOOLS,
        messages: nextMessages,
      });
    }

    // 最終テキスト応答を抽出
    const textBlocks = response.content.filter(
      (c): c is Anthropic.TextBlock => c.type === 'text',
    );
    const finalText = textBlocks.map((c) => c.text).join('\n');

    history.push({ role: 'assistant', content: finalText });

    return finalText || '(応答なし)';
  }

  private async executeTool(
    name: string,
    input: Record<string, unknown>,
  ): Promise<string> {
    switch (name) {
      case 'run_command':
        return this.executeCommand(input.command as string);
      case 'read_file':
        return this.readFile(input.path as string, input.max_lines as number | undefined);
      default:
        return `不明なツール: ${name}`;
    }
  }

  private async executeCommand(command: string): Promise<string> {
    // 許可リスト照合
    const isAllowed = ALLOWED_COMMANDS.some((pattern) => pattern.test(command));
    if (!isAllowed) {
      log.warn({ command }, 'メンテモード: 許可リスト外のコマンドを拒否');
      return `コマンドが許可リストに含まれていません: ${command}\n許可されているコマンド: journalctl, systemctl (ai-steward), cat, ls, ps, df, free, git (読み取り), npm (build/test)`;
    }

    log.info({ command }, 'メンテモード: コマンド実行');

    try {
      const { stdout, stderr } = await execFileAsync('bash', ['-c', command], {
        timeout: COMMAND_TIMEOUT,
        maxBuffer: 1024 * 1024, // 1MB
        env: { ...process.env, TERM: 'dumb' },
      });

      let output = stdout || '';
      if (stderr) {
        output += (output ? '\n' : '') + `[stderr] ${stderr}`;
      }

      // 出力が長すぎる場合は切り詰め
      if (output.length > 10000) {
        output = output.slice(0, 5000) + '\n\n... (省略) ...\n\n' + output.slice(-3000);
      }

      return output || '(出力なし)';
    } catch (err: unknown) {
      const error = err as { code?: string; killed?: boolean; stderr?: string; message?: string };
      if (error.killed) {
        return `コマンドがタイムアウトしました（${COMMAND_TIMEOUT / 1000}秒）`;
      }
      return `実行エラー: ${error.stderr || error.message || '不明なエラー'}`;
    }
  }

  private readFile(path: string, maxLines?: number): string {
    try {
      const content = readFileSync(path, 'utf-8');
      const lines = content.split('\n');
      const limit = maxLines || 200;
      if (lines.length > limit) {
        return lines.slice(0, limit).join('\n') + `\n\n... (残り${lines.length - limit}行省略)`;
      }
      return content;
    } catch (err: unknown) {
      const error = err as { message?: string };
      return `ファイル読み取りエラー: ${error.message || '不明'}`;
    }
  }
}
