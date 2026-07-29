import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Config } from '../src/config.js';
import type { AppDatabase } from '../src/db/client.js';
import { getFile, getNzb } from '../src/db/repository.js';
import { getMovieJob } from '../src/db/movie-repository.js';
import { MovieWorker } from '../src/workers/movie-worker.js';
import { cleanup, createTempDataDir, createTestApp, createTestDb, testConfig } from './helpers.js';

let dataDir: string;
let config: Config;
let db: AppDatabase;
let app: ReturnType<typeof createTestApp>;

beforeEach(async () => {
  dataDir = await createTempDataDir();
  config = testConfig(dataDir, {
    API_KEY: 'secret'
  });
  db = createTestDb(config);
  app = createTestApp(db, config, undefined, {
    async fetchMovie(url) {
      return {
        url,
        title: 'Movie Title',
        service: 'svtplay',
        quality: '2160'
      };
    }
  });
});

afterEach(async () => {
  await cleanup(dataDir, db);
});

describe('movie API', () => {
  it('creates a movie job and queues a normal movie download without watchlist rows', async () => {
    const response = await app.request('/v1/movies', {
      method: 'POST',
      headers: {
        authorization: 'Bearer secret',
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        url: 'https://www.svtplay.se/video/movie/test'
      })
    });

    expect(response.status).toBe(202);
    const body = (await response.json()) as { movieId: string; fileId: string; status: string };
    expect(body).toMatchObject({
      movieId: expect.any(String),
      fileId: expect.any(String),
      status: 'download_queued'
    });

    expect(getMovieJob(db, body.movieId)).toMatchObject({
      url: 'https://www.svtplay.se/video/movie/test',
      title: 'Movie Title',
      status: 'download_queued',
      fileId: body.fileId,
      downloadAttempts: 1,
      nzbAttempts: 0
    });
    expect(getFile(db, body.fileId)).toMatchObject({
      url: 'https://www.svtplay.se/video/movie/test',
      title: 'Movie Title',
      filename: 'Movie.Title.svtplay.mkv',
      quality: '2160',
      season: null,
      episode: null
    });
    expect((db.prepare('SELECT COUNT(*) AS count FROM watchlist_source').get() as { count: number }).count).toBe(0);
    expect((db.prepare('SELECT COUNT(*) AS count FROM watchlist_episode').get() as { count: number }).count).toBe(0);
  });

  it('rejects duplicate active movie URLs', async () => {
    await createMovie('https://www.svtplay.se/video/duplicate');

    const duplicate = await createMovie('https://www.svtplay.se/video/duplicate');

    expect(duplicate.status).toBe(409);
    expect(await duplicate.json()).toMatchObject({ code: 'duplicate_url' });
  });

  it('rejects unsupported movie URLs', async () => {
    const response = await app.request('/v1/movies', {
      method: 'POST',
      headers: {
        authorization: 'Bearer secret',
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        url: 'https://example.test/movie'
      })
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: 'unsupported_movie_url' });
  });

  it('retries a failed movie download with a fresh file row', async () => {
    const created = await createMovie('https://www.svtplay.se/video/retry');
    const body = (await created.json()) as { movieId: string; fileId: string };
    db.prepare("UPDATE file SET status = 'failed', errorCode = 'unknown', error = 'failed' WHERE id = ?").run(body.fileId);

    await reconcileDownloads(worker());
    expect(getMovieJob(db, body.movieId)).toMatchObject({
      status: 'download_failed',
      fileId: body.fileId,
      lastError: 'failed'
    });

    const retry = await app.request(`/v1/movies/${body.movieId}/retry`, {
      method: 'POST',
      headers: { authorization: 'Bearer secret' }
    });

    expect(retry.status).toBe(202);
    const retried = (await retry.json()) as { fileId: string; status: string };
    expect(retried.status).toBe('download_queued');
    expect(retried.fileId).not.toBe(body.fileId);
    expect(getMovieJob(db, body.movieId)).toMatchObject({
      fileId: retried.fileId,
      downloadAttempts: 2,
      status: 'download_queued'
    });
  });
});

describe('movie worker', () => {
  it('queues an NZB after movie download completion and marks the movie posted when the NZB completes', async () => {
    const created = await createMovie('https://www.svtplay.se/video/worker');
    const body = (await created.json()) as { movieId: string; fileId: string };
    const file = getFile(db, body.fileId)!;
    await writeMediaFile(file);
    db.prepare("UPDATE file SET status = 'completed', downloadedAt = ? WHERE id = ?").run('2026-05-01T00:00:00.000Z', file.id);

    const movieWorker = worker();
    await reconcileDownloads(movieWorker);
    expect(getMovieJob(db, body.movieId)).toMatchObject({
      status: 'download_completed',
      downloadedAt: '2026-05-01T00:00:00.000Z'
    });

    await queueNzbs(movieWorker);
    const queued = getMovieJob(db, body.movieId)!;
    expect(queued).toMatchObject({
      status: 'nzb_queued',
      nzbAttempts: 1,
      nzbId: expect.any(String)
    });
    expect(getNzb(db, queued.nzbId!)).toMatchObject({
      releaseName: 'Movie.Title.svtplay',
      status: 'pending'
    });

    db.prepare("UPDATE nzb SET status = 'completed', postedAt = ? WHERE id = ?").run('2026-05-01T01:00:00.000Z', queued.nzbId);
    await reconcileNzbs(movieWorker);

    expect(getMovieJob(db, body.movieId)).toMatchObject({
      status: 'posted',
      postedAt: '2026-05-01T01:00:00.000Z',
      fileId: body.fileId
    });
    expect(getFile(db, body.fileId)).toMatchObject({
      status: 'completed',
      deleted: 0
    });
  });
});

function createMovie(url: string): Promise<Response> {
  return app.request('/v1/movies', {
    method: 'POST',
    headers: {
      authorization: 'Bearer secret',
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      url
    })
  });
}

function worker(): MovieWorker {
  return new MovieWorker(db, config, { info() {}, warn() {}, error() {} } as never);
}

async function reconcileDownloads(movieWorker: MovieWorker): Promise<void> {
  await (movieWorker as unknown as { reconcileDownloads(): Promise<void> }).reconcileDownloads();
}

async function queueNzbs(movieWorker: MovieWorker): Promise<void> {
  await (movieWorker as unknown as { queueNzbs(): Promise<void> }).queueNzbs();
}

async function reconcileNzbs(movieWorker: MovieWorker): Promise<void> {
  await (movieWorker as unknown as { reconcileNzbs(): Promise<void> }).reconcileNzbs();
}

async function writeMediaFile(file: { id: string; filename: string }): Promise<void> {
  const mediaPath = path.join(config.downloadsDir, file.id, file.filename);
  await fs.mkdir(path.dirname(mediaPath), { recursive: true });
  await fs.writeFile(mediaPath, 'media');
}
