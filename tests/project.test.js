const test = require("node:test");
const assert = require("node:assert/strict");
const P = require("../server/project.js");

const people = [
  { name: "Asha", email: "asha@example.com", sharePct: 50 },
  { name: "Ravi", email: "ravi@example.com", sharePct: 30 },
  { name: "Meera", email: "meera@example.com", sharePct: 20 }
];
const base = { name: "Brand site", clientName: "Acme", clientEmail: "client@example.com", totalUsd: 1000, collaborators: people };

test("shares that add up to 100 pass validation", () => {
  assert.deepEqual(P.validateProject(base), []);
});

test("shares that do not add up to 100 are refused, with the actual total", () => {
  const errors = P.validateProject({ ...base, collaborators: [{ ...people[0], sharePct: 40 }, people[1]] });
  assert.ok(errors.some(e => /must add up to 100 \(now 70\.00\)/.test(e)));
});

test("fewer than two people, or duplicate emails, are refused", () => {
  assert.ok(P.validateProject({ ...base, collaborators: [people[0]] }).some(e => /between 2 and 10/.test(e)));
  const dup = [people[0], { ...people[1], email: "ASHA@example.com", sharePct: 50 }];
  assert.ok(P.validateProject({ ...base, collaborators: dup }).some(e => /different email/.test(e)));
});

test("bad email and zero totals are refused", () => {
  assert.ok(P.validateProject({ ...base, clientEmail: "nope" }).length > 0);
  assert.ok(P.validateProject({ ...base, totalUsd: 0 }).length > 0);
});

test("splits always add up exactly to the total, even when a share does not divide evenly", () => {
  const parts = P.splitAmounts(100, [33.33, 33.33, 33.34]);
  const sum = Math.round(parts.reduce((a, b) => a + b, 0) * 100);
  assert.equal(sum, 10000);
  parts.forEach(p => assert.ok(Math.abs(p - 33.33) <= 0.01 + 1e-9));
});

test("a 50/30/20 split of 1000 is exact", () => {
  assert.deepEqual(P.splitAmounts(1000, [50, 30, 20]), [500, 300, 200]);
});

test("buildProject gives each collaborator their own amount and id", () => {
  const p = P.buildProject("proj_1", base);
  assert.equal(p.collaborators[0].amountUsd, 500);
  assert.equal(p.collaborators[2].id, "c3");
  assert.equal(p.collaborators.reduce((s, c) => s + c.amountUsd, 0), 1000);
});

test("summary: nobody invoiced means everything is owed", () => {
  const p = P.buildProject("proj_1", base);
  const s = P.summarise(p, {});
  assert.equal(s.paidUsd, 0);
  assert.equal(s.owedUsd, 1000);
  assert.equal(s.collaborators.every(c => c.status === "not_invoiced"), true);
  assert.equal(s.complete, false);
});

test("summary: a paid share is removed from what is owed, and only that share", () => {
  const p = P.buildProject("proj_1", base);
  p.collaborators[0].invoiceId = "INV2-A";
  p.collaborators[1].invoiceId = "INV2-B";
  const s = P.summarise(p, { "INV2-A": { status: "PAID" }, "INV2-B": { status: "SENT" } });
  assert.equal(s.paidUsd, 500);
  assert.equal(s.awaitingUsd, 300);
  assert.equal(s.owedUsd, 500);
  assert.equal(s.collaborators[0].status, "paid");
  assert.equal(s.collaborators[1].status, "sent");
});

test("summary: complete only when every share is paid", () => {
  const p = P.buildProject("proj_1", base);
  p.collaborators.forEach((c, i) => { c.invoiceId = `INV2-${i}`; });
  const all = Object.fromEntries(p.collaborators.map((c, i) => [`INV2-${i}`, { status: "PAID" }]));
  const s = P.summarise(p, all);
  assert.equal(s.complete, true);
  assert.equal(s.owedUsd, 0);
});
