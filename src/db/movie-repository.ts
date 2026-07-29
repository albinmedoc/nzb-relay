import { randomUUID } from 'node:crypto';
import type { Config } from '../config.js';
import type { AppDatabase } from './client.js';
import type { FileRow, MovieJobRow, MovieStatus, NzbRow } from '../types.js';
import { nowIso } from '../utils/time.js';
import { renderDownloadFilename } from '../utils/templates.js';
import { getFile, getNzb, insertFile, insertNzb } from './repository.js';

export interface CreateMovieInput {
  url: string;
  title: string;
  service: string;
  quality: string;
}

export interface MovieListFilters {
  status?: MovieStatus;
  createdAfter?: string;
  createdBefore?: string;
}

export function insertMovieWithDownload(db: AppDatabase, config: Config, input: CreateMovieInput): MovieJobRow {
  const movieId = randomUUID();
  const timestamp = nowIso();

  db.transaction(() => {
    const file = insertMovieFile(db, config, input);
    db.prepare(
      `
        INSERT INTO movie_job (
          id, url, title, service, quality, status, fileId, nzbId,
          downloadAttempts, nzbAttempts, downloadQueuedAt, downloadedAt, nzbQueuedAt, postedAt,
          lastErrorCode, lastError, createdAt, updatedAt
        )
        VALUES (?, ?, ?, ?, ?, 'download_queued', ?, NULL, 1, 0, ?, NULL, NULL, NULL, NULL, NULL, ?, ?)
      `
    ).run(movieId, input.url, input.title, input.service, input.quality, file.id, timestamp, timestamp, timestamp);
  })();

  return getMovieJobOrThrow(db, movieId);
}

export function queueMovieDownloadRetry(db: AppDatabase, config: Config, movie: MovieJobRow): FileRow {
  const timestamp = nowIso();
  let fileId = '';
  db.transaction(() => {
    const file = insertMovieFile(db, config, movie);
    fileId = file.id;
    db.prepare(
      `
        UPDATE movie_job
        SET status = 'download_queued',
            fileId = ?,
            nzbId = NULL,
            downloadAttempts = downloadAttempts + 1,
            downloadQueuedAt = ?,
            downloadedAt = NULL,
            nzbQueuedAt = NULL,
            postedAt = NULL,
            lastErrorCode = NULL,
            lastError = NULL,
            updatedAt = ?
        WHERE id = ?
      `
    ).run(file.id, timestamp, timestamp, movie.id);
  })();
  return getFile(db, fileId)!;
}

export function getMovieJob(db: AppDatabase, id: string): MovieJobRow | null {
  return (db.prepare('SELECT * FROM movie_job WHERE id = ?').get(id) as MovieJobRow | undefined) ?? null;
}

export function getMovieJobOrThrow(db: AppDatabase, id: string): MovieJobRow {
  const row = getMovieJob(db, id);
  if (!row) {
    throw new Error(`movie job not found: ${id}`);
  }
  return row;
}

export function deleteMovieJob(db: AppDatabase, id: string): void {
  db.prepare('DELETE FROM movie_job WHERE id = ?').run(id);
}

export function listMovieJobs(
  db: AppDatabase,
  limit: number,
  offset: number,
  filters: MovieListFilters = {}
): { items: MovieJobRow[]; total: number } {
  const { where, params } = buildMovieListWhere(filters);
  const items = db
    .prepare(
      `
        SELECT *
        FROM movie_job
        ${where}
        ORDER BY createdAt DESC
        LIMIT ? OFFSET ?
      `
    )
    .all(...params, limit, offset) as MovieJobRow[];
  const total = (db.prepare(`SELECT COUNT(*) AS total FROM movie_job ${where}`).get(...params) as { total: number }).total;
  return { items, total };
}

export function movieDownloadReconcileCandidates(db: AppDatabase, limit = 100): MovieJobRow[] {
  return db
    .prepare(
      `
        SELECT *
        FROM movie_job
        WHERE status = 'download_queued'
        ORDER BY downloadQueuedAt ASC, createdAt ASC
        LIMIT ?
      `
    )
    .all(limit) as MovieJobRow[];
}

export function movieNzbQueueCandidates(db: AppDatabase, limit = 100): MovieJobRow[] {
  return db
    .prepare(
      `
        SELECT *
        FROM movie_job
        WHERE status = 'download_completed'
        ORDER BY downloadedAt ASC, createdAt ASC
        LIMIT ?
      `
    )
    .all(limit) as MovieJobRow[];
}

