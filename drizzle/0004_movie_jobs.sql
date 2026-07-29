CREATE TABLE `movie_job` (
  `id` text PRIMARY KEY NOT NULL,
  `url` text NOT NULL,
  `title` text NOT NULL,
  `service` text NOT NULL,
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
  FOREIGN KEY (`fileId`) REFERENCES `file`(`id`) ON UPDATE no action ON DELETE set null,
  FOREIGN KEY (`nzbId`) REFERENCES `nzb`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `movie_job_status_idx` ON `movie_job` (`status`);
--> statement-breakpoint
CREATE INDEX `movie_job_file_id_idx` ON `movie_job` (`fileId`);
--> statement-breakpoint
CREATE INDEX `movie_job_nzb_id_idx` ON `movie_job` (`nzbId`);
--> statement-breakpoint
CREATE INDEX `movie_job_created_at_idx` ON `movie_job` (`createdAt`);
