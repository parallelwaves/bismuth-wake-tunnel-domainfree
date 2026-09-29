#!/usr/bin/env bash
# Deploys the Worker + static pages and sets its secrets.
#
#   bash deploy-cloudflare.sh
#
# Auth: either `wrangler login` (opens a browser) or set CLOUDFLARE_API_TOKEN
# (dash.cloudflare.com → My Profile → API Tokens → "Edit Cloudflare Workers").
# Discord isn't needed yet: add DISCORD_CLIENT_ID to wrangler.toml and the
# DISCORD_CLIENT_SECRET secret later, then run this again.
set -euo pipefail
cd "$(dirname "$0")/cloudflare"

command -v npx >/dev/null || { echo "✗ Install Node.js first (https://nodejs.org)."; exit 1; }
WR="npx --yes wrangler@latest"

if [ -z "${CLOUDFLARE_API_TOKEN:-}" ] && ! $WR whoami >/dev/null 2>&1; then
  $WR login
fi

echo "→ deploying Worker + pages"
$WR deploy

if [ -z "${GH_TOKEN:-}" ]; then
  read -rsp "Paste your GitHub classic token (codespace scope): " GH_TOKEN; echo
fi
[ -n "${GATEWAY_SECRET:-}" ] || GATEWAY_SECRET="$(openssl rand -hex 32)"

echo "→ setting secrets"
printf %s "$GH_TOKEN"        | $WR secret put GH_TOKEN
printf %s "$GATEWAY_SECRET"  | $WR secret put GATEWAY_SECRET

if [ -n "${DISCORD_CLIENT_SECRET:-}" ]; then
  printf %s "$DISCORD_CLIENT_SECRET" | $WR secret put DISCORD_CLIENT_SECRET
else
  echo "(skipping DISCORD_CLIENT_SECRET — set it later: npx wrangler secret put DISCORD_CLIENT_SECRET)"
fi

cat <<MSG

✓ Done. Put this SAME value in the Codespace (secret or .env):

    GATEWAY_SECRET=$GATEWAY_SECRET
    CS_CONTROL_TOKEN=<the same GitHub PAT you just gave the Worker>

Check it: open your Worker URL + /__bismuth/status
MSG
