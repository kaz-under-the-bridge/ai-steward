import 'dotenv/config';
import { loadConfig } from './config.js';
import { Orchestrator } from './orchestrator.js';
import { logger } from './logger.js';

async function main() {
  logger.info('ai-steward 起動中...');

  const config = loadConfig();
  const orchestrator = new Orchestrator(config);

  // graceful shutdown
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'シャットダウン開始');
    await orchestrator.stop();
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  await orchestrator.start();
  logger.info('ai-steward 起動完了');
}

main().catch((err) => {
  logger.fatal({ err }, '起動失敗');
  process.exit(1);
});
