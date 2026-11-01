const test = require("node:test");
const assert = require("node:assert/strict");
const L = require("../freelancer/lib/ledger.js");

const rows = [
  { paidAt: "2026-10-20T09:00:00Z", number: "FP-2", clientName: "Maya, Berlin", amountUsd: 500, rate: 84, receivingFeePct: 4.4 },
  { paidAt: "2026-10-05T09:00:00Z", number: "FP-1", clientName: "Acme", amountUsd: 1000, rate: 83, receivingFeePct: 4 },
  { paidAt: null, number: "FP-3", clientName: "Pending client", amountUsd: 200, rate: 84 },
  { paidAt: "2026-10-12T09:00:00Z", number: "FP-4", clientName: "No rate yet", amountUsd: 300, rate: 0 }
];

test("rows are sorted by receipt date and totals add up", () => {
  const l = L.buildLedger(rows);
  assert.deepEqual(l.rows.map(r => r.number), ["FP-1", "FP-2"]);
  assert.equal(l.totals.usd, 1500);
});

test("gross is USD times the rate; net is after the fee", () => {
  const l = L.buildLedger([rows[1]]);
  const r = l.rows[0];
  assert.equal(r.gross, 83000);
  assert.equal(r.fee, 40);
  assert.equal(r.net, Math.round((1000 - 40) * 83));
});

test("rows without a date or without a rate are listed as missing, not dropped silently", () => {
  const l = L.buildLedger(rows);
  assert.equal(l.missing.length, 2);
  assert.ok(l.missing.some(m => m.problem === "no receipt date"));
  assert.ok(l.missing.some(m => m.problem === "no rate entered"));
});

test("a month filter keeps only that month", () => {
  const l = L.buildLedger(rows, { month: "2026-10" });
  assert.equal(l.rows.length, 2);
  assert.equal(L.buildLedger(rows, { month: "2026-09" }).rows.length, 0);
});

test("CSV has a header, one line per row, a total, and CRLF endings", () => {
  const csv = L.toCsv(L.buildLedger(rows));
  const lines = csv.trimEnd().split("\r\n");
  assert.equal(lines[0], L.COLUMNS.map(L.safeCell).join(","));
  assert.equal(lines.length, 1 + 2 + 1);
  assert.match(lines[lines.length - 1], /^Total,/);
});

test("a client name with a comma is quoted, and quotes are doubled", () => {
  const l = L.buildLedger([{ paidAt: "2026-10-20T09:00:00Z", number: "X", clientName: 'Maya, "M" Studio', amountUsd: 10, rate: 80 }]);
  const csv = L.toCsv(l);
  assert.match(csv, /"Maya, ""M"" Studio"/);
});

test("formula injection is neutralised: a cell starting with = is prefixed", () => {
  assert.equal(L.safeCell("=1+1"), "'=1+1");
  assert.equal(L.safeCell("=HYPERLINK(\"http://x\")"), "\"'=HYPERLINK(\"\"http://x\"\")\"");
  assert.equal(L.safeCell("+SUM(A1)").startsWith("'+"), true);
  assert.equal(L.safeCell("-2"), "'-2");
  assert.equal(L.safeCell("@cmd").startsWith("'@"), true);
  assert.equal(L.safeCell("Normal name"), "Normal name");
});

test("a malicious client name in the export cannot start a formula", () => {
  const l = L.buildLedger([{ paidAt: "2026-10-20T09:00:00Z", number: "X", clientName: "=cmd|' /C calc'!A0", amountUsd: 10, rate: 80 }]);
  const line = L.toCsv(l).split("\r\n")[1];
  assert.ok(!/^=|,=/.test(line), "no unescaped formula at the start of a cell");
});
