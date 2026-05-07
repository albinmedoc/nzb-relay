import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildParparArgs } from '../src/workers/nzb-worker.js';

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
});
