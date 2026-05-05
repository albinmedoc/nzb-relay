import crypto from 'node:crypto';
import { fetch as undiciFetch } from 'undici';
import type { Logger } from 'pino';
import type { Config } from '../config.js';
import type { AppDatabase } from '../db/client.js';
import {
  markWebhookDelivered,
  markWebhookFailed,
  markWebhookRetry,
  nextDueWebhook
} from '../db/repository.js';
import type { WebhookDeliveryRow } from '../types.js';
import { addMillisecondsIso, nowIso, sleep } from '../utils/time.js';
import { truncateOneLine } from '../utils/child.js';

const RETRY_OFFSETS_MS = [60_000, 5 * 60_000, 30 * 60_000, 2 * 60 * 60_000, 12 * 60 * 60_000];
export type WebhookFetch = (
  url: string,
  init: {
    method: 'POST';
    headers: Record<string, string>;
    body: string;
    signal: AbortSignal;
  }
) => Promise<{ status: number }>;

export class WebhookDispatcher {
  private readonly stopController = new AbortController();
  private loopPromise: Promise<void> | null = null;

  constructor(
    private readonly db: AppDatabase,
    private readonly config: Config,
    private readonly logger: Logger,
    private readonly fetcher: WebhookFetch = undiciFetch as unknown as WebhookFetch
  ) {}

  start(): void {
    this.loopPromise ??= this.loop();
  }

  async stop(): Promise<void> {
    this.stopController.abort();
    await this.loopPromise;
  }

  private async loop(): Promise<void> {
    while (!this.stopController.signal.aborted) {
      const delivery = nextDueWebhook(this.db);
      if (!delivery) {
        await sleep(5000, this.stopController.signal);
        continue;
      }
      await this.dispatch(delivery);
    }
  }

  private async dispatch(delivery: WebhookDeliveryRow): Promise<void> {
    try {
      const headers: Record<string, string> = {
        'content-type': 'application/json',
        'x-webhook-event': delivery.event,
        'x-webhook-delivery': delivery.id
      };

      if (this.config.webhooks.secret) {
        headers['x-webhook-signature'] = `sha256=${crypto
          .createHmac('sha256', this.config.webhooks.secret)
          .update(delivery.payload)
          .digest('hex')}`;
      }

      const response = await this.fetcher(delivery.url, {
        method: 'POST',
        headers,
        body: delivery.payload,
        signal: AbortSignal.timeout(30_000)
      });

      if (response.status >= 200 && response.status <= 299) {
        markWebhookDelivered(this.db, delivery.id);
        return;
      }

      this.scheduleFailure(delivery, `HTTP ${response.status}`);
    } catch (error) {
      this.scheduleFailure(delivery, error instanceof Error ? error.message : String(error));
    }
  }

  private scheduleFailure(delivery: WebhookDeliveryRow, reason: string): void {
    const attempts = delivery.attempts + 1;
    const lastError = truncateOneLine(reason);
    const nextOffset = RETRY_OFFSETS_MS[attempts - 1];

    if (nextOffset == null) {
      markWebhookFailed(this.db, delivery.id, attempts, lastError);
      this.logger.warn({ event: 'webhook.failed', deliveryId: delivery.id, attempts, lastError }, 'webhook delivery failed permanently');
      return;
    }

    markWebhookRetry(this.db, delivery.id, attempts, addMillisecondsIso(nowIso(), nextOffset), lastError);
  }
}
