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
  enqueueIndexerUploads,
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

type RandomInt = (maxExclusive: number) => number;

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
      this.logger.debug?.({ event: 'nzb.claim_skipped', nzbId: pending.id }, 'NZB claim skipped');
      return true;
    }

    const row = getNzbOrThrow(this.db, pending.id);
    this.logger.debug?.(
      { event: 'nzb.claimed', nzbId: row.id, releaseName: row.releaseName },
      'NZB claimed'
    );
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
    const workDir = nzbWorkDir(this.config, row);
    await fsp.mkdir(workDir, { recursive: true });
    const logStream = fs.createWriteStream(nzbLogPath(this.config, row), { flags: 'a' });

    try {
      this.logger.debug?.({ event: 'nzb.started', nzbId: row.id, releaseName: row.releaseName }, 'NZB processing started');
      assertUsenetConfigured(this.config);
      const files = canonicalFilesForNzb(this.db, row.id);
      this.logger.debug?.({ event: 'nzb.files_loaded', nzbId: row.id, fileCount: files.length }, 'NZB files loaded');
      await this.preflightSpace(row, files, logStream);

      const password = crypto.randomBytes(16).toString('base64url');
      const stagedFiles = await this.stageSymlinks(row, files);
      this.logger.debug?.({ event: 'nzb.files_staged', nzbId: row.id, fileCount: stagedFiles.length }, 'NZB files staged');
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
      this.logger.debug?.({ event: 'nzb.rar_parts_ready', nzbId: row.id, partCount: rarParts.length }, 'NZB rar parts ready');
      await this.runStep(row, 'parpar', buildParparArgs(workDir, row.releaseName, rarParts), logStream, controller);

      const postFiles = [
        ...(await listMatching(workDir, row.releaseName, /(\.rar|\.r\d+|\.par2)$/i))
      ];
      this.logger.debug?.({ event: 'nzb.post_files_ready', nzbId: row.id, fileCount: postFiles.length }, 'NZB post files ready');
      await this.runStep(row, 'nyuu', buildNyuuArgs(this.config, row, password, postFiles), logStream, controller);

      const completed = transitionNzbCompleted(this.db, this.config, row);
      this.logger.debug?.({ event: 'nzb.completed', nzbId: row.id, transitioned: completed }, 'NZB completed');
      if (completed) {
        try {
          enqueueIndexerUploads(this.db, this.config, getNzbOrThrow(this.db, row.id));
        } catch (error) {
          this.logger.error({ event: 'indexer_upload.enqueue_failed', nzbId: row.id, error }, 'failed to enqueue indexer uploads');
        }
      }

      try {
        await removeNzbWorkDir(this.config, row);
      } catch (error) {
        this.logger.warn({ event: 'nzb.cleanup_failed', nzbId: row.id, error }, 'nzb cleanup failed');
      }
    } catch (error) {
      if (isTerminalSuppressed()) {
        this.logger.debug?.({ event: 'nzb.terminal_suppressed', nzbId: row.id }, 'NZB terminal transition suppressed');
        return;
      }
      const { code, message } = classifyNzbError(error);
      try {
        const transitioned = transitionNzbFailed(this.db, this.config, row, code, message);
        this.logger.debug?.(
          { event: 'nzb.failed', nzbId: row.id, errorCode: code, error: message, transitioned },
          'NZB failed'
        );
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
    this.logger.debug?.(
      { event: 'nzb.space_checked', nzbId: row.id, inputBytes: total, requiredBytes: required, availableBytes: available },
      'NZB staging space checked'
    );
    if (available < required) {
      const message = `insufficient_space: need ${required} bytes, have ${available} bytes`;
      logStream.write(`${message}\n`);
      throw new NzbPipelineError('insufficient_space', message);
    }
  }

  private async stageSymlinks(row: NzbRow, files: NzbFileSummary[]): Promise<string[]> {
    const workDir = nzbWorkDir(this.config, row);
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
    this.logger.debug?.({ event: 'nzb.step.started', nzbId: row.id, command }, 'NZB step started');
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
      this.logger.debug?.(
        { event: 'nzb.step.failed', nzbId: row.id, command, code: result.code, signal: result.signal },
        'NZB step failed'
      );
      throw new NzbPipelineError('child_exit_nonzero', childFailureSummary(command, result));
    }
    this.logger.debug?.({ event: 'nzb.step.completed', nzbId: row.id, command }, 'NZB step completed');
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

export function buildNyuuArgs(
  config: Config,
  row: Pick<NzbRow, 'releaseName' | 'nzbFile'>,
  password: string,
  postFiles: string[],
  randomInt?: RandomInt
): string[] {
  return [
    '--host',
    config.usenet.host,
    '--port',
    String(config.usenet.port),
    ...(config.usenet.ssl ? ['--ssl'] : []),
    '--user',
    config.usenet.user,
    '--password',
    config.usenet.pass,
    '--groups',
    newsgroupsForUpload(config, randomInt).join(','),
    '--article-size',
    '750000',
    '--from',
    '${rand(12)} <${rand(16)}@${rand(12)}.invalid>',
    '--date',
    'now',
    '--message-id',
    '${rand(24)}@${rand(12)}.invalid',
    '--nzb-file-mode',
    'temp',
    '--nzb-del-incomplete',
    '--overwrite',
    '--retry-on-bad-resp',
    '--connect-retries',
    '3',
    '--post-retries',
    '2',
    '--progress',
    'log:60s',
    '--log-time',
    '--meta',
    `name=${row.releaseName}`,
    '--meta',
    `password=${password}`,
    '--out',
    nzbFinalPath(config, row),
    ...postFiles
  ];
}

export function newsgroupsForUpload(
  config: Config,
  randomInt: RandomInt = (maxExclusive) => crypto.randomInt(maxExclusive)
): string[] {
  const remaining = [...config.usenet.newsgroups];
  const selected: string[] = [];
  const limit = Math.min(config.usenet.newsgroupsPerUpload, remaining.length);

  while (selected.length < limit) {
    const index = randomInt(remaining.length);
    const [newsgroup] = remaining.splice(index, 1);
    if (newsgroup == null) {
      throw new Error('random newsgroup selection returned an invalid index');
    }
    selected.push(newsgroup);
  }

  return selected;
}
