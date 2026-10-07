# Multi-architecture official Node base; build separately for linux/amd64 and
# linux/arm64. This is a deployment draft, not a verified/published image.
FROM node:24.21.0-bookworm-slim
ARG OPENCLAW_VERSION=2026.9.8
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ git ca-certificates \
    && rm -rf /var/lib/apt/lists/*
RUN npm install --prefix /opt/openclaw --omit=dev --no-audit --no-fund "openclaw@${OPENCLAW_VERSION}"
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund
COPY src ./src
ENV OPENCLAW_GATEWAY_SDK_FILE=/opt/openclaw/node_modules/openclaw/dist/plugin-sdk/gateway-runtime.js
ENV VOICE_PE_BIND=0.0.0.0
USER node
EXPOSE 8080
CMD ["node", "src/server.mjs"]
