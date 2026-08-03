import { describe, it, expect } from 'vitest';
import { redactSecrets } from '../redaction.js';

describe('redactSecrets', () => {
  it('Slackトークンをマスクする', () => {
    expect(redactSecrets('token is xoxb-1234567890-abcdefGHIJKL')).not.toContain('xoxb-1234567890');
    expect(redactSecrets('xapp-1-A0123456789-abcdef')).toContain('[REDACTED]');
  });

  it('Anthropic / GitHub / AWSのキーをマスクする', () => {
    expect(redactSecrets('sk-ant-api03-abc_def-123456')).toContain('[REDACTED]');
    expect(redactSecrets('ghp_abcdefghijklmnopqrstuvwxyz012345')).toContain('[REDACTED]');
    expect(redactSecrets('AKIAIOSFODNN7EXAMPLE')).toContain('[REDACTED]');
  });

  it('key=value形式の秘密値をマスクする', () => {
    const out = redactSecrets('SLACK_SIGNING_SECRET=abcd1234efgh');
    expect(out).toContain('SLACK_SIGNING_SECRET=');
    expect(out).not.toContain('abcd1234efgh');
    const out2 = redactSecrets('"api_key": "my-secret-value"');
    expect(out2).not.toContain('my-secret-value');
  });

  it('PEM秘密鍵ブロックをマスクする', () => {
    const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA\n-----END RSA PRIVATE KEY-----';
    expect(redactSecrets(pem)).toBe('[REDACTED]');
  });

  it('通常のテキストは変更しない', () => {
    const text = 'READMEに1行追記して、PRを作成してください。ファイルはsrc/config.tsです。';
    expect(redactSecrets(text)).toBe(text);
  });
});
