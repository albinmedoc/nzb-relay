import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Config } from '../src/config.js';
import type { AppDatabase } from '../src/db/client.js';
import {
  claimFile,
  getFile,
  getNzb,
  insertFile,
  insertNzb,
  transitionFileCompleted,
  transitionFileFailed
} from '../src/db/repository.js';
import {
  getWatchlistSource,
  insertWatchlistSource,
  listWatchlistEpisodesForSource,
  upsertWatchlistEpisode
} from '../src/db/watchlist-repository.js';
import type { WatchlistSourceRow } from '../src/types.js';
import { fileMediaPath } from '../src/utils/paths.js';
import { WatchlistWorker } from '../src/workers/watchlist-worker.js';
import type { WatchProvider, WatchProviderDiscovery } from '../src/watchlist/providers.js';
import { resolveWatchProvider } from '../src/watchlist/providers.js';
import { cleanup, createTempDataDir, createTestApp, createTestDb, testConfig } from './helpers.js';

let dataDir: string;
let config: Config;
let db: AppDatabase;

beforeEach(async () => {
  dataDir = await createTempDataDir();
  config = testConfig(dataDir, {
    API_KEY: 'secret',
    WATCHLIST_POLL_INTERVAL_SECONDS: '60',
    WATCHLIST_RECONCILE_INTERVAL_SECONDS: '1'
  });
  db = createTestDb(config);
});

afterEach(async () => {
  await cleanup(dataDir, db);
});

describe('watchlist API', () => {
  it('creates, lists, returns, and deletes watchlist sources', async () => {
    const provider = fakeProvider({
      service: 'tv4play',
      type: 'series',
      url: 'https://example.test/show',
      title: 'Show',
      episodes: []
    });
    const app = createTestApp(db, config, undefined, undefined, [provider]);

    const created = await app.request('/v1/watchlist', {
      method: 'POST',
      headers: {
        authorization: 'Bearer secret',
        'content-type': 'application/json'
      },
      body: JSON.stringify({ url: 'https://example.test/show' })
    });
    expect(created.status).toBe(201);
    const source = (await created.json()) as { id: string };
    expect(source).toMatchObject({
      service: 'tv4play',
      type: 'series',
      url: 'https://example.test/show',
      backfill: true
    });

    const duplicate = await app.request('/v1/watchlist', {
      method: 'POST',
      headers: {
        authorization: 'Bearer secret',
        'content-type': 'application/json'
      },
      body: JSON.stringify({ url: 'https://example.test/show' })
    });
    expect(duplicate.status).toBe(409);
    expect(await duplicate.json()).toMatchObject({ code: 'duplicate_watch_url' });

    const list = await app.request('/v1/watchlist', {
      headers: { authorization: 'Bearer secret' }
    });
    expect(await list.json()).toMatchObject({
      total: 1,
      items: [{ id: source.id, episodeCount: 0 }]
    });

    const detail = await app.request(`/v1/watchlist/${source.id}`, {
      headers: { authorization: 'Bearer secret' }
    });
    expect(await detail.json()).toMatchObject({
      id: source.id,
      episodes: []
    });

    const deleted = await app.request(`/v1/watchlist/${source.id}`, {
      method: 'DELETE',
      headers: { authorization: 'Bearer secret' }
    });
    expect(deleted.status).toBe(204);
    expect(getWatchlistSource(db, source.id)).toBeNull();
  });

  it('rejects unsupported watch URLs and invalid backfill values', async () => {
    const app = createTestApp(db, config);

    const unsupported = await app.request('/v1/watchlist', {
      method: 'POST',
      headers: {
        authorization: 'Bearer secret',
        'content-type': 'application/json'
      },
      body: JSON.stringify({ url: 'https://example.test/show' })
    });
    expect(unsupported.status).toBe(400);
    expect(await unsupported.json()).toMatchObject({ code: 'unsupported_watch_url' });

    const invalidBackfill = await app.request('/v1/watchlist', {
      method: 'POST',
      headers: {
        authorization: 'Bearer secret',
        'content-type': 'application/json'
      },
      body: JSON.stringify({ url: 'https://www.svtplay.se/test-serie', backfill: 'yes' })
    });
    expect(invalidBackfill.status).toBe(400);
    expect(await invalidBackfill.json()).toMatchObject({ code: 'invalid_backfill' });
  });
});

