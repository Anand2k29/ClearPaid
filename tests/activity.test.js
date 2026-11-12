const test = require("node:test");
const assert = require("node:assert/strict");
const { buildActivity, paypalFeatures } = require("../server/activity.js");

test("the timeline lists each PayPal step for an invoice, newest first", () => {
  const invoices = [{
    id: "INV2-1", number: "FP-1", clientName: "Maya", amount: 500,
    createdAt: "2026-11-01T09:00:00Z", sentAt: "2026-11-01T09:01:00Z",
    events: [{ id: "WH-1", type: "INVOICING.INVOICE.PAID", at: "2026-11-02T10:00:00Z" }]
  }];
  const list = buildActivity(invoices);
  assert.equal(list[0].label, "PayPal confirmed the payment");
  assert.equal(list[0].product, "PayPal Webhooks");
  assert.equal(list[list.length - 1].label, "Invoice created");
  assert.equal(list.length, 3);
});

test("every entry names the PayPal product and endpoint it came from", () => {
  const list = buildActivity([{ id: "INV2-2", number: "FP-2", createdAt: "2026-11-01T09:00:00Z", sentAt: "2026-11-01T09:01:00Z", lastRemindedAt: "2026-11-05T09:00:00Z" }]);
  assert.ok(list.every(e => e.product && e.endpoint));
  assert.ok(list.some(e => /remind$/.test(e.endpoint)));
});

test("invalid or missing dates are left out rather than shown wrongly", () => {
  const list = buildActivity([{ id: "x", number: "FP-3", createdAt: "not a date" }]);
  assert.equal(list.length, 0);
});

test("the list is limited, so the panel stays short", () => {
  const many = Array.from({ length: 50 }, (_, i) => ({ id: `i${i}`, number: `FP-${i}`, createdAt: new Date(Date.UTC(2026, 0, 1 + i)).toISOString() }));
  assert.equal(buildActivity(many, 10).length, 10);
});

test("PayPal feature switches reflect the configuration without revealing secrets", () => {
  const off = paypalFeatures({ paypalConfigured: false, webhookId: null, loginClientId: null });
  assert.equal(off.find(f => f.name === "Webhooks").on, false);
  const on = paypalFeatures({ paypalConfigured: true, webhookId: "WH-1", loginClientId: "cid" });
  assert.ok(on.every(f => typeof f.name === "string" && typeof f.on === "boolean"));
  assert.ok(!JSON.stringify(on).includes("cid"), "client id is not echoed");
});
