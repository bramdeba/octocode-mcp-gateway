// Octocode MCP gateway for Cloud Run.
//
// One process does two jobs:
//   1. Runs octocode-mcp (stdio-only) behind supergateway as a child process,
//      exposing streamable HTTP on 127.0.0.1:UPSTREAM_PORT.
//   2. Exposes a public HTTP endpoint that (a) publishes OAuth Protected
//      Resource Metadata, (b) validates AuthKit-issued bearer tokens, and
//      (c) proxies authorized MCP traffic to the internal server.
//
// The internal MCP server never sees unauthenticated traffic. Claude / Gemini
// talk only to the gateway, authenticating via WorkOS AuthKit (Google SSO).

import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createConnection } from 'node:net';
import { createProxyMiddleware } from 'http-proxy-middleware';
import { jwtVerify, createRemoteJWKSet } from 'jose';

const PORT = process.env.PORT || 8080;
const UPSTREAM_PORT = process.env.UPSTREAM_PORT || 3000;
const AUTHKIT_DOMAIN = process.env.AUTHKIT_DOMAIN;
const RESOURCE_URL = process.env.MCP_RESOURCE_URL;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
// Claude's MCP client doesn't send the `resource` parameter, so WorkOS sets
// aud to the DCR client_id instead of the resource URL. Set this to the
// client_id seen in WorkOS logs so we can validate aud despite that.
const WORKOS_CLIENT_ID = process.env.MCP_WORKOS_CLIENT_ID;

if (!AUTHKIT_DOMAIN || !RESOURCE_URL || !GITHUB_TOKEN) {
  console.error('Missing required env: AUTHKIT_DOMAIN, MCP_RESOURCE_URL, GITHUB_TOKEN');
  process.exit(1);
}

// Accept aud = resource URL (correct per spec) or aud = client_id (Claude workaround).
const VALID_AUDIENCES = WORKOS_CLIENT_ID ? [RESOURCE_URL, WORKOS_CLIENT_ID] : [RESOURCE_URL];

// --- 1. Start octocode-mcp behind supergateway as a child process ----------

// octocode-mcp is stdio-only, so supergateway wraps it and exposes streamable
// HTTP on the internal port. Both bins are installed by npm into .bin.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SUPERGATEWAY_BIN = path.join(__dirname, 'node_modules', '.bin', 'supergateway');
const OCTOCODE_BIN = path.join(__dirname, 'node_modules', '.bin', 'octocode-mcp');

console.log('Starting supergateway (octocode-mcp) on port', UPSTREAM_PORT);
const child = spawn(
  SUPERGATEWAY_BIN,
  [
    '--stdio', OCTOCODE_BIN,
    '--outputTransport', 'streamableHttp',
    '--port', String(UPSTREAM_PORT),
    '--streamableHttpPath', '/mcp',
    '--stateful',
    // Reap idle sessions (and their per-session octocode-mcp child processes)
    // after 1h so clients that vanish without a DELETE don't leak processes.
    '--sessionTimeout', '3600000',
    '--logLevel', 'info',
  ],
  {
    stdio: 'inherit',
    env: {
      ...process.env,
      GITHUB_TOKEN,
      ...(process.env.GITHUB_API_URL ? { GITHUB_API_URL: process.env.GITHUB_API_URL } : {}),
      // The container has no useful local filesystem to research.
      ENABLE_LOCAL: 'false',
      // Cloud Run's filesystem is read-only except /tmp.
      OCTOCODE_HOME: '/tmp/.octocode',
      // Without this, octocode replaces the text content of tool results with
      // a "structuredContent available" stub — and claude.ai connectors only
      // read the text part, so every tool would come back effectively empty.
      OCTOCODE_MCP_FULL_TEXT: 'true',
    },
  },
);

child.on('error', (err) => {
  console.error('Failed to spawn supergateway:', err.message);
  process.exit(1);
});

child.on('exit', (code, signal) => {
  console.error(`supergateway exited (code=${code}, signal=${signal}) — exiting so Cloud Run restarts the container`);
  process.exit(1);
});

