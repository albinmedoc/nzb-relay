# Specification

A small HTTP service that wraps `svtplay-dl` (download) and `nyuu` + `parpar` + `rar` (Usenet upload). It can be driven by an external orchestrator over REST, or it can monitor supported series itself through the built-in watchlist. The service has no UI of its own.

The design priority is robustness: every job has a deterministic lifecycle that survives crashes and restarts, and every terminal state produces a durable, retried notification.

## 1. Goals & Non-Goals

**Goals**
- Small, focused HTTP API. Async submission, in-process queue, one job at a time per pipeline.
- Every job has a clear lifecycle (`pending → running → completed | failed`) that survives restarts.
- Every terminal state produces a durable webhook delivery when a destination URL is configured and survives restarts.
- Idempotent against duplicate submissions; failed work can be retried without manual cleanup.
- Built-in watchlist polling for supported series sources, starting with SVT Play.
- All state lives in one SQLite file; all artifacts live under one configurable directory.

**Non-Goals**
- No web UI.
- No generalized scheduler beyond the built-in watchlist poller.
- No multi-user, no roles — single bearer token.
- No multi-tenant.
- No HMAC required by default (opt-in via env).
- No cancel-by-user beyond `DELETE` on a pending row (which kills the worker).

## 2. Architecture

A single long-running Node.js process that exposes:
- An HTTP API for submitting and inspecting jobs.
- Four internal background workers:
  1. **Watchlist worker** — polls watched sources, records episodes, and queues normal download/NZB jobs.
  2. **Download worker** — drains `pending` rows in the `file` table.
  3. **NZB worker** — drains `pending` rows in the `nzb` table.
  4. **Webhook dispatcher** — drains `pending` rows in `webhook_deliveries`.

State is kept in a single SQLite database (WAL mode). Generated artifacts (mkv files, NZB files, log files) live on the filesystem under a single configurable root directory.

### 2.1 Stack

- **Runtime**: Node.js 20+ with TypeScript.
  - **Dev**: `tsx` (or `tsx watch`) — runs the TypeScript sources directly, fast iteration, no build step.
  - **Production**: compiled JS. `tsc -p tsconfig.build.json` outputs to `dist/`; the production image runs `node dist/index.js`. The compile step happens inside a multi-stage Docker build (builder stage with the TS toolchain + dev deps, runtime stage with just `node` + `dist/` + production `node_modules`). Avoids shipping `tsx` and the TS compiler into the runtime image; produces faster startup and a smaller attack surface.
