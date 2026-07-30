import { spawn } from 'node:child_process';
import { XMLParser } from 'fast-xml-parser';
import type { Logger } from 'pino';
import { fetch } from 'undici';
import { commandLine } from '../utils/child.js';

const SVT_BASE_URL = 'https://www.svtplay.se';
const QUALITY_PROBE_TIMEOUT_MS = 60_000;
const DEFAULT_QUALITY_PROBE_CONCURRENCY = 4;

export interface SvtEpisode {
  episode: number;
  title: string;
  description: string;
  link: string;
  qualities: string[];
}

export interface SvtSerieResponse {
  slug: string;
  name: string;
  link: string;
  seasons: Array<{
    season: number;
    episodes: SvtEpisode[];
  }>;
}

export interface SvtMovieResponse {
  url: string;
  title: string;
  service: 'svtplay';
  quality: string;
}

type FeedOrder = 'asc' | 'desc';
export type QualityProbe = (url: string) => Promise<string[]>;

export interface SvtSerieFetchOptions {
  populateQualities?: boolean;
  fastQualities?: boolean;
  qualityProbe?: QualityProbe;
  qualityProbeConcurrency?: number;
  logger?: Logger;
}

export interface SvtMovieFetchOptions {
  qualityProbe?: QualityProbe;
  logger?: Logger;
}

interface QualityProbeContext {
  slug: string;
  source: 'page' | 'rss';
  season: number;
  episode: number;
  title: string;
  link: string;
}

interface ParsedRssEpisode {
  link: string;
  title: string;
  description: string;
  explicitSeason: number | null;
  episode: number;
  publishedAt: number | null;
}

interface SeasonRun {
  explicitSeason: number | null;
  episodes: ParsedRssEpisode[];
}

interface EpisodeWithoutQualities {
  episode: number;
  title: string;
  description: string;
  link: string;
  qualityContext: QualityProbeContext;
}

export async function fetchSvtSerie(
  slug: string,
  options: SvtSerieFetchOptions = {}
): Promise<SvtSerieResponse | null> {
  const encodedSlug = encodeURIComponent(slug).replace(/%2F/g, '/');
  const populateQualities = options.populateQualities !== false;
  const fastQualities = populateQualities && options.fastQualities === true;
  const qualityProbe = resolveQualityProbe(options);
  const qualityProbeConcurrency = resolveQualityProbeConcurrency(options.qualityProbeConcurrency);
  const logger = options.logger;
  logger?.info(
    {
      event: 'svt.discovery.started',
      slug,
      populateQualities,
      fastQualities,
      qualityProbeConcurrency
    },
    'SVT discovery started'
  );
  const pageResponse = await fetch(`${SVT_BASE_URL}/${encodedSlug}`, {
    signal: AbortSignal.timeout(30_000)
  });

  if (pageResponse.ok) {
    const pageResult = await parseSvtSeriePageHtml(
      await pageResponse.text(),
      slug,
      qualityProbe,
      logger,
      qualityProbeConcurrency,
      fastQualities
    );
    if (pageResult) {
      logger?.info(
        {
          event: 'svt.discovery.completed',
          slug,
          source: 'page',
          seasonCount: pageResult.seasons.length,
          episodeCount: countEpisodes(pageResult)
        },
        'SVT discovery completed'
      );
      return pageResult;
    }
  }

  const response = await fetch(`${SVT_BASE_URL}/${encodedSlug}/rss.xml`, {
    signal: AbortSignal.timeout(30_000)
  });
  if (response.status === 404) {
    return null;
  }
  if (!response.ok) {
    throw new Error(`SVT returned HTTP ${response.status}`);
  }

  const xml = await response.text();
  const rssResult = await parseSvtSerieXml(xml, slug, qualityProbe, logger, qualityProbeConcurrency, fastQualities);
  if (rssResult) {
    logger?.info(
      {
        event: 'svt.discovery.completed',
        slug,
        source: 'rss',
        seasonCount: rssResult.seasons.length,
        episodeCount: countEpisodes(rssResult)
      },
      'SVT discovery completed'
    );
  }
  return rssResult;
}

