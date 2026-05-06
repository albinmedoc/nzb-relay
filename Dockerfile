FROM node:20-slim AS builder

WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY tsconfig.json tsconfig.build.json drizzle.config.ts ./
COPY src ./src
COPY drizzle ./drizzle
RUN pnpm run build
RUN pnpm prune --prod

FROM node:20-slim AS runtime

WORKDIR /app
ARG VERSION=0.0.0
RUN corepack enable
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 python3-pip ffmpeg curl ca-certificates make g++ \
  && apt-get clean \
  && rm -rf /var/lib/apt/lists/*
RUN pip install --no-cache-dir --break-system-packages svtplay-dl
RUN npm install -g nyuu @animetosho/parpar \
  && npm cache clean --force

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/drizzle ./drizzle
COPY entrypoint.sh ./entrypoint.sh
RUN chmod +x ./entrypoint.sh

ENV NODE_ENV=production
ENV VERSION=${VERSION}
EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || '3001') + '/v1/health').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
ENTRYPOINT ["./entrypoint.sh"]
