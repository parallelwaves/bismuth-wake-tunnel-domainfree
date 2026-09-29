// server/gateway-auth.js
// ---------------------------------------------------------------------------
// Login now happens in the Cloudflare Worker (so it works while this Codespace
// is still booting). The Worker forwards the logged-in Discord user as a signed,
// 60-second header:  X-Bismuth-Auth: <base64url(json)>.<base64url(hmac)>
//
// This module verifies that header and makes the rest of the app see it as a
// normal logged-in session (req.session.user), so none of the existing
// getUserId()/requireAuth()/per-account-world code has to change.
//
// Enabled only when GATEWAY_SECRET is set (same value as on the Worker).
// Without it everything behaves exactly like before.
//
// When enabled it also closes a hole: the /ws WebSocket used to accept anyone,
// including console commands. In gateway mode it requires the signed header.
// ---------------------------------------------------------------------------

import crypto from 'crypto';

const CLOCK_SKEW_MS = 5000;

export function verifyGatewayToken(token, secret, now = Date.now()) {
  if (!token || !secret || typeof token !== 'string') return null;
  const i = token.indexOf('.');
  if (i < 1) return null;
  const payload = token.slice(0, i);
  const sig = token.slice(i + 1);

  const expected = crypto.createHmac('sha256', secret).update('gw.' + payload).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

  let obj;
  try {
    obj = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!obj || typeof obj.exp !== 'number' || obj.exp + CLOCK_SKEW_MS < now) return null;
  if (!obj.u || !obj.u.id) return null;
  return obj.u;
}

export function createGatewayAuth() {
  const secret = () => process.env.GATEWAY_SECRET || '';

  // Runs BEFORE express-session. If the header is valid we hand the request a
  // ready-made session object and flag it so the session middleware is skipped.
  function middleware(req, res, next) {
    const s = secret();
    if (!s) return next();
    const u = verifyGatewayToken(req.headers['x-bismuth-auth'], s);
    if (u) {
      req.gatewayAuthed = true;
      req.session = {
        user: { id: String(u.id), username: u.username, global_name: u.global_name || null, avatar: u.avatar || null },
        save: (cb) => cb && cb(),
        destroy: (cb) => cb && cb(),
      };
    }
    next();
  }

  // For `new WebSocketServer({ verifyClient })`.
  function verifyWsClient(info, cb) {
    const s = secret();
    if (!s) return cb(true); // gateway mode off → legacy behavior
    const u = verifyGatewayToken(info.req.headers['x-bismuth-auth'], s);
    if (u) return cb(true);
    return cb(false, 401, 'login required');
  }

  return { middleware, verifyWsClient };
}
