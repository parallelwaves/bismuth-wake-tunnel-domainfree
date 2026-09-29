#!/usr/bin/env bash
# Copies the Codespace-side files into your repo, patches server/index.js,
# commits and pushes. Safe to run twice.
#
#   bash install-into-repo.sh [path-to-repo]  [--no-push]
#
# Run it from a terminal inside the Codespace (it already has git access).
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
SRC="$HERE/codespace"
REPO="."
PUSH=1
for a in "$@"; do
  case "$a" in
    --no-push) PUSH=0 ;;
    *) REPO="$a" ;;
  esac
done

cd "$REPO"
[ -f server/index.js ] && [ -f package.json ] || { echo "✗ Run this from the repo root (needs server/index.js and package.json)."; exit 1; }
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || { echo "✗ Not a git repository."; exit 1; }

echo "→ copying files"
mkdir -p server scripts .devcontainer
cp "$SRC/server/lifecycle.js"        server/lifecycle.js
cp "$SRC/server/gateway-auth.js"     server/gateway-auth.js
cp "$SRC/scripts/autostart.sh"       scripts/autostart.sh
cp "$SRC/scripts/quick-tunnel.sh"    scripts/quick-tunnel.sh
cp "$SRC/.devcontainer/devcontainer.json" .devcontainer/devcontainer.json
chmod +x scripts/autostart.sh scripts/quick-tunnel.sh

echo "→ patching server/index.js"
if grep -q "createGatewayAuth" server/index.js; then
  echo "  already patched, skipping"
else
  patch -p1 --forward < "$SRC/server/index.js.patch" || { echo "✗ Patch didn't apply cleanly (server/index.js has diverged). Nothing was committed."; exit 1; }
  rm -f server/index.js.orig server/index.js.rej
fi

echo "→ .gitignore"
touch .gitignore
grep -qx ".keep-awake" .gitignore || echo ".keep-awake" >> .gitignore

node --check server/index.js
node --check server/lifecycle.js
node --check server/gateway-auth.js
bash -n scripts/autostart.sh
bash -n scripts/quick-tunnel.sh
echo "✓ syntax OK"

git add server/lifecycle.js server/gateway-auth.js server/index.js scripts/autostart.sh scripts/quick-tunnel.sh .devcontainer/devcontainer.json .gitignore
if git diff --cached --quiet; then
  echo "Nothing new to commit."
else
  git commit -q -m "Add Cloudflare wake-up bridge: gateway auth, lifecycle self-stop, autostart"
  echo "✓ committed"
fi

if [ "$PUSH" = 1 ]; then
  git push
  echo "✓ pushed"
else
  echo "(--no-push: run 'git push' yourself)"
fi

cat <<'MSG'

Next (no domain needed):
  1. GitHub -> Settings -> Codespaces -> Secrets, grant access to this repo:
       CS_CONTROL_TOKEN = classic PAT, `codespace` scope (same one the Worker uses as GH_TOKEN)
       GATEWAY_SECRET   = same 32+ char value as on the Worker
     (or put both lines in a .env file in this folder instead)
  2. Ctrl/Cmd+Shift+P -> "Codespaces: Rebuild Container" (once, devcontainer.json changed).
  3. Check it worked:  cat /tmp/bismuth-autostart.log /tmp/bismuth-tunnel.log
     You should see "published https://<words>.trycloudflare.com".
  4. Open https://YOUR-WORKER.workers.dev/__bismuth/status  ->  {"state":"Available","ready":true}

Own a domain later? Set TUNNEL_TOKEN (Codespace) + TUNNEL_HOSTNAME (Worker) for a fixed named tunnel.
MSG
