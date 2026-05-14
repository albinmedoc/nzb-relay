import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Config } from '../src/config.js';
import type { AppDatabase } from '../src/db/client.js';
import {
  claimFile,
  enqueueIndexerUploads,
  getFile,
  insertFile,
  insertNzb,
  listIndexerUploadsForNzb,
  recoverFileInterrupted,
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
