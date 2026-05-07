import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { Hono, type Context } from 'hono';
import type { Logger } from 'pino';
import type { Config } from '../config.js';
import type { AppDatabase } from '../db/client.js';
import {
  canonicalFilesForNzb,
  deleteNzb,
  getFile,
  getNzb,
  hardDeleteFile,
  hasActiveUrl,
  insertFile,
  insertNzb,
  isFileReferencedByNzb,
  listFiles,
  listNzbs,
  markFileDeleted
} from '../db/repository.js';
import {
  deleteWatchlistSource,
  getWatchlistSource,
  insertWatchlistSource,
  listWatchlistEpisodesForSource,
  listWatchlistSources
} from '../db/watchlist-repository.js';
import type { FileRow, NzbRow, WatchlistEpisodeRow, WatchlistSourceRow, WatchlistSourceSummary } from '../types.js';
import { fetchSvtSerie, type SvtSerieFetchOptions, type SvtSerieResponse } from '../discovery/svtplay.js';
import { removeDownloadDirectory, removeNzbArtifacts } from '../utils/cleanup.js';
import { fileLogPath, fileMediaPath, nzbFinalPath, nzbLogPath } from '../utils/paths.js';
import {
  renderDownloadFilename,
  renderSeasonPackReleaseName,
  renderSingleReleaseName
} from '../utils/templates.js';
import { authMiddleware, requestLoggingMiddleware } from './middleware.js';
import { errorResponse, isSqliteUniqueConstraint } from './errors.js';
import { defaultWatchProviders, resolveWatchProvider, type WatchProvider } from '../watchlist/providers.js';

export interface WorkerControllers {
  downloads?: {
    cancel(fileId: string): Promise<void>;
  };
  nzb?: {
    cancel(nzbId: string): Promise<void>;
  };
}

export interface SvtDiscovery {
  fetchSerie(slug: string, options?: SvtSerieFetchOptions): Promise<SvtSerieResponse | null>;
}

interface CreateAppDeps {
  db: AppDatabase;
  config: Config;
  logger: Logger;
  workers?: WorkerControllers;
  svtDiscovery?: SvtDiscovery;
  watchProviders?: WatchProvider[];
}

