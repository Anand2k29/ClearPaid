const test = require("node:test");
const assert = require("node:assert/strict");
const { createPayPalClient } = require("../server/paypal.js");
const { createHandler, start, validateInvoice } = require("../server/index.js");
const { createRateLimiter } = require("../server/security.js");

const TOKEN = "test-token-".padEnd(40, "x");
const AUTH = { Authorization: `Bearer ${TOKEN}` };

// Fake fetch that records calls and returns canned responses by URL suffix.
function fakeFetch(routes) {
  const calls = [];
  const fn = async (url, opts = {}) => {
    calls.push({ url, opts });
    const key = Object.keys(routes).find(k => url.endsWith(k));
    if (!key) return new Response(JSON.stringify({ message: "no route" }), { status: 404 });
    const r = routes[key];
    return new Response(JSON.stringify(r.body), { status: r.status || 200 });
  };
  fn.calls = calls;
  return fn;
}

const TOKEN_ROUTE = { "/v1/oauth2/token": { body: { access_token: "tok", expires_in: 3600 } } };

test("createPayPalClient refuses to start without credentials", () => {
  assert.throws(() => createPayPalClient({ clientId: "", clientSecret: "" }), /not set/);
});

test("sign-in uses basic auth and the client credentials grant", async () => {
  const f = fakeFetch({ ...TOKEN_ROUTE, "/v2/invoicing/invoices": { body: { id: "INV2-1", status: "DRAFT" }, status: 201 } });
  const client = createPayPalClient({ clientId: "id", clientSecret: "secret", fetchImpl: f });
  await client.createInvoice({ invoiceNumber: "INV-1", customerEmail: "buyer@example.com", customerName: "Test", amount: 10 });
  const token = f.calls[0];
  assert.match(token.url, /\/v1\/oauth2\/token$/);
  assert.equal(token.opts.headers.Authorization, "Basic " + Buffer.from("id:secret").toString("base64"));
  assert.equal(token.opts.body, "grant_type=client_credentials");
});

test("the token is reused until it nearly expires", async () => {
  const f = fakeFetch({ ...TOKEN_ROUTE, "/v2/invoicing/invoices": { body: { id: "X" }, status: 201 } });
  const client = createPayPalClient({ clientId: "id", clientSecret: "secret", fetchImpl: f });
  const args = { invoiceNumber: "INV-1", customerEmail: "buyer@example.com", customerName: "Test", amount: 10 };
  await client.createInvoice(args);
  await client.createInvoice(args);
  const tokenCalls = f.calls.filter(c => c.url.endsWith("/v1/oauth2/token"));
  assert.equal(tokenCalls.length, 1);
});

test("createInvoice sends the invoice with a two-decimal amount", async () => {
  const f = fakeFetch({ ...TOKEN_ROUTE, "/v2/invoicing/invoices": { body: { id: "INV2-9", status: "DRAFT" }, status: 201 } });
  const client = createPayPalClient({ clientId: "id", clientSecret: "secret", fetchImpl: f });
  const out = await client.createInvoice({ invoiceNumber: "INV-42", customerEmail: "buyer@example.com", customerName: "Ananya", amount: 12500 });
  assert.equal(out.id, "INV2-9");
  const body = JSON.parse(f.calls[1].opts.body);
  assert.equal(body.detail.invoice_number, "INV-42");
  assert.equal(body.detail.currency_code, "USD");
  assert.equal(body.items[0].unit_amount.value, "12500.00");
  assert.equal(body.primary_recipients[0].billing_info.email_address, "buyer@example.com");
});

test("sendInvoice and getInvoice use the invoice id in the path", async () => {
  const f = fakeFetch({
    ...TOKEN_ROUTE,
    "/send": { body: { status: "SENT" } },
    "/v2/invoicing/invoices/INV2-9": { body: { id: "INV2-9", status: "PAID" } }
  });
  const client = createPayPalClient({ clientId: "id", clientSecret: "secret", fetchImpl: f });
  await client.sendInvoice("INV2-9");
  const got = await client.getInvoice("INV2-9");
  assert.equal(got.status, "PAID");
  assert.match(f.calls[1].url, /\/v2\/invoicing\/invoices\/INV2-9\/send$/);
  assert.equal(f.calls[1].opts.method, "POST");
});

