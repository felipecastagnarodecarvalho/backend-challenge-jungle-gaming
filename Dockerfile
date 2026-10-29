# Bun runs the TypeScript sources directly (no build step); tsconfig.json is needed for decorators metadata.
FROM oven/bun:1.4.4 AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

FROM oven/bun:1.4.4
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY package.json tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
USER bun
EXPOSE 3000
STOPSIGNAL SIGTERM
# Exec form, no `bun run` wrapper: SIGTERM reaches the app process directly (tini via `init: true` in compose).
CMD ["bun", "src/main.ts"]
