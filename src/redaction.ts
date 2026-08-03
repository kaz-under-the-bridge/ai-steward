// Slackへ投稿するテキストから秘密情報らしき値をマスクする
// （repo-resolver同様のスタンドアロン関数。orchestratorから直接呼び出す）

const MASK = '[REDACTED]';

// 既知の秘密情報トークン形式
const TOKEN_PATTERNS: RegExp[] = [
  /xox[baprs]-[A-Za-z0-9-]{10,}/g,            // Slack Bot/App/User token
  /xapp-[A-Za-z0-9-]{10,}/g,                  // Slack App-level token
  /sk-ant-[A-Za-z0-9_-]{10,}/g,               // Anthropic API key
  /sk-[A-Za-z0-9]{20,}/g,                     // OpenAI等のAPI key
  /gh[pousr]_[A-Za-z0-9]{20,}/g,              // GitHub token (ghp_/gho_/ghu_/ghs_/ghr_)
  /github_pat_[A-Za-z0-9_]{20,}/g,            // GitHub fine-grained PAT
  /AKIA[0-9A-Z]{16}/g,                        // AWS Access Key ID
  /eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, // JWT
];

// key=value / key: value 形式で秘密らしきキーの値をマスク
const KEY_VALUE_PATTERN =
  /((?:password|passwd|secret|token|api[_-]?key|private[_-]?key|credential)s?["']?\s*[=:]\s*)(["']?)([^\s"',;]{4,})\2/gi;

// PEM秘密鍵ブロック
const PEM_PATTERN =
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g;

/**
 * テキスト中の秘密情報らしき値をマスクして返す
 */
export function redactSecrets(text: string): string {
  let result = text;
  result = result.replace(PEM_PATTERN, MASK);
  for (const pattern of TOKEN_PATTERNS) {
    result = result.replace(pattern, MASK);
  }
  result = result.replace(KEY_VALUE_PATTERN, `$1$2${MASK}$2`);
  return result;
}
