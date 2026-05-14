import { sql } from 'drizzle-orm';
import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

export const file = sqliteTable(
  'file',
  {
    id: text('id').primaryKey(),
    url: text('url').notNull(),
    status: text('status').notNull(),
    title: text('title').notNull(),
    filename: text('filename').notNull(),
    service: text('service').notNull(),
    quality: text('quality').notNull(),
    season: integer('season'),
    episode: integer('episode'),
    downloadedAt: text('downloadedAt'),
    createdAt: text('createdAt').notNull(),
    deleted: integer('deleted').notNull().default(0),
    errorCode: text('errorCode'),
    error: text('error')
  },
  (table) => ({
    activeUrlUnique: uniqueIndex('file_active_url_unique')
      .on(table.url)
      .where(sql`${table.status} IN ('pending', 'running', 'completed') AND ${table.deleted} = 0`),
    statusCreatedAtIdx: index('file_status_created_at_idx').on(table.status, table.createdAt)
  })
);

export const nzb = sqliteTable(
  'nzb',
  {
    id: text('id').primaryKey(),
    status: text('status').notNull(),
    releaseName: text('releaseName').notNull(),
    nzbFile: text('nzbFile').notNull(),
    createdAt: text('createdAt').notNull(),
    postedAt: text('postedAt'),
    errorCode: text('errorCode'),
    error: text('error')
  },
  (table) => ({
    statusCreatedAtIdx: index('nzb_status_created_at_idx').on(table.status, table.createdAt)
  })
);

export const nzbFiles = sqliteTable(
  'nzb_files',
  {
    nzbId: text('nzbId')
      .notNull()
      .references(() => nzb.id, { onDelete: 'cascade' }),
    fileId: text('fileId')
      .notNull()
      .references(() => file.id)
  },
  (table) => ({
    pk: primaryKey({ columns: [table.nzbId, table.fileId] })
  })
);

export const indexerUpload = sqliteTable(
  'indexer_upload',
  {
    id: text('id').primaryKey(),
    nzbId: text('nzbId')
      .notNull()
      .references(() => nzb.id, { onDelete: 'cascade' }),
    indexerName: text('indexerName').notNull(),
    url: text('url').notNull(),
    status: text('status').notNull(),
    attempts: integer('attempts').notNull().default(0),
    nextAttemptAt: text('nextAttemptAt'),
    lastError: text('lastError'),
    createdAt: text('createdAt').notNull(),
    updatedAt: text('updatedAt').notNull(),
    uploadedAt: text('uploadedAt')
  },
  (table) => ({
    nzbNameUnique: uniqueIndex('indexer_upload_nzb_name_unique').on(table.nzbId, table.indexerName),
    statusNextAttemptIdx: index('indexer_upload_status_next_attempt_idx').on(table.status, table.nextAttemptAt)
  })
);

export const webhookDeliveries = sqliteTable(
  'webhook_deliveries',
  {
    id: text('id').primaryKey(),
    event: text('event').notNull(),
    url: text('url').notNull(),
    payload: text('payload').notNull(),
    attempts: integer('attempts').notNull().default(0),
    nextAttemptAt: text('nextAttemptAt'),
    status: text('status').notNull(),
    lastError: text('lastError'),
    createdAt: text('createdAt').notNull()
  },
  (table) => ({
    statusNextAttemptIdx: index('webhook_status_next_attempt_idx').on(table.status, table.nextAttemptAt)
  })
);

export const watchlistSource = sqliteTable(
  'watchlist_source',
  {
    id: text('id').primaryKey(),
    service: text('service').notNull(),
    type: text('type').notNull(),
    url: text('url').notNull(),
    title: text('title'),
    enabled: integer('enabled').notNull().default(1),
    backfill: integer('backfill').notNull().default(1),
    deleteFileAfterNzb: integer('deleteFileAfterNzb').notNull().default(1),
    firstScanCompleted: integer('firstScanCompleted').notNull().default(0),
    lastScannedAt: text('lastScannedAt'),
    nextScanAt: text('nextScanAt'),
    lastErrorCode: text('lastErrorCode'),
    lastError: text('lastError'),
    createdAt: text('createdAt').notNull(),
    updatedAt: text('updatedAt').notNull()
  },
  (table) => ({
    urlUnique: uniqueIndex('watchlist_source_url_unique').on(table.url),
    enabledNextScanIdx: index('watchlist_source_enabled_next_scan_idx').on(table.enabled, table.nextScanAt)
  })
);

export const watchlistEpisode = sqliteTable(
  'watchlist_episode',
  {
    id: text('id').primaryKey(),
    sourceId: text('sourceId')
      .notNull()
      .references(() => watchlistSource.id, { onDelete: 'cascade' }),
    url: text('url').notNull(),
    season: integer('season').notNull(),
    episode: integer('episode').notNull(),
    title: text('title').notNull(),
    quality: text('quality').notNull(),
    status: text('status').notNull(),
    fileId: text('fileId').references(() => file.id, { onDelete: 'set null' }),
    nzbId: text('nzbId').references(() => nzb.id, { onDelete: 'set null' }),
    downloadAttempts: integer('downloadAttempts').notNull().default(0),
    nzbAttempts: integer('nzbAttempts').notNull().default(0),
    downloadQueuedAt: text('downloadQueuedAt'),
    downloadedAt: text('downloadedAt'),
    nzbQueuedAt: text('nzbQueuedAt'),
    postedAt: text('postedAt'),
    lastErrorCode: text('lastErrorCode'),
    lastError: text('lastError'),
    createdAt: text('createdAt').notNull(),
    updatedAt: text('updatedAt').notNull()
  },
  (table) => ({
    sourceUrlUnique: uniqueIndex('watchlist_episode_source_url_unique').on(table.sourceId, table.url),
    statusIdx: index('watchlist_episode_status_idx').on(table.status),
    fileIdIdx: index('watchlist_episode_file_id_idx').on(table.fileId),
    nzbIdIdx: index('watchlist_episode_nzb_id_idx').on(table.nzbId)
  })
);
