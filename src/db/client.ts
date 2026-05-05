import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import lockfile from 'proper-lockfile';
import type { Config } from '../config.js';

export type AppDatabase = Database.Database;

export function ensureDataDirectories(config: Config): void {
  fs.mkdirSync(config.dataDir, { recursive: true });
  fs.mkdirSync(config.downloadsDir, { recursive: true });
  fs.mkdirSync(config.nzbDir, { recursive: true });
}

export function openDatabase(config: Config): AppDatabase {
  ensureDataDirectories(config);
  const db = new Database(config.dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  return db;
}

export function runMigrations(db: AppDatabase, migrationsFolder = path.resolve('drizzle')): void {
  migrate(drizzle(db), { migrationsFolder });
}

export async function acquireSingleInstanceLock(config: Config): Promise<() => Promise<void>> {
  ensureDataDirectories(config);
  fs.closeSync(fs.openSync(config.lockPath, 'a'));
  return lockfile.lock(config.lockPath, {
    realpath: false,
    retries: 0
  });
}
