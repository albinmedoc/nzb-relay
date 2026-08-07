import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FormData } from 'undici';
import pino from 'pino';
import type { Config } from '../src/config.js';
import type { AppDatabase } from '../src/db/client.js';
import {
  enqueueSabnzbdPush,
  getSabnzbdPushForNzb,
  insertFile,
  insertNzb
} from '../src/db/repository.js';
import {
  buildSabnzbdPushRequest,
  SabnzbdPushWorker,
  type SabnzbdPushFetch
} from '../src/workers/sabnzbd-push-worker.js';
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

describe('SABnzbd push worker', () => {
  it('uploads completed NZBs with SAB addfile fields and category', async () => {
    config = testConfig(dataDir, {
      SABNZBD_URL: 'http://sabnzbd:8080/api',
      SABNZBD_API_KEY: 'secret',
      SABNZBD_CATEGORY: 'manual'
    });
    db = createTestDb(config);
    const nzb = await createCompletedNzb('Release.One');
    enqueueSabnzbdPush(db, config, nzb);

    const requests: Array<{ url: string; init: Parameters<SabnzbdPushFetch>[1] }> = [];
    const fetcher = vi.fn<SabnzbdPushFetch>(async (url, init) => {
      requests.push({ url, init });
      return {
        status: 200,
        async json() {
          return { status: true, nzo_ids: ['SABnzbd_nzo_abc'] };
        }
      };
    });
    const worker = new SabnzbdPushWorker(db, config, pino({ enabled: false }), fetcher);
    worker.start();
    await vi.advanceTimersByTimeAsync(100);
    await worker.stop();

    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe('http://sabnzbd:8080/api');
    expect(requests[0]?.init.method).toBe('POST');
    const form = requests[0]!.init.body as FormData;
    expect(form.get('mode')).toBe('addfile');
    expect(form.get('output')).toBe('json');
    expect(form.get('apikey')).toBe('secret');
    expect(form.get('cat')).toBe('manual');
    const file = form.get('nzbfile') as { name: string; type: string } | null;
    expect(file).toMatchObject({ name: 'Release.One.nzb', type: 'application/x-nzb' });
    expect(getSabnzbdPushForNzb(db, nzb.id)).toMatchObject({
      status: 'completed',
      attempts: 0,
      remoteIds: '["SABnzbd_nzo_abc"]'
    });
    expect(getSabnzbdPushForNzb(db, nzb.id)?.pushedAt).toBeTruthy();
  });

  it('builds requests without an API key when auth is not configured', async () => {
    config = testConfig(dataDir, {
      SABNZBD_URL: 'http://nzbdav:3000/api'
    });
    db = createTestDb(config);
    const nzb = await createCompletedNzb('No.Auth');
    const push = { category: 'series' };

    const request = await buildSabnzbdPushRequest(config, push, nzb);

    expect(request.method).toBe('POST');
    expect(request.body.get('apikey')).toBeNull();
    expect(request.body.get('cat')).toBe('series');
  });

  it('permanently fails after the retry budget is exhausted', async () => {
    config = testConfig(dataDir, {
      SABNZBD_URL: 'http://sabnzbd:8080/api'
    });
    db = createTestDb(config);
    const nzb = await createCompletedNzb('Retry.Release');
    enqueueSabnzbdPush(db, config, nzb);
    db.prepare('UPDATE sabnzbd_push SET attempts = 5, nextAttemptAt = ? WHERE nzbId = ?').run(
      '2026-05-05T12:00:00.000Z',
      nzb.id
    );

    const fetcher = vi.fn<SabnzbdPushFetch>(async () => ({
      status: 500,
      async json() {
        return {};
      }
    }));
    const worker = new SabnzbdPushWorker(db, config, pino({ enabled: false }), fetcher);
    worker.start();

    await vi.advanceTimersByTimeAsync(100);
    await worker.stop();

    expect(getSabnzbdPushForNzb(db, nzb.id)).toMatchObject({
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