export function createApp({
  db,
  config,
  logger,
  workers = {},
  svtDiscovery = { fetchSerie: fetchSvtSerie },
  watchProviders = defaultWatchProviders
}: CreateAppDeps): Hono {
  const app = new Hono();
  app.use('*', requestLoggingMiddleware(logger));

  const v1 = new Hono();
  v1.get('/health', (c) => c.json({ status: 'ok', version: config.version }));
  v1.use('*', authMiddleware(config));

  v1.get('/svtplay/serie/:slug', async (c) => {
    try {
      const populateQualities = c.req.query('qualities')?.toLowerCase() !== 'false';
      const fastQualities = populateQualities && c.req.query('fast')?.toLowerCase() === 'true';
      const result = await svtDiscovery.fetchSerie(c.req.param('slug'), {
        populateQualities,
        fastQualities,
        logger
      });
      if (!result) {
        return errorResponse(c, 404, 'not_found', 'series not found');
      }
      return c.json(result);
    } catch (error) {
      logger.warn({ error, slug: c.req.param('slug') }, 'svt discovery failed');
      return errorResponse(c, 502, 'discovery_failed', 'SVT discovery failed');
    }
  });

  v1.post('/downloads', async (c) => {
    const body = await readJsonObject(c);
    if (!body.ok) {
      return errorResponse(c, 400, 'invalid_json', 'invalid JSON body');
    }

    const validation = validateDownloadBody(body.value);
    if (!validation.ok) {
      return errorResponse(c, 400, validation.code, validation.error);
    }

    if (hasActiveUrl(db, validation.value.url)) {
      return errorResponse(c, 409, 'duplicate_url', 'active download already exists for url');
    }

    const filename = renderDownloadFilename(config, validation.value);

    try {
      const row = insertFile(db, {
        ...validation.value,
        filename
      });
      await ensureFileLog(config, row);
      return c.json({ fileId: row.id, status: row.status }, 202);
    } catch (error) {
      if (isSqliteUniqueConstraint(error)) {
        return errorResponse(c, 409, 'duplicate_url', 'active download already exists for url');
      }
      logger.error({ error }, 'failed to create download');
      return errorResponse(c, 500, 'internal_error', 'failed to create download');
    }
  });

  v1.post('/watchlist', async (c) => {
    const body = await readJsonObject(c);
    if (!body.ok) {
      return errorResponse(c, 400, 'invalid_json', 'invalid JSON body');
    }

    const url = stringField(body.value.url);
    if (!url) {
      return errorResponse(c, 400, 'missing_required_param', 'missing required parameter');
    }

    const backfillValidation = optionalBoolean(body.value.backfill);
    if (!backfillValidation.ok) {
      return errorResponse(c, 400, 'invalid_backfill', 'backfill must be a boolean');
    }

    const resolved = resolveWatchProvider(url, watchProviders);
    if (!resolved) {
      return errorResponse(c, 400, 'unsupported_watch_url', 'watch URL is not supported');
    }

    try {
      const row = insertWatchlistSource(db, {
        service: resolved.provider.service,
        type: resolved.provider.type,
        url: resolved.normalizedUrl,
        backfill: backfillValidation.value ?? true
      });
      return c.json(serializeWatchlistSource(row), 201);
    } catch (error) {
      if (isSqliteUniqueConstraint(error)) {
        return errorResponse(c, 409, 'duplicate_watch_url', 'watch URL already exists');
      }
      logger.error({ error }, 'failed to create watchlist source');
      return errorResponse(c, 500, 'internal_error', 'failed to create watchlist source');
    }
  });

  v1.get('/watchlist', (c) => {
    const { limit, offset } = parsePagination(c);
    const result = listWatchlistSources(db, limit, offset);
    return c.json({
      items: result.items.map(serializeWatchlistSourceSummary),
      total: result.total,
      limit,
      offset
    });
  });

  v1.get('/watchlist/:sourceId', (c) => {
    const source = getWatchlistSource(db, c.req.param('sourceId'));
    if (!source) {
      return errorResponse(c, 404, 'not_found', 'watchlist source not found');
    }

    return c.json({
      ...serializeWatchlistSource(source),
      episodes: listWatchlistEpisodesForSource(db, source.id).map(serializeWatchlistEpisode)
    });
  });

  v1.delete('/watchlist/:sourceId', (c) => {
    if (!deleteWatchlistSource(db, c.req.param('sourceId'))) {
      return errorResponse(c, 404, 'not_found', 'watchlist source not found');
    }

    return c.body(null, 204);
  });

  v1.get('/files', (c) => {
    const { limit, offset } = parsePagination(c);
    const result = listFiles(db, limit, offset);
    return c.json({
      items: result.items.map(serializeFile),
      total: result.total,
      limit,
      offset
    });
  });

  v1.get('/files/:fileId/download', async (c) => {
    const row = getFile(db, c.req.param('fileId'));
    if (!row || row.deleted) {
      return errorResponse(c, 404, 'not_found', 'file not found');
    }
    if (row.status !== 'completed') {
      return errorResponse(c, 409, 'not_ready', 'file is not ready');
    }
    return streamFile(c, fileMediaPath(config, row), 'video/x-matroska', row.filename);
  });

  v1.get('/files/:fileId/logs', async (c) => {
    const row = getFile(db, c.req.param('fileId'));
    if (!row) {
      return errorResponse(c, 404, 'not_found', 'file not found');
    }
    return readTextLog(c, fileLogPath(config, row));
  });

  v1.get('/files/:fileId', (c) => {
    const row = getFile(db, c.req.param('fileId'));
    if (!row) {
      return errorResponse(c, 404, 'not_found', 'file not found');
    }
    return c.json(serializeFile(row));
  });

  v1.delete('/files/:fileId', async (c) => {
    const row = getFile(db, c.req.param('fileId'));
    if (!row) {
      return errorResponse(c, 404, 'not_found', 'file not found');
    }

    const force = c.req.query('force') === 'true';
    if (force && isFileReferencedByNzb(db, row.id)) {
      return errorResponse(c, 409, 'referenced_by_nzb', 'file is referenced by an NZB');
    }

    if (row.status === 'running') {
      await workers.downloads?.cancel(row.id);
    }

    if (force) {
      hardDeleteFile(db, row.id);
    } else {
      markFileDeleted(db, row.id);
    }

    await removeDownloadDirectory(config, row);
    return c.body(null, 204);
  });

  v1.post('/nzb', async (c) => {
    const body = await readJsonObject(c);
    if (!body.ok) {
      return errorResponse(c, 400, 'invalid_json', 'invalid JSON body');
    }

    const bodyValidation = validateNzbBody(body.value);
    if (!bodyValidation.ok) {
      return errorResponse(c, 400, bodyValidation.code, bodyValidation.error);
    }

    const fileStateValidation = validateNzbFileStates(db, bodyValidation.fileIds);
    if (!fileStateValidation.ok) {
      return errorResponse(c, fileStateValidation.status, fileStateValidation.code, fileStateValidation.error);
    }

    const seasonPackValidation = validateSeasonPack(fileStateValidation.files);
    if (!seasonPackValidation.ok) {
      return errorResponse(c, 400, seasonPackValidation.code, seasonPackValidation.error);
    }

    const canonical = canonicalizeFiles(fileStateValidation.files);
    const releaseName =
      canonical.length === 1
        ? renderSingleReleaseName(config, canonical[0]!)
        : renderSeasonPackReleaseName(config, canonical[0]!);

    const row = insertNzb(db, {
      releaseName,
      fileIds: canonical.map((file) => file.id)
    });
    await ensureNzbLog(config, row);

    return c.json({ nzbId: row.id, status: row.status }, 202);
  });

  v1.get('/nzb', (c) => {
    const { limit, offset } = parsePagination(c);
    const result = listNzbs(db, limit, offset);
    return c.json({
      items: result.items.map((row) => serializeNzb(db, row)),
      total: result.total,
      limit,
      offset
    });
  });

  v1.get('/nzb/:nzbId/download', async (c) => {
    const row = getNzb(db, c.req.param('nzbId'));
    if (!row) {
      return errorResponse(c, 404, 'not_found', 'nzb not found');
    }
    if (row.status !== 'completed') {
      return errorResponse(c, 409, 'not_ready', 'nzb is not ready');
    }
    return streamFile(c, nzbFinalPath(config, row), 'application/x-nzb', `${row.releaseName}.nzb`);
  });

  v1.get('/nzb/:nzbId/logs', async (c) => {
    const row = getNzb(db, c.req.param('nzbId'));
    if (!row) {
      return errorResponse(c, 404, 'not_found', 'nzb not found');
    }
    return readTextLog(c, nzbLogPath(config, row.id));
  });

  v1.get('/nzb/:nzbId', (c) => {
    const row = getNzb(db, c.req.param('nzbId'));
    if (!row) {
      return errorResponse(c, 404, 'not_found', 'nzb not found');
    }
    return c.json(serializeNzb(db, row));
  });

  v1.delete('/nzb/:nzbId', async (c) => {
    const row = getNzb(db, c.req.param('nzbId'));
    if (!row) {
      return errorResponse(c, 404, 'not_found', 'nzb not found');
    }

    deleteNzb(db, row.id);
    if (row.status === 'running') {
      await workers.nzb?.cancel(row.id);
    }
    await removeNzbArtifacts(config, row);
    return c.body(null, 204);
  });

  v1.notFound((c) => errorResponse(c, 404, 'not_found', 'not found'));

  app.route('/v1', v1);
  app.notFound((c) => errorResponse(c, 404, 'not_found', 'not found'));

  app.onError((error, c) => {
    logger.error({ error }, 'unhandled request error');
    return errorResponse(c, 500, 'internal_error', 'internal server error');
  });

  return app;
}

