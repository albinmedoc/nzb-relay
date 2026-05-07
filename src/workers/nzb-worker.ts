import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { ChildProcess } from 'node:child_process';
import type { Logger } from 'pino';
import type { Config } from '../config.js';
import { assertUsenetConfigured } from '../config.js';
import type { AppDatabase } from '../db/client.js';
import {
  canonicalFilesForNzb,
  claimNzb,
  getNzbOrThrow,
  nextPendingNzb,
  transitionNzbCompleted,
  transitionNzbFailed
} from '../db/repository.js';
import { childFailureSummary, isEnospc, runLoggedProcess } from '../utils/child.js';
import { removeNzbWorkDir } from '../utils/cleanup.js';
import { fileMediaPath, nzbFinalPath, nzbLogPath, nzbWorkDir } from '../utils/paths.js';
import { sleep } from '../utils/time.js';
import type { ErrorCode, NzbFileSummary, NzbRow } from '../types.js';

interface ActiveNzb {
  id: string;
  controller: AbortController;
  done: Promise<void>;
  child: ChildProcess | null;
  shutdownCancelled: boolean;
}

export class NzbWorker {
  private readonly stopController = new AbortController();
  private loopPromise: Promise<void> | null = null;
  private active: ActiveNzb | null = null;

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

  async cancel(nzbId: string): Promise<void> {
    if (this.active?.id !== nzbId) {
      return;
    }
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
    const pending = nextPendingNzb(this.db);
    if (!pending) {
      return false;
    }
    if (!claimNzb(this.db, pending.id)) {
      return true;
    }

    const row = getNzbOrThrow(this.db, pending.id);
    const controller = new AbortController();
    const done = this.execute(row, controller, () => this.active?.id === row.id && this.active.shutdownCancelled);
    this.active = { id: row.id, controller, done, child: null, shutdownCancelled: false };

    try {
      await done;
    } finally {
      if (this.active?.id === row.id) {
        this.active = null;
      }
    }

    return true;
  }

  private async execute(row: NzbRow, controller: AbortController, isTerminalSuppressed: () => boolean): Promise<void> {
    const workDir = nzbWorkDir(this.config, row.id);
    await fsp.mkdir(workDir, { recursive: true });
    const logStream = fs.createWriteStream(nzbLogPath(this.config, row.id), { flags: 'a' });

    try {
      assertUsenetConfigured(this.config);
      const files = canonicalFilesForNzb(this.db, row.id);
      await this.preflightSpace(row, files, logStream);

      const password = crypto.randomBytes(16).toString('base64url');
      const stagedFiles = await this.stageSymlinks(row, files);
      const rarBase = path.join(workDir, `${row.releaseName}.rar`);

      await this.runStep(row, 'rar', [
        'a',
        '-m0',
        '-v100m',
        `-hp${password}`,
        '-ed',
        '-ep1',
        rarBase,
        ...stagedFiles
      ], logStream, controller);

      const rarParts = await listMatching(workDir, row.releaseName, /(\.rar|\.r\d+)$/i);
      await this.runStep(row, 'parpar', buildParparArgs(workDir, row.releaseName, rarParts), logStream, controller);

      const postFiles = [
        ...(await listMatching(workDir, row.releaseName, /(\.rar|\.r\d+|\.par2)$/i))
      ];
      await this.runStep(row, 'nyuu', [
        '--host',
        this.config.usenet.host,
        '--port',
        String(this.config.usenet.port),
        ...(this.config.usenet.ssl ? ['--ssl'] : []),
        '--user',
        this.config.usenet.user,
        '--password',
        this.config.usenet.pass,
        '--groups',
        this.config.usenet.newsgroups.join(','),
        '--article-size',
        '750000',
        '--meta',
        `name=${row.releaseName}`,
        '--meta',
        `password=${password}`,
        '--out',
        nzbFinalPath(this.config, row),
        ...postFiles
      ], logStream, controller);

      transitionNzbCompleted(this.db, this.config, row);

      try {
        await removeNzbWorkDir(this.config, row);
      } catch (error) {
        this.logger.warn({ event: 'nzb.cleanup_failed', nzbId: row.id, error }, 'nzb cleanup failed');
      }
    } catch (error) {
      if (isTerminalSuppressed()) {
        return;
      }
      const { code, message } = classifyNzbError(error);
      try {
        const transitioned = transitionNzbFailed(this.db, this.config, row, code, message);
        if (transitioned && code !== 'insufficient_space') {
          await removeNzbWorkDir(this.config, row);
        }
      } catch (transitionError) {
        this.logger.error({ error: transitionError, nzbId: row.id }, 'failed to persist nzb failure');
      }
    } finally {
      await new Promise<void>((resolve) => logStream.end(resolve));
    }
  }