- **HTTP framework**: [Hono](https://hono.dev/) — used with `@hono/node-server` for the runtime adapter. Hono's middleware composes cleanly for the bearer-auth check; its native `c.body()` / streaming response works for the binary endpoints (`/files/:id/download`, `/nzb/:id`).
- **Database**: SQLite via [`better-sqlite3`](https://github.com/WiseLibs/better-sqlite3) — synchronous API, simplifies the §5.2 atomic transaction invariant (no `await` between status update and delivery insert means no accidental yield points).
- **ORM / migrations**: [Drizzle ORM](https://orm.drizzle.team/) — schema in TypeScript, migrations generated via `drizzle-kit generate` and applied at startup before workers boot.
- **Outbound HTTP**: [`undici`](https://github.com/nodejs/undici) for the webhook dispatcher — explicit timeout control via `AbortSignal.timeout(30_000)`.
- **Crypto**: Node's built-in `node:crypto` (`createHmac('sha256', ...)`).
- **Child processes**: `node:child_process` `spawn`. Capture stdout/stderr via line-buffered streams (`readline.createInterface`) so the log file flushes per line.

External binaries required on `PATH`: `svtplay-dl`, `rar`, `parpar`, `nyuu`.

### 2.2 Notes for implementation

- **Transactional invariant.** `better-sqlite3` is synchronous — wrap the entity status update and the `webhook_deliveries` insert in a single `db.transaction(() => { ... })` call. Because there is no `await` inside, the transaction cannot be split by the event loop.
- **Polling vs notifications.** Workers poll their respective tables with a short interval (e.g. 1s for the queue workers, 5s for the dispatcher). An in-process event emitter can be used to wake a worker immediately on insert, but the poll loop must remain as the source of truth for crash-recovered work.
- **Signal handling.** Register `process.on('SIGTERM', ...)` for graceful shutdown (§5.6). Worker loops should observe an `AbortController` so they exit at the next checkpoint.

## 3. HTTP API

All endpoints below are mounted under the `/v1` prefix. For example `GET /health` is served at `GET /v1/health`, `POST /downloads` is served at `POST /v1/downloads`, and so on. Future API revisions will live under `/v2`, `/v3`, etc.; clients commit to a version at integration time.

All endpoints other than `GET /v1/health` require `Authorization: Bearer <API_KEY>` when `API_KEY` is set in the environment. Compare with timing-safe equality. Empty/unset = auth disabled (development convenience).

Common error envelope: `{ "error": "<short message>", "code": "<machine-readable-code>" }`. The HTTP status carries the primary signal; `code` is for clients that want to branch.

### 3.1 System

#### `GET /health`
Liveness probe. Open (no auth).

- **200**: `{ "status": "ok", "version": "<release-version>" }`. Release images set `version` from the GitHub release tag used to build the image.

### 3.2 Service discovery

Discovery endpoints are auth-gated like every other endpoint (the rule from §3 applies — only `/v1/health` is open).

Discovery endpoints are the **only** part of the API that is per-service. The rest of the system is provider-neutral: `POST /downloads` accepts any URL that the underlying download binary understands, with the caller-supplied `service` string used purely for filename substitution and diagnostics.

A discovery endpoint is mounted at `GET /<service>/serie/:slug` and returns the standardised shape below. Adding a new service means: add one route handler that knows how to parse that provider's catalog (RSS, JSON API, scraping — whatever the provider exposes) and emit the same response shape. No other part of the spec changes.

Each service implementation is responsible for translating its provider's identifiers into stable episode URLs that can be passed verbatim to `POST /downloads`.

`:slug` is passed through verbatim to the upstream provider's URL pattern. The router URL-decodes it; the implementation re-encodes if needed for the outgoing HTTP request. No whitelist or sanitisation — invalid slugs surface as `404` from the upstream provider.

#### `GET /svtplay/serie/:slug`
Parses SVT's embedded page data from `https://www.svtplay.se/<slug>` and returns the show's seasons + episodes. If page data cannot be parsed, falls back to `https://www.svtplay.se/<slug>/rss.xml`. Live-fetched per request; intentionally not cached. By default, discovery runs `svtplay-dl --list-quality` for each episode with bounded concurrency and returns available resolution heights in `qualities`. Use `?qualities=false` to skip probing and return empty quality arrays. Use `?fast=true` to probe only the first episode in each season and reuse those qualities for the rest of that season.

- **200**:
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
            "link": "https://www.svtplay.se/video/.../...",
            "qualities": ["1080", "720", "540"]
          }
        ]
      }
    ]
  }
  ```
- **404** if SVT returns no series for the slug.
- **502** if SVT discovery fetch or parsing fails.

### 3.3 Downloads

#### `POST /downloads`
Queue a download. **Async** — returns `202` immediately; completion is reported by webhook.

Body (`Content-Type: application/json`):

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

| Field     | Required | Type    | Description                                               |
|-----------|----------|---------|-----------------------------------------------------------|
| `url`     | yes      | string  | Episode URL                                               |
| `title`   | yes      | string  | Used in `{title}` substitution                            |
| `service` | yes      | string  | Used in `{service}` substitution (e.g. `svtplay`)         |
| `quality` | yes      | string  | Resolution string passed to `svtplay-dl --resolution`     |
| `season`  | no       | integer | If both `season` + `episode` present, episode template applies |
| `episode` | no       | integer | Otherwise movie template applies                          |

- **202**: `{ "fileId": "<uuid>", "status": "pending" }`
- **409** `{ "code": "duplicate_url" }` if a `pending`, `running`, or `completed` non-deleted row already exists for `url`. **Failed rows do not block retries.** This is enforced both in code and by a partial unique index (defence-in-depth against concurrent inserts).
- **400** `{ "code": "partial_episode_metadata" }` if exactly one of `season` or `episode` is provided — they must both be present (episode) or both absent (movie).
- **400** for missing required params or malformed quality.

Filename selection:
- `season` and `episode` both provided → `TEMPLATE_EPISODE` (default `{title}.s{season}e{episode}.{service}.{ext}`).
- Otherwise → `TEMPLATE_MOVIE` (default `{title}.{service}.{ext}`).
- Substitutions are sanitized: spaces → `.`, characters outside `[A-Za-z0-9._-]` stripped, season/episode zero-padded to two digits.

Filenames do not need to be globally unique: each download lives in its own per-`fileId` directory (`/data/downloads/<fileId>/<filename>.mkv`), so two downloads that happen to resolve to the same filename do not collide on disk.

#### `GET /files`
Paginated list. Query params: `?limit=20&offset=0` (defaults shown). Sorted newest first by `createdAt`. Soft-deleted rows are excluded by default.

- **200**:
  ```json
  {
    "items": [
      {
        "id": "<uuid>",
        "url": "...",
        "status": "pending | running | completed | failed",
        "filename": "...",
        "downloadedAt": "2026-05-05T12:34:56Z | null",
        "deleted": false,
        "errorCode": null,
        "error": null
      }
    ],
    "total": 137,
    "limit": 20,
    "offset": 0
  }
  ```

#### `GET /files/:fileId`
Returns JSON metadata for a file (does **not** stream the mkv).

- **200**: returns the row regardless of `deleted` value. Soft-deleted rows respond `200` with `deleted: true` (the row still exists; only the on-disk artifacts and downloadability are gone).
  ```json
  {
    "id": "<uuid>",
    "url": "...",
    "status": "pending | running | completed | failed",
    "filename": "...",
    "downloadedAt": "2026-05-05T12:34:56Z | null",
    "deleted": false,
    "errorCode": null,
    "error": null
  }
  ```
  `errorCode` and `error` are populated only when `status = "failed"`; `null` otherwise.
- **404** only if the row does not exist (never inserted, or hard-deleted via `force=true`).

#### `GET /files/:fileId/download`
Streams the mkv binary.

- **200** with `Content-Type: video/x-matroska`, `Content-Length`, `Content-Disposition: attachment; filename="<filename>.mkv"`, and the file body.
- **409** `{ "code": "not_ready" }` if `status != "completed"`.
- **404** if the row does not exist or `deleted = true`.

Range requests are **not supported**. The server ignores any `Range` request header and responds with `200` plus the full body. `Accept-Ranges` is not emitted. If a future use case needs partial content (media-player seeking, resumable downloads), it can be added without breaking this contract.

#### `GET /files/:fileId/logs`
Returns the plain-text log for the download (svtplay-dl stdout/stderr + the rename step).

- **200** `text/plain` body. Logs are flushed line-by-line, so `pending` and `running` jobs return whatever has been written so far.
- **404** if the row does not exist.
- **500** `{ "code": "log_missing" }` if the row exists but the log file is missing on disk. This is a server-side inconsistency (the file should always be present for the lifetime of the row); surfacing it as 500 makes the broken invariant visible rather than silently returning empty.

#### `DELETE /files/:fileId?force=<bool>`
Removes the mkv + log from disk and either soft- or hard-deletes the row.

- Default (`force=false`): mkv + log removed from disk, row marked `deleted = true`.
- `force=true`: as above, plus the row is hard-deleted from the DB.
- If `status = "pending"`: nothing to kill (no worker has picked it up); proceed straight to soft- or hard-delete.
- If `status = "running"`: kills the active `svtplay-dl` child (SIGTERM, then SIGKILL after ~1s), removes any partially-generated files in the working directory, then proceeds to soft- or hard-delete. To suppress the worker's natural `running → failed` transition, the worker's terminal `UPDATE` is gated on `WHERE id=? AND status='running' AND deleted=0`. So if the DELETE has already set `deleted=true` (or hard-deleted the row), the worker's UPDATE is a no-op and no `download.failed` webhook fires for the user-initiated delete.
- **204** on success.
- **409** `{ "code": "referenced_by_nzb" }` when `force=true` and the file is referenced by any `nzb_files` row. Soft delete is always allowed.
- **404** if the row does not exist (or already hard-deleted).

Soft-deleting a referenced file leaves historical NZB rows intact: their `nzb_files` join rows are untouched, `GET /v1/nzb/:nzbId` still lists the fileId in `files`, and the NZB on disk is unaffected. New `POST /v1/nzb` calls that reference a soft-deleted fileId will reject with `file_deleted` (§3.4) — re-uploading is impossible without first re-downloading the source.

### 3.4 NZB uploads

#### `POST /nzb`
Pack the listed files into a RAR + par2 set, post via nyuu, write the NZB to disk. **Async** — returns `202` immediately; completion is reported by webhook.

Body: `{ "fileIds": ["<uuid>", "<uuid>", ...] }` (any non-empty list; one for a single file, many for a season pack).

- **202**: `{ "nzbId": "<uuid>", "status": "pending" }`
- **400** `{ "code": "empty_list" }` if `fileIds` is empty.
- **400** `{ "code": "duplicate_file_id" }` if the same `fileId` appears more than once in `fileIds`. (We treat the array as a set; duplicates would silently collapse otherwise, which is worse than failing loudly.)
- **409** if any referenced file is not in a postable state. The `code` field distinguishes the cause so the orchestrator can branch without an extra `GET /v1/files/:id`:
  - `file_missing` — no row exists for that `fileId`.
  - `file_pending` — the file is still in flight (`status = pending` or `running`); retry the POST after `download.completed` fires.
  - `file_failed` — the file is in `status = failed`; the orchestrator must re-queue the download (or DELETE and re-POST) before retrying.
  - `file_deleted` — the row exists but `deleted = true`; not recoverable, the orchestrator must POST a fresh download.
  
  The response body's `error` message names which `fileId` triggered the rejection.
- **400** `{ "code": "season_pack_mismatch" }` if `fileIds.length > 1` and the referenced files do not all share the same `title`, `service`, and `season`.

**Validation order** (deterministic so two implementations can't diverge):
1. Body shape — `empty_list`, `duplicate_file_id`.
2. Existence + state — for each `fileId` in submission order: `file_missing` → `file_pending` → `file_failed` → `file_deleted`. First failure wins.
3. Cross-file consistency — `season_pack_mismatch` (only meaningful for multi-file submissions).

**Set semantics, not list semantics.** The `fileIds` array is treated as an unordered set. Submitting `[a, b, c]` and `[c, b, a]` produces byte-identical NZBs (modulo the per-NZB random password). Internally the pipeline imposes a canonical ordering for stable output:

```
ORDER BY episode ASC NULLS LAST, fileId ASC
```

This ordering is used by the NZB worker when staging files for `rar` (§9.2), and by every read endpoint or webhook that returns a `files`/`fileIds` collection — see §3.4 (`GET /v1/nzb`, `GET /v1/nzb/:nzbId`) and §6.1 (`nzb.completed`, `nzb.failed`).

For a single-file submission the `season_pack_mismatch` check is skipped. Templates between `TEMPLATE_EPISODE` and `TEMPLATE_MOVIE` are picked unambiguously: `POST /downloads`'s `partial_episode_metadata` rule (§3.3) guarantees a file row has either both `season`+`episode` populated or neither, so `POST /nzb` does not need to re-validate this.

Re-submitting the same `fileIds` is **allowed** and creates a new NZB job (the prior post on Usenet is unaffected). Idempotency is not enforced on `POST /nzb`.

**Release-name derivation** (used as the NZB's `<meta type="name">` and as the basis for nyuu's article subjects):
- 1 file with `season` + `episode` → render `TEMPLATE_EPISODE` against that file.
- 1 file without season/episode → render `TEMPLATE_MOVIE` against that file.
- >1 files → render `TEMPLATE_SEASON_PACK` (default `{title}.s{season}.{service}.{ext}`) against the shared `title`/`season`/`service` (verified by the validation rule above).

The release name is **computed at submit time** and persisted to `nzb.releaseName` (§4.2). All downstream consumers (the worker pipeline, `GET /v1/nzb/:nzbId/download`'s `Content-Disposition`) read from that column. Caching this way means subsequent soft-deletion of any referenced file does not break NZB retrieval or rendering.

Release names are **not unique** across NZBs. Re-posts (or coincidental metadata overlap) produce the same release name on the wire — Usenet identifies posts by Message-ID, not by name, so this is harmless. The unique handle within this service is `nzbId`.

The NZB on disk is named `<nzbId>.nzb` regardless of release name; the release name lives inside the NZB metadata and on the wire to Usenet.

#### `GET /nzb`
Paginated list. Query params: `?limit=20&offset=0` (defaults shown). Sorted newest first by `createdAt`. Each item's nested `files[]` array is returned in canonical order (see §3.4 set-semantics note).

- **200**:
  ```json
  {
    "items": [
      {
        "id": "<uuid>",
        "status": "pending | running | completed | failed",
        "createdAt": "...",
        "errorCode": null,
        "error": null,
        "files": [
          { "id": "<uuid>", "url": "...", "status": "completed", "downloadedAt": "..." }
        ]
      }
    ],
    "total": 137,
    "limit": 20,
    "offset": 0
  }
  ```

#### `GET /nzb/:nzbId`
Returns JSON metadata for an NZB job (does **not** stream the NZB). The `files[]` array is returned in canonical order (see §3.4 set-semantics note).

- **200**:
  ```json
  {
    "id": "<uuid>",
    "status": "pending | running | completed | failed",
    "nzbFile": "<filename>.nzb",
    "createdAt": "...",
    "postedAt": "2026-05-05T12:34:56Z | null",
    "errorCode": null,
    "error": null,
    "files": [
      { "id": "<uuid>", "url": "...", "status": "completed", "downloadedAt": "..." }
    ]
  }
  ```
  `errorCode` and `error` are populated only when `status = "failed"`; `null` otherwise.
- **404** if the row does not exist.

#### `GET /nzb/:nzbId/download`
Streams the generated NZB.

- **200** with `Content-Type: application/x-nzb`, `Content-Length`, `Content-Disposition: attachment; filename="<releaseName>.nzb"`, and the file body. The `<releaseName>` is read from the `nzb.releaseName` column (cached at submit time per §3.4), so the filename remains stable even after referenced files are soft-deleted.
- **409** `{ "code": "not_ready" }` if `status != "completed"`.
- **404** if the row does not exist.

Range requests are **not supported** (same rationale as `GET /v1/files/:fileId/download`). The server ignores any `Range` request header and responds with `200` plus the full body.

#### `GET /nzb/:nzbId/logs`
Returns the upload log (rar + parpar + nyuu output) as `text/plain`. Same status-code rules as `GET /v1/files/:fileId/logs`:

- **200** `text/plain` body. Logs are flushed line-by-line, so `pending` and `running` jobs return whatever has been written so far.
- **404** if the row does not exist.
- **500** `{ "code": "log_missing" }` if the row exists but the log file is missing on disk.

#### `DELETE /nzb/:nzbId`
Removes the NZB file and log from disk and the row from the DB.

- If `status = "pending"`: nothing to kill; the row is removed and (if any) the log file deleted.
- If `status = "running"`: kills the active child process (whichever of rar / parpar / nyuu is currently executing — SIGTERM, then SIGKILL after ~1s), removes the staging directory `DATA_DIR/nzb/<nzbId>/`, and removes any partial NZB / log file before deleting the row. As with file DELETE: the NZB worker's terminal `UPDATE` is gated on the row still existing in `running` state, so a hard-deleted row produces a no-op and no `nzb.failed` webhook fires for the user-initiated delete. Articles already accepted by nyuu before the kill cannot be unposted; that's accepted.
- If `status` is `completed` or `failed`: removes the NZB file and log file from disk and deletes the row.
- **204** on success.
- **404** if the row does not exist.

> NZBs do not soft-delete: the article on Usenet is unaffected by deletion of the NZB row, and there is no equivalent of the file→nzb reference chain coming back the other way.

## 4. Data Model

SQLite. All ids are UUIDv4 strings. Timestamps are ISO-8601 UTC strings.

### 4.1 `file`

| Column         | Type     | Notes                                       |
|----------------|----------|---------------------------------------------|
| `id`           | TEXT PK  | UUID                                        |
| `url`          | TEXT     | Source URL, the idempotency key             |
| `status`       | TEXT     | `pending` \| `running` \| `completed` \| `failed` |
| `title`        | TEXT     | Caller-supplied title; used to re-render `{title}` for NZB release names |
| `filename`     | TEXT     | Resolved filename (no extension path)       |
| `service`      | TEXT     | Recorded for filename + diagnostics         |
| `quality`      | TEXT     | Recorded                                    |
| `season`       | INTEGER  | Nullable                                    |
| `episode`      | INTEGER  | Nullable                                    |
| `downloadedAt` | TEXT     | Null until `status = completed`             |
| `createdAt`    | TEXT     |                                             |
| `deleted`      | INTEGER  | Boolean (0/1)                               |
| `errorCode`    | TEXT     | Nullable; populated only when `status = failed`. Stable enum from §6.1. |
| `error`        | TEXT     | Nullable; populated only when `status = failed`. One-line human-readable summary. |

Indexes:
- Partial unique: `UNIQUE(url) WHERE status IN ('pending','running','completed') AND deleted = 0`. DB-level backstop for `POST /downloads` idempotency under concurrent inserts.
- Index `(status, createdAt)` for queue/list scans.

`file` supports soft-delete (the `deleted` flag) because `nzb_files` rows can reference it and historical NZBs must remain inspectable. `nzb` (§4.2) does not need soft-delete — nothing references it back, so a `DELETE /v1/nzb/:nzbId` simply removes the row.

### 4.2 `nzb`

| Column        | Type     | Notes                                                    |
|---------------|----------|----------------------------------------------------------|
| `id`          | TEXT PK  | UUID                                                     |
| `status`      | TEXT     | `pending` \| `running` \| `completed` \| `failed`        |
| `releaseName` | TEXT     | Rendered template, computed at `POST /v1/nzb` submit time. Read by the pipeline worker, the NZB metadata, and the download endpoint's `Content-Disposition`. |
| `nzbFile`     | TEXT     | Filename of generated NZB (relative; always `<id>.nzb`)  |
| `createdAt`   | TEXT     |                                                          |
| `postedAt`    | TEXT     | Null until `status = completed`                          |
| `errorCode`   | TEXT     | Nullable; populated only when `status = failed`. Stable enum from §6.1. |
| `error`       | TEXT     | Nullable; populated only when `status = failed`. One-line human-readable summary. |

### 4.3 `nzb_files` (join)

| Column   | Type            | Notes |
|----------|-----------------|-------|
| `nzbId`  | TEXT FK → nzb   | ON DELETE CASCADE |
| `fileId` | TEXT FK → file  | NO ACTION (file row cannot be hard-deleted while referenced) |

Composite primary key `(nzbId, fileId)`.

### 4.4 `webhook_deliveries`

| Column          | Type     | Notes                                              |
|-----------------|----------|----------------------------------------------------|
| `id`            | TEXT PK  | UUID, used as `X-Webhook-Delivery`                 |
| `event`         | TEXT     | e.g. `download.completed`                          |
| `url`           | TEXT     | Resolved URL at insert time (so env changes don't retroactively redirect retries) |
| `payload`       | TEXT     | JSON, the exact body to POST                       |
| `attempts`      | INTEGER  | Default 0                                          |
| `nextAttemptAt` | TEXT     | Null when terminal                                 |
| `status`        | TEXT     | `pending` \| `delivered` \| `failed`               |
| `lastError`     | TEXT     | Nullable                                           |
| `createdAt`     | TEXT     |                                                    |

Index: `(status, nextAttemptAt)` for the dispatcher poll.

## 5. Processing Model

### 5.1 Workers

Three independent in-process workers, each driven by a poll loop on its DB queue:
- **Download worker** — picks the oldest `pending` `file` row, atomically transitions it `pending → running` (single `UPDATE … SET status='running' WHERE id=? AND status='pending'`), then spawns `svtplay-dl`, captures stdout/stderr to the log file (line-flushed), waits for exit. On exit, transitions to `completed` or `failed` per §5.2.
- **NZB worker** — picks the oldest `pending` `nzb` row, atomically transitions it `pending → running`, then runs the RAR → parpar → nyuu pipeline, writes the NZB to `DATA_DIR/nzb/`. Same terminal transition rules.
- **Webhook dispatcher** — picks `pending` rows in `webhook_deliveries` where `nextAttemptAt <= now()`, POSTs them, updates the row. (Note: `webhook_deliveries.status` does not include `running` — the dispatcher's in-flight state is process-local; persistence flips straight from `pending` to `delivered` or back to `pending` with a bumped `attempts`.)

The `pending → running` transition is a separate write from the terminal transition; only the terminal transition is bound to the `webhook_deliveries` insert (§5.2). A crash mid-job leaves the row in `running` state, which §5.5 recovers at next boot.

Each worker runs serially (one job at a time). They are independent of each other — a long download does not block webhook delivery.

The webhook dispatcher's serial behaviour is a deliberate trade-off, not a hidden bottleneck: a slow endpoint (e.g. one that responds in 29s, just under the 30s timeout) **will** rate-limit other deliveries behind it. In exchange we get strictly ordered delivery (sorted by `nextAttemptAt`), no thundering-herd risk after a backoff window expires, and a simple mental model. The expected deployment is a single orchestrator endpoint, where head-of-line blocking is acceptable. If you ever need parallel dispatch, that's a deliberate change to make later — not something to introduce by accident.

### 5.2 Atomic state transitions

Whenever a job moves to a terminal state, **the entity status update and the matching `webhook_deliveries` insert happen in the same DB transaction**. This is the load-bearing invariant: an entity row in `failed`/`completed` state always has its corresponding delivery row queued, or neither write is committed. A crash between the two cannot lose a notification.

The terminal `UPDATE` is gated on `WHERE id=? AND status='running'` (and additionally `AND deleted=0` for `file` rows). If the row has been removed by `DELETE` or already moved to a terminal state, the UPDATE affects 0 rows and the matching delivery insert is skipped — preventing webhooks from firing for user-initiated deletes (§3.3, §3.4) and avoiding double-fire if a transition is somehow attempted twice.

### 5.3 Idempotency

`POST /downloads` is idempotent against `url` when an existing row is `pending`, `running`, or `completed` and not deleted. The check is enforced in two places:
1. Application code returns `409` before queueing.
2. Partial unique index (see §4.1) protects against two requests racing past the application check.

`failed` rows do **not** block retries — that allows recovery from a transient svtplay-dl failure without manual cleanup.
For watchlist-managed work, retries create fresh job rows and the episode pointer moves to the newest active attempt. Once a later download succeeds, older failed download rows for that episode URL are hard-deleted after any failed NZBs that reference them are removed. Once a later NZB posts, older failed NZB rows for that episode file are hard-deleted.
If a watchlist NZB fails because its referenced media file is missing, the episode is moved back to download retry state instead of consuming further NZB attempts.

### 5.4 Cleanup on failure

When the worker transitions a row to `failed` (whether from a child-process error or from §5.5 startup recovery), it removes the entity's working directory:
- Download: `DATA_DIR/downloads/<fileId>/` (if any partial files were created).
- NZB: `DATA_DIR/nzb/<nzbId>/` working area; partially uploaded articles already on Usenet cannot be recalled — accept this and mark the row failed anyway.

The DB row is preserved (with `status = failed`). Deletion is the user's call via `DELETE`.

If the failure is `ENOSPC` (disk full), the worker marks the row `failed` with `errorCode = "insufficient_space"` and `error = "disk full"`, and skips the working-directory cleanup (deleting on a full disk usually still works for files that exist, but failure during cleanup must not mask the original error). The same `errorCode` is also used by the §9.2 step 3 NZB preflight when it predicts insufficient space *before* spawning anything; orchestrators can branch on `errorCode = "insufficient_space"` regardless of which path triggered it.

The DB write to mark a row `failed` can itself fail with `ENOSPC` (SQLite needs WAL space). In that case the row remains `pending`, and §5.5 startup recovery handles it the next time the process restarts (typically after disk space has been freed). Log the failed transition to stderr so the operator has a breadcrumb.

### 5.5 Startup recovery

On boot, before starting workers:
1. `UPDATE file SET status='failed' WHERE status='running'` and queue a `download.failed` delivery for each, with `errorCode = "interrupted_by_restart"` and `error = "interrupted by restart"`. (Per the §5.2 invariant, the status update and delivery insert happen in the same transaction, per row.)
2. Same for `nzb` rows in `running` state.
3. The cleanup step from §5.4 runs against each recovered row's working directory.
4. Webhook dispatcher resumes any `pending` rows in `webhook_deliveries` untouched — including the newly inserted ones.

`pending` rows are **not** touched by recovery — they were merely queued, never picked up by a worker, and the workers will pick them up normally once started. Only `running` rows represent work that was actually interrupted.

This guarantees: any job that was in flight when the previous process died ends up `failed`, with a webhook on its way to the orchestrator, with no orphan files. Anything that was just queued remains queued.

### 5.6 Graceful shutdown (`SIGTERM`)

1. Stop accepting new HTTP requests.
2. Stop workers from picking up new jobs.
3. For the active download/upload child process: send `SIGTERM`, wait up to 1 second, then `SIGKILL`.
4. Allow in-flight DB writes to complete.
5. Close the database (flushes WAL).
6. Exit cleanly.

Any rows left as `running` at shutdown are recovered by §5.5 on next boot. The shutdown handler does not need to mark anything failed itself — that's recovery's job. (`pending` rows simply wait in the queue; they require no recovery action.)

## 6. Webhooks

### 6.1 Events

| Event                 | When                                  | Payload (`data`)                                                          |
|-----------------------|---------------------------------------|---------------------------------------------------------------------------|
| `download.completed`  | File transitions to `completed`       | `{ fileId, url, status: "completed", filename, downloadedAt }`            |
| `download.failed`     | File transitions to `failed`          | `{ fileId, url, status: "failed", errorCode, error }`                     |
| `nzb.completed`       | NZB transitions to `completed`        | `{ nzbId, fileIds, status: "completed", nzbFile }`                        |
| `nzb.failed`          | NZB transitions to `failed`           | `{ nzbId, fileIds, status: "failed", errorCode, error }`                  |

Including `status` in `data` is intentional: receivers can branch on `data.status` uniformly across both webhook payloads and `GET /v1/files/:id` / `GET /v1/nzb/:id` responses, without parsing the event name.

`errorCode` (failure events only) is a stable machine-readable token for branching. `error` remains the human-readable one-line summary. `errorCode` is an open enum — implementers may add new values over time without breaking changes; receivers should treat unknown codes as generic failures. Currently defined values:

| `errorCode`            | Meaning                                                                                                  |
|------------------------|----------------------------------------------------------------------------------------------------------|
| `insufficient_space`   | Free space below required threshold (NZB preflight, §9.2) or `ENOSPC` mid-run. Recoverable by freeing disk and retrying. |
| `interrupted_by_restart` | Job was `running` when the previous process exited; marked failed by startup recovery (§5.5). Safe to retry. |
| `child_exit_nonzero`   | Child process (`svtplay-dl`, `rar`, `parpar`, `nyuu`) exited with a non-zero status. Inspect the log via `/logs`. |
| `unknown`              | Fallback when no specific code applies.                                                                  |

`error` is a one-line summary captured at the moment of failure. The full child-process output remains in the log file.

`fileIds` arrays in `nzb.*` payloads are in canonical order (see §3.4 set-semantics note), so they line up with what `GET /v1/nzb/:nzbId` would return.

### 6.2 Routing

- `WEBHOOK_URL` is the default destination for every event.
- `WEBHOOK_<EVENT>_URL` overrides the default for that specific event.
- If neither is set for an event, the delivery is not enqueued.

The destination URL is **resolved at the moment the delivery row is inserted** and stored on the row. Subsequent env changes do not retroactively redirect pending retries.

### 6.3 Request shape

```
POST <resolved-url>
Content-Type: application/json
X-Webhook-Event: <event-name>
X-Webhook-Delivery: <uuid>
X-Webhook-Signature: sha256=<hex>     (only when WEBHOOK_SECRET is set)

