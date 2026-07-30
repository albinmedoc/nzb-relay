import fs from 'node:fs/promises';
import path from 'node:path';
import type { Logger } from 'pino';
import type { Config } from '../config.js';
import type { AppDatabase } from '../db/client.js';
import { deleteNzb, getFile, hardDeleteFile, insertFile, insertNzb, markFileDeleted } from '../db/repository.js';
import {
  downloadQueueCandidates,
  downloadReconcileCandidates,
  failedFilesByUrl,
  failedNzbsByFileId,
  getActiveFileByUrl,
  getActiveNzbByFileId,
  getNzbForWatchlistEpisode,
  getWatchlistSource,
  linkWatchlistEpisodeToFile,
  linkWatchlistEpisodeToNzb,
  markWatchlistEpisodeDownloadCompleted,
  markWatchlistEpisodeDownloadFailed,
  markWatchlistEpisodeDownloadQueued,
  markWatchlistEpisodeNzbFailed,
  markWatchlistEpisodeNzbQueued,
  markWatchlistEpisodeNeedsRedownload,
  markWatchlistEpisodePosted,
  markWatchlistSourceScanCompleted,
  markWatchlistSourceScanFailed,
  markWatchlistSourceScanStarted,
  nextDueWatchlistSources,
  nzbQueueCandidates,
  nzbReconcileCandidates,
  upsertWatchlistEpisode
} from '../db/watchlist-repository.js';
import type { FileRow, NzbRow, WatchlistEpisodeRow, WatchlistEpisodeWithSource, WatchlistSourceRow } from '../types.js';
import { removeDownloadDirectory, removeNzbArtifacts } from '../utils/cleanup.js';
import { fileLogPath, fileMediaPath, nzbLogPath, stripMkv } from '../utils/paths.js';
import { renderDownloadFilename } from '../utils/templates.js';
import { addMillisecondsIso, nowIso, sleep } from '../utils/time.js';
import { defaultWatchProviders, type WatchProvider } from '../watchlist/providers.js';

const LOOP_SLEEP_MS = 1000;
const SOURCE_SCAN_BATCH_SIZE = 5;
const EPISODE_BATCH_SIZE = 25;

export class WatchlistWorker {
  private readonly stopController = new AbortController();
  private loopPromise: Promise<void> | null = null;
  private nextReconcileAt = 0;

  constructor(
    private readonly db: AppDatabase,
    private readonly config: Config,
    private readonly logger: Logger,
    private readonly providers: WatchProvider[] = defaultWatchProviders
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
        await this.scanDueSources();

        const now = Date.now();
        if (now >= this.nextReconcileAt) {
          await this.reconcileAndQueueEpisodes();
          this.nextReconcileAt = now + this.config.watchlist.reconcileIntervalSeconds * 1000;
        }
      } catch (error) {
        this.logger.error({ error }, 'watchlist worker iteration failed');
      }

