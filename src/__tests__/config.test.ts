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
  'MAX_CONCURRENT_SESSIONS',
  'SESSION_TIMEOUT_MINUTES',
  'MODEL_MAIN',
  'MODEL_MAIN_EFFORT',
  'MODEL_LIGHT',
  'MODEL_MAINTENANCE',
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

  it('同時実行上限とタイムアウトのデフォルトは3 / 60分', () => {
    const config = loadConfig();
    expect(config.claude.maxConcurrentSessions).toBe(3);
    expect(config.claude.sessionTimeoutMinutes).toBe(60);
  });

  it('MAX_CONCURRENT_SESSIONSをenvで上書きできる', () => {
    process.env.MAX_CONCURRENT_SESSIONS = '5';
    expect(loadConfig().claude.maxConcurrentSessions).toBe(5);
  });

  it('モデル設定のデフォルト値', () => {
    const config = loadConfig();
    expect(config.models.main).toEqual({ model: 'claude-fable-5', effort: 'low' });
    expect(config.models.light).toBe('claude-haiku-4-5-20251001');
    expect(config.models.maintenance).toBe('claude-sonnet-4-6');
  });

  it('MODEL_*のenvで上書きできる', () => {
    process.env.MODEL_MAIN = 'claude-opus-5';
    process.env.MODEL_MAIN_EFFORT = 'high';
    process.env.MODEL_LIGHT = 'claude-haiku-4-5';
    process.env.MODEL_MAINTENANCE = 'claude-sonnet-5';
    const config = loadConfig();
    expect(config.models.main).toEqual({ model: 'claude-opus-5', effort: 'high' });
    expect(config.models.light).toBe('claude-haiku-4-5');
    expect(config.models.maintenance).toBe('claude-sonnet-5');
  });

  it('MODEL_MAIN_EFFORTの不正値はエラー', () => {
    process.env.MODEL_MAIN_EFFORT = 'ultra';
    expect(() => loadConfig()).toThrow('MODEL_MAIN_EFFORT');
  });

  it('数値envの不正値はエラー', () => {
    process.env.SESSION_TIMEOUT_MINUTES = 'abc';
    expect(() => loadConfig()).toThrow('SESSION_TIMEOUT_MINUTES');
    process.env.SESSION_TIMEOUT_MINUTES = '0';
    expect(() => loadConfig()).toThrow('SESSION_TIMEOUT_MINUTES');
  });
});
