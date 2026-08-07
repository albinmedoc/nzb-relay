import { describe, expect, it } from 'vitest';
import { parseSvtMoviePageHtml, parseSvtSeriePageHtml, parseSvtSerieXml, parseSvtplayDlQualities } from '../src/discovery/svtplay.js';

describe('svtplay discovery', () => {
  it('reads seasons and episodes from SVT page data', async () => {
    const result = await parseSvtSeriePageHtml(
      pageData('/mysteriet-pa-greveholm', [
        seasonModule(
          1,
          [
            ...range(24, 14).map((episode) => pageItem(episode, episode === 14 ? 1 : episode)),
            pageItem(13, 13),
            pageItem(12, 1),
            ...range(11, 1).map((episode) => pageItem(episode, episode))
          ]
        ),
        relatedModule([pageItem(99, 99)])
      ]),
      'mysteriet-pa-greveholm',
      async () => ['1080', '720']
    );

    expect(result?.name).toBe('Mysteriet på Greveholm');
    expect(result?.link).toBe('https://www.svtplay.se/mysteriet-pa-greveholm');
    expect(result?.seasons).toHaveLength(1);
    expect(result?.seasons[0]?.season).toBe(1);
    expect(result?.seasons[0]?.episodes.map((episode) => episode.episode)).toEqual(range(1, 24));
    expect(result?.seasons[0]?.episodes[11]).toMatchObject({
      episode: 12,
      title: '12. Episode 12',
      description: 'Del 1 av 24.',
      qualities: ['1080', '720']
    });
    expect(result?.seasons[0]?.episodes[13]).toMatchObject({
      episode: 14,
      title: '14. Episode 14',
      description: 'Del 1 av 24.'
    });
  });

  it('probes page-data qualities concurrently with a bounded limit', async () => {
    let active = 0;
    let maxActive = 0;
    const result = await parseSvtSeriePageHtml(
      pageData('/mysteriet-pa-greveholm', [
        seasonModule(1, range(1, 6).map((episode) => pageItem(episode, episode)))
      ]),
      'mysteriet-pa-greveholm',
      async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await delay(10);
        active -= 1;
        return ['1080'];
      },
      undefined,
      3
    );

    expect(result?.seasons[0]?.episodes).toHaveLength(6);
    expect(maxActive).toBe(3);
  });

  it('can reuse first-episode qualities across each page-data season', async () => {
    const probedUrls: string[] = [];
    const result = await parseSvtSeriePageHtml(
      pageData('/test-serie', [
        seasonModule(1, [pageItemForSeason(1, 3), pageItemForSeason(1, 1), pageItemForSeason(1, 2)]),
        seasonModule(2, [pageItemForSeason(2, 2), pageItemForSeason(2, 1)])
      ]),
      'test-serie',
      async (url) => {
        probedUrls.push(url);
        return url.endsWith('/s1e1') ? ['720'] : ['1080'];
      },
      undefined,
      4,
      true
    );

    expect(probedUrls).toEqual([
      'https://www.svtplay.se/video/test/test-serie/s1e1',
      'https://www.svtplay.se/video/test/test-serie/s2e1'
    ]);
    expect(result?.seasons[0]?.episodes.map((episode) => episode.qualities)).toEqual([['720'], ['720'], ['720']]);
    expect(result?.seasons[1]?.episodes.map((episode) => episode.qualities)).toEqual([['1080'], ['1080']]);
  });

  it('infers seasons from newest-first RSS episode runs', async () => {
    const result = await parseSvtSerieXml(
      rss([
        item(2, 2, 'https://www.svtplay.se/video/s2e2/innan-vi-dor/avsnitt-2', '2025-06-27T02:00:00+02:00'),
        item(1, 2, 'https://www.svtplay.se/video/s2e1/innan-vi-dor/avsnitt-1', '2025-06-27T02:00:00+02:00'),
        item(3, 3, 'https://www.svtplay.se/video/s1e3/innan-vi-dor/avsnitt-3', '2025-06-20T02:00:00+02:00'),
        item(2, 3, 'https://www.svtplay.se/video/s1e2/innan-vi-dor/avsnitt-2', '2025-06-20T02:00:00+02:00'),
        item(1, 3, 'https://www.svtplay.se/video/s1e1/innan-vi-dor/avsnitt-1', '2025-06-20T02:00:00+02:00')
      ]),
      'innan-vi-dor'
    );

    expect(result).toEqual({
      slug: 'innan-vi-dor',
      name: 'Innan vi dör',
      link: 'https://www.svtplay.se/innan-vi-dor',
      seasons: [
        {
          season: 1,
          episodes: [
            {
              episode: 1,
              title: 'Avsnitt 1',
              description: 'Episode description. Del 1 av 3.',
              link: 'https://www.svtplay.se/video/s1e1/innan-vi-dor/avsnitt-1',
              qualities: []
            },
            {
              episode: 2,
              title: 'Avsnitt 2',
              description: 'Episode description. Del 2 av 3.',
              link: 'https://www.svtplay.se/video/s1e2/innan-vi-dor/avsnitt-2',
              qualities: []
            },
            {
              episode: 3,
              title: 'Avsnitt 3',
              description: 'Episode description. Del 3 av 3.',
              link: 'https://www.svtplay.se/video/s1e3/innan-vi-dor/avsnitt-3',
              qualities: []
            }
          ]
        },
        {
          season: 2,
          episodes: [
            {
              episode: 1,
              title: 'Avsnitt 1',
              description: 'Episode description. Del 1 av 2.',
              link: 'https://www.svtplay.se/video/s2e1/innan-vi-dor/avsnitt-1',
              qualities: []
            },
            {
              episode: 2,
              title: 'Avsnitt 2',
              description: 'Episode description. Del 2 av 2.',
              link: 'https://www.svtplay.se/video/s2e2/innan-vi-dor/avsnitt-2',
              qualities: []
            }
          ]
        }
      ]
    });
  });

  it('uses explicit season metadata when SVT exposes it', async () => {
    const result = await parseSvtSerieXml(
      rss([
        {
          title: 'Säsong 4 - Avsnitt 2',
          link: 'https://www.svtplay.se/video/explicit-2/serie/sasong-4-avsnitt-2',
          description: 'Del 2 av 2.',
          pubDate: '2025-06-27T02:00:00+02:00'
        },
        {
          title: 'Säsong 4 - Avsnitt 1',
          link: 'https://www.svtplay.se/video/explicit-1/serie/sasong-4-avsnitt-1',
          description: 'Del 1 av 2.',
          pubDate: '2025-06-27T02:00:00+02:00'
        }
      ]),
      'explicit-serie'
    );

    expect(result?.seasons).toHaveLength(1);
    expect(result?.seasons[0]).toMatchObject({
      season: 4,
      episodes: [
        { episode: 1 },
        { episode: 2 }
      ]
    });
  });

  it('prefers numbered item titles over inconsistent episode descriptions', async () => {
    const result = await parseSvtSerieXml(
      rss([
        ...range(24, 14).map((episode) => numberedItem(episode, episode === 14 ? 1 : episode)),
        numberedItem(13, 13),
        numberedItem(12, 1),
        ...range(11, 1).map((episode) => numberedItem(episode, episode))
      ]),
      'mysteriet-pa-greveholm'
    );

    expect(result?.seasons).toHaveLength(1);
    expect(result?.seasons[0]?.season).toBe(1);
    expect(result?.seasons[0]?.episodes.map((episode) => episode.episode)).toEqual(range(1, 24));
  });

  it('does not identify season or episode from description text', async () => {
    const result = await parseSvtSerieXml(
      rss([
        {
          title: 'Episode without identity metadata',
          link: 'https://www.svtplay.se/video/test/serie/episode-without-identity-metadata',
          description: 'Säsong 9. Del 7 av 7.',
          pubDate: '2025-06-27T02:00:00+02:00'
        }
      ]),
      'description-only-metadata'
    );

    expect(result?.seasons).toEqual([
      {
        season: 1,
        episodes: [
          {
            episode: 1,
            title: 'Episode without identity metadata',
            description: 'Säsong 9. Del 7 av 7.',
            link: 'https://www.svtplay.se/video/test/serie/episode-without-identity-metadata',
            qualities: []
          }
        ]
      }
    ]);
  });

  it('uses document titles as the primary movie title source and selects the highest quality', async () => {
    const result = await parseSvtMoviePageHtml(
      moviePageData('https://www.svtplay.se/video/movie/test', 'Embedded Metadata Title', 'Document Title – Document Title | SVT Play'),
      'https://www.svtplay.se/video/movie/test?foo=bar',
      async () => ['1080', '720']
    );

    expect(result).toEqual({
      url: 'https://www.svtplay.se/video/movie/test',
      title: 'Document Title',
      service: 'svtplay',
      quality: '1080'
    });
  });

  it('uses document titles for movie pages without SVT page data', async () => {
    const probedUrls: string[] = [];
    const result = await parseSvtMoviePageHtml(
      '<html><head><title data-next-head="">Toy Story 3 – Toy Story 3 | SVT Play</title></head></html>',
      'https://www.svtplay.se/video/j16GErk/toy-story-2/toy-story-2?video=visa',
      async (url) => {
        probedUrls.push(url);
        return ['1080', '720'];
      }
    );

    expect(result).toEqual({
      url: 'https://www.svtplay.se/video/j16GErk/toy-story-2/toy-story-2',
      title: 'Toy Story 3',
      service: 'svtplay',
      quality: '1080'
    });
    expect(probedUrls).toEqual(['https://www.svtplay.se/video/j16GErk/toy-story-2/toy-story-2']);
  });

  it('parses resolution heights from svtplay-dl quality output', () => {
    expect(
      parseSvtplayDlQualities(`
INFO: Quality:  Method:  Codec:  Resolution:  Language:  Role:
INFO: 3384      hls      h264    1920x1080    sv         main
INFO: 2329      hls      h264    1280x720     sv         main
INFO: 1555      hls      h264    960x540      sv         main
INFO: 1040      hls      h264    640x360      sv         main
INFO: 550       hls      h264    416x234      sv         main
`)
    ).toEqual(['1080', '720', '540', '360', '234']);
  });
});

