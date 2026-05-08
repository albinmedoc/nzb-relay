import { randomUUID } from 'node:crypto';
import type { Config } from '../config.js';
import type { AppDatabase } from './client.js';
import type { ErrorCode, FileRow, JobStatus, NzbFileSummary, NzbRow, WebhookDeliveryRow } from '../types.js';
import { enqueueWebhook } from '../webhooks.js';
import { nowIso } from '../utils/time.js';
import { sanitizeToken } from '../utils/templates.js';

export interface CreateFileInput {
  url: string;
  title: string;
  filename: string;
  service: string;
  quality: string;
  season: number | null;
  episode: number | null;
}

export interface CreateNzbInput {
  releaseName: string;
  fileIds: string[];
}

export interface JobListFilters {
  status?: JobStatus;
  createdAfter?: string;
  createdBefore?: string;
}

export function insertFile(db: AppDatabase, input: CreateFileInput): FileRow {
  const id = randomUUID();
  const createdAt = nowIso();
  db.prepare(
    `
      INSERT INTO file (
        id, url, status, title, filename, service, quality, season, episode,
        downloadedAt, createdAt, deleted, errorCode, error
      )
      VALUES (?, ?, 'pending', ?, ?, ?, ?, ?, ?, NULL, ?, 0, NULL, NULL)
    `
  ).run(id, input.url, input.title, input.filename, input.service, input.quality, input.season, input.episode, createdAt);

  return getFileOrThrow(db, id);
}

export function hasActiveUrl(db: AppDatabase, url: string): boolean {
  const row = db
    .prepare(
      `
        SELECT 1
        FROM file
        WHERE url = ?
          AND status IN ('pending', 'running', 'completed')
          AND deleted = 0
        LIMIT 1
      `
    )
    .get(url);
  return Boolean(row);
}

export function getFile(db: AppDatabase, id: string): FileRow | null {
  return (db.prepare('SELECT * FROM file WHERE id = ?').get(id) as FileRow | undefined) ?? null;
}

export function getFileOrThrow(db: AppDatabase, id: string): FileRow {
  const row = getFile(db, id);
  if (!row) {
    throw new Error(`file not found: ${id}`);
  }
  return row;
}

export function listFiles(
  db: AppDatabase,
  limit: number,
  offset: number,
  filters: JobListFilters = {}
): { items: FileRow[]; total: number } {
  const { where, params } = buildJobListWhere(filters, ['deleted = 0']);
  const items = db
    .prepare(
      `
        SELECT *
        FROM file
        ${where}
        ORDER BY createdAt DESC
        LIMIT ? OFFSET ?
      `
    )
    .all(...params, limit, offset) as FileRow[];
  const total = (db.prepare(`SELECT COUNT(*) AS total FROM file ${where}`).get(...params) as { total: number }).total;
  return { items, total };
}

export function markFileDeleted(db: AppDatabase, id: string): void {
  db.prepare('UPDATE file SET deleted = 1 WHERE id = ?').run(id);
}

export function hardDeleteFile(db: AppDatabase, id: string): void {
  db.prepare('DELETE FROM file WHERE id = ?').run(id);
}

export function isFileReferencedByNzb(db: AppDatabase, fileId: string): boolean {
  const row = db.prepare('SELECT 1 FROM nzb_files WHERE fileId = ? LIMIT 1').get(fileId);
  return Boolean(row);
}

export function nextPendingFile(db: AppDatabase): FileRow | null {
  return (
    (db
      .prepare(
        `
          SELECT *
          FROM file
          WHERE status = 'pending' AND deleted = 0
          ORDER BY createdAt ASC
          LIMIT 1
        `
      )
      .get() as FileRow | undefined) ?? null
  );
}

export function claimFile(db: AppDatabase, id: string): boolean {
  const result = db
    .prepare(
      `
        UPDATE file
        SET status = 'running', errorCode = NULL, error = NULL
        WHERE id = ? AND status = 'pending' AND deleted = 0
      `
    )
    .run(id);
  return result.changes === 1;
}

export function transitionFileCompleted(db: AppDatabase, config: Config, row: FileRow, downloadedAt = nowIso()): boolean {
  return db.transaction(() => {
    const result = db
      .prepare(
        `
          UPDATE file
          SET status = 'completed', downloadedAt = ?, errorCode = NULL, error = NULL
          WHERE id = ? AND status = 'running' AND deleted = 0
        `
      )
      .run(downloadedAt, row.id);

    if (result.changes !== 1) {
      return false;
    }

    enqueueWebhook(db, config, 'download.completed', {
      fileId: row.id,
      url: row.url,
      status: 'completed',
      filename: row.filename,
      downloadedAt
    });
    return true;
  })();
}

