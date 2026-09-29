# Bismuth wake-up bridge (v2: dashboard on Cloudflare, wakes on Deploy)

```
                     ┌─ static assets:  /  (landing)   /app (dashboard)        instant, always on
browser ─► Cloudflare┤
                     └─ Worker: /auth/*  /api/me  /api/*  /ws  ─► GitHub Codespace (Node + Minecraft)
                          │  ├─ Discord OAuth (login happens here)
                          │  └─ GitHub API: start the Codespace
                          └─ signs "this is Discord user X" for the Codespace (HMAC header)
```

## Quick path (two scripts)

```bash
# 1) In a terminal INSIDE your Codespace (upload the zip via the file explorer first):
unzip bismuth-wake.zip -d /tmp && bash /tmp/bismuth-wake/install-into-repo.sh
#    copies the Codespace files into the repo, patches server/index.js, commits, pushes

# 2) On any machine with Node (or the Codespace terminal + CLOUDFLARE_API_TOKEN set):
bash deploy-cloudflare.sh
#    deploys the Worker + pages, sets GH_TOKEN and a generated GATEWAY_SECRET,
#    and prints the GATEWAY_SECRET line to add to the Codespace
```

Discord isn't needed for either script. When you're ready: put `DISCORD_CLIENT_ID` in `cloudflare/wrangler.toml`, run `npx wrangler secret put DISCORD_CLIENT_SECRET`, and `npx wrangler deploy`. The manual steps below explain what each script does.

## No wrangler? Deploy from the Cloudflare dashboard (one file)

`wrangler.toml` is a settings file for the `wrangler` command-line tool. The dashboard never reads it, so it won't upload there and doesn't need to. Use `cloudflare/worker-standalone.js` instead: it is the Worker with the landing page and dashboard already embedded, so it is the only file you paste.

1. Cloudflare dashboard → **Workers & Pages → Create → Create Worker** → name it `bismuth-gateway` → **Deploy** → **Edit code**.
2. Select everything in the editor, delete it, paste the whole of `worker-standalone.js`, then **Deploy**.
3. Worker → **Settings → Variables and Secrets → Add**:

   | type | name | value |
   |---|---|---|
   | Text | `CODESPACE_REPO` | `parallelwaves/bismuthtech` (the Worker finds the newest Codespace of this repo itself; delete any old `CODESPACE_NAME`) |
   | Text | `CODESPACE_PORT` | `3000` |
   | Secret | `GH_TOKEN` | your classic PAT (`codespace` scope) |
   | Secret | `GATEWAY_SECRET` | 32+ random characters (`openssl rand -hex 32` in the Codespace terminal); use the same value in the Codespace |
   | Text | `DISCORD_CLIENT_ID` | later, when you do the Discord setup |
   | Secret | `DISCORD_CLIENT_SECRET` | later |

4. Worker → **Settings → Domains & Routes** to add your own domain, or use the `*.workers.dev` link.

If you change `public/app.html` or `public/index.html` later, run `node build-standalone.mjs` in `cloudflare/` and paste the new `worker-standalone.js` again.

(Third option: put the `cloudflare/` folder in a GitHub repo and use Workers & Pages → Create → Import a repository, root directory `cloudflare`. That flow does read `wrangler.toml`.)

## Cloudflare Tunnel (replaces the GitHub "Public" port button) — no domain needed

Before, the Worker called `https://<codespace>-3000.app.github.dev`, which only works while the port is Public, and GitHub resets that on every start. Now `cloudflared` inside the Codespace dials **out** to Cloudflare, so there is no port to publish.

**Default, domain-free (quick tunnel).** On every Codespace start `scripts/quick-tunnel.sh` runs a free Cloudflare quick tunnel and gets a random `https://<words>.trycloudflare.com` address. It writes `<words>` into the Codespace's own display name (`bm-<words>`) using the GitHub API; the Worker already talks to that API, so it reads the address back. No Cloudflare login, domain, KV or database. People only ever visit your `*.workers.dev` link; the random address is internal.

Setup is just two Codespaces secrets (GitHub → Settings → Codespaces → Secrets, granted to `parallelwaves/bismuthtech`):

| secret | value |
|---|---|
| `CS_CONTROL_TOKEN` | the same classic PAT (`codespace` scope) you gave the Worker as `GH_TOKEN` |
| `GATEWAY_SECRET` | the same value as on the Worker |

Then run `install-into-repo.sh` and rebuild the container once. Do **not** set `TUNNEL_HOSTNAME` on the Worker.

