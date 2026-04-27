FROM oven/bun:1.1-alpine AS deps
WORKDIR /app
COPY api/package.json ./
RUN bun install --production --no-save

FROM oven/bun:1.1-alpine
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY api/package.json api/tsconfig.json* ./
COPY api/src ./src
COPY skill ./skill
ENV NODE_ENV=production
ENV SKILL_DIR=/app/skill
ENV PORT=4100
EXPOSE 4100
USER bun
CMD ["bun", "run", "src/server.ts"]