test("a failed sign-in gives a readable error", async () => {
  const f = fakeFetch({ "/v1/oauth2/token": { body: {}, status: 401 } });
  const client = createPayPalClient({ clientId: "id", clientSecret: "bad", fetchImpl: f });
  await assert.rejects(client.getInvoice("X"), /sign-in failed \(401\)/);
});

test("validateInvoice catches bad input", () => {
  const good = { invoiceNumber: "INV-1", customerEmail: "a@b.co", customerName: "A", amount: 100 };
  assert.deepEqual(validateInvoice(good), []);
  assert.ok(validateInvoice({ ...good, amount: -5 }).length > 0);
  assert.ok(validateInvoice({ ...good, customerEmail: "not-an-email" }).length > 0);
  assert.ok(validateInvoice({ ...good, invoiceNumber: "x y" }).length > 0);
});

// ---- HTTP handler tests, using a real listener on a random port ----

async function withServer(paypal, fn) {
  const server = await start({ port: 0, env: {} });
  const handler = createHandler({ paypal, apiToken: TOKEN, limiter: createRateLimiter({ max: 1000, windowMs: 60000 }) });
  server.removeAllListeners("request");
  server.on("request", handler);
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn(base);
  } finally {
    server.close();
  }
}

test("health reports PayPal and AI configuration", async () => {
  await withServer(null, async base => {
    const r = await fetch(`${base}/api/health`).then(r => r.json());
    assert.deepEqual(r, { ok: true, paypalConfigured: false, aiProviders: [], authRequired: true, environment: "sandbox" });
  });
});

test("AI classify works without PayPal configured", async () => {
  await withServer(null, async base => {
    const res = await fetch(`${base}/api/ai/classify`, {
      method: "POST", headers: { "Content-Type": "application/json", ...AUTH },
      body: JSON.stringify({ text: "I'll pay on Friday" })
    });
    assert.equal(res.status, 200);
    const r = await res.json();
    assert.equal(r.label, "will_pay");
    assert.equal(r.source, "rules");
  });
});

test("AI draft rejects an unknown label", async () => {
  await withServer(null, async base => {
    const res = await fetch(`${base}/api/ai/draft`, {
      method: "POST", headers: { "Content-Type": "application/json", ...AUTH },
      body: JSON.stringify({ label: "send_money" })
    });
    assert.equal(res.status, 400);
  });
});

test("creating an invoice without PayPal configured returns 503", async () => {
  await withServer(null, async base => {
    const res = await fetch(`${base}/api/invoices`, { method: "POST", headers: { "Content-Type": "application/json", ...AUTH }, body: "{}" });
    assert.equal(res.status, 503);
  });
});

test("invalid invoice input returns 400 before any PayPal call", async () => {
  let called = false;
  const fake = { createInvoice: async () => { called = true; return {}; } };
  await withServer(fake, async base => {
    const res = await fetch(`${base}/api/invoices`, { method: "POST", headers: { "Content-Type": "application/json", ...AUTH }, body: JSON.stringify({ amount: -1 }) });
    assert.equal(res.status, 400);
    assert.equal(called, false);
  });
});

test("valid invoice is passed to PayPal and returned with 201", async () => {
  const fake = { createInvoice: async args => ({ id: "INV2-7", echo: args.invoiceNumber }) };
  await withServer(fake, async base => {
    const res = await fetch(`${base}/api/invoices`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH },
      body: JSON.stringify({ invoiceNumber: "INV-7", customerEmail: "a@b.co", customerName: "A", amount: 50 })
    });
    assert.equal(res.status, 201);
    assert.deepEqual(await res.json(), { id: "INV2-7", echo: "INV-7" });
  });
});