describe('watchlist provider resolution', () => {
  it('normalizes SVT Play series URLs and rejects episode URLs', () => {
    expect(resolveWatchProvider('https://www.svtplay.se/test-serie?foo=bar')?.normalizedUrl).toBe(
      'https://www.svtplay.se/test-serie'
    );
    expect(resolveWatchProvider('https://www.svtplay.se/video/abc/test-serie')).toBeNull();
  });
});

describe('watchlist database', () => {
  it('keeps episode metadata lean and source-referenced', () => {
    const source = insertSource(true);
    const first = upsertWatchlistEpisode(db, episodeInput(source.id, 'https://example.test/e1', '1080', 'discovered'));
    const second = upsertWatchlistEpisode(db, episodeInput(source.id, 'https://example.test/e1', '720', 'discovered'));

    expect(first.inserted).toBe(true);
    expect(second.inserted).toBe(false);
    expect(listWatchlistEpisodesForSource(db, source.id)).toMatchObject([
      {
        sourceId: source.id,
        url: 'https://example.test/e1',
        quality: '720'
      }
    ]);

    const columns = db.prepare('PRAGMA table_info(watchlist_episode)').all() as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).not.toContain('description');
  });
});

describe('watchlist worker', () => {
  it('queues discovered backfill downloads using source and episode metadata', async () => {
    const source = insertSource(true);
    const worker = workerWith(discovery());

    await scanAndReconcile(worker, source);

    const [episode] = listWatchlistEpisodesForSource(db, source.id);
    expect(episode).toMatchObject({
      status: 'download_queued',
      season: 1,
      episode: 2,
      quality: '1080',
      downloadAttempts: 1
    });
    const file = getFile(db, episode!.fileId!)!;
    expect(file).toMatchObject({
      title: 'Series Title',
      service: 'svtplay',
      season: 1,
      episode: 2,
      quality: '1080',
      filename: 'Series.Title.s01e02.svtplay.mkv'
    });
  });

  it('records first-scan episodes without queueing when backfill is disabled', async () => {
    const source = insertSource(false);
    const worker = workerWith(discovery());

    await scanAndReconcile(worker, source);

    expect(listWatchlistEpisodesForSource(db, source.id)).toMatchObject([
      {
        status: 'seen',
        fileId: null,
        downloadAttempts: 0
      }
    ]);
  });

  it('links an existing active file instead of creating a duplicate', async () => {
    const source = insertSource(true);
    const existing = insertFile(db, {
      url: 'https://example.test/e1',
      title: 'Manual',
      filename: 'Manual.s01e02.svtplay.mkv',
      service: 'svtplay',
      quality: '720',
      season: 1,
      episode: 2
    });
    const worker = workerWith(discovery());

    await scanAndReconcile(worker, source);

    const [episode] = listWatchlistEpisodesForSource(db, source.id);
    expect(episode).toMatchObject({
      status: 'download_queued',
      fileId: existing.id,
      downloadAttempts: 0
    });
    expect((db.prepare('SELECT COUNT(*) AS count FROM file').get() as { count: number }).count).toBe(1);
  });

  it('queues one NZB for a completed watched download when auto NZB is enabled', async () => {
    const source = insertSource(true);
    const worker = workerWith(discovery());
    await scanAndReconcile(worker, source);
    const [queued] = listWatchlistEpisodesForSource(db, source.id);
    const file = getFile(db, queued!.fileId!)!;

    expect(claimFile(db, file.id)).toBe(true);
    expect(transitionFileCompleted(db, config, getFile(db, file.id)!)).toBe(true);
    await writeMediaFile(file);

    await reconcile(worker);

    const [episode] = listWatchlistEpisodesForSource(db, source.id);
    expect(episode).toMatchObject({
      status: 'nzb_queued',
      nzbAttempts: 1
    });
    expect((db.prepare('SELECT COUNT(*) AS count FROM nzb').get() as { count: number }).count).toBe(1);
  });

  it('retries failed watched downloads with a new file row and deletes old failed attempts after success', async () => {
    const source = insertSource(true);
    const worker = workerWith(discovery());
    await scanAndReconcile(worker, source);
    const [firstQueued] = listWatchlistEpisodesForSource(db, source.id);
    const firstFile = getFile(db, firstQueued!.fileId!)!;

    expect(claimFile(db, firstFile.id)).toBe(true);
    expect(transitionFileFailed(db, config, getFile(db, firstFile.id)!, 'child_exit_nonzero', 'failed')).toBe(true);

    await reconcile(worker);

    const [retryQueued] = listWatchlistEpisodesForSource(db, source.id);
    expect(retryQueued).toMatchObject({
      status: 'download_queued',
      downloadAttempts: 2
    });
    expect(retryQueued!.fileId).not.toBe(firstFile.id);
    expect(getFile(db, firstFile.id)).toMatchObject({ status: 'failed' });

    const retryFile = getFile(db, retryQueued!.fileId!)!;
    expect(claimFile(db, retryFile.id)).toBe(true);
    expect(transitionFileCompleted(db, config, getFile(db, retryFile.id)!)).toBe(true);
    await writeMediaFile(retryFile);

    await reconcile(worker);

    expect(getFile(db, firstFile.id)).toBeNull();
    expect(getFile(db, retryFile.id)).toMatchObject({ status: 'completed' });
  });

  it('moves missing-media NZB failures back to download retry state', async () => {
    const source = insertSource(true);
    const worker = workerWith(discovery());
    await scanAndReconcile(worker, source);
    const [queued] = listWatchlistEpisodesForSource(db, source.id);
    const file = getFile(db, queued!.fileId!)!;

    expect(claimFile(db, file.id)).toBe(true);
    expect(transitionFileCompleted(db, config, getFile(db, file.id)!)).toBe(true);
    const nzb = insertNzb(db, {
      releaseName: 'Series.Title.s01e02.svtplay.mkv',
      fileIds: [file.id]
    });
    db.prepare("UPDATE nzb SET status = 'failed', errorCode = 'unknown', error = ? WHERE id = ?").run(
      `ENOENT: no such file or directory, stat '${fileMediaPath(config, file)}'`,
      nzb.id
    );
    db.prepare("UPDATE watchlist_episode SET status = 'nzb_queued', nzbId = ? WHERE id = ?").run(nzb.id, queued!.id);

    await reconcile(worker);

    const [needsRetry] = listWatchlistEpisodesForSource(db, source.id);
    expect(needsRetry).toMatchObject({
      status: 'download_failed',
      fileId: null,
      nzbId: null,
      lastErrorCode: 'file_media_missing'
    });
    expect(getFile(db, file.id)).toBeNull();
    expect(getNzb(db, nzb.id)).toBeNull();
  });

  it('links an existing active NZB instead of creating a duplicate', async () => {
    const source = insertSource(true);
    const worker = workerWith(discovery());
    await scanAndReconcile(worker, source);
    const [queued] = listWatchlistEpisodesForSource(db, source.id);
    const file = getFile(db, queued!.fileId!)!;
    await writeMediaFile(file);
    db.prepare("UPDATE file SET status = 'completed', downloadedAt = ? WHERE id = ?").run(
      '2026-05-06T00:00:00.000Z',
      file.id
    );
    db.prepare("UPDATE watchlist_episode SET status = 'download_completed', downloadedAt = ?, fileId = ? WHERE id = ?").run(
      '2026-05-06T00:00:00.000Z',
      file.id,
      queued!.id
    );
    const activeNzb = insertNzb(db, {
      releaseName: 'Series.Title.s01e02.svtplay.mkv',
      fileIds: [file.id]
    });

    await reconcile(worker);

    const [episode] = listWatchlistEpisodesForSource(db, source.id);
    expect(episode).toMatchObject({
      status: 'nzb_queued',
      nzbId: activeNzb.id,
      nzbAttempts: 0
    });
    expect((db.prepare('SELECT COUNT(*) AS count FROM nzb').get() as { count: number }).count).toBe(1);
  });

  it('deletes older failed NZB attempts after a later post succeeds', async () => {
    const source = insertSource(true);
    const worker = workerWith(discovery());
    await scanAndReconcile(worker, source);
    const [queued] = listWatchlistEpisodesForSource(db, source.id);
    const file = getFile(db, queued!.fileId!)!;
    db.prepare("UPDATE file SET status = 'completed', downloadedAt = ? WHERE id = ?").run(
      '2026-05-06T00:00:00.000Z',
      file.id
    );
    const failedNzb = insertNzb(db, {
      releaseName: 'Series.Title.s01e02.svtplay.mkv',
      fileIds: [file.id]
    });
    db.prepare("UPDATE nzb SET status = 'failed', errorCode = 'child_exit_nonzero', error = 'failed' WHERE id = ?").run(
      failedNzb.id
    );
    const postedNzb = insertNzb(db, {
      releaseName: 'Series.Title.s01e02.svtplay.mkv',
      fileIds: [file.id]
    });
    db.prepare("UPDATE nzb SET status = 'completed', postedAt = ? WHERE id = ?").run(
      '2026-05-06T00:01:00.000Z',
      postedNzb.id
    );
    db.prepare("UPDATE watchlist_episode SET status = 'nzb_queued', fileId = ?, nzbId = ? WHERE id = ?").run(
      file.id,
      postedNzb.id,
      queued!.id
    );

    await reconcile(worker);

    expect(getNzb(db, failedNzb.id)).toBeNull();
    expect(getNzb(db, postedNzb.id)).toMatchObject({ status: 'completed' });
    expect(listWatchlistEpisodesForSource(db, source.id)).toMatchObject([{ status: 'posted' }]);
  });

  it('does not queue NZBs when auto NZB is disabled', async () => {
    config = testConfig(dataDir, {
      WATCHLIST_AUTO_NZB: 'false'
    });
    db.close();
    db = createTestDb(config);
    const source = insertSource(true);
    const worker = workerWith(discovery());
    await scanAndReconcile(worker, source);
    const [queued] = listWatchlistEpisodesForSource(db, source.id);
    const file = getFile(db, queued!.fileId!)!;

    expect(claimFile(db, file.id)).toBe(true);
    expect(transitionFileCompleted(db, config, getFile(db, file.id)!)).toBe(true);

    await reconcile(worker);

    expect(listWatchlistEpisodesForSource(db, source.id)).toMatchObject([
      {
        status: 'download_completed',
        nzbId: null
      }
    ]);
    expect((db.prepare('SELECT COUNT(*) AS count FROM nzb').get() as { count: number }).count).toBe(0);
  });

  it('blocks failed downloads after the configured attempt budget', async () => {
    config = testConfig(dataDir, {
      WATCHLIST_MAX_ATTEMPTS: '1'
    });
    db.close();
    db = createTestDb(config);
    const source = insertSource(true);
    const worker = workerWith(discovery());
    await scanAndReconcile(worker, source);
    const [queued] = listWatchlistEpisodesForSource(db, source.id);
    db.prepare("UPDATE file SET status = 'failed', errorCode = 'child_exit_nonzero', error = 'failed' WHERE id = ?").run(
      queued!.fileId
    );

    await reconcile(worker);

    expect(listWatchlistEpisodesForSource(db, source.id)).toMatchObject([
      {
        status: 'blocked',
        lastErrorCode: 'child_exit_nonzero',
        downloadAttempts: 1
      }
    ]);
  });
});