{
  "event": "download.failed",
  "timestamp": "2026-05-05T12:34:56Z",
  "data": {
    "fileId": "9b8e...",
    "url": "https://www.svtplay.se/video/...",
    "status": "failed",
    "errorCode": "child_exit_nonzero",
    "error": "svtplay-dl exited with code 1: HTTP 403"
  }
}
```

The HMAC, when present, is `HMAC-SHA256(WEBHOOK_SECRET, raw_request_body)` as a lowercase hex string. Receivers verify by recomputing over the **raw** body before any JSON parsing.

### 6.4 Retry policy

Non-2xx response, network error, or timeout (default 30s) → mark the delivery for retry. After the initial attempt, up to **5 retries** are scheduled at the cumulative offsets **1m, 5m, 30m, 2h, 12h** from the previous attempt. That's a maximum of **6 total wire requests** (initial + 5 retries) before the delivery is marked `failed` and never retried.

The dispatcher polls every ~5s for due deliveries. On startup it makes no special handling — pending rows simply get picked up on the next poll.

## 7. Configuration

All configuration is via environment variables. There is no config file and no runtime mutation API.

### 7.1 Core

| Var | Default | Meaning |
|---|---|---|
| `PORT` | `3001` | HTTP listen port |
| `API_KEY` | _(empty)_ | When set, required as `Authorization: Bearer <key>`. Empty = auth disabled. |
| `DATA_DIR` | `/data` | Root for the SQLite db, downloads, nzbs, logs |
| `LOG_LEVEL` | `info` | pino log level: `trace` \| `debug` \| `info` \| `warn` \| `error` \| `fatal` |
| `STAGING_MULTIPLIER` | `2.2` | Free-space preflight factor for NZB jobs (§9.2). Required free space ≈ `sum(referencedFileSizes) × STAGING_MULTIPLIER`. Default covers `-m0` RAR (~1× source) + 10% par2 + safety margin. Tune up for higher redundancy or tighter safety margins; tune down at your own risk. |

### 7.2 Naming templates

These templates are used both for on-disk filenames and for NZB release names. Selection rules are spelled out in §3.3 (filenames) and §3.4 (NZB release names).

| Var | Default | Used for |
|---|---|---|
| `TEMPLATE_EPISODE`     | `{title}.s{season}e{episode}.{service}.{ext}` | Episode filename + single-episode NZB release name |
| `TEMPLATE_MOVIE`       | `{title}.{service}.{ext}`                     | Movie filename + single-movie NZB release name     |
| `TEMPLATE_SEASON_PACK` | `{title}.s{season}.{service}.{ext}`           | Multi-file NZB release name (season packs)         |

Substitutions: `{title}`, `{service}`, `{quality}`, `{season}` (zero-padded to 2), `{episode}` (zero-padded to 2), `{ext}` (always `mkv`).

### 7.3 Usenet

| Var | Required | Default | Meaning |
|---|---|---|---|
| `USENET_HOST` | yes | — | NNTP hostname |
| `USENET_PORT` | no | `563` | NNTP port (typically `563` for SSL, `119` for plaintext) |
| `USENET_SSL`  | no | `true` | `true` or `false`; controls whether nyuu negotiates TLS |
| `USENET_USER` | yes | — | NNTP username |
| `USENET_PASS` | yes | — | NNTP password |
| `USENET_NEWSGROUPS` | no | See below | Comma-separated newsgroups to publish articles to |
| `USENET_NEWSGROUPS_PER_UPLOAD` | no | `20` | Maximum number of configured newsgroups to use for each `nyuu` upload. Set higher only if the NNTP server allows that many crossposts. |

Default `USENET_NEWSGROUPS` is the full list below. Each upload randomly chooses up to `USENET_NEWSGROUPS_PER_UPLOAD` entries from that list.

```text
alt.binaries.newznzb.alpha
alt.binaries.newznzb.bravo
alt.binaries.newznzb.charlie
alt.binaries.newznzb.delta
alt.binaries.newznzb.echo
alt.binaries.newznzb.foxtrot
alt.binaries.newznzb.golf
alt.binaries.newznzb.hotel
alt.binaries.newznzb.india
alt.binaries.newznzb.juliett
alt.binaries.newznzb.kilo
alt.binaries.newznzb.lima
alt.binaries.newznzb.mike
alt.binaries.newznzb.november
alt.binaries.newznzb.oscar
alt.binaries.newznzb.papa
alt.binaries.newznzb.quebec
alt.binaries.newznzb.romeo
alt.binaries.newznzb.sierra
alt.binaries.newznzb.tango
alt.binaries.newznzb.uniform
alt.binaries.newznzb.victor
alt.binaries.newznzb.whiskey
alt.binaries.newznzb.xray
alt.binaries.newznzb.yankee
alt.binaries.newznzb.zulu
```

### 7.4 Webhooks

| Var | Default | Meaning |
|---|---|---|
| `WEBHOOK_URL` | _(empty)_ | Catch-all for every event |
| `WEBHOOK_DOWNLOAD_COMPLETED_URL` | _(empty)_ | Override for `download.completed` |
| `WEBHOOK_DOWNLOAD_FAILED_URL` | _(empty)_ | Override for `download.failed` |
| `WEBHOOK_NZB_COMPLETED_URL` | _(empty)_ | Override for `nzb.completed` |
| `WEBHOOK_NZB_FAILED_URL` | _(empty)_ | Override for `nzb.failed` |
| `WEBHOOK_SECRET` | _(empty)_ | When set, every webhook gets the `X-Webhook-Signature` HMAC header |

## 8. Storage Layout

All paths are under `DATA_DIR` (default `/data`).

```
/data/
  app.db                                  # SQLite (WAL mode)
  app.db-wal
  app.db-shm
  downloads/
    <fileId>/
      <filename>.mkv                      # the media (after rename)
      <filename>.log                      # svtplay-dl + rename output
  nzb/
    <nzbId>.nzb                           # generated NZB (final)
    <nzbId>.log                           # parpar + nyuu output
    <nzbId>/                              # working directory, removed on success or failure
      ...rar/par2 staging
