CREATE TABLE `indexer_upload` (
  `id` text PRIMARY KEY NOT NULL,
  `nzbId` text NOT NULL,
  `indexerName` text NOT NULL,
  `url` text NOT NULL,
  `status` text NOT NULL,
  `attempts` integer DEFAULT 0 NOT NULL,
  `nextAttemptAt` text,
  `lastError` text,
  `createdAt` text NOT NULL,
  `updatedAt` text NOT NULL,
  `uploadedAt` text,
  FOREIGN KEY (`nzbId`) REFERENCES `nzb`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `indexer_upload_nzb_name_unique` ON `indexer_upload` (`nzbId`, `indexerName`);
--> statement-breakpoint
CREATE INDEX `indexer_upload_status_next_attempt_idx` ON `indexer_upload` (`status`, `nextAttemptAt`);