export function movieNzbReconcileCandidates(db: AppDatabase, limit = 100): MovieJobRow[] {
  return db
    .prepare(
      `
        SELECT *
        FROM movie_job
        WHERE status = 'nzb_queued'
        ORDER BY nzbQueuedAt ASC, createdAt ASC
        LIMIT ?
      `
    )
    .all(limit) as MovieJobRow[];
}

export function markMovieDownloadCompleted(db: AppDatabase, movieId: string, downloadedAt: string): void {
  const timestamp = nowIso();
  db.prepare(
    `
      UPDATE movie_job
      SET status = 'download_completed',
          downloadedAt = ?,
          lastErrorCode = NULL,
          lastError = NULL,
          updatedAt = ?
      WHERE id = ?
    `
  ).run(downloadedAt, timestamp, movieId);
}

export function markMovieDownloadFailed(db: AppDatabase, movieId: string, input: FailureInput): void {
  markMovieFailed(db, movieId, 'download_failed', input);
}

export function markMovieNzbFailed(db: AppDatabase, movieId: string, input: FailureInput): void {
  markMovieFailed(db, movieId, 'nzb_failed', input);
}

export function markMovieNzbRetryReady(db: AppDatabase, movieId: string): void {
  const timestamp = nowIso();
  db.prepare(
    `
      UPDATE movie_job
      SET status = 'download_completed',
          nzbId = NULL,
          nzbQueuedAt = NULL,
          postedAt = NULL,
          lastErrorCode = NULL,
          lastError = NULL,
          updatedAt = ?
      WHERE id = ?
    `
  ).run(timestamp, movieId);
}

export function queueMovieNzb(db: AppDatabase, movie: MovieJobRow): NzbRow {
  if (!movie.fileId) {
    throw new Error('movie download file reference is missing');
  }

  const file = getFile(db, movie.fileId);
  if (!file) {
    throw new Error(`movie download file is missing: ${movie.fileId}`);
  }

  const timestamp = nowIso();
  let nzbId = '';
  db.transaction(() => {
    const nzb = insertNzb(db, {
      releaseName: stripMkv(file.filename),
      fileIds: [file.id]
    });
    nzbId = nzb.id;
    db.prepare(
      `
        UPDATE movie_job
        SET status = 'nzb_queued',
            nzbId = ?,
            nzbAttempts = nzbAttempts + 1,
            nzbQueuedAt = ?,
            postedAt = NULL,
            lastErrorCode = NULL,
            lastError = NULL,
            updatedAt = ?
        WHERE id = ?
      `
    ).run(nzb.id, timestamp, timestamp, movie.id);
  })();

  return getNzb(db, nzbId)!;
}

export function markMoviePosted(db: AppDatabase, movieId: string, postedAt: string): void {
  const timestamp = nowIso();
  db.prepare(
    `
      UPDATE movie_job
      SET status = 'posted',
          postedAt = ?,
          lastErrorCode = NULL,
          lastError = NULL,
          updatedAt = ?
      WHERE id = ?
    `
  ).run(postedAt, timestamp, movieId);
}

interface FailureInput {
  errorCode: string;
  error: string;
  blocked?: boolean;
}

function markMovieFailed(db: AppDatabase, movieId: string, status: 'download_failed' | 'nzb_failed', input: FailureInput): void {
  const timestamp = nowIso();
  db.prepare(
    `
      UPDATE movie_job
      SET status = ?,
          lastErrorCode = ?,
          lastError = ?,
          updatedAt = ?
      WHERE id = ?
    `
  ).run(input.blocked ? 'blocked' : status, input.errorCode, input.error, timestamp, movieId);
}

function insertMovieFile(db: AppDatabase, config: Config, input: CreateMovieInput): FileRow {
  return insertFile(db, {
    url: input.url,
    title: input.title,
    service: input.service,
    quality: input.quality,
    season: null,
    episode: null,
    filename: renderDownloadFilename(config, {
      title: input.title,
      service: input.service,
      quality: input.quality,
      season: null,
      episode: null
    })
  });
}

function buildMovieListWhere(filters: MovieListFilters): { where: string; params: Array<string | number> } {
  const clauses: string[] = [];
  const params: Array<string | number> = [];

  if (filters.status) {
    clauses.push('status = ?');
    params.push(filters.status);
  }
  if (filters.createdAfter) {
    clauses.push('createdAt >= ?');
    params.push(filters.createdAfter);
  }
  if (filters.createdBefore) {
    clauses.push('createdAt <= ?');
    params.push(filters.createdBefore);
  }

  return {
    where: clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '',
    params
  };
}

function stripMkv(filename: string): string {
  return filename.replace(/\.mkv$/i, '');
}
