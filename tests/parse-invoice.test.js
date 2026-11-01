const test = require("node:test");
const assert = require("node:assert/strict");
const P = require("../freelancer/lib/parse-invoice.js");

const usInvoice = `
Acme Design Studio
Invoice #INV-2041
Date: 12 Oct 2026

Bill to:
Maya Chen
maya@berlinstudio.com

Logo design, 3 revisions    $1,000.00
Tax                         $0.00

Total: $1,250.00
Due date: 2026-11-15
`;

test("reads a labelled total, currency, invoice number, due date and client", () => {
  const r = P.parseInvoice(usInvoice);
  assert.equal(r.fields.amount.value, 1250);
  assert.equal(r.fields.amount.currency, "USD");
  assert.equal(r.fields.invoiceNumber.value, "INV-2041");
  assert.equal(r.fields.dueDate.value, "2026-11-15");
  assert.equal(r.fields.clientName.value, "Maya Chen");
  assert.equal(r.fields.clientEmail.value, "maya@berlinstudio.com");
  assert.equal(r.found, 5);
  assert.deepEqual(r.warnings, []);
});

test("a labelled total wins over a larger line item", () => {
  const r = P.findAmount("Consulting 9000.00 USD\nAmount due: USD 800.50");
  assert.equal(r.value, 800.5);
});

test("an INR invoice is read and flagged as not USD", () => {
  const r = P.parseInvoice("Invoice No: 77\nTotal: ₹45,000.00\nDue: 01/12/2026");
  assert.equal(r.fields.amount.value, 45000);
  assert.equal(r.fields.amount.currency, "INR");
  assert.ok(r.warnings.some(w => /INR/.test(w)));
  assert.equal(r.fields.dueDate.value, "2026-12-01");
});

test("a euro amount is recognised with the symbol before the number", () => {
  assert.equal(P.findAmount("Total €2,000").currency, "EUR");
});

test("text dates such as 'Nov 15, 2026' are read", () => {
  assert.equal(P.findDueDate("Payment due: Nov 15, 2026").value, "2026-11-15");
});

test("an impossible date is not returned", () => {
  assert.equal(P.findDueDate("Due: 31/02/2026"), null);
});

test("an invoice with no money figure gives a clear warning, not a guess", () => {
  const r = P.parseInvoice("Hello, here is the document you asked for.");
  assert.equal(r.fields.amount, null);
  assert.ok(r.warnings.some(w => /No total/.test(w)));
  assert.equal(r.found, 0);
});

test("an OCR-style line with a stray space in the amount still parses", () => {
  assert.equal(P.findAmount("TOTAL  $ 1,250.00").value, 1250);
});

test("the invoice word 'date' is not taken as an invoice number", () => {
  assert.equal(P.findInvoiceNumber("Invoice date: 12 Oct"), null);
});