Debug: `cat /tmp/bismuth-autostart.log /tmp/bismuth-tunnel.log` in the Codespace (look for `published https://...trycloudflare.com`). `https://YOUR-WORKER.workers.dev/__bismuth/status` shows `state` / `ready`; `reason: app_starting` means the machine is up but the tunnel or app isn't answering yet.

Limits of quick tunnels: Cloudflare provides them for testing (no uptime guarantee), max 200 simultaneous requests, no Server-Sent Events. The dashboard uses plain HTTP + WebSocket, so that's fine. The address changes on each start (handled automatically).

**Optional upgrade, only if you later own a domain on Cloudflare:** create a named tunnel in Zero Trust, add a Public Hostname (HTTP → `localhost:3000`) on a name different from your site's, put the tunnel token in the Codespace as `TUNNEL_TOKEN` and set the Worker var `TUNNEL_HOSTNAME`. That gives a fixed address.

Security: the random tunnel address is technically public. With `GATEWAY_SECRET` set, `/api/*` and `/ws` reject anything not signed by the Worker, so nobody can use it directly.

## What happens when someone clicks Deploy

| t | what the user sees | what happens behind it |
|---|---|---|
| 0 s | clicks **Deploy Server** | landing page fires `POST /__bismuth/wake` → Worker starts the Codespace |
| 0.3 s | dashboard + "Login with Discord" | `/app` is a static file from Cloudflare; `/api/me` is answered by the Worker |
| 3–10 s | logs in | Discord OAuth runs in the Worker, no Codespace needed |
| 10–40 s | first-time wizard (world name, version, mode…) | version list comes from the Worker; Codespace keeps booting |
| finish | "creating…" then dashboard | wizard submit waits for the Codespace if it isn't up yet, then Minecraft **auto-starts** |

If the Codespace is still booting at any point, API calls just wait and retry (small "Waking your server… 23s" pill at the bottom) instead of failing.

## One thing to know first

Your 120 s timer in `server/index.js` stops the **Minecraft process + playit**, not the **Codespace**. GitHub's own idle timeout does that (30 min by default). `lifecycle.js` adds an optional self-stop so the Codespace itself sleeps ~120 s after Minecraft is idle and nobody is using the app. The 120 s Minecraft logic is untouched.

---

## 1. Tokens and secrets (do this first)

1. **GitHub token**: github.com → Settings → Developer settings → Tokens (classic) → scope **`codespace`**.
2. **Discord app** (developer portal → OAuth2): add exactly one redirect: `https://YOUR-DOMAIN/auth/discord/callback`. Old Codespace-URL redirects aren't used any more. Note the Client ID and Client Secret.
3. **Gateway secret**: run `openssl rand -hex 32`. The same value goes on the Worker and in the Codespace. It's what stops anyone forging "I am Discord user X".

## 2. Cloudflare

```bash
cd cloudflare
# edit wrangler.toml: CODESPACE_REPO (already filled) and DISCORD_CLIENT_ID
npx wrangler login
npx wrangler secret put GH_TOKEN
npx wrangler secret put DISCORD_CLIENT_SECRET
npx wrangler secret put GATEWAY_SECRET
npx wrangler deploy
```

Custom domain: uncomment `routes` in `wrangler.toml` (or Dashboard → Worker → Settings → Domains & Routes). Otherwise you get a `*.workers.dev` URL. Whichever you use is `YOUR-DOMAIN` in step 1.2.

`public/app.html` and `public/index.html` are your existing pages with a small patch (wake on load / on Deploy, patient API calls, early login and wizard). If you change the originals in the repo later, refresh the Cloudflare copies:

```bash
cd cloudflare
cp ../path/to/repo/public/app.html   public/app.html
cp ../path/to/repo/public/index.html public/index.html
patch -p1 < app.html.patch
patch -p1 < index.html.patch
npx wrangler deploy
```

Top of the dashboard script has `const AUTO_LAUNCH_AFTER_SETUP = true;`. Set it to `false` if you'd rather the user press **start server** themselves after the wizard.

## 3. Codespace (repo `parallelwaves/bismuthtech`)

Copy into the repo at the same paths:

