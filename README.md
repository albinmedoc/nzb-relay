# nzb-relay

`nzb-relay` is a small HTTP service for monitored media download and Usenet upload workflows. It wraps:

- `svtplay-dl` for downloads
- `rar`, `parpar`, and `nyuu` for NZB/Usenet posting
- SQLite for durable job state
- A built-in watchlist for polling supported series
- Webhooks for completion and failure notifications
- A separate Vue web dashboard image

The backend can monitor supported series itself through the watchlist API or be driven by an external orchestrator such as n8n, cron-backed scripts, or another REST client. The Vue dashboard runs as a separate frontend container and talks to the backend over HTTP.

For the HTTP contract, see [docs/API.md](docs/API.md). Runtime configuration is documented in
[docs/ENVIRONMENTS.md](docs/ENVIRONMENTS.md). An optional n8n setup is documented in
[docs/N8N_SVTPLAY.md](docs/N8N_SVTPLAY.md).

## What It Does

- Accepts async download jobs over HTTP.
- Monitors watched SVT Play series and queues newly discovered episodes.
- Can soft-delete watchlist downloads automatically after their NZB upload completes.
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

The backend Docker image pins Node.js and `svtplay-dl` at build time. To build with different versions:

```sh
docker build \
  --build-arg NODE_VERSION=20.20.2 \
  --build-arg SVTPLAY_DL_VERSION=4.179 \
  -t nzb-relay .
```

Build the frontend image separately:

```sh
docker build -f frontend/Dockerfile -t nzb-relay-frontend .
```

The frontend image builds the Vue app with Vite and runs a small Vite preview server that derives frontend runtime config from Basic Auth.

Use `SVTPLAY_DL_VERSION=latest` only for ad-hoc testing; release images should use the explicit defaults in the Dockerfile. Renovate updates those Dockerfile `ARG` values through the inline `renovate` metadata comments.

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

See [docs/ENVIRONMENTS.md](docs/ENVIRONMENTS.md) for the full list of supported environment variables and parsing rules.

`USENET_NEWSGROUPS` defaults to the `alt.binaries.newznzb.*` alphabet groups and can be set to a comma-separated list to override them. `USENET_NEWSGROUPS_PER_UPLOAD` defaults to `20`; each upload randomly picks that many groups so providers with a 20-group crosspost limit do not reject posts.

The service listens on `http://localhost:3001` by default. Health is available at `http://localhost:3001/v1/health`.
The frontend listens on `http://localhost:8080` in the compose example. If the frontend is served from a different origin, set backend `CORS_ORIGINS` to that browser origin.
Open the frontend with Basic Auth credentials where the username is the backend URL and the password is the API key. When using credentials in the URL, percent-encode the backend URL:

```text
http://http%3A%2F%2Flocalhost%3A3001:<API_KEY>@localhost:8080/#/dashboard
```

The frontend does not accept backend URL or token query parameters and does not store credentials in `localStorage`.
Use `/logout` to force a Basic Auth challenge when you need to enter different credentials.

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
    <nzbId>/
      <name>.nzb
      <name>.log
      work/
        transient rar/par2 staging
```

Mount `DATA_DIR` as a persistent volume in production.

## Release Images

The GitHub Actions workflow builds and pushes backend and frontend images to GitHub Container Registry when a GitHub release is published.
The same release tag is baked into the image as `VERSION`, which is returned by `GET /v1/health`.

For a non-prerelease release tag such as `v1.1.1`, the workflow publishes:

- `ghcr.io/<owner>/<repo>:v1`
- `ghcr.io/<owner>/<repo>:v1.1`
- `ghcr.io/<owner>/<repo>:v1.1.1`
- `ghcr.io/<owner>/<repo>:latest`
- `ghcr.io/<owner>/<repo>-frontend:v1`
- `ghcr.io/<owner>/<repo>-frontend:v1.1`
- `ghcr.io/<owner>/<repo>-frontend:v1.1.1`
- `ghcr.io/<owner>/<repo>-frontend:latest`
