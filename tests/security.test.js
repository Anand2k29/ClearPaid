const test = require("node:test");
const assert = require("node:assert/strict");
const S = require("../server/security.js");

const TOKEN = "t".repeat(40);

function req(headers = {}) {
  return { headers };
}

test("a correct bearer token is accepted", () => {
  assert.equal(S.checkBearer(req({ authorization: `Bearer ${TOKEN}` }), TOKEN), null);
});

test("a missing or wrong token is refused", () => {
  assert.equal(S.checkBearer(req({}), TOKEN), "missing bearer token");
  assert.equal(S.checkBearer(req({ authorization: "Bearer " + "x".repeat(40) }), TOKEN), "invalid bearer token");
  assert.equal(S.checkBearer(req({ authorization: `Basic ${TOKEN}` }), TOKEN), "missing bearer token");
});

test("a token that is a prefix of the real one is refused", () => {
  assert.equal(S.checkBearer(req({ authorization: `Bearer ${TOKEN.slice(0, 20)}` }), TOKEN), "invalid bearer token");
});

test("if the server token is missing or too short, every request is refused", () => {
  assert.equal(S.checkBearer(req({ authorization: "Bearer short" }), "short"), "server access token is not configured");
  assert.equal(S.checkBearer(req({ authorization: `Bearer ${TOKEN}` }), undefined), "server access token is not configured");
});

test("tokensMatch is false for non-strings and different lengths", () => {
  assert.equal(S.tokensMatch(undefined, TOKEN), false);
  assert.equal(S.tokensMatch(TOKEN + "x", TOKEN), false);
  assert.equal(S.tokensMatch(TOKEN, TOKEN), true);
});

test("security headers are set, including a strict CSP and no-store for the API", () => {
  const h = {};
  const res = { setHeader: (k, v) => { h[k] = v; } };
  S.setSecurityHeaders(res, { api: true });
  assert.equal(h["X-Content-Type-Options"], "nosniff");
  assert.equal(h["X-Frame-Options"], "DENY");
  assert.match(h["Content-Security-Policy"], /default-src 'self'/);
  assert.match(h["Content-Security-Policy"], /object-src 'none'/);
  assert.match(h["Content-Security-Policy"], /frame-ancestors 'none'/);
  assert.equal(h["Cache-Control"], "no-store");
  assert.equal(h["Referrer-Policy"], "no-referrer");
});

test("the rate limiter allows the limit, then refuses with a retry time, then resets", () => {
  let t = 0;
  const rl = S.createRateLimiter({ max: 3, windowMs: 1000, now: () => t });
  assert.equal(rl.hit("ip").allowed, true);
  assert.equal(rl.hit("ip").allowed, true);
  assert.equal(rl.hit("ip").allowed, true);
  const refused = rl.hit("ip");
  assert.equal(refused.allowed, false);
  assert.ok(refused.retryAfterSec >= 1);
  t = 1000;
  assert.equal(rl.hit("ip").allowed, true, "window reset");
});

test("the rate limiter counts each address separately", () => {
  const rl = S.createRateLimiter({ max: 1, windowMs: 60000 });
  assert.equal(rl.hit("a").allowed, true);
  assert.equal(rl.hit("b").allowed, true);
  assert.equal(rl.hit("a").allowed, false);
});

test("server and provider errors never reveal their message", () => {
  const leaky = Object.assign(new Error("PayPal POST failed (500) internal stack trace xyz"), { status: 502 });
  const out = S.publicError(leaky);
  assert.equal(out.status, 502);
  assert.doesNotMatch(out.message, /PayPal|stack|xyz/);
  const unknown = S.publicError(new Error("db password is hunter2"));
  assert.equal(unknown.status, 500);
  assert.doesNotMatch(unknown.message, /hunter2/);
});

test("client errors keep their short, safe message", () => {
  const out = S.publicError(Object.assign(new Error("Request body too large"), { status: 413 }));
  assert.equal(out.status, 413);
  assert.equal(out.message, "Request body too large");
});
