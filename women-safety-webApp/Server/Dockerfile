FROM node:24-alpine

WORKDIR /app

# Install build dependencies if needed
RUN apk add --no-cache python3 make g++

COPY package*.json ./

RUN npm ci --omit=dev

COPY . .

# Generate Prisma Client
RUN npx prisma generate

ENV PORT=5001

EXPOSE 5001

# Container health monitoring using Node.js built-in fetch
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:5001/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "index.js"]
