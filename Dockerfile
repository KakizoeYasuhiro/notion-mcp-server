# syntax=docker/dockerfile:1
FROM node:24.22.2-bookworm-slim AS base

FROM base AS builder
WORKDIR /app
COPY package*.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --ignore-scripts
COPY . .
RUN npm run build

FROM base
WORKDIR /app
COPY --from=builder /app/bin/cli.mjs ./bin/cli.mjs
COPY --from=builder /app/scripts/notion-openapi.json ./scripts/notion-openapi.json
RUN ln -s /app/bin/cli.mjs /usr/local/bin/notion-mcp-server

ENV OPENAPI_MCP_HEADERS="{}"
USER node
ENTRYPOINT ["notion-mcp-server"]
