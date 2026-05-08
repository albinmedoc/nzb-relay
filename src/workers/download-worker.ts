import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { ChildProcess } from 'node:child_process';
import type { Logger } from 'pino';
import type { Config } from '../config.js';
import type { AppDatabase } from '../db/client.js';
import {
  claimFile,
  getFileOrThrow,
  nextPendingFile,
  transitionFileCompleted,
  transitionFileFailed
} from '../db/repository.js';
import { childFailureSummary, isEnospc, runLoggedProcess } from '../utils/child.js';
import { removeDownloadPartialsKeepLog } from '../utils/cleanup.js';
import { fileLogPath, fileMediaPath, downloadDir, stripMkv } from '../utils/paths.js';
import { sleep } from '../utils/time.js';
import type { FileRow } from '../types.js';

interface ActiveDownload {
  id: string;
  controller: AbortController;
  done: Promise<void>;
  child: ChildProcess | null;
  userCancelled: boolean;
  shutdownCancelled: boolean;
}

export class DownloadWorker {
  private readonly stopController = new AbortController();
  private loopPromise: Promise<void> | null = null;
  private active: ActiveDownload | null = null;

  constructor(
    private readonly db: AppDatabase,
    private readonly config: Config,
    private readonly logger: Logger
  ) {}

  start(): void {
    this.loopPromise ??= this.loop();
  }

  async stop(): Promise<void> {
    this.stopController.abort();
    if (this.active) {
      this.active.shutdownCancelled = true;
      this.active.controller.abort();
      await this.active.done;
    }
    await this.loopPromise;
  }

  async cancel(fileId: string): Promise<void> {
    if (this.active?.id !== fileId) {
      return;
    }
    this.active.userCancelled = true;
    this.active.controller.abort();
    await this.active.done;
  }

  private async loop(): Promise<void> {
    while (!this.stopController.signal.aborted) {
      const didWork = await this.runOne();
      if (!didWork) {
        await sleep(1000, this.stopController.signal);
      }
    }
  }

  private async runOne(): Promise<boolean> {
    const pending = nextPendingFile(this.db);
    if (!pending) {
      return false;
    }
    if (!claimFile(this.db, pending.id)) {
      return true;
    }

    const row = getFileOrThrow(this.db, pending.id);
    const controller = new AbortController();
    const done = this.execute(
      row,
      controller,
      () => this.active?.id === row.id && (this.active.userCancelled || this.active.shutdownCancelled)
    );
    this.active = { id: row.id, controller, done, child: null, userCancelled: false, shutdownCancelled: false };

    try {
      await done;
    } finally {
      if (this.active?.id === row.id) {
        this.active = null;
      }
    }

    return true;
  }

  private async execute(row: FileRow, controller: AbortController, isTerminalSuppressed: () => boolean): Promise<void> {
    await fsp.mkdir(downloadDir(this.config, row.id), { recursive: true });
    const logPath = fileLogPath(this.config, row);
    const logStream = fs.createWriteStream(logPath, { flags: 'a' });

    try {
      await removeDownloadPartialsKeepLog(this.config, row);
      logStream.write(`starting svtplay-dl for ${row.url}\n`);
      const result = await runLoggedProcess({
        command: 'svtplay-dl',
        args: buildSvtplayDownloadArgs(this.config, row),
        logStream,
        signal: controller.signal,
        logger: this.logger,
        onChild: (child) => {
          if (this.active?.id === row.id) {
            this.active.child = child;
          }
        }
      });

      if (result.code === 0) {
        await ensureDownloadedMediaAtExpectedPath(this.config, row, logStream);
        await removeDownloadSidecars(this.config, row, logStream).catch((error) => {
          logStream.write(`download sidecar cleanup failed: ${error instanceof Error ? error.message : String(error)}\n`);
          this.logger.warn({ event: 'download.sidecar_cleanup_failed', fileId: row.id, error }, 'download sidecar cleanup failed');
        });
        logStream.write(`completed ${row.filename}\n`);
        transitionFileCompleted(this.db, this.config, row);
        return;
      }

      if (isTerminalSuppressed()) {
        logStream.write('download child stopped without terminal transition\n');
        return;
      }

      const error = childFailureSummary('svtplay-dl', result);
      const transitioned = transitionFileFailed(this.db, this.config, row, 'child_exit_nonzero', error);
      if (transitioned) {
        await removeDownloadPartialsKeepLog(this.config, row);
      }
    } catch (error) {
      if (isTerminalSuppressed()) {
        return;
      }
      const code = isEnospc(error) ? 'insufficient_space' : 'unknown';
      const message = code === 'insufficient_space' ? 'disk full' : error instanceof Error ? error.message : String(error);
      try {
        const transitioned = transitionFileFailed(this.db, this.config, row, code, message);
        if (transitioned && code !== 'insufficient_space') {
          await removeDownloadPartialsKeepLog(this.config, row);
        }
      } catch (transitionError) {
        this.logger.error({ error: transitionError, fileId: row.id }, 'failed to persist download failure');
      }
    } finally {
      await new Promise<void>((resolve) => logStream.end(resolve));
    }
  }
}

export function buildSvtplayDownloadArgs(config: Config, row: FileRow): string[] {
  return [
    `--resolution=${row.quality}`,
    '--force',
    '--output-format=mkv',
    '--subtitle',
    '-M',
    '--all-subtitles',
    `--output=${downloadDir(config, row.id)}`,
    `--filename=${stripMkv(row.filename)}.{ext}`,
    row.url
  ];
}

async function ensureDownloadedMediaAtExpectedPath(
  config: Config,
  row: FileRow,
  logStream: fs.WriteStream
): Promise<void> {
  const expectedPath = fileMediaPath(config, row);
  try {
    await fsp.stat(expectedPath);
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }

  const candidates = await downloadedMediaCandidates(config, row);
  if (candidates.length === 1) {
    logStream.write(`renaming downloaded media ${candidates[0]} to ${expectedPath}\n`);
    await fsp.rename(candidates[0]!, expectedPath);
    return;
  }

  throw new Error(
    `download completed but expected media is missing: ${expectedPath}; found ${candidates.length} media candidates`
  );
}

async function downloadedMediaCandidates(config: Config, row: FileRow): Promise<string[]> {
  const dir = downloadDir(config, row.id);
  let entries: string[];
  try {
    entries = await fsp.readdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw error;
  }

  return entries
    .filter((entry) => /\.(mkv|mp4)$/i.test(entry))
    .map((entry) => path.join(dir, entry));
}

export async function removeDownloadSidecars(
  config: Config,
  row: Pick<FileRow, 'id' | 'filename'>,
  logStream: Pick<fs.WriteStream, 'write'>
): Promise<void> {
  const dir = downloadDir(config, row.id);
  let entries: string[];
  try {
    entries = await fsp.readdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return;
    }
    throw error;
  }

  const keep = new Set([row.filename, path.basename(fileLogPath(config, row))]);
  const sidecars = entries.filter((entry) => !keep.has(entry));

  await Promise.all(
    sidecars.map(async (entry) => {
      await fsp.rm(path.join(dir, entry), { force: true });
      logStream.write(`removed download sidecar ${entry}\n`);
    })
  );
}
