// Each freelancer sees and changes only their own invoices, projects and reminders.
// These tests make real HTTP requests as different people, against a live listener.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createHandler, start } = require("../server/index.js");
const { createJsonStore } = require("../server/store.js");
const { openPostgresStore } = require("../server/store-postgres.js");
const AUTH = require("../server/auth.js");
const { createRateLimiter } = require("../server/security.js");
const { emptyTables } = require("./helpers/postgres.js");

// With TEST_DATABASE_URL set (npm run test:db), every test runs against real Postgres. Otherwise the JSON file is used.
const DB_URL = process.env.TEST_DATABASE_URL || null;
const TOKEN = "test-token-".padEnd(40, "x");

// A PayPal stand-in that records what it was asked to send or remind.
function fakePayPal() {
  const sent = [];
  const reminded = [];
  let n = 0;
  return {
    sent,
    reminded,
    async createInvoice() { n += 1; return { id: `INV-${n}`, status: "DRAFT", links: [] }; },
    async sendInvoice(id) { sent.push(id); return { status: "SENT" }; },
    async getInvoice(id) { return { id, status: "DRAFT" }; },
    async remindInvoice(id) { reminded.push(id); return {}; }
  };
}

async function setup() {
  let store;
  if (DB_URL) {
    store = await openPostgresStore(DB_URL);
    await emptyTables(DB_URL);
  } else {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cp-iso-"));
    store = createJsonStore(path.join(dir, "store.json"));
  }
  const authStore = AUTH.createAuthStore();
  const paypal = fakePayPal();
  const handler = createHandler({
    paypal,
    apiToken: TOKEN,
    store,
    proofSecret: "p".repeat(40),
    publicUrl: "https://clearpaid.example",
    auth: { store: authStore, clientId: "cid", clientSecret: "sec", demoEnabled: true },
    limiter: createRateLimiter({ max: 10000, windowMs: 60000 })
  });
  const server = await start({ port: 0, env: {} });
  server.removeAllListeners("request");
  server.on("request", handler);
  const base = `http://127.0.0.1:${server.address().port}`;
  const cookieFor = user => `cp_session=${authStore.createSession(user)}`;
  return { base, store, paypal, cookieFor, close: async () => { server.close(); await store.close(); } };
}

async function call(base, p, { method = "GET", cookie, token, body } = {}) {
  const headers = {};
  if (cookie) headers.Cookie = cookie;
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body) headers["Content-Type"] = "application/json";
  const r = await fetch(base + p, { method, headers, body: body ? JSON.stringify(body) : undefined, redirect: "manual" });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { json = null; }
  return { status: r.status, json, text, headers: r.headers };
}

const maya = { id: "maya", provider: "paypal", email: "maya@example.com", name: "Maya" };
const ravi = { id: "ravi", provider: "paypal", email: "ravi@example.com", name: "Ravi" };

function invoice(number, amount = 100) {
  return { invoiceNumber: number, customerEmail: "client@example.com", customerName: "Client", amount, currency: "USD" };
}

test("one freelancer's invoices are hidden from another, who cannot read or send them", async () => {
  const t = await setup();
  try {
    const created = await call(t.base, "/api/invoices", { method: "POST", cookie: t.cookieFor(maya), body: invoice("MAYA-1") });
    assert.equal(created.status, 201);
    const id = created.json.id;

    const activity = await call(t.base, "/api/activity", { cookie: t.cookieFor(ravi) });
    assert.equal(activity.status, 200);
    assert.equal(activity.json.activity.some(e => e.invoice === "MAYA-1"), false, "not in Ravi's timeline");

    assert.equal((await call(t.base, `/api/invoices/${id}`, { cookie: t.cookieFor(ravi) })).status, 404);
    assert.equal((await call(t.base, `/api/invoices/${id}/send`, { method: "POST", cookie: t.cookieFor(ravi) })).status, 404);
    assert.deepEqual(t.paypal.sent, [], "PayPal was never asked to send Maya's invoice for Ravi");

    assert.equal((await call(t.base, `/api/invoices/${id}`, { cookie: t.cookieFor(maya) })).status, 200);
    assert.equal((await call(t.base, `/api/invoices/${id}/send`, { method: "POST", cookie: t.cookieFor(maya) })).status, 200);
    assert.deepEqual(t.paypal.sent, [id]);
  } finally {
    await t.close();
  }
});

test("invoice numbers are unique across the PayPal account, so a clash is refused", async () => {
  const t = await setup();
  try {
    assert.equal((await call(t.base, "/api/invoices", { method: "POST", cookie: t.cookieFor(maya), body: invoice("SHARED-9") })).status, 201);
    assert.equal((await call(t.base, "/api/invoices", { method: "POST", cookie: t.cookieFor(ravi), body: invoice("SHARED-9") })).status, 409);
  } finally {
    await t.close();
  }
});

test("a shared project belongs to the freelancer who made it", async () => {
  const t = await setup();
  try {
    const project = {
      name: "Brand site", clientName: "Acme", clientEmail: "acme@example.com", totalUsd: 1000,
      collaborators: [
        { name: "Maya", email: "maya@example.com", sharePct: 60 },
        { name: "Ravi", email: "ravi@example.com", sharePct: 40 }
      ]
    };
    const created = await call(t.base, "/api/projects", { method: "POST", cookie: t.cookieFor(maya), body: project });
    assert.equal(created.status, 201);
    const pid = created.json.id;
    assert.equal((await call(t.base, `/api/projects/${pid}`, { cookie: t.cookieFor(ravi) })).status, 404);
    assert.equal((await call(t.base, `/api/projects/${pid}/invoices`, { method: "POST", cookie: t.cookieFor(ravi) })).status, 404);
    assert.equal((await call(t.base, `/api/projects/${pid}`, { cookie: t.cookieFor(maya) })).status, 200);
    assert.deepEqual(t.paypal.sent, [], "nothing was sent for Ravi");
  } finally {
    await t.close();
  }
});

