import path from 'node:path';
import { z } from 'zod';
import type { WebhookEvent } from './types.js';

export interface Config {
  version: string;
  port: number;
  apiKey: string;
  dataDir: string;
  dbPath: string;
  lockPath: string;
  downloadsDir: string;
  nzbDir: string;
  logLevel: string;
  stagingMultiplier: number;
  cors: {
    origins: '*' | string[];
  };
  watchlist: {
    pollIntervalSeconds: number;
    reconcileIntervalSeconds: number;
    autoNzb: boolean;
    maxAttempts: number;
  };
  templates: {
    episode: string;
    movie: string;
    seasonPack: string;
  };
  usenet: {
    host: string;
    port: number;
    ssl: boolean;
    user: string;
    pass: string;
    newsgroups: string[];
    newsgroupsPerUpload: number;
  };
  indexerUploads: IndexerUploadConfig[];
  webhooks: {
    defaultUrl: string;
    downloadCompletedUrl: string;
    downloadFailedUrl: string;
    nzbCompletedUrl: string;
    nzbFailedUrl: string;
    secret: string;
  };
}

export interface IndexerUploadConfig {
  name: string;
  url: string;
  method: 'POST' | 'PUT';
  format: 'multipart' | 'raw';
  fileField: string;
  filenameTemplate: string;
  headers: Record<string, string>;
  fields: Record<string, string>;
}

const DEFAULT_TEMPLATES = {
  episode: '{title}.s{season}e{episode}.{service}.{ext}',
  movie: '{title}.{service}.{ext}',
  seasonPack: '{title}.s{season}.{service}.{ext}'
};

const DEFAULT_USENET_NEWSGROUPS = [
  'alt.binaries.newznzb.alpha',
  'alt.binaries.newznzb.bravo',
  'alt.binaries.newznzb.charlie',
  'alt.binaries.newznzb.delta',
  'alt.binaries.newznzb.echo',
  'alt.binaries.newznzb.foxtrot',
  'alt.binaries.newznzb.golf',
  'alt.binaries.newznzb.hotel',
  'alt.binaries.newznzb.india',
  'alt.binaries.newznzb.juliett',
  'alt.binaries.newznzb.kilo',
  'alt.binaries.newznzb.lima',
  'alt.binaries.newznzb.mike',
  'alt.binaries.newznzb.november',
  'alt.binaries.newznzb.oscar',
  'alt.binaries.newznzb.papa',
  'alt.binaries.newznzb.quebec',
  'alt.binaries.newznzb.romeo',
  'alt.binaries.newznzb.sierra',
  'alt.binaries.newznzb.tango',
  'alt.binaries.newznzb.uniform',
  'alt.binaries.newznzb.victor',
  'alt.binaries.newznzb.whiskey',
  'alt.binaries.newznzb.xray',
  'alt.binaries.newznzb.yankee',
  'alt.binaries.newznzb.zulu'
];

