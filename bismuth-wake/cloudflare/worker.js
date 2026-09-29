/**
 * Bismuth gateway — Cloudflare Worker (v2)
 * ---------------------------------------------------------------------------
 * Permanent front door for Bismuth. The dashboard shell (/app) and landing page
 * (/) are static assets served by Cloudflare, so they load instantly whether the
 * Codespace is awake or not. Everything dynamic goes through this Worker:
 *
 *   browser ──► Cloudflare (assets: /, /app)
 *          └──► this Worker ──► Cloudflare Tunnel ──► Codespace :3000
 *                    │             (/api/*, /ws, everything else)
 *                    ├─► GitHub REST API   (check state / start the Codespace)
 *                    └─► Discord OAuth     (login happens HERE, not in the Codespace)
 *
 * Why login lives here: the Codespace takes 30–60 s to boot. If Discord login
 * needed the Codespace, the user would stare at a spinner. Doing OAuth in the
 * Worker means: click Deploy → Codespace starts booting → user logs in and fills
 * the setup wizard while it boots → by the time they press "create world" the
 * machine is (almost) ready.
 *
 * The Worker tells the Codespace who the user is with a short-lived HMAC-signed
 * header (X-Bismuth-Auth). The Codespace verifies it with the same secret
 * (server/gateway-auth.js). Without the secret nobody can forge an identity.
 *
 * It NEVER wakes the Codespace for WebSocket / API traffic, only for an explicit
 * POST /__bismuth/wake (sent by the landing "Deploy" button and the dashboard
 * page load), so stale tabs can't keep the machine alive.
 *
 * Two ways the Worker finds the tunnel (no domain needed for the first):
 *   1. QUICK TUNNEL (default, no domain): the Codespace runs `cloudflared --url` which gives it a
 *      random https://<words>.trycloudflare.com address on every start, then writes the
 *      <words> part into its own Codespace "display name" through the GitHub API. This Worker
 *      already talks to that API, so it reads the address back from there. No KV / database.
 *   2. NAMED TUNNEL (only if you own a domain on Cloudflare): set var TUNNEL_HOSTNAME.
 *
 * Config (wrangler.toml / dashboard):
 *   var    TUNNEL_HOSTNAME       OPTIONAL. Fixed tunnel hostname, only if you own a domain.
 *                                Leave unset to use the domain-free quick tunnel.
 *   var    CODESPACE_REPO        e.g. parallelwaves/bismuthtech  (used only to wake/check the
 *                                Codespace via GitHub API — the origin is the tunnel now)
 *   var    CODESPACE_NAME        optional fixed Codespace name fallback (wake/state checks only)
 *   var    DISCORD_CLIENT_ID
 *   secret DISCORD_CLIENT_SECRET
 *   secret GH_TOKEN              classic PAT, `codespace` scope (wake + state checks + tunnel address)
 *   secret GATEWAY_SECRET        random, 32+ chars; SAME value in the Codespace
 *   (Codespace side) CS_CONTROL_TOKEN = same PAT as GH_TOKEN, lets the Codespace publish its address
 */

const GH_API = 'https://api.github.com';
const SESSION_COOKIE = 'bm_session';
const OAUTH_COOKIE = 'bm_oauth';
const HINT_COOKIE = 'bm_sc'; // "setup complete" UX hint: 1 / 0 (never trusted for security)
const OUR_COOKIES = [SESSION_COOKIE, OAUTH_COOKIE, HINT_COOKIE];
const SESSION_MAX_AGE_S = 30 * 24 * 60 * 60;
const AUTH_HEADER_TTL_MS = 60_000;
const PUBLIC_API = new Set(['/api/status', '/api/versions']);

// Landing page + dashboard shell. With wrangler + [assets] these are served by
// Cloudflare before the Worker even runs and this stays null. For the
// paste-into-the-dashboard route, `node build-standalone.mjs` replaces the next
// line with the two pages embedded, so ONE file is all you have to upload.
const PAGES = null; // __BISMUTH_PAGES__

