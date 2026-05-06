import { describe, expect, it } from 'vitest';
import { assertUsenetConfigured, loadConfig, resolveWebhookUrl } from '../src/config.js';
import { renderDownloadFilename, renderSeasonPackReleaseName } from '../src/utils/templates.js';
import { testConfig } from './helpers.js';

describe('config and templates', () => {
  it('loads defaults and event-specific webhook overrides', () => {
    const config = loadConfig({
      WEBHOOK_URL: 'https://example.test/all',
      WEBHOOK_NZB_FAILED_URL: 'https://example.test/nzb-failed'
    });

    expect(config.port).toBe(3001);
    expect(resolveWebhookUrl(config, 'download.completed')).toBe('https://example.test/all');
    expect(resolveWebhookUrl(config, 'nzb.failed')).toBe('https://example.test/nzb-failed');
  });

  it('uses USENET_NEWSGROUPS and accepts previous variable names as fallbacks', () => {
    expect(loadConfig({ USENET_NEWSGROUPS: 'alt.binaries.tv, alt.binaries.misc' }).usenet.newsgroups).toEqual([
      'alt.binaries.tv',
      'alt.binaries.misc'
    ]);
    expect(loadConfig({ USENET_NEWSGROUP: 'alt.binaries.single' }).usenet.newsgroups).toEqual([
      'alt.binaries.single'
    ]);
    expect(loadConfig({ USENET_RELEASE_GROUP: 'alt.binaries.legacy' }).usenet.newsgroups).toEqual([
      'alt.binaries.legacy'
    ]);
    expect(
      loadConfig({
        USENET_NEWSGROUPS: 'alt.binaries.tv,alt.binaries.misc',
        USENET_NEWSGROUP: 'alt.binaries.single',
        USENET_RELEASE_GROUP: 'alt.binaries.legacy'
      }).usenet.newsgroups
    ).toEqual(['alt.binaries.tv', 'alt.binaries.misc']);
  });

  it('reports the new newsgroup variable name when Usenet config is incomplete', () => {
    const config = loadConfig({
      USENET_HOST: 'news.example.com',
      USENET_USER: 'user',
      USENET_PASS: 'pass'
    });

    expect(() => assertUsenetConfigured(config)).toThrow(
      'missing Usenet configuration: USENET_NEWSGROUPS'
    );
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
        title: 'Show Name',
        service: 'svtplay',
        season: 3,
        episode: 1,
        filename: 'ignored.mkv',
        downloadedAt: null,
        deleted: 0
      })
    ).toBe('Show.Name.s03.svtplay.mkv');
  });
});
