const test = require("node:test");
const assert = require("node:assert/strict");
const F = require("../freelancer/calc.js");

test("with no fees and no markup the freelancer gets the full INR amount", () => {
  const r = F.netReceived(1000, { receivingFeePct: 0, conversionMarkupPct: 0, withdrawalFee: 0, midMarketRate: 83 });
  assert.equal(r.netInr, 83000);
  assert.equal(r.totalLossInr, 0);
  assert.equal(r.effectivePct, 0);
});

test("fees and markup reduce the amount in the expected order", () => {
  const r = F.netReceived(1000, { receivingFeePct: 4, conversionMarkupPct: 3, withdrawalFee: 0, midMarketRate: 80 });
  // 1000 - 4% = 960 USD; 960 x 80 = 76800 INR; minus 3% = 74496 INR
  assert.equal(r.netInr, 74496);
  assert.equal(r.idealInr, 80000);
  assert.equal(r.totalLossInr, 5504);
});

test("a flat withdrawal fee is charged in INR", () => {
  const r = F.netReceived(100, { receivingFeePct: 0, conversionMarkupPct: 0, withdrawalFee: 1, midMarketRate: 83 });
  assert.equal(r.netInr, 83 * 100 - 83);
});

test("defaults produce a loss between 5% and 10% on a typical invoice", () => {
  const r = F.netReceived(500);
  assert.ok(r.effectivePct > 5 && r.effectivePct < 10, `effective fee was ${r.effectivePct}%`);
});

test("late cost is simple interest on the INR value", () => {
  // 1000 USD at 83 INR, 12% a year, 30 days: 83000 x 0.12 x 30/365 = 818.9
  assert.equal(F.lateCostInr(1000, 30, { midMarketRate: 83, opportunityRatePct: 12 }), 819);
  assert.equal(F.lateCostInr(1000, 0), 0);
});

test("compare sorts providers from best to worst net amount", () => {
  const out = F.compare(1000, [
    { name: "Expensive", receivingFeePct: 5, conversionMarkupPct: 4, midMarketRate: 83 },
    { name: "Cheap", receivingFeePct: 1, conversionMarkupPct: 1, midMarketRate: 83 }
  ]);
  assert.equal(out[0].name, "Cheap");
  assert.ok(out[0].netInr > out[1].netInr);
});
