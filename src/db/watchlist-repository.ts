import { randomUUID } from 'node:crypto';
import type { AppDatabase } from './client.js';
import type {
  FileRow,
  NzbRow,
  WatchlistEpisodeRow,
  WatchlistEpisodeStatus,
  WatchlistEpisodeWithSource,
  WatchlistSourceRow,
  WatchlistSourceSummary,
  WatchlistSourceType
} from '../types.js';
import { nowIso } from '../utils/time.js';

export interface CreateWatchlistSourceInput {
  service: string;
  type: WatchlistSourceType;
  url: string;
  backfill: boolean;
  deleteFileAfterNzb?: boolean;
}

export interface DiscoveredWatchlistEpisodeInput {
  sourceId: string;
  url: string;
  season: number;
  episode: number;
  title: string;
  quality: string;
  status: WatchlistEpisodeStatus;
}

export function insertWatchlistSource(db: AppDatabase, input: CreateWatchlistSourceInput): WatchlistSourceRow {
  const id = randomUUID();
  const timestamp = nowIso();
  db.prepare(
    `
      INSERT INTO watchlist_source (
        id, service, type, url, title, enabled, backfill, deleteFileAfterNzb, firstScanCompleted,
        lastScannedAt, nextScanAt, lastErrorCode, lastError, createdAt, updatedAt
      )
      VALUES (?, ?, ?, ?, NULL, 1, ?, ?, 0, NULL, ?, NULL, NULL, ?, ?)
    `
  ).run(
    id,
    input.service,
    input.type,
    input.url,
    input.backfill ? 1 : 0,
    (input.deleteFileAfterNzb ?? true) ? 1 : 0,
    timestamp,
    timestamp,
    timestamp
  );

  return getWatchlistSourceOrThrow(db, id);
}

export function getWatchlistSource(db: AppDatabase, id: string): WatchlistSourceRow | null {
  return (db.prepare('SELECT * FROM watchlist_source WHERE id = ?').get(id) as WatchlistSourceRow | undefined) ?? null;
}

export function getWatchlistSourceOrThrow(db: AppDatabase, id: string): WatchlistSourceRow {
  const row = getWatchlistSource(db, id);
  if (!row) {
    throw new Error(`watchlist source not found: ${id}`);
  }
  return row;
}

export function deleteWatchlistSource(db: AppDatabase, id: string): boolean {
  const result = db.prepare('DELETE FROM watchlist_source WHERE id = ?').run(id);
  return result.changes === 1;
}

export function listWatchlistSources(
  db: AppDatabase,
  limit: number,
  offset: number
): { items: WatchlistSourceSummary[]; total: number } {
  const items = db
    .prepare(
      `
        SELECT
          ws.*,
          COUNT(we.id) AS episodeCount,
          SUM(CASE WHEN we.status IN ('download_queued', 'nzb_queued') THEN 1 ELSE 0 END) AS queuedCount,
          SUM(CASE WHEN we.status = 'posted' THEN 1 ELSE 0 END) AS postedCount,
          SUM(CASE WHEN we.status = 'blocked' THEN 1 ELSE 0 END) AS blockedCount
        FROM watchlist_source ws
        LEFT JOIN watchlist_episode we ON we.sourceId = ws.id
        GROUP BY ws.id
        ORDER BY ws.createdAt DESC
        LIMIT ? OFFSET ?
      `
    )
    .all(limit, offset) as WatchlistSourceSummary[];
  const total = (db.prepare('SELECT COUNT(*) AS total FROM watchlist_source').get() as { total: number }).total;
  return { items, total };
}

export function listWatchlistEpisodesForSource(db: AppDatabase, sourceId: string): WatchlistEpisodeRow[] {
  return db
    .prepare(
      `
        SELECT *
        FROM watchlist_episode
        WHERE sourceId = ?
        ORDER BY season ASC, episode ASC, createdAt ASC
      `
    )
    .all(sourceId) as WatchlistEpisodeRow[];
}

export function nextDueWatchlistSources(db: AppDatabase, now = nowIso(), limit = 10): WatchlistSourceRow[] {
  return db
    .prepare(
      `
        SELECT *
        FROM watchlist_source
        WHERE enabled = 1
          AND (nextScanAt IS NULL OR nextScanAt <= ?)
        ORDER BY nextScanAt IS NULL DESC, nextScanAt ASC, createdAt ASC
        LIMIT ?
      `
    )
    .all(now, limit) as WatchlistSourceRow[];
}

export function markWatchlistSourceScanStarted(db: AppDatabase, id: string, timestamp = nowIso()): void {
  db.prepare(
    `
      UPDATE watchlist_source
      SET updatedAt = ?
      WHERE id = ?
    `
  ).run(timestamp, id);
}

