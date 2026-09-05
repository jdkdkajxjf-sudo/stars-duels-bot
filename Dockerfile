FROM oven/bun:1 AS base
WORKDIR /app

# Install curl for healthcheck
RUN apt-get update && apt-get install -y curl && rm -rf /var/lib/apt/lists/*

# Copy package files
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile --production

# Copy source
COPY . .

# Generate Prisma client
RUN bunx prisma generate

# Expose port (Render sets PORT env)
ENV PORT=3006
EXPOSE 3006

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD curl -f http://localhost:3006/health || exit 1

# Start: detect DB provider (postgresql:// or file:), run migrations, then start bot
CMD ["sh", "-c", "if [ -z \"$DATABASE_URL\" ]; then echo 'FATAL: DATABASE_URL not set'; exit 1; fi && if echo $DATABASE_URL | grep -q '^file:'; then echo 'SQLite mode' && sed -i 's/provider = \"postgresql\"/provider = \"sqlite\"/' prisma/schema.prisma && bunx prisma generate; else echo 'PostgreSQL mode'; fi && bunx prisma db push --accept-data-loss && bun index.ts"]
