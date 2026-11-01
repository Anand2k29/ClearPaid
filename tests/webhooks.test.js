const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createStore } = require("../server/store.js");
const { verifyWebhook, applyEvent, HEADERS } = require("../server/webhooks.js");

function tempStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fp-store-"));
  return createStore(path.join(dir, "store.json"));
}

const NOW = Date.parse("2026-11-02T10:01:00Z");
const paidEvent = { id: "WH-1", event_type: "INVOICING.INVOICE.PAID", create_time: "2026-11-02T10:00:00Z", resource: { id: "INV2-1" } };

function headers() {
  return {
    [HEADERS.authAlgo]: "SHA256withRSA",
    [HEADERS.certUrl]: "https://api.sandbox.paypal.com/cert",
    [HEADERS.transmissionId]: "t-1",
    [HEADERS.transmissionSig]: "sig",
    [HEADERS.transmissionTime]: "2026-11-02T10:00:00Z"
  };
}

test("verifyWebhook is true only when PayPal says SUCCESS, and sends the webhook id", async () => {
  let sent;
  const fetchImpl = async (url, opts) => {
    sent = { url, body: JSON.parse(opts.body), auth: opts.headers.Authorization };
    return new Response(JSON.stringify({ verification_status: "SUCCESS" }), { status: 200 });
  };
  const ok = await verifyWebhook({
    headers: headers(), rawBody: JSON.stringify(paidEvent), webhookId: "WH-ID", getToken: async () => "tok", now: NOW, fetchImpl
  });
  assert.equal(ok, true);
  assert.match(sent.url, /verify-webhook-signature$/);
  assert.equal(sent.auth, "Bearer tok");
  assert.equal(sent.body.webhook_id, "WH-ID");
  assert.equal(sent.body.transmission_sig, "sig");
  assert.deepEqual(sent.body.webhook_event, paidEvent);
});

test("verifyWebhook is false on FAILURE, and on a PayPal error", async () => {
  const failing = async () => new Response(JSON.stringify({ verification_status: "FAILURE" }), { status: 200 });
  const erroring = async () => new Response("{}", { status: 500 });
  const args = { headers: headers(), rawBody: JSON.stringify(paidEvent), webhookId: "WH-ID", getToken: async () => "tok", now: NOW };
  assert.equal(await verifyWebhook({ ...args, fetchImpl: failing }), false);
  assert.equal(await verifyWebhook({ ...args, fetchImpl: erroring }), false);
});

test("verifyWebhook refuses to run without a webhook id", async () => {
  await assert.rejects(verifyWebhook({ headers: headers(), rawBody: "{}", webhookId: null, getToken: async () => "t" }), /PAYPAL_WEBHOOK_ID/);
});

test("a PAID event marks a known invoice paid", () => {
  const store = tempStore();
  store.upsert("INV2-1", { number: "FP-1", status: "SENT" });
  const r = applyEvent(paidEvent, store);
  assert.equal(r.changed, true);
  assert.equal(store.get("INV2-1").status, "PAID");
  assert.equal(store.get("INV2-1").paidAt, "2026-11-02T10:00:00Z");
});

test("the same event delivered twice changes nothing the second time", () => {
  const store = tempStore();
  store.upsert("INV2-1", { status: "SENT" });
  applyEvent(paidEvent, store);
  const again = applyEvent(paidEvent, store);
  assert.equal(again.changed, false);
  assert.equal(again.reason, "duplicate event");
});

test("an event for an unknown invoice is ignored", () => {
  const store = tempStore();
  assert.equal(applyEvent(paidEvent, store).reason, "unknown invoice");
});

test("PAID is not undone by a later SENT update", () => {
  const store = tempStore();
  store.upsert("INV2-1", { status: "SENT" });
  applyEvent(paidEvent, store);
  store.upsert("INV2-1", { status: "SENT" });
  assert.equal(store.get("INV2-1").status, "PAID");
});

test("a cancelled event is recorded", () => {
  const store = tempStore();
  store.upsert("INV2-1", { status: "SENT" });
  const r = applyEvent({ id: "WH-2", event_type: "INVOICING.INVOICE.CANCELLED", resource: { id: "INV2-1" } }, store);
  assert.equal(r.status, "CANCELLED");
});

test("unrelated events are not handled but do not fail", () => {
  const store = tempStore();
  store.upsert("INV2-1", { status: "SENT" });
  const r = applyEvent({ id: "WH-3", event_type: "PAYMENT.CAPTURE.COMPLETED", resource: { id: "INV2-1" } }, store);
  assert.equal(r.changed, false);
});

test("the store survives a restart", () => {
  const store = tempStore();
  const file = store.file;
  store.upsert("INV2-9", { number: "FP-9", status: "SENT" });
  const reopened = createStore(file);
  assert.equal(reopened.get("INV2-9").number, "FP-9");
});

test("a webhook delivered outside the replay window is refused, even with a valid signature", async () => {
  const fetchImpl = async () => new Response(JSON.stringify({ verification_status: "SUCCESS" }), { status: 200 });
  const args = { headers: headers(), rawBody: JSON.stringify(paidEvent), webhookId: "WH-ID", getToken: async () => "tok", fetchImpl };
  assert.equal(await verifyWebhook({ ...args, now: NOW + 10 * 60 * 1000 }), false, "too late");
  assert.equal(await verifyWebhook({ ...args, now: NOW - 10 * 60 * 1000 }), false, "too early");
  assert.equal(await verifyWebhook({ ...args, now: NOW + 60 * 1000 }), true, "within the window");
});

test("a webhook without a valid timestamp is refused", async () => {
  const h = headers();
  delete h[HEADERS.transmissionTime];
  assert.equal(await verifyWebhook({ headers: h, rawBody: "{}", webhookId: "WH", getToken: async () => "t", now: NOW }), false);
});