```

The working directory under `nzb/<nzbId>/` is transient: created at the start of the upload, removed when the job ends regardless of outcome.

## 9. Pipelines

This section spells out what each worker actually does. Implementers should not need to read external man pages to wire this up.

### 9.1 Download pipeline (`svtplay-dl`)

Per `pending` `file` row (after the worker has atomically transitioned it to `running`, §5.1):

1. Create the working directory `DATA_DIR/downloads/<fileId>/`.
2. Open `DATA_DIR/downloads/<fileId>/<filename>.log` in append mode (line-flushed).
3. Spawn `svtplay-dl` with stdout+stderr piped to the log:
   ```
   svtplay-dl \
     --resolution=<quality> \
     --force \
     --output-format=mkv \
     -M \
     --all-subtitles \
     --output=<DATA_DIR>/downloads/<fileId> \
     --filename=<filename-without-extension>.{ext} \
     <url>
   ```
   - `--output-format=mkv` forces an mkv container regardless of the source format. Requires `ffmpeg` on `PATH` (already present in the `node:20-slim` reference image after `apt install ffmpeg`).
   - `--force` lets svtplay-dl overwrite stale intermediate files left by interrupted downloads.
   - `-M --all-subtitles` merges every available subtitle track into the mkv.
   - `--output` is the per-file download directory; `--filename` controls the final media basename.
4. On exit code 0: verify `<DATA_DIR>/downloads/<fileId>/<filename>.mkv` exists, then update the row to `status='completed'`, set `downloadedAt`, queue the `download.completed` delivery (atomically, §5.2).
5. On non-zero exit, signal-kill, or spawn error: update to `status='failed'`, set `error` to the last line of stderr (truncated to 200 chars), set `errorCode` per §6.1 (typically `child_exit_nonzero`; use `insufficient_space` if the worker detects `ENOSPC` while writing the mkv), queue `download.failed`, run §5.4 cleanup.

The log file is the source of truth for human debugging. The DB stores only the one-line summary.

### 9.2 NZB pipeline (rar → parpar → nyuu)

Per `pending` `nzb` row (after the worker has atomically transitioned it to `running`, §5.1):

1. Read `releaseName` from the row (already computed at submit time per §3.4).
2. Create the working directory `DATA_DIR/nzb/<nzbId>/` and the log file `DATA_DIR/nzb/<nzbId>.log` (append mode, line-flushed).
3. **Free-space preflight.** Sum the on-disk size of every referenced mkv (`statvfs`/`fs.statSync` on each `<DATA_DIR>/downloads/<fileId>/<filename>.mkv`). Compute `required = sum × STAGING_MULTIPLIER` (default 2.2 — see §7.1). Compare against `DATA_DIR`'s available bytes. If `available < required`, the job is failed immediately with `errorCode = "insufficient_space"` and `error = "insufficient_space: need <required> bytes, have <available> bytes"`. No password is generated, no child processes spawn, no articles touch the wire. Cleanup runs per §5.4.
4. **Generate a per-NZB password.** 16 bytes from `crypto.randomBytes(16)`, base64url-encoded. The password lives only in the resulting NZB's `<meta type="password">` element — it is **not** stored in the DB. Re-posting the same `fileIds` produces a fresh password.
5. **Stage symlinks** to the source mkv files inside the working directory, so rar sees the files at predictable paths without copying. Iterate the joined `nzb_files` rows in canonical order — `ORDER BY file.episode ASC NULLS LAST, file.id ASC` — so the same set of fileIds always produces a byte-identical RAR layout.
6. **RAR step** (mandatory flags called out — others are at the implementer's discretion):
   ```
   rar a \
     -m0 \                                    # store, no compression
     -v100m \                                 # 100 MB volumes
     -hp<password> \                          # header encryption (filenames hidden)
     -ed -ep1 \                               # don't store empty dirs / strip leading paths
     <DATA_DIR>/nzb/<nzbId>/<release-name>.rar \
     <staged-files>
   ```
   Output is a multi-volume archive: `<release-name>.rar`, `<release-name>.r00`, `<release-name>.r01`, …
7. **parpar step** generates par2 redundancy over the rar volumes:
   ```
   parpar \
     --input-slices=768000b \                 # block size (matches Usenet article size)
     -r 10% \                                 # 10% redundancy
     -o <DATA_DIR>/nzb/<nzbId>/<release-name>.par2 \
     <DATA_DIR>/nzb/<nzbId>/<release-name>.rar \
     <DATA_DIR>/nzb/<nzbId>/<release-name>.r* 
   ```
   Output: `<release-name>.par2`, `<release-name>.vol000+01.par2`, etc.
8. **nyuu step** posts every rar + par2 file to Usenet and writes the NZB:
   ```
   nyuu \
     --host <USENET_HOST> --port <USENET_PORT> \
     # pass --ssl only when USENET_SSL=true
     --user <USENET_USER> --password <USENET_PASS> \
     --groups <random USENET_NEWSGROUPS_PER_UPLOAD entries from USENET_NEWSGROUPS> \
     --article-size 750000 \
     --meta name=<release-name> \
     --meta password=<password> \
     --out <DATA_DIR>/nzb/<nzbId>.nzb \
     <DATA_DIR>/nzb/<nzbId>/<release-name>.rar \
     <DATA_DIR>/nzb/<nzbId>/<release-name>.r* \
     <DATA_DIR>/nzb/<nzbId>/<release-name>.par2 \
     <DATA_DIR>/nzb/<nzbId>/<release-name>.vol*.par2
   ```
9. On success of all three steps: update row to `status='completed'`, set `postedAt`, set `nzbFile` to `<nzbId>.nzb`, queue `nzb.completed`. Then remove the working directory `DATA_DIR/nzb/<nzbId>/` (the symlinks and rar/par2 staging). **If cleanup of the working directory fails after a successful post, log a `warn`-level application log line (e.g. `{ event: "nzb.cleanup_failed", nzbId, error }`) and continue.** The NZB status remains `completed` and the `nzb.completed` webhook still fires — the post is on Usenet, the row reflects reality, and a leftover staging directory is operational debris that does not warrant marking the job failed or retrying it.
10. On any step's failure: update to `status='failed'`, capture the failing tool's last stderr line as `error`, set `errorCode` to the appropriate token from §6.1 (e.g. `child_exit_nonzero` for a non-zero rar/parpar/nyuu exit, `insufficient_space` if the failure is `ENOSPC` mid-run), queue `nzb.failed`, run §5.4 cleanup. Articles already accepted by nyuu before the failure cannot be unposted — that's accepted behaviour; the row is failed regardless.

### 9.3 Pipeline invariants

The following are mandatory because they affect downstream consumers (nzbDAV, Sonarr, etc.) — not implementer discretion:

- **RAR `-m0` (store, no compression).** Compressed RARs are not transparently readable by all consumers.
- **Password in NZB metadata** via `--meta password=<pw>`. Without this, downloaders cannot extract the archive.
- **`<meta type="name">`** set to the release name via `--meta name=<release>`. This is what indexers and Sonarr-likes pattern-match on.

### 9.4 Accepted consequence: password durability

The per-NZB password lives **only** in the NZB file's `<meta type="password">` element. It is generated in memory at the start of the pipeline (§9.2 step 3) and never persisted to the DB. This keeps the password's leak surface as small as possible — backups, logs, and `GET` responses cannot accidentally expose it.

The narrow trade-off: between `nyuu` completing the post (NZB written, password baked in) and the worker's `running → completed` DB transaction committing, there is a small window. A process crash inside that window leaves:

- **Articles on Usenet** — irreversible; nyuu has already accepted them.
- **The NZB file at `DATA_DIR/nzb/<nzbId>.nzb`** — present on disk; cleanup (§5.4) only removes the working directory `<nzbId>/`, not the NZB itself.
- **The DB row in `running` state** — at the next boot, §5.5 recovery transitions it to `failed`.
- **No `nzb.completed` webhook** — the atomic invariant in §5.2 means the delivery is only inserted alongside the `completed` transition that never committed; nothing fires.

End state: the NZB on disk is **stranded** from the API's perspective — `GET /v1/nzb/:nzbId/download` returns `409 not_ready` because `status='failed'`, and no orchestrator ever learned the job exists. An operator can still inspect `<nzbId>.nzb` directly on the volume and recover the password manually if the articles are worth retrieving. A subsequent `DELETE /v1/nzb/:nzbId` removes the orphaned file.

This is accepted as the right trade-off: storing the password in the DB to close the window would double its leak surface (backups, logs, future query paths) for a failure mode that should be vanishingly rare on a healthy host. Bandwidth wasted on the unrecoverable post is the cost.

## 10. Operational Behaviour

### 10.1 Logging

**Job logs** (per-job, captured from child processes):
- Each job has its own log file under `DATA_DIR` (paths in §8). Opened in append mode. Flushed line-by-line so a crashed worker still leaves a useful tail.
- Content is the raw stdout/stderr from `svtplay-dl` (download jobs) or from the rar/parpar/nyuu pipeline steps (NZB jobs), interleaved in the order written.
- **No size cap.** Job log files are bounded only by the lifetime of their owning row — `DELETE /v1/files/:id` and `DELETE /v1/nzb/:id` remove the corresponding logs. A chatty download (e.g. svtplay-dl with verbose flags on a long episode) can produce multiple MB of log; budget volume size accordingly.

**Application logs** (per-process, structured):
- Emitted as line-delimited JSON via [pino](https://getpino.io) to **stdout**. Each line is a complete JSON object — Docker's log driver and downstream aggregators (Loki, Datadog, Vector, etc.) parse this natively.
- Log level controlled by `LOG_LEVEL` (default `info`). Acceptable values: `trace | debug | info | warn | error | fatal`.
- **Do not run `pino-pretty` in production.** It's slow and breaks JSON parsing in aggregators. For local dev, pipe externally: `tsx src/index.ts | pino-pretty`.
- **Request logging** is a tiny pino-based Hono middleware (do **not** use `hono/logger`, which writes plain text). Recommended fields per request: `{ method, path, status, durationMs, requestId }`. Generate `requestId` per request and surface it in error responses for traceability.
- No application-level log rotation; rely on the container log driver / host.

### 10.2 Health

`GET /health` is the Docker healthcheck target. Returns 200 once the HTTP listener is up and the DB is initialised. It does **not** fail when downloads are stuck — readiness is "process can answer HTTP," not "everything is happy."

### 10.3 Startup sequence

1. **Open SQLite** at `DATA_DIR/app.db` with `PRAGMA journal_mode=WAL` and `PRAGMA foreign_keys=ON`.
2. **Acquire an exclusive lock** on `DATA_DIR/app.lock` (e.g. `proper-lockfile` or a `flock(2)` syscall). If the lock is already held, exit with a non-zero code and a clear log line — see §10.6.
3. **Run pending migrations.** Drizzle layout: `drizzle.config.ts` at repo root pointing `out: './drizzle'`, `schema: './src/db/schema.ts'`. At startup, call `migrate(db, { migrationsFolder: './drizzle' })` from `drizzle-orm/better-sqlite3/migrator`. The `drizzle/` folder contains the generated SQL migration files (committed to source control via `drizzle-kit generate` in dev) and is copied into the runtime image as a sibling of `dist/`, so the same path resolves in both dev and production. **Downgrades are not supported**: if `app.db` contains a migration newer than what the binary's `drizzle/` folder knows about, the migrator detects the mismatch and the process exits non-zero. Operators must redeploy a binary at or ahead of the on-disk schema.
4. Run the recovery routine (§5.5).
5. Start the three workers.
6. Bind the HTTP listener on `PORT`.

### 10.4 Shutdown sequence

See §5.6.

### 10.5 Container packaging

Reference deployment uses `node:20-slim` as the base image. Required additions:

- **`python3` + `pip`** via `apt-get install -y python3 python3-pip`, then `pip install --break-system-packages svtplay-dl` (Debian 12+ requires the flag).
- **`ffmpeg`** via `apt-get install -y ffmpeg` (needed by `svtplay-dl --output-format=mkv`).
- **`nyuu` + `@animetosho/parpar`** via `npm install -g nyuu @animetosho/parpar`.
- **`rar`** is non-free and not packaged in Debian's main repositories. The image's `entrypoint.sh` downloads the official RAR binary on first start. Pin the version in the entrypoint:
  ```sh
  # entrypoint.sh
  RAR_VERSION="7.10"
  if [ ! -x /usr/local/bin/rar ]; then
    arch="$(uname -m)"
    case "$arch" in
      x86_64) suffix="x64" ;;
      aarch64) suffix="arm64" ;;
      *) echo "unsupported arch: $arch" >&2; exit 1 ;;
    esac
    curl -fsSL "https://www.rarlab.com/rar/rarlinux-${suffix}-${RAR_VERSION//./}.tar.gz" \
      | tar -xzf - -C /tmp
    install -m 0755 /tmp/rar/rar /usr/local/bin/rar
    rm -rf /tmp/rar
  fi
  exec node dist/index.js
  ```
  (RAR is proprietary — free for personal use, redistribution is restricted, which is why we don't bake it into the image.)

The `DATA_DIR` should be a mounted volume so SQLite and artifacts survive container recreation.

### 10.6 Single-instance constraint

The application is **not** designed to run as multiple replicas. Two processes pointing at the same `DATA_DIR` would race on workers and risk double-posting NZBs. The startup lock from §10.3 enforces this: if `app.lock` is already held, the second process exits immediately.

Horizontal scaling is explicitly out of scope (§11). If you need more throughput, increase the per-instance worker concurrency (currently fixed at 1 per pipeline by design — that's a deliberate robustness trade-off, not a bottleneck to remove without thinking).

## 11. Out of Scope (future work)

- Pause/resume of a running job.
- HMAC verification on the **inbound** side (receiving webhooks from elsewhere).
- Multiple concurrent downloads.
- Disk-space pre-flight checks.
- Quality normalisation (returning a canonical set of resolutions vs whatever svtplay-dl reports).
- Caching of discovery endpoint results (`GET /<service>/serie/:slug`).
