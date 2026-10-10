FROM rclone/rclone:1.75.1 AS rclone
FROM --platform=$BUILDPLATFORM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-fund --no-audit
COPY index.html vite.config.mjs ./
COPY public ./public
COPY src ./src
RUN npm run build

FROM node:24-alpine AS runtime
ARG CLOUDREEL_VERSION=1.0.5
ARG VCS_REF=unknown
LABEL org.opencontainers.image.title="CloudReel" \
    org.opencontainers.image.description="115 to Google Drive media transfer assistant" \
    org.opencontainers.image.source="https://github.com/qwer8856/cloudreel" \
    org.opencontainers.image.version=$CLOUDREEL_VERSION \
    org.opencontainers.image.revision=$VCS_REF
WORKDIR /app
RUN apk add --no-cache ca-certificates tzdata \
    && mkdir -p /data/config /data/panel /data/files \
    && chown -R node:node /data
COPY --from=rclone /usr/local/bin/rclone /usr/local/bin/rclone
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-fund --no-audit && npm cache clean --force
COPY server ./server
COPY --from=build /app/dist ./dist
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8787 \
    RCLONE_CONFIG=/data/config/rclone.conf DATA_DIR=/data/panel LOCAL_ROOT=/data/files
USER node
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:8787/api/session').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server/index.mjs"]
