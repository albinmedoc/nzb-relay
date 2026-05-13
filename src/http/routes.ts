import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { Hono, type Context } from 'hono';
import { cors } from 'hono/cors';
import type { Logger } from 'pino';
import { z } from 'zod';
import {
  createDownloadRequestSchema,
  createFileArchiveRequestSchema,
  createNzbArchiveRequestSchema,
  createNzbRequestSchema,
  createWatchlistSourceRequestSchema,
  jobStatusSchema,
  updateWatchlistSourceRequestSchema,
  type CreateDownloadResponse,
  type CreateNzbResponse,
  type FileJobResponse,
  type HealthResponse,
  type NzbJobResponse,
  type RetryFileResponse,
  type RetryNzbResponse,
  type RetryWatchlistSourceResponse,
  type WatchlistEpisodeResponse,
  type WatchlistSourceDetailResponse,
  type WatchlistSourceResponse,
  type WatchlistSourceSummaryResponse
} from '@nzb-relay/shared';
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
  markFileDeleted,
  retryFailedFile,
  retryFailedNzb
} from '../db/repository.js';
import type { JobListFilters } from '../db/repository.js';
import {
  deleteWatchlistSource,
  getWatchlistSource,
  insertWatchlistSource,
  listWatchlistEpisodesForSource,
  listWatchlistSources,
  retryFailedWatchlistEpisodesForSource,
  updateWatchlistSource
} from '../db/watchlist-repository.js';
import type { FileRow, JobStatus, NzbRow, WatchlistEpisodeRow, WatchlistSourceRow, WatchlistSourceSummary } from '../types.js';
import { fetchSvtSerie, type SvtSerieFetchOptions, type SvtSerieResponse } from '../discovery/svtplay.js';
import { removeDownloadDirectory, removeDownloadPartialsKeepLog, removeNzbArtifacts, removeNzbWorkDir } from '../utils/cleanup.js';
import { fileLogPath, fileMediaPath, nzbFinalPath, nzbLogPath } from '../utils/paths.js';
import {
  renderDownloadFilename,
  sanitizeToken
} from '../utils/templates.js';
import { streamZip, type ZipEntry } from '../utils/zip.js';
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
  if (config.cors.origins === '*') {
    v1.use('*', cors(corsOptions('*')));
  } else if (config.cors.origins.length > 0) {
    v1.use('*', cors(corsOptions(config.cors.origins)));
  }
  v1.get('/health', (c) => c.json({ status: 'ok', version: config.version } satisfies HealthResponse));
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
      return c.json({ fileId: row.id, status: row.status } satisfies CreateDownloadResponse, 202);
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

    const validation = validateWatchlistBody(body.value);
    if (!validation.ok) {
      return errorResponse(c, 400, validation.code, validation.error);
    }

    const resolved = resolveWatchProvider(validation.value.url, watchProviders);
    if (!resolved) {
      return errorResponse(c, 400, 'unsupported_watch_url', 'watch URL is not supported');
    }

    try {
      const row = insertWatchlistSource(db, {
        service: resolved.provider.service,
        type: resolved.provider.type,
        url: resolved.normalizedUrl,
        backfill: validation.value.backfill,
        deleteFileAfterNzb: validation.value.deleteFileAfterNzb
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
    } satisfies WatchlistSourceDetailResponse);
  });

  v1.patch('/watchlist/:sourceId', async (c) => {
    const body = await readJsonObject(c);
    if (!body.ok) {
      return errorResponse(c, 400, 'invalid_json', 'invalid JSON body');
    }

    const validation = validateWatchlistPatchBody(body.value);
    if (!validation.ok) {
      return errorResponse(c, 400, validation.code, validation.error);
    }

    const source = updateWatchlistSource(db, c.req.param('sourceId'), validation.value);
    if (!source) {
      return errorResponse(c, 404, 'not_found', 'watchlist source not found');
    }

    return c.json(serializeWatchlistSource(source));
  });

  v1.delete('/watchlist/:sourceId', (c) => {
    if (!deleteWatchlistSource(db, c.req.param('sourceId'))) {
      return errorResponse(c, 404, 'not_found', 'watchlist source not found');
    }

    return c.body(null, 204);
  });

  v1.post('/watchlist/:sourceId/retry', (c) => {
    const source = getWatchlistSource(db, c.req.param('sourceId'));
    if (!source) {
      return errorResponse(c, 404, 'not_found', 'watchlist source not found');
    }

    const retried = retryFailedWatchlistEpisodesForSource(db, source.id);
    return c.json({ sourceId: source.id, retried } satisfies RetryWatchlistSourceResponse, 202);
  });

  v1.get('/files', (c) => {
    const params = parseListParams(c);
    if (!params.ok) {
      return errorResponse(c, 400, params.code, params.error);
    }
    const { limit, offset, filters } = params.value;
    const result = listFiles(db, limit, offset, filters);
    return c.json({
      items: result.items.map(serializeFile),
      total: result.total,
      limit,
      offset
    });
  });

  v1.post('/files/archive', async (c) => {
    const body = await readJsonObject(c);
    if (!body.ok) {
      return errorResponse(c, 400, 'invalid_json', 'invalid JSON body');
    }

    const validation = validateFileArchiveBody(body.value);
    if (!validation.ok) {
      return errorResponse(c, 400, validation.code, validation.error);
    }

    const entries: ZipEntry[] = [];
    const names = uniqueArchiveNames();
    for (const fileId of validation.fileIds) {
      const row = getFile(db, fileId);
      if (!row) {
        return errorResponse(c, 404, 'not_found', `file not found: ${fileId}`);
      }
      if (row.deleted) {
        return errorResponse(c, 409, 'file_deleted', `file is deleted: ${fileId}`);
      }
      if (row.status !== 'completed') {
        return errorResponse(c, 409, 'not_ready', `file is not ready: ${fileId}`);
      }
      const filePath = fileMediaPath(config, row);
      const stat = await statArtifact(c, filePath);
      if (!stat.ok) {
        return stat.response;
      }
      entries.push({ name: names(row.filename), path: filePath, size: stat.size });
    }

    return streamZipResponse(c, entries, 'nzb-relay-files.zip');
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

  v1.post('/files/:fileId/retry', async (c) => {
    const row = getFile(db, c.req.param('fileId'));
    if (!row) {
      return errorResponse(c, 404, 'not_found', 'file not found');
    }
    if (row.deleted) {
      return errorResponse(c, 409, 'file_deleted', 'file is deleted');
    }
    if (row.status !== 'failed') {
      return errorResponse(c, 409, 'file_not_failed', 'file is not failed');
    }
    if (hasActiveUrl(db, row.url)) {
      return errorResponse(c, 409, 'duplicate_url', 'active download already exists for url');
    }

    await removeDownloadPartialsKeepLog(config, row);
    if (!retryFailedFile(db, row.id)) {
      return errorResponse(c, 409, 'file_not_failed', 'file is not failed');
    }
    return c.json({ fileId: row.id, status: 'pending' } satisfies RetryFileResponse, 202);
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
    const row = insertNzb(db, {
      releaseName: bodyValidation.name,
      fileIds: canonical.map((file) => file.id)
    });
    await ensureNzbLog(config, row);

    return c.json({ nzbId: row.id, status: row.status } satisfies CreateNzbResponse, 202);
  });

  v1.get('/nzb', (c) => {
    const params = parseListParams(c);
    if (!params.ok) {
      return errorResponse(c, 400, params.code, params.error);
    }
    const { limit, offset, filters } = params.value;
    const result = listNzbs(db, limit, offset, filters);
    return c.json({
      items: result.items.map((row) => serializeNzb(db, row)),
      total: result.total,
      limit,
      offset
    });
  });

  v1.post('/nzb/archive', async (c) => {
    const body = await readJsonObject(c);
    if (!body.ok) {
      return errorResponse(c, 400, 'invalid_json', 'invalid JSON body');
    }

    const validation = validateNzbArchiveBody(body.value);
    if (!validation.ok) {
      return errorResponse(c, 400, validation.code, validation.error);
    }

    const entries: ZipEntry[] = [];
    const names = uniqueArchiveNames();
    for (const nzbId of validation.nzbIds) {
      const row = getNzb(db, nzbId);
      if (!row) {
        return errorResponse(c, 404, 'not_found', `nzb not found: ${nzbId}`);
      }
      if (row.status !== 'completed') {
        return errorResponse(c, 409, 'not_ready', `NZB is not ready: ${nzbId}`);
      }
      const filePath = nzbFinalPath(config, row);
      const stat = await statArtifact(c, filePath);
      if (!stat.ok) {
        return stat.response;
      }
      entries.push({ name: names(`${row.releaseName}.nzb`), path: filePath, size: stat.size });
    }

    return streamZipResponse(c, entries, 'nzb-relay-nzbs.zip');
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
    return readTextLog(c, nzbLogPath(config, row));
  });

  v1.post('/nzb/:nzbId/retry', async (c) => {
    const row = getNzb(db, c.req.param('nzbId'));
    if (!row) {
      return errorResponse(c, 404, 'not_found', 'nzb not found');
    }
    if (row.status !== 'failed') {
      return errorResponse(c, 409, 'nzb_not_failed', 'NZB is not failed');
    }

    const files = canonicalFilesForNzb(db, row.id);
    const fileStateValidation = validateNzbFileStates(db, files.map((file) => file.id));
    if (!fileStateValidation.ok) {
      return errorResponse(c, fileStateValidation.status, fileStateValidation.code, fileStateValidation.error);
    }

    await removeNzbWorkDir(config, row);
    if (!retryFailedNzb(db, row.id)) {
      return errorResponse(c, 409, 'nzb_not_failed', 'NZB is not failed');
    }
    return c.json({ nzbId: row.id, status: 'pending' } satisfies RetryNzbResponse, 202);
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

function corsOptions(origin: '*' | string[]) {
  return {
    origin,
    allowHeaders: ['Authorization', 'Content-Type'],
    allowMethods: ['GET', 'HEAD', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    maxAge: 600
  };
}

function serializeFile(row: FileRow): FileJobResponse {
  return {
    id: row.id,
    url: row.url,
    status: row.status,
    filename: row.filename,
    createdAt: row.createdAt,
    downloadedAt: row.downloadedAt,
    deleted: Boolean(row.deleted),
    errorCode: row.status === 'failed' ? row.errorCode : null,
    error: row.status === 'failed' ? row.error : null
  };
}

function serializeNzb(db: AppDatabase, row: NzbRow): NzbJobResponse {
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
      createdAt: file.createdAt,
      downloadedAt: file.downloadedAt
    }))
  };
}

function serializeWatchlistSource(row: WatchlistSourceRow): WatchlistSourceResponse {
  return {
    id: row.id,
    service: row.service,
    type: row.type,
    url: row.url,
    title: row.title,
    enabled: Boolean(row.enabled),
    backfill: Boolean(row.backfill),
    deleteFileAfterNzb: Boolean(row.deleteFileAfterNzb),
    firstScanCompleted: Boolean(row.firstScanCompleted),
    lastScannedAt: row.lastScannedAt,
    nextScanAt: row.nextScanAt,
    lastErrorCode: row.lastErrorCode,
    lastError: row.lastError,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  };
}

function serializeWatchlistSourceSummary(row: WatchlistSourceSummary): WatchlistSourceSummaryResponse {
  return {
    ...serializeWatchlistSource(row),
    episodeCount: Number(row.episodeCount),
    queuedCount: Number(row.queuedCount),
    postedCount: Number(row.postedCount),
    blockedCount: Number(row.blockedCount)
  };
}

function serializeWatchlistEpisode(row: WatchlistEpisodeRow): WatchlistEpisodeResponse {
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

const jsonObjectSchema = z.record(z.string(), z.unknown());
const paginationQuerySchema = z
  .object({
    limit: z.string().optional().transform((value) => clampParsedInt(value, 20, 1, 100)),
    offset: z.string().optional().transform((value) => clampParsedInt(value, 0, 0, Number.MAX_SAFE_INTEGER))
  })
  .passthrough();

async function readJsonObject(c: Context): Promise<
  | { ok: true; value: Record<string, unknown> }
  | { ok: false }
> {
  try {
    const value = (await c.req.json()) as unknown;
    const parsed = jsonObjectSchema.safeParse(value);
    if (!parsed.success) {
      return { ok: false };
    }
    return { ok: true, value: parsed.data };
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
  const required = createDownloadRequestSchema.pick({ url: true, title: true, service: true, quality: true }).safeParse(body);
  if (!required.success) {
    return { ok: false, code: 'missing_required_param', error: 'missing required parameter' };
  }
  try {
    new URL(required.data.url);
  } catch {
    return { ok: false, code: 'malformed_url', error: 'url is malformed' };
  }
  if (!/^\d{3,4}$/.test(required.data.quality)) {
    return { ok: false, code: 'malformed_quality', error: 'quality is malformed' };
  }

  const episodeMetadata = createDownloadRequestSchema.pick({ season: true, episode: true }).safeParse(body);
  if (!episodeMetadata.success) {
    return { ok: false, code: 'invalid_episode_metadata', error: 'season and episode must be integers' };
  }
  const season = episodeMetadata.data.season ?? null;
  const episode = episodeMetadata.data.episode ?? null;
  if ((season == null) !== (episode == null)) {
    return { ok: false, code: 'partial_episode_metadata', error: 'season and episode must both be present or both absent' };
  }

  return {
    ok: true,
    value: {
      url: required.data.url,
      title: required.data.title,
      service: required.data.service,
      quality: required.data.quality,
      season,
      episode
    }
  };
}

function validateWatchlistBody(body: Record<string, unknown>):
  | { ok: true; value: { url: string; backfill: boolean; deleteFileAfterNzb: boolean } }
  | { ok: false; code: string; error: string } {
  const url = createWatchlistSourceRequestSchema.pick({ url: true }).safeParse(body);
  if (!url.success) {
    return { ok: false, code: 'missing_required_param', error: 'missing required parameter' };
  }

  const backfill = createWatchlistSourceRequestSchema.pick({ backfill: true }).safeParse(body);
  if (!backfill.success) {
    return { ok: false, code: 'invalid_backfill', error: 'backfill must be a boolean' };
  }

  const deleteFileAfterNzb = createWatchlistSourceRequestSchema.pick({ deleteFileAfterNzb: true }).safeParse(body);
  if (!deleteFileAfterNzb.success) {
    return { ok: false, code: 'invalid_delete_file_after_nzb', error: 'deleteFileAfterNzb must be a boolean' };
  }

  return {
    ok: true,
    value: {
      url: url.data.url,
      backfill: backfill.data.backfill ?? true,
      deleteFileAfterNzb: deleteFileAfterNzb.data.deleteFileAfterNzb ?? true
    }
  };
}

function validateWatchlistPatchBody(body: Record<string, unknown>):
  | { ok: true; value: { enabled?: boolean; deleteFileAfterNzb?: boolean; title?: string } }
  | { ok: false; code: string; error: string } {
  const value: { enabled?: boolean; deleteFileAfterNzb?: boolean; title?: string } = {};
  let fields = 0;

  if ('enabled' in body) {
    const enabled = updateWatchlistSourceRequestSchema.pick({ enabled: true }).safeParse(body);
    if (!enabled.success) {
      return { ok: false, code: 'invalid_enabled', error: 'enabled must be a boolean' };
    }
    value.enabled = enabled.data.enabled;
    fields += 1;
  }

  if ('deleteFileAfterNzb' in body) {
    const deleteFileAfterNzb = updateWatchlistSourceRequestSchema.pick({ deleteFileAfterNzb: true }).safeParse(body);
    if (!deleteFileAfterNzb.success) {
      return { ok: false, code: 'invalid_delete_file_after_nzb', error: 'deleteFileAfterNzb must be a boolean' };
    }
    value.deleteFileAfterNzb = deleteFileAfterNzb.data.deleteFileAfterNzb;
    fields += 1;
  }

  if ('title' in body) {
    const title = updateWatchlistSourceRequestSchema.pick({ title: true }).safeParse(body);
    if (!title.success) {
      return { ok: false, code: 'invalid_title', error: 'title must be a non-empty string' };
    }
    value.title = title.data.title;
    fields += 1;
  }

  if (fields === 0) {
    return { ok: false, code: 'empty_update', error: 'at least one editable field is required' };
  }

  return { ok: true, value };
}

function validateNzbBody(body: Record<string, unknown>):
  | { ok: true; fileIds: string[]; name: string }
  | { ok: false; code: string; error: string } {
  const fileIdsValidation = createNzbRequestSchema.pick({ fileIds: true }).safeParse(body);
  if (!fileIdsValidation.success || fileIdsValidation.data.fileIds.length === 0) {
    return { ok: false, code: 'empty_list', error: 'fileIds must be a non-empty array' };
  }

  const fileIds = fileIdsValidation.data.fileIds;
  if (new Set(fileIds).size !== fileIds.length) {
    return { ok: false, code: 'duplicate_file_id', error: 'fileIds contains a duplicate fileId' };
  }

  const name = typeof body.name === 'string' ? sanitizeToken(body.name) : '';
  if (!name) {
    return { ok: false, code: 'invalid_name', error: 'name must be a non-empty release name' };
  }

  return { ok: true, fileIds, name };
}

function validateFileArchiveBody(body: Record<string, unknown>):
  | { ok: true; fileIds: string[] }
  | { ok: false; code: string; error: string } {
  const validation = createFileArchiveRequestSchema.safeParse(body);
  if (!validation.success) {
    return { ok: false, code: 'empty_list', error: 'fileIds must be a non-empty array' };
  }
  if (new Set(validation.data.fileIds).size !== validation.data.fileIds.length) {
    return { ok: false, code: 'duplicate_file_id', error: 'fileIds contains a duplicate fileId' };
  }
  return { ok: true, fileIds: validation.data.fileIds };
}

function validateNzbArchiveBody(body: Record<string, unknown>):
  | { ok: true; nzbIds: string[] }
  | { ok: false; code: string; error: string } {
  const validation = createNzbArchiveRequestSchema.safeParse(body);
  if (!validation.success) {
    return { ok: false, code: 'empty_list', error: 'nzbIds must be a non-empty array' };
  }
  if (new Set(validation.data.nzbIds).size !== validation.data.nzbIds.length) {
    return { ok: false, code: 'duplicate_nzb_id', error: 'nzbIds contains a duplicate nzbId' };
  }
  return { ok: true, nzbIds: validation.data.nzbIds };
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
  return paginationQuerySchema.parse({
    limit: c.req.query('limit'),
    offset: c.req.query('offset')
  });
}

function parseListParams(c: Context):
  | { ok: true; value: { limit: number; offset: number; filters: JobListFilters } }
  | { ok: false; code: string; error: string } {
  const { limit, offset } = parsePagination(c);
  const status = c.req.query('status');
  const createdAfter = c.req.query('createdAfter');
  const createdBefore = c.req.query('createdBefore');
  const watchlistSourceId = c.req.query('watchlistSourceId');
  const includeDeleted = c.req.query('includeDeleted');
  const filters: JobListFilters = {};

  if (status != null) {
    const statusValidation = jobStatusSchema.safeParse(status);
    if (!statusValidation.success) {
      return { ok: false, code: 'invalid_status', error: 'status must be pending, running, completed, or failed' };
    }
    filters.status = statusValidation.data;
  }

  if (createdAfter != null) {
    const createdAfterValidation = parseDateQuery(createdAfter);
    if (!createdAfterValidation.ok) {
      return { ok: false, code: 'invalid_created_after', error: 'createdAfter must be a valid datetime' };
    }
    filters.createdAfter = createdAfterValidation.value;
  }

  if (createdBefore != null) {
    const createdBeforeValidation = parseDateQuery(createdBefore);
    if (!createdBeforeValidation.ok) {
      return { ok: false, code: 'invalid_created_before', error: 'createdBefore must be a valid datetime' };
    }
    filters.createdBefore = createdBeforeValidation.value;
  }

  if (filters.createdAfter && filters.createdBefore && filters.createdAfter > filters.createdBefore) {
    return { ok: false, code: 'invalid_created_range', error: 'createdAfter must be before or equal to createdBefore' };
  }

  if (watchlistSourceId != null) {
    const sourceId = z.string().trim().min(1).safeParse(watchlistSourceId);
    if (!sourceId.success) {
      return { ok: false, code: 'invalid_watchlist_source_id', error: 'watchlistSourceId must be a non-empty string' };
    }
    filters.watchlistSourceId = sourceId.data;
  }

  if (includeDeleted != null) {
    const value = includeDeleted.toLowerCase();
    if (value !== 'true' && value !== 'false') {
      return { ok: false, code: 'invalid_include_deleted', error: 'includeDeleted must be true or false' };
    }
    filters.includeDeleted = value === 'true';
  }

  return { ok: true, value: { limit, offset, filters } };
}

function parseDateQuery(value: string): { ok: true; value: string } | { ok: false } {
  const parsed = z
    .string()
    .trim()
    .min(1)
    .refine((candidate) => !Number.isNaN(Date.parse(candidate)))
    .safeParse(value);
  if (!parsed.success) {
    return { ok: false };
  }
  return { ok: true, value: new Date(parsed.data).toISOString() };
}

function clampParsedInt(value: string | undefined, fallback: number, min: number, max: number): number {
  if (!value) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(Math.max(parsed, min), max);
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

async function statArtifact(c: Context, filePath: string): Promise<{ ok: true; size: number } | { ok: false; response: Response }> {
  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) {
      return { ok: false, response: errorResponse(c, 500, 'artifact_missing', 'artifact missing on disk') };
    }
    return { ok: true, size: stat.size };
  } catch {
    return { ok: false, response: errorResponse(c, 500, 'artifact_missing', 'artifact missing on disk') };
  }
}

function streamZipResponse(c: Context, entries: ZipEntry[], filename: string): Response {
  return c.body(Readable.toWeb(Readable.from(streamZip(entries))) as ReadableStream, 200, {
    'content-type': 'application/zip',
    'content-disposition': `attachment; filename="${filename.replaceAll('"', '')}"`
  });
}

function uniqueArchiveNames(): (name: string) => string {
  const seen = new Map<string, number>();
  return (name: string) => {
    const safeName = path.basename(name).replaceAll('"', '') || 'artifact';
    const count = seen.get(safeName) ?? 0;
    seen.set(safeName, count + 1);
    if (count === 0) {
      return safeName;
    }
    const extension = path.extname(safeName);
    const base = extension ? safeName.slice(0, -extension.length) : safeName;
    return `${base}-${count + 1}${extension}`;
  };
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
  await fs.mkdir(path.dirname(nzbLogPath(config, row)), { recursive: true });
  await fs.appendFile(nzbLogPath(config, row), '');
}
