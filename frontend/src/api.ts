import { apiBase, backendToken } from './runtime';
import type {
  CreateMovieRequest,
  CreateWatchlistSourceRequest,
  FileListParams,
  FileJob,
  Health,
  JobListParams,
  ListParams,
  ListResponse,
  MovieJob,
  NzbJob,
  UpdateWatchlistSourceRequest,
  WatchlistSource,
  WatchlistSourceDetail
} from './types';

export async function requestJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await request(path, init);
  if (!response.ok) {
    throw new Error(await readError(response));
  }
  return (await response.json()) as T;
}

export async function request(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  if (backendToken) {
    headers.set('authorization', `Bearer ${backendToken}`);
  }
  return fetch(`${apiBase.value}${path}`, {
    ...init,
    headers
  });
}

export async function readError(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: string; code?: string };
    return body.error || body.code || `${response.status} ${response.statusText}`;
  } catch {
    return `${response.status} ${response.statusText}`;
  }
}

export function getHealth(): Promise<Health> {
  return requestJson<Health>('/health');
}

export function listWatchlist(params: ListParams = {}): Promise<ListResponse<WatchlistSource>> {
  return requestJson<ListResponse<WatchlistSource>>(`/watchlist${toQuery({ limit: 20, ...params })}`);
}

export function createWatchlistSource(input: CreateWatchlistSourceRequest): Promise<WatchlistSource> {
  return requestJson<WatchlistSource>('/watchlist', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input)
  });
}

export function createMovie(input: CreateMovieRequest): Promise<{ movieId: string; fileId: string; status: string }> {
  return requestJson('/movies', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input)
  });
}

export function listMovies(params: Record<string, string | number | boolean | null | undefined> = {}): Promise<ListResponse<MovieJob>> {
  return requestJson<ListResponse<MovieJob>>(`/movies${toQuery({ limit: 20, ...params })}`);
}

export function retryMovie(movieId: string): Promise<unknown> {
  return requestJson(`/movies/${movieId}/retry`, { method: 'POST' });
}

export async function deleteMovie(movieId: string): Promise<void> {
  await ensureOk(await request(`/movies/${movieId}`, { method: 'DELETE' }));
}

export function updateWatchlistSource(
  sourceId: string,
  patch: UpdateWatchlistSourceRequest
): Promise<WatchlistSource> {
  return requestJson<WatchlistSource>(`/watchlist/${sourceId}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(patch)
  });
}

export function retryWatchlistSource(sourceId: string): Promise<unknown> {
  return requestJson(`/watchlist/${sourceId}/retry`, { method: 'POST' });
}

export function getWatchlistSource(sourceId: string): Promise<WatchlistSourceDetail> {
  return requestJson<WatchlistSourceDetail>(`/watchlist/${sourceId}`);
}

export async function deleteWatchlistSource(sourceId: string): Promise<void> {
  await ensureOk(await request(`/watchlist/${sourceId}`, { method: 'DELETE' }));
}

export function listFiles(params: FileListParams = {}): Promise<ListResponse<FileJob>> {
  return requestJson<ListResponse<FileJob>>(`/files${toQuery({ limit: 20, ...params })}`);
}

export function retryFile(fileId: string): Promise<unknown> {
  return requestJson(`/files/${fileId}/retry`, { method: 'POST' });
}

export async function deleteFile(fileId: string): Promise<void> {
  await ensureOk(await request(`/files/${fileId}`, { method: 'DELETE' }));
}

export function listNzbs(params: JobListParams = {}): Promise<ListResponse<NzbJob>> {
  return requestJson<ListResponse<NzbJob>>(`/nzb${toQuery({ limit: 20, ...params })}`);
}

export function retryNzb(nzbId: string): Promise<unknown> {
  return requestJson(`/nzb/${nzbId}/retry`, { method: 'POST' });
}

export async function deleteNzb(nzbId: string): Promise<void> {
  await ensureOk(await request(`/nzb/${nzbId}`, { method: 'DELETE' }));
}

export async function readText(path: string): Promise<string> {
  const response = await request(path);
  await ensureOk(response);
  return response.text();
}

export async function downloadArtifact(path: string, filename: string): Promise<void> {
  const response = await request(path);
  await ensureOk(response);
  await downloadResponse(response, filename);
}

export async function downloadFileArchive(fileIds: string[]): Promise<void> {
  const response = await request('/files/archive', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ fileIds })
  });
  await ensureOk(response);
  await downloadResponse(response, 'nzb-relay-files.zip');
}

export async function downloadNzbArchive(nzbIds: string[]): Promise<void> {
  const response = await request('/nzb/archive', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ nzbIds })
  });
  await ensureOk(response);
  await downloadResponse(response, 'nzb-relay-nzbs.zip');
}

async function downloadResponse(response: Response, filename: string): Promise<void> {
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

async function ensureOk(response: Response): Promise<void> {
  if (!response.ok) {
    throw new Error(await readError(response));
  }
}

function toQuery(params: Record<string, string | number | boolean | null | undefined>): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') {
      query.set(key, String(value));
    }
  }
  const value = query.toString();
  return value ? `?${value}` : '';
}
