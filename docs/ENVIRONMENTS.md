# Environment Variables

All runtime configuration for `nzb-relay` is provided through environment variables. The application does not read a config file and does not expose a runtime configuration API.

At startup, the service loads these values, creates paths under `DATA_DIR`, opens SQLite, runs migrations, acquires a single-instance lock, and starts the HTTP server and workers. Invalid numeric values fail startup.

## Minimum Runtime Configuration

For a normal runtime, set at least:

```sh
API_KEY=change-me
USENET_HOST=news.example.com
USENET_USER=usenet-user
USENET_PASS=usenet-password
```

`API_KEY` is optional from the application's point of view, but leaving it empty disables authentication for every endpoint except `GET /v1/health`, which is always public. `USENET_HOST`, `USENET_USER`, and `USENET_PASS` are required at startup.

Set `WEBHOOK_URL` or event-specific webhook URLs only when notifications are wanted.

## Parsing Rules

- Empty or unset variables use their default.
- Integer settings must be valid integers. Positive integer settings must be greater than `0`.
- Positive number settings must be greater than `0`.
- Boolean settings use the default when unset or empty. Any value equal to `true`, case-insensitive, is `true`; every other non-empty value is `false`.
- Secrets such as `API_KEY`, `USENET_PASS`, and `WEBHOOK_SECRET` should not be committed to git.

## Core Runtime

| Variable | Required | Default | Description |
|---|---:|---|---|
| `VERSION` | no | `0.0.0` | Version returned by `GET /v1/health`. Release images bake the GitHub release tag into this value at build time. |
| `PORT` | no | `3001` | HTTP listen port. The Docker image exposes `3001`, but the app listens on this value. |
| `API_KEY` | no | empty | Bearer token required by all `/v1` endpoints except `GET /v1/health` when set. Empty means authentication is disabled. |
| `CORS_ORIGINS` | no | empty | Comma-separated browser origins allowed to call `/v1/*`, or `*` to allow any origin. Leave empty when the API is not called from a separate frontend origin. |
| `DATA_DIR` | no | `/data` | Root directory for SQLite, lock file, downloads, NZB files, worker logs, and transient NZB staging. Resolved to an absolute path at startup. |
| `LOG_LEVEL` | no | `info` | Pino log level. Common values are `trace`, `debug`, `info`, `warn`, `error`, `fatal`, and `silent`. |
| `STAGING_MULTIPLIER` | no | `2.2` | Positive number used by the NZB worker's free-space preflight. Required free space is approximately `sum(referenced media sizes) * STAGING_MULTIPLIER`. |

`DATA_DIR` contains:

```text
<DATA_DIR>/
  app.db
  app.lock
  downloads/
  nzb/
```

The application is designed for one process per `DATA_DIR`. A second process using the same directory exits when it cannot acquire `app.lock`.

## Watchlist

The watchlist worker polls supported series sources, records discovered episodes, queues downloads, and can automatically queue NZB jobs after downloads complete.
New watchlist sources default to soft-deleting downloaded files after their NZB upload completes. This is controlled per source with the `deleteFileAfterNzb` watchlist API field.

| Variable | Required | Default | Description |
|---|---:|---|---|
| `WATCHLIST_POLL_INTERVAL_SECONDS` | no | `3600` | Positive integer. Number of seconds between scans for each enabled watchlist source. |
| `WATCHLIST_RECONCILE_INTERVAL_SECONDS` | no | `10` | Positive integer. Number of seconds between reconciliation passes that connect watchlist episodes to download and NZB job state. |
| `WATCHLIST_AUTO_NZB` | no | `true` | Boolean. When `true`, completed watchlist downloads are automatically queued for NZB creation. When `false`, the worker still scans sources and queues downloads but does not queue NZB jobs. |
| `WATCHLIST_MAX_ATTEMPTS` | no | `3` | Positive integer. Maximum download attempts and maximum NZB attempts for a watchlist episode before that step is blocked. |

## Naming Templates

Templates control both stored media filenames and NZB release names. Rendered values are sanitized to filesystem-safe release names: whitespace becomes `.`, unsupported characters are removed, repeated dots are collapsed, and leading or trailing dots are trimmed.

