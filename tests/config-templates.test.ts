import { describe, expect, it } from 'vitest';
import { assertUsenetConfigured, loadConfig, resolveWebhookUrl } from '../src/config.js';
import { renderDownloadFilename, renderSeasonPackReleaseName } from '../src/utils/templates.js';
import { testConfig } from './helpers.js';

const DEFAULT_USENET_NEWSGROUPS = [
  'alt.binaries.newznzb.alpha',
  'alt.binaries.newznzb.bravo',
  'alt.binaries.newznzb.charlie',
  'alt.binaries.newznzb.delta',
  'alt.binaries.newznzb.echo',
  'alt.binaries.newznzb.foxtrot',
  'alt.binaries.newznzb.golf',
  'alt.binaries.newznzb.hotel',
  'alt.binaries.newznzb.india',
  'alt.binaries.newznzb.juliett',
  'alt.binaries.newznzb.kilo',
  'alt.binaries.newznzb.lima',
  'alt.binaries.newznzb.mike',
  'alt.binaries.newznzb.november',
  'alt.binaries.newznzb.oscar',
  'alt.binaries.newznzb.papa',
  'alt.binaries.newznzb.quebec',
  'alt.binaries.newznzb.romeo',
  'alt.binaries.newznzb.sierra',
  'alt.binaries.newznzb.tango',
  'alt.binaries.newznzb.uniform',
  'alt.binaries.newznzb.victor',
  'alt.binaries.newznzb.whiskey',
  'alt.binaries.newznzb.xray',
  'alt.binaries.newznzb.yankee',
  'alt.binaries.newznzb.zulu'
];

