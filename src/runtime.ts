import type { Server } from 'node:http';
import { serve } from '@hono/node-server';
import type { Logger } from 'pino';
import { assertUsenetConfigured, loadConfig, type Config } from './config.js';
import { acquireSingleInstanceLock, openDatabase, runMigrations, type AppDatabase } from './db/client.js';
import { createLogger } from './logger.js';
import { recoverInterruptedJobs } from './recovery.js';
import { createApp } from './http/routes.js';
import { DownloadWorker } from './workers/download-worker.js';
import { NzbWorker } from './workers/nzb-worker.js';
import { WatchlistWorker } from './workers/watchlist-worker.js';
import { WebhookDispatcher } from './workers/webhook-dispatcher.js';

export interface Runtime {
  config: Config;
  logger: Logger;
  db: AppDatabase;
  app: ReturnType<typeof createApp>;
  workers: {
    downloads: DownloadWorker;
    nzb: NzbWorker;
    watchlist: WatchlistWorker;
    webhooks: WebhookDispatcher;
  };
  startHttp(): Server;
  stop(): Promise<void>;
}

interface CreateRuntimeOptions {
  env?: NodeJS.ProcessEnv;
  startWorkers?: boolean;
  migrate?: boolean;
  migrationsFolder?: string;
  acquireLock?: boolean;
}

export async function createRuntime(options: CreateRuntimeOptions = {}): Promise<Runtime> {
  const config = loadConfig(options.env);
  assertUsenetConfigured(config);
  const logger = createLogger(config);
  const releaseLock = options.acquireLock === false ? null : await acquireSingleInstanceLock(config);
  const db = openDatabase(config);

  try {
    if (options.migrate !== false) {
      runMigrations(db, options.migrationsFolder);
    }

    await recoverInterruptedJobs(db, config, logger);

    const downloads = new DownloadWorker(db, config, logger);
    const nzb = new NzbWorker(db, config, logger);
    const watchlist = new WatchlistWorker(db, config, logger);
    const webhooks = new WebhookDispatcher(db, config, logger);
    const app = createApp({
      db,
      config,
      logger,
      workers: {
        downloads,
        nzb
      }
    });

    if (options.startWorkers !== false) {
      downloads.start();
      nzb.start();
      watchlist.start();
      webhooks.start();
    }

    let server: Server | null = null;

    return {
      config,
      logger,
      db,
      app,
      workers: {
        downloads,
        nzb,
        watchlist,
        webhooks
      },
      startHttp() {
        server = serve({
          fetch: app.fetch,
          port: config.port
        }) as Server;
        logger.info({ port: config.port }, 'http listener started');
        return server;
      },
      async stop() {
        await closeServer(server);
        await Promise.all([downloads.stop(), nzb.stop(), watchlist.stop(), webhooks.stop()]);
        db.close();
        await releaseLock?.();
      }
    };
  } catch (error) {
    db.close();
    await releaseLock?.();
    throw error;
  }
}

function closeServer(server: Server | null): Promise<void> {
  if (!server) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}