export async function parseSvtSeriePageHtml(
  html: string,
  slug: string,
  qualityProbe: QualityProbe = async () => [],
  logger?: Logger,
  qualityProbeConcurrency = DEFAULT_QUALITY_PROBE_CONCURRENCY,
  fastQualities = false
): Promise<SvtSerieResponse | null> {
  const detailsPage = extractDetailsPage(html);
  if (!detailsPage) {
    return null;
  }

  const serieLink =
    absoluteSvtUrl(firstText(getPath(detailsPage, ['item', 'urls', 'svtplay']))) || `${SVT_BASE_URL}/${slug}`;
  const seasons = await parsePageSeasons(
    detailsPage,
    slug,
    qualityProbe,
    logger,
    resolveQualityProbeConcurrency(qualityProbeConcurrency),
    fastQualities
  );
  if (seasons.length === 0) {
    return null;
  }

  return {
    slug,
    name: extractPageSerieName(detailsPage) || humanizeSlug(slug),
    link: serieLink,
    seasons
  };
}

export async function parseSvtSerieXml(
  xml: string,
  slug: string,
  qualityProbe: QualityProbe = async () => [],
  logger?: Logger,
  qualityProbeConcurrency = DEFAULT_QUALITY_PROBE_CONCURRENCY,
  fastQualities = false
): Promise<SvtSerieResponse | null> {
  const parser = new XMLParser({ ignoreAttributes: false, trimValues: true });
  const parsed = parser.parse(xml) as Record<string, unknown>;
  const channel = getPath<Record<string, unknown>>(parsed, ['rss', 'channel']);
  const rawItems = asArray(channel?.item);
  const serieName = extractRssSerieName(textValue(channel?.title)) || humanizeSlug(slug);
  const serieLink = textValue(channel?.link) || `https://www.svtplay.se/${slug}`;

  if (rawItems.length === 0) {
    return null;
  }

  const parsedEpisodes: ParsedRssEpisode[] = [];
  for (const [index, raw] of rawItems.entries()) {
    const item = raw as Record<string, unknown>;
    const title = textValue(item.title) || `Avsnitt ${index + 1}`;
    const link = textValue(item.link) || textValue(item.guid);
    if (!link) {
      continue;
    }
    const description = textValue(item.description);

    parsedEpisodes.push({
      link,
      title,
      description,
      explicitSeason: extractSeason(title, link),
      episode: extractEpisode(title, link) ?? index + 1,
      publishedAt: parseDate(textValue(item.pubDate) || textValue(item['dc:date']))
    });
  }

  if (parsedEpisodes.length === 0) {
    return null;
  }

  const order = inferFeedOrder(parsedEpisodes);
  const runs = collectSeasonRuns(parsedEpisodes, order);
  const seasonNumbers = inferSeasonNumbers(runs, order);
  const concurrency = resolveQualityProbeConcurrency(qualityProbeConcurrency);
  const bySeason = new Map<number, SvtEpisode[]>();
  for (const [runIndex, run] of runs.entries()) {
    const season = seasonNumbers[runIndex] ?? 1;
    const episodesWithoutQualities: EpisodeWithoutQualities[] = [];
    for (const parsedEpisode of run.episodes) {
      episodesWithoutQualities.push({
        episode: parsedEpisode.episode,
        title: parsedEpisode.title,
        description: parsedEpisode.description,
        link: parsedEpisode.link,
        qualityContext: {
          slug,
          source: 'rss',
          season,
          episode: parsedEpisode.episode,
          title: parsedEpisode.title,
          link: parsedEpisode.link
        }
      });
    }

    for (const episode of await populateEpisodeQualities(
      episodesWithoutQualities,
      qualityProbe,
      logger,
      concurrency,
      fastQualities
    )) {
      const group = bySeason.get(season) ?? [];
      group.push(episode);
      bySeason.set(season, group);
    }
  }

  return {
    slug,
    name: serieName,
    link: serieLink,
    seasons: [...bySeason.entries()]
      .sort(([a], [b]) => a - b)
      .map(([season, seasonEpisodes]) => ({
        season,
        episodes: seasonEpisodes.sort((a, b) => a.episode - b.episode)
      }))
  };
}

