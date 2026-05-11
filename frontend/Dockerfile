# renovate: datasource=node-version depName=node
ARG NODE_VERSION=20.20.2
FROM node:${NODE_VERSION}-slim AS deps

WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY frontend/package.json ./frontend/package.json
RUN pnpm install --frozen-lockfile --filter nzb-relay-frontend...

FROM deps AS builder

WORKDIR /app
COPY frontend ./frontend
RUN pnpm --filter nzb-relay-frontend build

FROM node:${NODE_VERSION}-slim AS runtime

ENV FRONTEND_PORT=8080
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY frontend/package.json frontend/vite.config.ts ./frontend/
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/frontend/node_modules ./frontend/node_modules
COPY --from=builder /app/frontend/dist ./frontend/dist
WORKDIR /app/frontend
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.FRONTEND_PORT || '8080') + '/health').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
CMD ["sh", "-c", "pnpm run start -- --port \"${FRONTEND_PORT}\""]
