# Self-hosting the Octocode MCP Server on Cloud Run with WorkOS Auth

A complete, copy-paste runbook for running the Octocode MCP server (GitHub code
research) fully in the cloud, protected by OAuth, so staff can connect Claude or
Gemini by pasting one URL and signing in with their Google Workspace account.

**Chosen architecture for this guide**

- **Auth:** WorkOS AuthKit (managed authorization server, free at internal scale)
- **Upstream:** GitHub API, authenticated with a single PAT (bot account recommended)
- **Bridge:** supergateway wraps the stdio-only `octocode-mcp` binary and exposes
  streamable HTTP on an internal port (never public)
- **Identity:** Google Workspace (users "Sign in with Google")
- **Hosting:** Google Cloud Run (one container: gateway + supergateway + octocode)

```
Claude / Gemini
   │  OAuth 2.1 + PKCE  → user signs in with Google Workspace
   ▼
WorkOS AuthKit  (managed authorization server: login, DCR/CIMD, token issuance)
   │  issues a signed JWT (aud = your Cloud Run URL)
   ▼
Cloud Run service  ── gateway :8080: publishes metadata, validates JWT
   │  (127.0.0.1:3000)
   ▼
supergateway  (streamable HTTP ⇄ stdio bridge, child process, never public)
   │  (stdio)
   ▼
octocode-mcp  (stdio MCP server)
   │  authenticates with GITHUB_TOKEN
   ▼
GitHub API
```

You stand this up once **per deployment target** (see below). After that,
onboarding a new person is "add connector → sign in," and off-boarding is
removing them from a Google Workspace group.

> **One caveat that differs from per-user setups:** every connected user acts
> as the *single* GitHub PAT baked into the deployment. Use a dedicated
> machine-user/bot PAT with minimal scopes (Phase 3), and only grant it access
> to what everyone should see.

---

## Deployment targets

This service is deployed to **two GCP projects**, each a fully independent
deployment:

| Target | GCP project | gcloud account | Config file |
|---|---|---|---|
| `wallyai` | `wallyai` | `bram@wally.be` | `.deploy.wallyai.env` |
| `active-tangent` | `active-tangent-337814` | _(different account — set `GCLOUD_ACCOUNT`)_ | `.deploy.active-tangent.env` |

Each target has its **own** Artifact Registry repo, Secret Manager secret
(`octocode-github-token` must be created in each project), runtime service
account (`mcp-runtime@<project>.iam.gserviceaccount.com`), WorkOS AuthKit
environment (a different `AUTHKIT_DOMAIN` per target), and Cloud Run service
URL. Nothing is shared between them.

**Phases 1–8 below must be done once per target** — each project needs its own
secret, service-account binding, image build, deploy, WorkOS environment, and
`MCP_WORKOS_CLIENT_ID`.

Current state:

- **wallyai** — the `octocode-github-token` secret, the `mcp-runtime` service
  account, and the `mcp` Artifact Registry repo already exist; the secret→SA
  IAM binding has **not** been granted yet (do Phase 3c's binding step).
- **active-tangent-337814** — nothing has been created yet; start from Phase 1.

---

## Before you start

You need:

- A Google Cloud project with billing enabled, and the `gcloud` CLI installed
  **on your machine** (only you, the admin, need it — end users never touch it).
- Owner/Editor on that project (or the specific IAM roles for Cloud Run,
  Artifact Registry, and Secret Manager).
- A GitHub account you can mint a PAT from — ideally a dedicated bot/machine
  user with access to the repos you want researchable.
- A WorkOS account (free): https://dashboard.workos.com
- The gateway code in this folder (`server.js`, `package.json`, `Dockerfile`,
  `.dockerignore`, `deploy.sh`).

Pick a target and configure its `.deploy.<target>.env` once; every phase below
reads from it. Set `TARGET` and source the env file at the start of a session
so the raw `gcloud` commands below stay copy-pasteable:

```bash
TARGET=wallyai   # or: active-tangent
cp .deploy.env.example .deploy.$TARGET.env   # first time only — then edit the values
# Load the values into your shell for the manual commands:
source .deploy.$TARGET.env
export IMAGE="$REGION-docker.pkg.dev/$PROJECT_ID/$REPO/octocode-mcp-gateway"

gcloud config set project "$PROJECT_ID"
```

If a target's project lives under a different Google account, set
`GCLOUD_ACCOUNT` in its env file — `deploy.sh` then runs every gcloud call with
`--account=$GCLOUD_ACCOUNT`. The manual gcloud commands below include
`${GCLOUD_ACCOUNT:+--account=$GCLOUD_ACCOUNT}`, which expands to nothing when
the variable is unset, so they work as-is either way.

---

## Phase 1 — GCP project prerequisites

Enable the required APIs (once per target project):

```bash
gcloud services enable ${GCLOUD_ACCOUNT:+--account=$GCLOUD_ACCOUNT} \
  --project="$PROJECT_ID" \
  run.googleapis.com \
  artifactregistry.googleapis.com \
  secretmanager.googleapis.com \
  cloudbuild.googleapis.com
```

---

## Phase 2 — Artifact Registry repository

Create the Docker repo that will hold the gateway image (once per target
project — already done for `wallyai`, where the `mcp` repo exists; still needed
for `active-tangent-337814`):

```bash
gcloud artifacts repositories create "$REPO" \
  ${GCLOUD_ACCOUNT:+--account=$GCLOUD_ACCOUNT} \
  --repository-format=docker --location="$REGION" --project="$PROJECT_ID"
```

---

## Phase 3 — GitHub PAT, secret, and runtime service account

### 3a. Create the GitHub PAT

Use a **dedicated bot/machine account** if at all possible — every connected
user will act as this identity on GitHub, so a personal token means everyone
researches as *you*.

1. Sign in as the bot account → **Settings → Developer settings →
   Personal access tokens → Tokens (classic) → Generate new token (classic)**.

   > **Classic, not fine-grained.** GitHub's default token page nowadays is
   > "Fine-grained tokens", which shows *permissions* (Actions,
   > Administration, …) instead of *scopes* — that's the wrong page. Octocode's
   > docs specify classic scopes, and fine-grained tokens are limited to a
   > single resource owner and have gaps with GitHub's search APIs that
   > octocode relies on. If your org mandates fine-grained tokens, the closest
   > equivalent is: Repository access "All repositories", Repository
   > permissions Contents: Read-only + Metadata: Read-only, Organization
   > permissions Members: Read-only — but test `ghSearchCode` before rolling
   > it out.

2. Scopes: **`repo`**, **`read:user`**, **`read:org`**. Nothing else.
3. Set an expiry you're comfortable rotating on (rotation is two commands, see
   Operations below).
4. Grant the bot account access to the repos/orgs you want researchable — its
   access *is* the access boundary for every connected user.

### 3b. Store it in Secret Manager

Never bake credentials into the image or pass them as CLI args. The secret must
be created in **each target project** (already done for `wallyai`; still needed
for `active-tangent-337814`):

```bash
printf '%s' 'ghp_XXXXXXXXXXXXXXXXXXXX' \
  | gcloud secrets create "$SECRET_NAME" ${GCLOUD_ACCOUNT:+--account=$GCLOUD_ACCOUNT} \
      --data-file=- --project="$PROJECT_ID"
```

### 3c. Create the runtime service account and grant it access

We use a dedicated, least-privilege service account, one per target project
(already created in `wallyai`; still needed in `active-tangent-337814`):

```bash
gcloud iam service-accounts create mcp-runtime \
  ${GCLOUD_ACCOUNT:+--account=$GCLOUD_ACCOUNT} \
  --display-name="Octocode MCP Cloud Run runtime" --project="$PROJECT_ID"

# RUNTIME_SA in .deploy.<target>.env should be:
#   mcp-runtime@$PROJECT_ID.iam.gserviceaccount.com
```

