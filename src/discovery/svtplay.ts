import { spawn } from 'node:child_process';
import { XMLParser } from 'fast-xml-parser';
import { fetch } from 'undici';

export interface SvtEpisode {
  url: string;
  title: string;
  season: number;
  episode: number;
  qualities: string[];
}

export interface SvtSerieResponse {
  slug: string;
  seasons: Array<{
    number: number;
    episodes: SvtEpisode[];
  }>;
}

export async function fetchSvtSerie(slug: string): Promise<SvtSerieResponse | null> {
  const encodedSlug = encodeURIComponent(slug).replace(/%2F/g, '/');
  const response = await fetch(`https://www.svtplay.se/${encodedSlug}/rss.xml`, {
    signal: AbortSignal.timeout(30_000)
  });

  if (response.status === 404) {
    return null;
  }
  if (!response.ok) {
    throw new Error(`SVT returned HTTP ${response.status}`);
  }

  const xml = await response.text();
  const parser = new XMLParser({ ignoreAttributes: false, trimValues: true });
  const parsed = parser.parse(xml) as Record<string, unknown>;
  const channel = getPath<Record<string, unknown>>(parsed, ['rss', 'channel']);
  const rawItems = asArray(channel?.item);

  if (rawItems.length === 0) {
    return null;
  }

  const episodes: SvtEpisode[] = [];
  for (const [index, raw] of rawItems.entries()) {
    const item = raw as Record<string, unknown>;
    const title = textValue(item.title) || `Avsnitt ${index + 1}`;
    const url = textValue(item.link) || textValue(item.guid);
    if (!url) {
      continue;
    }

    episodes.push({
      url,
      title,
      season: extractNumber(title, /säsong\s+(\d+)/i) ?? extractNumber(textValue(item.description), /säsong\s+(\d+)/i) ?? 1,
      episode: extractNumber(title, /avsnitt\s+(\d+)/i) ?? extractNumber(title, /\bE(\d+)\b/i) ?? index + 1,
      qualities: await probeQualities(url)
    });
  }

  const bySeason = new Map<number, SvtEpisode[]>();
  for (const episode of episodes) {
    const group = bySeason.get(episode.season) ?? [];
    group.push(episode);
    bySeason.set(episode.season, group);
  }

  return {
    slug,
    seasons: [...bySeason.entries()]
      .sort(([a], [b]) => a - b)
      .map(([number, seasonEpisodes]) => ({
        number,
        episodes: seasonEpisodes.sort((a, b) => a.episode - b.episode)
      }))
  };
}

function probeQualities(url: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const child = spawn('svtplay-dl', ['--list-quality', url], {
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let output = '';
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('quality probe timed out'));
    }, 60_000);

    child.stdout.on('data', (chunk) => {
      output += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      output += String(chunk);
    });
    child.on('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timeout);
      if (code !== 0) {
        reject(new Error(`svtplay-dl quality probe exited with code ${code}`));
        return;
      }
      const qualities = [...new Set([...output.matchAll(/\b([1-9]\d{2,3})p?\b/g)].map((match) => match[1]))]
        .filter((value): value is string => Boolean(value))
        .sort((a, b) => Number(b) - Number(a));
      if (qualities.length === 0) {
        reject(new Error('quality probe returned no qualities'));
        return;
      }
      resolve(qualities);
    });
  });
}

function getPath<T>(value: Record<string, unknown>, path: string[]): T | undefined {
  let current: unknown = value;
  for (const key of path) {
    if (!current || typeof current !== 'object') {
      return undefined;
    }
    current = (current as Record<string, unknown>)[key];
  }
  return current as T | undefined;
}

function asArray(value: unknown): unknown[] {
  if (value == null) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}

function textValue(value: unknown): string {
  if (typeof value === 'string' || typeof value === 'number') {
    return String(value);
  }
  if (value && typeof value === 'object' && '#text' in value) {
    return String((value as Record<string, unknown>)['#text'] ?? '');
  }
  return '';
}

function extractNumber(value: string, pattern: RegExp): number | null {
  const match = pattern.exec(value);
  if (!match?.[1]) {
    return null;
  }
  const parsed = Number.parseInt(match[1], 10);
  return Number.isFinite(parsed) ? parsed : null;
}