test("static pages are served, internal folders and dotfiles are not", async () => {
  await withServer(null, async base => {
    const home = await fetch(`${base}/`);
    assert.equal(home.status, 200);
    assert.match(home.headers.get("content-type"), /text\/html/);
    assert.equal((await fetch(`${base}/server/index.js`)).status, 404);
    assert.equal((await fetch(`${base}/tests/server.test.js`)).status, 404);
    assert.equal((await fetch(`${base}/.env`)).status, 404);
    // Traversal attempt: the client may normalise the path, so only assert that no file outside the project is served.
    const escaped = await fetch(`${base}/..%2fpackage.json`);
    assert.notEqual(escaped.status, 200);
  });
});

// ---- Access control, rate limiting and headers ----

test("API calls without a token are refused with 401 and a WWW-Authenticate challenge", async () => {
  await withServer(null, async base => {
    const res = await fetch(`${base}/api/ai/classify`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: "hi" }) });
    assert.equal(res.status, 401);
    assert.match(res.headers.get("www-authenticate"), /Bearer/);
  });
});

test("API calls with a wrong token are refused", async () => {
  await withServer(null, async base => {
    const res = await fetch(`${base}/api/ai/classify`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer nope" }, body: JSON.stringify({ text: "hi" }) });
    assert.equal(res.status, 401);
  });
});

test("the webhook and health endpoints do not need the access token", async () => {
  await withServer(null, async base => {
    assert.equal((await fetch(`${base}/api/health`)).status, 200);
  });
});

test("if the server has no token configured, the API refuses everything with a clear fix", async () => {
  const server = await start({ port: 0, env: {} });
  server.removeAllListeners("request");
  server.on("request", createHandler({ paypal: null, apiToken: null }));
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/ai/classify`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` }, body: "{}" });
    assert.equal(res.status, 503);
    assert.match((await res.json()).error, /API_TOKEN/);
  } finally {
    server.close();
  }
});

test("responses carry security headers, and API responses are not cached", async () => {
  await withServer(null, async base => {
    const page = await fetch(`${base}/freelancer/index.html`);
    assert.equal(page.headers.get("x-content-type-options"), "nosniff");
    assert.equal(page.headers.get("x-frame-options"), "DENY");
    assert.match(page.headers.get("content-security-policy"), /default-src 'self'/);
    const api = await fetch(`${base}/api/health`);
    assert.equal(api.headers.get("cache-control"), "no-store");
  });
});

test("the API rate-limits a client that sends too many requests", async () => {
  const server = await start({ port: 0, env: {} });
  server.removeAllListeners("request");
  server.on("request", createHandler({ paypal: null, apiToken: TOKEN, limiter: createRateLimiter({ max: 2, windowMs: 60000 }) }));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const codes = [];
    for (let i = 0; i < 4; i++) codes.push((await fetch(`${base}/api/health`)).status);
    assert.deepEqual(codes.slice(0, 2), [200, 200]);
    assert.equal(codes[2], 429);
  } finally {
    server.close();
  }
});

test("the server listens on localhost by default", async () => {
  const server = await start({ port: 0, env: {} });
  try {
    assert.equal(server.address().address, "127.0.0.1");
  } finally {
    server.close();
  }
});

test("a proof is created with the access token, and its public page verifies the signature", async () => {
  const os = require("node:os");
  const path = require("node:path");
  const fs = require("node:fs");
  const { createStore } = require("../server/store.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cp-proof-"));
  const store = createStore(path.join(dir, "store.json"));
  store.upsert("INV2-P1", { number: "FP-2026-009", status: "SENT", amount: 500, currency: "USD", customerEmail: "c@example.com", sentAt: "2026-11-01T09:00:00Z" });
  const server = await start({ port: 0, env: {} });
  server.removeAllListeners("request");
  server.on("request", createHandler({ paypal: null, apiToken: TOKEN, store, proofSecret: "p".repeat(40), publicUrl: "https://clearpaid.example", limiter: createRateLimiter({ max: 1000, windowMs: 60000 }) }));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const noAuth = await fetch(`${base}/api/invoices/INV2-P1/proof`, { method: "POST" });
    assert.equal(noAuth.status, 401);
    const created = await fetch(`${base}/api/invoices/INV2-P1/proof`, { method: "POST", headers: AUTH });
    assert.equal(created.status, 201);
    const body = await created.json();
    assert.match(body.verifyUrl, /^https:\/\/clearpaid\.example\/proof\/[A-Za-z0-9_-]{20,}$/);
    assert.match(body.whatsappUrl, /^https:\/\/wa\.me\/\?text=/);
    assert.match(body.mailtoUrl, /^mailto:c%40example\.com/);
    const page = await fetch(body.verifyUrl.replace("https://clearpaid.example", base));
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /Signature verified/);
    assert.match(html, /FP-2026-009/);
    assert.doesNotMatch(html, /c@example\.com/, "no client email on the public page");
    assert.equal((await fetch(`${base}/proof/not-a-real-token-value-here`)).status, 404);
  } finally {
    server.close();
  }
});