export function transitionFileFailed(
  db: AppDatabase,
  config: Config,
  row: FileRow,
  errorCode: ErrorCode,
  error: string
): boolean {
  return db.transaction(() => {
    const result = db
      .prepare(
        `
          UPDATE file
          SET status = 'failed', errorCode = ?, error = ?
          WHERE id = ? AND status = 'running' AND deleted = 0
        `
      )
      .run(errorCode, error, row.id);

    if (result.changes !== 1) {
      return false;
    }

    enqueueWebhook(db, config, 'download.failed', {
      fileId: row.id,
      url: row.url,
      status: 'failed',
      errorCode,
      error
    });
    return true;
  })();
}

export function insertNzb(db: AppDatabase, input: CreateNzbInput): NzbRow {
  const id = randomUUID();
  const createdAt = nowIso();
  const releaseName = sanitizeToken(input.releaseName);
  if (!releaseName) {
    throw new Error('releaseName is empty');
  }
  const nzbFile = `${id}/${releaseName}.nzb`;

  db.transaction(() => {
    assertNzbFilesPostable(db, input.fileIds);

    db.prepare(
      `
        INSERT INTO nzb (
          id, status, releaseName, nzbFile, createdAt, postedAt, errorCode, error
        )
        VALUES (?, 'pending', ?, ?, ?, NULL, NULL, NULL)
      `
    ).run(id, releaseName, nzbFile, createdAt);

    const insertJoin = db.prepare('INSERT INTO nzb_files (nzbId, fileId) VALUES (?, ?)');
    for (const fileId of input.fileIds) {
      insertJoin.run(id, fileId);
    }
  })();

  return getNzbOrThrow(db, id);
}

function assertNzbFilesPostable(db: AppDatabase, fileIds: string[]): void {
  for (const fileId of fileIds) {
    const row = getFile(db, fileId);
    if (!row) {
      throw new Error(`file missing: ${fileId}`);
    }
    if (row.status !== 'completed') {
      throw new Error(`file not completed: ${fileId} (${row.status})`);
    }
    if (row.deleted) {
      throw new Error(`file deleted: ${fileId}`);
    }
  }
}

export function getNzb(db: AppDatabase, id: string): NzbRow | null {
  return (db.prepare('SELECT * FROM nzb WHERE id = ?').get(id) as NzbRow | undefined) ?? null;
}

export function getNzbOrThrow(db: AppDatabase, id: string): NzbRow {
  const row = getNzb(db, id);
  if (!row) {
    throw new Error(`nzb not found: ${id}`);
  }
  return row;
}

export function deleteNzb(db: AppDatabase, id: string): void {
  db.prepare('DELETE FROM nzb WHERE id = ?').run(id);
}

export function listNzbs(
  db: AppDatabase,
  limit: number,
  offset: number,
  filters: JobListFilters = {}
): { items: NzbRow[]; total: number } {
  const { where, params } = buildJobListWhere(filters);
  const items = db
    .prepare(
      `
        SELECT *
        FROM nzb
        ${where}
        ORDER BY createdAt DESC
        LIMIT ? OFFSET ?
      `
    )
    .all(...params, limit, offset) as NzbRow[];
  const total = (db.prepare(`SELECT COUNT(*) AS total FROM nzb ${where}`).get(...params) as { total: number }).total;
  return { items, total };
}

