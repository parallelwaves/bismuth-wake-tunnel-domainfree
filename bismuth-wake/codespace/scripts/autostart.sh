#!/usr/bin/env bash
# scripts/autostart.sh — runs on EVERY Codespace start (devcontainer postStartCommand).
#   1. starts the Bismuth server if it isn't already running
#   2. starts cloudflared (Cloudflare Tunnel): an OUTBOUND connection to Cloudflare,
#      so GitHub's port-visibility (Public/Private) is never involved.
#      No domain? Leave TUNNEL_TOKEN unset: a free quick tunnel is used and its address is
#      handed to the Worker automatically (see scripts/quick-tunnel.sh). Needs CS_CONTROL_TOKEN.
#      Own a domain? Set TUNNEL_TOKEN for a fixed named tunnel instead.
# Always exits 0. Read /tmp/bismuth-autostart.log and /tmp/bismuth-tunnel.log to debug.

cd "$(dirname "$0")/.." || exit 0

PORT_NUM="${PORT:-3000}"
LOG=/tmp/bismuth-autostart.log
TLOG=/tmp/bismuth-tunnel.log
log() { echo "[autostart] $(date -u +%FT%TZ) $*" >>"$LOG"; }

dotenv_get() {
  [ -f .env ] || return 0
  grep -E "^$1=" .env | tail -n1 | cut -d= -f2- | sed -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'\$//"
}
# Codespaces secrets may not be in a lifecycle command's environment; read the file too.
secrets_get() {
  local f=/workspaces/.codespaces/shared/user-secrets-envs.json
  [ -f "$f" ] || return 0
  node -e 'try{const d=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const v=d[process.argv[2]];if(v)process.stdout.write(String(v))}catch(e){}' "$f" "$1" 2>/dev/null
}

TUNNEL_TOKEN="${TUNNEL_TOKEN:-}"
[ -n "$TUNNEL_TOKEN" ] || TUNNEL_TOKEN="$(secrets_get TUNNEL_TOKEN)"
[ -n "$TUNNEL_TOKEN" ] || TUNNEL_TOKEN="$(dotenv_get TUNNEL_TOKEN)"

log "=== codespace start (port=$PORT_NUM) ==="

# 1) app
if curl -fsS -m 2 "http://127.0.0.1:${PORT_NUM}/api/status" >/dev/null 2>&1; then
  log "bismuth already running"
else
  [ -d node_modules ] || npm install --no-audit --no-fund >>"$LOG" 2>&1
  setsid nohup npm start >>"$LOG" 2>&1 </dev/null &
  log "started bismuth"
fi

# 2) tunnel
#    - TUNNEL_TOKEN set  -> named tunnel (needs a domain on Cloudflare; fixed hostname)
#    - otherwise         -> domain-free quick tunnel (scripts/quick-tunnel.sh), needs CS_CONTROL_TOKEN
CS_TOKEN="${CS_CONTROL_TOKEN:-}"
[ -n "$CS_TOKEN" ] || CS_TOKEN="$(secrets_get CS_CONTROL_TOKEN)"
[ -n "$CS_TOKEN" ] || CS_TOKEN="$(dotenv_get CS_CONTROL_TOKEN)"

if [ -z "$TUNNEL_TOKEN" ] && [ -z "$CS_TOKEN" ]; then
  log "SKIPPED tunnel: set CS_CONTROL_TOKEN (domain-free quick tunnel) or TUNNEL_TOKEN (named tunnel)"
  exit 0
fi

if ! command -v cloudflared >/dev/null 2>&1; then
  log "installing cloudflared"
  arch="$(uname -m)"; case "$arch" in aarch64|arm64) bin=cloudflared-linux-arm64 ;; *) bin=cloudflared-linux-amd64 ;; esac
  if sudo curl -fsSL -o /usr/local/bin/cloudflared "https://github.com/cloudflare/cloudflared/releases/latest/download/$bin" >>"$LOG" 2>&1 \
     && sudo chmod +x /usr/local/bin/cloudflared; then
    log "cloudflared installed"
  else
    log "FAILED to install cloudflared"; exit 0
  fi
fi

if [ -n "$TUNNEL_TOKEN" ]; then
  # named tunnel
  if pgrep -f "cloudflared.*tunnel.*run" >/dev/null 2>&1; then
    log "cloudflared already running"
  else
    log "starting named tunnel (auto-restarts if it exits; logs: $TLOG)"
    export TUNNEL_TOKEN
    setsid nohup bash -c '
      while true; do
        cloudflared tunnel --no-autoupdate run >>"'"$TLOG"'" 2>&1
        echo "[autostart] cloudflared exited, restarting in 5s" >>"'"$TLOG"'"
        sleep 5
      done
    ' >/dev/null 2>&1 </dev/null &
  fi
else
  # quick tunnel, no domain
  if pgrep -f "scripts/quick-tunnel.sh" >/dev/null 2>&1; then
    log "quick tunnel already running"
  else
    log "starting quick tunnel supervisor"
    setsid nohup bash scripts/quick-tunnel.sh >/dev/null 2>&1 </dev/null &
  fi
fi
exit 0
