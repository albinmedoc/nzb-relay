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

