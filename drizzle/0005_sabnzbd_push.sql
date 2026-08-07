CREATE TABLE `sabnzbd_push` (
  `id` text PRIMARY KEY NOT NULL,
  `nzbId` text NOT NULL,
  `url` text NOT NULL,
  `category` text NOT NULL,
  `status` text NOT NULL,
  `attempts` integer DEFAULT 0 NOT NULL,
  `nextAttemptAt` text,
  `lastError` text,
  `remoteIds` text,
  `createdAt` text NOT NULL,
  `updatedAt` text NOT NULL,
  `pushedAt` text,
  FOREIGN KEY (`nzbId`) REFERENCES `nzb`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sabnzbd_push_nzb_unique` ON `sabnzbd_push` (`nzbId`);
--> statement-breakpoint
CREATE INDEX `sabnzbd_push_status_next_attempt_idx` ON `sabnzbd_push` (`status`, `nextAttemptAt`);
