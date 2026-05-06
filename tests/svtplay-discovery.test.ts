import { describe, expect, it } from 'vitest';
import { parseSvtSeriePageHtml, parseSvtSerieXml } from '../src/discovery/svtplay.js';

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
      'mysteriet-pa-greveholm'
    );

    expect(result?.link).toBe('https://www.svtplay.se/mysteriet-pa-greveholm');
    expect(result?.seasons).toHaveLength(1);
    expect(result?.seasons[0]?.season).toBe(1);
    expect(result?.seasons[0]?.episodes.map((episode) => episode.episode)).toEqual(range(1, 24));
    expect(result?.seasons[0]?.episodes[11]).toMatchObject({
      episode: 12,
      title: '12. Episode 12',
      description: 'Del 1 av 24.'
    });
    expect(result?.seasons[0]?.episodes[13]).toMatchObject({
      episode: 14,
      title: '14. Episode 14',
      description: 'Del 1 av 24.'
    });
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

function rss(items: TestRssItem[]): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss xmlns:dc="http://purl.org/dc/elements/1.1/" version="2.0">
  <channel>
    <title>SVT Play - Test</title>
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
