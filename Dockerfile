# syntax=docker/dockerfile:1

# ---- web build ----
FROM node:22-alpine AS web
WORKDIR /app/web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

# ---- server build ----
FROM node:22-alpine AS server
WORKDIR /app/server
COPY server/package.json server/package-lock.json ./
RUN npm ci
COPY server/ ./
RUN npm run build && npm prune --omit=dev

# ---- runtime ----
FROM node:22-alpine
ENV NODE_ENV=production PORT=4000
WORKDIR /app
COPY --from=server /app/server/node_modules ./server/node_modules
COPY --from=server /app/server/dist ./server/dist
COPY --from=server /app/server/package.json ./server/package.json
COPY --from=web /app/web/dist ./web/dist
USER node
EXPOSE 4000
WORKDIR /app/server
CMD ["node", "dist/index.js"]
