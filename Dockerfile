# renovate: datasource=node-version depName=node
ARG NODE_VERSION=20.20.2
FROM node:${NODE_VERSION}-slim AS backend-deps

WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile --filter .

FROM backend-deps AS backend-builder

WORKDIR /app
COPY tsconfig.json tsconfig.build.json drizzle.config.ts ./
COPY src ./src
COPY drizzle ./drizzle
RUN pnpm run build:server
RUN pnpm prune --prod

FROM node:${NODE_VERSION}-slim AS backend

WORKDIR /app
ARG VERSION=0.0.0
# renovate: datasource=pypi depName=svtplay-dl
ARG SVTPLAY_DL_VERSION=4.179
RUN set -eux; \
  apt-get update; \
  apt-get install -y --no-install-recommends ca-certificates curl ffmpeg python3 python3-pip make g++; \
  if [ "$SVTPLAY_DL_VERSION" = "latest" ]; then \
    pip install --no-cache-dir --break-system-packages svtplay-dl; \
  else \
    pip install --no-cache-dir --break-system-packages "svtplay-dl==$SVTPLAY_DL_VERSION"; \
  fi; \
  npm install -g --omit=dev nyuu @animetosho/parpar; \
  npm cache clean --force; \
  apt-get purge -y --auto-remove python3-pip make g++; \
  apt-get clean; \
  rm -rf /var/lib/apt/lists/* /root/.cache /tmp/*

COPY --from=backend-builder /app/node_modules ./node_modules
COPY --from=backend-builder /app/dist ./dist
COPY --from=backend-builder /app/drizzle ./drizzle
COPY entrypoint.sh ./entrypoint.sh
RUN chmod +x ./entrypoint.sh

ENV NODE_ENV=production
ENV VERSION=${VERSION}
ENV SVTPLAY_DL_VERSION=${SVTPLAY_DL_VERSION}
EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || '3001') + '/v1/health').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
ENTRYPOINT ["./entrypoint.sh"]

FROM backend AS runtime