function insertSource(backfill: boolean) {
  return insertWatchlistSource(db, {
    service: 'svtplay',
    type: 'series',
    url: 'https://example.test/source',
    backfill
  });
}

function episodeInput(
  sourceId: string,
  url: string,
  quality: string,
  status: 'seen' | 'discovered'
) {
  return {
    sourceId,
    url,
    season: 1,
    episode: 2,
    title: 'Episode 2',
    quality,
    status
  };
}

function discovery(): WatchProviderDiscovery {
  return {
    service: 'svtplay',
    type: 'series',
    url: 'https://example.test/source',
    title: 'Series Title',
    episodes: [
      {
        url: 'https://example.test/e1',
        season: 1,
        episode: 2,
        title: 'Episode 2',
        quality: '1080'
      }
    ]
  };
}

function fakeProvider(result: WatchProviderDiscovery): WatchProvider {
  return {
    service: result.service,
    type: result.type,
    supports: (url) => url.hostname === new URL(result.url).hostname,
    normalize: () => result.url,
    discover: async () => result
  };
}

function workerWith(result: WatchProviderDiscovery): WatchlistWorker {
  return new WatchlistWorker(db, config, { info() {}, warn() {}, error() {} } as never, [fakeProvider(result)]);
}

async function scanAndReconcile(worker: WatchlistWorker, source: WatchlistSourceRow): Promise<void> {
  await scan(worker, source);
  await reconcile(worker);
}

async function scan(worker: WatchlistWorker, source: WatchlistSourceRow): Promise<void> {
  await (worker as unknown as { scanSource(source: WatchlistSourceRow): Promise<void> }).scanSource(source);
}

async function reconcile(worker: WatchlistWorker): Promise<void> {
  await (worker as unknown as { reconcileAndQueueEpisodes(): Promise<void> }).reconcileAndQueueEpisodes();
}

async function writeMediaFile(file: { id: string; filename: string }): Promise<void> {
  const mediaPath = path.join(config.downloadsDir, file.id, file.filename);
  await fs.mkdir(path.dirname(mediaPath), { recursive: true });
  await fs.writeFile(mediaPath, 'media');
}
