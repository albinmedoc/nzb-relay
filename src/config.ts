import path from 'node:path';
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
  };
  webhooks: {
    defaultUrl: string;
    downloadCompletedUrl: string;
    downloadFailedUrl: string;
    nzbCompletedUrl: string;
    nzbFailedUrl: string;
    secret: string;
  };
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

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const dataDir = path.resolve(env.DATA_DIR ?? '/data');

  return {
    version: env.VERSION ?? env.npm_package_version ?? '0.1.0',
    port: readInt(env.PORT, 3001, 'PORT'),
    apiKey: env.API_KEY ?? '',
    dataDir,
    dbPath: path.join(dataDir, 'app.db'),
    lockPath: path.join(dataDir, 'app.lock'),
    downloadsDir: path.join(dataDir, 'downloads'),
    nzbDir: path.join(dataDir, 'nzb'),
    logLevel: env.LOG_LEVEL ?? 'info',
    stagingMultiplier: readFloat(env.STAGING_MULTIPLIER, 2.2, 'STAGING_MULTIPLIER'),
    templates: {
      episode: env.TEMPLATE_EPISODE ?? DEFAULT_TEMPLATES.episode,
      movie: env.TEMPLATE_MOVIE ?? DEFAULT_TEMPLATES.movie,
      seasonPack: env.TEMPLATE_SEASON_PACK ?? DEFAULT_TEMPLATES.seasonPack
    },
    usenet: {
      host: env.USENET_HOST ?? '',
      port: readInt(env.USENET_PORT, 563, 'USENET_PORT'),
      ssl: readBool(env.USENET_SSL, true),
      user: env.USENET_USER ?? '',
      pass: env.USENET_PASS ?? '',
      newsgroups: readNewsgroups(env)
    },
    webhooks: {
      defaultUrl: env.WEBHOOK_URL ?? '',
      downloadCompletedUrl: env.WEBHOOK_DOWNLOAD_COMPLETED_URL ?? '',
      downloadFailedUrl: env.WEBHOOK_DOWNLOAD_FAILED_URL ?? '',
      nzbCompletedUrl: env.WEBHOOK_NZB_COMPLETED_URL ?? '',
      nzbFailedUrl: env.WEBHOOK_NZB_FAILED_URL ?? '',
      secret: env.WEBHOOK_SECRET ?? ''
    }
  };
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
  if (!value) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${name} must be an integer`);
  }
  return parsed;
}

function readFloat(value: string | undefined, fallback: number, name: string): number {
  if (!value) {
    return fallback;
  }
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive number`);
  }
  return parsed;
}

function readBool(value: string | undefined, fallback: boolean): boolean {
  if (value == null || value === '') {
    return fallback;
  }
  return value.toLowerCase() === 'true';
}

function readNewsgroups(env: NodeJS.ProcessEnv): string[] {
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
