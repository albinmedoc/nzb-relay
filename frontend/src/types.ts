export type JobStatus = 'pending' | 'running' | 'completed' | 'failed';
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

export interface Health {
  status: string;
  version: string;
}

export interface ListResponse<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}

export interface ListParams {
  limit?: number;
  offset?: number;
}

export interface JobListParams extends ListParams {
  status?: JobStatus;
  createdAfter?: string;
  createdBefore?: string;
}

export interface WatchlistSource {
  id: string;
  service: string;
  type: string;
  url: string;
  title: string | null;
  enabled: boolean;
  backfill: boolean;
  deleteFileAfterNzb: boolean;
  firstScanCompleted: boolean;
  lastScannedAt: string | null;
  nextScanAt: string | null;
  lastErrorCode: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
  episodeCount?: number;
  queuedCount?: number;
  postedCount?: number;
  blockedCount?: number;
}

export interface WatchlistEpisode {
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

export interface WatchlistSourceDetail extends WatchlistSource {
  episodes: WatchlistEpisode[];
}

export interface FileJob {
  id: string;
  url: string;
  status: JobStatus;
  filename: string;
  createdAt: string;
  downloadedAt: string | null;
  deleted: boolean;
  errorCode: string | null;
  error: string | null;
}

export interface NzbJob {
  id: string;
  status: JobStatus;
  nzbFile: string;
  createdAt: string;
  postedAt: string | null;
  errorCode: string | null;
  error: string | null;
  files: Array<{
    id: string;
    url: string;
    status: JobStatus;
    createdAt: string;
    downloadedAt: string | null;
  }>;
}
