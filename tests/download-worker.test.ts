import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '../src/config.js';
import type { FileRow } from '../src/types.js';
import {
  buildFfmpegDownloadMuxArgs,
  buildFfmpegSubtitleMuxArgs,
  buildSvtplayDownloadArgs,
  downloadedMediaCandidates,
  normalizeCodecName,
  normalizeMpegTsPackets,
  parseFfprobeCodecs,
  removeDownloadSidecars,
  subtitleLanguageFromPath,
  subtitleTextForLanguageDetection
} from '../src/workers/download-worker.js';
import { downloadDir } from '../src/utils/paths.js';
import { cleanup, createTempDataDir, testConfig } from './helpers.js';

let dataDir: string;
let config: Config;

beforeEach(async () => {
  dataDir = await createTempDataDir();
  config = testConfig(dataDir);
});

afterEach(async () => {
  await cleanup(dataDir);
});

describe('download worker', () => {
  it('uses the current svtplay-dl mkv output flag', () => {
    const row: FileRow = {
      id: 'file-1',
      url: 'https://www.svtplay.se/video/1',
      status: 'running',
      title: 'Title',
      filename: 'Title.svtplay.mkv',
      service: 'svtplay',
      quality: '1080',
      season: null,
      episode: null,
      downloadedAt: null,
      createdAt: '2026-05-06T00:00:00.000Z',
      deleted: 0,
      errorCode: null,
      error: null
    };

    expect(buildSvtplayDownloadArgs(config, row)).toEqual([
      '--resolution=1080',
      '--force',
      '--output-format=mkv',
      '--subtitle',
      '--all-subtitles',
      '--no-merge',
      `--output=${path.join(dataDir, 'downloads', 'file-1')}`,
      '--filename=Title.svtplay.{ext}',
      'https://www.svtplay.se/video/1'
    ]);
  });

  it('builds ffmpeg args to mux subtitle sidecars into the mkv', () => {
    expect(buildFfmpegSubtitleMuxArgs(
      '/data/downloads/file-1/Title.svtplay.mkv',
      [
        '/data/downloads/file-1/Title.svtplay.en.srt',
        '/data/downloads/file-1/Title.svtplay.sv.srt'
      ],
      '/data/downloads/file-1/Title.svtplay.muxing.mkv',
      ['eng', 'swe']
    )).toEqual([
      '-y',
      '-i',
      '/data/downloads/file-1/Title.svtplay.mkv',
      '-i',
      '/data/downloads/file-1/Title.svtplay.en.srt',
      '-i',
      '/data/downloads/file-1/Title.svtplay.sv.srt',
      '-map',
      '0:v?',
      '-map',
      '0:a?',
      '-map',
      '1:0',
      '-metadata:s:s:0',
      'language=eng',
      '-map',
      '2:0',
      '-metadata:s:s:1',
      'language=swe',
      '-map_metadata',
      '0',
      '-map_chapters',
      '0',
      '-c',
      'copy',
      '-c:s',
      'srt',
      '/data/downloads/file-1/Title.svtplay.muxing.mkv'
    ]);
  });

  it('builds ffmpeg args to mux separate MPEG-TS video and audio artifacts', () => {
    expect(buildFfmpegDownloadMuxArgs(
      [
        '/data/downloads/file-1/Title.svtplay.ts',
        '/data/downloads/file-1/Title.svtplay.audio.ts'
      ],
      [],
      '/data/downloads/file-1/Title.svtplay.muxing.mkv',
      []
    )).toEqual([
      '-y',
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
      'mpegts',
      '-i',
      '/data/downloads/file-1/Title.svtplay.ts',
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
      'mpegts',
      '-i',
      '/data/downloads/file-1/Title.svtplay.audio.ts',
      '-map',
      '0:v?',
      '-map',
      '0:a?',
      '-map',
      '1:a?',
      '-map_metadata',
      '0',
      '-map_chapters',
      '0',
      '-c',
      'copy',
      '-c:s',
      'srt',
      '/data/downloads/file-1/Title.svtplay.muxing.mkv'
    ]);
  });

  it('uses explicit SVT subtitle filename languages and otherwise falls back to undetermined', () => {
    expect(subtitleLanguageFromPath('/data/downloads/file-1/Title.svtplay.lulesamiska.srt')).toBe('smj');
    expect(subtitleLanguageFromPath('/data/downloads/file-1/Title.svtplay.meankieli.srt')).toBe('fit');
    expect(subtitleLanguageFromPath('/data/downloads/file-1/Title.svtplay.jiddisch.srt')).toBe('yid');
    expect(subtitleLanguageFromPath('/data/downloads/file-1/Title.svtplay.sv.srt')).toBe('und');
    expect(subtitleLanguageFromPath('/data/downloads/file-1/Title.svtplay.sv-SE.srt')).toBe('und');
    expect(subtitleLanguageFromPath('/data/downloads/file-1/Title.svtplay.en.vtt')).toBe('und');
    expect(subtitleLanguageFromPath('/data/downloads/file-1/Title.svtplay.se.srt')).toBe('und');
    expect(subtitleLanguageFromPath('/data/downloads/file-1/Title.svtplay.unknown.srt')).toBe('und');
  });

  it('accepts svtplay-dl media when it already uses the final mkv filename', async () => {
    const row = {
      id: 'file-1',
      filename: 'Rattatouille.1080p.-HAVSORN.mkv'
    } as FileRow;
    const dir = downloadDir(config, row.id);
    const mediaPath = path.join(dir, row.filename);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(mediaPath, 'media');
    await fs.writeFile(path.join(dir, 'Rattatouille.1080p.-HAVSORN.muxing.mkv'), 'partial');

    expect(await downloadedMediaCandidates(config, row)).toEqual([mediaPath]);
  });

  it('parses and normalizes ffprobe codec names', () => {
    expect(normalizeCodecName('hevc')).toBe('h265');
    expect(normalizeCodecName('avc1')).toBe('h264');
    expect(
      parseFfprobeCodecs(JSON.stringify({
        streams: [
          { codec_type: 'video', codec_name: 'hevc' },
          { codec_type: 'audio', codec_name: 'aac' }
        ]
      }))
    ).toEqual({ videoCodec: 'h265', audioCodec: 'aac' });
  });

  it('extracts subtitle text for language detection', async () => {
    const subtitlePath = path.join(dataDir, 'Title.svtplay.sv.srt');
    await fs.writeFile(subtitlePath, [
      'WEBVTT',
      '',
      '1',
      '00:00:01.000 --> 00:00:03.000',
      '<i>Hej och välkommen.</i>',
      '',
      '2',
      '00:00:04.000 --> 00:00:05.000',
      'Det här är en testtext.'
    ].join('\n'));

    await expect(subtitleTextForLanguageDetection(subtitlePath)).resolves.toBe(
      'Hej och välkommen. Det här är en testtext.'
    );
  });

  it('removes all non-media sidecars after a successful download', async () => {
    const row: Pick<FileRow, 'id' | 'filename'> = {
      id: 'file-1',
      filename: 'Title.svtplay.mkv'
    };
    const dir = downloadDir(config, row.id);
    await fs.mkdir(dir, { recursive: true });
    await Promise.all([
      fs.writeFile(path.join(dir, 'Title.svtplay.mkv'), 'media'),
      fs.writeFile(path.join(dir, 'Title.svtplay.log'), 'log'),
      fs.writeFile(path.join(dir, 'Title.svtplay.sv.srt'), 'subtitle'),
      fs.writeFile(path.join(dir, 'Title.svtplay.en.vtt'), 'subtitle'),
      fs.writeFile(path.join(dir, 'Title.svtplay.ttml'), 'subtitle'),
      fs.writeFile(path.join(dir, 'Title.svtplay.nfo'), 'metadata')
    ]);
    const logStream = { write: vi.fn() };

    await removeDownloadSidecars(config, row, logStream);

    const remaining = await fs.readdir(dir);
    expect(remaining.sort()).toEqual(['Title.svtplay.log', 'Title.svtplay.mkv']);
    expect(logStream.write).toHaveBeenCalledWith('removed download sidecar Title.svtplay.sv.srt\n');
    expect(logStream.write).toHaveBeenCalledWith('removed download sidecar Title.svtplay.en.vtt\n');
    expect(logStream.write).toHaveBeenCalledWith('removed download sidecar Title.svtplay.ttml\n');
    expect(logStream.write).toHaveBeenCalledWith('removed download sidecar Title.svtplay.nfo\n');
  });

  it('normalizes mixed MPEG-TS packet sizes to 188-byte packets', async () => {
    const inputPath = path.join(dataDir, 'mixed.ts');
    const outputPath = path.join(dataDir, 'mixed.normalized.ts');
    const packet188 = mpegTsPacket(0x10);
    const packet192 = Buffer.concat([Buffer.from([1, 2, 3, 4]), mpegTsPacket(0x20)]);
    const packet204 = Buffer.concat([mpegTsPacket(0x30), Buffer.alloc(16, 0xff)]);
    await fs.writeFile(inputPath, Buffer.concat([packet188, packet192, packet204]));

    const stats = await normalizeMpegTsPackets(inputPath, outputPath);

    expect(stats).toEqual({ packet188: 1, packet192: 1, packet204: 1 });
    expect(await fs.readFile(outputPath)).toEqual(Buffer.concat([
      mpegTsPacket(0x10),
      mpegTsPacket(0x20),
      mpegTsPacket(0x30)
    ]));
  });
});

function mpegTsPacket(fill: number): Buffer {
  return Buffer.concat([Buffer.from([0x47]), Buffer.alloc(187, fill)]);
}