| Variable | Required | Default | Used for |
|---|---:|---|---|
| `TEMPLATE_EPISODE` | no | `{title}.s{season}e{episode}.{service}.{ext}` | Episode downloads and single-episode NZB release names. |
| `TEMPLATE_MOVIE` | no | `{title}.{service}.{ext}` | Movie or non-episode downloads and single-file NZB release names. |
| `TEMPLATE_SEASON_PACK` | no | `{title}.s{season}.{service}.{ext}` | Multi-file NZB release names. |

Supported substitutions:

| Token | Value |
|---|---|
| `{title}` | Request or watchlist title after sanitization. |
| `{service}` | Source service, for example `svtplay`, after sanitization. |
| `{quality}` | Requested or discovered quality after sanitization. May be empty. |
| `{videoCodec}` | First video stream codec from the completed MKV, for example `h264`, `h265`, `av1`, or `vp9`. May be empty before completion or if probing fails. |
| `{audioCodec}` | First audio stream codec from the completed MKV, for example `aac`, `ac3`, `eac3`, or `opus`. May be empty before completion or if probing fails. |
| `{season}` | Season number padded to two digits when present. |
| `{episode}` | Episode number padded to two digits when present. |
| `{ext}` | File extension. Defaults to `mkv`. |

Codec substitutions are applied after the download has been muxed with `ffmpeg`. The worker first downloads using the template with empty codec values, then runs `ffprobe`, renames the completed media/log files, and stores the final filename. `hevc` is normalized to `h265`, and `avc1` is normalized to `h264`.

If a rendered template becomes empty after sanitization, the fallback is `release.<ext>`.

## Usenet

Usenet settings are passed to `nyuu` during NZB posting. The application validates that host, username, and password are configured during startup.

| Variable | Required | Default | Description |
|---|---:|---|---|
| `USENET_HOST` | yes | none | NNTP server hostname. |
| `USENET_PORT` | no | `563` | NNTP server port. Use `563` for TLS in most setups, or `119` for plaintext. |
| `USENET_SSL` | no | `true` | Boolean. When `true`, `nyuu` receives `--ssl`. |
| `USENET_USER` | yes | none | NNTP username. |
| `USENET_PASS` | yes | none | NNTP password. |
| `USENET_NEWSGROUPS` | no | default list below | Comma-separated newsgroups available for posting. Whitespace around entries is trimmed and empty entries are ignored. |
| `USENET_NEWSGROUPS_PER_UPLOAD` | no | `20` | Positive integer. Maximum number of configured newsgroups randomly selected for each upload. The worker uses the smaller of this value and the configured newsgroup count. |

Default `USENET_NEWSGROUPS`:

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

### Legacy Usenet Aliases

These aliases are still accepted for backwards compatibility:

| Variable | Priority | Description |
|---|---:|---|
| `USENET_NEWSGROUP` | after `USENET_NEWSGROUPS` | Single-value or comma-separated legacy fallback for `USENET_NEWSGROUPS`. |
| `USENET_RELEASE_GROUP` | after `USENET_NEWSGROUP` | Older fallback for `USENET_NEWSGROUPS`. |

Priority is:

```text
USENET_NEWSGROUPS -> USENET_NEWSGROUP -> USENET_RELEASE_GROUP -> built-in defaults
```

## Webhooks

Webhook URLs are optional. If no matching URL is configured for an event, no delivery is queued.

Event-specific variables override `WEBHOOK_URL` for that event only.

| Variable | Required | Default | Description |
|---|---:|---|---|
| `WEBHOOK_URL` | no | empty | Catch-all destination for every webhook event. |
| `WEBHOOK_DOWNLOAD_COMPLETED_URL` | no | empty | Destination for `download.completed`. Overrides `WEBHOOK_URL`. |
| `WEBHOOK_DOWNLOAD_FAILED_URL` | no | empty | Destination for `download.failed`. Overrides `WEBHOOK_URL`. |
| `WEBHOOK_NZB_COMPLETED_URL` | no | empty | Destination for `nzb.completed`. Overrides `WEBHOOK_URL`. |
| `WEBHOOK_NZB_FAILED_URL` | no | empty | Destination for `nzb.failed`. Overrides `WEBHOOK_URL`. |
| `WEBHOOK_SECRET` | no | empty | Secret used to sign webhook request bodies. When set, deliveries include `X-Webhook-Signature: sha256=<hex>`, where the hex value is `HMAC-SHA256(WEBHOOK_SECRET, raw_request_body)`. |

