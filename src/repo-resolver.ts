import { execFileSync } from 'node:child_process';
import { createChildLogger } from './logger.js';

const log = createChildLogger('repo-resolver');

let cachedRepos: { name: string; path: string }[] | null = null;

/**
 * /home/kaz/git 配下のgitリポジトリ一覧をキャッシュ付きで取得
 */
function getRepoList(gitRoot: string): { name: string; path: string }[] {
  if (cachedRepos) return cachedRepos;

  try {
    // findはPermission deniedでexit 1を返すことがあるため、エラーでも stdout を使う
    let output: string;
    try {
      output = execFileSync(
        'find',
        [gitRoot, '-maxdepth', '4', '-name', '.git', '-type', 'd'],
        { encoding: 'utf-8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] },
      );
    } catch (execErr: unknown) {
      // exit code !== 0 でもstdoutにはデータがある場合がある
      const e = execErr as { stdout?: string };
      output = e.stdout || '';
      if (!output) throw execErr;
    }

    cachedRepos = output
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((gitDir) => {
        const repoPath = gitDir.replace(/\/.git$/, '');
        const name = repoPath.split('/').pop() || '';
        return { name, path: repoPath };
      });

    log.info({ count: cachedRepos.length }, 'リポジトリ一覧取得');
    return cachedRepos;
  } catch {
    log.warn('リポジトリ一覧の取得に失敗');
    return [];
  }
}

/**
 * キャッシュをクリア（リポジトリ追加時等）
 */
export function clearRepoCache(): void {
  cachedRepos = null;
}

/**
 * メッセージからリポジトリ名を抽出してパスを解決する
 *
 * パターン例:
 *   "ouchi-serverでREADMEを見せて" → /home/kaz/git/.../ouchi-server
 *   "ai-stewardのsrc構成を教えて" → /home/kaz/git/.../ai-steward
 *   "loglassリポでgit logを見て" → /home/kaz/git/loglass/loglass
 *
 * @returns { cwd, cleanedPrompt } cwdが解決できなければdefaultCwd
 */
export function resolveRepo(
  message: string,
  gitRoot: string,
  defaultCwd: string,
): { cwd: string; cleanedPrompt: string } {
  const repos = getRepoList(gitRoot);
  if (repos.length === 0) {
    return { cwd: defaultCwd, cleanedPrompt: message };
  }

  // 「〜で」「〜の」「〜リポで」「〜リポの」パターンでリポ名を抽出
  // 長い名前から先にマッチさせる（部分一致を避ける）
  const sortedRepos = [...repos].sort((a, b) => b.name.length - a.name.length);

  for (const repo of sortedRepos) {
    // リポ名の前後にデリミタがあるパターン
    const patterns = [
      new RegExp(`(${escapeRegExp(repo.name)})(リポ)?(で|の|を|に|から)`, 'i'),
      new RegExp(`(^|\\s)(${escapeRegExp(repo.name)})(\\s|$)`, 'i'),
    ];

    for (const pattern of patterns) {
      if (pattern.test(message)) {
        log.info({ repoName: repo.name, repoPath: repo.path }, 'リポジトリ解決');
        return { cwd: repo.path, cleanedPrompt: message };
      }
    }
  }

  // マッチしなければデフォルト
  return { cwd: defaultCwd, cleanedPrompt: message };
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
