# ── Build stage ──────────────────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --ignore-scripts
COPY tsconfig.json ./
COPY src/ ./src/
COPY migrations/ ./migrations/
COPY prompts/ ./prompts/
COPY taxonomy_config.yaml ./
RUN npx tsc -p tsconfig.json

# ── Runtime stage ────────────────────────────────────────────────
FROM node:20-alpine AS runtime

WORKDIR /app

# Install production deps only
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --ignore-scripts && \
    npm rebuild better-sqlite3 --quiet 2>/dev/null || true

# Copy built output + assets
COPY --from=builder /app/dist ./dist
COPY migrations/ ./migrations/
COPY prompts/ ./prompts/
COPY taxonomy_config.yaml ./
COPY data/ ./data/

# Data directory for SQLite + keyword CSV
RUN mkdir -p /app/data

# Health check
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD wget -qO- http://localhost:3100/health || exit 1

EXPOSE 3100

CMD ["node", "dist/server.js"]
