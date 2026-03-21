import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export interface RepoConfig {
  permissionMode?: string;    // --permission-mode
  addDirs?: string[];          // --add-dir（複数可）
  extraArgs?: string[];        // その他の任意CLI引数
}

export interface AppConfig {
  slack: {
    botToken: string;
    appToken: string;
    signingSecret: string;
    allowedChannelIds: string[];
  };
  claude: {
    path: string;
    homeDir: string;
    defaultCwd: string;
  };
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

export function loadConfig(): AppConfig {
  const required = (key: string): string => {
    const value = process.env[key];
    if (!value) throw new Error(`環境変数 ${key} が設定されていません`);
    return value;
  };

  return {
    slack: {
      botToken: required('SLACK_BOT_TOKEN'),
      appToken: required('SLACK_APP_TOKEN'),
      signingSecret: required('SLACK_SIGNING_SECRET'),
      allowedChannelIds: required('ALLOWED_CHANNEL_IDS').split(',').map((s) => s.trim()),
    },
    claude: {
      path: process.env.CLAUDE_PATH || 'claude',
      homeDir: process.env.CLAUDE_HOME || process.env.HOME || '/home/kaz',
      defaultCwd: process.env.CLAUDE_CWD || '/home/kaz/git',
    },
    anthropicApiKey: process.env.ANTHROPIC_API_KEY || null,
    dbPath: process.env.DB_PATH || './data/steward.db',
    logLevel: process.env.LOG_LEVEL || 'info',
    repoConfigs: loadRepoConfigs(),
    channelRepoBindings: parseKeyValuePairs(process.env.CHANNEL_REPO_BINDINGS),
  };
}
