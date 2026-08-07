# API Documentation

All endpoints are mounted under `/v1`.

`GET /v1/health` is always open. Every other endpoint requires bearer authentication when `API_KEY` is set:

```http
Authorization: Bearer <API_KEY>
```

Error responses use this JSON shape:

```json
{
  "error": "short human-readable message",
  "code": "machine_readable_code",
  "requestId": "optional request id"
}
```

## Health

### `GET /v1/health`

Returns service liveness once HTTP and the database are initialized.
For release images, `version` is the GitHub release tag used to build the image.

Response:

```json
{
  "status": "ok",
  "version": "v1.1.0"
}
```

## Discovery

### `GET /v1/svtplay/serie/:slug`

Fetches `https://www.svtplay.se/<slug>` and parses SVT's embedded page data into seasons and episodes.
If the page data cannot be parsed, the service falls back to `https://www.svtplay.se/<slug>/rss.xml`.
By default, discovery runs `svtplay-dl --list-quality` for each episode, with bounded concurrency, and returns available resolution heights in `qualities`.
Use `?qualities=false` to skip probing and return empty quality arrays.
Use `?fast=true` to probe only the first episode in each season and reuse those qualities for the rest of that season.

Response:

```json
{
  "slug": "30-grader-i-februari",
  "name": "30 grader i februari",
  "link": "https://www.svtplay.se/30-grader-i-februari",
  "seasons": [
    {
      "season": 1,
      "episodes": [
        {
          "episode": 1,
          "title": "Avsnitt 1",
          "description": "Del 1 av 10. ...",
          "link": "https://www.svtplay.se/video/...",
          "qualities": ["1080", "720", "540"]
        }
      ]
    }
  ]
}
```

Status codes:

- `200` success
- `404` series not found
- `502` SVT discovery fetch or parse failed

## Movies

Movies are one-shot jobs. They create a normal download immediately, then automatically queue one NZB after that download completes. Movie jobs do not create watchlist sources or episodes, and downloaded movie files are kept after NZB posting.
Movie creation only accepts an SVT Play video URL; the server parses the title and picks the best available quality.

### `POST /v1/movies`

Queues a movie download and automatic NZB posting.

Request:

```json
{
  "url": "https://www.svtplay.se/video/..."
}
```

Response:

```json
{
  "movieId": "uuid",
  "fileId": "uuid",
  "status": "download_queued"
}
```

Status codes:

- `202` queued
- `400 invalid_json`
- `400 missing_required_param`
- `400 malformed_url`
- `400 unsupported_movie_url`
- `404 movie_not_found`
- `502 svt_unavailable`
- `502 movie_quality_probe_failed`
- `502 movie_discovery_failed`
- `409 duplicate_url`

### `GET /v1/movies`

Lists movie jobs, newest first.

Query parameters:

- `limit`, default `20`, max `100`
- `offset`, default `0`
- `status`: `download_queued`, `download_failed`, `download_completed`, `nzb_queued`, `nzb_failed`, `posted`, or `blocked`
- `createdAfter`
- `createdBefore`

### `GET /v1/movies/:movieId`

Returns a single movie job.

### `POST /v1/movies/:movieId/retry`

Retries a failed movie job. Download failures get a fresh download row. NZB failures reuse the completed movie file and queue a fresh NZB attempt.

### `DELETE /v1/movies/:movieId`

Deletes movie metadata. Linked file and NZB jobs remain visible in their respective job lists.

## Watchlist

The watchlist is provider-neutral, but currently only SVT Play series URLs are supported.
The app polls watched sources, records discovered episodes, queues missing downloads, and can automatically queue one NZB per completed episode.
Watchlist retries create new file/NZB job rows while an episode is failing, then remove older failed attempts once a later download or NZB succeeds.
If an NZB fails because the completed media file is missing, the episode is moved back to download retry state.
Auto-queued watchlist NZBs use the completed media filename basename for the NZB/log basename, for example `Show.s01e02.svtplay.mkv` becomes `Show.s01e02.svtplay.nzb`.
By default, watchlist sources soft-delete downloaded files after their NZB upload completes. The watchlist episode remains `posted`, the file row remains as deleted history, and the download artifacts are removed from disk.

