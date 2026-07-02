FROM node:22-slim

WORKDIR /app

# Install all dependencies (gateway + supergateway + @octocodeai/mcp as local deps)
COPY package.json ./
RUN npm install --omit=dev

COPY server.js ./

ENV NODE_ENV=production
# Cloud Run injects PORT (default 8080); the gateway reads it.
CMD ["node", "server.js"]
