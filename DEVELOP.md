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

Backend-only build:

```sh
pnpm run build:server
```

Frontend-only build:

```sh
pnpm run build:frontend
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

The application requires Usenet server credentials at startup. `USENET_NEWSGROUPS` defaults to the `alt.binaries.newznzb.*` alphabet groups, and can be set to a comma-separated list to override them. `USENET_NEWSGROUPS_PER_UPLOAD` defaults to `20`; each upload randomly picks that many groups.

```sh
DATA_DIR=./data \
API_KEY=dev-secret \
USENET_HOST=news.example.com \
USENET_USER=user \
USENET_PASS=pass \
pnpm run dev
```

The API will listen on `http://localhost:3001` unless `PORT` is set.

For frontend development, run the Vite dev server in a separate terminal:

```sh
pnpm run dev:frontend
```

The released frontend container builds the Vue app and serves it with Vite preview plus the same Basic Auth runtime config middleware used by the Vite dev server.

For cross-origin frontend development, set the backend CORS origin:

```sh
CORS_ORIGINS=http://localhost:5173 \
DATA_DIR=./data \
API_KEY=dev-secret \
USENET_HOST=news.example.com \
USENET_USER=user \
USENET_PASS=pass \
pnpm run dev
```

Open `http://http%3A%2F%2Flocalhost%3A3001:dev-secret@localhost:5173/#/dashboard` to pass the backend URL and API key through Basic Auth URL credentials. You can also open `http://localhost:5173/` and enter `http://localhost:3001` as the username and `dev-secret` as the password when the browser prompts.

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
