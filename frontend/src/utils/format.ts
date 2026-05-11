import type { NzbJob } from '../types';

export function formatDate(value: string | null | undefined): string {
  if (!value) {
    return '-';
  }
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  }).format(new Date(value));
}

export function nzbDownloadName(nzb: NzbJob): string {
  const value = nzb.nzbFile.split('/').pop() || nzb.nzbFile || nzb.id;
  return value.endsWith('.nzb') ? value : `${value}.nzb`;
}
