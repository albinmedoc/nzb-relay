import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildNyuuArgs, buildParparArgs, newsgroupsForUpload } from '../src/workers/nzb-worker.js';
import { testConfig } from './helpers.js';

describe('nzb worker', () => {
  it('uses a byte-sized parpar input slice option', () => {
    const workDir = path.join('/data', 'nzb', 'nzb-1');
    const rarPart = path.join(workDir, 'Release.part1.rar');

    expect(buildParparArgs(workDir, 'Release', [rarPart])).toEqual([
      '--input-slices=768000b',
      '-r',
      '10%',
      '-o',
      path.join(workDir, 'Release.par2'),
      rarPart
    ]);
  });

  it('randomly selects the configured number of newsgroups for an upload', () => {
    const config = testConfig('/data', {
      USENET_NEWSGROUPS: 'alt.binaries.one,alt.binaries.two,alt.binaries.three',
      USENET_NEWSGROUPS_PER_UPLOAD: '2'
    });

    expect(newsgroupsForUpload(config, (maxExclusive) => maxExclusive - 1)).toEqual([
      'alt.binaries.three',
      'alt.binaries.two'
    ]);
  });

  it('uses the limited newsgroup list in nyuu args', () => {
    const config = testConfig('/data', {
      USENET_HOST: 'news.example.com',
      USENET_USER: 'user',
      USENET_PASS: 'pass',
      USENET_NEWSGROUPS: 'alt.binaries.one,alt.binaries.two,alt.binaries.three',
      USENET_NEWSGROUPS_PER_UPLOAD: '2'
    });
    const args = buildNyuuArgs(
      config,
      { releaseName: 'Release', nzbFile: 'nzb-1.nzb' },
      'secret',
      [path.join('/data', 'nzb', 'nzb-1', 'Release.rar')],
      (maxExclusive) => maxExclusive - 1
    );

    expect(args.slice(args.indexOf('--groups'), args.indexOf('--groups') + 2)).toEqual([
      '--groups',
      'alt.binaries.three,alt.binaries.two'
    ]);
  });
});
