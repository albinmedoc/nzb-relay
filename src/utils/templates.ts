import type { Config } from '../config.js';
import type { FileRow, NzbFileSummary } from '../types.js';

interface TemplateInput {
  title: string;
  service: string;
  quality?: string;
  season?: number | null;
  episode?: number | null;
  ext?: string;
  videoCodec?: string | null;
  audioCodec?: string | null;
}

export function renderDownloadFilename(config: Config, input: TemplateInput): string {
  const template = input.season != null && input.episode != null ? config.templates.episode : config.templates.movie;
  return renderTemplate(template, input);
}

export function renderSingleReleaseName(config: Config, file: FileRow | NzbFileSummary): string {
  const template = file.season != null && file.episode != null ? config.templates.episode : config.templates.movie;
  return renderTemplate(template, file);
}

export function renderSeasonPackReleaseName(config: Config, file: FileRow | NzbFileSummary): string {
  return renderTemplate(config.templates.seasonPack, file);
}

export function renderTemplate(template: string, input: TemplateInput): string {
  const replacements = {
    title: sanitizeToken(input.title),
    service: sanitizeToken(input.service),
    quality: sanitizeToken(input.quality ?? ''),
    videoCodec: sanitizeToken(input.videoCodec ?? ''),
    audioCodec: sanitizeToken(input.audioCodec ?? ''),
    season: input.season == null ? '' : String(input.season).padStart(2, '0'),
    episode: input.episode == null ? '' : String(input.episode).padStart(2, '0'),
    ext: sanitizeToken(input.ext ?? 'mkv')
  };

  const rendered = template.replace(
    /\{(title|service|quality|videoCodec|audioCodec|season|episode|ext)\}/g,
    (_, key: keyof typeof replacements) => {
      return replacements[key];
    }
  );

  const cleaned = rendered
    .replace(/\s+/g, '.')
    .replace(/[^A-Za-z0-9._-]/g, '')
    .replace(/\.{2,}/g, '.')
    .replace(/^\.+|\.+$/g, '');

  return cleaned || `release.${replacements.ext}`;
}

export function sanitizeToken(value: string): string {
  return value
    .trim()
    .replace(/\s+/g, '.')
    .replace(/[^A-Za-z0-9._-]/g, '')
    .replace(/\.{2,}/g, '.')
    .replace(/^\.+|\.+$/g, '');
}
