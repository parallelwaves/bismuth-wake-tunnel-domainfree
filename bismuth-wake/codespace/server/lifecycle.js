// server/lifecycle.js
// ---------------------------------------------------------------------------
// Codespace-side half of the wake-up bridge. Zero dependencies (uses Node's
// built-in fetch), so it drops into the existing project as-is.
//
// It does three things:
//   1. Adds an `X-Bismuth: 1` header to every response. The Cloudflare Worker
//      uses this to tell "the app answered" apart from GitHub's own
//      "Problem loading" page.
//   2. Tracks real activity (HTTP requests + WebSocket commands). Health
//      probes from the Worker (/api/status) are ignored on purpose, so the
//      Worker checking on you never keeps the machine awake.
//   3. Optional self-stop: your existing 120 s timer only stops the Minecraft
//      process + playit. It does NOT power off the Codespace itself — GitHub's
//      own idle timeout does that (30 min by default). If CS_CONTROL_TOKEN is
//      set, this module stops the Codespace via the GitHub API once
//      Minecraft is idle AND nobody has used the app for CS_IDLE_STOP_SEC
//      (default 120). The existing 120 s Minecraft logic is left untouched.
//
// Env (read lazily, so values from .env / Codespaces secrets both work):
//   CODESPACE_NAME      set automatically by GitHub inside a Codespace
//   CS_CONTROL_TOKEN    classic PAT with `codespace` scope (enables self-stop)
//   CS_IDLE_STOP_SEC    grace period after the last activity (default 120)
//   CS_AUTO_STOP=0      turn self-stop off entirely
//   .keep-awake file    `touch .keep-awake` in the repo root to pause
//                       self-stop while you're editing code in the Codespace
// ---------------------------------------------------------------------------

import fs from 'fs';

const API = 'https://api.github.com';
const TICK_MS = 5000;

export function createLifecycle({ isBusy, log = console.log, keepAwakeFile = null } = {}) {
  let lastActivity = Date.now();
  let stopping = false;
  let timer = null;

  const touch = () => {
    lastActivity = Date.now();
  };

  const conf = () => ({
    name: process.env.CODESPACE_NAME || '',
    token: process.env.CS_CONTROL_TOKEN || '',
    graceMs: (parseInt(process.env.CS_IDLE_STOP_SEC || '120', 10) || 120) * 1000,
    enabled: process.env.CS_AUTO_STOP !== '0',
  });

  function middleware(req, res, next) {
    res.setHeader('X-Bismuth', '1');
    if (req.path !== '/api/status') touch(); // the Worker's probe is not "activity"
    next();
  }

  async function stopCodespace(c) {
    const r = await fetch(`${API}/user/codespaces/${encodeURIComponent(c.name)}/stop`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${c.token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'bismuth-lifecycle',
      },
    });
    if (!r.ok) throw new Error(`GitHub API ${r.status}`);
  }

  async function tick() {
    const c = conf();
    if (!c.enabled || !c.name || !c.token || stopping) return;

    if (keepAwakeFile && fs.existsSync(keepAwakeFile)) return touch();
    if (isBusy && isBusy()) return touch(); // Minecraft running / players online
    if (Date.now() - lastActivity < c.graceMs) return;

    stopping = true;
    try {
      log(`No activity for ${Math.round(c.graceMs / 1000)}s and Minecraft is idle — stopping the Codespace.`);
      await stopCodespace(c);
    } catch (err) {
      log('Codespace self-stop failed:', err.message);
    } finally {
      // If the stop worked this process is about to be killed anyway.
      // If it failed, try again in a minute.
      setTimeout(() => {
        stopping = false;
      }, 60_000).unref?.();
    }
  }

  function start() {
    const c = conf();
    if (!c.enabled) log('Codespace self-stop: disabled (CS_AUTO_STOP=0)');
    else if (!c.name) log('Codespace self-stop: off (not running inside a Codespace)');
    else if (!c.token) log('Codespace self-stop: off (set CS_CONTROL_TOKEN to enable). GitHub\'s own idle timeout still applies.');
    else log(`Codespace self-stop: on — stops ${Math.round(c.graceMs / 1000)}s after Minecraft is idle and nobody is using the app.`);

    touch();
    timer = setInterval(() => tick().catch(() => {}), TICK_MS);
    timer.unref?.();
  }

  return { middleware, touch, start, tick };
}
