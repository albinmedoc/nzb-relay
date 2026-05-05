CREATE TABLE `file` (
  `id` text PRIMARY KEY NOT NULL,
  `url` text NOT NULL,
  `status` text NOT NULL,
  `title` text NOT NULL,
  `filename` text NOT NULL,
  `service` text NOT NULL,
  `quality` text NOT NULL,
  `season` integer,
  `episode` integer,
  `downloadedAt` text,
  `createdAt` text NOT NULL,
  `deleted` integer DEFAULT 0 NOT NULL,
  `errorCode` text,
  `error` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `file_active_url_unique` ON `file` (`url`) WHERE status IN ('pending', 'running', 'completed') AND deleted = 0;
--> statement-breakpoint
CREATE INDEX `file_status_created_at_idx` ON `file` (`status`, `createdAt`);
--> statement-breakpoint
CREATE TABLE `nzb` (
  `id` text PRIMARY KEY NOT NULL,
  `status` text NOT NULL,
  `releaseName` text NOT NULL,
  `nzbFile` text NOT NULL,
  `createdAt` text NOT NULL,
  `postedAt` text,
  `errorCode` text,
  `error` text
);
--> statement-breakpoint
CREATE INDEX `nzb_status_created_at_idx` ON `nzb` (`status`, `createdAt`);
--> statement-breakpoint
CREATE TABLE `nzb_files` (
  `nzbId` text NOT NULL,
  `fileId` text NOT NULL,
  PRIMARY KEY (`nzbId`, `fileId`),
  FOREIGN KEY (`nzbId`) REFERENCES `nzb`(`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`fileId`) REFERENCES `file`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `webhook_deliveries` (
  `id` text PRIMARY KEY NOT NULL,
  `event` text NOT NULL,
  `url` text NOT NULL,
  `payload` text NOT NULL,
  `attempts` integer DEFAULT 0 NOT NULL,
  `nextAttemptAt` text,
  `status` text NOT NULL,
  `lastError` text,
  `createdAt` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `webhook_status_next_attempt_idx` ON `webhook_deliveries` (`status`, `nextAttemptAt`);