test("reminders list and approve only the freelancer's own overdue invoices", async () => {
  const t = await setup();
  try {
    await t.store.saveInvoice("paypal:maya", "OLD-PAY", { number: "OLD-1", status: "SENT", amount: 50, currency: "USD", customerEmail: "c@example.com", clientName: "C", dueDate: "2020-01-01", sentAt: "2019-12-01T00:00:00Z" });
    assert.equal((await call(t.base, "/api/reminders", { cookie: t.cookieFor(ravi) })).json.reminders.length, 0);
    const mine = await call(t.base, "/api/reminders", { cookie: t.cookieFor(maya) });
    assert.deepEqual(mine.json.reminders.map(r => r.id), ["OLD-PAY"]);
    assert.equal((await call(t.base, "/api/reminders/OLD-PAY/approve", { method: "POST", cookie: t.cookieFor(ravi) })).status, 404);
    assert.equal((await call(t.base, "/api/reminders/OLD-PAY/snooze", { method: "POST", cookie: t.cookieFor(ravi) })).status, 404);
    assert.deepEqual(t.paypal.reminded, [], "no reminder went out for Ravi");
    assert.equal((await call(t.base, "/api/reminders/OLD-PAY/approve", { method: "POST", cookie: t.cookieFor(maya) })).status, 200);
    assert.deepEqual(t.paypal.reminded, ["OLD-PAY"]);
  } finally {
    await t.close();
  }
});

test("a proof can be made only by the owner, and its public page shows no client details", async () => {
  const t = await setup();
  try {
    await t.store.saveInvoice("paypal:maya", "PROOF-ID", { number: "PROOF-1", status: "SENT", amount: 75, currency: "USD", customerEmail: "secret-client@example.com", sentAt: "2026-11-01T09:00:00Z" });
    assert.equal((await call(t.base, "/api/invoices/PROOF-ID/proof", { method: "POST", cookie: t.cookieFor(ravi) })).status, 404);
    const made = await call(t.base, "/api/invoices/PROOF-ID/proof", { method: "POST", cookie: t.cookieFor(maya) });
    assert.equal(made.status, 201);
    const page = await call(t.base, new URL(made.json.verifyUrl).pathname);
    assert.equal(page.status, 200);
    assert.match(page.text, /PROOF-1/);
    assert.doesNotMatch(page.text, /secret-client@example\.com/);
  } finally {
    await t.close();
  }
});

test("each demo visitor has their own data, and demo visitors cannot send", async () => {
  const t = await setup();
  try {
    const demoCookie = async () => {
      const r = await call(t.base, "/auth/demo");
      assert.equal(r.status, 302);
      return r.headers.get("set-cookie").split(";")[0];
    };
    const first = await demoCookie();
    const second = await demoCookie();
    assert.notEqual(first, second, "each visit gets its own session");
    const made = await call(t.base, "/api/invoices", { method: "POST", cookie: first, body: invoice("DEMO-1") });
    assert.equal(made.status, 201);
    const other = await call(t.base, "/api/activity", { cookie: second });
    assert.equal(other.json.activity.some(e => e.invoice === "DEMO-1"), false, "the second visitor cannot see the first's invoice");
    const send = await call(t.base, `/api/invoices/${made.json.id}/send`, { method: "POST", cookie: first });
    assert.equal(send.status, 403, "demo accounts cannot send");
    assert.deepEqual(t.paypal.sent, []);
  } finally {
    await t.close();
  }
});

test("the developer access token has its own records, separate from every signed-in freelancer", async () => {
  const t = await setup();
  try {
    assert.equal((await call(t.base, "/api/invoices", { method: "POST", token: TOKEN, body: invoice("DEV-1") })).status, 201);
    const asMaya = await call(t.base, "/api/activity", { cookie: t.cookieFor(maya) });
    assert.equal(asMaya.json.activity.some(e => e.invoice === "DEV-1"), false, "Maya cannot see the developer's invoice");
    const asDev = await call(t.base, "/api/activity", { token: TOKEN });
    assert.equal(asDev.json.activity.some(e => e.invoice === "DEV-1"), true, "the developer sees their own invoice");
  } finally {
    await t.close();
  }
});

test("demo sign-in returns only to the app's own desktop or phone pages", async () => {
  const t = await setup();
  try {
    const back = async next => {
      const query = next === undefined ? "" : `?next=${encodeURIComponent(next)}`;
      return (await call(t.base, `/auth/demo${query}`)).headers.get("location");
    };
    assert.equal(await back("/freelancer/desktop/invoices.html"), "/freelancer/desktop/invoices.html");
    assert.equal(await back("/freelancer/mobile/index.html"), "/freelancer/mobile/index.html");
    assert.equal(await back("/freelancer/desktop/"), "/freelancer/desktop/");
    assert.equal(await back("https://evil.example/"), "/app", "other sites are refused");
    assert.equal(await back("//evil.example/x"), "/app", "protocol-relative addresses are refused");
    assert.equal(await back("/freelancer/server/x.js"), "/app", "other folders are refused");
    assert.equal(await back("/freelancer/desktop/../../server/index.js"), "/app", "path tricks are refused");
    assert.equal(await back(undefined), "/app", "no return address gives the normal entry point");
  } finally {
    await t.close();
  }
});

test("health says which storage is in use", async () => {
  const t = await setup();
  try {
    const r = await call(t.base, "/api/health");
    assert.equal(r.json.storage, DB_URL ? "postgres" : "json file");
  } finally {
    await t.close();
  }
});