function serializeFile(row: FileRow) {
  return {
    id: row.id,
    url: row.url,
    status: row.status,
    filename: row.filename,
    downloadedAt: row.downloadedAt,
    deleted: Boolean(row.deleted),
    errorCode: row.status === 'failed' ? row.errorCode : null,
    error: row.status === 'failed' ? row.error : null
  };
}

function serializeNzb(db: AppDatabase, row: NzbRow) {
  return {
    id: row.id,
    status: row.status,
    nzbFile: row.nzbFile,
    createdAt: row.createdAt,
    postedAt: row.postedAt,
    errorCode: row.status === 'failed' ? row.errorCode : null,
    error: row.status === 'failed' ? row.error : null,
    files: canonicalFilesForNzb(db, row.id).map((file) => ({
      id: file.id,
      url: file.url,
      status: file.status,
      downloadedAt: file.downloadedAt
    }))
  };
}

function serializeWatchlistSource(row: WatchlistSourceRow) {
  return {
    id: row.id,
    service: row.service,
    type: row.type,
    url: row.url,
    title: row.title,
    enabled: Boolean(row.enabled),
    backfill: Boolean(row.backfill),
    firstScanCompleted: Boolean(row.firstScanCompleted),
    lastScannedAt: row.lastScannedAt,
    nextScanAt: row.nextScanAt,
    lastErrorCode: row.lastErrorCode,
    lastError: row.lastError,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  };
}

