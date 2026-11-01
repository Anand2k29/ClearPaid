// Sign in with PayPal (OpenID Connect, authorization code flow).
// The server keeps the client secret, checks `state` against CSRF, and holds the session in an HttpOnly cookie.
// Endpoints follow PayPal's Log in with PayPal documentation (sandbox). Not yet run against a live sandbox app.
const crypto = require("node:crypto");

const SANDBOX = {
  authorize: "https://www.sandbox.paypal.com/connect",
  token: "https://api-m.sandbox.paypal.com/v1/oauth2/token",
  userinfo: "https://api-m.sandbox.paypal.com/v1/identity/oauth2/userinfo?schema=openid"
};
const SESSION_MS = 8 * 60 * 60 * 1000;
const PENDING_MS = 10 * 60 * 1000;
const COOKIE = "cp_session";

function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString("base64url");
}

// In-memory session and login-attempt stores. A restart signs everyone out, which is acceptable for this build.
function createAuthStore() {
  const sessions = new Map();
  const pending = new Map();
  return {
    startAttempt(now = Date.now()) {
      const state = randomToken();
      const nonce = randomToken();
      pending.set(state, { nonce, expires: now + PENDING_MS });
      return { state, nonce };
    },
    // One-time use: a state value can complete sign-in only once.
    takeAttempt(state, now = Date.now()) {
      const p = pending.get(state);
      pending.delete(state);
      if (!p || p.expires < now) return null;
      return p;
    },
    createSession(user, now = Date.now()) {
      const id = randomToken();
      sessions.set(id, { user, expires: now + SESSION_MS });
      return id;
    },
    getSession(id, now = Date.now()) {
      if (!id) return null;
      const s = sessions.get(id);
      if (!s) return null;
      if (s.expires < now) { sessions.delete(id); return null; }
      return s.user;
    },
    destroySession(id) {
      sessions.delete(id);
    }
  };
}

function authorizeUrl({ clientId, redirectUri, state, nonce, env = "sandbox" }) {
  const base = env === "live" ? "https://www.paypal.com/connect" : SANDBOX.authorize;
  const params = new URLSearchParams({
    flowEntry: "static",
    client_id: clientId,
    response_type: "code",
    scope: "openid email",
    redirect_uri: redirectUri,
    state,
    nonce
  });
  return `${base}?${params.toString()}`;
}

// Exchanges the one-time code for an access token, then reads the verified PayPal profile.
async function exchangeCode({ code, clientId, clientSecret, redirectUri, fetchImpl = fetch }) {
  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
  const tokenRes = await fetchImpl(SANDBOX.token, {
    method: "POST",
    headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: redirectUri }).toString(),
    signal: AbortSignal.timeout(10000)
  });
  if (!tokenRes.ok) throw Object.assign(new Error("PayPal sign-in could not be completed."), { status: 401 });
  const tokens = await tokenRes.json();
  const infoRes = await fetchImpl(SANDBOX.userinfo, {
    headers: { Authorization: `Bearer ${tokens.access_token}` },
    signal: AbortSignal.timeout(10000)
  });
  if (!infoRes.ok) throw Object.assign(new Error("PayPal profile could not be read."), { status: 401 });
  const info = await infoRes.json();
  if (!info.email) throw Object.assign(new Error("PayPal did not share an email address."), { status: 401 });
  return { id: String(info.user_id || info.sub || info.email), email: info.email, name: info.name || info.given_name || info.email, provider: "paypal" };
}

function parseCookies(header) {
  const out = {};
  String(header || "").split(";").forEach(part => {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  });
  return out;
}

function sessionCookie(id, { secure = false, maxAgeSec = SESSION_MS / 1000 } = {}) {
  return `${COOKIE}=${encodeURIComponent(id)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAgeSec}${secure ? "; Secure" : ""}`;
}

function clearCookie({ secure = false } = {}) {
  return `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secure ? "; Secure" : ""}`;
}

function sessionIdFrom(req) {
  return parseCookies(req.headers.cookie)[COOKIE] || null;
}

module.exports = { createAuthStore, authorizeUrl, exchangeCode, parseCookies, sessionCookie, clearCookie, sessionIdFrom, COOKIE, SANDBOX };
