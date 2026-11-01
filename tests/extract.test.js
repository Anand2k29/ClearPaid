const test = require("node:test");
const assert = require("node:assert/strict");
const { extractFields } = require("../kyc/lib/extract.js");
const C = require("../kyc/lib/checks.js");

const TODAY = new Date(2026, 10, 1);

test("finds a checksum-valid Aadhaar-style number printed in groups of four", () => {
  const base = "23456789012";
  const num = base + C.verhoeffCheckDigit(base);
  const grouped = num.replace(/(\d{4})(\d{4})(\d{4})/, "$1 $2 $3");
  const r = extractFields(`Government sample\n${grouped}\nDOB 01/01/1990`, TODAY);
  assert.equal(r.aadhaar.value, num);
  assert.equal(r.aadhaar.checksumValid, true);
  assert.deepEqual(r.warnings, []);
});

test("flags an Aadhaar-style number that fails the checksum", () => {
  const r = extractFields("234567890129", TODAY);
  assert.equal(r.aadhaar.checksumValid, false);
  assert.equal(r.warnings.length, 1);
});

test("finds a PAN and checks its format", () => {
  const r = extractFields("Permanent Account Number\nABCPD1234E", TODAY);
  assert.deepEqual(r.pan, { value: "ABCPD1234E", formatValid: true });
});

test("only expiry dates get an expiry status", () => {
  const r = extractFields("Issued 01/02/2015\nExpiry 15/01/2027\nValid to 31/12/2035\nBad 31/02/2030", TODAY);
  const status = Object.fromEntries(r.dates.map(d => [d.raw, d.status]));
  assert.equal(status["01/02/2015"], "not an expiry");
  assert.equal(status["15/01/2027"], "expiring");
  assert.equal(status["31/12/2035"], "valid");
  assert.equal(status["31/02/2030"], "invalid");
});

test("a date of birth is never reported as expired", () => {
  const r = extractFields("DOB 15/08/1990\nValid till 31/12/2035", TODAY);
  const dob = r.dates.find(d => d.raw === "15/08/1990");
  assert.equal(dob.kind, "birth");
  assert.notEqual(dob.status, "expired");
});

test("no fields found gives empty results without throwing", () => {
  const r = extractFields("nothing useful here", TODAY);
  assert.equal(r.aadhaar, null);
  assert.equal(r.pan, null);
  assert.deepEqual(r.dates, []);
  assert.equal(r.mrz, null);
});
