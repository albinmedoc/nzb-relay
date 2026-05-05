import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import pino from 'pino';
import { loadConfig, type Config } from '../src/config.js';
import { openDatabase, runMigrations, type AppDatabase } from '../src/db/client.js';
import { createApp, type WorkerControllers } from '../src/http/routes.js';

export async function createTempDataDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'nzb-relay-'));
}

export function testConfig(dataDir: string, overrides: NodeJS.ProcessEnv = {}): Config {
  return loadConfig({
    DATA_DIR: dataDir,
    PORT: '0',
    LOG_LEVEL: 'silent',
    ...overrides
  });
}

export function createTestDb(config: Config): AppDatabase {
  const db = openDatabase(config);
  runMigrations(db, path.resolve('drizzle'));
  return db;
}

export function createTestApp(db: AppDatabase, config: Config, workers?: WorkerControllers) {
  return createApp({
    db,
    config,
    logger: pino({ enabled: false }),
    workers
  });
}

export async function cleanup(dataDir: string, db?: AppDatabase): Promise<void> {
  db?.close();
  await fs.rm(dataDir, { recursive: true, force: true });
}
