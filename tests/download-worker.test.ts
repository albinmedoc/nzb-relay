import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Config } from '../src/config.js';
import type { FileRow } from '../src/types.js';
import { buildSvtplayDownloadArgs } from '../src/workers/download-worker.js';
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
      '--output-format=mkv',
      '-M',
      '--all-subtitles',
      `--output=${path.join(dataDir, 'downloads', 'file-1')}`,
      '--filename=Title.svtplay.{ext}',
      'https://www.svtplay.se/video/1'
    ]);
  });
});