Then grant it access to the secret. This binding is **not yet granted in
`wallyai`** (the secret and SA exist there, but not the binding), and needed in
`active-tangent-337814` too once created:

```bash
gcloud secrets add-iam-policy-binding "$SECRET_NAME" \
  ${GCLOUD_ACCOUNT:+--account=$GCLOUD_ACCOUNT} \
  --member="serviceAccount:$RUNTIME_SA" \
  --role="roles/secretmanager.secretAccessor" --project="$PROJECT_ID"
```

(If the service account already exists from another MCP deployment in the same
project — e.g. the MongoDB gateway — skip creation and just add the secret
binding.)

---

## Phase 4 — Build and push the gateway image

Each target has its own registry, so build once per target:

```bash
./deploy.sh "$TARGET" build
# equivalent to: gcloud builds submit --tag "$IMAGE" --project "$PROJECT_ID"
```

No local Docker needed — the build runs in Cloud Build. The image bundles the
gateway, supergateway, and `@octocodeai/mcp` (`npm install` at build time).

---

## Phase 5 — Deploy to Cloud Run (first pass)

The gateway needs its own public URL as the OAuth `resource` value, but you only
learn that URL after the first deploy — so we deploy once with placeholders,
read the URL, then redeploy in Phase 7.

```bash
./deploy.sh "$TARGET" deploy

# Capture the real service URL (each target has its own)
export SERVICE_URL=$(./deploy.sh "$TARGET" url)
echo "$SERVICE_URL"
```

Notes on the flags `deploy.sh` sets, and why they matter for MCP:

- `--allow-unauthenticated` is correct here. Auth is **not** open — it's enforced
  inside the gateway via OAuth/JWT. (Cloud Run IAM can't do the MCP OAuth
  handshake; that's exactly why we run our own gateway.)
- `--session-affinity` + `--min/max-instances=1` keep each client's MCP session
  pinned to one instance — supergateway holds streamable-HTTP session state in
  memory — and an always-on instance avoids child-spawn cold starts.
- `--timeout=3600` allows long-lived streaming responses.
- `--set-secrets="GITHUB_TOKEN=$SECRET_NAME:latest"` injects the PAT; the
  gateway passes it through to the octocode child process.

---

## Phase 6 — Configure WorkOS AuthKit

Each target has its **own WorkOS AuthKit environment** with its own AuthKit
domain — do this phase once per target, in that target's environment.

In the WorkOS Dashboard (https://dashboard.workos.com):

1. **Find your AuthKit domain.** It looks like `https://your-app.authkit.app`
   (Dashboard → *AuthKit* → *Domains*, or your custom domain). Save it:

   ```bash
   export AUTHKIT_DOMAIN="https://your-app.authkit.app"
   ```

2. **Enable Google as the login method.** Dashboard → *AuthKit* →
   *Authentication* → enable **Google OAuth** (so users see "Sign in with
   Google"). To restrict to your company only, either configure a Google
   Workspace **Enterprise SSO** connection, or enforce allowed email domains in
   AuthKit settings. (Social Google login is free; an Enterprise SSO connection
   is the paid option if you require strict SAML/OIDC federation.)

3. **Enable client self-identification.** Dashboard → *Connect* →
   *Configuration* → turn on **Client ID Metadata Document (CIMD)**, and also
   enable **Dynamic Client Registration (DCR)** for backwards compatibility.
   This is what lets Claude/Gemini register themselves with no manual client
   setup.

4. **Add your Cloud Run URL as a Resource Indicator.** Dashboard → *Connect* →
   *Configuration* → **Resource Indicators** → add the value of `$SERVICE_URL`
   (e.g. `https://octocode-mcp-xxxx.a.run.app`). This makes AuthKit mint tokens
   whose `aud` matches your gateway, which the gateway then verifies.

---

## Phase 7 — Redeploy with the real values

Now that you have both `$SERVICE_URL` and `$AUTHKIT_DOMAIN`, set them for real:

```bash
./deploy.sh "$TARGET" redeploy "$AUTHKIT_DOMAIN" "$SERVICE_URL"
```

The script verifies the public metadata is being served correctly:

```bash
curl -s "$SERVICE_URL/.well-known/oauth-protected-resource" | jq
# Expect: { "resource": "<SERVICE_URL>", "authorization_servers": ["<AUTHKIT_DOMAIN>"], ... }

curl -s -o /dev/null -w "%{http_code}\n" "$SERVICE_URL/"
# Expect: 401  (gateway correctly demands a token for MCP traffic)
```

### 7b — Set `MCP_WORKOS_CLIENT_ID` (after the first client connects)

Claude's MCP client sets the JWT `aud` claim to its DCR client ID rather than
the resource URL. The first connection attempt will therefore fail audience
validation — on purpose, and the gateway logs the decoded claims so you can
discover the client ID. Check the logs for a line like:

```
JWT validation failed: unexpected "aud" claim value | claims: {"aud":"client_01XXXXX..."}
```

```bash
gcloud run services logs read "$SERVICE" ${GCLOUD_ACCOUNT:+--account=$GCLOUD_ACCOUNT} \
  --region="$REGION" --project="$PROJECT_ID" --limit=50
```

Copy the `client_01XXXXX...` value and set it as an env var — the gateway then
accepts it as a second valid audience. Do this per target: each WorkOS
environment issues its own client ID, so the value differs per deployment:

```bash
gcloud run services update "$SERVICE" \
  ${GCLOUD_ACCOUNT:+--account=$GCLOUD_ACCOUNT} \
  --region="$REGION" --project="$PROJECT_ID" \
  --update-env-vars="MCP_WORKOS_CLIENT_ID=client_01XXXXX..."
```

Reconnect from Claude; the token should now validate.

---

## Phase 8 — Connect the AI clients (what end users do)

The connector URL you hand out is simply `$SERVICE_URL`.

**Claude — Team/Enterprise (admin pushes it to everyone)**
1. Admin → **Settings → Connectors** (Organization) → **Add custom connector**.
2. Name: `Octocode`. Remote MCP server URL: paste `$SERVICE_URL`.
3. Save and enable org-wide. Users then just toggle it on and click **Connect →
   Sign in with Google**.

**Claude — Pro/individual**
1. **Settings → Connectors → Add custom connector**.
2. Paste `$SERVICE_URL`, click **Connect**, sign in with Google. Done.

**Gemini Enterprise / Agentspace**
1. Admin registers a new connector / MCP tool with the same `$SERVICE_URL`.
2. It inherits Google Workspace SSO; users authorize on first use.

**Functional test.** In Claude, after connecting, ask: "Search GitHub for how
express implements router param handling." You should see the `ghSearchCode` /
`ghGetFileContent` tools run and return real code. Available tools:
`ghSearchCode`, `ghGetFileContent`, `ghViewRepoStructure`, `ghSearchRepos`,
`ghHistoryResearch`, `npmSearch`, `oqlSearch`.

---

## Phase 9 — Operations

### Rotate the GitHub PAT

Each target project has its own copy of the secret, so rotate in every target.
Mint a new PAT on the bot account (same scopes: `repo`, `read:user`,
`read:org`), then per target:

```bash
printf '%s' 'ghp_NEW_TOKEN' \
  | gcloud secrets versions add "$SECRET_NAME" ${GCLOUD_ACCOUNT:+--account=$GCLOUD_ACCOUNT} \
      --data-file=- --project="$PROJECT_ID"
./deploy.sh "$TARGET" push   # new revision picks up :latest
```

Revoke the old PAT on GitHub after confirming the new revision is serving.

### Update the octocode version (or gateway code)

The Dockerfile installs `@octocodeai/mcp` at build time, so a rebuild picks up
the newest version matching the range in `package.json`. Run for each target
you want updated:

```bash
./deploy.sh "$TARGET" build && ./deploy.sh "$TARGET" push
```

Pin an exact version in `package.json` if you prefer controlled upgrades.

### Logs

```bash
gcloud run services logs read "$SERVICE" ${GCLOUD_ACCOUNT:+--account=$GCLOUD_ACCOUNT} \
  --region="$REGION" --project="$PROJECT_ID" --limit=100
# or tail:
gcloud beta run services logs tail "$SERVICE" ${GCLOUD_ACCOUNT:+--account=$GCLOUD_ACCOUNT} \
  --region="$REGION" --project="$PROJECT_ID"
```

Supergateway and octocode inherit stdio, so their output lands in the same
Cloud Run log stream as the gateway.

### Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `502` JSON from the gateway | supergateway/octocode child not (yet) listening on `UPSTREAM_PORT`, or it crashed | Check logs for child-process output; the gateway exits (and Cloud Run restarts it) if the child dies or never binds within 2 minutes. A crash loop usually means a bad `GITHUB_TOKEN` or a broken octocode release — roll back with a previous image. |
| `401` with `unexpected "aud" claim value` | `MCP_WORKOS_CLIENT_ID` not set, or Resource Indicator missing/mismatched in WorkOS | Do Phase 7b; verify the Resource Indicator exactly equals `$SERVICE_URL`. |
| Claude errors `state: Field required` at connect time (never reaches the sign-in screen) | The service URL is not registered as a Resource Indicator in *this target's* WorkOS environment, so the authorize request bounces back to Claude's callback without `state` | WorkOS Dashboard → Connect → Configuration → Resource Indicators → add `$SERVICE_URL`, then delete and re-add the connector in Claude. |
| Claude never redirects to WorkOS at all, or errors immediately after adding the connector | Connector was added while the service still advertised placeholder auth values — Claude caches OAuth discovery at add-time | Delete the connector entirely and re-add it (use the exact `$SERVICE_URL` from `./deploy.sh <target> url`, not the numeric `run.app` variant). |
| Every tool returns a `structuredContent available` stub or `Error occurred during tool execution` after a deploy | Former: `OCTOCODE_MCP_FULL_TEXT` not set (the gateway hardcodes it). Latter: the restart invalidated the MCP session; the gateway rewrites supergateway's stale-session `400` to `404` so Claude re-inits | Start a new Claude conversation; if it persists, check gateway logs for the `400 → 404` rewrite line. |
| `401` with `issuer` mismatch or JWKS errors | `AUTHKIT_DOMAIN` wrong or still a placeholder (each target has its own domain — check you set the right one) | Re-run `./deploy.sh <target> redeploy` with the correct domain. |
| Tools run but GitHub calls fail with `403` / rate-limit errors | PAT lacks scopes, lost repo access, or the shared PAT hit GitHub's rate limit (all users share one identity's quota) | Check the PAT's scopes and org access; wait out the rate-limit window; consider narrowing usage or `REQUEST_TIMEOUT`/`MAX_RETRIES` tuning. |
| Sessions drop mid-conversation | More than one instance, or affinity disabled | Keep `--session-affinity --min-instances=1 --max-instances=1`. |

### Security checklist

- [ ] PAT belongs to a dedicated bot account with minimal scopes (`repo`,
      `read:user`, `read:org`) and only the intended repo access.
- [ ] PAT is in Secret Manager, not env files or args.
- [ ] Runtime service account is dedicated and only has `secretAccessor`.
- [ ] Resource Indicator in WorkOS exactly equals `$SERVICE_URL`.
- [ ] Google login is restricted to your company (Enterprise SSO connection or
      allowed-domain enforcement), so only employees can authenticate.
- [ ] Everyone understands the single-GitHub-identity model: all users share
      the bot's access and audit trail.

---

## Cost summary

- **WorkOS AuthKit:** free up to 1M monthly active users; Google social login
  included. (Only a formal Enterprise SSO connection costs anything — optional.)
- **Cloud Run:** one always-on small instance per target plus minimal traffic —
  on the order of a few dollars a month each.
- **Secret Manager / Artifact Registry:** negligible.
- **GitHub:** free — API usage is covered by the PAT's rate limits.

Effectively a near-zero monthly bill for an internal tool, with no auth server to
operate yourself.
