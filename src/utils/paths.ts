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

export function nzbWorkDir(config: Config, nzbId: string): string {
  return path.join(config.nzbDir, nzbId);
}

export function nzbFinalPath(config: Config, row: Pick<NzbRow, 'nzbFile'>): string {
  return path.join(config.nzbDir, row.nzbFile);
}

export function nzbLogPath(config: Config, nzbId: string): string {
  return path.join(config.nzbDir, `${nzbId}.log`);
}

export function stripMkv(filename: string): string {
  return filename.toLowerCase().endsWith('.mkv') ? filename.slice(0, -4) : filename;
}

