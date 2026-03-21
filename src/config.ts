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
  };
}
