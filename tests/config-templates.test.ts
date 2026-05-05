import { describe, expect, it } from 'vitest';
import { loadConfig, resolveWebhookUrl } from '../src/config.js';
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