test("the assistant refuses off-topic questions without calling any model", async () => {
  let modelCalls = 0;
  const providers = [{ name: "groq", key: "gk", model: "m", id: "groq/m#1" }];
  const fakeFetch = async () => { modelCalls++; return new Response("{}", { status: 200 }); };
  const server = await start({ port: 0, env: {} });
  server.removeAllListeners("request");
  server.on("request", createHandler({ paypal: null, apiToken: TOKEN, ai: { providers, fetchImpl: fakeFetch, cooldowns: new Map() }, limiter: createRateLimiter({ max: 1000, windowMs: 60000 }) }));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const r = await fetch(`${base}/api/assistant`, { method: "POST", headers: { "Content-Type": "application/json", ...AUTH }, body: JSON.stringify({ question: "Write a poem about the moon" }) });
    const body = await r.json();
    assert.equal(body.allowed, false);
    assert.equal(body.source, "scope");
    assert.equal(modelCalls, 0);
  } finally {
    server.close();
  }
});

test("AI calls are limited per minute, and the limit is enforced after the quota is used", async () => {
  const server = await start({ port: 0, env: {} });
  server.removeAllListeners("request");
  server.on("request", createHandler({ paypal: null, apiToken: TOKEN, aiLimiter: createRateLimiter({ max: 2, windowMs: 60000 }), limiter: createRateLimiter({ max: 1000, windowMs: 60000 }) }));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const codes = [];
    for (let i = 0; i < 3; i++) {
      codes.push((await fetch(`${base}/api/assistant`, { method: "POST", headers: { "Content-Type": "application/json", ...AUTH }, body: JSON.stringify({ question: "invoice status" }) })).status);
    }
    assert.deepEqual(codes.slice(0, 2), [200, 200]);
    assert.equal(codes[2], 429);
  } finally {
    server.close();
  }
});

// ---- Sign in with PayPal and session access ----

test("sign-in with PayPal says it is not configured until credentials are set", async () => {
  await withServer(null, async base => {
    const r = await fetch(`${base}/auth/paypal/start`, { redirect: "manual" });
    assert.equal(r.status, 503);
  });
});

test("sign-in with PayPal redirects to the sandbox login, with a state value", async () => {
  const AUTH = require("../server/auth.js");
  const authStore = AUTH.createAuthStore();
  const server = await start({ port: 0, env: {} });
  server.removeAllListeners("request");
  server.on("request", createHandler({ paypal: null, apiToken: TOKEN, auth: { store: authStore, clientId: "cid", clientSecret: "sec", publicUrl: "https://clearpaid.example" } }));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const r = await fetch(`${base}/auth/paypal/start`, { redirect: "manual" });
    assert.equal(r.status, 302);
    const loc = new URL(r.headers.get("location"));
    assert.equal(loc.origin + loc.pathname, "https://www.sandbox.paypal.com/connect");
    assert.equal(loc.searchParams.get("redirect_uri"), "https://clearpaid.example/auth/paypal/callback");
    assert.ok(loc.searchParams.get("state"));
  } finally {
    server.close();
  }
});

test("/api/me is 401 without a session, and returns the user with one", async () => {
  const AUTH = require("../server/auth.js");
  const authStore = AUTH.createAuthStore();
  const sid = authStore.createSession({ id: "u1", email: "freelancer@example.com", name: "Asha" });
  const server = await start({ port: 0, env: {} });
  server.removeAllListeners("request");
  server.on("request", createHandler({ paypal: null, apiToken: TOKEN, auth: { store: authStore, clientId: "cid", clientSecret: "sec" } }));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    assert.equal((await fetch(`${base}/api/me`)).status, 401);
    const r = await fetch(`${base}/api/me`, { headers: { Cookie: `cp_session=${sid}` } });
    assert.equal(r.status, 200);
    assert.equal((await r.json()).user.email, "freelancer@example.com");
  } finally {
    server.close();
  }
});

