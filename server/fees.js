// Turns PayPal transaction records into the fees a freelancer really paid.
// Pure functions, so they are tested without a network. Only completed payments (status "S") in one currency,
// and only for invoices that belong to the requesting freelancer, are counted.
const COMPLETED = "S";

function cents(v) {
  return Math.round(Number(v) * 100);
}

// details: the transaction_details array from PayPal's Transaction Search API.
// invoiceNumbers: the freelancer's own invoice numbers. Pass null only for an internal check.
function summarizeFees(details, { currency = "USD", invoiceNumbers = null } = {}) {
  const mine = invoiceNumbers ? new Set(invoiceNumbers) : null;
  const seen = new Set();
  let grossCents = 0;
  let feeCents = 0;
  let count = 0;
  for (const row of details || []) {
    const info = row.transaction_info || {};
    if (info.transaction_status !== COMPLETED) continue;
    const amount = info.transaction_amount || {};
    const fee = info.fee_amount || {};
    if (amount.currency_code !== currency || fee.currency_code !== currency) continue;
    // Transaction ids are not unique: a balance-affecting record and a related record can share one id.
    const key = `${info.transaction_id}|${info.transaction_initiation_date}|${amount.value}`;
    if (seen.has(key)) continue;
    if (mine && !mine.has(info.invoice_id)) continue;
    seen.add(key);
    const gross = Number(amount.value);
    if (!(gross > 0)) continue;
    grossCents += cents(gross);
    feeCents += Math.abs(cents(fee.value));
    count += 1;
  }
  const grossTotal = grossCents / 100;
  const feeTotal = feeCents / 100;
  return {
    currency,
    count,
    grossTotal,
    feeTotal,
    effectivePct: grossTotal ? Number(((feeTotal / grossTotal) * 100).toFixed(2)) : null
  };
}

// Splits a date range into windows of at most 31 days, which is PayPal's limit per request.
// Dates are RFC 3339 strings (UTC, seconds precision).
function dateWindows(days, now = new Date()) {
  const end = new Date(now);
  const start = new Date(now.getTime() - days * 86400000);
  const windows = [];
  let cursor = start;
  while (cursor < end) {
    const next = new Date(Math.min(cursor.getTime() + 31 * 86400000, end.getTime()));
    windows.push({ startDate: toRfc3339(cursor), endDate: toRfc3339(next) });
    cursor = next;
  }
  return windows;
}

function toRfc3339(d) {
  return d.toISOString().replace(/\.\d{3}Z$/, "Z");
}

module.exports = { summarizeFees, dateWindows, toRfc3339 };
