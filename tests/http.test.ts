import fs from 'node:fs/promises';
import path from 'node:path';
import { Hono } from 'hono';
import type { Logger } from 'pino';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Config } from '../src/config.js';
import type { AppDatabase } from '../src/db/client.js';
import { getFile, getNzb, insertFile, insertNzb } from '../src/db/repository.js';
import { insertWatchlistSource, upsertWatchlistEpisode } from '../src/db/watchlist-repository.js';
import { requestLoggingMiddleware } from '../src/http/middleware.js';
import { nzbLogPath } from '../src/utils/paths.js';
import { cleanup, createTempDataDir, createTestApp, createTestDb, testConfig } from './helpers.js';

let dataDir: string;
let config: Config;
let db: AppDatabase;
let app: ReturnType<typeof createTestApp>;

beforeEach(async () => {
  dataDir = await createTempDataDir();
  config = testConfig(dataDir, {
    API_KEY: 'secret'
  });
  db = createTestDb(config);
  app = createTestApp(db, config);
});

afterEach(async () => {
  await cleanup(dataDir, db);
});

describe('http api', () => {
  it('leaves health open and gates other routes with bearer auth', async () => {
    const health = await app.request('/v1/health');
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({
      status: 'ok',
      version: '0.0.0'
    });

    const unauthorized = await app.request('/v1/files');
    expect(unauthorized.status).toBe(401);
    expect(await unauthorized.json()).toMatchObject({
      code: 'unauthorized',
      requestId: expect.any(String)
    });

    const authorized = await app.request('/v1/files', {
      headers: { authorization: 'Bearer secret' }
    });
    expect(authorized.status).toBe(200);
  });

  it('leaves frontend routes disabled by default', async () => {
    const response = await app.request('/');

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({
      code: 'not_found',
      requestId: expect.any(String)
    });
  });

  it('adds CORS headers for allowed frontend origins', async () => {
    const corsApp = createTestApp(
      db,
      testConfig(dataDir, {
        API_KEY: 'secret',
        CORS_ORIGINS: 'https://ui.example.test'
      })
    );

    const allowed = await corsApp.request('/v1/files', {
      headers: {
        authorization: 'Bearer secret',
        origin: 'https://ui.example.test'
      }
    });
    expect(allowed.status).toBe(200);
    expect(allowed.headers.get('access-control-allow-origin')).toBe('https://ui.example.test');

    const disallowed = await corsApp.request('/v1/files', {
      headers: {
        authorization: 'Bearer secret',
        origin: 'https://other.example.test'
      }
    });
    expect(disallowed.status).toBe(200);
    expect(disallowed.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('handles CORS preflight before auth', async () => {
    const corsApp = createTestApp(
      db,
      testConfig(dataDir, {
        API_KEY: 'secret',
        CORS_ORIGINS: '*'
      })
    );

    const response = await corsApp.request('/v1/files', {
      method: 'OPTIONS',
      headers: {
        origin: 'https://ui.example.test',
        'access-control-request-headers': 'authorization, content-type'
      }
    });

    expect(response.status).toBe(204);
    expect(response.headers.get('access-control-allow-origin')).toBe('*');
    expect(response.headers.get('access-control-allow-headers')).toBe('Authorization,Content-Type');
  });

  it('omits request logs for health checks', async () => {
    const logs: Array<{ path: string }> = [];
    const logger = {
      info(fields: { path: string }) {
        logs.push(fields);
      }
    } as Logger;
    const loggingApp = new Hono();
    loggingApp.use('*', requestLoggingMiddleware(logger));
    loggingApp.get('/v1/health', (c) => c.json({ status: 'ok' }));
    loggingApp.get('/v1/files', (c) => c.json({ items: [] }));

    const health = await loggingApp.request('/v1/health');
    const files = await loggingApp.request('/v1/files');

    expect(health.status).toBe(200);
    expect(health.headers.get('x-request-id')).toEqual(expect.any(String));
    expect(files.status).toBe(200);
    expect(logs.map((entry) => entry.path)).toEqual(['/v1/files']);
  });

  it('filters files by status and inclusive createdAt bounds', async () => {
    const pending = createFile('https://example.test/pending');
    const completed = createFile('https://example.test/completed');
    const failed = createFile('https://example.test/failed');
    db.prepare("UPDATE file SET status = 'pending', createdAt = ? WHERE id = ?").run('2026-05-01T00:00:00.000Z', pending.id);
    db.prepare("UPDATE file SET status = 'completed', createdAt = ? WHERE id = ?").run(
      '2026-05-02T00:00:00.000Z',
      completed.id
    );
    db.prepare("UPDATE file SET status = 'failed', createdAt = ? WHERE id = ?").run('2026-05-03T00:00:00.000Z', failed.id);

    const byStatus = await app.request('/v1/files?status=completed', {
      headers: { authorization: 'Bearer secret' }
    });
    expect(byStatus.status).toBe(200);
    expect(await byStatus.json()).toMatchObject({
      total: 1,
      items: [{ id: completed.id, status: 'completed', createdAt: '2026-05-02T00:00:00.000Z' }]
    });

    const byDate = await app.request(
      '/v1/files?createdAfter=2026-05-02T00:00:00.000Z&createdBefore=2026-05-03T00:00:00.000Z',
      { headers: { authorization: 'Bearer secret' } }
    );
    expect(byDate.status).toBe(200);
    expect(await byDate.json()).toMatchObject({
      total: 2,
      items: [{ id: failed.id }, { id: completed.id }]
    });

    const combined = await app.request('/v1/files?status=completed&createdAfter=2026-05-02T00:00:00.000Z', {
      headers: { authorization: 'Bearer secret' }
    });
    expect(combined.status).toBe(200);
    expect(await combined.json()).toMatchObject({
      total: 1,
      items: [{ id: completed.id }]
    });
  });

  it('rejects invalid file filters', async () => {
    const invalidStatus = await app.request('/v1/files?status=bogus', {
      headers: { authorization: 'Bearer secret' }
    });
    expect(invalidStatus.status).toBe(400);
    expect(await invalidStatus.json()).toMatchObject({ code: 'invalid_status' });

    const invalidDate = await app.request('/v1/files?createdAfter=not-a-date', {
      headers: { authorization: 'Bearer secret' }
    });
    expect(invalidDate.status).toBe(400);
    expect(await invalidDate.json()).toMatchObject({ code: 'invalid_created_after' });

    const invalidRange = await app.request(
      '/v1/files?createdAfter=2026-05-03T00:00:00.000Z&createdBefore=2026-05-02T00:00:00.000Z',
      { headers: { authorization: 'Bearer secret' } }
    );
    expect(invalidRange.status).toBe(400);
    expect(await invalidRange.json()).toMatchObject({ code: 'invalid_created_range' });
  });

  it('filters files by watchlist source and can include soft-deleted rows', async () => {
    const source = createWatchlistSource();
    const otherSource = createWatchlistSource('https://example.test/other-source');
    const linked = createFile('https://example.test/source-file');
    const deleted = createFile('https://example.test/deleted-source-file');
    const other = createFile('https://example.test/other-source-file');
    db.prepare('UPDATE file SET deleted = 1 WHERE id = ?').run(deleted.id);
    linkWatchlistFile(source.id, linked.id, 'https://example.test/source-file');
    linkWatchlistFile(source.id, deleted.id, 'https://example.test/deleted-source-file');
    linkWatchlistFile(otherSource.id, other.id, 'https://example.test/other-source-file');

    const defaultResponse = await app.request(`/v1/files?watchlistSourceId=${source.id}`, {
      headers: { authorization: 'Bearer secret' }
    });
    expect(defaultResponse.status).toBe(200);
    expect(await defaultResponse.json()).toMatchObject({
      total: 1,
      items: [{ id: linked.id }]
    });

    const includeDeletedResponse = await app.request(`/v1/files?watchlistSourceId=${source.id}&includeDeleted=true`, {
      headers: { authorization: 'Bearer secret' }
    });
    expect(includeDeletedResponse.status).toBe(200);
    expect(await includeDeletedResponse.json()).toMatchObject({
      total: 2,
      items: expect.arrayContaining([
        expect.objectContaining({ id: linked.id, deleted: false }),
        expect.objectContaining({ id: deleted.id, deleted: true })
      ])
    });
  });

  it('filters NZBs by status and inclusive createdAt bounds', async () => {
    const file = createFile('https://example.test/nzb-source');
    db.prepare("UPDATE file SET status = 'completed', downloadedAt = ? WHERE id = ?").run(
      '2026-05-01T00:00:00.000Z',
      file.id
    );

    const pending = insertNzb(db, { releaseName: 'Pending', fileIds: [file.id] });
    const completed = insertNzb(db, { releaseName: 'Completed', fileIds: [file.id] });
    const failed = insertNzb(db, { releaseName: 'Failed', fileIds: [file.id] });
    db.prepare("UPDATE nzb SET status = 'pending', createdAt = ? WHERE id = ?").run('2026-05-01T00:00:00.000Z', pending.id);
    db.prepare("UPDATE nzb SET status = 'completed', createdAt = ?, postedAt = ? WHERE id = ?").run(
      '2026-05-02T00:00:00.000Z',
      '2026-05-02T01:00:00.000Z',
      completed.id
    );
    db.prepare("UPDATE nzb SET status = 'failed', createdAt = ?, errorCode = 'unknown', error = 'failed' WHERE id = ?").run(
      '2026-05-03T00:00:00.000Z',
      failed.id
    );

    const byStatus = await app.request('/v1/nzb?status=completed', {
      headers: { authorization: 'Bearer secret' }
    });
    expect(byStatus.status).toBe(200);
    expect(await byStatus.json()).toMatchObject({
      total: 1,
      items: [{ id: completed.id, status: 'completed', files: [{ id: file.id }] }]
    });

    const byDate = await app.request(
      '/v1/nzb?createdAfter=2026-05-02T00:00:00.000Z&createdBefore=2026-05-03T00:00:00.000Z',
      { headers: { authorization: 'Bearer secret' } }
    );
    expect(byDate.status).toBe(200);
    expect(await byDate.json()).toMatchObject({
      total: 2,
      items: [{ id: failed.id }, { id: completed.id }]
    });
  });

  it('rejects invalid NZB filters', async () => {
    const invalidStatus = await app.request('/v1/nzb?status=bogus', {
      headers: { authorization: 'Bearer secret' }
    });
    expect(invalidStatus.status).toBe(400);
    expect(await invalidStatus.json()).toMatchObject({ code: 'invalid_status' });

    const invalidDate = await app.request('/v1/nzb?createdBefore=not-a-date', {
      headers: { authorization: 'Bearer secret' }
    });
    expect(invalidDate.status).toBe(400);
    expect(await invalidDate.json()).toMatchObject({ code: 'invalid_created_before' });
  });

  it('filters NZBs by watchlist source', async () => {
    const source = createWatchlistSource();
    const otherSource = createWatchlistSource('https://example.test/other-nzb-source');
    const linkedFile = createFile('https://example.test/source-nzb-file');
    const otherFile = createFile('https://example.test/other-nzb-file');
    db.prepare("UPDATE file SET status = 'completed', downloadedAt = ? WHERE id IN (?, ?)").run(
      '2026-05-06T00:00:00.000Z',
      linkedFile.id,
      otherFile.id
    );
    const linkedNzb = insertNzb(db, { releaseName: 'Source.Nzb', fileIds: [linkedFile.id] });
    const otherNzb = insertNzb(db, { releaseName: 'Other.Nzb', fileIds: [otherFile.id] });
    linkWatchlistNzb(source.id, linkedFile.id, linkedNzb.id, 'https://example.test/source-nzb-file');
    linkWatchlistNzb(otherSource.id, otherFile.id, otherNzb.id, 'https://example.test/other-nzb-file');

    const response = await app.request(`/v1/nzb?watchlistSourceId=${source.id}`, {
      headers: { authorization: 'Bearer secret' }
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      total: 1,
      items: [{ id: linkedNzb.id, files: [{ id: linkedFile.id }] }]
    });
  });

  it('uses the JSON error envelope for unknown routes', async () => {
    const response = await app.request('/v1/nope', {
      headers: { authorization: 'Bearer secret' }
    });

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({
      code: 'not_found',
      requestId: expect.any(String)
    });
  });

  it('populates SVT discovery qualities by default and supports opt-out and fast mode', async () => {
    const calls: Array<{
      slug: string;
      populateQualities: boolean | undefined;
      fastQualities: boolean | undefined;
    }> = [];
    const appWithDiscovery = createTestApp(db, config, undefined, {
      async fetchSerie(slug, options) {
        calls.push({
          slug,
          populateQualities: options?.populateQualities,
          fastQualities: options?.fastQualities
        });
        return {
          slug,
          name: 'Serie',
          link: `https://www.svtplay.se/${slug}`,
          seasons: []
        };
      }
    });

    const defaultResponse = await appWithDiscovery.request('/v1/svtplay/serie/test-serie', {
      headers: { authorization: 'Bearer secret' }
    });
    const disabledResponse = await appWithDiscovery.request('/v1/svtplay/serie/test-serie?qualities=false', {
      headers: { authorization: 'Bearer secret' }
    });
    const fastResponse = await appWithDiscovery.request('/v1/svtplay/serie/test-serie?fast=true', {
      headers: { authorization: 'Bearer secret' }
    });
    const disabledFastResponse = await appWithDiscovery.request('/v1/svtplay/serie/test-serie?qualities=false&fast=true', {
      headers: { authorization: 'Bearer secret' }
    });

    expect(defaultResponse.status).toBe(200);
    expect(disabledResponse.status).toBe(200);
    expect(fastResponse.status).toBe(200);
    expect(disabledFastResponse.status).toBe(200);
    expect(calls).toEqual([
      { slug: 'test-serie', populateQualities: true, fastQualities: false },
      { slug: 'test-serie', populateQualities: false, fastQualities: false },
      { slug: 'test-serie', populateQualities: true, fastQualities: true },
      { slug: 'test-serie', populateQualities: false, fastQualities: false }
    ]);
  });

  it('validates partial episode metadata before queueing downloads', async () => {
    const response = await app.request('/v1/downloads', {
      method: 'POST',
      headers: {
        authorization: 'Bearer secret',
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        url: 'https://www.svtplay.se/video/1',
        title: 'Title',
        service: 'svtplay',
        quality: '1080',
        season: 1
      })
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: 'partial_episode_metadata' });
  });

  it('returns duplicate_url for active download URL submissions', async () => {
    const body = {
      url: 'https://www.svtplay.se/video/2',
      title: 'Title',
      service: 'svtplay',
      quality: '1080',
      season: 1,
      episode: 1
    };

    const first = await postDownload(body);
    expect(first.status).toBe(202);

    const second = await postDownload(body);
    expect(second.status).toBe(409);
    expect(await second.json()).toMatchObject({ code: 'duplicate_url' });
  });

  it('validates NZB fileIds in deterministic order', async () => {
    const failed = insertFile(db, {
      url: 'https://example.test/failed',
      title: 'Title',
      filename: 'Title.s01e01.svtplay.mkv',
      service: 'svtplay',
      quality: '1080',
      season: 1,
      episode: 1
    });
    db.prepare("UPDATE file SET status = 'failed' WHERE id = ?").run(failed.id);

    const response = await app.request('/v1/nzb', {
      method: 'POST',
      headers: {
        authorization: 'Bearer secret',
        'content-type': 'application/json'
      },
      body: JSON.stringify({ fileIds: ['missing-id', failed.id], name: 'Title.s01e01.svtplay' })
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'file_missing' });
  });

  it('uses the API NZB name for per-job artifacts', async () => {
    const file = insertFile(db, {
      url: 'https://example.test/completed',
      title: 'Title',
      filename: 'Title.s01e01.svtplay.mkv',
      service: 'svtplay',
      quality: '1080',
      season: 1,
      episode: 1
    });
    db.prepare("UPDATE file SET status = 'completed', downloadedAt = ? WHERE id = ?").run(
      '2026-05-06T00:00:00.000Z',
      file.id
    );

    const response = await app.request('/v1/nzb', {
      method: 'POST',
      headers: {
        authorization: 'Bearer secret',
        'content-type': 'application/json'
      },
      body: JSON.stringify({ fileIds: [file.id], name: 'Bakom.varje.man.s02.svtplay' })
    });

    expect(response.status).toBe(202);
    const { nzbId } = (await response.json()) as { nzbId: string };
    const nzb = getNzb(db, nzbId)!;
    expect(nzb).toMatchObject({
      releaseName: 'Bakom.varje.man.s02.svtplay',
      nzbFile: `${nzbId}/Bakom.varje.man.s02.svtplay.nzb`
    });
    expect(nzbLogPath(config, nzb)).toBe(path.join(config.nzbDir, nzbId, 'Bakom.varje.man.s02.svtplay.log'));
    expect((await fs.stat(nzbLogPath(config, nzb))).isFile()).toBe(true);
  });

  it('soft-deletes files by default and preserves metadata', async () => {
    const row = insertFile(db, {
      url: 'https://example.test/delete',
      title: 'Title',
      filename: 'Title.svtplay.mkv',
      service: 'svtplay',
      quality: '1080',
      season: null,
      episode: null
    });

    const response = await app.request(`/v1/files/${row.id}`, {
      method: 'DELETE',
      headers: { authorization: 'Bearer secret' }
    });

    expect(response.status).toBe(204);
    expect(getFile(db, row.id)?.deleted).toBe(1);

    const metadata = await app.request(`/v1/files/${row.id}`, {
      headers: { authorization: 'Bearer secret' }
    });
    expect(await metadata.json()).toMatchObject({ id: row.id, createdAt: row.createdAt, deleted: true });
  });

  it('retries a failed file by resetting the same row to pending', async () => {
    const row = createFile('https://example.test/retry-file');
    db.prepare("UPDATE file SET status = 'failed', errorCode = 'unknown', error = 'failed' WHERE id = ?").run(row.id);

    const response = await app.request(`/v1/files/${row.id}/retry`, {
      method: 'POST',
      headers: { authorization: 'Bearer secret' }
    });

    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ fileId: row.id, status: 'pending' });
    expect(getFile(db, row.id)).toMatchObject({
      status: 'pending',
      downloadedAt: null,
      errorCode: null,
      error: null
    });
  });

  it('streams a ZIP archive for completed file artifacts', async () => {
    const row = createFile('https://example.test/archive-file');
    db.prepare("UPDATE file SET status = 'completed', downloadedAt = ? WHERE id = ?").run('2026-05-06T00:00:00.000Z', row.id);
    await writeFileArtifact(row, 'media');

    const response = await app.request('/v1/files/archive', {
      method: 'POST',
      headers: {
        authorization: 'Bearer secret',
        'content-type': 'application/json'
      },
      body: JSON.stringify({ fileIds: [row.id] })
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/zip');
    expect(Buffer.from(await response.arrayBuffer()).subarray(0, 4).toString('hex')).toBe('504b0304');
  });

  it('rejects file archives with empty or not-ready file IDs', async () => {
    const empty = await app.request('/v1/files/archive', {
      method: 'POST',
      headers: {
        authorization: 'Bearer secret',
        'content-type': 'application/json'
      },
      body: JSON.stringify({ fileIds: [] })
    });
    expect(empty.status).toBe(400);
    expect(await empty.json()).toMatchObject({ code: 'empty_list' });

    const pending = createFile('https://example.test/archive-pending-file');
    const notReady = await app.request('/v1/files/archive', {
      method: 'POST',
      headers: {
        authorization: 'Bearer secret',
        'content-type': 'application/json'
      },
      body: JSON.stringify({ fileIds: [pending.id] })
    });
    expect(notReady.status).toBe(409);
    expect(await notReady.json()).toMatchObject({ code: 'not_ready' });
  });

  it('rejects file retry unless the file is failed, active, and URL-unique', async () => {
    const pending = createFile('https://example.test/retry-pending');
    const pendingResponse = await app.request(`/v1/files/${pending.id}/retry`, {
      method: 'POST',
      headers: { authorization: 'Bearer secret' }
    });
    expect(pendingResponse.status).toBe(409);
    expect(await pendingResponse.json()).toMatchObject({ code: 'file_not_failed' });

    const deleted = createFile('https://example.test/retry-deleted');
    db.prepare("UPDATE file SET status = 'failed', errorCode = 'unknown', error = 'failed', deleted = 1 WHERE id = ?").run(
      deleted.id
    );
    const deletedResponse = await app.request(`/v1/files/${deleted.id}/retry`, {
      method: 'POST',
      headers: { authorization: 'Bearer secret' }
    });
    expect(deletedResponse.status).toBe(409);
    expect(await deletedResponse.json()).toMatchObject({ code: 'file_deleted' });

    const failed = createFile('https://example.test/retry-duplicate');
    db.prepare("UPDATE file SET status = 'failed', errorCode = 'unknown', error = 'failed' WHERE id = ?").run(failed.id);
    createFile('https://example.test/retry-duplicate');
    const duplicateResponse = await app.request(`/v1/files/${failed.id}/retry`, {
      method: 'POST',
      headers: { authorization: 'Bearer secret' }
    });
    expect(duplicateResponse.status).toBe(409);
    expect(await duplicateResponse.json()).toMatchObject({ code: 'duplicate_url' });
  });

  it('kills a running download before marking the file deleted', async () => {
    const row = insertFile(db, {
      url: 'https://example.test/running-delete',
      title: 'Title',
      filename: 'Title.svtplay.mkv',
      service: 'svtplay',
      quality: '1080',
      season: null,
      episode: null
    });
    db.prepare("UPDATE file SET status = 'running' WHERE id = ?").run(row.id);

    let deletedValueWhenCancelled: number | null = null;
    const appWithWorker = createTestApp(db, config, {
      downloads: {
        async cancel(fileId: string) {
          deletedValueWhenCancelled = getFile(db, fileId)?.deleted ?? null;
        }
      }
    });

    const response = await appWithWorker.request(`/v1/files/${row.id}`, {
      method: 'DELETE',
      headers: { authorization: 'Bearer secret' }
    });

    expect(response.status).toBe(204);
    expect(deletedValueWhenCancelled).toBe(0);
    expect(getFile(db, row.id)?.deleted).toBe(1);
  });

  it('retries a failed NZB by resetting the same row to pending', async () => {
    const file = createFile('https://example.test/retry-nzb-file');
    db.prepare("UPDATE file SET status = 'completed', downloadedAt = ? WHERE id = ?").run(
      '2026-05-06T00:00:00.000Z',
      file.id
    );
    const nzb = insertNzb(db, { releaseName: 'Retry.Nzb', fileIds: [file.id] });
    db.prepare("UPDATE nzb SET status = 'failed', errorCode = 'unknown', error = 'failed' WHERE id = ?").run(nzb.id);

    const response = await app.request(`/v1/nzb/${nzb.id}/retry`, {
      method: 'POST',
      headers: { authorization: 'Bearer secret' }
    });

    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ nzbId: nzb.id, status: 'pending' });
    expect(getNzb(db, nzb.id)).toMatchObject({
      status: 'pending',
      postedAt: null,
      errorCode: null,
      error: null
    });
  });

  it('rejects NZB retry unless the NZB is failed and files are postable', async () => {
    const file = createFile('https://example.test/retry-nzb-invalid-file');
    db.prepare("UPDATE file SET status = 'completed', downloadedAt = ? WHERE id = ?").run(
      '2026-05-06T00:00:00.000Z',
      file.id
    );
    const pendingNzb = insertNzb(db, { releaseName: 'Pending.Nzb', fileIds: [file.id] });
    const pendingResponse = await app.request(`/v1/nzb/${pendingNzb.id}/retry`, {
      method: 'POST',
      headers: { authorization: 'Bearer secret' }
    });
    expect(pendingResponse.status).toBe(409);
    expect(await pendingResponse.json()).toMatchObject({ code: 'nzb_not_failed' });

    const deletedFile = createFile('https://example.test/retry-nzb-deleted-file');
    db.prepare("UPDATE file SET status = 'completed', downloadedAt = ? WHERE id = ?").run(
      '2026-05-06T00:00:00.000Z',
      deletedFile.id
    );
    const failedNzb = insertNzb(db, { releaseName: 'Deleted.File.Nzb', fileIds: [deletedFile.id] });
    db.prepare('UPDATE file SET deleted = 1 WHERE id = ?').run(deletedFile.id);
    db.prepare("UPDATE nzb SET status = 'failed', errorCode = 'unknown', error = 'failed' WHERE id = ?").run(failedNzb.id);

    const deletedFileResponse = await app.request(`/v1/nzb/${failedNzb.id}/retry`, {
      method: 'POST',
      headers: { authorization: 'Bearer secret' }
    });
    expect(deletedFileResponse.status).toBe(409);
    expect(await deletedFileResponse.json()).toMatchObject({ code: 'file_deleted' });
  });

  it('streams a ZIP archive for completed NZB artifacts', async () => {
    const file = createFile('https://example.test/archive-nzb-file');
    db.prepare("UPDATE file SET status = 'completed', downloadedAt = ? WHERE id = ?").run(
      '2026-05-06T00:00:00.000Z',
      file.id
    );
    const nzb = insertNzb(db, { releaseName: 'Archive.Nzb', fileIds: [file.id] });
    db.prepare("UPDATE nzb SET status = 'completed', postedAt = ? WHERE id = ?").run('2026-05-06T01:00:00.000Z', nzb.id);
    await writeNzbArtifact(nzb, '<nzb />');

    const response = await app.request('/v1/nzb/archive', {
      method: 'POST',
      headers: {
        authorization: 'Bearer secret',
        'content-type': 'application/json'
      },
      body: JSON.stringify({ nzbIds: [nzb.id] })
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/zip');
    expect(Buffer.from(await response.arrayBuffer()).subarray(0, 4).toString('hex')).toBe('504b0304');
  });

  it('rejects NZB archives with empty or not-ready NZB IDs', async () => {
    const empty = await app.request('/v1/nzb/archive', {
      method: 'POST',
      headers: {
        authorization: 'Bearer secret',
        'content-type': 'application/json'
      },
      body: JSON.stringify({ nzbIds: [] })
    });
    expect(empty.status).toBe(400);
    expect(await empty.json()).toMatchObject({ code: 'empty_list' });

    const file = createFile('https://example.test/archive-pending-nzb-file');
    db.prepare("UPDATE file SET status = 'completed', downloadedAt = ? WHERE id = ?").run(
      '2026-05-06T00:00:00.000Z',
      file.id
    );
    const nzb = insertNzb(db, { releaseName: 'Pending.Archive.Nzb', fileIds: [file.id] });
    const notReady = await app.request('/v1/nzb/archive', {
      method: 'POST',
      headers: {
        authorization: 'Bearer secret',
        'content-type': 'application/json'
      },
      body: JSON.stringify({ nzbIds: [nzb.id] })
    });
    expect(notReady.status).toBe(409);
    expect(await notReady.json()).toMatchObject({ code: 'not_ready' });
  });
});

function postDownload(body: Record<string, unknown>) {
  return app.request('/v1/downloads', {
    method: 'POST',
    headers: {
      authorization: 'Bearer secret',
      'content-type': 'application/json'
    },
    body: JSON.stringify(body)
  });
}

function createFile(url: string) {
  return insertFile(db, {
    url,
    title: 'Title',
    filename: 'Title.svtplay.mkv',
    service: 'svtplay',
    quality: '1080',
    season: null,
    episode: null
  });
}

async function writeFileArtifact(file: { id: string; filename: string }, content: string) {
  const filePath = path.join(config.downloadsDir, file.id, file.filename);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content);
}

async function writeNzbArtifact(nzb: { nzbFile: string }, content: string) {
  const filePath = path.join(config.nzbDir, nzb.nzbFile);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content);
}

function createWatchlistSource(url = 'https://example.test/source') {
  return insertWatchlistSource(db, {
    service: 'svtplay',
    type: 'series',
    url,
    backfill: true
  });
}

function linkWatchlistFile(sourceId: string, fileId: string, url: string) {
  const { row } = upsertWatchlistEpisode(db, {
    sourceId,
    url,
    season: 1,
    episode: 1,
    title: 'Episode 1',
    quality: '1080',
    status: 'download_queued'
  });
  db.prepare('UPDATE watchlist_episode SET fileId = ? WHERE id = ?').run(fileId, row.id);
}

function linkWatchlistNzb(sourceId: string, fileId: string, nzbId: string, url: string) {
  const { row } = upsertWatchlistEpisode(db, {
    sourceId,
    url,
    season: 1,
    episode: 1,
    title: 'Episode 1',
    quality: '1080',
    status: 'nzb_queued'
  });
  db.prepare('UPDATE watchlist_episode SET fileId = ?, nzbId = ? WHERE id = ?').run(fileId, nzbId, row.id);
}
