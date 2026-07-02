# Octocode MCP Gateway

OAuth-protected Cloud Run gateway in front of the [Octocode MCP server](https://www.npmjs.com/package/@octocodeai/mcp) (GitHub code research). Users connect Claude or Gemini by pasting one URL and signing in with their Google Workspace account.

**Architecture:** WorkOS AuthKit issues JWTs → gateway validates them → proxies to a private supergateway + octocode-mcp process → GitHub API.

```
Claude / Gemini
   │  OAuth 2.1 + PKCE  → user signs in with Google Workspace
   ▼
WorkOS AuthKit  (managed authorization server: login, DCR/CIMD, token issuance)
   │  issues a signed JWT
   ▼
Cloud Run service
   ├── gateway :8080  (Express — publishes OAuth metadata, validates JWT, proxies)
   │      │  (127.0.0.1, never public)
   │      ▼
   ├── supergateway :3000  (streamable HTTP ⇄ stdio bridge, child process)
   │      │  (stdio)
   │      ▼
   └── octocode-mcp  (stdio MCP server, @octocodeai/mcp)
          │  GITHUB_TOKEN (PAT from Secret Manager)
          ▼
       GitHub API
```

Octocode is **stdio-only**, so unlike the MongoDB gateway (which runs an in-process
HTTP runner) this container runs [supergateway](https://www.npmjs.com/package/supergateway)
as a child process to wrap the stdio binary and expose streamable HTTP on an
internal port (`UPSTREAM_PORT`, default 3000). The Express gateway on `:8080` is
the only thing exposed publicly.

---

## Quickstart

The service is deployed to **two independent targets** — `wallyai` (project
`wallyai`) and `active-tangent` (project `active-tangent-337814`) — each with
its own registry, secret, service account, WorkOS environment, and service URL.
See `RUNBOOK.md` ("Deployment targets") for what differs between them.

```bash
cp .deploy.env.example .deploy.wallyai.env   # one env file per target — fill in your values
./deploy.sh wallyai build                    # build & push the image (Cloud Build)
./deploy.sh wallyai deploy                   # first-time deploy (placeholder auth values)
# ... configure WorkOS AuthKit (RUNBOOK.md Phase 6) ...
./deploy.sh wallyai redeploy https://your-app.authkit.app https://octocode-mcp-xxxx.a.run.app
```

First-time setup (GCP project, GitHub PAT, secret, WorkOS) is covered step by
step in `RUNBOOK.md` — once per target.

`.deploy.<target>.env` fields:

| Field | Description |
|---|---|
| `PROJECT_ID` | GCP project ID |
| `REGION` | GCP region (e.g. `europe-west1`) |
| `SERVICE` | Cloud Run service name (default `octocode-mcp`) |
| `REPO` | Artifact Registry repository name (default `mcp`) |
| `RUNTIME_SA` | Runtime service account email |
| `SECRET_NAME` | Secret Manager secret holding the GitHub PAT (default `octocode-github-token`) |
| `GCLOUD_ACCOUNT` | _(optional)_ gcloud account with access to this target's project — when set, every gcloud call runs with `--account=` |

`.deploy.*.env` files are gitignored — never commit them.

---

## Prerequisites

- `gcloud` CLI authenticated with access to the target GCP project (each target
  may live under a different Google account — set `GCLOUD_ACCOUNT` in that
  target's env file)
- A GitHub personal access token stored in Secret Manager under `$SECRET_NAME`
  (scopes: `repo`, `read:user`, `read:org`) — one secret per target project
- WorkOS account at [dashboard.workos.com](https://dashboard.workos.com) — one
  AuthKit environment per target

---

## deploy.sh

All deployment operations go through `./deploy.sh <target> <command>`. Running `./deploy.sh` with no arguments lists the available targets and commands.

Configuration is read from `.deploy.<target>.env` at the repo root (copy `.deploy.env.example`). The script fails with a clear error if the file is missing.

### `build`

Rebuilds the Docker image in Cloud Build and pushes it to the target's Artifact Registry.

```bash
./deploy.sh wallyai build
```

Run this after changing `server.js`, `package.json`, or `Dockerfile` — or to pick
up a new `@octocodeai/mcp` version.

### `deploy`

**First-time only.** Creates the Cloud Run service with placeholder auth values. Prints the service URL when done. Run `redeploy` immediately after to set real values.

```bash
./deploy.sh wallyai deploy
```

### `push`

Deploys a new image without touching env vars or other config. Use this for all updates after the initial setup.

```bash
./deploy.sh wallyai build && ./deploy.sh wallyai push
```

### `redeploy`

Phase 7 of the setup — sets the real WorkOS AuthKit domain and service URL on the running service. Run this after configuring WorkOS (see RUNBOOK.md Phase 6). Each target has its own WorkOS environment, so the AuthKit domain differs per target.

```bash
./deploy.sh <target> redeploy <authkit-domain> <service-url>

# Example:
./deploy.sh active-tangent redeploy https://your-app.authkit.app https://octocode-mcp-xxxx-ew.a.run.app
```

Also verifies the setup by hitting `/.well-known/oauth-protected-resource` (should return JSON) and `/` (should return `HTTP 401`).

After a user first connects Claude, check Cloud Run logs for a line like:

```
JWT validation failed: unexpected "aud" claim value | claims: {"aud":"client_01XXXXX..."}
```

Copy that `client_XXXXX` value and set it as a Cloud Run env var so the gateway can validate the audience claim (after `source .deploy.<target>.env` — client IDs differ per target since each has its own WorkOS environment):

```bash
gcloud run services update "$SERVICE" \
  ${GCLOUD_ACCOUNT:+--account=$GCLOUD_ACCOUNT} \
  --region="$REGION" --project="$PROJECT_ID" \
  --update-env-vars="MCP_WORKOS_CLIENT_ID=client_01XXXXX..."
```

Claude's MCP client sets `aud` to its DCR client ID rather than the resource URL, so this step is required to enable proper audience validation.

### `url`

Prints the current Cloud Run service URL for a target.

```bash
./deploy.sh wallyai url
```

---

## Connecting a client

The connector URL you hand out is simply the Cloud Run service URL of the relevant target (`./deploy.sh <target> url`) — each target has its own URL.

**Claude — Team/Enterprise (admin pushes it to everyone)**
1. Admin → **Settings → Connectors** (Organization) → **Add custom connector**.
2. Name: `Octocode`. Remote MCP server URL: paste the service URL.
3. Save and enable org-wide. Users toggle it on and click **Connect → Sign in
   with Google**.

**Claude — Pro/individual**
1. **Settings → Connectors → Add custom connector**.
2. Paste the service URL, click **Connect**, sign in with Google. Done.

**Gemini Enterprise / Agentspace**
1. Admin registers a new connector / MCP tool with the same service URL.
2. It inherits Google Workspace SSO; users authorize on first use.

Nothing is installed locally.

---

## Single GitHub identity (important caveat)

Every connected user acts as **the one GitHub PAT** stored in Secret Manager —
the gateway authenticates *people* via WorkOS, but octocode talks to GitHub as
a single identity. All GitHub-side audit logs, rate limits, and repo access are
shared.

**Use a dedicated machine-user / bot account PAT with minimal scopes**, not a
personal token. Only grant the bot access to the repos/orgs you want every
connected user to be able to research.

---

## Available tools

With `ENABLE_LOCAL=false` (hardcoded — the container has no useful local
filesystem), octocode exposes:

| Tool | Purpose |
|---|---|
| `ghSearchCode` | Search code across GitHub repositories |
| `ghGetFileContent` | Fetch file contents (full, ranges, or pattern-matched) |
| `ghViewRepoStructure` | Explore a repository's directory tree |
| `ghSearchRepos` | Discover repositories by topic/name/stars |
| `ghHistoryResearch` | Research commit/PR history and code evolution |
| `npmSearch` | Search and inspect npm packages |
| `oqlSearch` | Octocode query language search |

`local*` tools and `lspGetSemantics` are disabled via `ENABLE_LOCAL=false`;
`ghCloneRepo` is off by default upstream.

---

## Configuration reference

Set on the Cloud Run service (gateway process):

| Var | Default | Purpose |
|---|---|---|
| `PORT` | `8080` | Public gateway port (set by Cloud Run) |
| `UPSTREAM_PORT` | `3000` | Internal supergateway port, never exposed publicly |
| `AUTHKIT_DOMAIN` | _(required)_ | WorkOS AuthKit domain, e.g. `https://your-app.authkit.app` |
| `MCP_RESOURCE_URL` | _(required)_ | The public Cloud Run service URL (OAuth resource / `aud`) |
| `MCP_WORKOS_CLIENT_ID` | _(optional)_ | Claude's DCR client ID, accepted as a second valid `aud` |
| `GITHUB_TOKEN` | _(required, from Secret Manager)_ | GitHub PAT passed to the octocode child process |

Passed through to the octocode child process (env vars take precedence over
`~/.octocode/.octocoderc` over defaults):

| Var | Default | Purpose |
|---|---|---|
| `GITHUB_TOKEN` | _(from Secret Manager)_ | GitHub authentication |
| `GITHUB_API_URL` | `https://api.github.com` | Override for GitHub Enterprise |
| `ENABLE_LOCAL` | `false` _(hardcoded)_ | Local-filesystem tools — always off in the container |
| `OCTOCODE_HOME` | `/tmp/.octocode` _(hardcoded)_ | Octocode state dir — `/tmp` is the only writable path on Cloud Run |
| `DISABLE_TOOLS` / `ENABLE_TOOLS` / `TOOLS_TO_RUN` | _(unset)_ | Fine-grained tool selection |
| `REQUEST_TIMEOUT` | octocode default | GitHub request timeout |
| `MAX_RETRIES` | octocode default | GitHub request retries |

To set optional octocode vars, use `gcloud run services update ... --update-env-vars=...`
(the gateway forwards them to the child).

> **Single instance required.** Supergateway keeps streamable-HTTP session state
> in memory per instance, so `deploy.sh` pins the service with
> `--session-affinity --min-instances=1 --max-instances=1` (which also avoids
> cold-start child-spawn latency). Keep it that way.