function pageResponse(html) {
  return new Response(html, {
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=120' },
  });
}

// Per-isolate memory: keeps us far below GitHub's API rate limit even when
// many visitors are polling at the same time.
let statusCache = { at: 0, val: null };
let lastWakeAt = 0;
let versionsCache = { at: 0, val: null };

export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);

      const missing = [];
      if (!env.CODESPACE_NAME && !env.CODESPACE_REPO) missing.push('CODESPACE_REPO (or CODESPACE_NAME)');
      if (!env.GH_TOKEN) missing.push('GH_TOKEN');
      if (!env.GATEWAY_SECRET || String(env.GATEWAY_SECRET).length < 32) missing.push('GATEWAY_SECRET (32+ chars)');
      if (missing.length) {
        return json({ error: 'gateway_not_configured', message: 'Missing on this Worker: ' + missing.join(', ') }, 500);
      }

      switch (url.pathname) {
        case '/__bismuth/status':
          return json(await getStatus(env));
        case '/__bismuth/wake':
          if (request.method !== 'POST') return json({ error: 'use_post' }, 405);
          return json(await wake(env));
        case '/__bismuth/versions':
          return json(await getVersions());
        case '/auth/discord':
          return await discordStart(env, url);
        case '/auth/discord/callback':
          return await discordCallback(request, env, url);
        case '/auth/logout':
          return redirect('/', [clearCookie(SESSION_COOKIE), clearCookie(HINT_COOKIE)]);
        case '/api/me':
          return await handleMe(request, env, url);
        case '/':
        case '/index.html':
          if (PAGES) return pageResponse(PAGES.index);
          return await proxy(request, env, url);
        case '/app':
        case '/app.html':
          if (PAGES) return pageResponse(PAGES.app);
          return await proxy(request, env, url);
        default:
          return await proxy(request, env, url);
      }
    } catch (err) {
      return json({ error: 'gateway_error', message: String(err && err.message ? err.message : err) }, 502);
    }
  },
};

/* ------------------------------------------------------------------ */
/* Config helpers                                                      */
/* ------------------------------------------------------------------ */

// Which Codespace are we talking about? With CODESPACE_REPO set, ask GitHub for
// the newest Codespace of that repo (cached 30 s) so a re-created Codespace with
// a new random name is picked up automatically. Falls back to CODESPACE_NAME.
let nameCache = { at: 0, val: null, repo: null };

async function resolveName(env) {
  if (env.CODESPACE_REPO) {
    if (nameCache.val && nameCache.repo === env.CODESPACE_REPO && Date.now() - nameCache.at < 30_000) return nameCache.val;
    try {
      const r = await ghCall(env, 'GET', '/user/codespaces?per_page=100');
      if (r.ok) {
        const want = String(env.CODESPACE_REPO).toLowerCase();
        const list = ((await r.json()).codespaces || []).filter(
          (c) => c.repository && String(c.repository.full_name).toLowerCase() === want
        );
        list.sort((a, b) => new Date(b.last_used_at || b.created_at) - new Date(a.last_used_at || a.created_at));
        if (list[0]) {
          nameCache = { at: Date.now(), val: list[0].name, repo: env.CODESPACE_REPO };
          return list[0].name;
        }
      }
    } catch {
      /* fall back below */
    }
  }
  return env.CODESPACE_NAME || null;
}

// The Codespace record (state + display name), cached for a few seconds so a burst
// of visitors doesn't hammer the GitHub API.
let csCache = { at: 0, name: null, val: null };

async function getCodespace(env, fresh = false) {
  const name = await resolveName(env);
  if (!name) return { name: null, status: 404, body: null };
  if (!fresh && csCache.val && csCache.name === name && Date.now() - csCache.at < 4000) return csCache.val;
  const r = await ghCall(env, 'GET', `/user/codespaces/${encodeURIComponent(name)}`);
  const out = { name, status: r.status, body: r.ok ? await r.json() : null };
  csCache = { at: Date.now(), name, val: out };
  return out;
}

