export type JobStatus = 'pending' | 'running' | 'completed' | 'failed';

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
