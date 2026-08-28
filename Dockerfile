
FROM node:22-slim AS builder

WORKDIR /app

# Install all dependencies (gateway + supergateway + @octocodeai/mcp as local deps)
COPY package.json ./
RUN npm install --omit=dev

# --- runtime: no npm ships here --------------------------------------------
# server.js spawns node_modules/.bin binaries directly, so npm/npx are never
# used at runtime. Removing npm drops its bundled tar (and every future npm
# transitive CVE) from the shipped image.
FROM node:22-slim

WORKDIR /app

# Patch base-OS packages (libssl/libgcrypt/etc. age into CVEs), then drop npm
# and its bundled tar — the runtime never uses npm (server.js spawns the
# node_modules/.bin binaries directly).
RUN apt-get update \
    && apt-get upgrade -y \
    && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

COPY --from=builder /app/node_modules ./node_modules
COPY package.json server.js ./

ENV NODE_ENV=production
# Cloud Run injects PORT (default 8080); the gateway reads it.
CMD ["node", "server.js"]