Environment knobs:

- `WATCHLIST_POLL_INTERVAL_SECONDS`, default `3600`
- `WATCHLIST_RECONCILE_INTERVAL_SECONDS`, default `10`
- `WATCHLIST_AUTO_NZB`, default `true`
- `WATCHLIST_MAX_ATTEMPTS`, default `3`

### `POST /v1/watchlist`

Adds a series URL to the watchlist.

Request:

```json
{
  "url": "https://www.svtplay.se/30-grader-i-februari",
  "backfill": true,
  "deleteFileAfterNzb": true
}
```

Required fields:

- `url`

Optional fields:

- `backfill`, default `true`
- `deleteFileAfterNzb`, default `true`

When `backfill=false`, the first successful scan records currently available episodes as `seen` without queueing them. Episodes first discovered on later scans are queued normally.
When `deleteFileAfterNzb=true`, watchlist-owned downloaded files are soft-deleted after their NZB upload completes. This does not apply to manually submitted NZB jobs.

Response:

```json
{
  "id": "uuid",
  "service": "svtplay",
  "type": "series",
  "url": "https://www.svtplay.se/30-grader-i-februari",
  "title": null,
  "enabled": true,
  "backfill": true,
  "deleteFileAfterNzb": true,
  "firstScanCompleted": false,
  "lastScannedAt": null,
  "nextScanAt": "2026-05-06T12:00:00.000Z",
  "lastErrorCode": null,
  "lastError": null,
  "createdAt": "2026-05-06T12:00:00.000Z",
  "updatedAt": "2026-05-06T12:00:00.000Z"
}
```

Status codes:

- `201` created
- `400 invalid_json`
- `400 missing_required_param`
- `400 invalid_backfill`
- `400 invalid_delete_file_after_nzb`
- `400 unsupported_watch_url`
- `409 duplicate_watch_url`

### `GET /v1/watchlist`

Lists watchlist sources, newest first.

Query parameters:

- `limit`, default `20`, max `100`
- `offset`, default `0`

Response:

```json
{
  "items": [
    {
      "id": "uuid",
      "service": "svtplay",
      "type": "series",
      "url": "https://www.svtplay.se/30-grader-i-februari",
      "title": "30 grader i februari",
      "enabled": true,
      "backfill": true,
      "deleteFileAfterNzb": true,
      "firstScanCompleted": true,
      "lastScannedAt": "2026-05-06T12:00:00.000Z",
      "nextScanAt": "2026-05-06T13:00:00.000Z",
      "lastErrorCode": null,
      "lastError": null,
      "createdAt": "2026-05-06T11:55:00.000Z",
      "updatedAt": "2026-05-06T12:00:00.000Z",
      "episodeCount": 10,
      "queuedCount": 1,
      "postedCount": 8,
      "blockedCount": 0
    }
  ],
  "total": 1,
  "limit": 20,
  "offset": 0
}
```

### `GET /v1/watchlist/:sourceId`

Returns a watchlist source and its episodes.

Episode rows reference the source and only store episode-specific metadata. Source fields such as `service` and series `title` are used when queueing downloads for filename rendering.

Episode statuses:

- `seen`
- `discovered`
- `download_queued`
- `download_failed`
- `download_completed`
- `nzb_queued`
- `nzb_failed`
- `posted`
- `blocked`

Status codes:

- `200` found
- `404` source does not exist

### `PATCH /v1/watchlist/:sourceId`

Updates editable fields on a watchlist source.

Request:

```json
{
  "enabled": false,
  "deleteFileAfterNzb": false,
  "title": "Custom Series Title"
}
```

All fields are optional, but at least one editable field must be present.

Editable fields:

- `enabled`
- `deleteFileAfterNzb`
- `title`

Manual titles are preserved during future scans; provider-discovered titles only fill sources that do not already have a title.

