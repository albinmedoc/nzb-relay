import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '../src/config.js';
import type { FileRow } from '../src/types.js';
import { buildSvtplayDownloadArgs, removeDownloadSidecars } from '../src/workers/download-worker.js';
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
      '-M',
      '--all-subtitles',
      `--output=${path.join(dataDir, 'downloads', 'file-1')}`,
      '--filename=Title.svtplay.{ext}',
      'https://www.svtplay.se/video/1'
    ]);
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
});