function buildJobListWhere(
  filters: JobListFilters,
  baseClauses: string[] = []
): { where: string; params: Array<string | number> } {
  const clauses = [...baseClauses];
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

export function nextPendingNzb(db: AppDatabase): NzbRow | null {
  return (
    (db
      .prepare(
        `
          SELECT *
          FROM nzb
          WHERE status = 'pending'
          ORDER BY createdAt ASC
          LIMIT 1
        `
      )
      .get() as NzbRow | undefined) ?? null
  );
}

export function claimNzb(db: AppDatabase, id: string): boolean {
  const result = db
    .prepare(
      `
        UPDATE nzb
        SET status = 'running', errorCode = NULL, error = NULL
        WHERE id = ? AND status = 'pending'
      `
    )
    .run(id);
  return result.changes === 1;
}

export function canonicalFilesForNzb(db: AppDatabase, nzbId: string): NzbFileSummary[] {
  return db
    .prepare(
      `
        SELECT f.id, f.url, f.status, f.title, f.service, f.season, f.episode, f.filename, f.downloadedAt, f.deleted
        FROM nzb_files nf
        JOIN file f ON f.id = nf.fileId
        WHERE nf.nzbId = ?
        ORDER BY f.episode IS NULL ASC, f.episode ASC, f.id ASC
      `
    )
    .all(nzbId) as NzbFileSummary[];
}

export function transitionNzbCompleted(db: AppDatabase, config: Config, row: NzbRow, postedAt = nowIso()): boolean {
  return db.transaction(() => {
    const result = db
      .prepare(
        `
          UPDATE nzb
          SET status = 'completed', postedAt = ?, errorCode = NULL, error = NULL
          WHERE id = ? AND status = 'running'
        `
      )
      .run(postedAt, row.id);

    if (result.changes !== 1) {
      return false;
    }

    const fileIds = canonicalFilesForNzb(db, row.id).map((file) => file.id);
    enqueueWebhook(db, config, 'nzb.completed', {
      nzbId: row.id,
      fileIds,
      status: 'completed',
      nzbFile: row.nzbFile
    });
    return true;
  })();
}

export function transitionNzbFailed(
  db: AppDatabase,
  config: Config,
  row: NzbRow,
  errorCode: ErrorCode,
  error: string
): boolean {
  return db.transaction(() => {
    const result = db
      .prepare(
        `
          UPDATE nzb
          SET status = 'failed', errorCode = ?, error = ?
          WHERE id = ? AND status = 'running'
        `
      )
      .run(errorCode, error, row.id);

    if (result.changes !== 1) {
      return false;
    }

    const fileIds = canonicalFilesForNzb(db, row.id).map((file) => file.id);
    enqueueWebhook(db, config, 'nzb.failed', {
      nzbId: row.id,
      fileIds,
      status: 'failed',
      errorCode,
      error
    });
    return true;
  })();
}

export function runningFiles(db: AppDatabase): FileRow[] {
  return db.prepare("SELECT * FROM file WHERE status = 'running'").all() as FileRow[];
}

export function runningNzbs(db: AppDatabase): NzbRow[] {
  return db.prepare("SELECT * FROM nzb WHERE status = 'running'").all() as NzbRow[];
}

export function recoverFileInterrupted(db: AppDatabase, config: Config, row: FileRow): boolean {
  if (row.deleted) {
    const result = db
      .prepare(
        `
          UPDATE file
          SET status = 'failed', errorCode = 'interrupted_by_restart', error = 'interrupted by restart'
          WHERE id = ? AND status = 'running' AND deleted = 1
        `
      )
      .run(row.id);
    return result.changes === 1;
  }

  return transitionFileFailed(db, config, row, 'interrupted_by_restart', 'interrupted by restart');
}

export function recoverNzbInterrupted(db: AppDatabase, config: Config, row: NzbRow): boolean {
  return transitionNzbFailed(db, config, row, 'interrupted_by_restart', 'interrupted by restart');
}

export function nextDueWebhook(db: AppDatabase, now = nowIso()): WebhookDeliveryRow | null {
  return (
    (db
      .prepare(
        `
          SELECT *
          FROM webhook_deliveries
          WHERE status = 'pending'
            AND nextAttemptAt IS NOT NULL
            AND nextAttemptAt <= ?
          ORDER BY nextAttemptAt ASC, createdAt ASC
          LIMIT 1
        `
      )
      .get(now) as WebhookDeliveryRow | undefined) ?? null
  );
}

export function markWebhookDelivered(db: AppDatabase, id: string): void {
  db.prepare(
    `
      UPDATE webhook_deliveries
      SET status = 'delivered', nextAttemptAt = NULL, lastError = NULL
      WHERE id = ?
    `
  ).run(id);
}

export function markWebhookRetry(db: AppDatabase, id: string, attempts: number, nextAttemptAt: string, lastError: string): void {
  db.prepare(
    `
      UPDATE webhook_deliveries
      SET attempts = ?, nextAttemptAt = ?, status = 'pending', lastError = ?
      WHERE id = ?
    `
  ).run(attempts, nextAttemptAt, lastError, id);
}

export function markWebhookFailed(db: AppDatabase, id: string, attempts: number, lastError: string): void {
  db.prepare(
    `
      UPDATE webhook_deliveries
      SET attempts = ?, nextAttemptAt = NULL, status = 'failed', lastError = ?
      WHERE id = ?
    `
  ).run(attempts, lastError, id);
}

export function coerceStatus(value: string): JobStatus {
  if (value === 'pending' || value === 'running' || value === 'completed' || value === 'failed') {
    return value;
  }
  throw new Error(`invalid job status: ${value}`);
}