export function markWatchlistSourceScanCompleted(
  db: AppDatabase,
  id: string,
  input: { title: string; url: string; lastScannedAt: string; nextScanAt: string }
): void {
  db.prepare(
    `
      UPDATE watchlist_source
      SET title = ?, url = ?, firstScanCompleted = 1, lastScannedAt = ?, nextScanAt = ?,
          lastErrorCode = NULL, lastError = NULL, updatedAt = ?
      WHERE id = ?
    `
  ).run(input.title, input.url, input.lastScannedAt, input.nextScanAt, input.lastScannedAt, id);
}

export function markWatchlistSourceScanFailed(
  db: AppDatabase,
  id: string,
  input: { errorCode: string; error: string; lastScannedAt: string; nextScanAt: string }
): void {
  db.prepare(
    `
      UPDATE watchlist_source
      SET lastScannedAt = ?, nextScanAt = ?, lastErrorCode = ?, lastError = ?, updatedAt = ?
      WHERE id = ?
    `
  ).run(input.lastScannedAt, input.nextScanAt, input.errorCode, input.error, input.lastScannedAt, id);
}

export function upsertWatchlistEpisode(
  db: AppDatabase,
  input: DiscoveredWatchlistEpisodeInput,
  timestamp = nowIso()
): { row: WatchlistEpisodeRow; inserted: boolean } {
  const existing = getWatchlistEpisodeByUrl(db, input.sourceId, input.url);
  if (existing) {
    db.prepare(
      `
        UPDATE watchlist_episode
        SET season = ?, episode = ?, title = ?, quality = ?, updatedAt = ?
        WHERE id = ?
      `
    ).run(input.season, input.episode, input.title, input.quality, timestamp, existing.id);
    return { row: getWatchlistEpisodeOrThrow(db, existing.id), inserted: false };
  }

  const id = randomUUID();
  db.prepare(
    `
      INSERT INTO watchlist_episode (
        id, sourceId, url, season, episode, title, quality, status, fileId, nzbId,
        downloadAttempts, nzbAttempts, downloadQueuedAt, downloadedAt, nzbQueuedAt,
        postedAt, lastErrorCode, lastError, createdAt, updatedAt
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, 0, 0, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?)
    `
  ).run(
    id,
    input.sourceId,
    input.url,
    input.season,
    input.episode,
    input.title,
    input.quality,
    input.status,
    timestamp,
    timestamp
  );

  return { row: getWatchlistEpisodeOrThrow(db, id), inserted: true };
}

export function getWatchlistEpisodeByUrl(
  db: AppDatabase,
  sourceId: string,
  url: string
): WatchlistEpisodeRow | null {
  return (
    (db
      .prepare('SELECT * FROM watchlist_episode WHERE sourceId = ? AND url = ?')
      .get(sourceId, url) as WatchlistEpisodeRow | undefined) ?? null
  );
}

export function getWatchlistEpisodeOrThrow(db: AppDatabase, id: string): WatchlistEpisodeRow {
  const row = db.prepare('SELECT * FROM watchlist_episode WHERE id = ?').get(id) as WatchlistEpisodeRow | undefined;
  if (!row) {
    throw new Error(`watchlist episode not found: ${id}`);
  }
  return row;
}

export function downloadQueueCandidates(db: AppDatabase, maxAttempts: number, limit = 25): WatchlistEpisodeWithSource[] {
  return db
    .prepare(
      `
        SELECT
          we.*,
          ws.service AS sourceService,
          ws.type AS sourceType,
          ws.url AS sourceUrl,
          ws.title AS sourceTitle
        FROM watchlist_episode we
        JOIN watchlist_source ws ON ws.id = we.sourceId
        WHERE ws.enabled = 1
          AND we.status IN ('discovered', 'download_failed')
          AND we.downloadAttempts < ?
        ORDER BY we.createdAt ASC
        LIMIT ?
      `
    )
    .all(maxAttempts, limit) as WatchlistEpisodeWithSource[];
}

export function nzbQueueCandidates(db: AppDatabase, maxAttempts: number, limit = 25): WatchlistEpisodeWithSource[] {
  return db
    .prepare(
      `
        SELECT
          we.*,
          ws.service AS sourceService,
          ws.type AS sourceType,
          ws.url AS sourceUrl,
          ws.title AS sourceTitle
        FROM watchlist_episode we
        JOIN watchlist_source ws ON ws.id = we.sourceId
        WHERE ws.enabled = 1
          AND we.status IN ('download_completed', 'nzb_failed')
          AND we.nzbAttempts < ?
        ORDER BY we.downloadedAt ASC, we.createdAt ASC
        LIMIT ?
      `
    )
    .all(maxAttempts, limit) as WatchlistEpisodeWithSource[];
}

