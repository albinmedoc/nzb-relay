CREATE TABLE `watchlist_source` (
  `id` text PRIMARY KEY NOT NULL,
  `service` text NOT NULL,
  `type` text NOT NULL,
  `url` text NOT NULL,
  `title` text,
  `enabled` integer DEFAULT 1 NOT NULL,
  `backfill` integer DEFAULT 1 NOT NULL,
  `firstScanCompleted` integer DEFAULT 0 NOT NULL,
  `lastScannedAt` text,
  `nextScanAt` text,
  `lastErrorCode` text,
  `lastError` text,
  `createdAt` text NOT NULL,
  `updatedAt` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `watchlist_source_url_unique` ON `watchlist_source` (`url`);
--> statement-breakpoint
CREATE INDEX `watchlist_source_enabled_next_scan_idx` ON `watchlist_source` (`enabled`, `nextScanAt`);
--> statement-breakpoint
CREATE TABLE `watchlist_episode` (
  `id` text PRIMARY KEY NOT NULL,
  `sourceId` text NOT NULL,
  `url` text NOT NULL,
  `season` integer NOT NULL,
  `episode` integer NOT NULL,
  `title` text NOT NULL,
  `quality` text NOT NULL,
  `status` text NOT NULL,
  `fileId` text,
  `nzbId` text,
  `downloadAttempts` integer DEFAULT 0 NOT NULL,
  `nzbAttempts` integer DEFAULT 0 NOT NULL,
  `downloadQueuedAt` text,
  `downloadedAt` text,
  `nzbQueuedAt` text,
  `postedAt` text,
  `lastErrorCode` text,
  `lastError` text,
  `createdAt` text NOT NULL,
  `updatedAt` text NOT NULL,
  FOREIGN KEY (`sourceId`) REFERENCES `watchlist_source`(`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`fileId`) REFERENCES `file`(`id`) ON UPDATE no action ON DELETE set null,
  FOREIGN KEY (`nzbId`) REFERENCES `nzb`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `watchlist_episode_source_url_unique` ON `watchlist_episode` (`sourceId`, `url`);
--> statement-breakpoint
CREATE INDEX `watchlist_episode_status_idx` ON `watchlist_episode` (`status`);
--> statement-breakpoint
CREATE INDEX `watchlist_episode_file_id_idx` ON `watchlist_episode` (`fileId`);
--> statement-breakpoint
CREATE INDEX `watchlist_episode_nzb_id_idx` ON `watchlist_episode` (`nzbId`);
