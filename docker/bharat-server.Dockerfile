# bharat-server: Express + tRPC API, React frontend, WebSocket at /signals.
# Build context is the repo root (needs package.json, src/, server.ts, etc).
#   docker build -f docker/bharat-server.Dockerfile -t bharat-server .
FROM node:22-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "--max-old-space-size=4096", "node_modules/tsx/dist/cli.mjs", "server.ts"]