export function downloadReconcileCandidates(db: AppDatabase, limit = 100): WatchlistEpisodeRow[] {
  return db
    .prepare(
      `
        SELECT *
        FROM watchlist_episode
        WHERE status = 'download_queued'
        ORDER BY downloadQueuedAt ASC
        LIMIT ?
      `
    )
    .all(limit) as WatchlistEpisodeRow[];
}

export function nzbReconcileCandidates(db: AppDatabase, limit = 100): WatchlistEpisodeRow[] {
  return db
    .prepare(
      `
        SELECT *
        FROM watchlist_episode
        WHERE status = 'nzb_queued'
        ORDER BY nzbQueuedAt ASC
        LIMIT ?
      `
    )
    .all(limit) as WatchlistEpisodeRow[];
}

export function linkWatchlistEpisodeToFile(db: AppDatabase, episodeId: string, file: FileRow, timestamp = nowIso()): void {
  const status = file.status === 'completed' ? 'download_completed' : 'download_queued';
  db.prepare(
    `
      UPDATE watchlist_episode
      SET status = ?, fileId = ?, downloadedAt = ?, lastErrorCode = NULL, lastError = NULL, updatedAt = ?
      WHERE id = ?
    `
  ).run(status, file.id, file.downloadedAt, timestamp, episodeId);
}

export function markWatchlistEpisodeDownloadQueued(
  db: AppDatabase,
  episodeId: string,
  fileId: string,
  timestamp = nowIso()
): void {
  db.prepare(
    `
      UPDATE watchlist_episode
      SET status = 'download_queued', fileId = ?, downloadAttempts = downloadAttempts + 1,
          downloadQueuedAt = ?, downloadedAt = NULL, lastErrorCode = NULL, lastError = NULL, updatedAt = ?
      WHERE id = ?
    `
  ).run(fileId, timestamp, timestamp, episodeId);
}

export function markWatchlistEpisodeDownloadCompleted(
  db: AppDatabase,
  episodeId: string,
  downloadedAt: string,
  timestamp = nowIso()
): void {
  db.prepare(
    `
      UPDATE watchlist_episode
      SET status = 'download_completed', downloadedAt = ?, lastErrorCode = NULL, lastError = NULL, updatedAt = ?
      WHERE id = ?
    `
  ).run(downloadedAt, timestamp, episodeId);
}

export function markWatchlistEpisodeDownloadFailed(
  db: AppDatabase,
  episodeId: string,
  input: { errorCode: string; error: string; blocked: boolean },
  timestamp = nowIso()
): void {
  db.prepare(
    `
      UPDATE watchlist_episode
      SET status = ?, lastErrorCode = ?, lastError = ?, updatedAt = ?
      WHERE id = ?
    `
  ).run(input.blocked ? 'blocked' : 'download_failed', input.errorCode, input.error, timestamp, episodeId);
}

export function markWatchlistEpisodeNzbQueued(
  db: AppDatabase,
  episodeId: string,
  nzbId: string,
  timestamp = nowIso()
): void {
  db.prepare(
    `
      UPDATE watchlist_episode
      SET status = 'nzb_queued', nzbId = ?, nzbAttempts = nzbAttempts + 1,
          nzbQueuedAt = ?, postedAt = NULL, lastErrorCode = NULL, lastError = NULL, updatedAt = ?
      WHERE id = ?
    `
  ).run(nzbId, timestamp, timestamp, episodeId);
}

export function linkWatchlistEpisodeToNzb(
  db: AppDatabase,
  episodeId: string,
  nzb: NzbRow,
  timestamp = nowIso()
): void {
  db.prepare(
    `
      UPDATE watchlist_episode
      SET status = 'nzb_queued', nzbId = ?, nzbQueuedAt = ?, lastErrorCode = NULL, lastError = NULL, updatedAt = ?
      WHERE id = ?
    `
  ).run(nzb.id, timestamp, timestamp, episodeId);
}

export function markWatchlistEpisodePosted(
  db: AppDatabase,
  episodeId: string,
  postedAt: string,
  timestamp = nowIso()
): void {
  db.prepare(
    `
      UPDATE watchlist_episode
      SET status = 'posted', postedAt = ?, lastErrorCode = NULL, lastError = NULL, updatedAt = ?
      WHERE id = ?
    `
  ).run(postedAt, timestamp, episodeId);
}

export function markWatchlistEpisodeNzbFailed(
  db: AppDatabase,
  episodeId: string,
  input: { errorCode: string; error: string; blocked: boolean },
  timestamp = nowIso()
): void {
  db.prepare(
    `
      UPDATE watchlist_episode
      SET status = ?, lastErrorCode = ?, lastError = ?, updatedAt = ?
      WHERE id = ?
    `
  ).run(input.blocked ? 'blocked' : 'nzb_failed', input.errorCode, input.error, timestamp, episodeId);
}