function serializeWatchlistSourceSummary(row: WatchlistSourceSummary) {
  return {
    ...serializeWatchlistSource(row),
    episodeCount: Number(row.episodeCount),
    queuedCount: Number(row.queuedCount),
    postedCount: Number(row.postedCount),
    blockedCount: Number(row.blockedCount)
  };
}

function serializeWatchlistEpisode(row: WatchlistEpisodeRow) {
  return {
    id: row.id,
    sourceId: row.sourceId,
    url: row.url,
    season: row.season,
    episode: row.episode,
    title: row.title,
    quality: row.quality,
    status: row.status,
    fileId: row.fileId,
    nzbId: row.nzbId,
    downloadAttempts: row.downloadAttempts,
    nzbAttempts: row.nzbAttempts,
    downloadQueuedAt: row.downloadQueuedAt,
    downloadedAt: row.downloadedAt,
    nzbQueuedAt: row.nzbQueuedAt,
    postedAt: row.postedAt,
    lastErrorCode: row.lastErrorCode,
    lastError: row.lastError,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  };
}

async function readJsonObject(c: Context): Promise<
  | { ok: true; value: Record<string, unknown> }
  | { ok: false }
> {
  try {
    const value = (await c.req.json()) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return { ok: false };
    }
    return { ok: true, value: value as Record<string, unknown> };
  } catch {
    return { ok: false };
  }
}

function validateDownloadBody(body: Record<string, unknown>):
  | {
      ok: true;
      value: {
        url: string;
        title: string;
        service: string;
        quality: string;
        season: number | null;
        episode: number | null;
      };
    }
  | { ok: false; code: string; error: string } {
  const url = stringField(body.url);
  const title = stringField(body.title);
  const service = stringField(body.service);
  const quality = stringField(body.quality);
  if (!url || !title || !service || !quality) {
    return { ok: false, code: 'missing_required_param', error: 'missing required parameter' };
  }
  try {
    new URL(url);
  } catch {
    return { ok: false, code: 'malformed_url', error: 'url is malformed' };
  }
  if (!/^\d{3,4}$/.test(quality)) {
    return { ok: false, code: 'malformed_quality', error: 'quality is malformed' };
  }

  const season = optionalInteger(body.season);
  const episode = optionalInteger(body.episode);
  if (!season.ok || !episode.ok) {
    return { ok: false, code: 'invalid_episode_metadata', error: 'season and episode must be integers' };
  }
  if ((season.value == null) !== (episode.value == null)) {
    return { ok: false, code: 'partial_episode_metadata', error: 'season and episode must both be present or both absent' };
  }

  return {
    ok: true,
    value: {
      url,
      title,
      service,
      quality,
      season: season.value,
      episode: episode.value
    }
  };
}

function validateNzbBody(body: Record<string, unknown>):
  | { ok: true; fileIds: string[] }
  | { ok: false; code: string; error: string } {
  if (!Array.isArray(body.fileIds)) {
    return { ok: false, code: 'empty_list', error: 'fileIds must be a non-empty array' };
  }
  const fileIds = body.fileIds.filter((value): value is string => typeof value === 'string' && value.length > 0);
  if (fileIds.length === 0 || fileIds.length !== body.fileIds.length) {
    return { ok: false, code: 'empty_list', error: 'fileIds must be a non-empty array of strings' };
  }
  if (new Set(fileIds).size !== fileIds.length) {
    return { ok: false, code: 'duplicate_file_id', error: 'fileIds contains a duplicate fileId' };
  }
  return { ok: true, fileIds };
}

