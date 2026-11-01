const test = require("node:test");
const assert = require("node:assert/strict");
const P = require("../server/proof.js");

const SECRET = "s".repeat(40);
const fields = { number: "FP-2026-001", amountCents: 125000, currency: "USD", issuedOn: "2026-11-01", invoiceId: "INV2-ABC" };

test("a proof built with the secret verifies, and returns the same fields", () => {
  const p = P.buildProof(fields, SECRET);
  const v = P.verifyCode(p.code, SECRET);
  assert.equal(v.valid, true);
  assert.deepEqual(v.fields, fields);
});

test("changing any field after signing breaks the signature", () => {
  const code = P.buildProof(fields, SECRET).code;
  const tampered = code.replace("125000", "999999");
  assert.equal(P.verifyCode(tampered, SECRET).valid, false);
  assert.equal(P.verifyCode(code.replace("FP-2026-001", "FP-2026-002"), SECRET).valid, false);
});

test("a proof made with a different secret does not verify", () => {
  const code = P.buildProof(fields, SECRET).code;
  assert.equal(P.verifyCode(code, "x".repeat(40)).valid, false);
});

test("text that is not a ClearPaid proof is refused", () => {
  assert.equal(P.verifyCode("hello", SECRET).valid, false);
  assert.equal(P.verifyCode("CP2|a|b|c|d|e|f", SECRET).valid, false);
});

test("signing refuses to run without a strong secret", () => {
  assert.throws(() => P.buildProof(fields, undefined), /PROOF_SECRET/);
  assert.throws(() => P.buildProof(fields, "short"), /PROOF_SECRET/);
});

test("unsafe characters in the invoice number cannot be signed (no separator injection)", () => {
  assert.throws(() => P.buildProof({ ...fields, number: "A|B" }, SECRET), /not safe/);
  assert.throws(() => P.buildProof({ ...fields, number: "A B" }, SECRET), /not safe/);
});

test("bad currency or date formats are refused", () => {
  assert.throws(() => P.buildProof({ ...fields, currency: "usd" }, SECRET), /currency/);
  assert.throws(() => P.buildProof({ ...fields, issuedOn: "01/11/2026" }, SECRET), /date/);
});

test("public proof tokens are random and long enough to be unguessable", () => {
  const a = P.newProofToken();
  const b = P.newProofToken();
  assert.notEqual(a, b);
  assert.ok(a.length >= 30);
});

test("the public page escapes text so a crafted invoice number cannot inject markup", () => {
  const html = P.proofPage({ number: "<img src=x onerror=alert(1)>", amountUsd: "$1", issuedOn: "2026-11-01", status: "SENT", verified: true });
  assert.ok(!html.includes("<img src=x"));
  assert.match(html, /&lt;img/);
});

test("the public page shows no contact details or internal ids", () => {
  const html = P.proofPage({ number: "FP-1", amountUsd: "$1", issuedOn: "2026-11-01", status: "PAID", verified: true });
  assert.doesNotMatch(html, /@/);
  assert.doesNotMatch(html, /INV2-/);
});