export function markWatchlistEpisodeNeedsRedownload(
  db: AppDatabase,
  episodeId: string,
  input: { errorCode: string; error: string; blocked: boolean },
  timestamp = nowIso()
): void {
  db.prepare(
    `
      UPDATE watchlist_episode
      SET status = ?, fileId = NULL, nzbId = NULL, lastErrorCode = ?, lastError = ?, updatedAt = ?
      WHERE id = ?
    `
  ).run(input.blocked ? 'blocked' : 'download_failed', input.errorCode, input.error, timestamp, episodeId);
}

export function retryFailedWatchlistEpisodesForSource(
  db: AppDatabase,
  sourceId: string,
  timestamp = nowIso()
): number {
  return db.transaction(() => {
    const retryable = db
      .prepare(
        `
          SELECT
            we.id,
            we.status,
            f.id AS fileId,
            f.status AS fileStatus,
            f.deleted AS fileDeleted
          FROM watchlist_episode we
          LEFT JOIN file f ON f.id = we.fileId
          WHERE we.sourceId = ?
            AND we.status IN ('download_failed', 'nzb_failed', 'blocked')
        `
      )
      .all(sourceId) as Array<{
        id: string;
        status: WatchlistEpisodeStatus;
        fileId: string | null;
        fileStatus: string | null;
        fileDeleted: number | null;
      }>;

    const resetDownload = db.prepare(
      `
        UPDATE watchlist_episode
        SET status = 'download_failed',
            fileId = NULL,
            nzbId = NULL,
            downloadAttempts = 0,
            nzbAttempts = 0,
            downloadQueuedAt = NULL,
            downloadedAt = NULL,
            nzbQueuedAt = NULL,
            postedAt = NULL,
            lastErrorCode = NULL,
            lastError = NULL,
            updatedAt = ?
        WHERE id = ?
      `
    );
    const resetNzb = db.prepare(
      `
        UPDATE watchlist_episode
        SET status = 'download_completed',
            nzbId = NULL,
            nzbAttempts = 0,
            nzbQueuedAt = NULL,
            postedAt = NULL,
            lastErrorCode = NULL,
            lastError = NULL,
            updatedAt = ?
        WHERE id = ?
      `
    );

    for (const episode of retryable) {
      if (
        (episode.status === 'nzb_failed' || episode.status === 'blocked') &&
        episode.fileId &&
        episode.fileStatus === 'completed' &&
        !episode.fileDeleted
      ) {
        resetNzb.run(timestamp, episode.id);
        continue;
      }
      resetDownload.run(timestamp, episode.id);
    }

    return retryable.length;
  })();
}

export function failedFilesByUrl(db: AppDatabase, url: string, excludeFileId: string): FileRow[] {
  return db
    .prepare(
      `
        SELECT *
        FROM file
        WHERE url = ?
          AND id <> ?
          AND status = 'failed'
        ORDER BY createdAt ASC
      `
    )
    .all(url, excludeFileId) as FileRow[];
}

export function getActiveFileByUrl(db: AppDatabase, url: string): FileRow | null {
  return (
    (db
      .prepare(
        `
          SELECT *
          FROM file
          WHERE url = ?
            AND status IN ('pending', 'running', 'completed')
            AND deleted = 0
          ORDER BY createdAt ASC
          LIMIT 1
        `
      )
      .get(url) as FileRow | undefined) ?? null
  );
}

export function getActiveNzbByFileId(db: AppDatabase, fileId: string): NzbRow | null {
  return (
    (db
      .prepare(
        `
          SELECT n.*
          FROM nzb n
          JOIN nzb_files nf ON nf.nzbId = n.id
          WHERE nf.fileId = ?
            AND n.status IN ('pending', 'running')
          ORDER BY n.createdAt ASC
          LIMIT 1
        `
      )
      .get(fileId) as NzbRow | undefined) ?? null
  );
}

export function failedNzbsByFileId(db: AppDatabase, fileId: string, excludeNzbId: string | null = null): NzbRow[] {
  return db
    .prepare(
      `
        SELECT n.*
        FROM nzb n
        JOIN nzb_files nf ON nf.nzbId = n.id
        WHERE nf.fileId = ?
          AND n.status = 'failed'
          AND (? IS NULL OR n.id <> ?)
        ORDER BY n.createdAt ASC
      `
    )
    .all(fileId, excludeNzbId, excludeNzbId) as NzbRow[];
}

export function getNzbForWatchlistEpisode(db: AppDatabase, episode: WatchlistEpisodeRow): NzbRow | null {
  if (!episode.nzbId) {
    return null;
  }
  return (db.prepare('SELECT * FROM nzb WHERE id = ?').get(episode.nzbId) as NzbRow | undefined) ?? null;
}
