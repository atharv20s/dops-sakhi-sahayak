FROM node:24-alpine
WORKDIR /app

# Install build dependencies if needed
RUN apk add --no-cache python3 make g++

COPY package*.json ./
RUN npm ci --only=production

COPY . .

ENV PORT=5001
EXPOSE 5001

CMD ["node", "index.js"]