function extractSeason(title: string, url: string): number | null {
  return (
    extractSeasonFromText(title) ??
    extractNumber(url, /(?:säsong|sasong|season)-(\d+)/i)
  );
}

function extractEpisode(title: string, url: string): number | null {
  return (
    extractNumber(title, /avsnitt\s+(\d+)/i) ??
    extractNumber(title, /\bE(\d+)\b/i) ??
    extractNumber(title, /^\s*(\d+)\.\s+/) ??
    extractNumber(url, /\/avsnitt-(\d+)\b/i)
  );
}

function resolveQualityProbe(options: SvtSerieFetchOptions): QualityProbe {
  if (options.populateQualities === false) {
    return emptyQualityProbe;
  }
  return memoizeQualityProbe(options.qualityProbe ?? createSvtplayDlQualityProbe(options.logger));
}

function resolveQualityProbeConcurrency(value: number | undefined): number {
  if (value == null) {
    return DEFAULT_QUALITY_PROBE_CONCURRENCY;
  }
  if (!Number.isFinite(value)) {
    return DEFAULT_QUALITY_PROBE_CONCURRENCY;
  }
  return Math.max(1, Math.floor(value));
}

async function emptyQualityProbe(): Promise<string[]> {
  return [];
}

function memoizeQualityProbe(probe: QualityProbe): QualityProbe {
  const cache = new Map<string, Promise<string[]>>();
  return (url) => {
    const cached = cache.get(url);
    if (cached) {
      return cached;
    }
    const result = probe(url);
    cache.set(url, result);
    return result;
  };
}

function createSvtplayDlQualityProbe(logger?: Logger): QualityProbe {
  return (url) => probeSvtplayDlQualities(url, logger);
}

function probeSvtplayDlQualities(url: string, logger?: Logger): Promise<string[]> {
  return new Promise((resolve, reject) => {
    let output = '';
    let settled = false;
    let timeout: NodeJS.Timeout | null = null;
    const command = 'svtplay-dl';
    const args = ['--list-quality', url];

    const settle = (error: Error | null, qualities?: string[]) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeout) {
        clearTimeout(timeout);
      }
      if (error) {
        reject(error);
        return;
      }
      resolve(qualities ?? []);
    };

    logger?.debug?.(
      {
        event: 'svtplay_dl.command',
        source: 'quality_probe',
        command,
        args,
        commandLine: commandLine(command, args)
      },
      'svtplay-dl command'
    );
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe']
    });

    timeout = setTimeout(() => {
      settle(new Error('svtplay-dl quality probe timed out'));
      child.kill('SIGKILL');
    }, QUALITY_PROBE_TIMEOUT_MS);

    child.stdout?.on('data', (chunk) => {
      output += String(chunk);
    });
    child.stderr?.on('data', (chunk) => {
      output += String(chunk);
    });
    child.on('error', (error) => {
      settle(error);
    });
    child.on('close', (code) => {
      if (code !== 0) {
        settle(new Error(`svtplay-dl quality probe exited with code ${code}: ${truncateOneLine(output)}`));
        return;
      }

      const qualities = parseSvtplayDlQualities(output);
      if (qualities.length === 0) {
        settle(new Error(`svtplay-dl quality probe returned no qualities: ${truncateOneLine(output)}`));
        return;
      }
      settle(null, qualities);
    });
  });
}

export function parseSvtplayDlQualities(output: string): string[] {
  const heights = new Set<string>();
  for (const match of output.matchAll(/\b\d{3,4}x(\d{3,4})\b/g)) {
    if (match[1]) {
      heights.add(match[1]);
    }
  }

  if (heights.size === 0) {
    for (const match of output.matchAll(/\b([1-9]\d{2,3})p?\b/g)) {
      if (match[1]) {
        heights.add(match[1]);
      }
    }
  }

  return [...heights].sort((a, b) => Number(b) - Number(a));
}

