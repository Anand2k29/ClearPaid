const test = require("node:test");
const assert = require("node:assert/strict");
const A = require("../server/auth.js");

test("the authorize link carries client, redirect, state, nonce and the openid scope", () => {
  const url = new URL(A.authorizeUrl({ clientId: "cid", redirectUri: "http://localhost:3000/auth/paypal/callback", state: "s1", nonce: "n1" }));
  assert.equal(url.origin + url.pathname, "https://www.sandbox.paypal.com/connect");
  assert.equal(url.searchParams.get("client_id"), "cid");
  assert.equal(url.searchParams.get("scope"), "openid email");
  assert.equal(url.searchParams.get("state"), "s1");
  assert.equal(url.searchParams.get("nonce"), "n1");
  assert.equal(url.searchParams.get("response_type"), "code");
});

test("a sign-in attempt can be used only once", () => {
  const store = A.createAuthStore();
  const { state } = store.startAttempt();
  assert.ok(store.takeAttempt(state));
  assert.equal(store.takeAttempt(state), null, "second use is refused");
});

test("an unknown or expired state is refused (CSRF protection)", () => {
  const store = A.createAuthStore();
  assert.equal(store.takeAttempt("made-up"), null);
  const { state } = store.startAttempt(0);
  assert.equal(store.takeAttempt(state, 60 * 60 * 1000), null, "expired after 10 minutes");
});

test("sessions expire, and can be destroyed on sign-out", () => {
  const store = A.createAuthStore();
  const user = { id: "u1", email: "a@example.com" };
  const id = store.createSession(user, 0);
  assert.deepEqual(store.getSession(id, 1000), user);
  assert.equal(store.getSession(id, 9 * 60 * 60 * 1000), null, "expired after 8 hours");
  const id2 = store.createSession(user, 0);
  store.destroySession(id2);
  assert.equal(store.getSession(id2, 1), null);
});

test("the code exchange sends the client secret in a header and reads the verified profile", async () => {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url, opts });
    if (url.includes("oauth2/token")) return new Response(JSON.stringify({ access_token: "at-1" }), { status: 200 });
    return new Response(JSON.stringify({ user_id: "PAYER123", email: "freelancer@example.com", name: "Asha" }), { status: 200 });
  };
  const user = await A.exchangeCode({ code: "c1", clientId: "cid", clientSecret: "sec", redirectUri: "http://localhost/cb", fetchImpl });
  assert.deepEqual(user, { id: "PAYER123", email: "freelancer@example.com", name: "Asha", provider: "paypal" });
  assert.equal(calls[0].opts.headers.Authorization, "Basic " + Buffer.from("cid:sec").toString("base64"));
  assert.match(calls[0].opts.body, /grant_type=authorization_code/);
  assert.equal(calls[1].opts.headers.Authorization, "Bearer at-1");
  assert.ok(!calls[0].url.includes("sec"), "secret is never in the URL");
});

test("a failed token exchange is refused without leaking PayPal's response", async () => {
  const fetchImpl = async () => new Response("{\"error\":\"invalid_grant\",\"secret\":\"x\"}", { status: 400 });
  await assert.rejects(A.exchangeCode({ code: "bad", clientId: "a", clientSecret: "b", redirectUri: "r", fetchImpl }), /could not be completed/);
});

test("a profile without an email is refused", async () => {
  const fetchImpl = async (url) => url.includes("oauth2/token")
    ? new Response(JSON.stringify({ access_token: "t" }), { status: 200 })
    : new Response(JSON.stringify({ user_id: "x" }), { status: 200 });
  await assert.rejects(A.exchangeCode({ code: "c", clientId: "a", clientSecret: "b", redirectUri: "r", fetchImpl }), /did not share an email/);
});

test("the session cookie is HttpOnly, SameSite and Secure when served over HTTPS", () => {
  const c = A.sessionCookie("abc", { secure: true });
  assert.match(c, /HttpOnly/);
  assert.match(c, /SameSite=Lax/);
  assert.match(c, /; Secure/);
  assert.match(A.clearCookie(), /Max-Age=0/);
});

test("the session id is read from the cookie header", () => {
  assert.equal(A.sessionIdFrom({ headers: { cookie: "x=1; cp_session=abc%20def; y=2" } }), "abc def");
  assert.equal(A.sessionIdFrom({ headers: {} }), null);
});
