# syntax=docker/dockerfile:1
FROM node:24.19.0-bookworm-slim@sha256:a9f5f7c91a432850b2a8a7797adf5eadb6c733ceed61167806cee7ea7fbc29df AS frontend

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY tsconfig.json vite.config.ts ./
COPY web ./web
COPY admin ./admin
COPY scripts ./scripts
COPY src/paths.mjs ./src/paths.mjs
RUN npm run build

FROM node:24.19.0-bookworm-slim@sha256:a9f5f7c91a432850b2a8a7797adf5eadb6c733ceed61167806cee7ea7fbc29df

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund && npm cache clean --force
COPY --chown=node:node src ./src
COPY --chown=node:node web ./web
COPY --chown=node:node scripts ./scripts
COPY --chown=node:node vendor ./vendor
COPY --chown=node:node deploy/synapse ./deploy/synapse
COPY --from=frontend --chown=node:node /app/dist/web ./dist/web
COPY --from=frontend --chown=node:node /app/dist/admin ./dist/admin

ENV NODE_ENV=production DS_GROUP_DATA_DIR=/data DS_GROUP_HOST=0.0.0.0 DS_GROUP_PORT=18100
USER node
EXPOSE 18100
HEALTHCHECK --interval=15s --timeout=5s --start-period=15s --retries=4 \
  CMD node -e "fetch('http://127.0.0.1:18100/readyz',{signal:AbortSignal.timeout(4000)}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "src/core.mjs"]
