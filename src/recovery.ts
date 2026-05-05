import type { Logger } from 'pino';
import type { Config } from './config.js';
import type { AppDatabase } from './db/client.js';
import { recoverFileInterrupted, recoverNzbInterrupted, runningFiles, runningNzbs } from './db/repository.js';
import { removeDownloadPartialsKeepLog, removeNzbWorkDir } from './utils/cleanup.js';

export async function recoverInterruptedJobs(db: AppDatabase, config: Config, logger: Logger): Promise<void> {
  for (const row of runningFiles(db)) {
    const transitioned = recoverFileInterrupted(db, config, row);
    if (transitioned) {
      try {
        await removeDownloadPartialsKeepLog(config, row);
      } catch (error) {
        logger.warn({ event: 'download.recovery_cleanup_failed', fileId: row.id, error }, 'download recovery cleanup failed');
      }
    }
  }

  for (const row of runningNzbs(db)) {
    const transitioned = recoverNzbInterrupted(db, config, row);
    if (transitioned) {
      try {
        await removeNzbWorkDir(config, row);
      } catch (error) {
        logger.warn({ event: 'nzb.recovery_cleanup_failed', nzbId: row.id, error }, 'nzb recovery cleanup failed');
      }
    }
  }
}

