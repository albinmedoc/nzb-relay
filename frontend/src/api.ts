import { apiBase, backendToken } from './runtime';
import type { FileJob, Health, ListResponse, NzbJob, WatchlistSource } from './types';

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

export function listWatchlist(): Promise<ListResponse<WatchlistSource>> {
  return requestJson<ListResponse<WatchlistSource>>('/watchlist?limit=50');
}

export function createWatchlistSource(input: { url: string; backfill: boolean; deleteFileAfterNzb: boolean }): Promise<WatchlistSource> {
  return requestJson<WatchlistSource>('/watchlist', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input)
  });
}

export function updateWatchlistSource(
  sourceId: string,
  patch: Partial<Pick<WatchlistSource, 'enabled' | 'deleteFileAfterNzb'>>
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

export async function deleteWatchlistSource(sourceId: string): Promise<void> {
  await ensureOk(await request(`/watchlist/${sourceId}`, { method: 'DELETE' }));
}

export function listFiles(): Promise<ListResponse<FileJob>> {
  return requestJson<ListResponse<FileJob>>('/files?limit=50');
}

export function retryFile(fileId: string): Promise<unknown> {
  return requestJson(`/files/${fileId}/retry`, { method: 'POST' });
}

export async function deleteFile(fileId: string): Promise<void> {
  await ensureOk(await request(`/files/${fileId}`, { method: 'DELETE' }));
}

export function listNzbs(): Promise<ListResponse<NzbJob>> {
  return requestJson<ListResponse<NzbJob>>('/nzb?limit=50');
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
