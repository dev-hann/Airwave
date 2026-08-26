# Multi-stage build for production-ready image (Node.js server)
# APP_VERSION: injected by CI (git tag name or dev-<sha>); exposed via env.
ARG APP_VERSION=dev
FROM node:22-slim AS builder
ARG APP_VERSION

WORKDIR /build

# Copy workspace manifests for dependency install
COPY package.json package-lock.json* ./
COPY apps/web/package.json ./apps/web/
COPY apps/node-server/package.json ./apps/node-server/
COPY packages/domain/package.json ./packages/domain/
COPY packages/usecases/package.json ./packages/usecases/
COPY packages/db/package.json ./packages/db/
COPY packages/shared/package.json ./packages/shared/

RUN npm ci

# Copy application source
COPY . .

# Build frontend (workspace script targets apps/web; output goes to apps/node-server/static-dist)
RUN npm run build

# Runtime binaries (yt-dlp / deno / ffmpeg / ffprobe) — downloaded into /build/bin
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl ca-certificates xz-utils unzip \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /build/bin \
    && ARCH=$(uname -m) \
    && case "$ARCH" in \
        x86_64|amd64) ASSET="yt-dlp_linux" ;; \
        aarch64|arm64) ASSET="yt-dlp_linux_aarch64" ;; \
        *) echo "Unsupported architecture: $ARCH" >&2; exit 1 ;; \
    esac \
    && curl -fsSL "https://github.com/yt-dlp/yt-dlp/releases/latest/download/${ASSET}" -o /build/bin/yt-dlp \
    && chmod +x /build/bin/yt-dlp

RUN ARCH=$(uname -m) \
    && case "$ARCH" in \
        x86_64|amd64) DENO_ASSET="deno-x86_64-unknown-linux-gnu.zip" ;; \
        aarch64|arm64) DENO_ASSET="deno-aarch64-unknown-linux-gnu.zip" ;; \
        *) echo "Unsupported architecture: $ARCH" >&2; exit 1 ;; \
    esac \
    && curl -fsSL "https://github.com/denoland/deno/releases/latest/download/${DENO_ASSET}" -o /tmp/deno.zip \
    && unzip -q /tmp/deno.zip -d /tmp/deno-extract \
    && mv /tmp/deno-extract/deno /build/bin/deno \
    && chmod +x /build/bin/deno \
    && rm -rf /tmp/deno.zip /tmp/deno-extract

RUN ARCH=$(uname -m) \
    && case "$ARCH" in \
        x86_64|amd64) ASSET_URL="https://github.com/yt-dlp/FFmpeg-Builds/releases/latest/download/ffmpeg-master-latest-linux64-gpl.tar.xz" ;; \
        aarch64|arm64) ASSET_URL="https://github.com/yt-dlp/FFmpeg-Builds/releases/latest/download/ffmpeg-master-latest-linuxarm64-gpl.tar.xz" ;; \
        *) echo "Unsupported architecture: $ARCH" >&2; exit 1 ;; \
    esac \
    && TMP_DIR=$(mktemp -d) \
    && curl -fsSL "$ASSET_URL" -o "$TMP_DIR/ffmpeg.tar.xz" \
    && tar -xJf "$TMP_DIR/ffmpeg.tar.xz" -C "$TMP_DIR" \
    && FFMPEG_BIN=$(find "$TMP_DIR" -type f -name ffmpeg | head -n 1) \
    && cp "$FFMPEG_BIN" /build/bin/ffmpeg \
    && chmod +x /build/bin/ffmpeg \
    && rm -rf "$TMP_DIR"

RUN ARCH=$(uname -m) \
    && case "$ARCH" in \
        x86_64|amd64) MR_ARCH=amd64 ;; \
        aarch64|arm64) MR_ARCH=arm64 ;; \
        *) echo "Unsupported architecture: $ARCH" >&2; exit 1 ;; \
    esac \
    && TMP_DIR=$(mktemp -d) \
    && curl -fsSL -L --retry 3 --retry-delay 2 \
        "https://ffmpeg.martin-riedl.de/redirect/latest/linux/${MR_ARCH}/release/ffprobe.zip" \
        -o "$TMP_DIR/ffprobe.zip" \
    && unzip -q "$TMP_DIR/ffprobe.zip" -d "$TMP_DIR/out" \
    && FFPROBE_BIN=$(find "$TMP_DIR/out" -type f -name ffprobe | head -n 1) \
    && cp "$FFPROBE_BIN" /build/bin/ffprobe \
    && chmod +x /build/bin/ffprobe \
    && rm -rf "$TMP_DIR"

# Production stage
FROM node:22-slim
ARG APP_VERSION

RUN apt-get update && apt-get install -y --no-install-recommends \
    curl ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /app/bin /app/data && \
    chown -R node:node /app

WORKDIR /app

# Workspace + app sources (node_modules from builder for runtime deps)
COPY --chown=airwave:airwave --from=builder /build/package.json ./package.json
COPY --chown=airwave:airwave --from=builder /build/node_modules ./node_modules
COPY --chown=airwave:airwave --from=builder /build/packages ./packages
COPY --chown=airwave:airwave --from=builder /build/apps/node-server ./apps/node-server

# Frontend bundle served by the Node server
COPY --chown=airwave:airwave --from=builder /build/apps/node-server/static-dist ./apps/node-server/static-dist

# Runtime binaries
COPY --chown=airwave:airwave --from=builder /build/bin/yt-dlp ./bin/yt-dlp
COPY --chown=airwave:airwave --from=builder /build/bin/deno ./bin/deno
COPY --chown=airwave:airwave --from=builder /build/bin/ffmpeg ./bin/ffmpeg
COPY --chown=airwave:airwave --from=builder /build/bin/ffprobe ./bin/ffprobe

ENV NODE_ENV=production \
    AIRWAVE_APP_VERSION=${APP_VERSION} \
    AIRWAVE_YT_DLP_PATH=/app/bin/yt-dlp \
    AIRWAVE_FFMPEG_PATH=/app/bin/ffmpeg \
    AIRWAVE_FFPROBE_PATH=/app/bin/ffprobe \
    AIRWAVE_DENO_PATH=/app/bin/deno \
    AIRWAVE_DB_URL="sqlite:///./data/airwave.db" \
    AIRWAVE_STATIC_DIR=/app/apps/node-server/static-dist \
    PATH="/app/bin:${PATH}"

USER node
EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD curl -f http://localhost:8000/api/health || exit 1

CMD ["node", "--experimental-strip-types", "apps/node-server/src/main.ts"]
