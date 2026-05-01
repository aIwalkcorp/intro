FROM oven/bun:1.1-alpine AS deps
WORKDIR /app
COPY api/package.json api/bun.lock* ./
RUN bun install --frozen-lockfile --production --no-save || bun install --production --no-save

FROM oven/bun:1.1-alpine
WORKDIR /app
RUN apk add --no-cache curl tini
COPY --from=deps /app/node_modules ./node_modules
COPY api/package.json api/tsconfig.json* api/drizzle.config.ts ./
COPY api/src ./src
COPY skill ./skill
ENV NODE_ENV=production
ENV SKILL_DIR=/app/skill
ENV PORT=4100
EXPOSE 4100
USER bun

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -fsS http://127.0.0.1:4100/healthz || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["bun", "run", "src/server.ts"]