## Indexer Uploads

Indexer uploads are optional. When configured, each completed NZB is queued for upload to every configured HTTP target. These deliveries are retried independently from the NZB job; a failed indexer upload does not change the parent NZB from `completed` to `failed`.

| Variable | Required | Default | Description |
|---|---:|---|---|
| `INDEXER_UPLOADS_JSON` | no | empty | JSON array of generic HTTP upload targets. Empty means no indexer uploads are queued. |

DrunkenSlug-style uploads use a multipart file field named `files[]`:

```json
[
  {
    "name": "drunkenslug",
    "url": "https://nzbs.drunkenslug.com/upload.php",
    "fileField": "files[]"
  }
]
```

Supported target fields:

| Field | Default | Description |
|---|---|---|
| `name` | required | Unique target name used in API status and retry rows. |
| `url` | required | Upload endpoint URL. |
| `method` | `POST` | `POST` or `PUT`. |
| `format` | `multipart` | `multipart` sends a form upload; `raw` sends the NZB as the request body. |
| `fileField` | `file` | Multipart file field name, passed through verbatim. Names such as `files[]` are supported. |
| `filenameTemplate` | `{releaseName}.nzb` | Filename used for the uploaded NZB part or raw content disposition. |
| `headers` | `{}` | String map of extra request headers. |
| `fields` | `{}` | String map of extra multipart fields. Ignored for `raw`. |

`headers`, `fields`, and `filenameTemplate` support `{nzbId}`, `{releaseName}`, `{nzbFile}`, and `{postedAt}` substitutions.

## Tooling And Container Variables

These variables are not part of normal application configuration, but they appear in project tooling or the container image.

| Variable | Scope | Default | Description |
|---|---|---|---|
| `DATABASE_URL` | Drizzle tooling | `./data/app.db` | Used by `drizzle.config.ts` for Drizzle Kit commands. The running application does not read this variable; it always opens `<DATA_DIR>/app.db`. |
| `NODE_VERSION` | Docker image build metadata | Dockerfile `ARG` default | Build argument used in the `node:<version>-slim` base image tag. Renovate tracks the Dockerfile `ARG` comments in both Dockerfiles. |
| `NODE_ENV` | Docker image / Node ecosystem | `production` in the runtime image | Set by the Dockerfile. The application code does not branch on it directly. |
| `SVTPLAY_DL_VERSION` | Docker image build/runtime metadata | Dockerfile `ARG` default | Build argument used to pin the installed `svtplay-dl` package version. The value is also exposed as an environment variable in the built image for inspection. Use `latest` only for ad-hoc testing. |

## Frontend Configuration

The separate frontend image builds the Vue app and serves it with Vite preview. The frontend server reads Basic Auth on each browser request and serves a generated `/config.js` for that request. The browser app does not read `BACKEND_URL`, `BACKEND_TOKEN`, query parameters, or `localStorage`.

| Variable | Required | Default | Description |
|---|---:|---|---|
| `FRONTEND_PORT` | no | `8080` | Port used by the Vite preview server inside the frontend container. |

Set the dashboard backend URL and token with Basic Auth credentials. The username is the backend URL and the password is the backend API key. When using credentials in the URL, percent-encode the backend URL:

```text
http://http%3A%2F%2Flocalhost%3A3001:<API_KEY>@localhost:8080/#/dashboard
```

The frontend server uses the Basic Auth username as the backend URL, uses the Basic Auth password as the bearer token for backend API calls, and does not persist either value in browser storage. Omit the username to use same-origin `/v1`.

Visit `/logout` to force a Basic Auth challenge when you need to enter different credentials. Browser behavior differs, so cancelling the challenge may still leave existing credentials active in some browsers.
