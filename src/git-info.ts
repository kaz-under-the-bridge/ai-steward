// タスク完了時のPR/commitリンク生成（応答テキストの正規表現ではなくgitの確定情報から取る）
// repo-resolver同様のスタンドアロン関数。orchestratorから直接呼び出す

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createChildLogger } from './logger.js';

const log = createChildLogger('git-info');
const execFileAsync = promisify(execFile);

export interface GitTaskInfo {
  branch: string;
  shortSha: string;
  prUrl: string | null;
}

interface PrListEntry {
  url: string;
  updatedAt: string;
}

/**
 * タスク開始以降に更新されたPRだけを対象にする（前タスクの残骸PRを誤リンクしない）
 */
export function pickRecentPr(prs: PrListEntry[], taskStartedAt: Date): string | null {
  for (const pr of prs) {
    if (new Date(pr.updatedAt).getTime() >= taskStartedAt.getTime()) {
      return pr.url;
    }
  }
  return null;
}

/**
 * cwdのgit確定情報（branch / HEAD sha / 現branchのPR URL）を取得する。
 * git管理外・gh未認証などは null を返して呼び出し元で表示をスキップする
 */
export async function getGitTaskInfo(cwd: string, taskStartedAt: Date): Promise<GitTaskInfo | null> {
  try {
    const { stdout: branchOut } = await execFileAsync(
      'git',
      ['-C', cwd, 'rev-parse', '--abbrev-ref', 'HEAD'],
      { timeout: 10_000 },
    );
    const branch = branchOut.trim();
    const { stdout: shaOut } = await execFileAsync(
      'git',
      ['-C', cwd, 'rev-parse', '--short', 'HEAD'],
      { timeout: 10_000 },
    );
    const shortSha = shaOut.trim();

    let prUrl: string | null = null;
    try {
      const { stdout: prOut } = await execFileAsync(
        'gh',
        ['pr', 'list', '--head', branch, '--state', 'open', '--json', 'url,updatedAt', '--limit', '5'],
        { cwd, timeout: 15_000 },
      );
      const prs = JSON.parse(prOut) as PrListEntry[];
      prUrl = pickRecentPr(prs, taskStartedAt);
    } catch (err) {
      log.warn({ err, cwd, branch }, 'gh pr list失敗（PRリンクなしで続行）');
    }

    return { branch, shortSha, prUrl };
  } catch {
    // git管理外のcwd等
    return null;
  }
}
