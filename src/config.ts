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
  // リポ名 → permission-mode マッピング（未指定はdefault）
  repoPermissionOverrides: Map<string, string>;
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
    repoPermissionOverrides: parseKeyValuePairs(process.env.REPO_PERMISSION_OVERRIDES),
    channelRepoBindings: parseKeyValuePairs(process.env.CHANNEL_REPO_BINDINGS),
  };
}
