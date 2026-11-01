const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const R = require("../server/reminders.js");
const { createStore } = require("../server/store.js");

const TODAY = new Date(2026, 10, 20); // 20 November 2026
const NOW = TODAY.getTime();

function store() {
  return createStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cp-rem-")), "s.json"));
}

function sentInvoice(overrides = {}) {
  return { id: "INV2-1", number: "FP-1", status: "SENT", clientName: "Maya", customerEmail: "m@example.com", amount: 500, dueDate: "2026-11-10", ...overrides };
}

test("an unpaid invoice past its due date is found, with days late", () => {
  const list = R.findOverdue([sentInvoice()], TODAY);
  assert.equal(list.length, 1);
  assert.equal(list[0].daysLate, 10);
});

test("invoices that are not yet due, paid, cancelled or have no due date are not found", () => {
  const invoices = [
    sentInvoice({ id: "a", dueDate: "2026-11-25" }),
    sentInvoice({ id: "b", status: "PAID" }),
    sentInvoice({ id: "c", status: "CANCELLED" }),
    sentInvoice({ id: "d", dueDate: undefined }),
    sentInvoice({ id: "e", status: "DRAFT" })
  ];
  assert.deepEqual(R.findOverdue(invoices, TODAY), []);
});

test("an invoice reminded within the last week is not found again", () => {
  const recent = sentInvoice({ lastRemindedAt: new Date(NOW - 2 * 86400000).toISOString() });
  const old = sentInvoice({ id: "old", lastRemindedAt: new Date(NOW - 8 * 86400000).toISOString() });
  const ids = R.findOverdue([recent, old], TODAY, { now: NOW }).map(x => x.id);
  assert.deepEqual(ids, ["old"]);
});

test("the reminder wording states only the invoice, amount and due date", () => {
  const text = R.reminderText({ clientName: "Maya", number: "FP-1", amountUsd: 500, dueDate: "2026-11-10" });
  assert.match(text, /FP-1/);
  assert.match(text, /\$500\.00/);
  assert.match(text, /2026-11-10/);
  assert.doesNotMatch(text, /legal|court|penalty|interest/i, "no threats or invented penalties");
});

test("approving sends one PayPal reminder and records it", async () => {
  const s = store();
  s.upsert("INV2-1", sentInvoice());
  const calls = [];
  const paypal = { remindInvoice: async (id, note) => { calls.push({ id, note }); return {}; } };
  const r = await R.approveReminder("INV2-1", { store: s, paypal, now: NOW });
  assert.equal(r.sent, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].id, "INV2-1");
  assert.equal(s.get("INV2-1").reminderCount, 1);
  assert.ok(s.get("INV2-1").lastRemindedAt);
});

test("an invoice cannot be reminded twice within the weekly gap", async () => {
  const s = store();
  s.upsert("INV2-1", sentInvoice());
  const paypal = { remindInvoice: async () => ({}) };
  await R.approveReminder("INV2-1", { store: s, paypal, now: NOW });
  await assert.rejects(R.approveReminder("INV2-1", { store: s, paypal, now: NOW + 86400000 }), /less than 7 days/);
});

test("a paid invoice cannot be reminded, and nothing is sent", async () => {
  const s = store();
  s.upsert("INV2-1", sentInvoice({ status: "PAID" }));
  let called = false;
  const paypal = { remindInvoice: async () => { called = true; return {}; } };
  await assert.rejects(R.approveReminder("INV2-1", { store: s, paypal, now: NOW }), /Only sent, unpaid/);
  assert.equal(called, false);
});

test("an invoice not yet due cannot be reminded", async () => {
  const s = store();
  s.upsert("INV2-1", sentInvoice({ dueDate: "2026-12-01" }));
  await assert.rejects(R.approveReminder("INV2-1", { store: s, paypal: { remindInvoice: async () => ({}) }, now: NOW }), /not past its due date/);
});

test("the daily limit stops a burst of reminders", async () => {
  const s = store();
  for (let i = 0; i < 3; i++) {
    s.upsert(`INV2-${i}`, sentInvoice({ id: `INV2-${i}`, number: `FP-${i}`, lastRemindedAt: new Date(NOW + 1000).toISOString() }));
  }
  s.upsert("INV2-x", sentInvoice({ id: "INV2-x", number: "FP-x" }));
  await assert.rejects(R.approveReminder("INV2-x", { store: s, paypal: { remindInvoice: async () => ({}) }, now: NOW, dailyCap: 3 }), /Daily reminder limit/);
});

test("a PayPal failure is raised and the reminder is not recorded as sent", async () => {
  const s = store();
  s.upsert("INV2-1", sentInvoice());
  const paypal = { remindInvoice: async () => { throw new Error("PayPal POST failed (500)"); } };
  await assert.rejects(R.approveReminder("INV2-1", { store: s, paypal, now: NOW }), /PayPal/);
  assert.equal(s.get("INV2-1").lastRemindedAt, undefined);
});

test("snoozing sets the weekly gap without sending anything", () => {
  const s = store();
  s.upsert("INV2-1", sentInvoice());
  R.snoozeReminder("INV2-1", { store: s, now: NOW });
  assert.ok(s.get("INV2-1").lastRemindedAt);
  assert.equal(s.get("INV2-1").reminderCount, undefined);
});

test("the due date can be moved forward by a number of days", () => {
  assert.equal(R.addDaysIso("2026-11-10", 30), "2026-12-10");
  assert.equal(R.isDueDate("2026-11-10"), true);
  assert.equal(R.isDueDate("10/11/2026"), false);
});