interface TestRssItem {
  title: string;
  link: string;
  description: string;
  pubDate: string;
}

function item(episode: number, total: number, link: string, pubDate: string): TestRssItem {
  return {
    title: `Avsnitt ${episode}`,
    link,
    description: `Episode description. Del ${episode} av ${total}.`,
    pubDate
  };
}

function numberedItem(episode: number, describedEpisode: number): TestRssItem {
  return {
    title: `${episode}. Episode ${episode}`,
    link: `https://www.svtplay.se/video/test/mysteriet-pa-greveholm/${episode}-episode-${episode}`,
    description: `Episode description. Del ${describedEpisode} av 24.`,
    pubDate: '2017-04-02T06:00:00+02:00'
  };
}

function range(from: number, to: number): number[] {
  const step = from <= to ? 1 : -1;
  const values: number[] = [];
  for (let value = from; step > 0 ? value <= to : value >= to; value += step) {
    values.push(value);
  }
  return values;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface TestPageModule {
  id: string;
  selection: {
    name: string;
    selectionType: string;
    listPresentation: string;
    analytics: {
      json: {
        listId: string;
        listName: string;
      };
    };
    items: TestPageItem[];
  };
}

interface TestPageItem {
  heading: string;
  description: string;
  analytics: {
    json: {
      listItemIndex: number;
      itemIndex: number;
    };
  };
  item: {
    name: string;
    urls: {
      svtplay: string;
    };
  };
}

function pageData(link: string, modules: TestPageModule[]): string {
  const urqlData = {
    cache: {
      hasNext: false,
      data: JSON.stringify({
        detailsPageByPath: {
          item: {
            parent: {
              name: 'Mysteriet på Greveholm'
            },
            urls: {
              svtplay: link
            }
          },
          modules
        }
      })
    }
  };

  return `<html><script>URQL_DATA = ${JSON.stringify(urqlData)};</script></html>`;
}

function moviePageData(link: string, title: string, documentTitle?: string): string {
  const urqlData = {
    cache: {
      hasNext: false,
      data: JSON.stringify({
        detailsPageByPath: {
          item: {
            name: title,
            parent: {
              name: 'Not the title'
            },
            urls: {
              svtplay: link
            }
          },
          details: {
            heading: title
          },
          analytics: {
            json: {
              title
            }
          },
          modules: []
        }
      })
    }
  };

  return `<html><head>${documentTitle ? `<title data-next-head="">${documentTitle}</title>` : ''}</head><script>URQL_DATA = ${JSON.stringify(urqlData)};</script></html>`;
}

function seasonModule(season: number, items: TestPageItem[]): TestPageModule {
  return {
    id: `season-${season}-test`,
    selection: {
      name: `Säsong ${season}`,
      selectionType: 'season',
      listPresentation: 'Season',
      analytics: {
        json: {
          listId: `Säsong ${season}`,
          listName: `Säsong ${season}`
        }
      },
      items
    }
  };
}

function relatedModule(items: TestPageItem[]): TestPageModule {
  return {
    id: 'related-test',
    selection: {
      name: 'Related',
      selectionType: 'related',
      listPresentation: 'Default',
      analytics: {
        json: {
          listId: 'Related',
          listName: 'Related'
        }
      },
      items
    }
  };
}

function pageItem(episode: number, describedEpisode: number): TestPageItem {
  return {
    heading: `${episode}. Episode ${episode}`,
    description: `Del ${describedEpisode} av 24.`,
    analytics: {
      json: {
        listItemIndex: episode,
        itemIndex: episode
      }
    },
    item: {
      name: `${episode}. Episode ${episode}`,
      urls: {
        svtplay: `/video/test/mysteriet-pa-greveholm/${episode}-episode-${episode}`
      }
    }
  };
}

function pageItemForSeason(season: number, episode: number): TestPageItem {
  const testItem = pageItem(episode, episode);
  testItem.item.urls.svtplay = `/video/test/test-serie/s${season}e${episode}`;
  return testItem;
}

function rss(items: TestRssItem[]): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss xmlns:dc="http://purl.org/dc/elements/1.1/" version="2.0">
  <channel>
    <title>SVT Play - Innan vi dör</title>
    <link>https://www.svtplay.se/innan-vi-dor</link>
    ${items
      .map(
        (rssItem) => `<item>
      <title>${rssItem.title}</title>
      <link>${rssItem.link}</link>
      <guid>${rssItem.link}</guid>
      <description>${rssItem.description}</description>
      <pubDate>${rssItem.pubDate}</pubDate>
      <dc:date>${rssItem.pubDate}</dc:date>
    </item>`
      )
      .join('\n')}
  </channel>
</rss>`;
}