// The Codespace publishes its quick-tunnel address as its display name: "bm-<words>".
// (<words>.trycloudflare.com). Only accept a strict slug so nothing else can steer the proxy.
function originFromDisplayName(displayName) {
  const m = /^bm-([a-z0-9]+(?:-[a-z0-9]+)*)$/.exec(String(displayName || ''));
  return m ? `https://${m[1]}.trycloudflare.com` : null;
}

async function cfg(env) {
  const name = await resolveName(env);
  // Named tunnel (you own a domain): fixed hostname that never changes.
  if (env.TUNNEL_HOSTNAME) {
    return { name, origin: `https://${String(env.TUNNEL_HOSTNAME).replace(/^https?:\/\//, '').replace(/\/$/, '')}` };
  }
  // Quick tunnel (no domain): the address changes every Codespace start and is
  // published in the Codespace's display name.
  const cs = await getCodespace(env);
  return { name, origin: cs.body ? originFromDisplayName(cs.body.display_name) : null };
}

function ghCall(env, method, path) {
  return fetch(GH_API + path, {
    method,
    headers: {
      Authorization: `Bearer ${env.GH_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'bismuth-gateway', // GitHub rejects API calls without a UA
    },
  });
}

/* ------------------------------------------------------------------ */
/* Small crypto / cookie helpers                                       */
/* ------------------------------------------------------------------ */

const enc = new TextEncoder();
let keyCache = { secret: null, key: null };

async function hmacKey(env) {
  if (keyCache.secret !== env.GATEWAY_SECRET) {
    keyCache = {
      secret: env.GATEWAY_SECRET,
      key: await crypto.subtle.importKey('raw', enc.encode(env.GATEWAY_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']),
    };
  }
  return keyCache.key;
}

function b64urlFromBytes(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function bytesFromB64url(str) {
  const pad = '='.repeat((4 - (str.length % 4)) % 4);
  const bin = atob(str.replace(/-/g, '+').replace(/_/g, '/') + pad);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

// token = base64url(json) + "." + base64url(HMAC-SHA256(secret, purpose + "." + base64url(json)))
// `purpose` separates cookie tokens ("session") from Codespace headers ("gw"),
// so one can never be replayed as the other.
async function signToken(env, purpose, obj) {
  const payload = b64urlFromBytes(enc.encode(JSON.stringify(obj)));
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(env), enc.encode(purpose + '.' + payload));
  return payload + '.' + b64urlFromBytes(new Uint8Array(sig));
}

async function verifyToken(env, purpose, token) {
  if (!token || typeof token !== 'string') return null;
  const i = token.indexOf('.');
  if (i < 1) return null;
  const payload = token.slice(0, i);
  let sigBytes;
  try {
    sigBytes = bytesFromB64url(token.slice(i + 1));
  } catch {
    return null;
  }
  const ok = await crypto.subtle.verify('HMAC', await hmacKey(env), sigBytes, enc.encode(purpose + '.' + payload));
  if (!ok) return null;
  try {
    return JSON.parse(new TextDecoder().decode(bytesFromB64url(payload)));
  } catch {
    return null;
  }
}

function parseCookies(request) {
  const out = {};
  for (const part of (request.headers.get('Cookie') || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

function cookie(name, value, { maxAge = SESSION_MAX_AGE_S } = {}) {
  return `${name}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;
}
function clearCookie(name) {
  return `${name}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
}

// Remove our own cookies before anything is forwarded to the Codespace.
function stripOurCookies(header) {
  return header
    .split(';')
    .map((p) => p.trim())
    .filter((p) => p && !OUR_COOKIES.includes(p.split('=')[0]))
    .join('; ');
}

function json(obj, status = 200, extra = {}, cookies = []) {
  const headers = new Headers({ 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...extra });
  for (const c of cookies) headers.append('Set-Cookie', c);
  return new Response(JSON.stringify(obj), { status, headers });
}

function redirect(location, cookies = []) {
  const headers = new Headers({ Location: location, 'Cache-Control': 'no-store' });
  for (const c of cookies) headers.append('Set-Cookie', c);
  return new Response(null, { status: 302, headers });
}

function withCookies(res, cookies) {
  const r = new Response(res.body, res);
  for (const c of cookies) r.headers.append('Set-Cookie', c);
  return r;
}

/* ------------------------------------------------------------------ */
/* Sessions + Discord OAuth (runs entirely in the Worker)              */
/* ------------------------------------------------------------------ */

async function readSession(request, env) {
  const tok = parseCookies(request)[SESSION_COOKIE];
  const obj = await verifyToken(env, 'session', tok);
  if (!obj || !obj.u || !obj.u.id || typeof obj.exp !== 'number' || obj.exp < Date.now()) return null;
  return obj.u;
}

function discordConfigured(env) {
  return !!(env.DISCORD_CLIENT_ID && env.DISCORD_CLIENT_SECRET);
}

async function discordStart(env, url) {
  if (!discordConfigured(env)) {
    return new Response('Set DISCORD_CLIENT_ID (var) and DISCORD_CLIENT_SECRET (secret) on the Worker. Redirect URI to register in Discord: ' + url.origin + '/auth/discord/callback', { status: 500 });
  }
  const state = b64urlFromBytes(crypto.getRandomValues(new Uint8Array(16)));
  const params = new URLSearchParams({
    client_id: env.DISCORD_CLIENT_ID,
    redirect_uri: url.origin + '/auth/discord/callback',
    response_type: 'code',
    scope: 'identify',
    state,
  });
  return redirect('https://discord.com/api/oauth2/authorize?' + params, [cookie(OAUTH_COOKIE, state, { maxAge: 600 })]);
}

async function discordCallback(request, env, url) {
  const fail = (why) => redirect('/app?error=' + encodeURIComponent(why), [clearCookie(OAUTH_COOKIE)]);

  if (url.searchParams.get('error')) return fail(url.searchParams.get('error'));
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  if (!code) return fail('no_code');
  if (!state || state !== parseCookies(request)[OAUTH_COOKIE]) return fail('bad_state');

  try {
    const tokenRes = await fetch('https://discord.com/api/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'DiscordBot (bismuth-gateway, 1.0)' },
      body: new URLSearchParams({
        client_id: env.DISCORD_CLIENT_ID,
        client_secret: env.DISCORD_CLIENT_SECRET,
        grant_type: 'authorization_code',
        code,
        redirect_uri: url.origin + '/auth/discord/callback',
      }),
    });
    const tokenData = await tokenRes.json();
    if (!tokenData.access_token) return fail('oauth_failed');

    const userRes = await fetch('https://discord.com/api/users/@me', {
      headers: { Authorization: 'Bearer ' + tokenData.access_token, 'User-Agent': 'DiscordBot (bismuth-gateway, 1.0)' },
    });
    const u = await userRes.json();
    if (!u || !u.id) return fail('oauth_failed');

    const session = await signToken(env, 'session', {
      u: { id: String(u.id), username: u.username, global_name: u.global_name || null, avatar: u.avatar || null },
      exp: Date.now() + SESSION_MAX_AGE_S * 1000,
    });
    return redirect('/app', [cookie(SESSION_COOKIE, session), clearCookie(OAUTH_COOKIE)]);
  } catch {
    return fail('oauth_failed');
  }
}

// Answered here so the login screen / wizard can appear instantly, even while
// the Codespace is still booting. When the Codespace is awake its answer is
// authoritative (it knows whether this account finished setup).
async function handleMe(request, env, url) {
  const base = {
    discordConfigured: discordConfigured(env),
    redirectUri: url.origin + '/auth/discord/callback',
    allowNoAuth: false,
  };
  const user = await readSession(request, env);
  if (!user) return json({ ...base, user: null, setupComplete: false });

  const up = await callUpstream(request, env, url, user, { timeoutMs: 4000 });
  if (up.kind === 'app') {
    try {
      const d = await up.res.json();
      const cookies = typeof d.setupComplete === 'boolean' ? [cookie(HINT_COOKIE, d.setupComplete ? '1' : '0')] : [];
      return json({ ...d, ...base, user: d.user || user }, 200, {}, cookies);
    } catch {
      /* fall through to the "asleep" answer */
    }
  }

  const hint = parseCookies(request)[HINT_COOKIE];
  return json({ ...base, user, setupComplete: hint === '1' ? true : hint === '0' ? false : null, waking: true });
}

/* ------------------------------------------------------------------ */
/* Minecraft versions (for the wizard while the Codespace is asleep)   */
/* ------------------------------------------------------------------ */

const PRESET_VERSIONS = ['1.21.1', '1.20.4', '1.20.1', '1.19.4', '1.18.2', '1.16.5', '1.12.2', '1.8.9'];

async function getVersions() {
  if (versionsCache.val && Date.now() - versionsCache.at < 60 * 60 * 1000) return versionsCache.val;
  try {
    const r = await fetch('https://launchermeta.mojang.com/mc/game/version_manifest_v2.json', { cf: { cacheTtl: 3600 } });
    const meta = await r.json();
    const releases = meta.versions.filter((v) => v.type === 'release').map((v) => v.id);
    const ordered = [...new Set([...PRESET_VERSIONS.filter((p) => releases.includes(p)), ...releases])].slice(0, 80);
    versionsCache = { at: Date.now(), val: { versions: ordered } };
  } catch {
    return { versions: PRESET_VERSIONS };
  }
  return versionsCache.val;
}

/* ------------------------------------------------------------------ */
/* Codespace state / wake                                              */
/* ------------------------------------------------------------------ */

async function codespaceState(env, fresh = false) {
  const cs = await getCodespace(env, fresh);
  if (!cs.name || cs.status === 404) return { state: 'NotFound' };
  if (cs.status === 401 || cs.status === 403) return { state: 'AuthError', httpStatus: cs.status };
  if (!cs.body) return { state: 'Unknown', reason: `github_api_${cs.status}` };
  return { state: cs.body.state || 'Unknown' };
}

// Is the app itself answering through the cloudflared tunnel?
// The Codespace-side patch adds `X-Bismuth: 1` to every response, which is how
// we tell "our app" apart from cloudflared's own error pages.
async function probeApp(env) {
  const { origin } = await cfg(env);
  if (!origin) return { ok: false, reason: 'app_starting' };
  try {
    const r = await fetch(origin + '/api/status', {
      headers: { Accept: 'application/json' },
      redirect: 'manual',
      signal: AbortSignal.timeout(4000),
    });
    if (r.ok && r.headers.get('x-bismuth') === '1') return { ok: true };
    // 502/503 = cloudflared is up but the app hasn't started yet
    if (r.status === 502 || r.status === 503) return { ok: false, reason: 'app_starting' };
    // Unexpected redirect (shouldn't happen with a tunnel, but handle gracefully)
    if ([301, 302, 303, 307, 308].includes(r.status)) return { ok: false, reason: 'app_starting' };
    return { ok: false, reason: 'app_starting' };
  } catch {
    return { ok: false, reason: 'app_starting' };
  }
}

async function getStatus(env) {
  const now = Date.now();
  if (statusCache.val && now - statusCache.at < 2000) return statusCache.val;

  const cs = await codespaceState(env);
  const out = { state: cs.state, ready: false };
  if (cs.reason) out.reason = cs.reason;

  if (cs.state === 'Available') {
    const p = await probeApp(env);
    out.ready = p.ok;
    if (!p.ok) out.reason = p.reason;
  }

  statusCache = { at: Date.now(), val: out };
  return out;
}

async function wake(env) {
  const { name } = await cfg(env);
  const cs = await codespaceState(env, true);

  // Only a fully stopped Codespace can be started.
  if (cs.state !== 'Shutdown') return { state: cs.state, started: false };

  // Guard against several visitors / tabs all pressing "start" at once.
  if (Date.now() - lastWakeAt < 10_000) return { state: 'Starting', started: false };
  lastWakeAt = Date.now();

  const r = await ghCall(env, 'POST', `/user/codespaces/${encodeURIComponent(name)}/start`);
  statusCache = { at: 0, val: null };
  csCache = { at: 0, name: null, val: null };

  if (r.status === 402) {
    return { state: cs.state, started: false, error: 'billing', message: 'The GitHub Codespaces spending limit has been reached.' };
  }
  // 409 = it changed state under us (someone else just started it). Fine.
  if (!r.ok && r.status !== 409) {
    return { state: cs.state, started: false, error: `github_api_${r.status}` };
  }
  return { state: 'Starting', started: true };
}

/* ------------------------------------------------------------------ */
/* Reverse proxy (HTTP + WebSocket)                                    */
/* ------------------------------------------------------------------ */

async function callUpstream(request, env, url, session, { timeoutMs = 15_000 } = {}) {
  const { origin } = await cfg(env);
  if (!origin) return { kind: 'asleep' };
  const isWs = (request.headers.get('Upgrade') || '').toLowerCase() === 'websocket';
  const target = origin + url.pathname + url.search;

  const headers = new Headers(request.headers);
  for (const k of [...headers.keys()]) {
    if (k.startsWith('cf-') || k === 'x-real-ip' || k === 'x-forwarded-for' || k === 'x-forwarded-host' ||
        k === 'x-forwarded-proto' || k === 'x-bismuth-auth') headers.delete(k);
  }
  const ck = stripOurCookies(request.headers.get('Cookie') || '');
  if (ck) headers.set('Cookie', ck);
  else headers.delete('Cookie');

  // Public Codespace ports show a "you are about to visit a dev tunnel"
  // interstitial to browser-like requests. cloudflared tunnels don't do this,
  // but we keep the forwarded host headers for the app's redirectUri detection.
  headers.set('X-Forwarded-Host', url.host);
  headers.set('X-Forwarded-Proto', 'https');
  if (session) {
    headers.set('X-Bismuth-Auth', await signToken(env, 'gw', { u: session, exp: Date.now() + AUTH_HEADER_TTL_MS }));
  }

  const hasBody = request.method !== 'GET' && request.method !== 'HEAD';
  const init = { method: request.method, headers, redirect: 'manual' };
  if (hasBody) init.body = request.body;
  if (!hasBody && !isWs) init.signal = AbortSignal.timeout(timeoutMs);

  let upstream;
  try {
    upstream = await fetch(target, init);
  } catch {
    return { kind: 'asleep' };
  }

  if (upstream.status === 101) return { kind: 'ws', res: upstream };
  if (upstream.headers.get('x-bismuth') === '1') return { kind: 'app', res: new Response(upstream.body, upstream) };

  // Reached GitHub's edge but not our app → Codespace is stopped / booting /
  // tunnel isn't connected yet. Never leak that page to the visitor.
  return { kind: 'asleep' };
}

async function proxy(request, env, url) {
  const session = await readSession(request, env);
  const isWs = (request.headers.get('Upgrade') || '').toLowerCase() === 'websocket';

  // Don't even touch the Codespace for anonymous traffic that can't succeed.
  if (isWs && !session) return json({ error: 'login_required' }, 401);
  if (url.pathname.startsWith('/api/') && !PUBLIC_API.has(url.pathname) && !session) {
    return json({ error: 'login_required' }, 401);
  }

  const up = await callUpstream(request, env, url, session);
  if (up.kind === 'asleep') return asleepResponse(request, isWs);
  if (up.kind === 'ws') return up.res;

  // Remember (as a UX hint only) that this account finished the wizard, so a
  // returning user can skip straight to the dashboard next time.
  if (url.pathname === '/api/profile/setup' && request.method === 'POST' && up.res.ok) {
    return withCookies(up.res, [cookie(HINT_COOKIE, '1')]);
  }
  return up.res;
}

function asleepResponse(request, isWs) {
  const wantsHtml =
    request.method === 'GET' && !isWs && (request.headers.get('Accept') || '').includes('text/html');

  if (wantsHtml) {
    return new Response(WAKE_PAGE, {
      status: 503,
      headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Retry-After': '5' },
    });
  }
  return json(
    { error: 'codespace_asleep', message: 'The Bismuth server is asleep and is being started.' },
    503,
    { 'Retry-After': '5', 'X-Bismuth-Asleep': '1' }
  );
}

/* ------------------------------------------------------------------ */
/* The "waking up" page                                                */
/* NOTE: client script below deliberately avoids backticks and ${}     */
/* because this whole page lives inside a JS template literal.         */
/* ------------------------------------------------------------------ */

const WAKE_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>Waking Bismuth…</title>
<style>
  :root{--bg:#0a0a0b;--text:#e4e4e6;--muted:#86868c;--border:#212124;--accent:#c0f242;--surface:#0d0d0f;
        --font:'IBM Plex Mono',ui-monospace,SFMono-Regular,Consolas,monospace}
  @media (prefers-color-scheme:light){
    :root{--bg:#fbfbfa;--text:#16161a;--muted:#79797f;--border:#e4e4e1;--accent:#4d7a12;--surface:#fff}
  }
  *{box-sizing:border-box}
  html,body{margin:0;height:100%;background:var(--bg);color:var(--text);font-family:var(--font);-webkit-font-smoothing:antialiased}
  main{min-height:100%;display:flex;align-items:center;justify-content:center;padding:24px}
  .card{width:100%;max-width:460px;border:1px solid var(--border);background:var(--surface);padding:32px 28px}
  .brand{display:flex;align-items:center;gap:10px;font-weight:600;letter-spacing:.02em;margin-bottom:28px}
  .brand svg{width:26px;height:26px;animation:spin 6s linear infinite}
  @keyframes spin{to{transform:rotate(360deg)}}
  h1{font-size:18px;margin:0 0 8px;font-weight:600}
  p{margin:0;color:var(--muted);font-size:13px;line-height:1.6}
  ol{list-style:none;padding:0;margin:26px 0 0}
  li{display:flex;align-items:center;gap:12px;padding:9px 0;font-size:13px;color:var(--muted)}
  li .dot{width:10px;height:10px;border:1px solid var(--muted);flex:none}
  li.active{color:var(--text)} li.active .dot{border-color:var(--accent);background:var(--accent);animation:pulse 1.1s ease-in-out infinite}
  li.done{color:var(--text)} li.done .dot{border-color:var(--accent);background:var(--accent)}
  @keyframes pulse{50%{opacity:.25}}
  .meta{margin-top:22px;padding-top:16px;border-top:1px solid var(--border);font-size:12px;color:var(--muted);display:flex;justify-content:space-between;gap:12px}
  .err h1{color:#ff6b6b}
  button{margin-top:20px;background:var(--accent);color:var(--bg);border:0;padding:9px 18px;font:inherit;font-size:13px;font-weight:600;cursor:pointer}
  .hidden{display:none}
</style>
</head>
<body>
<main>
  <div class="card" id="card">
    <div class="brand">
      <svg viewBox="0 0 32 32"><path d="M16 4 L26 10 V22 L16 28 L6 22 V10 Z" fill="none" stroke="var(--accent)" stroke-width="2"/></svg>
      <span>bismuth</span>
    </div>
    <h1 id="title">Waking the server…</h1>
    <p id="sub">This machine sleeps when nobody is using it. Starting it now — usually 30–60 seconds.</p>
    <ol id="steps">
      <li id="s0" class="active"><span class="dot"></span>Starting the cloud machine</li>
      <li id="s1"><span class="dot"></span>Booting Bismuth</li>
      <li id="s2"><span class="dot"></span>Ready</li>
    </ol>
    <div class="meta"><span id="state">state: …</span><span id="clock">0s</span></div>
    <button id="retry" class="hidden">Try again</button>
    <noscript><p style="margin-top:16px">Enable JavaScript to see progress, or just reload this page in a minute.</p></noscript>
  </div>
</main>
<script>
(function(){
  var t0 = Date.now(), lastWake = 0, stopped = false;
  function $(id){ return document.getElementById(id); }

  function setSteps(active){
    for (var i = 0; i < 3; i++){
      var el = $('s' + i);
      el.className = i < active ? 'done' : (i === active ? 'active' : '');
    }
  }
  function showError(title, sub){
    stopped = true;
    $('card').className = 'card err';
    $('title').textContent = title;
    $('sub').textContent = sub;
    $('retry').className = '';
  }
  function reloadGuarded(){
    var n = 0, ts = 0;
    try { n = +(sessionStorage.getItem('bm_n') || 0); ts = +(sessionStorage.getItem('bm_t') || 0); } catch(e){}
    if (!ts || Date.now() - ts > 60000) { n = 0; ts = Date.now(); }
    if (n >= 3) { showError('Server is up but the page did not load', 'Press retry. If this keeps happening, check that port 3000 is Public.'); return; }
    try { sessionStorage.setItem('bm_n', String(n + 1)); sessionStorage.setItem('bm_t', String(ts)); } catch(e){}
    location.replace(location.href);
  }

  function tick(){
    if (stopped) return;
    var secs = Math.round((Date.now() - t0) / 1000);
    $('clock').textContent = secs + 's';

    fetch('/__bismuth/status', { cache: 'no-store' })
      .then(function(r){ return r.json(); })
      .then(function(s){
        $('state').textContent = 'state: ' + String(s.state).toLowerCase() + (s.ready ? ' · ready' : '');

        if (s.ready) { setSteps(3); $('title').textContent = 'Ready'; reloadGuarded(); return; }

        if (s.state === 'NotFound') return showError('Codespace not found', 'The Worker cannot find the Codespace. Check CODESPACE_REPO (or CODESPACE_NAME) on the Worker.');
        if (s.state === 'AuthError') return showError('GitHub rejected the token', 'Check the GH_TOKEN secret (needs the codespace scope).');
        if (s.state === 'Failed' || s.state === 'Deleted' || s.state === 'Archived' || s.state === 'Moved')
          return showError('Codespace is ' + String(s.state).toLowerCase(), 'It cannot be started automatically. Open GitHub → Codespaces to check it.');

        if (s.state === 'Available') {
          setSteps(1);
          $('title').textContent = 'Booting Bismuth…';
          if (secs > 120)
            $('sub').textContent = 'Taking longer than usual. Check that the server started in the Codespace (npm start).';
          else
            $('sub').textContent = 'Machine is up. The app is starting.';
        } else {
          setSteps(0);
        }

        if (s.state === 'Shutdown' && Date.now() - lastWake > 15000) {
          lastWake = Date.now();
          return fetch('/__bismuth/wake', { method: 'POST' })
            .then(function(r){ return r.json(); })
            .then(function(w){
              if (w && w.error === 'billing') showError('Cannot start the server', w.message || 'Codespaces spending limit reached.');
              else if (w && w.error) showError('Could not start the server', 'GitHub API said: ' + w.error);
            });
        }
      })
      .catch(function(){ $('state').textContent = 'state: retrying…'; })
      .then(function(){ if (!stopped) setTimeout(tick, 2500); });
  }

  $('retry').onclick = function(){
    try { sessionStorage.removeItem('bm_n'); sessionStorage.removeItem('bm_t'); } catch(e){}
    location.reload();
  };
  tick();
})();
</script>
</body>
</html>`;
