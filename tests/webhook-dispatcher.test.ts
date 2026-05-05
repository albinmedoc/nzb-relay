import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import pino from 'pino';
import type { Config } from '../src/config.js';
import type { AppDatabase } from '../src/db/client.js';
import { WebhookDispatcher, type WebhookFetch } from '../src/workers/webhook-dispatcher.js';
import { enqueueWebhook } from '../src/webhooks.js';
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

describe('webhook dispatcher', () => {
  it('sends signed payloads and marks delivery delivered', async () => {
    config = testConfig(dataDir, {
      WEBHOOK_URL: 'https://example.test/webhook',
      WEBHOOK_SECRET: 'secret'
    });
    db = createTestDb(config);
    enqueueWebhook(db, config, 'download.completed', { fileId: 'f1', status: 'completed' });

    const requests: Array<{ url: string; init: Parameters<WebhookFetch>[1] }> = [];
    const fetcher = vi.fn<WebhookFetch>(async (url, init) => {
      requests.push({ url, init });
      return { status: 200 };
    });
    const dispatcher = new WebhookDispatcher(db, config, pino({ enabled: false }), fetcher);
    dispatcher.start();
    await vi.advanceTimersByTimeAsync(100);
    await dispatcher.stop();

    const row = db.prepare('SELECT status FROM webhook_deliveries').get() as { status: string };
    expect(row.status).toBe('delivered');
    expect(requests[0]?.init.headers).toMatchObject({
      'x-webhook-signature': expect.stringMatching(/^sha256=[a-f0-9]{64}$/)
    });
  });

  it('schedules retries and then permanently fails after retry budget', async () => {
    config = testConfig(dataDir, {
      WEBHOOK_URL: 'http://127.0.0.1:9/webhook'
    });
    db = createTestDb(config);
    enqueueWebhook(db, config, 'download.failed', { fileId: 'f1', status: 'failed' });

    const fetcher = vi.fn<WebhookFetch>(async () => ({ status: 500 }));
    const dispatcher = new WebhookDispatcher(db, config, pino({ enabled: false }), fetcher);
    dispatcher.start();

    for (const offset of [100, 60_000, 5 * 60_000, 30 * 60_000, 2 * 60 * 60_000, 12 * 60 * 60_000]) {
      await vi.advanceTimersByTimeAsync(offset);
    }

    await dispatcher.stop();

    const row = db.prepare('SELECT status, attempts, nextAttemptAt FROM webhook_deliveries').get() as {
      status: string;
      attempts: number;
      nextAttemptAt: string | null;
    };
    expect(row).toMatchObject({ status: 'failed', attempts: 6, nextAttemptAt: null });
  });
});
