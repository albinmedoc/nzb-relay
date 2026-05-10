export type JobStatus = 'pending' | 'running' | 'completed' | 'failed';
export type WebhookStatus = 'pending' | 'delivered' | 'failed';
export type WatchlistSourceType = 'series';
export type WatchlistEpisodeStatus =
  | 'seen'
  | 'discovered'
  | 'download_queued'
  | 'download_failed'
  | 'download_completed'
  | 'nzb_queued'
  | 'nzb_failed'
  | 'posted'
  | 'blocked';

export type ErrorCode =
  | 'insufficient_space'
  | 'interrupted_by_restart'
  | 'child_exit_nonzero'
  | 'unknown';

export type WebhookEvent =
  | 'download.completed'
  | 'download.failed'
  | 'nzb.completed'
  | 'nzb.failed';

export interface FileRow {
  id: string;
  url: string;
  status: JobStatus;
  title: string;
  filename: string;
  service: string;
  quality: string;
  season: number | null;
  episode: number | null;
  downloadedAt: string | null;
  createdAt: string;
  deleted: number;
  errorCode: ErrorCode | null;
  error: string | null;
}

export interface NzbRow {
  id: string;
  status: JobStatus;
  releaseName: string;
  nzbFile: string;
  createdAt: string;
  postedAt: string | null;
  errorCode: ErrorCode | null;
  error: string | null;
}

export interface WebhookDeliveryRow {
  id: string;
  event: WebhookEvent;
  url: string;
  payload: string;
  attempts: number;
  nextAttemptAt: string | null;
  status: WebhookStatus;
  lastError: string | null;
  createdAt: string;
}

export interface WatchlistSourceRow {
  id: string;
  service: string;
  type: WatchlistSourceType;
  url: string;
  title: string | null;
  enabled: number;
  backfill: number;
  deleteFileAfterNzb: number;
  firstScanCompleted: number;
  lastScannedAt: string | null;
  nextScanAt: string | null;
  lastErrorCode: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface WatchlistEpisodeRow {
  id: string;
  sourceId: string;
  url: string;
  season: number;
  episode: number;
  title: string;
  quality: string;
  status: WatchlistEpisodeStatus;
  fileId: string | null;
  nzbId: string | null;
  downloadAttempts: number;
  nzbAttempts: number;
  downloadQueuedAt: string | null;
  downloadedAt: string | null;
  nzbQueuedAt: string | null;
  postedAt: string | null;
  lastErrorCode: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface WatchlistEpisodeWithSource extends WatchlistEpisodeRow {
  sourceService: string;
  sourceType: WatchlistSourceType;
  sourceUrl: string;
  sourceTitle: string | null;
}

export interface WatchlistSourceSummary extends WatchlistSourceRow {
  episodeCount: number;
  queuedCount: number;
  postedCount: number;
  blockedCount: number;
}

export interface NzbFileSummary {
  id: string;
  url: string;
  status: JobStatus;
  title: string;
  service: string;
  season: number | null;
  episode: number | null;
  filename: string;
  createdAt: string;
  downloadedAt: string | null;
  deleted: number;
}

export interface ChildProcessResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  lastLine: string | null;
  lastStderrLine: string | null;
  error: Error | null;
}
