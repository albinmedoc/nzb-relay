import { XMLParser } from 'fast-xml-parser';
import { fetch } from 'undici';

const SVT_BASE_URL = 'https://www.svtplay.se';

export interface SvtEpisode {
  episode: number;
  title: string;
  description: string;
  link: string;
  qualities: string[];
}

export interface SvtSerieResponse {
  slug: string;
  link: string;
  seasons: Array<{
    season: number;
    episodes: SvtEpisode[];
  }>;
}

type FeedOrder = 'asc' | 'desc';
type QualityProbe = (url: string) => Promise<string[]>;

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

export async function fetchSvtSerie(slug: string): Promise<SvtSerieResponse | null> {
  const encodedSlug = encodeURIComponent(slug).replace(/%2F/g, '/');
  const pageResponse = await fetch(`${SVT_BASE_URL}/${encodedSlug}`, {
    signal: AbortSignal.timeout(30_000)
  });

  if (pageResponse.ok) {
    const pageResult = await parseSvtSeriePageHtml(await pageResponse.text(), slug);
    if (pageResult) {
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
  return parseSvtSerieXml(xml, slug);
}

export async function parseSvtSeriePageHtml(
  html: string,
  slug: string,
  qualityProbe: QualityProbe = async () => []
): Promise<SvtSerieResponse | null> {
  const detailsPage = extractDetailsPage(html);
  if (!detailsPage) {
    return null;
  }

  const serieLink =
    absoluteSvtUrl(firstText(getPath(detailsPage, ['item', 'urls', 'svtplay']))) || `${SVT_BASE_URL}/${slug}`;
  const seasons = await parsePageSeasons(detailsPage, qualityProbe);
  if (seasons.length === 0) {
    return null;
  }

  return {
    slug,
    link: serieLink,
    seasons
  };
}

export async function parseSvtSerieXml(
  xml: string,
  slug: string,
  qualityProbe: QualityProbe = async () => []
): Promise<SvtSerieResponse | null> {
  const parser = new XMLParser({ ignoreAttributes: false, trimValues: true });
  const parsed = parser.parse(xml) as Record<string, unknown>;
  const channel = getPath<Record<string, unknown>>(parsed, ['rss', 'channel']);
  const rawItems = asArray(channel?.item);
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
  const bySeason = new Map<number, SvtEpisode[]>();
  for (const [runIndex, run] of runs.entries()) {
    const season = seasonNumbers[runIndex] ?? 1;
    for (const parsedEpisode of run.episodes) {
      const episode: SvtEpisode = {
        episode: parsedEpisode.episode,
        title: parsedEpisode.title,
        description: parsedEpisode.description,
        link: parsedEpisode.link,
        qualities: await qualityProbe(parsedEpisode.link)
      };
      const group = bySeason.get(season) ?? [];
      group.push(episode);
      bySeason.set(season, group);
    }
  }

  return {
    slug,
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

async function parsePageSeasons(
  detailsPage: Record<string, unknown>,
  qualityProbe: QualityProbe
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

    const episodes: SvtEpisode[] = [];
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
      episodes.push({
        episode: extractEpisode(title, link) ?? extractTeaserIndex(item) ?? index + 1,
        title,
        description: firstText(item.description),
        link,
        qualities: await qualityProbe(link)
      });
    }

    if (episodes.length > 0) {
      seasons.push({
        season,
        episodes: episodes.sort((a, b) => a.episode - b.episode)
      });
    }
  }

  return seasons.sort((a, b) => a.season - b.season);
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
