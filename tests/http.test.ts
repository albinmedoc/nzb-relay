import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Config } from '../src/config.js';
import type { AppDatabase } from '../src/db/client.js';
import { getFile, getNzb, insertFile, insertNzb } from '../src/db/repository.js';
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
      items: [{ id: completed.id, status: 'completed' }]
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
    expect(await metadata.json()).toMatchObject({ id: row.id, deleted: true });
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
