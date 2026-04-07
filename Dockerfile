# ── Build stage ──────────────────────────────────
FROM node:22-alpine AS builder
WORKDIR /app

# Install server dependencies
COPY package.json package-lock.json ./
RUN npm ci

# Copy source and config
COPY tsconfig.json ./
COPY src/ src/
COPY drizzle/ drizzle/
COPY drizzle.config.ts ./

# Build server (TypeScript → dist/)
RUN npm run build

# Build Vue SPA (src/web/ → src/web/dist/)
RUN cd src/web && npm ci && npx vite build

# ── Migration stage (includes devDeps for drizzle-kit) ──
FROM node:22-alpine AS migrator
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY --from=builder /app/dist/ dist/
COPY drizzle/ drizzle/
COPY drizzle.config.ts ./
CMD ["npx", "drizzle-kit", "push"]

# ── Production stage ─────────────────────────────
FROM node:22-alpine
WORKDIR /app

# Install production dependencies only
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Copy compiled server from builder
COPY --from=builder /app/dist/ dist/

# Copy built Vue SPA to where server.ts expects it (src/web/dist/)
COPY --from=builder /app/src/web/dist/ src/web/dist/

# Copy legacy index.html fallback
COPY src/web/index.html src/web/index.html

# Copy drizzle migrations (for reference, not for runtime)
COPY drizzle/ drizzle/
COPY drizzle.config.ts ./

ENV NODE_ENV=production
EXPOSE 3001

CMD ["node", "dist/api/server.js"]
