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

Response:

```json
{
  "status": "ok",
  "version": "0.1.0"
}
```

## Discovery

### `GET /v1/svtplay/serie/:slug`

Fetches `https://www.svtplay.se/<slug>` and parses SVT's embedded page data into seasons and episodes.
If the page data cannot be parsed, the service falls back to `https://www.svtplay.se/<slug>/rss.xml`.
Available video resolutions are not probed during discovery, so `qualities` is returned as an empty array.

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
          "qualities": []
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

Response:

```json
{
  "items": [
    {
      "id": "uuid",
      "url": "https://...",
      "status": "pending",
      "filename": "Show.s01e02.svtplay.mkv",
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

## NZB Uploads

### `POST /v1/nzb`

Queues an async NZB upload job for one or more completed files.

Request:

```json
{
  "fileIds": ["uuid-1", "uuid-2"]
}
```

Validation order:

1. Body shape: `empty_list`, `duplicate_file_id`
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

Response:

```json
{
  "items": [
    {
      "id": "uuid",
      "status": "completed",
      "nzbFile": "uuid.nzb",
      "createdAt": "2026-05-05T12:00:00.000Z",
      "postedAt": "2026-05-05T12:10:00.000Z",
      "errorCode": null,
      "error": null,
      "files": [
        {
          "id": "file-uuid",
          "url": "https://...",
          "downloadedAt": "2026-05-05T11:00:00.000Z"
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
