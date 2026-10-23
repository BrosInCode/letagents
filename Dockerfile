# ── Build stage ──────────────────────────────────
FROM node:22-alpine AS builder
WORKDIR /app

# Install server dependencies
COPY package.json package-lock.json ./
RUN npm ci

# Copy source and config
COPY tsconfig.json ./
COPY src/ src/
COPY shared/ shared/
COPY drizzle/ drizzle/
COPY drizzle.config.ts ./

# Build server (TypeScript → dist/)
RUN npm run build

# The shared web UI (shared/ui) imports desktop renderer sources: chat
# avatars use the provider images, and the Connectors page uses desktop
# settings components, the error helper and IPC types. Build stage only;
# the production image copies the built bundle, not these sources.
COPY apps/desktop/renderer/src/ apps/desktop/renderer/src/
COPY apps/desktop/electron/ipc-types/ apps/desktop/electron/ipc-types/

# Build Vue SPA (src/web/ → src/web/dist/)
RUN cd src/web && npm ci && npx vite build

# ── Migration stage (includes devDeps for drizzle-kit) ──
FROM node:22-alpine AS migrator
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY --from=builder /app/dist/ dist/
COPY --from=builder /app/shared/ shared/
COPY drizzle/ drizzle/
COPY drizzle.config.ts ./
COPY tsconfig.json ./
COPY src/api/db/ src/api/db/
COPY src/shared/ src/shared/
CMD ["sh", "-c", "node dist/api/migrate.js && node dist/api/focus-rooms/repair-ad-hoc-lineage.js"]

# ── Production stage ─────────────────────────────
FROM node:22-alpine
WORKDIR /app

# Install production dependencies only
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Copy compiled server from builder
COPY --from=builder /app/dist/ dist/
COPY --from=builder /app/shared/ shared/

# Copy built Vue SPA to where server.ts expects it (src/web/dist/)
COPY --from=builder /app/src/web/dist/ src/web/dist/

# Copy drizzle migrations (for reference, not for runtime)
COPY drizzle/ drizzle/
COPY drizzle.config.ts ./

ENV NODE_ENV=production
EXPOSE 3001

CMD ["node", "dist/api/server.js"]