| file | what it does |
|---|---|
| `server/lifecycle.js` | `X-Bismuth` header, activity tracking, optional self-stop |
| `server/gateway-auth.js` | verifies the Worker's signed identity; also locks down `/ws` |
| `scripts/autostart.sh` | on every Codespace start: runs `npm start` and the tunnel |
| `scripts/quick-tunnel.sh` | domain-free tunnel: runs cloudflared and publishes its address for the Worker |
| `.devcontainer/devcontainer.json` | replaces yours: `postStartCommand`, no forwarded 3000 |
| `server/index.js.patch` | small edits to `server/index.js`. Apply: `git apply server/index.js.patch` (or `patch -p1 < server/index.js.patch`) |

Add `.keep-awake` to `.gitignore`.

Codespace secrets (GitHub → Settings → Codespaces → Secrets, give them access to the repo), or put the same lines in `.env` inside the Codespace:

```
GATEWAY_SECRET=<the same value as on the Worker>
CS_CONTROL_TOKEN=<the classic PAT (same as the Worker's GH_TOKEN)>
```

You no longer need `DISCORD_CLIENT_ID/SECRET` in the Codespace `.env`: login moved to the Worker. Everyone will log in once more; Discord IDs are unchanged, so worlds, mods and settings under `data/users/<id>/` are all still theirs.

Commit + push, then in the Codespace: **Ctrl/Cmd+Shift+P → "Codespaces: Rebuild Container"** (once; `data/` survives).

Optional env: `CS_IDLE_STOP_SEC` (default 120), `CS_AUTO_STOP=0` (no self-stop). While editing code in the Codespace, `touch .keep-awake` so it doesn't stop under you.

## 4. Test

1. `https://YOUR-DOMAIN/__bismuth/status` → JSON with `state` and `ready`.
2. Stop the Codespace (github.com/codespaces → ⋯ → Stop). Open `https://YOUR-DOMAIN/`, press **Deploy Server**. Watch the Codespace go Starting in GitHub while you log in and click through the wizard.
3. After the wizard, Minecraft starts. Leave it: ~120 s later Minecraft stops, ~120 s after that the Codespace stops. `Codespace self-stop: on …` appears in `/tmp/bismuth-autostart.log`.

## The launch console (the moving feed while waiting)

While the machine and Minecraft boot, the dashboard shows a "Launching your server" screen: phase chips (cloud machine → bismuth engine → minecraft), a progress bar, a timer and a scrolling feed.

- Lines marked `●` `✓` `✗` `›` are **real**: machine state from the Worker, and Minecraft's own console output.
- Lines marked `~` are **placeholders** (playful filler and tips) that appear every 1–2.5 s in the quiet gaps so the screen never freezes.
- Config problems show up here in red with the fix, e.g. "Codespace not found", "GitHub rejected the token", "port 3000 is not public yet".
- To change the wording, edit `BOOT_FLAVOR` and `BOOT_TIPS` near the top of the dashboard script in `cloudflare/public/app.html`, rebuild (`node build-standalone.mjs`) and redeploy. To replace a placeholder with a real event later, call `BootConsole.real('text','ok')` from any code.
- Users can press **hide**. It closes by itself when the server is online.

The machine wake-up itself (30–90 s) is GitHub's and can't be skipped. Overlapping it with login and the wizard, plus this feed, is what makes it feel shorter. For a live demo, set `CS_IDLE_STOP_SEC=1800` in the Codespace so it stays warm for 30 minutes and nobody sees a cold start.

## Behavior notes

- **Security fix included:** before, anyone who could reach the Codespace URL could open `/ws` and send Minecraft console commands with no login. With `GATEWAY_SECRET` set, `/ws` requires the Worker's signed identity. Side effect: the raw Codespace URL no longer gives a working dashboard; use the Worker domain.
- The Worker only wakes the Codespace for `POST /__bismuth/wake` (Deploy click, dashboard page load, or an API call made from an open dashboard). WebSocket reconnects from a stale tab get a plain `503` and never wake it.
- Anonymous requests never reach the Codespace: `/api/*` without a login gets `401` from the Worker.
- Returning users: the Worker remembers "setup done" in a cookie, so they skip straight to the dashboard. A returning user on a new device sees the wizard for a few seconds until the Codespace answers; if it finds an existing world it closes the wizard and keeps their saved settings.
- Uploads through the Worker are capped by Cloudflare's request-body limit (100 MB on Free/Pro); the dashboard allows 512 MB.
- `/__bismuth/wake` is public. Worst case someone starts your Codespace; it stops itself soon after. Add a Cloudflare rate-limit rule on that path if you're worried.
- A cold start is roughly 30–60 s. Minecraft's first jar download adds time on a brand-new account.
- Minecraft players still join through the playit.gg address; nothing here touches that.
