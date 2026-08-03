import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export interface RepoConfig {
  permissionMode?: string;    // --permission-mode
  addDirs?: string[];          // --add-dir（複数可）
  extraArgs?: string[];        // その他の任意CLI引数
  model?: string;              // --model（MODEL_MAINの上書き）
  effort?: string;             // --effort（MODEL_MAIN_EFFORTの上書き）
}

// claude CLI --effort の許容値
export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

export interface ModelConfig {
  // Claude Code CLI本体（--model / --effort）
  main: { model: string; effort: string };
  // Router / Formatter 用の軽量モデル
  light: string;
  // メンテナンスモード用モデル
  maintenance: string;
}

export interface AppConfig {
  slack: {
    botToken: string;
    appToken: string;
    signingSecret: string;
    allowedChannelIds: string[];
    allowedUserIds: string[];
    mentionOnlyChannelIds: string[];
  };
  claude: {
    path: string;
    homeDir: string;
    defaultCwd: string;
    // 既定の--permission-mode（RepoConfigのpermissionModeで上書き可）
    defaultPermissionMode: string;
    // 常駐CLIプロセス数の全体上限（超過分はキュー待ち）
    maxConcurrentSessions: number;
    // 1タスクのwall-clockタイムアウト（分）
    sessionTimeoutMinutes: number;
  };
  models: ModelConfig;
  anthropicApiKey: string | null;
  dbPath: string;
  logLevel: string;
  // リポ名 → CLI設定
  repoConfigs: Map<string, RepoConfig>;
  // チャンネルID → リポパス バインディング
  channelRepoBindings: Map<string, string>;
}

/**
 * "key1:val1,key2:val2" 形式の文字列をMapにパース
 */
function parseKeyValuePairs(input: string | undefined): Map<string, string> {
  const map = new Map<string, string>();
  if (!input) return map;
  for (const pair of input.split(',')) {
    const [key, value] = pair.split(':').map((s) => s.trim());
    if (key && value) {
      map.set(key, value);
    }
  }
  return map;
}

/**
 * config/repos.json を読み込んでリポ名→RepoConfigのMapを返す
 */
function loadRepoConfigs(): Map<string, RepoConfig> {
  const map = new Map<string, RepoConfig>();
  try {
    const configPath = resolve(process.cwd(), 'config/repos.json');
    const raw = readFileSync(configPath, 'utf-8');
    const parsed = JSON.parse(raw) as Record<string, RepoConfig>;
    for (const [name, config] of Object.entries(parsed)) {
      map.set(name, config);
    }
  } catch {
    // ファイルが存在しない場合は空Mapを返す
  }
  return map;
}

/**
 * 正の整数のenvを読む（未設定はデフォルト、不正値はエラー）
 */
function parsePositiveInt(key: string, defaultValue: number): number {
  const raw = process.env[key];
  if (!raw) return defaultValue;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`環境変数 ${key} は正の整数で指定してください: ${raw}`);
  }
  return value;
}

/**
 * effort値のenvを読む（未設定はデフォルト、許容値以外はエラー）
 */
function parseEffort(key: string, defaultValue: string): string {
  const raw = process.env[key];
  if (!raw) return defaultValue;
  if (!(EFFORT_LEVELS as readonly string[]).includes(raw)) {
    throw new Error(`環境変数 ${key} は ${EFFORT_LEVELS.join(' / ')} のいずれかで指定してください: ${raw}`);
  }
  return raw;
}

/**
 * repos.json の model / effort を起動時に検証する（不正値は起動エラー）
 */
function validateRepoConfigs(repoConfigs: Map<string, RepoConfig>): void {
  for (const [name, rc] of repoConfigs) {
    if (rc.model !== undefined && (typeof rc.model !== 'string' || !rc.model.trim())) {
      throw new Error(`repos.json ${name}.model は空でない文字列で指定してください`);
    }
    if (rc.effort !== undefined && !(EFFORT_LEVELS as readonly string[]).includes(rc.effort)) {
      throw new Error(`repos.json ${name}.effort は ${EFFORT_LEVELS.join(' / ')} のいずれかで指定してください: ${rc.effort}`);
    }
  }
}

export function loadConfig(): AppConfig {
  const required = (key: string): string => {
    const value = process.env[key];
    if (!value) throw new Error(`環境変数 ${key} が設定されていません`);
    return value;
  };

  const repoConfigs = loadRepoConfigs();
  validateRepoConfigs(repoConfigs);

  return {
    slack: {
      botToken: required('SLACK_BOT_TOKEN'),
      appToken: required('SLACK_APP_TOKEN'),
      signingSecret: required('SLACK_SIGNING_SECRET'),
      allowedChannelIds: required('ALLOWED_CHANNEL_IDS').split(',').map((s) => s.trim()),
      allowedUserIds: required('ALLOWED_USER_IDS').split(',').map((s) => s.trim()).filter(Boolean),
      mentionOnlyChannelIds: (process.env.MENTION_ONLY_CHANNEL_IDS || '').split(',').map((s) => s.trim()).filter(Boolean),
    },
    claude: {
      path: process.env.CLAUDE_PATH || 'claude',
      homeDir: process.env.CLAUDE_HOME || process.env.HOME || '/home/kaz',
      defaultCwd: process.env.CLAUDE_CWD || '/home/kaz/git',
      defaultPermissionMode: process.env.DEFAULT_PERMISSION_MODE || 'default',
      maxConcurrentSessions: parsePositiveInt('MAX_CONCURRENT_SESSIONS', 3),
      sessionTimeoutMinutes: parsePositiveInt('SESSION_TIMEOUT_MINUTES', 60),
    },
    models: {
      main: {
        model: process.env.MODEL_MAIN || 'claude-fable-5',
        effort: parseEffort('MODEL_MAIN_EFFORT', 'low'),
      },
      light: process.env.MODEL_LIGHT || 'claude-haiku-4-5-20251001',
      maintenance: process.env.MODEL_MAINTENANCE || 'claude-sonnet-4-6',
    },
    anthropicApiKey: process.env.ANTHROPIC_API_KEY || null,
    dbPath: process.env.DB_PATH || './data/steward.db',
    logLevel: process.env.LOG_LEVEL || 'info',
    repoConfigs,
    channelRepoBindings: parseKeyValuePairs(process.env.CHANNEL_REPO_BINDINGS),
  };
}