      await sleep(LOOP_SLEEP_MS, this.stopController.signal);
    }
  }

  private async scanDueSources(): Promise<void> {
    const due = nextDueWatchlistSources(this.db, nowIso(), SOURCE_SCAN_BATCH_SIZE);
    if (due.length > 0) {
      this.logger.debug?.({ event: 'watchlist.sources_due', sourceCount: due.length }, 'watchlist sources due');
    }
    for (const source of due) {
      if (this.stopController.signal.aborted) {
        return;
      }
      await this.scanSource(source);
    }
  }

  private async scanSource(source: WatchlistSourceRow): Promise<void> {
    const provider = this.providerFor(source);
    const startedAt = nowIso();
    const nextScanAt = addMillisecondsIso(startedAt, this.config.watchlist.pollIntervalSeconds * 1000);
    markWatchlistSourceScanStarted(this.db, source.id, startedAt);

    if (!provider) {
      this.logger.debug?.(
        { event: 'watchlist.source.unsupported', sourceId: source.id, service: source.service, type: source.type },
        'watchlist source unsupported'
      );
      markWatchlistSourceScanFailed(this.db, source.id, {
        errorCode: 'unsupported_provider',
        error: `unsupported watch provider: ${source.service}/${source.type}`,
        lastScannedAt: startedAt,
        nextScanAt
      });
      return;
    }

    try {
      this.logger.debug?.(
        { event: 'watchlist.source.scan_started', sourceId: source.id, service: source.service, type: source.type },
        'watchlist source scan started'
      );
      const result = await provider.discover(source.url, { logger: this.logger });
      const shouldQueueNewEpisodes = Boolean(source.backfill) || Boolean(source.firstScanCompleted);

      this.db.transaction(() => {
        for (const episode of result.episodes) {
          upsertWatchlistEpisode(this.db, {
            sourceId: source.id,
            url: episode.url,
            season: episode.season,
            episode: episode.episode,
            title: episode.title,
            quality: episode.quality,
            status: shouldQueueNewEpisodes ? 'discovered' : 'seen'
          }, startedAt);
        }

        markWatchlistSourceScanCompleted(this.db, source.id, {
          title: result.title,
          url: result.url,
          lastScannedAt: startedAt,
          nextScanAt
        });
      })();

      this.logger.info(
        {
          event: 'watchlist.source.scanned',
          sourceId: source.id,
          service: source.service,
          type: source.type,
          episodeCount: result.episodes.length
        },
        'watchlist source scanned'
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      markWatchlistSourceScanFailed(this.db, source.id, {
        errorCode: 'discovery_failed',
        error: message,
        lastScannedAt: startedAt,
        nextScanAt
      });
      this.logger.warn({ event: 'watchlist.source.scan_failed', sourceId: source.id, error }, 'watchlist source scan failed');
    }
  }

  private async reconcileAndQueueEpisodes(): Promise<void> {
    await this.reconcileDownloads();
    await this.queueDownloads();

    if (this.config.watchlist.autoNzb) {
      await this.reconcileNzbs();
      await this.queueNzbs();
    }
  }

  private async reconcileDownloads(): Promise<void> {
    const candidates = downloadReconcileCandidates(this.db);
    if (candidates.length > 0) {
      this.logger.debug?.({ event: 'watchlist.downloads_reconcile', episodeCount: candidates.length }, 'watchlist downloads reconcile');
    }
    for (const episode of candidates) {
      if (!episode.fileId) {
        this.logger.debug?.(
          { event: 'watchlist.download.file_missing', episodeId: episode.id },
          'watchlist download file reference missing'
        );
        this.markDownloadFailure(episode, 'file_missing', 'download file reference is missing');
        continue;
      }

      const file = getFile(this.db, episode.fileId);
      if (!file || file.deleted) {
        this.logger.debug?.(
          { event: 'watchlist.download.file_deleted', episodeId: episode.id, fileId: episode.fileId },
          'watchlist download file missing or deleted'
        );
        this.markRedownloadNeeded(episode, 'file_deleted', 'download file is missing or deleted');
        continue;
      }

      if (file.status === 'completed') {
        this.logger.debug?.(
          { event: 'watchlist.download.completed', episodeId: episode.id, fileId: file.id },
          'watchlist download completed'
        );
        markWatchlistEpisodeDownloadCompleted(this.db, episode.id, file.downloadedAt ?? nowIso());
        await this.cleanupFailedDownloadAttempts(episode, file);
        continue;
      }

      if (file.status === 'failed') {
        this.logger.debug?.(
          { event: 'watchlist.download.failed', episodeId: episode.id, fileId: file.id, errorCode: file.errorCode },
          'watchlist download failed'
        );
        this.markDownloadFailure(episode, file.errorCode ?? 'download_failed', file.error ?? 'download failed');
      }
    }
  }

  private async queueDownloads(): Promise<void> {
    const candidates = downloadQueueCandidates(this.db, this.config.watchlist.maxAttempts, EPISODE_BATCH_SIZE);
    if (candidates.length > 0) {
      this.logger.debug?.({ event: 'watchlist.downloads_queue', episodeCount: candidates.length }, 'watchlist downloads queue');
    }
    for (const episode of candidates) {
      const active = getActiveFileByUrl(this.db, episode.url);
      if (active) {
        this.logger.debug?.(
          { event: 'watchlist.download.linked_existing', episodeId: episode.id, fileId: active.id },
          'watchlist linked existing download'
        );
        linkWatchlistEpisodeToFile(this.db, episode.id, active);
        continue;
      }

      try {
        const input = {
          url: episode.url,
          title: episode.sourceTitle || episode.title,
          service: episode.sourceService,
          quality: episode.quality,
          season: episode.season,
          episode: episode.episode
        };
        const row = insertFile(this.db, {
          ...input,
          filename: renderDownloadFilename(this.config, input)
        });
        await ensureFileLog(this.config, row);
        markWatchlistEpisodeDownloadQueued(this.db, episode.id, row.id);
        this.logger.debug?.(
          { event: 'watchlist.download.queued', episodeId: episode.id, fileId: row.id, filename: row.filename },
          'watchlist download queued'
        );
      } catch (error) {
        const duplicate = getActiveFileByUrl(this.db, episode.url);
        if (duplicate) {
          this.logger.debug?.(
            { event: 'watchlist.download.linked_duplicate', episodeId: episode.id, fileId: duplicate.id },
            'watchlist linked duplicate download'
          );
          linkWatchlistEpisodeToFile(this.db, episode.id, duplicate);
          continue;
        }

        const message = error instanceof Error ? error.message : String(error);
        this.logger.error({ event: 'watchlist.download.queue_failed', episodeId: episode.id, error }, 'watchlist download queue failed');
        markWatchlistEpisodeDownloadFailed(this.db, episode.id, {
          errorCode: 'queue_failed',
          error: message,
          blocked: episode.downloadAttempts >= this.config.watchlist.maxAttempts
        });
      }
    }
  }

  private async reconcileNzbs(): Promise<void> {
    const candidates = nzbReconcileCandidates(this.db);
    if (candidates.length > 0) {
      this.logger.debug?.({ event: 'watchlist.nzbs_reconcile', episodeCount: candidates.length }, 'watchlist NZBs reconcile');
    }
    for (const episode of candidates) {
      const nzb = getNzbForWatchlistEpisode(this.db, episode);
      if (!nzb) {
        this.logger.debug?.({ event: 'watchlist.nzb.missing', episodeId: episode.id }, 'watchlist NZB missing');
        this.markNzbFailure(episode, 'nzb_missing', 'NZB job reference is missing');
        continue;
      }

      if (nzb.status === 'completed') {
        this.logger.debug?.(
          { event: 'watchlist.nzb.completed', episodeId: episode.id, nzbId: nzb.id },
          'watchlist NZB completed'
        );
        markWatchlistEpisodePosted(this.db, episode.id, nzb.postedAt ?? nowIso());
        if (episode.fileId) {
          await this.cleanupFailedNzbsForFile(episode.fileId, nzb.id);
          await this.deleteFileAfterNzbIfEnabled(episode);
        }
        continue;
      }

      if (nzb.status === 'failed') {
        if (isMissingMediaNzbFailure(nzb)) {
          this.logger.debug?.(
            { event: 'watchlist.nzb.media_missing', episodeId: episode.id, nzbId: nzb.id },
            'watchlist NZB media missing'
          );
          await this.markRedownloadNeededAndCleanup(episode, 'file_media_missing', nzb.error ?? 'download media is missing');
          continue;
        }
        this.logger.debug?.(
          { event: 'watchlist.nzb.failed', episodeId: episode.id, nzbId: nzb.id, errorCode: nzb.errorCode },
          'watchlist NZB failed'
        );
        this.markNzbFailure(episode, nzb.errorCode ?? 'nzb_failed', nzb.error ?? 'NZB job failed');
      }
    }
  }

  private async queueNzbs(): Promise<void> {
    const candidates = nzbQueueCandidates(this.db, this.config.watchlist.maxAttempts, EPISODE_BATCH_SIZE);
    if (candidates.length > 0) {
      this.logger.debug?.({ event: 'watchlist.nzbs_queue', episodeCount: candidates.length }, 'watchlist NZBs queue');
    }
    for (const episode of candidates) {
      if (!episode.fileId) {
        this.logger.debug?.({ event: 'watchlist.nzb.file_missing', episodeId: episode.id }, 'watchlist NZB file missing');
        this.markRedownloadNeeded(episode, 'file_missing', 'download file reference is missing');
        continue;
      }

      const file = getFile(this.db, episode.fileId);
      if (!file || file.deleted || file.status !== 'completed') {
        this.logger.debug?.(
          { event: 'watchlist.nzb.file_not_postable', episodeId: episode.id, fileId: episode.fileId },
          'watchlist NZB file not postable'
        );
        await this.markRedownloadNeededAndCleanup(episode, 'file_not_postable', 'download file is not postable');
        continue;
      }

      if (!(await mediaExists(this.config, file))) {
        this.logger.debug?.(
          { event: 'watchlist.nzb.media_missing', episodeId: episode.id, fileId: file.id },
          'watchlist NZB media missing'
        );
        await this.markRedownloadNeededAndCleanup(episode, 'file_media_missing', 'download media is missing');
        continue;
      }

      const activeNzb = getActiveNzbByFileId(this.db, file.id);
      if (activeNzb) {
        this.logger.debug?.(
          { event: 'watchlist.nzb.linked_existing', episodeId: episode.id, nzbId: activeNzb.id },
          'watchlist linked existing NZB'
        );
        linkWatchlistEpisodeToNzb(this.db, episode.id, activeNzb);
        continue;
      }

      try {
        const row = insertNzb(this.db, {
          releaseName: stripMkv(file.filename),
          fileIds: [file.id]
        });
        await ensureNzbLog(this.config, row);
        markWatchlistEpisodeNzbQueued(this.db, episode.id, row.id);
        this.logger.debug?.(
          { event: 'watchlist.nzb.queued', episodeId: episode.id, nzbId: row.id, releaseName: row.releaseName },
          'watchlist NZB queued'
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.error({ event: 'watchlist.nzb.queue_failed', episodeId: episode.id, error }, 'watchlist NZB queue failed');
        markWatchlistEpisodeNzbFailed(this.db, episode.id, {
          errorCode: 'queue_failed',
          error: message,
          blocked: episode.nzbAttempts >= this.config.watchlist.maxAttempts
        });
      }
    }
  }

  private markDownloadFailure(episode: WatchlistEpisodeRow, errorCode: string, error: string): void {
    markWatchlistEpisodeDownloadFailed(this.db, episode.id, {
      errorCode,
      error,
      blocked: episode.downloadAttempts >= this.config.watchlist.maxAttempts
    });
  }

  private markRedownloadNeeded(episode: WatchlistEpisodeRow, errorCode: string, error: string): void {
    markWatchlistEpisodeNeedsRedownload(this.db, episode.id, {
      errorCode,
      error,
      blocked: episode.downloadAttempts >= this.config.watchlist.maxAttempts
    });
  }

  private async markRedownloadNeededAndCleanup(episode: WatchlistEpisodeRow, errorCode: string, error: string): Promise<void> {
    try {
      if (episode.fileId) {
        await this.cleanupFailedNzbsForFile(episode.fileId);
        const file = getFile(this.db, episode.fileId);
        if (file && file.status === 'completed') {
          hardDeleteFile(this.db, file.id);
          await removeDownloadDirectory(this.config, file);
        }
      }
    } catch (cleanupError) {
      this.logger.warn({ event: 'watchlist.retry.cleanup_failed', episodeId: episode.id, error: cleanupError }, 'watchlist retry cleanup failed');
    }
    this.markRedownloadNeeded(episode, errorCode, error);
  }

  private markNzbFailure(episode: WatchlistEpisodeRow, errorCode: string, error: string): void {
    markWatchlistEpisodeNzbFailed(this.db, episode.id, {
      errorCode,
      error,
      blocked: episode.nzbAttempts >= this.config.watchlist.maxAttempts
    });
  }

  private async cleanupFailedDownloadAttempts(episode: WatchlistEpisodeRow, currentFile: FileRow): Promise<void> {
    for (const failed of failedFilesByUrl(this.db, episode.url, currentFile.id)) {
      try {
        await this.cleanupFailedNzbsForFile(failed.id);
        hardDeleteFile(this.db, failed.id);
        await removeDownloadDirectory(this.config, failed);
      } catch (error) {
        this.logger.warn({ event: 'watchlist.failed_file.cleanup_failed', episodeId: episode.id, fileId: failed.id, error }, 'watchlist failed file cleanup failed');
      }
    }
  }

  private async cleanupFailedNzbsForFile(fileId: string, excludeNzbId: string | null = null): Promise<void> {
    for (const nzb of failedNzbsByFileId(this.db, fileId, excludeNzbId)) {
      await this.deleteNzbArtifacts(nzb);
    }
  }

  private async deleteNzbArtifacts(nzb: NzbRow): Promise<void> {
    deleteNzb(this.db, nzb.id);
    await removeNzbArtifacts(this.config, nzb);
  }

  private async deleteFileAfterNzbIfEnabled(episode: WatchlistEpisodeRow): Promise<void> {
    const source = getWatchlistSource(this.db, episode.sourceId);
    if (!source?.deleteFileAfterNzb || !episode.fileId) {
      return;
    }

    const file = getFile(this.db, episode.fileId);
    if (!file || file.deleted) {
      return;
    }

    markFileDeleted(this.db, file.id);
    await removeDownloadDirectory(this.config, file);
  }

  private providerFor(source: WatchlistSourceRow): WatchProvider | null {
    return this.providers.find((provider) => provider.service === source.service && provider.type === source.type) ?? null;
  }
}

async function ensureFileLog(config: Config, row: { id: string; filename: string }): Promise<void> {
  const logPath = fileLogPath(config, row);
  await fs.mkdir(path.dirname(logPath), { recursive: true });
  await fs.appendFile(logPath, '');
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

function isMissingMediaNzbFailure(nzb: NzbRow): boolean {
  const error = nzb.error ?? '';
  return error.includes('ENOENT') && error.includes('/downloads/');
}
