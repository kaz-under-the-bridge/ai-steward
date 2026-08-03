import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { loadConfig } from '../config.js';

const REQUIRED_ENV: Record<string, string> = {
  SLACK_BOT_TOKEN: 'xoxb-test',
  SLACK_APP_TOKEN: 'xapp-test',
  SLACK_SIGNING_SECRET: 'secret-test',
  ALLOWED_CHANNEL_IDS: 'C001,C002',
  ALLOWED_USER_IDS: 'U001,U002',
};

const MANAGED_KEYS = [
  ...Object.keys(REQUIRED_ENV),
  'MENTION_ONLY_CHANNEL_IDS',
  'DEFAULT_PERMISSION_MODE',
];

let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = {};
  for (const key of MANAGED_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  for (const [key, value] of Object.entries(REQUIRED_ENV)) {
    process.env[key] = value;
  }
});

afterEach(() => {
  for (const key of MANAGED_KEYS) {
    if (savedEnv[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = savedEnv[key];
    }
  }
});

describe('loadConfig', () => {
  it('必須envが揃っていれば読み込める', () => {
    const config = loadConfig();
    expect(config.slack.allowedChannelIds).toEqual(['C001', 'C002']);
    expect(config.slack.allowedUserIds).toEqual(['U001', 'U002']);
  });

  it('ALLOWED_USER_IDS未設定時はエラー（fail-closed）', () => {
    delete process.env.ALLOWED_USER_IDS;
    expect(() => loadConfig()).toThrow('ALLOWED_USER_IDS');
  });

  it('ALLOWED_USER_IDSの空白をtrimしてパースする', () => {
    process.env.ALLOWED_USER_IDS = ' U001 , U002 ';
    const config = loadConfig();
    expect(config.slack.allowedUserIds).toEqual(['U001', 'U002']);
  });

  it('DEFAULT_PERMISSION_MODE未設定時はdefault', () => {
    const config = loadConfig();
    expect(config.claude.defaultPermissionMode).toBe('default');
  });
});
