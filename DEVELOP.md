# Development Guide

This guide covers local development for `nzb-relay`.

## Requirements

- Node.js 20+
- pnpm 10+
- SQLite-compatible native build tooling for `better-sqlite3`

For local worker execution, these external binaries must also be available on `PATH`:

- `svtplay-dl`
- `ffmpeg`
- `rar`
- `parpar`
- `nyuu`

## Install Dependencies

```sh
pnpm install
```

If pnpm blocks native package build scripts, allow `better-sqlite3` and rebuild:

```sh
pnpm rebuild better-sqlite3
```

The project already declares `better-sqlite3` in `pnpm.onlyBuiltDependencies`.

## Run Checks

Production build:

```sh
pnpm run build
```

Full TypeScript check, including tests:

```sh
pnpm exec tsc -p tsconfig.json --noEmit
```

Test suite:

```sh
pnpm test
```

## Run Locally

The application requires Usenet server credentials at startup. `USENET_NEWSGROUPS` defaults to the `alt.binaries.newznzb.*` alphabet groups, and can be set to a comma-separated list to override them.

```sh
DATA_DIR=./data \
API_KEY=dev-secret \
USENET_HOST=news.example.com \
USENET_USER=user \
USENET_PASS=pass \
pnpm run dev
```

The API will listen on `http://localhost:3001` unless `PORT` is set.

Health check:

```sh
curl http://localhost:3001/v1/health
```

Authenticated API request:

```sh
curl \
  -H "Authorization: Bearer dev-secret" \
  http://localhost:3001/v1/files
```

## Database And Migrations

The Drizzle schema lives in [src/db/schema.ts](src/db/schema.ts).

Generated migrations are committed under [drizzle/](drizzle/). To generate a new migration after changing the schema:

```sh
pnpm run db:generate
```

Migrations run automatically at application startup before workers start.

## Runtime Data

For local development with `DATA_DIR=./data`, the app writes:

```text
data/
  app.db
  downloads/
  nzb/
```

`data/` is ignored by git.
