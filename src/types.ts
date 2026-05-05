export type JobStatus = 'pending' | 'running' | 'completed' | 'failed';
export type WebhookStatus = 'pending' | 'delivered' | 'failed';

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

export interface NzbFileSummary {
  id: string;
  url: string;
  title: string;
  service: string;
  season: number | null;
  episode: number | null;
  filename: string;
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