Status codes:

- `200` updated
- `400 invalid_json`
- `400 empty_update`
- `400 invalid_enabled`
- `400 invalid_delete_file_after_nzb`
- `400 invalid_title`
- `404` source does not exist

### `DELETE /v1/watchlist/:sourceId`

Stops monitoring a source and deletes its watchlist metadata.

This does not delete files, NZB jobs, or artifacts that were already created.

Status codes:

- `204` deleted
- `404` source does not exist

### `POST /v1/watchlist/:sourceId/retry`

Retries failed watchlist work for a source.

All episodes under the source with status `download_failed`, `nzb_failed`, or `blocked` are reset so the watchlist worker can queue them again on its next reconciliation pass.

Response:

```json
{
  "sourceId": "uuid",
  "retried": 2
}
```

Status codes:

- `202` retry state updated
- `404` source does not exist

## Downloads

### `POST /v1/downloads`

Queues an async download job.

Request:

```json
{
  "url": "https://www.svtplay.se/video/...",
  "title": "Show Title",
  "service": "svtplay",
  "quality": "1080",
  "season": 1,
  "episode": 2
}
```

Required fields:

- `url`
- `title`
- `service`
- `quality`

Optional fields:

- `season`
- `episode`

`season` and `episode` must either both be present or both be absent.

Response:

```json
{
  "fileId": "uuid",
  "status": "pending"
}
```

Status codes:

- `202` queued
- `400` invalid body, malformed URL, malformed quality, or partial episode metadata
- `409 duplicate_url` active non-deleted row already exists for this URL

Failed download rows do not block retrying the same URL.

### `GET /v1/files`

Lists non-deleted file rows, newest first.

Query parameters:

- `limit`, default `20`, max `100`
- `offset`, default `0`
- `status`, one of `pending`, `running`, `completed`, `failed`
- `createdAfter`, valid datetime, inclusive `createdAt >= createdAfter`
- `createdBefore`, valid datetime, inclusive `createdAt <= createdBefore`
- `watchlistSourceId`, filters to files linked from episodes under the watchlist source
- `includeDeleted`, `true` or `false`, default `false`; useful with `watchlistSourceId` because posted watchlist files can be soft-deleted

Invalid filters return `400` with `invalid_status`, `invalid_created_after`, `invalid_created_before`, `invalid_created_range`, `invalid_watchlist_source_id`, or `invalid_include_deleted`.

Response:

```json
{
  "items": [
    {
      "id": "uuid",
      "url": "https://...",
      "status": "pending",
      "filename": "Show.s01e02.svtplay.mkv",
      "createdAt": "2026-05-05T12:00:00.000Z",
      "downloadedAt": null,
      "deleted": false,
      "errorCode": null,
      "error": null
    }
  ],
  "total": 1,
  "limit": 20,
  "offset": 0
}
```

### `GET /v1/files/:fileId`

Returns file metadata. Soft-deleted rows still return `200` with `deleted: true`.

Status codes:

- `200` found
- `404` row does not exist

### `GET /v1/files/:fileId/download`

Streams the completed MKV.

Response headers:

- `Content-Type: video/x-matroska`
- `Content-Length`
- `Content-Disposition: attachment; filename="<filename>.mkv"`

Status codes:

- `200` stream full file
- `409 not_ready` file status is not `completed`
- `404` row does not exist or is deleted

Range requests are not supported. The server ignores `Range` and returns the full body.

### `POST /v1/files/archive`

Streams a ZIP archive for completed file artifacts.

Request:

```json
{
  "fileIds": ["uuid-1", "uuid-2"]
}
```

Status codes:

- `200` ZIP stream
- `400 empty_list`
- `400 duplicate_file_id`
- `404 not_found`
- `409 file_deleted`
- `409 not_ready`
- `500 artifact_missing`

### `GET /v1/files/:fileId/logs`

Returns the per-download plain-text log.

Status codes:

- `200` log body
- `404` row does not exist
- `500 log_missing` row exists but log file is missing