function validateNzbFileStates(db: AppDatabase, fileIds: string[]):
  | { ok: true; files: FileRow[] }
  | { ok: false; status: 409; code: string; error: string } {
  const files: FileRow[] = [];
  for (const fileId of fileIds) {
    const row = getFile(db, fileId);
    if (!row) {
      return { ok: false, status: 409, code: 'file_missing', error: `file missing: ${fileId}` };
    }
    if (row.status === 'pending' || row.status === 'running') {
      return { ok: false, status: 409, code: 'file_pending', error: `file pending: ${fileId}` };
    }
    if (row.status === 'failed') {
      return { ok: false, status: 409, code: 'file_failed', error: `file failed: ${fileId}` };
    }
    if (row.deleted) {
      return { ok: false, status: 409, code: 'file_deleted', error: `file deleted: ${fileId}` };
    }
    files.push(row);
  }

  return { ok: true, files };
}

function validateSeasonPack(files: FileRow[]): { ok: true } | { ok: false; code: string; error: string } {
  if (files.length > 1) {
    const [first] = files;
    if (!first || files.some((file) => file.title !== first.title || file.service !== first.service || file.season !== first.season)) {
      return { ok: false, code: 'season_pack_mismatch', error: 'files do not form a season pack' };
    }
  }

  return { ok: true };
}

function canonicalizeFiles<T extends { episode: number | null; id: string }>(files: T[]): T[] {
  return [...files].sort((a, b) => {
    if (a.episode == null && b.episode != null) {
      return 1;
    }
    if (a.episode != null && b.episode == null) {
      return -1;
    }
    if (a.episode != null && b.episode != null && a.episode !== b.episode) {
      return a.episode - b.episode;
    }
    return a.id.localeCompare(b.id);
  });
}

function parsePagination(c: Context): { limit: number; offset: number } {
  const limit = clampInt(c.req.query('limit'), 20, 1, 100);
  const offset = clampInt(c.req.query('offset'), 0, 0, Number.MAX_SAFE_INTEGER);
  return { limit, offset };
}

function clampInt(value: string | undefined, fallback: number, min: number, max: number): number {
  if (!value) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(Math.max(parsed, min), max);
}

function stringField(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function optionalInteger(value: unknown): { ok: true; value: number | null } | { ok: false } {
  if (value == null) {
    return { ok: true, value: null };
  }
  if (Number.isInteger(value)) {
    return { ok: true, value: value as number };
  }
  return { ok: false };
}

function optionalBoolean(value: unknown): { ok: true; value: boolean | null } | { ok: false } {
  if (value == null) {
    return { ok: true, value: null };
  }
  if (typeof value === 'boolean') {
    return { ok: true, value };
  }
  return { ok: false };
}

async function streamFile(c: Context, filePath: string, contentType: string, filename: string): Promise<Response> {
  let stat;
  try {
    stat = await fs.stat(filePath);
  } catch {
    return errorResponse(c, 500, 'artifact_missing', 'artifact missing on disk');
  }

  return c.body(Readable.toWeb(createReadStream(filePath)) as ReadableStream, 200, {
    'content-type': contentType,
    'content-length': String(stat.size),
    'content-disposition': `attachment; filename="${filename.replaceAll('"', '')}"`
  });
}

async function readTextLog(c: Context, logPath: string): Promise<Response> {
  try {
    const content = await fs.readFile(logPath, 'utf8');
    return c.text(content, 200, {
      'content-type': 'text/plain; charset=utf-8'
    });
  } catch {
    return errorResponse(c, 500, 'log_missing', 'log file missing');
  }
}

async function ensureFileLog(config: Config, row: FileRow): Promise<void> {
  await fs.mkdir(path.dirname(fileLogPath(config, row)), { recursive: true });
  await fs.appendFile(fileLogPath(config, row), '');
}

async function ensureNzbLog(config: Config, row: NzbRow): Promise<void> {
  await fs.mkdir(path.dirname(nzbLogPath(config, row.id)), { recursive: true });
  await fs.appendFile(nzbLogPath(config, row.id), '');
}
