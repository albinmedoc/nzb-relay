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
    const candidates = movieDownloadReconcileCandidates(this.db, MOVIE_BATCH_SIZE);
    if (candidates.length > 0) {
      this.logger.debug?.({ event: 'movie.downloads_reconcile', movieCount: candidates.length }, 'movie downloads reconcile');
    }
    for (const movie of candidates) {
      if (!movie.fileId) {
        this.logger.debug?.({ event: 'movie.download.file_missing', movieId: movie.id }, 'movie download file reference missing');
        markMovieDownloadFailed(this.db, movie.id, {
          errorCode: 'file_missing',
          error: 'download file reference is missing'
        });
        continue;
      }

      const file = getFile(this.db, movie.fileId);
      if (!file || file.deleted) {
        this.logger.debug?.(
          { event: 'movie.download.file_deleted', movieId: movie.id, fileId: movie.fileId },
          'movie download file missing or deleted'
        );
        markMovieDownloadFailed(this.db, movie.id, {
          errorCode: 'file_deleted',
          error: 'download file is missing or deleted'
        });
        continue;
      }

      if (file.status === 'completed') {
        this.logger.debug?.(
          { event: 'movie.download.completed', movieId: movie.id, fileId: file.id },
          'movie download completed'
        );
        markMovieDownloadCompleted(this.db, movie.id, file.downloadedAt ?? new Date().toISOString());
        continue;
      }

      if (file.status === 'failed') {
        this.logger.debug?.(
          { event: 'movie.download.failed', movieId: movie.id, fileId: file.id, errorCode: file.errorCode },
          'movie download failed'
        );
        markMovieDownloadFailed(this.db, movie.id, {
          errorCode: file.errorCode ?? 'download_failed',
          error: file.error ?? 'download failed'
        });
      }
    }
  }

  private async queueNzbs(): Promise<void> {
    const candidates = movieNzbQueueCandidates(this.db, MOVIE_BATCH_SIZE);
    if (candidates.length > 0) {
      this.logger.debug?.({ event: 'movie.nzbs_queue', movieCount: candidates.length }, 'movie NZBs queue');
    }
    for (const movie of candidates) {
      try {
        if (!movie.fileId) {
          this.logger.debug?.({ event: 'movie.nzb.file_missing', movieId: movie.id }, 'movie NZB file missing');
          throw new Error('download file reference is missing');
        }

        const file = getFile(this.db, movie.fileId);
        if (!file || file.deleted || file.status !== 'completed') {
          this.logger.debug?.(
            { event: 'movie.nzb.file_not_postable', movieId: movie.id, fileId: movie.fileId },
            'movie NZB file not postable'
          );
          throw new Error('download file is not postable');
        }

        if (!(await mediaExists(this.config, file))) {
          this.logger.debug?.(
            { event: 'movie.nzb.media_missing', movieId: movie.id, fileId: file.id },
            'movie NZB media missing'
          );
          markMovieDownloadFailed(this.db, movie.id, {
            errorCode: 'file_media_missing',
            error: 'download media is missing'
          });
          continue;
        }

        const nzb = queueMovieNzb(this.db, movie);
        await ensureNzbLog(this.config, nzb);
        this.logger.debug?.(
          { event: 'movie.nzb.queued', movieId: movie.id, nzbId: nzb.id, releaseName: nzb.releaseName },
          'movie NZB queued'
        );
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
    const candidates = movieNzbReconcileCandidates(this.db, MOVIE_BATCH_SIZE);
    if (candidates.length > 0) {
      this.logger.debug?.({ event: 'movie.nzbs_reconcile', movieCount: candidates.length }, 'movie NZBs reconcile');
    }
    for (const movie of candidates) {
      if (!movie.nzbId) {
        this.logger.debug?.({ event: 'movie.nzb.missing', movieId: movie.id }, 'movie NZB missing');
        markMovieNzbFailed(this.db, movie.id, {
          errorCode: 'nzb_missing',
          error: 'NZB job reference is missing'
        });
        continue;
      }

      const nzb = getNzb(this.db, movie.nzbId);
      if (!nzb) {
        this.logger.debug?.({ event: 'movie.nzb.missing', movieId: movie.id, nzbId: movie.nzbId }, 'movie NZB missing');
        markMovieNzbFailed(this.db, movie.id, {
          errorCode: 'nzb_missing',
          error: 'NZB job is missing'
        });
        continue;
      }

      if (nzb.status === 'completed') {
        this.logger.debug?.({ event: 'movie.nzb.completed', movieId: movie.id, nzbId: nzb.id }, 'movie NZB completed');
        markMoviePosted(this.db, movie.id, nzb.postedAt ?? new Date().toISOString());
        continue;
      }

      if (nzb.status === 'failed') {
        this.logger.debug?.(
          { event: 'movie.nzb.failed', movieId: movie.id, nzbId: nzb.id, errorCode: nzb.errorCode },
          'movie NZB failed'
        );
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
