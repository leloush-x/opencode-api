# Dockerfile for the Bun port of opencode2api.
#
# Build:
#   docker build -t opencode2api .
#
# Run (config.json must bind to 0.0.0.0 so docker port mapping works):
#   docker run -p 8080:8080 -p 8081:8081 \
#     -v "$(pwd)/config:/config:rw" \
#     opencode2api

# ---------------------------------------------------------------------------
# Build stage
# ---------------------------------------------------------------------------
FROM oven/bun:1.4.4 AS builder
WORKDIR /app

# Install dependencies first (better layer caching).
COPY package.json bun.lock bunfig.toml ./
RUN bun install --backend=copyfile

# Copy source, typecheck, compile a standalone binary.
COPY . .
RUN bun run typecheck
RUN bun run build:binary

# ---------------------------------------------------------------------------
# Run stage
# ---------------------------------------------------------------------------
FROM oven/bun:1.4.4-slim
WORKDIR /app

RUN groupadd -r oc2api && useradd -r -g oc2api oc2api

# Compiled binary + the WebUI assets it serves.
COPY --from=builder /app/dist/opencode2api /usr/local/bin/opencode2api
COPY --from=builder /app/dist/webui /app/webui

# Tell the binary where the WebUI lives (it otherwise looks next to itself).
ENV WEBUI_DIR=/app/webui

# Config and state live outside the image, mounted at runtime.
VOLUME /config
ENV CONFIG=/config/config.json

EXPOSE 8080 8081

USER oc2api

ENTRYPOINT ["opencode2api", "-config", "/config/config.json"]
