import { z } from 'zod';

export const jobStatusSchema = z.enum(['pending', 'running', 'completed', 'failed']);
export type JobStatus = z.infer<typeof jobStatusSchema>;

export const watchlistSourceTypeSchema = z.enum(['series']);
export type WatchlistSourceType = z.infer<typeof watchlistSourceTypeSchema>;

export const watchlistEpisodeStatusSchema = z.enum([
  'seen',
  'discovered',
  'download_queued',
  'download_failed',
  'download_completed',
  'nzb_queued',
  'nzb_failed',
  'posted',
  'blocked'
]);
export type WatchlistEpisodeStatus = z.infer<typeof watchlistEpisodeStatusSchema>;

export const createDownloadRequestSchema = z
  .object({
    url: z.string().trim().min(1),
    title: z.string().trim().min(1),
    service: z.string().trim().min(1),
    quality: z.string().trim().min(1),
    season: z.number().int().nullable().optional(),
    episode: z.number().int().nullable().optional()
  })
  .passthrough();
export type CreateDownloadRequest = z.infer<typeof createDownloadRequestSchema>;

export const createWatchlistSourceRequestSchema = z
  .object({
    url: z.string().trim().min(1),
    backfill: z.boolean().nullish(),
    deleteFileAfterNzb: z.boolean().nullish()
  })
  .passthrough();
export type CreateWatchlistSourceRequest = z.infer<typeof createWatchlistSourceRequestSchema>;

export const updateWatchlistSourceRequestSchema = z
  .object({
    enabled: z.boolean().optional(),
    deleteFileAfterNzb: z.boolean().optional(),
    title: z.string().trim().min(1).optional()
  })
  .passthrough();
export type UpdateWatchlistSourceRequest = z.infer<typeof updateWatchlistSourceRequestSchema>;

export const createNzbRequestSchema = z
  .object({
    fileIds: z.array(z.string().trim().min(1)),
    name: z.string()
  })
  .passthrough();
export type CreateNzbRequest = z.infer<typeof createNzbRequestSchema>;

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

export interface ApiErrorResponse {
  code: string;
  error: string;
  requestId: string;
}

export interface HealthResponse {
  status: string;
  version: string;
}

export interface CreateDownloadResponse {
  fileId: string;
  status: JobStatus;
}

export interface RetryFileResponse {
  fileId: string;
  status: JobStatus;
}

export interface FileJobResponse {
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

export interface CreateNzbResponse {
  nzbId: string;
  status: JobStatus;
}

export interface RetryNzbResponse {
  nzbId: string;
  status: JobStatus;
}

export interface NzbJobResponse {
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

export interface WatchlistSourceResponse {
  id: string;
  service: string;
  type: WatchlistSourceType;
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
}

export interface WatchlistSourceSummaryResponse extends WatchlistSourceResponse {
  episodeCount: number;
  queuedCount: number;
  postedCount: number;
  blockedCount: number;
}

export interface WatchlistEpisodeResponse {
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

export interface WatchlistSourceDetailResponse extends WatchlistSourceResponse {
  episodes: WatchlistEpisodeResponse[];
}

export interface RetryWatchlistSourceResponse {
  sourceId: string;
  retried: number;
}