const envSchema = z
  .object({
    VERSION: z.string().optional(),
    PORT: z.string().optional(),
    API_KEY: z.string().optional(),
    DATA_DIR: z.string().optional(),
    LOG_LEVEL: z.string().optional(),
    STAGING_MULTIPLIER: z.string().optional(),
    CORS_ORIGINS: z.string().optional(),
    WATCHLIST_POLL_INTERVAL_SECONDS: z.string().optional(),
    WATCHLIST_RECONCILE_INTERVAL_SECONDS: z.string().optional(),
    WATCHLIST_AUTO_NZB: z.string().optional(),
    WATCHLIST_MAX_ATTEMPTS: z.string().optional(),
    TEMPLATE_EPISODE: z.string().optional(),
    TEMPLATE_MOVIE: z.string().optional(),
    TEMPLATE_SEASON_PACK: z.string().optional(),
    USENET_HOST: z.string().optional(),
    USENET_PORT: z.string().optional(),
    USENET_SSL: z.string().optional(),
    USENET_USER: z.string().optional(),
    USENET_PASS: z.string().optional(),
    USENET_NEWSGROUPS: z.string().optional(),
    USENET_NEWSGROUP: z.string().optional(),
    USENET_RELEASE_GROUP: z.string().optional(),
    USENET_NEWSGROUPS_PER_UPLOAD: z.string().optional(),
    INDEXER_UPLOADS_JSON: z.string().optional(),
    WEBHOOK_URL: z.string().optional(),
    WEBHOOK_DOWNLOAD_COMPLETED_URL: z.string().optional(),
    WEBHOOK_DOWNLOAD_FAILED_URL: z.string().optional(),
    WEBHOOK_NZB_COMPLETED_URL: z.string().optional(),
    WEBHOOK_NZB_FAILED_URL: z.string().optional(),
    WEBHOOK_SECRET: z.string().optional()
  })
  .passthrough();

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsedEnv = envSchema.parse(env);
  const dataDir = path.resolve(parsedEnv.DATA_DIR ?? '/data');

  return {
    version: parsedEnv.VERSION ?? '0.0.0',
    port: readInt(parsedEnv.PORT, 3001, 'PORT'),
    apiKey: parsedEnv.API_KEY ?? '',
    dataDir,
    dbPath: path.join(dataDir, 'app.db'),
    lockPath: path.join(dataDir, 'app.lock'),
    downloadsDir: path.join(dataDir, 'downloads'),
    nzbDir: path.join(dataDir, 'nzb'),
    logLevel: parsedEnv.LOG_LEVEL ?? 'info',
    stagingMultiplier: readFloat(parsedEnv.STAGING_MULTIPLIER, 2.2, 'STAGING_MULTIPLIER'),
    cors: {
      origins: readCorsOrigins(parsedEnv.CORS_ORIGINS)
    },
    watchlist: {
      pollIntervalSeconds: readPositiveInt(
        parsedEnv.WATCHLIST_POLL_INTERVAL_SECONDS,
        3600,
        'WATCHLIST_POLL_INTERVAL_SECONDS'
      ),
      reconcileIntervalSeconds: readPositiveInt(
        parsedEnv.WATCHLIST_RECONCILE_INTERVAL_SECONDS,
        10,
        'WATCHLIST_RECONCILE_INTERVAL_SECONDS'
      ),
      autoNzb: readBool(parsedEnv.WATCHLIST_AUTO_NZB, true),
      maxAttempts: readPositiveInt(parsedEnv.WATCHLIST_MAX_ATTEMPTS, 3, 'WATCHLIST_MAX_ATTEMPTS')
    },
    templates: {
      episode: parsedEnv.TEMPLATE_EPISODE ?? DEFAULT_TEMPLATES.episode,
      movie: parsedEnv.TEMPLATE_MOVIE ?? DEFAULT_TEMPLATES.movie,
      seasonPack: parsedEnv.TEMPLATE_SEASON_PACK ?? DEFAULT_TEMPLATES.seasonPack
    },
    usenet: {
      host: parsedEnv.USENET_HOST ?? '',
      port: readInt(parsedEnv.USENET_PORT, 563, 'USENET_PORT'),
      ssl: readBool(parsedEnv.USENET_SSL, true),
      user: parsedEnv.USENET_USER ?? '',
      pass: parsedEnv.USENET_PASS ?? '',
      newsgroups: readNewsgroups(parsedEnv),
      newsgroupsPerUpload: readPositiveInt(
        parsedEnv.USENET_NEWSGROUPS_PER_UPLOAD,
        20,
        'USENET_NEWSGROUPS_PER_UPLOAD'
      )
    },
    indexerUploads: readIndexerUploads(parsedEnv.INDEXER_UPLOADS_JSON),
    webhooks: {
      defaultUrl: parsedEnv.WEBHOOK_URL ?? '',
      downloadCompletedUrl: parsedEnv.WEBHOOK_DOWNLOAD_COMPLETED_URL ?? '',
      downloadFailedUrl: parsedEnv.WEBHOOK_DOWNLOAD_FAILED_URL ?? '',
      nzbCompletedUrl: parsedEnv.WEBHOOK_NZB_COMPLETED_URL ?? '',
      nzbFailedUrl: parsedEnv.WEBHOOK_NZB_FAILED_URL ?? '',
      secret: parsedEnv.WEBHOOK_SECRET ?? ''
    }
  };
}

