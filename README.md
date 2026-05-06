# nzb-relay

`nzb-relay` is a small HTTP service for monitored media download and Usenet upload workflows. It wraps:

- `svtplay-dl` for downloads
- `rar`, `parpar`, and `nyuu` for NZB/Usenet posting
- SQLite for durable job state
- A built-in watchlist for polling supported series
- Webhooks for completion and failure notifications

The service has no UI. It can monitor supported series itself through the watchlist API, or be driven by an external orchestrator such as n8n, cron-backed scripts, or another REST client.

For the HTTP contract, see [docs/API.md](docs/API.md). An optional n8n setup is documented in
[docs/N8N_SVTPLAY.md](docs/N8N_SVTPLAY.md).

## What It Does

- Accepts async download jobs over HTTP.
- Monitors watched SVT Play series and queues newly discovered episodes.
- Stores every job in SQLite with a deterministic lifecycle: `pending -> running -> completed | failed`.
- Runs watchlist, download, NZB upload, and webhook workers.
- Persists generated media, NZB files, and logs under one `DATA_DIR`.
- Sends durable webhook notifications for terminal states, with retries after restarts.
- Exposes read and download endpoints for job metadata, logs, MKV files, and NZB files.

See [docs/API.md](docs/API.md) for endpoint details.

## Container Support

The published image is intended for `linux/amd64`.

RAR is proprietary and the official RARLAB command-line Linux package is available for x64. Because of that, the GitHub workflow builds only `linux/amd64`, and the entrypoint only installs RAR on `x86_64`.

The container downloads the pinned RAR binary on first start if `/usr/local/bin/rar` is missing.

## Quick Start With Docker Compose

Copy [docker-compose.yaml](docker-compose.yaml), edit the environment variables, then run:

```sh
docker compose up -d
```

At minimum, set:

- `API_KEY`
- `USENET_HOST`
- `USENET_USER`
- `USENET_PASS`
- `WEBHOOK_URL` or event-specific webhook URLs, if you want notifications

`USENET_NEWSGROUPS` defaults to the `alt.binaries.newznzb.*` alphabet groups and can be set to a comma-separated list to override them.

The service listens on `http://localhost:3001` by default. Health is available at:

## Storage

All runtime state lives under `DATA_DIR`:

```text
/data/
  app.db
  downloads/
    <fileId>/
      <filename>.mkv
      <filename>.log
  nzb/
    <nzbId>.nzb
    <nzbId>.log
    <nzbId>/
      transient rar/par2 staging
```

Mount `DATA_DIR` as a persistent volume in production.

## Release Images

The GitHub Actions workflow builds and pushes to GitHub Container Registry when a GitHub release is published.
The same release tag is baked into the image as `VERSION`, which is returned by `GET /v1/health`.

For a non-prerelease release tag such as `v1.1.1`, the workflow publishes:

- `ghcr.io/<owner>/<repo>:v1`
- `ghcr.io/<owner>/<repo>:v1.1`
- `ghcr.io/<owner>/<repo>:v1.1.1`
- `ghcr.io/<owner>/<repo>:latest`