  private async preflightSpace(row: NzbRow, files: NzbFileSummary[], logStream: fs.WriteStream): Promise<void> {
    let total = 0;
    for (const file of files) {
      const stat = await fsp.stat(fileMediaPath(this.config, toFileRow(file)));
      total += stat.size;
    }

    const statfs = await fsp.statfs(this.config.dataDir);
    const available = statfs.bavail * statfs.bsize;
    const required = Math.ceil(total * this.config.stagingMultiplier);
    if (available < required) {
      const message = `insufficient_space: need ${required} bytes, have ${available} bytes`;
      logStream.write(`${message}\n`);
      throw new NzbPipelineError('insufficient_space', message);
    }
  }

  private async stageSymlinks(row: NzbRow, files: NzbFileSummary[]): Promise<string[]> {
    const workDir = nzbWorkDir(this.config, row.id);
    const staged: string[] = [];
    let index = 1;
    for (const file of files) {
      const source = fileMediaPath(this.config, toFileRow(file));
      const target = path.join(workDir, `${String(index).padStart(3, '0')}-${file.id}-${file.filename}`);
      await fsp.symlink(source, target);
      staged.push(target);
      index += 1;
    }
    return staged;
  }

  private async runStep(
    row: NzbRow,
    command: string,
    args: string[],
    logStream: fs.WriteStream,
    controller: AbortController
  ): Promise<void> {
    logStream.write(`starting ${command}\n`);
    const result = await runLoggedProcess({
      command,
      args,
      logStream,
      signal: controller.signal,
      logger: this.logger,
      onChild: (child) => {
        if (this.active?.id === row.id) {
          this.active.child = child;
        }
      }
    });

    if (result.code !== 0) {
      throw new NzbPipelineError('child_exit_nonzero', childFailureSummary(command, result));
    }
  }
}

class NzbPipelineError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string
  ) {
    super(message);
  }
}

function classifyNzbError(error: unknown): { code: ErrorCode; message: string } {
  if (error instanceof NzbPipelineError) {
    return { code: error.code, message: error.message };
  }
  if (isEnospc(error)) {
    return { code: 'insufficient_space', message: 'disk full' };
  }
  return { code: 'unknown', message: error instanceof Error ? error.message : String(error) };
}

async function listMatching(dir: string, prefix: string, pattern: RegExp): Promise<string[]> {
  const entries = await fsp.readdir(dir);
  return entries
    .filter((entry) => entry.startsWith(prefix) && pattern.test(entry))
    .sort()
    .map((entry) => path.join(dir, entry));
}

function toFileRow(file: NzbFileSummary) {
  return {
    ...file,
    status: 'completed' as const,
    quality: '',
    createdAt: '',
    errorCode: null,
    error: null
  };
}

export function buildParparArgs(workDir: string, releaseName: string, rarParts: string[]): string[] {
  return [
    '--input-slices=768000b',
    '-r',
    '10%',
    '-o',
    path.join(workDir, `${releaseName}.par2`),
    ...rarParts
  ];
}
