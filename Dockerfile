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
RUN corepack enable
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 python3-pip ffmpeg curl ca-certificates \
  && pip install --break-system-packages svtplay-dl \
  && npm install -g nyuu @animetosho/parpar \
  && apt-get clean \
  && rm -rf /var/lib/apt/lists/*

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/drizzle ./drizzle
COPY entrypoint.sh ./entrypoint.sh
RUN chmod +x ./entrypoint.sh

ENV NODE_ENV=production
EXPOSE 3001
ENTRYPOINT ["./entrypoint.sh"]
