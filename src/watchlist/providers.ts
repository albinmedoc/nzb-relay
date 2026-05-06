import type { Logger } from 'pino';
import { fetchSvtSerie } from '../discovery/svtplay.js';
import type { WatchlistSourceType } from '../types.js';

export interface WatchProviderEpisode {
  url: string;
  season: number;
  episode: number;
  title: string;
  quality: string;
}

export interface WatchProviderDiscovery {
  service: string;
  type: WatchlistSourceType;
  url: string;
  title: string;
  episodes: WatchProviderEpisode[];
}

export interface WatchProvider {
  service: string;
  type: WatchlistSourceType;
  supports(url: URL): boolean;
  normalize(url: URL): string;
  discover(url: string, options?: { logger?: Logger }): Promise<WatchProviderDiscovery>;
}

export interface ResolvedWatchProvider {
  provider: WatchProvider;
  normalizedUrl: string;
}

export const svtplaySeriesProvider: WatchProvider = {
  service: 'svtplay',
  type: 'series',
  supports(url) {
    return svtSlugFromUrl(url) != null;
  },
  normalize(url) {
    const slug = svtSlugFromUrl(url);
    if (!slug) {
      throw new Error('unsupported SVT Play URL');
    }
    return `https://www.svtplay.se/${encodeURIComponent(slug)}`;
  },
  async discover(url, options) {
    const parsed = new URL(url);
    const slug = svtSlugFromUrl(parsed);
    if (!slug) {
      throw new Error('unsupported SVT Play URL');
    }

    const result = await fetchSvtSerie(slug, {
      populateQualities: true,
      fastQualities: true,
      logger: options?.logger
    });
    if (!result) {
      throw new Error('SVT Play series not found');
    }

    return {
      service: 'svtplay',
      type: 'series',
      url: `https://www.svtplay.se/${encodeURIComponent(result.slug)}`,
      title: result.name,
      episodes: result.seasons.flatMap((season) =>
        season.episodes.map((episode) => ({
          url: episode.link,
          season: season.season,
          episode: episode.episode,
          title: episode.title,
          quality: highestQuality(episode.qualities)
        }))
      )
    };
  }
};

export const defaultWatchProviders: WatchProvider[] = [svtplaySeriesProvider];

export function resolveWatchProvider(rawUrl: string, providers = defaultWatchProviders): ResolvedWatchProvider | null {
  const parsed = parseWatchUrl(rawUrl);
  if (!parsed) {
    return null;
  }

  for (const provider of providers) {
    if (provider.supports(parsed)) {
      return {
        provider,
        normalizedUrl: provider.normalize(parsed)
      };
    }
  }

  return null;
}

function parseWatchUrl(rawUrl: string): URL | null {
  try {
    return new URL(rawUrl.trim());
  } catch {
    return null;
  }
}

function svtSlugFromUrl(url: URL): string | null {
  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  if (host !== 'svtplay.se') {
    return null;
  }

  const [firstSegment] = url.pathname.split('/').filter(Boolean);
  if (!firstSegment || firstSegment.toLowerCase() === 'video') {
    return null;
  }

  try {
    return decodeURIComponent(firstSegment);
  } catch {
    return firstSegment;
  }
}

function highestQuality(qualities: string[]): string {
  const highest = qualities
    .map((quality) => Number(quality))
    .filter((quality) => Number.isFinite(quality))
    .sort((a, b) => b - a)[0];

  return highest ? String(highest) : '1080';
}
