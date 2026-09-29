#!/usr/bin/env bash
# scripts/quick-tunnel.sh — DOMAIN-FREE tunnel supervisor (started by autostart.sh).
#
#   1. runs `cloudflared tunnel --url http://127.0.0.1:3000` (a "quick tunnel":
#      no Cloudflare account, no domain; you get https://<random-words>.trycloudflare.com)
#   2. publishes <random-words> into THIS Codespace's display name ("bm-<words>")
#      through the GitHub API. The Cloudflare Worker reads it back from the same API.
#   3. if cloudflared ever exits, restarts it and publishes the new address.
#
# Needs CS_CONTROL_TOKEN (classic PAT, `codespace` scope; same one the Worker uses as
# GH_TOKEN) and CODESPACE_NAME (set automatically by GitHub). Always safe to re-run.
cd "$(dirname "$0")/.." || exit 0

PORT_NUM="${PORT:-3000}"
TLOG=/tmp/bismuth-tunnel.log
LOG=/tmp/bismuth-autostart.log
log() { echo "[quick-tunnel] $(date -u +%FT%TZ) $*" >>"$LOG"; }

dotenv_get() {
  [ -f .env ] || return 0
  grep -E "^$1=" .env | tail -n1 | cut -d= -f2- | sed -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'\$//"
}
secrets_get() {
  local f=/workspaces/.codespaces/shared/user-secrets-envs.json
  [ -f "$f" ] || return 0
  node -e 'try{const d=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const v=d[process.argv[2]];if(v)process.stdout.write(String(v))}catch(e){}' "$f" "$1" 2>/dev/null
}

TOKEN="${CS_CONTROL_TOKEN:-}"; [ -n "$TOKEN" ] || TOKEN="$(secrets_get CS_CONTROL_TOKEN)"; [ -n "$TOKEN" ] || TOKEN="$(dotenv_get CS_CONTROL_TOKEN)"
CS_NAME="${CODESPACE_NAME:-}"
if [ -z "$TOKEN" ] || [ -z "$CS_NAME" ]; then
  [ -n "$TOKEN" ] && have_t=yes || have_t=no
  [ -n "$CS_NAME" ] && have_n=yes || have_n=no
  log "cannot run: need CS_CONTROL_TOKEN (present: $have_t) and CODESPACE_NAME (present: $have_n)"
  exit 0
fi

publish() { # $1 = slug ; tries a few times
  local i
  for i in 1 2 3 4 5; do
    if curl -fsS -m 15 -X PATCH \
         -H "Authorization: Bearer $TOKEN" -H "Accept: application/vnd.github+json" \
         -H "X-GitHub-Api-Version: 2022-11-28" \
         "https://api.github.com/user/codespaces/${CS_NAME}" \
         -d "{\"display_name\":\"bm-$1\"}" >/dev/null 2>&1; then
      return 0
    fi
    sleep 3
  done
  return 1
}

while true; do
  : >"$TLOG"
  cloudflared tunnel --no-autoupdate --url "http://127.0.0.1:${PORT_NUM}" >>"$TLOG" 2>&1 &
  CF=$!

  url=""
  for _ in $(seq 1 90); do
    url="$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$TLOG" | grep -v '^https://api\.' | head -n1)"
    [ -n "$url" ] && break
    kill -0 "$CF" 2>/dev/null || break
    sleep 1
  done

  slug="${url#https://}"; slug="${slug%.trycloudflare.com}"
  if [ -z "$slug" ]; then
    log "no tunnel address yet — restarting cloudflared"
    kill "$CF" 2>/dev/null; sleep 5; continue
  fi
  # GitHub display names are capped at 48 chars; "bm-" + slug must fit.
  if [ "${#slug}" -gt 45 ]; then
    log "address '$slug' too long for a display name — asking for a new one"
    kill "$CF" 2>/dev/null; sleep 2; continue
  fi

  if publish "$slug"; then log "published https://${slug}.trycloudflare.com"
  else log "FAILED to publish the address to GitHub (check CS_CONTROL_TOKEN has the 'codespace' scope)"; fi

  wait "$CF"
  log "cloudflared exited — restarting in 5s"
  sleep 5
done