const indexerUploadSchema = z
  .object({
    name: z.string().trim().min(1),
    url: z.string().trim().url(),
    method: z.enum(['POST', 'PUT']).optional(),
    format: z.enum(['multipart', 'raw']).optional(),
    fileField: z.string().min(1).optional(),
    filenameTemplate: z.string().min(1).optional(),
    headers: z.record(z.string(), z.string()).optional(),
    fields: z.record(z.string(), z.string()).optional()
  })
  .strict();

function readIndexerUploads(value: string | undefined): IndexerUploadConfig[] {
  if (!value) {
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error('INDEXER_UPLOADS_JSON must be valid JSON');
  }

  const entries = z.array(indexerUploadSchema).parse(parsed).map((entry) => ({
    name: entry.name,
    url: entry.url,
    method: entry.method ?? 'POST',
    format: entry.format ?? 'multipart',
    fileField: entry.fileField ?? 'file',
    filenameTemplate: entry.filenameTemplate ?? '{releaseName}.nzb',
    headers: entry.headers ?? {},
    fields: entry.fields ?? {}
  }));

  const seen = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry.name)) {
      throw new Error(`duplicate indexer upload name: ${entry.name}`);
    }
    seen.add(entry.name);
  }

  return entries;
}

export function resolveWebhookUrl(config: Config, event: WebhookEvent): string {
  const specific = {
    'download.completed': config.webhooks.downloadCompletedUrl,
    'download.failed': config.webhooks.downloadFailedUrl,
    'nzb.completed': config.webhooks.nzbCompletedUrl,
    'nzb.failed': config.webhooks.nzbFailedUrl
  } satisfies Record<WebhookEvent, string>;

  return specific[event] || config.webhooks.defaultUrl;
}

export function assertUsenetConfigured(config: Config): void {
  const missing = [
    ['USENET_HOST', config.usenet.host],
    ['USENET_USER', config.usenet.user],
    ['USENET_PASS', config.usenet.pass],
    ['USENET_NEWSGROUPS', config.usenet.newsgroups.length > 0 ? 'configured' : '']
  ]
    .filter(([, value]) => !value)
    .map(([name]) => name);

  if (missing.length > 0) {
    throw new Error(`missing Usenet configuration: ${missing.join(', ')}`);
  }
}

function readInt(value: string | undefined, fallback: number, name: string): number {
  return z
    .string()
    .optional()
    .transform((raw) => {
      if (!raw) {
        return fallback;
      }
      const parsed = Number.parseInt(raw, 10);
      if (!Number.isFinite(parsed)) {
        throw new Error(`${name} must be an integer`);
      }
      return parsed;
    })
    .parse(value);
}

function readPositiveInt(value: string | undefined, fallback: number, name: string): number {
  const parsed = readInt(value, fallback, name);
  if (parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function readFloat(value: string | undefined, fallback: number, name: string): number {
  return z
    .string()
    .optional()
    .transform((raw) => {
      if (!raw) {
        return fallback;
      }
      const parsed = Number.parseFloat(raw);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error(`${name} must be a positive number`);
      }
      return parsed;
    })
    .parse(value);
}

function readBool(value: string | undefined, fallback: boolean): boolean {
  return z
    .string()
    .optional()
    .transform((raw) => {
      if (raw == null || raw === '') {
        return fallback;
      }
      return raw.toLowerCase() === 'true';
    })
    .parse(value);
}

function readCorsOrigins(value: string | undefined): '*' | string[] {
  if (!value) {
    return [];
  }
  const origins = value
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
  if (origins.includes('*')) {
    return '*';
  }
  return origins;
}

function readNewsgroups(env: z.infer<typeof envSchema>): string[] {
  const value = env.USENET_NEWSGROUPS || env.USENET_NEWSGROUP || env.USENET_RELEASE_GROUP;
  if (!value) {
    return [...DEFAULT_USENET_NEWSGROUPS];
  }

  const newsgroups = value
    .split(',')
    .map((newsgroup) => newsgroup.trim())
    .filter(Boolean);

  return newsgroups.length > 0 ? newsgroups : [...DEFAULT_USENET_NEWSGROUPS];
}
