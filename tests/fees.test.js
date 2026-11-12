const { test } = require("node:test");
const assert = require("node:assert/strict");
const { summarizeFees, dateWindows, toRfc3339 } = require("../server/fees.js");
const { createPayPalClient } = require("../server/paypal.js");

const row = (over = {}) => ({
  transaction_info: {
    transaction_id: over.id || "T1",
    transaction_initiation_date: over.date || "2026-10-01T10:00:00+0000",
    transaction_status: over.status || "S",
    transaction_amount: { currency_code: over.currency || "USD", value: over.amount || "100.00" },
    fee_amount: { currency_code: over.currency || "USD", value: over.fee || "-4.40" },
    invoice_id: over.invoice || "INV-1"
  }
});

test("summarizeFees totals completed payments and the real fee rate", () => {
  const s = summarizeFees([row({ id: "A", amount: "100.00", fee: "-4.40" }), row({ id: "B", amount: "50.00", fee: "-2.20" })]);
  assert.equal(s.count, 2);
  assert.equal(s.grossTotal, 150);
  assert.equal(s.feeTotal, 6.6);
  assert.equal(s.effectivePct, 4.4);
});

test("summarizeFees skips pending, denied and other-currency records", () => {
  const s = summarizeFees([
    row({ id: "P", status: "P" }),
    row({ id: "D", status: "D" }),
    row({ id: "E", currency: "EUR" }),
    row({ id: "OK", amount: "10.00", fee: "-0.44" })
  ]);
  assert.equal(s.count, 1);
  assert.equal(s.grossTotal, 10);
});

test("summarizeFees counts only the freelancer's own invoices", () => {
  const s = summarizeFees(
    [row({ id: "MINE", invoice: "INV-9", amount: "20.00", fee: "-0.88" }), row({ id: "THEIRS", invoice: "INV-7", amount: "999.00", fee: "-40" })],
    { invoiceNumbers: ["INV-9"] }
  );
  assert.equal(s.count, 1);
  assert.equal(s.grossTotal, 20);
});

test("summarizeFees does not double-count a repeated transaction record", () => {
  const s = summarizeFees([row({ id: "X", amount: "30.00", fee: "-1.32" }), row({ id: "X", amount: "30.00", fee: "-1.32" })]);
  assert.equal(s.count, 1);
});

test("summarizeFees returns no rate when there is nothing to measure", () => {
  const s = summarizeFees([]);
  assert.equal(s.count, 0);
  assert.equal(s.effectivePct, null);
});

test("dateWindows keeps every window within PayPal's 31-day limit and covers the range", () => {
  const now = new Date("2026-11-09T12:00:00Z");
  const windows = dateWindows(90, now);
  assert.ok(windows.length >= 3);
  for (const w of windows) {
    const span = (Date.parse(w.endDate) - Date.parse(w.startDate)) / 86400000;
    assert.ok(span <= 31, `window too long: ${span}`);
    assert.match(w.startDate, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  }
  assert.equal(windows[windows.length - 1].endDate, toRfc3339(now));
});

function fakeFetch(handler) {
  const calls = [];
  const fn = async (url, init = {}) => {
    let body;
    try { body = init.body ? JSON.parse(init.body) : undefined; } catch { body = init.body; }
    calls.push({ url, method: init.method || "GET", body });
    if (url.endsWith("/v1/oauth2/token")) return new Response(JSON.stringify({ access_token: "t", expires_in: 3600 }), { status: 200 });
    return handler(url, init);
  };
  return { fn, calls };
}

test("createOrder sends a CAPTURE order with the invoice id and returns the approve link", async () => {
  const { fn, calls } = fakeFetch(() => new Response(JSON.stringify({
    id: "ORDER1", status: "CREATED",
    links: [{ rel: "self", href: "x" }, { rel: "approve", href: "https://www.sandbox.paypal.com/checkoutnow?token=ORDER1" }]
  }), { status: 201 }));
  const client = createPayPalClient({ clientId: "c", clientSecret: "s", fetchImpl: fn, base: "https://fake" });
  const out = await client.createOrder({ amount: 250, currency: "USD", customId: "INV-42", description: "Invoice INV-42", returnUrl: "https://x/r", cancelUrl: "https://x/c" });
  const sent = calls.find(c => c.url.endsWith("/v2/checkout/orders"));
  assert.equal(sent.method, "POST");
  assert.equal(sent.body.intent, "CAPTURE");
  assert.equal(sent.body.purchase_units[0].custom_id, "INV-42");
  assert.equal(sent.body.purchase_units[0].amount.value, "250.00");
  assert.equal(out.id, "ORDER1");
  assert.match(out.approveUrl, /checkoutnow/);
});

test("listTransactions asks the reporting endpoint for the given window", async () => {
  const { fn, calls } = fakeFetch(() => new Response(JSON.stringify({ transaction_details: [row({ id: "Z" })] }), { status: 200 }));
  const client = createPayPalClient({ clientId: "c", clientSecret: "s", fetchImpl: fn, base: "https://fake" });
  const out = await client.listTransactions({ startDate: "2026-10-01T00:00:00Z", endDate: "2026-10-31T00:00:00Z" });
  const sent = calls.find(c => c.url.includes("/v1/reporting/transactions"));
  assert.match(sent.url, /start_date=2026-10-01T00%3A00%3A00Z/);
  assert.equal(out.transaction_details.length, 1);
});