### `DELETE /v1/files/:fileId?force=<bool>`

Deletes file artifacts.

Default behavior:

- removes MKV and log files
- marks the row `deleted = true`

With `force=true`:

- removes MKV and log files
- hard-deletes the row
- rejects with `409 referenced_by_nzb` if any NZB references the file

If the file is running, the active `svtplay-dl` child process is killed before the row is deleted. User-initiated deletes do not emit `download.failed` webhooks.

Status codes:

- `204` deleted
- `404` row does not exist
- `409 referenced_by_nzb` hard-delete is blocked

### `POST /v1/files/:fileId/retry`

Retries a failed download by resetting the same file row back to `pending`.

Only failed, non-deleted file rows can be retried. Soft-deleted files are rejected.

Response:

```json
{
  "fileId": "uuid",
  "status": "pending"
}
```

Status codes:

- `202` queued for retry
- `404` row does not exist
- `409 file_not_failed`
- `409 file_deleted`
- `409 duplicate_url`

## NZB Uploads

### `POST /v1/nzb`

Queues an async NZB upload job for one or more completed files.

Request:

```json
{
  "fileIds": ["uuid-1", "uuid-2"],
  "name": "Bakom.varje.man.s02.svtplay"
}
```

`name` is the release/NZB basename. It is sanitized the same way as generated filenames and is used for the NZB and log files under `/data/nzb/<nzbId>/`.

Validation order:

1. Body shape: `empty_list`, `duplicate_file_id`, `invalid_name`
2. File existence and state, in submission order: `file_missing`, `file_pending`, `file_failed`, `file_deleted`
3. Multi-file consistency: `season_pack_mismatch`

Response:

```json
{
  "nzbId": "uuid",
  "status": "pending"
}
```

Status codes:

- `202` queued
- `400 empty_list`
- `400 duplicate_file_id`
- `400 invalid_name`
- `400 season_pack_mismatch`
- `409 file_missing`
- `409 file_pending`
- `409 file_failed`
- `409 file_deleted`

Re-submitting the same set of `fileIds` creates a new NZB job.

### `GET /v1/nzb`

Lists NZB jobs, newest first.

Query parameters:

- `limit`, default `20`, max `100`
- `offset`, default `0`
- `status`, one of `pending`, `running`, `completed`, `failed`
- `createdAfter`, valid datetime, inclusive `createdAt >= createdAfter`
- `createdBefore`, valid datetime, inclusive `createdAt <= createdBefore`
- `watchlistSourceId`, filters to NZBs linked from episodes under the watchlist source

Invalid filters return `400` with `invalid_status`, `invalid_created_after`, `invalid_created_before`, `invalid_created_range`, or `invalid_watchlist_source_id`.

Response:

```json
{
  "items": [
    {
      "id": "uuid",
      "status": "completed",
      "nzbFile": "uuid/Bakom.varje.man.s02.svtplay.nzb",
      "createdAt": "2026-05-05T12:00:00.000Z",
      "postedAt": "2026-05-05T12:10:00.000Z",
      "errorCode": null,
      "error": null,
      "files": [
        {
          "id": "file-uuid",
          "url": "https://...",
          "status": "completed",
          "createdAt": "2026-05-05T10:55:00.000Z",
          "downloadedAt": "2026-05-05T11:00:00.000Z"
        }
      ],
      "indexerUploads": [
        {
          "id": "upload-uuid",
          "indexerName": "drunkenslug",
          "url": "https://nzbs.drunkenslug.com/upload.php",
          "status": "completed",
          "attempts": 0,
          "nextAttemptAt": null,
          "lastError": null,
          "uploadedAt": "2026-05-05T12:11:00.000Z"
        }
      ]
    }
  ],
  "total": 1,
  "limit": 20,
  "offset": 0
}
```

Nested files are returned in canonical order: `episode ASC NULLS LAST, fileId ASC`.
`indexerUploads` is empty unless optional indexer upload targets are configured.

### `GET /v1/nzb/:nzbId`

Returns NZB job metadata.

Status codes:

