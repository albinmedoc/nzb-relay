import fs from 'node:fs/promises';
import path from 'node:path';
import type { Config } from '../config.js';
import type { FileRow } from '../types.js';
import { downloadDir, fileLogPath, nzbFinalPath, nzbJobDir, nzbLogPath, nzbWorkDir } from './paths.js';
import type { NzbRow } from '../types.js';

export async function removeDownloadDirectory(config: Config, row: Pick<FileRow, 'id'>): Promise<void> {
  await fs.rm(downloadDir(config, row.id), { recursive: true, force: true });
}

export async function removeDownloadPartialsKeepLog(config: Config, row: FileRow): Promise<void> {
  const dir = downloadDir(config, row.id);
  const keep = path.basename(fileLogPath(config, row));

  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return;
    }
    throw error;
  }

  await Promise.all(
    entries
      .filter((entry) => entry !== keep)
      .map((entry) => fs.rm(path.join(dir, entry), { recursive: true, force: true }))
  );
}

export async function removeNzbArtifacts(config: Config, row: Pick<NzbRow, 'id' | 'nzbFile'>): Promise<void> {
  await fs.rm(nzbJobDir(config, row.id), { recursive: true, force: true });
  await fs.rm(nzbWorkDir(config, row), { recursive: true, force: true });
  await fs.rm(nzbLogPath(config, row), { force: true });
  await fs.rm(nzbFinalPath(config, row), { force: true });
}

export async function removeNzbWorkDir(config: Config, row: Pick<NzbRow, 'id' | 'nzbFile'>): Promise<void> {
  await fs.rm(nzbWorkDir(config, row), { recursive: true, force: true });
}
