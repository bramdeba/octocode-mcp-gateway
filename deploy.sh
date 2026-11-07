#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# This service is deployed to multiple GCP projects, each with its own
# Artifact Registry repo and WorkOS setup. Every command therefore takes a
# deployment target as its first argument; config is read from
# .deploy.<target>.env (copy .deploy.env.example).
TARGET="${1:-}"

usage() {
  echo "Usage: ./deploy.sh <target> <command>"
  echo ""
  echo "Targets (one .deploy.<target>.env file per deployment):"
  for f in "$SCRIPT_DIR"/.deploy.*.env; do
    [[ -e "$f" ]] || continue
    t="$(basename "$f")"; t="${t#.deploy.}"; t="${t%.env}"
    echo "  $t"
  done
  echo ""
  echo "Commands:"
  echo "  build                              Build & push the Docker image"
  echo "  deploy                             First-time deploy only (resets to placeholder env vars)"
  echo "  push                               Deploy new image without touching env vars (use this for updates)"
  echo "  redeploy <authkit-domain> <url>    Phase 7: set real WorkOS + service URL"
  echo "  url                                Print the current service URL"
  echo ""
  echo "Example: ./deploy.sh wallyai build"
}

if [[ -z "$TARGET" || "$TARGET" == "help" ]]; then
  usage
  exit 0
fi

ENV_FILE="$SCRIPT_DIR/.deploy.$TARGET.env"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Error: $ENV_FILE not found."
  echo "Copy .deploy.env.example to .deploy.$TARGET.env and fill in your values."
  echo ""
  usage
  exit 1
fi

# shellcheck source=.deploy.env.example
source "$ENV_FILE"

: "${PROJECT_ID:?PROJECT_ID must be set in $ENV_FILE}"
: "${REGION:?REGION must be set in $ENV_FILE}"
: "${SERVICE:?SERVICE must be set in $ENV_FILE}"
: "${REPO:?REPO must be set in $ENV_FILE}"
: "${RUNTIME_SA:?RUNTIME_SA must be set in $ENV_FILE}"
: "${SECRET_NAME:?SECRET_NAME must be set in $ENV_FILE}"
# Optional: gcloud account to run commands as (projects may live under
# different Google accounts). Leave unset to use the active gcloud account.
GCLOUD_ACCOUNT="${GCLOUD_ACCOUNT:-}"

GCLOUD=(gcloud)
if [[ -n "$GCLOUD_ACCOUNT" ]]; then
  GCLOUD+=(--account="$GCLOUD_ACCOUNT")
fi

IMAGE="$REGION-docker.pkg.dev/$PROJECT_ID/$REPO/octocode-mcp-gateway"

CMD="${2:-help}"

case "$CMD" in
  build)
    echo "[$TARGET] Building and pushing image..."
    "${GCLOUD[@]}" builds submit --tag "$IMAGE" --project "$PROJECT_ID" \
      --region "$REGION" --default-buckets-behavior=regional-user-owned-bucket
    ;;

  deploy)
    echo "[$TARGET] First-time deploy to Cloud Run (placeholder auth values — run 'redeploy' after WorkOS setup)..."
    "${GCLOUD[@]}" run deploy "$SERVICE" \
      --image="$IMAGE" \
      --region="$REGION" \
      --project="$PROJECT_ID" \
      --service-account="$RUNTIME_SA" \
      --allow-unauthenticated \
      --port=8080 \
      --set-secrets="GITHUB_TOKEN=$SECRET_NAME:latest" \
      --set-env-vars="AUTHKIT_DOMAIN=https://placeholder,MCP_RESOURCE_URL=https://placeholder" \
      --session-affinity \
      --min-instances=1 --max-instances=1 \
      --timeout=3600
    echo ""
    echo "Service URL:"
    "${GCLOUD[@]}" run services describe "$SERVICE" --region="$REGION" --project="$PROJECT_ID" --format="value(status.url)"
    ;;

  push)
    # Deploy a new image without touching env vars or other config.
    # Use this for all updates after the initial deploy + redeploy.
    echo "[$TARGET] Pushing new image to Cloud Run (config unchanged)..."
    "${GCLOUD[@]}" run deploy "$SERVICE" \
      --image="$IMAGE" \
      --region="$REGION" \
      --project="$PROJECT_ID"
    ;;

  redeploy)
    # Phase 7: set real AUTHKIT_DOMAIN and SERVICE_URL after WorkOS is configured.
    # Each target has its own WorkOS environment, so the AuthKit domain differs
    # per deployment. Usage: ./deploy.sh <target> redeploy <authkit-domain> <service-url>
    AUTHKIT_DOMAIN="${3:?Usage: ./deploy.sh $TARGET redeploy <authkit-domain> <service-url>}"
    SERVICE_URL="${4:?Usage: ./deploy.sh $TARGET redeploy <authkit-domain> <service-url>}"
    echo "[$TARGET] Updating env vars on Cloud Run service..."
    "${GCLOUD[@]}" run services update "$SERVICE" \
      --region="$REGION" \
      --project="$PROJECT_ID" \
      --update-env-vars="AUTHKIT_DOMAIN=$AUTHKIT_DOMAIN,MCP_RESOURCE_URL=$SERVICE_URL"
    echo "Done. Verifying metadata endpoint..."
    curl -s "$SERVICE_URL/.well-known/oauth-protected-resource" | python3 -m json.tool
    echo ""
    echo "Root should return 401:"
    curl -s -o /dev/null -w "HTTP %{http_code}\n" "$SERVICE_URL/"
    ;;

  url)
    "${GCLOUD[@]}" run services describe "$SERVICE" --region="$REGION" --project="$PROJECT_ID" --format="value(status.url)"
    ;;

  *)
    usage
    ;;
esac
