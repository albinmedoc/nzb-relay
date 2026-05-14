import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FormData } from 'undici';
import pino from 'pino';
import type { Config } from '../src/config.js';
import type { AppDatabase } from '../src/db/client.js';
import {
  enqueueIndexerUploads,
  insertFile,
  insertNzb,
  listIndexerUploadsForNzb
} from '../src/db/repository.js';
import {
  buildIndexerUploadRequest,
  IndexerUploadWorker,
  type IndexerUploadFetch
} from '../src/workers/indexer-upload-worker.js';
import { nzbFinalPath } from '../src/utils/paths.js';
import { cleanup, createTempDataDir, createTestDb, testConfig } from './helpers.js';

let dataDir: string;
let config: Config;
let db: AppDatabase;

beforeEach(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-05-05T12:00:00.000Z'));
  dataDir = await createTempDataDir();
});

afterEach(async () => {
  vi.useRealTimers();
  await cleanup(dataDir, db);
});

describe('indexer upload worker', () => {
  it('uploads DrunkenSlug-style multipart requests using files[]', async () => {
    config = testConfig(dataDir, {
      INDEXER_UPLOADS_JSON: JSON.stringify([
        {
          name: 'drunkenslug',
          url: 'https://nzbs.drunkenslug.com/upload.php',
          fileField: 'files[]',
          fields: {
            name: '{releaseName}'
          }
        }
      ])
    });
    db = createTestDb(config);
    const nzb = await createCompletedNzb('Release.One');
    enqueueIndexerUploads(db, config, nzb);

    const requests: Array<{ url: string; init: Parameters<IndexerUploadFetch>[1] }> = [];
    const fetcher = vi.fn<IndexerUploadFetch>(async (url, init) => {
      requests.push({ url, init });
      return { status: 200 };
    });
    const worker = new IndexerUploadWorker(db, config, pino({ enabled: false }), fetcher);
    worker.start();
    await vi.advanceTimersByTimeAsync(100);
    await worker.stop();

    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe('https://nzbs.drunkenslug.com/upload.php');
    expect(requests[0]?.init.method).toBe('POST');
    const form = requests[0]!.init.body as FormData;
    const file = form.get('files[]') as { name: string; type: string } | null;
    expect(file).toMatchObject({ name: 'Release.One.nzb', type: 'application/x-nzb' });
    expect(form.get('name')).toBe('Release.One');
    expect(listIndexerUploadsForNzb(db, nzb.id)[0]).toMatchObject({
      status: 'completed',
      attempts: 0
    });
    expect(listIndexerUploadsForNzb(db, nzb.id)[0]?.uploadedAt).toBeTruthy();
  });

  it('builds raw NZB upload requests', async () => {
    config = testConfig(dataDir, {
      INDEXER_UPLOADS_JSON: JSON.stringify([
        {
          name: 'raw',
          url: 'https://indexer.example/upload',
          format: 'raw',
          headers: {
            'x-release': '{releaseName}'
          }
        }
      ])
    });
    db = createTestDb(config);
    const nzb = await createCompletedNzb('Raw.Release');

    const request = await buildIndexerUploadRequest(config, config.indexerUploads[0]!, nzb);

    expect(request).toMatchObject({
      method: 'POST',
      headers: {
        'content-type': 'application/x-nzb',
        'content-disposition': 'attachment; filename="Raw.Release.nzb"',
        'x-release': 'Raw.Release'
      }
    });
    expect(Buffer.isBuffer(request.body)).toBe(true);
    expect((request.body as Buffer).toString('utf8')).toBe('<nzb />');
  });

  it('permanently fails after the retry budget is exhausted', async () => {
    config = testConfig(dataDir, {
      INDEXER_UPLOADS_JSON: JSON.stringify([
        {
          name: 'down',
          url: 'https://indexer.example/upload'
        }
      ])
    });
    db = createTestDb(config);
    const nzb = await createCompletedNzb('Retry.Release');
    enqueueIndexerUploads(db, config, nzb);
    db.prepare('UPDATE indexer_upload SET attempts = 5, nextAttemptAt = ? WHERE nzbId = ?').run(
      '2026-05-05T12:00:00.000Z',
      nzb.id
    );

    const fetcher = vi.fn<IndexerUploadFetch>(async () => ({ status: 500 }));
    const worker = new IndexerUploadWorker(db, config, pino({ enabled: false }), fetcher);
    worker.start();

    await vi.advanceTimersByTimeAsync(100);
    await worker.stop();

    expect(listIndexerUploadsForNzb(db, nzb.id)[0]).toMatchObject({
      status: 'failed',
      attempts: 6,
      nextAttemptAt: null,
      lastError: 'HTTP 500'
    });
  });
});

async function createCompletedNzb(releaseName: string) {
  const file = insertFile(db, {
    url: `https://example.test/${releaseName}`,
    title: releaseName,
    filename: `${releaseName}.mkv`,
    service: 'svtplay',
    quality: '1080',
    season: null,
    episode: null
  });
  db.prepare("UPDATE file SET status = 'completed', downloadedAt = ? WHERE id = ?").run(
    '2026-05-05T11:00:00.000Z',
    file.id
  );
  const nzb = insertNzb(db, { releaseName, fileIds: [file.id] });
  db.prepare("UPDATE nzb SET status = 'completed', postedAt = ? WHERE id = ?").run(
    '2026-05-05T12:00:00.000Z',
    nzb.id
  );
  const completed = db.prepare('SELECT * FROM nzb WHERE id = ?').get(nzb.id) as typeof nzb;
  await fs.mkdir(path.dirname(nzbFinalPath(config, completed)), { recursive: true });
  await fs.writeFile(nzbFinalPath(config, completed), '<nzb />');
  return completed;
}