function extractPageSerieName(detailsPage: Record<string, unknown>): string {
  return firstText(
    getPath(detailsPage, ['item', 'parent', 'name']),
    getPath(detailsPage, ['item', 'name']),
    getPath(detailsPage, ['details', 'heading']),
    getPath(detailsPage, ['analytics', 'json', 'title'])
  );
}

export function normalizeSvtMovieUrl(rawUrl: string): string | null {
  try {
    const url = new URL(rawUrl);
    const host = url.hostname.toLowerCase().replace(/^www\./, '');
    if (host !== 'svtplay.se') {
      return null;
    }

    const segments = url.pathname.split('/').filter(Boolean);
    if (segments[0]?.toLowerCase() !== 'video' || segments.length < 2) {
      return null;
    }

    url.protocol = 'https:';
    url.hash = '';
    url.search = '';
    return url.toString();
  } catch {
    return null;
  }
}

function extractRssSerieName(title: string): string {
  return title.replace(/^SVT Play\s*-\s*/i, '').trim();
}

function humanizeSlug(slug: string): string {
  return slug
    .split('/')
    .at(-1)!
    .split('-')
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

async function parsePageSeasons(
  detailsPage: Record<string, unknown>,
  slug: string,
  qualityProbe: QualityProbe,
  logger: Logger | undefined,
  qualityProbeConcurrency: number,
  fastQualities: boolean
): Promise<SvtSerieResponse['seasons']> {
  const seasons: SvtSerieResponse['seasons'] = [];
  let implicitSeason = 1;

  for (const rawModule of asArray(detailsPage.modules)) {
    const module = asRecord(rawModule);
    const selection = asRecord(module?.selection);
    if (!module || !selection || !isSeasonSelection(module, selection)) {
      continue;
    }

    const explicitSeason = extractSeasonFromSelection(module, selection);
    const season = explicitSeason ?? implicitSeason;
    implicitSeason = Math.max(implicitSeason + 1, season + 1);

    const episodesWithoutQualities: EpisodeWithoutQualities[] = [];
    const seenLinks = new Set<string>();
    for (const [index, rawItem] of asArray(selection.items).entries()) {
      const item = asRecord(rawItem);
      if (!item) {
        continue;
      }

      const link = absoluteSvtUrl(
        firstText(getPath(item, ['item', 'urls', 'svtplay']), getPath(item, ['urls', 'svtplay']), item.link)
      );
      if (!link || seenLinks.has(link)) {
        continue;
      }
      seenLinks.add(link);

      const title = firstText(item.heading, getPath(item, ['item', 'name']), item.title) || `Avsnitt ${index + 1}`;
      const episodeNumber = extractEpisode(title, link) ?? extractTeaserIndex(item) ?? index + 1;
      episodesWithoutQualities.push({
        episode: episodeNumber,
        title,
        description: firstText(item.description),
        link,
        qualityContext: {
          slug,
          source: 'page',
          season,
          episode: episodeNumber,
          title,
          link
        }
      });
    }

    const episodes = await populateEpisodeQualities(
      episodesWithoutQualities,
      qualityProbe,
      logger,
      qualityProbeConcurrency,
      fastQualities
    );

    if (episodes.length > 0) {
      seasons.push({
        season,
        episodes: episodes.sort((a, b) => a.episode - b.episode)
      });
    }
  }

  return seasons.sort((a, b) => a.season - b.season);
}

async function populateEpisodeQualities(
  episodes: EpisodeWithoutQualities[],
  qualityProbe: QualityProbe,
  logger: Logger | undefined,
  concurrency: number,
  fastQualities: boolean
): Promise<SvtEpisode[]> {
  if (fastQualities) {
    return populateEpisodeQualitiesFromFirstEpisode(episodes, qualityProbe, logger);
  }

  const populated = await mapConcurrent(episodes, concurrency, async (episode) => ({
    episode: episode.episode,
    title: episode.title,
    description: episode.description,
    link: episode.link,
    qualities: await probeEpisodeQualities(qualityProbe, logger, episode.qualityContext)
  }));

  return populated.sort((a, b) => a.episode - b.episode);
}

async function populateEpisodeQualitiesFromFirstEpisode(
  episodes: EpisodeWithoutQualities[],
  qualityProbe: QualityProbe,
  logger: Logger | undefined
): Promise<SvtEpisode[]> {
  const sampleEpisode = selectFirstEpisode(episodes);
  const sampledQualities = sampleEpisode
    ? await probeEpisodeQualities(qualityProbe, logger, sampleEpisode.qualityContext)
    : [];

  const populated = episodes.map((episode) => {
    if (sampleEpisode && episode !== sampleEpisode) {
      logger?.info(
        {
          event: 'svt.episode.qualities.reused',
          ...episode.qualityContext,
          sourceEpisode: sampleEpisode.episode,
          sourceLink: sampleEpisode.link,
          qualityCount: sampledQualities.length,
          qualities: sampledQualities
        },
        'SVT episode qualities reused from season sample'
      );
    }

    return {
      episode: episode.episode,
      title: episode.title,
      description: episode.description,
      link: episode.link,
      qualities: [...sampledQualities]
    };
  });

  return populated.sort((a, b) => a.episode - b.episode);
}

function selectFirstEpisode(episodes: EpisodeWithoutQualities[]): EpisodeWithoutQualities | undefined {
  return episodes.reduce<EpisodeWithoutQualities | undefined>((selected, episode) => {
    if (!selected || episode.episode < selected.episode) {
      return episode;
    }
    return selected;
  }, undefined);
}

async function mapConcurrent<T, R>(
  values: T[],
  concurrency: number,
  mapper: (value: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  const workerCount = Math.min(concurrency, values.length);
  const workers = Array.from({ length: workerCount }, async () => {
    for (;;) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= values.length) {
        return;
      }
      results[index] = await mapper(values[index]!, index);
    }
  });

  await Promise.all(workers);
  return results;
}

