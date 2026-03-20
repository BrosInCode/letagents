# ── Build stage ──────────────────────────────────
FROM node:22-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src/ src/
COPY drizzle/ drizzle/
COPY drizzle.config.ts ./
RUN npm run build

# ── Production stage ─────────────────────────────
FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=builder /app/dist/ dist/
COPY drizzle/ drizzle/
COPY drizzle.config.ts ./
COPY src/web/ dist/web/
EXPOSE 3001
CMD ["node", "dist/api/server.js"]
