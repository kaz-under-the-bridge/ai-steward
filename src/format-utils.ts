// !status / !usage 表示用の整形ヘルパー（スタンドアロン関数）

/**
 * ミリ秒を「1時間23分」「4分5秒」「12秒」形式にする
 */
export function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}時間${minutes}分`;
  if (minutes > 0) return `${minutes}分${seconds}秒`;
  return `${seconds}秒`;
}

/**
 * トークン数を「12,345」形式にする
 */
export function formatTokenCount(count: number): string {
  return count.toLocaleString('en-US');
}

/**
 * SQLiteのdatetime('now')（UTC、"YYYY-MM-DD HH:MM:SS"）からの経過ミリ秒
 */
export function elapsedSinceSqliteUtc(createdAt: string, now: Date = new Date()): number {
  const created = new Date(`${createdAt.replace(' ', 'T')}Z`);
  return now.getTime() - created.getTime();
}