async function probeEpisodeQualities(
  qualityProbe: QualityProbe,
  logger: Logger | undefined,
  context: QualityProbeContext
): Promise<string[]> {
  const startedAt = Date.now();
  logger?.info({ event: 'svt.episode.qualities.started', ...context }, 'SVT episode quality probe started');
  try {
    const qualities = await qualityProbe(context.link);
    logger?.info(
      {
        event: 'svt.episode.qualities.completed',
        ...context,
        qualityCount: qualities.length,
        qualities,
        durationMs: Date.now() - startedAt
      },
      'SVT episode quality probe completed'
    );
    return qualities;
  } catch (error) {
    logger?.warn(
      {
        event: 'svt.episode.qualities.failed',
        ...context,
        error,
        durationMs: Date.now() - startedAt
      },
      'SVT episode quality probe failed'
    );
    throw error;
  }
}

export async function fetchSvtMovie(url: string, options: SvtMovieFetchOptions = {}): Promise<SvtMovieResponse> {
  const normalizedUrl = normalizeSvtMovieUrl(url);
  if (!normalizedUrl) {
    throw new Error('unsupported SVT Play movie URL');
  }

  const response = await fetch(normalizedUrl, {
    signal: AbortSignal.timeout(30_000)
  });
  if (response.status === 404) {
    throw new Error('SVT Play movie not found');
  }
  if (!response.ok) {
    throw new Error(`SVT returned HTTP ${response.status}`);
  }

  const movieResult = await parseSvtMoviePageHtml(
    await response.text(),
    normalizedUrl,
    options.qualityProbe ?? createSvtplayDlQualityProbe(options.logger),
    options.logger
  );
  if (!movieResult) {
    throw new Error('SVT Play movie not found');
  }
  return movieResult;
}

