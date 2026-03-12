# ── Stage 1: Build ──────────────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /app

# Install deps first (layer cache)
COPY package.json package-lock.json* ./
RUN npm ci --ignore-scripts && npm run rebuild:better-sqlite3

# Copy source and build
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# ── Stage 2: Runtime ────────────────────────────────────────────
FROM node:20-alpine

WORKDIR /app

# Install only production deps
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --ignore-scripts && npm run rebuild:better-sqlite3

# Copy built output
COPY --from=builder /app/dist ./dist

# Copy runtime assets
COPY migrations/ ./migrations/
COPY prompts/ ./prompts/
COPY data/ ./data/

# Create data directory for SQLite
RUN mkdir -p /app/data

# Default port
EXPOSE 3100

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:3100/health || exit 1

CMD ["node", "dist/server.js"]
