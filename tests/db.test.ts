import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Config } from '../src/config.js';
import type { AppDatabase } from '../src/db/client.js';
import {
  claimFile,
  enqueueIndexerUploads,
  enqueueSabnzbdPush,
  getFile,
  getSabnzbdPushForNzb,
  insertFile,
  insertNzb,
  listIndexerUploadsForNzb,
  nextDueSabnzbdPush,
  recoverFileInterrupted,
  retryFailedSabnzbdPush,
  transitionFileCompleted,
  transitionFileFailed
} from '../src/db/repository.js';
import { cleanup, createTempDataDir, createTestDb, testConfig } from './helpers.js';

let dataDir: string;
let config: Config;
let db: AppDatabase;

beforeEach(async () => {
  dataDir = await createTempDataDir();
  config = testConfig(dataDir, {
    WEBHOOK_URL: 'https://example.test/webhook'
  });
  db = createTestDb(config);
});

afterEach(async () => {
  await cleanup(dataDir, db);
});

describe('database invariants', () => {
  it('enforces active download URL uniqueness while allowing failed retries', () => {
    insertFile(db, fileInput('https://example.test/a'));

    expect(() => insertFile(db, fileInput('https://example.test/a'))).toThrow();

    const failed = insertFile(db, fileInput('https://example.test/b'));
    expect(claimFile(db, failed.id)).toBe(true);
    transitionFileFailed(db, config, getFile(db, failed.id)!, 'child_exit_nonzero', 'failed');

    expect(() => insertFile(db, fileInput('https://example.test/b'))).not.toThrow();
  });

  it('commits completed file state and webhook delivery together', () => {
    const row = insertFile(db, fileInput('https://example.test/c'));
    expect(claimFile(db, row.id)).toBe(true);

    expect(transitionFileCompleted(db, config, getFile(db, row.id)!)).toBe(true);

    const file = getFile(db, row.id)!;
    const delivery = db.prepare('SELECT event, payload FROM webhook_deliveries').get() as { event: string; payload: string };
    expect(file.status).toBe('completed');
    expect(delivery.event).toBe('download.completed');
    expect(JSON.parse(delivery.payload).data.fileId).toBe(row.id);
  });

  it('rejects NZB creation for files that are not completed', () => {
    const row = insertFile(db, fileInput('https://example.test/pending-nzb'));

    expect(() => insertNzb(db, { releaseName: 'Title.s01e01.svtplay.mkv', fileIds: [row.id] })).toThrow(
      `file not completed: ${row.id} (pending)`
    );
    expect((db.prepare('SELECT COUNT(*) AS count FROM nzb').get() as { count: number }).count).toBe(0);
  });

  it('queues indexer uploads idempotently and removes them with the NZB', () => {
    config = testConfig(dataDir, {
      INDEXER_UPLOADS_JSON: JSON.stringify([{ name: 'drunkenslug', url: 'https://nzbs.drunkenslug.com/upload.php' }])
    });
    db.close();
    db = createTestDb(config);
    const file = insertFile(db, fileInput('https://example.test/indexer-upload'));
    db.prepare("UPDATE file SET status = 'completed', downloadedAt = ? WHERE id = ?").run(
      '2026-05-05T00:00:00.000Z',
      file.id
    );
    const nzb = insertNzb(db, { releaseName: 'Title.s01e01.svtplay', fileIds: [file.id] });

    expect(enqueueIndexerUploads(db, config, nzb)).toBe(1);
    expect(enqueueIndexerUploads(db, config, nzb)).toBe(0);
    expect(listIndexerUploadsForNzb(db, nzb.id)).toHaveLength(1);

    db.prepare('DELETE FROM nzb WHERE id = ?').run(nzb.id);

    expect(listIndexerUploadsForNzb(db, nzb.id)).toEqual([]);
  });

  it('queues SABnzbd pushes idempotently with fallback category', () => {
    config = testConfig(dataDir, {
      SABNZBD_URL: 'http://sabnzbd:8080/api',
      SABNZBD_CATEGORY: 'manual'
    });
    db.close();
    db = createTestDb(config);
    const file = insertFile(db, fileInput('https://example.test/sab-push'));
    db.prepare("UPDATE file SET status = 'completed', downloadedAt = ? WHERE id = ?").run(
      '2026-05-05T00:00:00.000Z',
      file.id
    );
    const nzb = insertNzb(db, { releaseName: 'Title.s01e01.svtplay', fileIds: [file.id] });

    expect(enqueueSabnzbdPush(db, config, nzb)).toBe(true);
    expect(enqueueSabnzbdPush(db, config, nzb)).toBe(false);
    expect(getSabnzbdPushForNzb(db, nzb.id)).toMatchObject({
      url: 'http://sabnzbd:8080/api',
      category: 'manual',
      status: 'pending'
    });
    expect(nextDueSabnzbdPush(db)).toMatchObject({ nzbId: nzb.id });

    db.prepare('DELETE FROM nzb WHERE id = ?').run(nzb.id);

    expect(getSabnzbdPushForNzb(db, nzb.id)).toBeNull();
  });

  it('resolves SABnzbd push categories for movies and watchlist series', () => {
    config = testConfig(dataDir, {
      SABNZBD_URL: 'http://sabnzbd:8080/api',
      SABNZBD_MOVIE_CATEGORY: 'films',
      SABNZBD_SERIES_CATEGORY: 'shows'
    });
    db.close();
    db = createTestDb(config);

    const movieNzb = completedNzb('https://example.test/movie', 'Movie.Title');
    db.prepare(
      `
        INSERT INTO movie_job (
          id, url, title, service, quality, status, fileId, nzbId,
          downloadAttempts, nzbAttempts, downloadQueuedAt, downloadedAt, nzbQueuedAt, postedAt,
          lastErrorCode, lastError, createdAt, updatedAt
        )
        VALUES ('movie-1', 'https://example.test/movie', 'Movie', 'svtplay', '1080', 'nzb_queued', NULL, ?,
          0, 0, NULL, NULL, NULL, NULL, NULL, NULL, '2026-05-05T00:00:00.000Z', '2026-05-05T00:00:00.000Z')
      `
    ).run(movieNzb.id);

    const seriesNzb = completedNzb('https://example.test/series', 'Series.Title');
    db.prepare(
      `
        INSERT INTO watchlist_source (
          id, service, type, url, title, enabled, backfill, deleteFileAfterNzb,
          firstScanCompleted, lastScannedAt, nextScanAt, lastErrorCode, lastError, createdAt, updatedAt
        )
        VALUES ('source-1', 'svtplay', 'series', 'https://example.test/source', 'Series', 1, 1, 1,
          0, NULL, NULL, NULL, NULL, '2026-05-05T00:00:00.000Z', '2026-05-05T00:00:00.000Z')
      `
    ).run();
    db.prepare(
      `
        INSERT INTO watchlist_episode (
          id, sourceId, url, season, episode, title, quality, status, fileId, nzbId,
          downloadAttempts, nzbAttempts, downloadQueuedAt, downloadedAt, nzbQueuedAt, postedAt,
          lastErrorCode, lastError, createdAt, updatedAt
        )
        VALUES ('episode-1', 'source-1', 'https://example.test/series', 1, 1, 'Episode', '1080', 'nzb_queued', NULL, ?,
          0, 0, NULL, NULL, NULL, NULL, NULL, NULL, '2026-05-05T00:00:00.000Z', '2026-05-05T00:00:00.000Z')
      `
    ).run(seriesNzb.id);

    enqueueSabnzbdPush(db, config, movieNzb);
    enqueueSabnzbdPush(db, config, seriesNzb);

    expect(getSabnzbdPushForNzb(db, movieNzb.id)?.category).toBe('films');
    expect(getSabnzbdPushForNzb(db, seriesNzb.id)?.category).toBe('shows');
  });

  it('retries failed SABnzbd pushes by resetting the same row', () => {
    config = testConfig(dataDir, {
      SABNZBD_URL: 'http://sabnzbd:8080/api'
    });
    db.close();
    db = createTestDb(config);
    const nzb = completedNzb('https://example.test/sab-retry', 'Retry.Title');
    enqueueSabnzbdPush(db, config, nzb);
    db.prepare(
      "UPDATE sabnzbd_push SET status = 'failed', attempts = 2, lastError = 'down', remoteIds = ?, pushedAt = ? WHERE nzbId = ?"
    ).run('["old"]', '2026-05-05T01:00:00.000Z', nzb.id);

    expect(retryFailedSabnzbdPush(db, nzb.id, '2026-05-05T02:00:00.000Z')).toBe(true);

    expect(getSabnzbdPushForNzb(db, nzb.id)).toMatchObject({
      status: 'pending',
      attempts: 0,
      nextAttemptAt: '2026-05-05T02:00:00.000Z',
      lastError: null,
      remoteIds: null,
      pushedAt: null
    });
  });

  it('recovers deleted running files without enqueueing a webhook', () => {
    const row = insertFile(db, fileInput('https://example.test/deleted-running'));
    expect(claimFile(db, row.id)).toBe(true);
    db.prepare('UPDATE file SET deleted = 1 WHERE id = ?').run(row.id);

    expect(recoverFileInterrupted(db, config, getFile(db, row.id)!)).toBe(true);

    expect(getFile(db, row.id)).toMatchObject({
      status: 'failed',
      deleted: 1,
      errorCode: 'interrupted_by_restart'
    });
    expect((db.prepare('SELECT COUNT(*) AS count FROM webhook_deliveries').get() as { count: number }).count).toBe(0);
  });
});

function completedNzb(url: string, releaseName: string) {
  const file = insertFile(db, fileInput(url));
  db.prepare("UPDATE file SET status = 'completed', downloadedAt = ? WHERE id = ?").run(
    '2026-05-05T00:00:00.000Z',
    file.id
  );
  const nzb = insertNzb(db, { releaseName, fileIds: [file.id] });
  db.prepare("UPDATE nzb SET status = 'completed', postedAt = ? WHERE id = ?").run('2026-05-05T00:10:00.000Z', nzb.id);
  return db.prepare('SELECT * FROM nzb WHERE id = ?').get(nzb.id) as typeof nzb;
}

function fileInput(url: string) {
  return {
    url,
    title: 'Title',
    filename: 'Title.s01e01.svtplay.mkv',
    service: 'svtplay',
    quality: '1080',
    season: 1,
    episode: 1
  };
}