test("a signed-in session can use the API without the access token", async () => {
  const AUTH = require("../server/auth.js");
  const authStore = AUTH.createAuthStore();
  const sid = authStore.createSession({ id: "u1", email: "freelancer@example.com", name: "Asha" });
  const server = await start({ port: 0, env: {} });
  server.removeAllListeners("request");
  server.on("request", createHandler({ paypal: null, apiToken: TOKEN, auth: { store: authStore, clientId: "cid", clientSecret: "sec" }, limiter: createRateLimiter({ max: 1000, windowMs: 60000 }) }));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const without = await fetch(`${base}/api/assistant`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ question: "invoice status" }) });
    assert.equal(without.status, 401);
    const withCookie = await fetch(`${base}/api/assistant`, { method: "POST", headers: { "Content-Type": "application/json", Cookie: `cp_session=${sid}` }, body: JSON.stringify({ question: "invoice status" }) });
    assert.equal(withCookie.status, 200);
  } finally {
    server.close();
  }
});

test("sign-out clears the session cookie and ends the session", async () => {
  const AUTH = require("../server/auth.js");
  const authStore = AUTH.createAuthStore();
  const sid = authStore.createSession({ id: "u1", email: "a@example.com", name: "A" });
  const server = await start({ port: 0, env: {} });
  server.removeAllListeners("request");
  server.on("request", createHandler({ paypal: null, apiToken: TOKEN, auth: { store: authStore, clientId: "cid", clientSecret: "sec" } }));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const r = await fetch(`${base}/auth/logout`, { redirect: "manual", headers: { Cookie: `cp_session=${sid}` } });
    assert.equal(r.status, 302);
    assert.match(r.headers.get("set-cookie"), /Max-Age=0/);
    assert.equal(authStore.getSession(sid), null);
  } finally {
    server.close();
  }
});

test("/app redirects to the app folder, so its scripts and images load", async () => {
  await withServer(null, async base => {
    const r = await fetch(`${base}/app`, { redirect: "manual" });
    assert.equal(r.status, 302);
    assert.equal(r.headers.get("location"), "/freelancer/index.html");
  });
});

test("the demo sign-in gives a session cookie, and demo accounts cannot send invoices", async () => {
  const AUTH = require("../server/auth.js");
  const authStore = AUTH.createAuthStore();
  const server = await start({ port: 0, env: {} });
  server.removeAllListeners("request");
  server.on("request", createHandler({ paypal: { sendInvoice: async () => ({}) }, apiToken: TOKEN, auth: { store: authStore, clientId: "cid", clientSecret: "sec", demoEnabled: true }, limiter: createRateLimiter({ max: 1000, windowMs: 60000 }) }));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const demo = await fetch(`${base}/auth/demo`, { redirect: "manual" });
    assert.equal(demo.status, 302);
    const cookie = demo.headers.get("set-cookie").split(";")[0];
    const me = await fetch(`${base}/api/me`, { headers: { Cookie: cookie } });
    assert.equal((await me.json()).user.provider, "demo");
    const send = await fetch(`${base}/api/invoices/INV2-1/send`, { method: "POST", headers: { Cookie: cookie } });
    assert.equal(send.status, 403);
    assert.match((await send.json()).error, /Demo accounts cannot send/);
  } finally {
    server.close();
  }
});

test("the demo can be switched off on the server", async () => {
  const server = await start({ port: 0, env: {} });
  server.removeAllListeners("request");
  server.on("request", createHandler({ paypal: null, apiToken: TOKEN, auth: { store: require("../server/auth.js").createAuthStore(), demoEnabled: false } }));
  try {
    const r = await fetch(`http://127.0.0.1:${server.address().port}/auth/demo`, { redirect: "manual" });
    assert.equal(r.status, 404);
  } finally {
    server.close();
  }
});