export async function parseSvtMoviePageHtml(
  html: string,
  url: string,
  qualityProbe: QualityProbe = probeSvtplayDlQualities,
  logger?: Logger
): Promise<SvtMovieResponse | null> {
  const detailsPage = extractDetailsPage(html);
  if (!detailsPage) {
    return null;
  }

  const canonicalUrl =
    normalizeSvtMovieUrl(absoluteSvtUrl(firstText(getPath(detailsPage, ['item', 'urls', 'svtplay']))) || url) || url;
  const title =
    firstText(
      getPath(detailsPage, ['item', 'name']),
      getPath(detailsPage, ['details', 'heading']),
      getPath(detailsPage, ['analytics', 'json', 'title']),
      getPath(detailsPage, ['item', 'parent', 'name'])
    ) || humanizeSlug(canonicalUrl);

  logger?.info({ event: 'svt.movie.discovery.started', url: canonicalUrl }, 'SVT movie discovery started');
  const qualities = await qualityProbe(canonicalUrl);
  const quality = qualities[0];
  if (!quality) {
    throw new Error(`svtplay-dl quality probe returned no qualities for ${canonicalUrl}`);
  }

  logger?.info(
    {
      event: 'svt.movie.discovery.completed',
      url: canonicalUrl,
      title,
      quality
    },
    'SVT movie discovery completed'
  );

  return {
    url: canonicalUrl,
    title,
    service: 'svtplay',
    quality
  };
}

function countEpisodes(response: SvtSerieResponse): number {
  return response.seasons.reduce((count, season) => count + season.episodes.length, 0);
}

function extractDetailsPage(html: string): Record<string, unknown> | null {
  const rawUrqlData = extractAssignedObject(html, 'URQL_DATA');
  if (!rawUrqlData) {
    return null;
  }

  const urqlData = parseJson(rawUrqlData);
  if (!isRecord(urqlData)) {
    return null;
  }

  for (const entry of Object.values(urqlData)) {
    const record = asRecord(entry);
    const payload = textValue(record?.data);
    if (!payload) {
      continue;
    }

    const parsedPayload = parseJson(payload);
    const detailsPage = findRecordByKey(parsedPayload, 'detailsPageByPath');
    if (detailsPage) {
      return detailsPage;
    }
  }

  return null;
}

function extractAssignedObject(source: string, name: string): string | null {
  const nameIndex = source.indexOf(name);
  if (nameIndex < 0) {
    return null;
  }
  const equalsIndex = source.indexOf('=', nameIndex + name.length);
  if (equalsIndex < 0) {
    return null;
  }
  const start = source.indexOf('{', equalsIndex + 1);
  if (start < 0) {
    return null;
  }

  let depth = 0;
  let inString = false;
  let escaping = false;
  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    if (!char) {
      continue;
    }

    if (inString) {
      if (escaping) {
        escaping = false;
      } else if (char === '\\') {
        escaping = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === '{') {
      depth += 1;
      continue;
    }
    if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        return source.slice(start, index + 1);
      }
    }
  }

  return null;
}

function findRecordByKey(value: unknown, key: string, depth = 0): Record<string, unknown> | null {
  if (depth > 10) {
    return null;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findRecordByKey(item, key, depth + 1);
      if (found) {
        return found;
      }
    }
    return null;
  }

  const record = asRecord(value);
  if (!record) {
    return null;
  }

  const direct = asRecord(record[key]);
  if (direct) {
    return direct;
  }

  for (const item of Object.values(record)) {
    const found = findRecordByKey(item, key, depth + 1);
    if (found) {
      return found;
    }
  }
  return null;
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function isSeasonSelection(module: Record<string, unknown>, selection: Record<string, unknown>): boolean {
  return (
    firstText(selection.selectionType).toLowerCase() === 'season' ||
    firstText(selection.listPresentation).toLowerCase() === 'season' ||
    extractSeasonFromSelection(module, selection) !== null
  );
}

function extractSeasonFromSelection(
  module: Record<string, unknown>,
  selection: Record<string, unknown>
): number | null {
  return (
    extractSeasonFromText(firstText(selection.name)) ??
    extractSeasonFromText(firstText(getPath(selection, ['analytics', 'json', 'listId']))) ??
    extractSeasonFromText(firstText(getPath(selection, ['analytics', 'json', 'listName']))) ??
    extractNumber(firstText(module.id), /season-(\d+)/i)
  );
}

function extractSeasonFromText(value: string): number | null {
  return extractNumber(value, /(?:säsong|sasong|season)\s*(\d+)/i);
}

