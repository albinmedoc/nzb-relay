import { randomUUID } from 'node:crypto';
import type { AppDatabase } from './db/client.js';
import { resolveWebhookUrl, type Config } from './config.js';
import type { WebhookEvent } from './types.js';
import { nowIso } from './utils/time.js';

export function enqueueWebhook(
  db: AppDatabase,
  config: Config,
  event: WebhookEvent,
  data: Record<string, unknown>,
  timestamp = nowIso()
): void {
  const url = resolveWebhookUrl(config, event);
  if (!url) {
    return;
  }

  const payload = JSON.stringify({
    event,
    timestamp,
    data
  });

  db.prepare(
    `
      INSERT INTO webhook_deliveries (
        id, event, url, payload, attempts, nextAttemptAt, status, lastError, createdAt
      )
      VALUES (?, ?, ?, ?, 0, ?, 'pending', NULL, ?)
    `
  ).run(randomUUID(), event, url, payload, timestamp, timestamp);
}

