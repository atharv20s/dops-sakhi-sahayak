# Multi-stage build for Sakhi Sahayak Backend
# Stage 1: Build & Prisma Generate
FROM node:24-alpine AS builder

WORKDIR /app

RUN apk add --no-cache python3 make g++

COPY package*.json ./
COPY prisma ./prisma/

# Install all dependencies (including prisma CLI devDependency)
RUN DATABASE_URL="postgresql://build:build@127.0.0.1:5432/build" DIRECT_URL="postgresql://build:build@127.0.0.1:5432/build" npm ci

# Generate Prisma Client (outputs to node_modules/@prisma/client and .prisma)
RUN DATABASE_URL="postgresql://build:build@127.0.0.1:5432/build" DIRECT_URL="postgresql://build:build@127.0.0.1:5432/build" npx prisma generate

# Prune dev dependencies keeping the generated prisma client
RUN npm prune --omit=dev \
    && npm install --no-save --omit=dev prisma@6.4.1 \
    && ./node_modules/.bin/prisma --version

# Stage 2: Production Runner
FROM node:24-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=5001

# Copy production node_modules from builder (includes generated prisma client)
COPY --from=builder /app/node_modules ./node_modules
COPY . .

EXPOSE 5001

# Container health monitoring using Node.js built-in fetch
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:5001/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

# Apply checked-in, forward-only migrations before serving production traffic.
CMD ["sh", "-c", "./node_modules/.bin/prisma migrate deploy && exec node index.js"]
