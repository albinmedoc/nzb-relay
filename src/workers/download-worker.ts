import fs from 'node:fs';
import fsp from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import type { Logger } from 'pino';
import { fetch } from 'undici';
import type { Config } from '../config.js';
import type { AppDatabase } from '../db/client.js';
import {
  claimFile,
  getFileOrThrow,
  nextPendingFile,
  transitionFileCompleted,
  transitionFileFailed,
  updateRunningFileFilename
} from '../db/repository.js';
import { childFailureSummary, commandLine, isEnospc, runLoggedProcess } from '../utils/child.js';
import { removeDownloadPartialsKeepLog } from '../utils/cleanup.js';
import { fileLogPath, fileMediaPath, downloadDir, stripMkv } from '../utils/paths.js';
import { renderDownloadFilename } from '../utils/templates.js';
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
      this.logger.debug?.({ event: 'download.claim_skipped', fileId: pending.id }, 'download claim skipped');
      return true;
    }

    const row = getFileOrThrow(this.db, pending.id);
    this.logger.debug?.(
      { event: 'download.claimed', fileId: row.id, filename: row.filename, quality: row.quality },
      'download claimed'
    );
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
    let finalRow = row;

    try {
      this.logger.debug?.(
        { event: 'download.started', fileId: row.id, filename: row.filename, url: row.url },
        'download started'
      );
      await removeDownloadPartialsKeepLog(this.config, row);
      logStream.write(`starting svtplay-dl for ${row.url}\n`);
      const result = await this.runSvtplayDl(row, logStream, controller);

      if (result.code === 0) {
        await this.muxDownloadArtifacts(row, logStream, controller);
        await removeDownloadSidecars(this.config, row, logStream).catch((error) => {
          logStream.write(`download sidecar cleanup failed: ${error instanceof Error ? error.message : String(error)}\n`);
          this.logger.warn({ event: 'download.sidecar_cleanup_failed', fileId: row.id, error }, 'download sidecar cleanup failed');
        });
        finalRow = await this.applyCodecTemplate(row, logStream, controller);
        logStream.write(`completed ${finalRow.filename}\n`);
        transitionFileCompleted(this.db, this.config, finalRow);
        this.logger.debug?.(
          { event: 'download.completed', fileId: finalRow.id, filename: finalRow.filename },
          'download completed'
        );
        return;
      }

      if (isTerminalSuppressed()) {
        logStream.write('download child stopped without terminal transition\n');
        this.logger.debug?.({ event: 'download.terminal_suppressed', fileId: row.id }, 'download terminal transition suppressed');
        return;
      }

      const error = childFailureSummary('svtplay-dl', result);
      const transitioned = transitionFileFailed(this.db, this.config, row, 'child_exit_nonzero', error);
      this.logger.debug?.(
        { event: 'download.failed', fileId: row.id, errorCode: 'child_exit_nonzero', error, transitioned },
        'download failed'
      );
      if (transitioned) {
        await removeDownloadPartialsKeepLog(this.config, row);
      }
    } catch (error) {
      if (isTerminalSuppressed()) {
        this.logger.debug?.({ event: 'download.terminal_suppressed', fileId: row.id }, 'download terminal transition suppressed');
        return;
      }
      const code = error instanceof DownloadPipelineError
        ? error.code
        : isEnospc(error) ? 'insufficient_space' : 'unknown';
      const message = code === 'insufficient_space' ? 'disk full' : error instanceof Error ? error.message : String(error);
      try {
        const transitioned = transitionFileFailed(this.db, this.config, row, code, message);
        this.logger.debug?.(
          { event: 'download.failed', fileId: row.id, errorCode: code, error: message, transitioned },
          'download failed'
        );
        if (transitioned && code !== 'insufficient_space') {
          await removeDownloadPartialsKeepLog(this.config, row);
        }
      } catch (transitionError) {
        this.logger.error({ error: transitionError, fileId: row.id }, 'failed to persist download failure');
      }
    } finally {
      await new Promise<void>((resolve) => logStream.end(resolve));
      if (finalRow.filename !== row.filename) {
        await renameDownloadLog(this.config, row, finalRow).catch((error) => {
          this.logger.warn({ event: 'download.log_rename_failed', fileId: row.id, error }, 'download log rename failed');
        });
      }
    }
  }

  private runSvtplayDl(
    row: FileRow,
    logStream: fs.WriteStream,
    controller: AbortController
  ): Promise<ChildProcessResult> {
    const command = 'svtplay-dl';
    const args = buildSvtplayDownloadArgs(this.config, row);
    this.logger.debug?.(
      {
        event: 'svtplay_dl.command',
        source: 'download',
        fileId: row.id,
        command,
        args,
        commandLine: commandLine(command, args)
      },
      'svtplay-dl command'
    );
    return runLoggedProcess({
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
  }

  private async muxDownloadArtifacts(row: FileRow, logStream: fs.WriteStream, controller: AbortController): Promise<void> {
    const mediaInputs = await downloadedMediaCandidates(this.config, row);
    if (mediaInputs.length === 0) {
      throw new Error(`download completed but no media artifacts were found for ${row.filename}`);
    }

    const sidecars = await subtitleSidecars(this.config, row);
    const tempPath = path.join(downloadDir(this.config, row.id), `${stripMkv(row.filename)}.muxing.mkv`);
    const muxInputs = await prepareMediaInputsForMux(mediaInputs, logStream, controller.signal);
    const languages = await detectSubtitleLanguages(sidecars, logStream);
    this.logger.debug?.(
      {
        event: 'download.mux.started',
        fileId: row.id,
        mediaInputCount: mediaInputs.length,
        subtitleCount: sidecars.length,
        subtitleLanguages: languages
      },
      'download mux started'
    );
    logStream.write(`muxing ${mediaInputs.length} media artifact(s) and ${sidecars.length} subtitle sidecar(s) into ${row.filename}\n`);
    const result = await runLoggedProcess({
      command: 'ffmpeg',
      args: buildFfmpegDownloadMuxArgs(muxInputs, sidecars, tempPath, languages),
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

    await assertMuxedMediaHasRequiredStreams(tempPath, controller.signal);
    await fsp.rename(tempPath, fileMediaPath(this.config, row));
    this.logger.debug?.({ event: 'download.mux.completed', fileId: row.id }, 'download mux completed');
    logStream.write(`muxed download artifacts into ${row.filename}\n`);
  }

  private async applyCodecTemplate(
    row: FileRow,
    logStream: Pick<fs.WriteStream, 'write'>,
    controller: AbortController
  ): Promise<FileRow> {
    if (!downloadTemplateIncludesCodecs(this.config, row)) {
      return row;
    }

    let codecs: MediaCodecs;
    try {
      codecs = await probeMediaCodecs(fileMediaPath(this.config, row), controller.signal);
    } catch (error) {
      if (controller.signal.aborted) {
        throw new DownloadPipelineError('child_exit_nonzero', 'codec probe cancelled');
      }
      logStream.write(`codec probe failed: ${error instanceof Error ? error.message : String(error)}\n`);
      this.logger.warn({ event: 'download.codec_probe_failed', fileId: row.id, error }, 'download codec probe failed');
      return row;
    }

    const filename = renderDownloadFilename(this.config, {
      ...row,
      videoCodec: codecs.videoCodec,
      audioCodec: codecs.audioCodec
    });
    if (filename === row.filename) {
      return row;
    }

    const currentPath = fileMediaPath(this.config, row);
    const nextRow = { ...row, filename };
    const nextPath = fileMediaPath(this.config, nextRow);
    await fsp.rename(currentPath, nextPath);

    const updated = updateRunningFileFilename(this.db, row.id, filename);
    if (!updated) {
      await fsp.rename(nextPath, currentPath).catch(() => undefined);
      throw new Error(`failed to update filename for running file: ${row.id}`);
    }

    this.logger.debug?.(
      {
        event: 'download.filename_updated',
        fileId: row.id,
        previousFilename: row.filename,
        filename,
        videoCodec: codecs.videoCodec,
        audioCodec: codecs.audioCodec
      },
      'download filename updated'
    );
    logStream.write(`renamed media with codecs: ${row.filename} -> ${filename}\n`);
    return updated;
  }
}

class DownloadPipelineError extends Error {
  constructor(readonly code: ErrorCode, message: string) {
    super(message);
  }
}

interface MediaCodecs {
  videoCodec: string;
  audioCodec: string;
}

interface FfprobeStream {
  codec_type?: unknown;
  codec_name?: unknown;
}

interface FfprobeOutput {
  streams?: FfprobeStream[];
}

function downloadTemplateIncludesCodecs(config: Config, row: Pick<FileRow, 'season' | 'episode'>): boolean {
  const template = row.season != null && row.episode != null ? config.templates.episode : config.templates.movie;
  return /\{(?:videoCodec|audioCodec)\}/.test(template);
}

export function normalizeCodecName(codecName: string): string {
  const normalized = codecName.trim().toLowerCase();
  if (normalized === 'hevc' || normalized === 'h265') {
    return 'h265';
  }
  if (normalized === 'avc1' || normalized === 'h264') {
    return 'h264';
  }
  return normalized;
}

export function parseFfprobeCodecs(output: string): MediaCodecs {
  const parsed = JSON.parse(output) as FfprobeOutput;
  const streams = Array.isArray(parsed.streams) ? parsed.streams : [];
  const video = streams.find((stream) => stream.codec_type === 'video' && typeof stream.codec_name === 'string');
  const audio = streams.find((stream) => stream.codec_type === 'audio' && typeof stream.codec_name === 'string');
  return {
    videoCodec: typeof video?.codec_name === 'string' ? normalizeCodecName(video.codec_name) : '',
    audioCodec: typeof audio?.codec_name === 'string' ? normalizeCodecName(audio.codec_name) : ''
  };
}

export function probeMediaCodecs(filePath: string, signal?: AbortSignal): Promise<MediaCodecs> {
  return new Promise((resolve, reject) => {
    const child = spawn('ffprobe', [
      '-v',
      'error',
      '-show_entries',
      'stream=codec_type,codec_name',
      '-of',
      'json',
      filePath
    ], {
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    let killTimer: NodeJS.Timeout | null = null;

    const terminate = () => {
      if (!child.killed) {
        child.kill('SIGTERM');
        killTimer = setTimeout(() => {
          if (!child.killed) {
            child.kill('SIGKILL');
          }
        }, 1000);
      }
    };

    const settle = (error: Error | null, codecs?: MediaCodecs) => {
      if (settled) {
        return;
      }
      settled = true;
      if (killTimer) {
        clearTimeout(killTimer);
      }
      signal?.removeEventListener('abort', terminate);
      if (error) {
        reject(error);
        return;
      }
      resolve(codecs ?? { videoCodec: '', audioCodec: '' });
    };

    child.stdout?.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', (error) => {
      settle(error);
    });
    child.on('close', (code, signalName) => {
      if (code !== 0) {
        settle(new Error(`ffprobe exited with code ${code ?? 'unknown'}${signalName ? ` by signal ${signalName}` : ''}: ${stderr.trim() || 'no output'}`));
        return;
      }
      try {
        settle(null, parseFfprobeCodecs(stdout));
      } catch (error) {
        settle(error instanceof Error ? error : new Error(String(error)));
      }
    });

    if (signal?.aborted) {
      terminate();
    } else {
      signal?.addEventListener('abort', terminate, { once: true });
    }
  });
}

async function assertMuxedMediaHasRequiredStreams(filePath: string, signal?: AbortSignal): Promise<void> {
  let codecs: MediaCodecs;
  try {
    codecs = await probeMediaCodecs(filePath, signal);
  } catch (error) {
    await fsp.rm(filePath, { force: true });
    const message = error instanceof Error ? error.message : String(error);
    throw new DownloadPipelineError('child_exit_nonzero', `muxed file probe failed: ${message}`);
  }
  const missing = [
    codecs.videoCodec ? '' : 'video',
    codecs.audioCodec ? '' : 'audio'
  ].filter(Boolean);
  if (missing.length > 0) {
    await fsp.rm(filePath, { force: true });
    throw new DownloadPipelineError('child_exit_nonzero', `muxed file is missing ${missing.join(' and ')} stream`);
  }
}

async function renameDownloadLog(config: Config, from: Pick<FileRow, 'id' | 'filename'>, to: Pick<FileRow, 'id' | 'filename'>): Promise<void> {
  const fromPath = fileLogPath(config, from);
  const toPath = fileLogPath(config, to);
  if (fromPath === toPath) {
    return;
  }
  await fsp.mkdir(path.dirname(toPath), { recursive: true });
  await fsp.rename(fromPath, toPath);
}

export function buildSvtplayDownloadArgs(
  config: Config,
  row: FileRow
): string[] {
  const args = [
    `--resolution=${row.quality}`,
    '--force',
    '--output-format=mkv',
    '--subtitle',
    '--all-subtitles',
    '--no-merge',
    `--output=${downloadDir(config, row.id)}`,
    `--filename=${stripMkv(row.filename)}.{ext}`,
    row.url
  ];
  if (svtplayDlVerboseEnabled(config.logLevel)) {
    args.splice(1, 0, '--verbose');
  }
  return args;
}

function svtplayDlVerboseEnabled(logLevel: string): boolean {
  return ['trace', 'debug'].includes(logLevel.toLowerCase());
}

export function buildFfmpegDownloadMuxArgs(
  mediaPaths: string[],
  subtitlePaths: string[],
  outputPath: string,
  languages = subtitlePaths.map((subtitlePath) => subtitleLanguageFromPath(subtitlePath))
): string[] {
  const args = ['-y'];

  for (const mediaPath of mediaPaths) {
    if (/\.ts$/i.test(mediaPath)) {
      args.push(
        '-analyzeduration',
        '500M',
        '-probesize',
        '500M',
        '-max_probe_packets',
        '500000',
        '-scan_all_pmts',
        '1',
        '-merge_pmt_versions',
        '1',
        '-f',
        'mpegts'
      );
    }
    args.push('-i', mediaPath);
  }
  for (const subtitlePath of subtitlePaths) {
    args.push('-i', subtitlePath);
  }

  mediaPaths.forEach((mediaPath, index) => {
    if (isLikelyAudioOnlyArtifact(mediaPath)) {
      args.push('-map', `${index}:a?`);
    } else {
      args.push('-map', `${index}:v?`, '-map', `${index}:a?`);
    }
  });

  subtitlePaths.forEach((subtitlePath, index) => {
    args.push('-map', `${mediaPaths.length + index}:0`);
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

export const buildFfmpegSubtitleMuxArgs = (
  mediaPath: string,
  subtitlePaths: string[],
  outputPath: string,
  languages = subtitlePaths.map((subtitlePath) => subtitleLanguageFromPath(subtitlePath))
): string[] => buildFfmpegDownloadMuxArgs([mediaPath], subtitlePaths, outputPath, languages);

function isLikelyAudioOnlyArtifact(filePath: string): boolean {
  return /\.audio(?:\.nzb-relay)?\.[^.]+$/i.test(path.basename(filePath));
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

export async function downloadedMediaCandidates(config: Config, row: FileRow): Promise<string[]> {
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
    .filter((entry) => /\.(mkv|mp4|ts)$/i.test(entry))
    .map((entry) => path.join(dir, entry))
    .filter((entry) => !/\.muxing\.mkv$/i.test(entry))
    .sort((left, right) => mediaArtifactSortKey(left).localeCompare(mediaArtifactSortKey(right)));
}

export async function prepareMediaInputsForMux(
  mediaInputs: string[],
  logStream: Pick<fs.WriteStream, 'write'>,
  signal?: AbortSignal
): Promise<string[]> {
  const prepared: string[] = [];
  for (const mediaInput of mediaInputs) {
    if (!/\.ts$/i.test(mediaInput)) {
      prepared.push(mediaInput);
      continue;
    }

    if (!(await isMpegTsFile(mediaInput))) {
      const aliasPath = nonMpegTsAliasPath(mediaInput);
      await linkOrCopyFile(mediaInput, aliasPath);
      prepared.push(aliasPath);
      logStream.write(`using non-MPEG-TS media artifact ${path.basename(mediaInput)} as ${path.basename(aliasPath)}\n`);
      continue;
    }

    const normalizedPath = normalizedTsPath(mediaInput);
    const stats = await normalizeMpegTsPackets(mediaInput, normalizedPath, signal);
    prepared.push(normalizedPath);
    logStream.write(
      `normalized MPEG-TS packets ${path.basename(mediaInput)} -> ${path.basename(normalizedPath)} ` +
        `(188=${stats.packet188}, 192=${stats.packet192}, 204=${stats.packet204})\n`
    );
  }
  return prepared;
}

function normalizedTsPath(filePath: string): string {
  return filePath.replace(/\.ts$/i, '.normalized.ts');
}

function nonMpegTsAliasPath(filePath: string): string {
  return filePath.replace(/\.ts$/i, '.nzb-relay.mp4');
}

async function isMpegTsFile(filePath: string): Promise<boolean> {
  const handle = await fsp.open(filePath, 'r');
  try {
    const buffer = Buffer.allocUnsafe(408);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return detectMpegTsPacket(buffer.subarray(0, bytesRead), 0) !== null;
  } finally {
    await handle.close();
  }
}

async function linkOrCopyFile(fromPath: string, toPath: string): Promise<void> {
  await fsp.rm(toPath, { force: true });
  try {
    await fsp.link(fromPath, toPath);
  } catch {
    await fsp.copyFile(fromPath, toPath);
  }
}

interface MpegTsNormalizeStats {
  packet188: number;
  packet192: number;
  packet204: number;
}

interface MpegTsPacket {
  packetSize: 188 | 192 | 204;
  payloadOffset: number;
}

export async function normalizeMpegTsPackets(
  inputPath: string,
  outputPath: string,
  signal?: AbortSignal
): Promise<MpegTsNormalizeStats> {
  const input = await fsp.open(inputPath, 'r');
  const output = await fsp.open(outputPath, 'w');
  const readBuffer = Buffer.allocUnsafe(1024 * 1024);
  let carry: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  const stats: MpegTsNormalizeStats = { packet188: 0, packet192: 0, packet204: 0 };

  try {
    while (true) {
      if (signal?.aborted) {
        throw new DownloadPipelineError('child_exit_nonzero', 'mpegts normalization cancelled');
      }

      const { bytesRead } = await input.read(readBuffer, 0, readBuffer.length, null);
      const final = bytesRead === 0;
      carry = final ? carry : Buffer.concat([carry, readBuffer.subarray(0, bytesRead)]);
      carry = await normalizeMpegTsBuffer(carry, output, stats, final);

      if (final) {
        break;
      }
    }
  } catch (error) {
    await fsp.rm(outputPath, { force: true });
    throw error;
  } finally {
    await input.close();
    await output.close();
  }

  return stats;
}

async function normalizeMpegTsBuffer(
  data: Buffer,
  output: FileHandle,
  stats: MpegTsNormalizeStats,
  final: boolean
): Promise<Buffer> {
  let offset = 0;
  const holdBack = 408;

  while (offset < data.length) {
    if (!final && data.length - offset < holdBack) {
      break;
    }

    const packet = detectMpegTsPacket(data, offset);
    if (!packet) {
      if (!final) {
        break;
      }
      throw new DownloadPipelineError(
        'child_exit_nonzero',
        `could not normalize MPEG-TS packet at byte ${offset}; remaining=${data.length - offset}`
      );
    }
    if (data.length - offset < packet.packetSize) {
      if (!final) {
        break;
      }
      throw new DownloadPipelineError(
        'child_exit_nonzero',
        `truncated MPEG-TS packet at byte ${offset}; expected=${packet.packetSize}, remaining=${data.length - offset}`
      );
    }

    await output.write(data.subarray(offset + packet.payloadOffset, offset + packet.payloadOffset + 188));
    if (packet.packetSize === 188) {
      stats.packet188 += 1;
    } else if (packet.packetSize === 192) {
      stats.packet192 += 1;
    } else {
      stats.packet204 += 1;
    }
    offset += packet.packetSize;
  }

  return data.subarray(offset);
}

function detectMpegTsPacket(buffer: Buffer, offset: number): MpegTsPacket | null {
  const remaining = buffer.length - offset;
  if (buffer[offset + 4] === 0x47 && (buffer[offset] !== 0x47 || remaining === 192)) {
    return { packetSize: 192, payloadOffset: 4 };
  }
  if (buffer[offset] !== 0x47) {
    return null;
  }
  if (remaining === 204) {
    return { packetSize: 204, payloadOffset: 0 };
  }
  if (remaining === 188) {
    return { packetSize: 188, payloadOffset: 0 };
  }

  const next188 = hasMpegTsPacketStart(buffer, offset + 188);
  const next204 = hasMpegTsPacketStart(buffer, offset + 204);
  if (next204 && !next188) {
    return { packetSize: 204, payloadOffset: 0 };
  }
  return { packetSize: 188, payloadOffset: 0 };
}

function hasMpegTsPacketStart(buffer: Buffer, offset: number): boolean {
  if (offset >= buffer.length) {
    return false;
  }
  return buffer[offset] === 0x47 || buffer[offset + 4] === 0x47;
}

function mediaArtifactSortKey(filePath: string): string {
  const basename = path.basename(filePath);
  if (isLikelyAudioOnlyArtifact(filePath)) {
    return `1-${basename}`;
  }
  return `0-${basename}`;
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
