import path from 'node:path';
import type { Config } from '../config.js';
import type { FileRow, NzbRow } from '../types.js';

export function downloadDir(config: Config, fileId: string): string {
  return path.join(config.downloadsDir, fileId);
}

export function fileMediaPath(config: Config, row: FileRow): string {
  return path.join(downloadDir(config, row.id), row.filename);
}

export function fileLogPath(config: Config, row: Pick<FileRow, 'id' | 'filename'>): string {
  return path.join(downloadDir(config, row.id), `${stripMkv(row.filename)}.log`);
}

export function nzbJobDir(config: Config, nzbId: string): string {
  return path.join(config.nzbDir, nzbId);
}

export function nzbWorkDir(config: Config, row: Pick<NzbRow, 'id' | 'nzbFile'>): string {
  return path.dirname(row.nzbFile) === '.'
    ? path.join(config.nzbDir, row.id)
    : path.join(nzbJobDir(config, row.id), 'work');
}

export function nzbFinalPath(config: Config, row: Pick<NzbRow, 'nzbFile'>): string {
  return path.join(config.nzbDir, row.nzbFile);
}

export function nzbLogPath(config: Config, row: Pick<NzbRow, 'nzbFile'>): string {
  const finalPath = nzbFinalPath(config, row);
  return path.join(path.dirname(finalPath), `${stripNzb(path.basename(row.nzbFile))}.log`);
}

export function stripMkv(filename: string): string {
  return filename.toLowerCase().endsWith('.mkv') ? filename.slice(0, -4) : filename;
}

export function stripNzb(filename: string): string {
  return filename.toLowerCase().endsWith('.nzb') ? filename.slice(0, -4) : filename;
}
