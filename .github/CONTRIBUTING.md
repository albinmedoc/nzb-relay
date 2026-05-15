# Contributing

Thanks for working on `nzb-relay`. This project is a TypeScript service with a Hono API, SQLite/Drizzle persistence, worker processes, and a Vue frontend.

## Requirements

- Node.js 20+
- pnpm 10+
- Native build tooling for `better-sqlite3`

Worker development also needs these binaries on `PATH`:

- `svtplay-dl`
- `ffmpeg`
- `rar`
- `parpar`
- `nyuu`

## Setup

Install dependencies:

```sh
pnpm install
```

If pnpm blocks native package build scripts, allow and rebuild `better-sqlite3`:

```sh
pnpm rebuild better-sqlite3
```

The package manifest already lists `better-sqlite3` in `pnpm.onlyBuiltDependencies`.

## Local Runtime

The backend requires Usenet credentials at startup:

```sh
DATA_DIR=./data \
API_KEY=dev-secret \
USENET_HOST=news.example.com \
USENET_USER=user \
USENET_PASS=pass \
pnpm run dev
```

The API listens on `http://localhost:3001` unless `PORT` is set.

Run the frontend dev server in another terminal:

```sh
pnpm run dev:frontend
```

For cross-origin frontend development, start the backend with CORS enabled:

```sh
CORS_ORIGINS=http://localhost:5173 \
DATA_DIR=./data \
API_KEY=dev-secret \
USENET_HOST=news.example.com \
USENET_USER=user \
USENET_PASS=pass \
pnpm run dev
```

Open the frontend with Basic Auth credentials. The username is the backend URL and the password is the API key:

```text
http://http%3A%2F%2Flocalhost%3A3001:dev-secret@localhost:5173/#/dashboard
```

Health check:

```sh
curl http://localhost:3001/v1/health
```

Authenticated request:

```sh
curl \
  -H "Authorization: Bearer dev-secret" \
  http://localhost:3001/v1/files
```

## Checks

Run the full build:

```sh
pnpm run build
```

Run server or frontend builds separately:

```sh
pnpm run build:server
pnpm run build:frontend
```

Run the test suite:

```sh
pnpm test
```

Run the full TypeScript check, including tests:

```sh
pnpm exec tsc -p tsconfig.json --noEmit
```

## Database Changes

The Drizzle schema lives in `src/db/schema.ts`. Generated migrations are committed under `drizzle/`.

After changing the schema, generate and commit a migration:

```sh
pnpm run db:generate
```

Migrations run automatically during application startup before workers start.

## Runtime Data

For local development with `DATA_DIR=./data`, the app writes:

```text
data/
  app.db
  downloads/
  nzb/
```

`data/` is ignored by git.

## Before Opening A PR

- Keep changes scoped to the behavior being changed.
- Update docs and tests when public behavior or configuration changes.
- Run `pnpm test`.
- Run `pnpm run build` when shared types, server code, frontend code, or build configuration changes.
