#!/usr/bin/env bash
# Applies database migrations, uploads secrets from an env file, and deploys all Edge Functions.
#
# Usage:  ./scripts/deploy.sh [env-file]
#         (env-file defaults to supabase/functions/.env)
#
# Prerequisite: `supabase login` and `supabase link --project-ref <ref>` (one-time).

set -euo pipefail
cd "$(dirname "$0")/.."

ENV_FILE="${1:-supabase/functions/.env}"

if ! command -v supabase >/dev/null 2>&1; then
  echo "Supabase CLI not found. Install it with: npm install -g supabase" >&2
  exit 1
fi

if [ ! -f "$ENV_FILE" ]; then
  echo "Env file not found: $ENV_FILE" >&2
  echo "Copy supabase/functions/.env.example to supabase/functions/.env and fill it in." >&2
  exit 1
fi

echo "==> Applying database migrations"
supabase db push

echo "==> Uploading secrets from $ENV_FILE"
supabase secrets set --env-file "$ENV_FILE"

echo "==> Deploying Edge Functions"
supabase functions deploy

echo "Done."