function extractTeaserIndex(item: Record<string, unknown>): number | null {
  return (
    readPositiveInteger(getPath(item, ['analytics', 'json', 'listItemIndex'])) ??
    readPositiveInteger(getPath(item, ['analytics', 'json', 'itemIndex']))
  );
}

function absoluteSvtUrl(value: string): string {
  if (!value) {
    return '';
  }
  try {
    const url = new URL(value, SVT_BASE_URL);
    if (url.hostname === 'www.svtplay.se' || url.hostname.endsWith('.svtplay.se')) {
      url.protocol = 'https:';
    }
    return url.toString();
  } catch {
    return '';
  }
}

function parseDate(value: string): number | null {
  if (!value) {
    return null;
  }
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? null : timestamp;
}

function inferFeedOrder(episodes: ParsedRssEpisode[]): FeedOrder {
  const dated = episodes.filter((episode) => episode.publishedAt !== null);
  const firstDate = dated[0]?.publishedAt;
  const lastDate = dated[dated.length - 1]?.publishedAt;
  if (firstDate != null && lastDate != null) {
    if (firstDate > lastDate) {
      return 'desc';
    }
    if (firstDate < lastDate) {
      return 'asc';
    }
  }

  let ascendingPairs = 0;
  let descendingPairs = 0;
  for (let index = 1; index < episodes.length; index += 1) {
    const previous = episodes[index - 1];
    const current = episodes[index];
    if (!previous || !current || previous.episode === current.episode) {
      continue;
    }
    if (current.episode > previous.episode) {
      ascendingPairs += 1;
    } else {
      descendingPairs += 1;
    }
  }
  return ascendingPairs > descendingPairs ? 'asc' : 'desc';
}

function collectSeasonRuns(episodes: ParsedRssEpisode[], order: FeedOrder): SeasonRun[] {
  const runs: SeasonRun[] = [];
  for (const episode of episodes) {
    const currentRun = runs[runs.length - 1];
    const previousEpisode = currentRun?.episodes[currentRun.episodes.length - 1];
    if (!currentRun || !previousEpisode || startsNewSeason(previousEpisode, episode, currentRun, order)) {
      runs.push({
        explicitSeason: episode.explicitSeason,
        episodes: [episode]
      });
      continue;
    }

    currentRun.episodes.push(episode);
    currentRun.explicitSeason ??= episode.explicitSeason;
  }
  return runs;
}

function startsNewSeason(
  previous: ParsedRssEpisode,
  current: ParsedRssEpisode,
  currentRun: SeasonRun,
  order: FeedOrder
): boolean {
  if (
    currentRun.explicitSeason !== null &&
    current.explicitSeason !== null &&
    current.explicitSeason !== currentRun.explicitSeason
  ) {
    return true;
  }
  if (order === 'asc') {
    return current.episode <= previous.episode;
  }
  return current.episode >= previous.episode;
}

function inferSeasonNumbers(runs: SeasonRun[], order: FeedOrder): number[] {
  const explicitRuns = runs
    .map((run, index) => ({ index, season: run.explicitSeason }))
    .filter((run): run is { index: number; season: number } => run.season !== null);

  if (explicitRuns.length === 0) {
    return runs.map((_, index) => (order === 'desc' ? runs.length - index : index + 1));
  }

  return runs.map((run, index) => {
    if (run.explicitSeason !== null) {
      return run.explicitSeason;
    }
    const nearest = explicitRuns.reduce((best, candidate) => {
      return Math.abs(candidate.index - index) < Math.abs(best.index - index) ? candidate : best;
    });
    const inferred =
      order === 'desc' ? nearest.season + nearest.index - index : nearest.season + index - nearest.index;
    return Math.max(1, inferred);
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

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return asRecord(value) !== null;
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

function firstText(...values: unknown[]): string {
  for (const value of values) {
    const text = textValue(value).trim();
    if (text) {
      return text;
    }
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

function readPositiveInteger(value: unknown): number | null {
  const parsed =
    typeof value === 'number' ? value : typeof value === 'string' ? Number.parseInt(value, 10) : Number.NaN;
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function truncateOneLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, 200) || 'no output';
}
