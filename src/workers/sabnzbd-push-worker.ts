import fs from 'node:fs/promises';
import { FormData, fetch as undiciFetch } from 'undici';
import type { Logger } from 'pino';
import type { Config } from '../config.js';
import type { AppDatabase } from '../db/client.js';
import {
  getNzb,
  markSabnzbdPushCompleted,
  markSabnzbdPushFailed,
  markSabnzbdPushRetry,
  nextDueSabnzbdPush
} from '../db/repository.js';
import type { NzbRow, SabnzbdPushRow } from '../types.js';
import { truncateOneLine } from '../utils/child.js';
import { nzbFinalPath } from '../utils/paths.js';
import { addMillisecondsIso, nowIso, sleep } from '../utils/time.js';

const RETRY_OFFSETS_MS = [60_000, 5 * 60_000, 30 * 60_000, 2 * 60 * 60_000, 12 * 60 * 60_000];

export type SabnzbdPushFetch = (
  url: string,
  init: {
    method: 'POST';
    body: FormData;
    signal: AbortSignal;
  }
) => Promise<{ status: number; json(): Promise<unknown> }>;

export class SabnzbdPushWorker {
  private readonly stopController = new AbortController();
  private loopPromise: Promise<void> | null = null;

  constructor(
    private readonly db: AppDatabase,
    private readonly config: Config,
    private readonly logger: Logger,
    private readonly fetcher: SabnzbdPushFetch = undiciFetch as unknown as SabnzbdPushFetch
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
      const push = nextDueSabnzbdPush(this.db);
      if (!push) {
        await sleep(5000, this.stopController.signal);
        continue;
      }
      this.logger.debug?.(
        { event: 'sabnzbd_push.claimed', pushId: push.id, nzbId: push.nzbId, category: push.category },
        'SABnzbd push claimed'
      );
      await this.dispatch(push);
    }
  }

  private async dispatch(push: SabnzbdPushRow): Promise<void> {
    const nzb = getNzb(this.db, push.nzbId);
    if (!nzb || nzb.status !== 'completed') {
      this.failPermanently(push, `nzb is not completed: ${push.nzbId}`);
      return;
    }

    try {
      const request = await buildSabnzbdPushRequest(this.config, push, nzb);
      this.logger.debug?.(
        { event: 'sabnzbd_push.request_started', pushId: push.id, nzbId: push.nzbId, category: push.category },
        'SABnzbd push request started'
      );
      const response = await this.fetcher(push.url, {
        ...request,
        signal: AbortSignal.timeout(30_000)
      });
      this.logger.debug?.(
        { event: 'sabnzbd_push.response', pushId: push.id, nzbId: push.nzbId, status: response.status },
        'SABnzbd push response'
      );

      if (response.status < 200 || response.status > 299) {
        this.scheduleFailure(push, `HTTP ${response.status}`);
        return;
      }

      const parsed = parseSabnzbdResponse(await response.json());
      if (!parsed.ok) {
        this.scheduleFailure(push, parsed.error);
        return;
      }

      markSabnzbdPushCompleted(this.db, push.id, parsed.remoteIds ? JSON.stringify(parsed.remoteIds) : null);
      this.logger.info({ event: 'sabnzbd_push.completed', pushId: push.id, nzbId: push.nzbId }, 'SABnzbd push completed');
    } catch (error) {
      this.scheduleFailure(push, error instanceof Error ? error.message : String(error));
    }
  }

  private scheduleFailure(push: SabnzbdPushRow, reason: string): void {
    const attempts = push.attempts + 1;
    const lastError = truncateOneLine(reason);
    const nextOffset = RETRY_OFFSETS_MS[attempts - 1];

    if (nextOffset == null) {
      markSabnzbdPushFailed(this.db, push.id, attempts, lastError);
      this.logger.warn(
        { event: 'sabnzbd_push.failed', pushId: push.id, nzbId: push.nzbId, attempts, lastError },
        'SABnzbd push failed permanently'
      );
      return;
    }

    markSabnzbdPushRetry(this.db, push.id, attempts, addMillisecondsIso(nowIso(), nextOffset), lastError);
    this.logger.warn(
      { event: 'sabnzbd_push.retry', pushId: push.id, nzbId: push.nzbId, attempts, lastError },
      'SABnzbd push failed; scheduled retry'
    );
  }

  private failPermanently(push: SabnzbdPushRow, reason: string): void {
    const attempts = push.attempts + 1;
    const lastError = truncateOneLine(reason);
    markSabnzbdPushFailed(this.db, push.id, attempts, lastError);
    this.logger.warn(
      { event: 'sabnzbd_push.failed', pushId: push.id, nzbId: push.nzbId, attempts, lastError },
      'SABnzbd push failed permanently'
    );
  }
}

export async function buildSabnzbdPushRequest(
  config: Config,
  push: Pick<SabnzbdPushRow, 'category'>,
  nzb: Pick<NzbRow, 'releaseName' | 'nzbFile'>
): Promise<{
  method: 'POST';
  body: FormData;
}> {
  const file = await fs.readFile(nzbFinalPath(config, nzb));
  const form = new FormData();
  form.append('mode', 'addfile');
  form.append('output', 'json');
  if (config.sabnzbd.apiKey) {
    form.append('apikey', config.sabnzbd.apiKey);
  }
  form.append('cat', push.category);
  form.append('nzbfile', new Blob([file], { type: 'application/x-nzb' }), `${nzb.releaseName}.nzb`);

  return {
    method: 'POST',
    body: form
  };
}

function parseSabnzbdResponse(value: unknown): { ok: true; remoteIds: string[] | null } | { ok: false; error: string } {
  if (!value || typeof value !== 'object') {
    return { ok: false, error: 'invalid SABnzbd response' };
  }

  const body = value as { status?: unknown; error?: unknown; nzo_ids?: unknown };
  if (body.status === false) {
    return { ok: false, error: typeof body.error === 'string' ? body.error : 'SABnzbd rejected NZB' };
  }

  const remoteIds = Array.isArray(body.nzo_ids)
    ? body.nzo_ids.filter((id): id is string => typeof id === 'string')
    : null;

  return { ok: true, remoteIds };
}