describe('config and templates', () => {
  it('loads defaults and event-specific webhook overrides', () => {
    const config = loadConfig({
      WEBHOOK_URL: 'https://example.test/all',
      WEBHOOK_NZB_FAILED_URL: 'https://example.test/nzb-failed'
    });

    expect(config.port).toBe(3001);
    expect(config.cors.origins).toEqual([]);
    expect(config.usenet.newsgroups).toEqual(DEFAULT_USENET_NEWSGROUPS);
    expect(config.usenet.newsgroupsPerUpload).toBe(20);
    expect(resolveWebhookUrl(config, 'download.completed')).toBe('https://example.test/all');
    expect(resolveWebhookUrl(config, 'nzb.failed')).toBe('https://example.test/nzb-failed');
  });

  it('loads optional CORS origins', () => {
    expect(loadConfig({ CORS_ORIGINS: 'https://ui.example.test, http://localhost:8080' }).cors.origins).toEqual([
      'https://ui.example.test',
      'http://localhost:8080'
    ]);
    expect(loadConfig({ CORS_ORIGINS: '*' }).cors.origins).toBe('*');
  });

  it('loads generic indexer upload targets', () => {
    const config = loadConfig({
      INDEXER_UPLOADS_JSON: JSON.stringify([
        {
          name: 'drunkenslug',
          url: 'https://nzbs.drunkenslug.com/upload.php',
          fileField: 'files[]'
        }
      ])
    });

    expect(config.indexerUploads).toEqual([
      {
        name: 'drunkenslug',
        url: 'https://nzbs.drunkenslug.com/upload.php',
        method: 'POST',
        format: 'multipart',
        fileField: 'files[]',
        filenameTemplate: '{releaseName}.nzb',
        headers: {},
        fields: {}
      }
    ]);
  });

  it('loads single SABnzbd-compatible push configuration', () => {
    const config = loadConfig({
      SABNZBD_URL: 'http://sabnzbd:8080/api',
      SABNZBD_API_KEY: 'secret',
      SABNZBD_MOVIE_CATEGORY: 'films',
      SABNZBD_SERIES_CATEGORY: 'shows',
      SABNZBD_CATEGORY: 'manual'
    });

    expect(config.sabnzbd).toEqual({
      url: 'http://sabnzbd:8080/api',
      apiKey: 'secret',
      movieCategory: 'films',
      seriesCategory: 'shows',
      category: 'manual'
    });
  });

  it('defaults optional SABnzbd-compatible push settings', () => {
    const config = loadConfig({
      SABNZBD_URL: 'http://nzbdav:3000/api'
    });

    expect(config.sabnzbd).toEqual({
      url: 'http://nzbdav:3000/api',
      apiKey: '',
      movieCategory: 'movies',
      seriesCategory: 'series',
      category: '*'
    });
    expect(loadConfig().sabnzbd.url).toBe('');
    expect(() => loadConfig({ SABNZBD_URL: 'not-a-url' })).toThrow('SABNZBD_URL must be a URL');
  });

  it('validates indexer upload configuration', () => {
    expect(() => loadConfig({ INDEXER_UPLOADS_JSON: 'not-json' })).toThrow('INDEXER_UPLOADS_JSON must be valid JSON');
    expect(() =>
      loadConfig({
        INDEXER_UPLOADS_JSON: JSON.stringify([
          { name: 'one', url: 'https://one.example/upload' },
          { name: 'one', url: 'https://two.example/upload' }
        ])
      })
    ).toThrow('duplicate indexer upload name: one');
    expect(() =>
      loadConfig({
        INDEXER_UPLOADS_JSON: JSON.stringify([{ name: 'bad', url: 'https://example.test/upload', format: 'ftp' }])
      })
    ).toThrow();
  });

  it('uses USENET_NEWSGROUPS when set', () => {
    expect(loadConfig({ USENET_NEWSGROUPS: 'alt.binaries.tv, alt.binaries.misc' }).usenet.newsgroups).toEqual([
      'alt.binaries.tv',
      'alt.binaries.misc'
    ]);
  });

  it('loads and validates the per-upload newsgroup count', () => {
    expect(loadConfig({ USENET_NEWSGROUPS_PER_UPLOAD: '3' }).usenet.newsgroupsPerUpload).toBe(3);
    expect(() => loadConfig({ USENET_NEWSGROUPS_PER_UPLOAD: '0' })).toThrow(
      'USENET_NEWSGROUPS_PER_UPLOAD must be a positive integer'
    );
  });

  it('uses the default newsgroups when validating Usenet config', () => {
    const config = loadConfig({
      USENET_HOST: 'news.example.com',
      USENET_USER: 'user',
      USENET_PASS: 'pass'
    });

    expect(() => assertUsenetConfigured(config)).not.toThrow();
  });

  it('renders sanitized episode and season-pack names', () => {
    const config = testConfig('/tmp/nzb-relay-test');

    expect(
      renderDownloadFilename(config, {
        title: 'Show: Name!',
        service: 'svt play',
        quality: '1080',
        season: 1,
        episode: 2
      })
    ).toBe('Show.Name.s01e02.svt.play.mkv');

    expect(
      renderSeasonPackReleaseName(config, {
        id: 'f1',
        url: 'https://example.test',
        status: 'completed',
        title: 'Show Name',
        service: 'svtplay',
        season: 3,
        episode: 1,
        filename: 'ignored.mkv',
        createdAt: '2026-05-01T00:00:00.000Z',
        downloadedAt: null,
        deleted: 0
      })
    ).toBe('Show.Name.s03.svtplay.mkv');
  });

  it('renders video and audio codec substitutions when provided', () => {
    const config = testConfig('/tmp/nzb-relay-test', {
      TEMPLATE_EPISODE: '{title}.s{season}e{episode}.{quality}p.{videoCodec}.{audioCodec}.{service}.{ext}'
    });

    expect(
      renderDownloadFilename(config, {
        title: 'Show Name',
        service: 'svtplay',
        quality: '1080',
        season: 1,
        episode: 2,
        videoCodec: 'h264',
        audioCodec: 'aac'
      })
    ).toBe('Show.Name.s01e02.1080p.h264.aac.svtplay.mkv');
  });
});
