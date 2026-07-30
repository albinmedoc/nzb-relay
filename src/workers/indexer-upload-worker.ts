import fs from 'node:fs/promises';
import { FormData, fetch as undiciFetch } from 'undici';
import type { Logger } from 'pino';
import type { Config, IndexerUploadConfig } from '../config.js';
import type { AppDatabase } from '../db/client.js';
import {
  getNzb,
  markIndexerUploadCompleted,
  markIndexerUploadFailed,
  markIndexerUploadRetry,
  nextDueIndexerUpload
} from '../db/repository.js';
import type { IndexerUploadRow, NzbRow } from '../types.js';
import { truncateOneLine } from '../utils/child.js';
import { nzbFinalPath } from '../utils/paths.js';
import { addMillisecondsIso, nowIso, sleep } from '../utils/time.js';

const RETRY_OFFSETS_MS = [60_000, 5 * 60_000, 30 * 60_000, 2 * 60 * 60_000, 12 * 60 * 60_000];

type IndexerUploadBody = Buffer | FormData;

export type IndexerUploadFetch = (
  url: string,
  init: {
    method: 'POST' | 'PUT';
    headers: Record<string, string>;
    body: IndexerUploadBody;
    signal: AbortSignal;
  }
) => Promise<{ status: number }>;

export class IndexerUploadWorker {
  private readonly stopController = new AbortController();
  private loopPromise: Promise<void> | null = null;

  constructor(
    private readonly db: AppDatabase,
    private readonly config: Config,
    private readonly logger: Logger,
    private readonly fetcher: IndexerUploadFetch = undiciFetch as unknown as IndexerUploadFetch
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
      const upload = nextDueIndexerUpload(this.db);
      if (!upload) {
        await sleep(5000, this.stopController.signal);
        continue;
      }
      this.logger.debug?.(
        { event: 'indexer_upload.claimed', uploadId: upload.id, nzbId: upload.nzbId, indexerName: upload.indexerName },
        'indexer upload claimed'
      );
      await this.dispatch(upload);
    }
  }

  private async dispatch(upload: IndexerUploadRow): Promise<void> {
    const target = this.config.indexerUploads.find((entry) => entry.name === upload.indexerName);
    if (!target) {
      this.logger.debug?.(
        { event: 'indexer_upload.target_missing', uploadId: upload.id, indexerName: upload.indexerName },
        'indexer upload target missing'
      );
      this.failPermanently(upload, `indexer upload target is not configured: ${upload.indexerName}`);
      return;
    }

    const nzb = getNzb(this.db, upload.nzbId);
    if (!nzb || nzb.status !== 'completed') {
      this.logger.debug?.(
        { event: 'indexer_upload.nzb_not_ready', uploadId: upload.id, nzbId: upload.nzbId, status: nzb?.status },
        'indexer upload NZB not ready'
      );
      this.failPermanently(upload, `nzb is not completed: ${upload.nzbId}`);
      return;
    }

    try {
      const request = await buildIndexerUploadRequest(this.config, target, nzb);
      this.logger.debug?.(
        {
          event: 'indexer_upload.request_started',
          uploadId: upload.id,
          nzbId: upload.nzbId,
          indexerName: target.name,
          method: request.method,
          format: target.format
        },
        'indexer upload request started'
      );
      const response = await this.fetcher(target.url, {
        ...request,
        signal: AbortSignal.timeout(30_000)
      });
      this.logger.debug?.(
        { event: 'indexer_upload.response', uploadId: upload.id, nzbId: upload.nzbId, status: response.status },
        'indexer upload response'
      );

      if (response.status >= 200 && response.status <= 299) {
        markIndexerUploadCompleted(this.db, upload.id);
        this.logger.info({ event: 'indexer_upload.completed', uploadId: upload.id, nzbId: upload.nzbId }, 'indexer upload completed');
        return;
      }

      this.scheduleFailure(upload, `HTTP ${response.status}`);
    } catch (error) {
      this.scheduleFailure(upload, error instanceof Error ? error.message : String(error));
    }
  }

  private scheduleFailure(upload: IndexerUploadRow, reason: string): void {
    const attempts = upload.attempts + 1;
    const lastError = truncateOneLine(reason);
    const nextOffset = RETRY_OFFSETS_MS[attempts - 1];

    if (nextOffset == null) {
      markIndexerUploadFailed(this.db, upload.id, attempts, lastError);
      this.logger.warn(
        { event: 'indexer_upload.failed', uploadId: upload.id, nzbId: upload.nzbId, attempts, lastError },
        'indexer upload failed permanently'
      );
      return;
    }

    markIndexerUploadRetry(this.db, upload.id, attempts, addMillisecondsIso(nowIso(), nextOffset), lastError);
    this.logger.debug?.(
      { event: 'indexer_upload.retry_scheduled', uploadId: upload.id, nzbId: upload.nzbId, attempts, nextOffsetMs: nextOffset },
      'indexer upload retry scheduled'
    );
    this.logger.warn(
      { event: 'indexer_upload.retry', uploadId: upload.id, nzbId: upload.nzbId, attempts, lastError },
      'indexer upload failed; scheduled retry'
    );
  }

  private failPermanently(upload: IndexerUploadRow, reason: string): void {
    const attempts = upload.attempts + 1;
    const lastError = truncateOneLine(reason);
    markIndexerUploadFailed(this.db, upload.id, attempts, lastError);
    this.logger.warn(
      { event: 'indexer_upload.failed', uploadId: upload.id, nzbId: upload.nzbId, attempts, lastError },
      'indexer upload failed permanently'
    );
  }
}

export async function buildIndexerUploadRequest(
  config: Config,
  target: IndexerUploadConfig,
  nzb: Pick<NzbRow, 'id' | 'releaseName' | 'nzbFile' | 'postedAt'>
): Promise<{
  method: 'POST' | 'PUT';
  headers: Record<string, string>;
  body: IndexerUploadBody;
}> {
  const filePath = nzbFinalPath(config, nzb);
  const file = await fs.readFile(filePath);
  const filename = renderIndexerTemplate(target.filenameTemplate, nzb);
  const headers = renderRecord(target.headers, nzb);

  if (target.format === 'raw') {
    headers['content-type'] ??= 'application/x-nzb';
    headers['content-disposition'] ??= `attachment; filename="${filename.replaceAll('"', '\\"')}"`;
    return {
      method: target.method,
      headers,
      body: file
    };
  }

  const form = new FormData();
  for (const [name, value] of Object.entries(renderRecord(target.fields, nzb))) {
    form.append(name, value);
  }
  form.append(target.fileField, new Blob([file], { type: 'application/x-nzb' }), filename);

  return {
    method: target.method,
    headers,
    body: form
  };
}

function renderRecord(values: Record<string, string>, nzb: Pick<NzbRow, 'id' | 'releaseName' | 'nzbFile' | 'postedAt'>): Record<string, string> {
  return Object.fromEntries(Object.entries(values).map(([key, value]) => [key, renderIndexerTemplate(value, nzb)]));
}

function renderIndexerTemplate(template: string, nzb: Pick<NzbRow, 'id' | 'releaseName' | 'nzbFile' | 'postedAt'>): string {
  return template
    .replaceAll('{nzbId}', nzb.id)
    .replaceAll('{releaseName}', nzb.releaseName)
    .replaceAll('{nzbFile}', nzb.nzbFile)
    .replaceAll('{postedAt}', nzb.postedAt ?? '');
}