- `200` found
- `404` row does not exist

### `GET /v1/nzb/:nzbId/download`

Streams the completed NZB file.

Response headers:

- `Content-Type: application/x-nzb`
- `Content-Length`
- `Content-Disposition: attachment; filename="<releaseName>.nzb"`

Status codes:

- `200` stream full NZB
- `409 not_ready` NZB status is not `completed`
- `404` row does not exist

Range requests are not supported. The server ignores `Range` and returns the full body.

### `POST /v1/nzb/archive`

Streams a ZIP archive for completed NZB artifacts.

Request:

```json
{
  "nzbIds": ["uuid-1", "uuid-2"]
}
```

Status codes:

- `200` ZIP stream
- `400 empty_list`
- `400 duplicate_nzb_id`
- `404 not_found`
- `409 not_ready`
- `500 artifact_missing`

### `GET /v1/nzb/:nzbId/logs`

Returns the upload pipeline log from `rar`, `parpar`, and `nyuu`.

Status codes:

- `200` log body
- `404` row does not exist
- `500 log_missing` row exists but log file is missing

### `DELETE /v1/nzb/:nzbId`

Deletes the NZB row and artifacts. NZBs are always hard-deleted.

If the NZB job is running, the active child process is killed and no `nzb.failed` webhook is emitted for the user-initiated delete.

Status codes:

- `204` deleted
- `404` row does not exist

### `POST /v1/nzb/:nzbId/retry`

Retries a failed NZB upload by resetting the same NZB row back to `pending`.

Referenced files are revalidated before retry. They must still exist, be completed, and not be deleted.

Response:

```json
{
  "nzbId": "uuid",
  "status": "pending"
}
```

Status codes:

- `202` queued for retry
- `404` row does not exist
- `409 nzb_not_failed`
- `409 file_missing`
- `409 file_pending`
- `409 file_failed`
- `409 file_deleted`

## Webhooks

Webhook delivery rows are inserted in the same SQLite transaction as the matching terminal state update.

Events:

| Event | When | Data |
| --- | --- | --- |
| `download.completed` | File completed | `{ fileId, url, status, filename, downloadedAt }` |
| `download.failed` | File failed | `{ fileId, url, status, errorCode, error }` |
| `nzb.completed` | NZB posted | `{ nzbId, fileIds, status, nzbFile }` |
| `nzb.failed` | NZB failed | `{ nzbId, fileIds, status, errorCode, error }` |

Request shape:

```http
POST <resolved-url>
Content-Type: application/json
X-Webhook-Event: download.completed
X-Webhook-Delivery: <uuid>
X-Webhook-Signature: sha256=<hex>
```

Body:

```json
{
  "event": "download.completed",
  "timestamp": "2026-05-05T12:34:56.000Z",
  "data": {
    "fileId": "uuid",
    "url": "https://...",
    "status": "completed",
    "filename": "Show.s01e02.svtplay.mkv",
    "downloadedAt": "2026-05-05T12:34:56.000Z"
  }
}
```

`X-Webhook-Signature` is included only when `WEBHOOK_SECRET` is set. The signature is:

```text
HMAC-SHA256(WEBHOOK_SECRET, raw_request_body)
```

Routing:

- `WEBHOOK_URL` is the default destination
- `WEBHOOK_DOWNLOAD_COMPLETED_URL` overrides `download.completed`
- `WEBHOOK_DOWNLOAD_FAILED_URL` overrides `download.failed`
- `WEBHOOK_NZB_COMPLETED_URL` overrides `nzb.completed`
- `WEBHOOK_NZB_FAILED_URL` overrides `nzb.failed`

Retries:

- initial attempt plus up to 5 retries
- retry offsets: `1m`, `5m`, `30m`, `2h`, `12h`
- non-2xx responses, network errors, and timeouts are retried
- after 6 total attempts, delivery is marked `failed`

Failure `errorCode` values currently used:

- `insufficient_space`
- `interrupted_by_restart`
- `child_exit_nonzero`
- `unknown`
