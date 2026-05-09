import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { ChildProcess } from 'node:child_process';
import type { Logger } from 'pino';
import { fetch } from 'undici';
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
import type { ChildProcessResult, ErrorCode, FileRow } from '../types.js';

const LANGDETECT_URL = 'https://svtplay-dl.se/langdetect/';
const LANGDETECT_TIMEOUT_MS = 30_000;

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
      const result = await this.runSvtplayDl(row, logStream, controller);

      if (result.code === 0) {
        await ensureDownloadedMediaAtExpectedPath(this.config, row, logStream);
        await this.muxSubtitles(row, logStream, controller);
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
      const code = error instanceof DownloadPipelineError
        ? error.code
        : isEnospc(error) ? 'insufficient_space' : 'unknown';
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

  private runSvtplayDl(
    row: FileRow,
    logStream: fs.WriteStream,
    controller: AbortController
  ): Promise<ChildProcessResult> {
    return runLoggedProcess({
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
  }

  private async muxSubtitles(row: FileRow, logStream: fs.WriteStream, controller: AbortController): Promise<void> {
    const sidecars = await subtitleSidecars(this.config, row);
    if (sidecars.length === 0) {
      logStream.write('no subtitle sidecars found to mux\n');
      return;
    }

    const mediaPath = fileMediaPath(this.config, row);
    const tempPath = path.join(downloadDir(this.config, row.id), `${stripMkv(row.filename)}.muxing.mkv`);
    const languages = await detectSubtitleLanguages(sidecars, logStream);
    logStream.write(`muxing ${sidecars.length} subtitle sidecar(s) into ${row.filename}\n`);
    const result = await runLoggedProcess({
      command: 'ffmpeg',
      args: buildFfmpegSubtitleMuxArgs(mediaPath, sidecars, tempPath, languages),
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
      await fsp.rm(tempPath, { force: true });
      throw new DownloadPipelineError('child_exit_nonzero', childFailureSummary('ffmpeg', result));
    }

    await fsp.rename(tempPath, mediaPath);
    logStream.write(`muxed subtitles into ${row.filename}\n`);
  }
}

class DownloadPipelineError extends Error {
  constructor(readonly code: ErrorCode, message: string) {
    super(message);
  }
}

export function buildSvtplayDownloadArgs(
  config: Config,
  row: FileRow
): string[] {
  return [
    `--resolution=${row.quality}`,
    '--force',
    '--output-format=mkv',
    '--subtitle',
    '--all-subtitles',
    `--output=${downloadDir(config, row.id)}`,
    `--filename=${stripMkv(row.filename)}.{ext}`,
    row.url
  ];
}

export function buildFfmpegSubtitleMuxArgs(
  mediaPath: string,
  subtitlePaths: string[],
  outputPath: string,
  languages = subtitlePaths.map((subtitlePath) => subtitleLanguageFromPath(subtitlePath))
): string[] {
  const args = [
    '-y',
    '-i',
    mediaPath
  ];

  for (const subtitlePath of subtitlePaths) {
    args.push('-i', subtitlePath);
  }

  args.push(
    '-map',
    '0:v?',
    '-map',
    '0:a?'
  );

  subtitlePaths.forEach((subtitlePath, index) => {
    args.push('-map', `${index + 1}:0`);
    const language = languages[index];
    if (language) {
      args.push(`-metadata:s:s:${index}`, `language=${language}`);
    }
  });

  args.push(
    '-map_metadata',
    '0',
    '-map_chapters',
    '0',
    '-c',
    'copy',
    '-c:s',
    'srt',
    outputPath
  );

  return args;
}

async function detectSubtitleLanguages(
  subtitlePaths: string[],
  logStream: Pick<fs.WriteStream, 'write'>
): Promise<string[]> {
  return Promise.all(
    subtitlePaths.map(async (subtitlePath) => {
      const explicitLanguage = subtitleLanguageExceptionFromPath(subtitlePath);
      if (explicitLanguage) {
        return explicitLanguage;
      }

      const fallback = subtitleLanguageFromPath(subtitlePath);
      try {
        const text = await subtitleTextForLanguageDetection(subtitlePath);
        if (!text) {
          return fallback;
        }
        const detected = await detectLanguage(text);
        logStream.write(`detected subtitle language ${path.basename(subtitlePath)}: ${detected}\n`);
        return detected;
      } catch (error) {
        logStream.write(
          `subtitle language detection failed for ${path.basename(subtitlePath)}: ${error instanceof Error ? error.message : String(error)}\n`
        );
        return fallback;
      }
    })
  );
}

export async function detectLanguage(query: string): Promise<string> {
  const response = await fetch(LANGDETECT_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query }),
    signal: AbortSignal.timeout(LANGDETECT_TIMEOUT_MS)
  });
  if (!response.ok) {
    throw new Error(`langdetect returned HTTP ${response.status}`);
  }

  const body = await response.json() as { language?: unknown };
  return typeof body.language === 'string' && body.language ? body.language : 'und';
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

async function subtitleSidecars(config: Config, row: FileRow): Promise<string[]> {
  const dir = downloadDir(config, row.id);
  const mediaBase = stripMkv(row.filename);
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
    .filter((entry) => entry.startsWith(`${mediaBase}.`) && /\.(srt|vtt|ttml|dfxp|ass|ssa)$/i.test(entry))
    .sort()
    .map((entry) => path.join(dir, entry));
}

export function subtitleLanguageFromPath(filePath: string): string {
  return subtitleLanguageExceptionFromPath(filePath) ?? 'und';
}

const SVTPLAY_DL_SUBTITLE_EXCEPTIONS: ReadonlyMap<string, string> = new Map([
  ['lulesamiska', 'smj'],
  ['meankieli', 'fit'],
  ['jiddisch', 'yid']
]);

function subtitleLanguageExceptionFromPath(filePath: string): string | null {
  const tokens = path.basename(filePath).split('.').slice(1, -1).map(normalizeSubtitleLanguageToken);
  for (const token of tokens) {
    const language = SVTPLAY_DL_SUBTITLE_EXCEPTIONS.get(token);
    if (language) {
      return language;
    }
  }
  return null;
}

function normalizeSubtitleLanguageToken(value: string): string {
  return value.toLowerCase().replace(/^[-_.]+|[-_.]+$/g, '');
}

export async function subtitleTextForLanguageDetection(filePath: string): Promise<string> {
  const raw = await fsp.readFile(filePath, 'utf8');
  const text = raw
    .replace(/^\uFEFF/, '')
    .replace(/\r/g, '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !isSubtitleMetadataLine(line))
    .map((line) => line.replace(/<[^>]+>/g, '').trim())
    .filter(Boolean);

  return text.slice(0, 24).join(' ').replace(/\s+/g, ' ').trim();
}

function isSubtitleMetadataLine(line: string): boolean {
  return (
    /^WEBVTT(?:\s|$)/i.test(line) ||
    /^NOTE(?:\s|$)/i.test(line) ||
    /^\d+$/.test(line) ||
    /-->\s*/.test(line) ||
    /^STYLE(?:\s|$)/i.test(line) ||
    /^REGION(?:\s|$)/i.test(line) ||
    /^\{\\/.test(line)
  );
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