// Poll until the MCP server's port is ready, then confirm
let probeCount = 0;
const probeInterval = setInterval(() => {
  probeCount++;
  const s = createConnection({ host: '127.0.0.1', port: Number(UPSTREAM_PORT) }, () => {
    console.log(`MCP server ready on port ${UPSTREAM_PORT} after ~${probeCount * 5}s`);
    s.end();
    clearInterval(probeInterval);
  });
  s.on('error', () => {
    console.log(`MCP server not yet on port ${UPSTREAM_PORT} (probe ${probeCount})`);
    if (probeCount >= 24) {
      console.error('MCP server never bound to port after 2 minutes — giving up');
      clearInterval(probeInterval);
      process.exit(1);
    }
  });
}, 5000);

// --- 2. Public gateway ----------------------------------------------------
const app = express();

const JWKS = createRemoteJWKSet(new URL(`${AUTHKIT_DOMAIN}/oauth2/jwks`));
const WWW_AUTHENTICATE = [
  'Bearer error="unauthorized"',
  'error_description="Authorization needed"',
  `resource_metadata="${RESOURCE_URL}/.well-known/oauth-protected-resource"`,
].join(', ');

// /health, not /healthz: Cloud Run's Google Front End reserves /healthz and
// answers it with its own 404 before the request ever reaches the container.
// /healthz is kept for local dev tooling that expects it.
app.get(['/health', '/healthz'], (_req, res) => res.status(200).send('ok'));
app.get('/favicon.ico', (_req, res) => res.status(204).end());

app.get('/.well-known/oauth-protected-resource', (_req, res) => {
  res.json({
    resource: RESOURCE_URL,
    authorization_servers: [AUTHKIT_DOMAIN],
    bearer_methods_supported: ['header'],
  });
});

app.get('/.well-known/oauth-authorization-server', async (_req, res) => {
  try {
    const r = await fetch(`${AUTHKIT_DOMAIN}/.well-known/oauth-authorization-server`);
    res.status(r.status).json(await r.json());
  } catch (e) {
    res.status(502).json({ error: 'Failed to fetch authorization server metadata.' });
  }
});

// --- 3. Bearer-token gate -------------------------------------------------
app.use(async (req, res, next) => {
  const token = req.headers.authorization?.match(/^Bearer (.+)$/)?.[1];
  if (!token) {
    return res.set('WWW-Authenticate', WWW_AUTHENTICATE).status(401).json({ error: 'No token provided.' });
  }
  try {
    await jwtVerify(token, JWKS, { issuer: AUTHKIT_DOMAIN, audience: VALID_AUDIENCES });
    return next();
  } catch (err) {
    try {
      const parts = token.split('.');
      if (parts.length === 3) {
        const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
        console.error('JWT validation failed:', err.message, '| claims:', JSON.stringify({ iss: claims.iss, aud: claims.aud, sub: claims.sub, exp: claims.exp }));
      }
    } catch (_) {}
    return res.set('WWW-Authenticate', WWW_AUTHENTICATE).status(401).json({ error: 'Invalid bearer token.' });
  }
});

// --- 4. Proxy authorized traffic to the internal MCP server ---------------
// MCP clients post to the base URL (/); rewrite root to /mcp where supergateway listens.
app.use(
  createProxyMiddleware({
    target: `http://127.0.0.1:${UPSTREAM_PORT}`,
    changeOrigin: true,
    ws: true,
    pathRewrite: { '^/$': '/mcp' },
    on: {
      // Supergateway answers requests that reference an unknown/expired MCP
      // session with 400, but the streamable-HTTP spec says 404 — and clients
      // (Claude) only transparently re-initialize on 404. Without this,
      // every container restart strands existing sessions on a hard error.
      proxyRes: (proxyRes, req) => {
        if (proxyRes.statusCode === 400 && req.headers['mcp-session-id']) {
          console.log('Rewriting stale-session 400 → 404 for client re-init');
          proxyRes.statusCode = 404;
        }
      },
      error: (err, req, res) => {
        console.error('Proxy error:', err.code, err.message);
        if (!res.headersSent) {
          res.status(502).json({ error: 'MCP upstream unavailable', detail: err.message });
        }
      },
    },
  }),
);

app.listen(PORT, () => {
  console.log(`MCP gateway listening on :${PORT} → upstream 127.0.0.1:${UPSTREAM_PORT}`);
});
