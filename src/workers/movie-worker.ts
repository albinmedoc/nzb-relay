import fs from 'node:fs/promises';
import path from 'node:path';
import type { Logger } from 'pino';
import type { Config } from '../config.js';
import type { AppDatabase } from '../db/client.js';
import { getFile, getNzb } from '../db/repository.js';
import {
  markMovieDownloadCompleted,
  markMovieDownloadFailed,
  markMovieNzbFailed,
  markMoviePosted,
  movieDownloadReconcileCandidates,
  movieNzbQueueCandidates,
  movieNzbReconcileCandidates,
  queueMovieNzb
} from '../db/movie-repository.js';
import type { FileRow, MovieJobRow } from '../types.js';
import { fileMediaPath, nzbLogPath } from '../utils/paths.js';
import { sleep } from '../utils/time.js';

const LOOP_SLEEP_MS = 1000;
const MOVIE_BATCH_SIZE = 50;

export class MovieWorker {
  private readonly stopController = new AbortController();
  private loopPromise: Promise<void> | null = null;

  constructor(
    private readonly db: AppDatabase,
    private readonly config: Config,
    private readonly logger: Logger
  ) {}

  start(): void {
    this.loopPromise ??= this.loop();
  }

  async stop(): Promise<void> {
    this.stopController.abort();
    await this.loopPromise;
  }

  private async loop(): Promise<void> {
    while (!this.stopController.signal.aborted) {
      try {
        await this.reconcileDownloads();
        await this.queueNzbs();
        await this.reconcileNzbs();
      } catch (error) {
        this.logger.error({ error }, 'movie worker iteration failed');
      }

      await sleep(LOOP_SLEEP_MS, this.stopController.signal);
    }
  }

  private async reconcileDownloads(): Promise<void> {
    for (const movie of movieDownloadReconcileCandidates(this.db, MOVIE_BATCH_SIZE)) {
      if (!movie.fileId) {
        markMovieDownloadFailed(this.db, movie.id, {
          errorCode: 'file_missing',
          error: 'download file reference is missing'
        });
        continue;
      }

      const file = getFile(this.db, movie.fileId);
      if (!file || file.deleted) {
        markMovieDownloadFailed(this.db, movie.id, {
          errorCode: 'file_deleted',
          error: 'download file is missing or deleted'
        });
        continue;
      }

      if (file.status === 'completed') {
        markMovieDownloadCompleted(this.db, movie.id, file.downloadedAt ?? new Date().toISOString());
        continue;
      }

      if (file.status === 'failed') {
        markMovieDownloadFailed(this.db, movie.id, {
          errorCode: file.errorCode ?? 'download_failed',
          error: file.error ?? 'download failed'
        });
      }
    }
  }

  private async queueNzbs(): Promise<void> {
    for (const movie of movieNzbQueueCandidates(this.db, MOVIE_BATCH_SIZE)) {
      try {
        if (!movie.fileId) {
          throw new Error('download file reference is missing');
        }

        const file = getFile(this.db, movie.fileId);
        if (!file || file.deleted || file.status !== 'completed') {
          throw new Error('download file is not postable');
        }

        if (!(await mediaExists(this.config, file))) {
          markMovieDownloadFailed(this.db, movie.id, {
            errorCode: 'file_media_missing',
            error: 'download media is missing'
          });
          continue;
        }

        const nzb = queueMovieNzb(this.db, movie);
        await ensureNzbLog(this.config, nzb);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.error({ event: 'movie.nzb.queue_failed', movieId: movie.id, error }, 'movie NZB queue failed');
        markMovieNzbFailed(this.db, movie.id, {
          errorCode: 'queue_failed',
          error: message
        });
      }
    }
  }

  private async reconcileNzbs(): Promise<void> {
    for (const movie of movieNzbReconcileCandidates(this.db, MOVIE_BATCH_SIZE)) {
      if (!movie.nzbId) {
        markMovieNzbFailed(this.db, movie.id, {
          errorCode: 'nzb_missing',
          error: 'NZB job reference is missing'
        });
        continue;
      }

      const nzb = getNzb(this.db, movie.nzbId);
      if (!nzb) {
        markMovieNzbFailed(this.db, movie.id, {
          errorCode: 'nzb_missing',
          error: 'NZB job is missing'
        });
        continue;
      }

      if (nzb.status === 'completed') {
        markMoviePosted(this.db, movie.id, nzb.postedAt ?? new Date().toISOString());
        continue;
      }

      if (nzb.status === 'failed') {
        markMovieNzbFailed(this.db, movie.id, {
          errorCode: nzb.errorCode ?? 'nzb_failed',
          error: nzb.error ?? 'NZB job failed'
        });
      }
    }
  }
}

async function ensureNzbLog(config: Config, row: { nzbFile: string }): Promise<void> {
  const logPath = nzbLogPath(config, row);
  await fs.mkdir(path.dirname(logPath), { recursive: true });
  await fs.appendFile(logPath, '');
}

async function mediaExists(config: Config, file: FileRow): Promise<boolean> {
  try {
    await fs.stat(fileMediaPath(config, file));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}
