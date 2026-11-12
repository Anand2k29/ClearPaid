// The rules every invoice store must follow. Run against each implementation (JSON file, Postgres),
// so the hosted database and the local file behave the same way.
const test = require("node:test");
const assert = require("node:assert/strict");

// makeStore() returns { store, done } where done() releases the store and cleans up.
function storeContract(label, makeStore, { skip = false } = {}) {
  const t = (name, fn) => test(name, { skip }, fn);
  async function withStore(fn) {
    const { store, done } = await makeStore();
    try {
      await fn(store);
    } finally {
      await done();
    }
  }

  t(`${label}: an owner sees only their own invoices`, () => withStore(async store => {
    await store.saveInvoice("paypal:a", "INV-A1", { number: "A-1", status: "SENT", amount: 10 });
    await store.saveInvoice("paypal:b", "INV-B1", { number: "B-1", status: "SENT", amount: 20 });
    assert.deepEqual((await store.listInvoices("paypal:a")).map(i => i.id), ["INV-A1"]);
    assert.equal(await store.getInvoice("paypal:a", "INV-B1"), null, "A cannot read B's invoice");
    assert.equal((await store.getInvoice("paypal:b", "INV-B1")).number, "B-1");
  }));

  t(`${label}: saving to someone else's invoice is refused and changes nothing`, () => withStore(async store => {
    await store.saveInvoice("paypal:a", "INV-A1", { number: "A-1", status: "SENT", amount: 10 });
    await assert.rejects(store.saveInvoice("paypal:b", "INV-A1", { status: "PAID" }), err => err.status === 404);
    assert.equal((await store.getInvoice("paypal:a", "INV-A1")).status, "SENT");
  }));

  t(`${label}: the owner of a record cannot be changed by a later save`, () => withStore(async store => {
    await store.saveInvoice("paypal:a", "INV-A1", { number: "A-1", status: "SENT" });
    await store.saveInvoice("paypal:a", "INV-A1", { ownerId: "paypal:b", status: "SENT" });
    assert.equal((await store.getInvoice("paypal:a", "INV-A1")).ownerId, "paypal:a");
    assert.equal(await store.getInvoice("paypal:b", "INV-A1"), null);
  }));

  t(`${label}: findByNumber and findByProofToken look across owners`, () => withStore(async store => {
    await store.saveInvoice("paypal:a", "INV-A1", { number: "SHARED-1", status: "SENT", proofToken: "tok-abcdefghijklmnopqrstu" });
    assert.equal((await store.findByNumber("SHARED-1")).id, "INV-A1");
    assert.equal((await store.findByNumber("NOPE")), null);
    assert.equal((await store.findByProofToken("tok-abcdefghijklmnopqrstu")).id, "INV-A1");
    assert.equal(await store.findByProofToken("missing"), null);
  }));

  t(`${label}: a PAID invoice is never moved back to an earlier status`, () => withStore(async store => {
    await store.saveInvoice("paypal:a", "INV-A1", { status: "SENT" });
    await store.updateInvoice("INV-A1", { status: "PAID", paidAt: "2026-11-02T10:00:00Z" });
    await store.saveInvoice("paypal:a", "INV-A1", { status: "SENT" });
    assert.equal((await store.getInvoice("paypal:a", "INV-A1")).status, "PAID");
  }));

  t(`${label}: simultaneous deliveries of one webhook event are recorded once`, () => withStore(async store => {
    await store.saveInvoice("paypal:a", "INV-A1", { status: "SENT" });
    const results = await Promise.all(Array.from({ length: 5 }, () => store.recordEvent("INV-A1", { id: "WH-9", type: "X" })));
    assert.equal(results.filter(Boolean).length, 1);
    assert.equal((await store.getInvoice("paypal:a", "INV-A1")).events.length, 1);
  }));

  t(`${label}: a webhook event is recorded once, and only for a known invoice`, () => withStore(async store => {
    await store.saveInvoice("paypal:a", "INV-A1", { status: "SENT" });
    assert.equal(await store.recordEvent("INV-A1", { id: "WH-1", type: "X" }), true);
    assert.equal(await store.recordEvent("INV-A1", { id: "WH-1", type: "X" }), false);
    assert.equal(await store.recordEvent("UNKNOWN", { id: "WH-2", type: "X" }), false);
    assert.equal((await store.getInvoice("paypal:a", "INV-A1")).events.length, 1);
  }));

  t(`${label}: an internal update keeps the owner, and an unknown id gives null`, () => withStore(async store => {
    await store.saveInvoice("paypal:a", "INV-A1", { status: "SENT" });
    const next = await store.updateInvoice("INV-A1", { status: "CANCELLED" });
    assert.equal(next.ownerId, "paypal:a");
    assert.equal(await store.updateInvoice("NOPE", { status: "PAID" }), null);
    assert.equal((await store.findInvoice("INV-A1")).status, "CANCELLED", "findInvoice sees any owner's record");
  }));

  t(`${label}: projects are scoped to their owner`, () => withStore(async store => {
    await store.saveProject("paypal:a", { id: "proj-1", name: "Site", collaborators: [] });
    assert.equal((await store.getProject("paypal:a", "proj-1")).name, "Site");
    assert.equal(await store.getProject("paypal:b", "proj-1"), null);
    await assert.rejects(store.saveProject("paypal:b", { id: "proj-1", name: "Hijack" }), err => err.status === 404);
    assert.equal((await store.getProject("paypal:a", "proj-1")).name, "Site");
  }));

  t(`${label}: nested data survives a round trip`, () => withStore(async store => {
    const links = [{ rel: "self", href: "https://api-m.sandbox.paypal.com/v2/invoicing/invoices/INV-A1" }];
    await store.saveInvoice("paypal:a", "INV-A1", { number: "A-1", status: "SENT", amount: 12.5, links });
    const rec = await store.getInvoice("paypal:a", "INV-A1");
    assert.deepEqual(rec.links, links);
    assert.equal(rec.amount, 12.5);
  }));

  t(`${label}: a returned record is a copy, so editing it changes nothing stored`, () => withStore(async store => {
    await store.saveInvoice("paypal:a", "INV-A1", { status: "SENT" });
    const rec = await store.getInvoice("paypal:a", "INV-A1");
    rec.status = "PAID";
    assert.equal((await store.getInvoice("paypal:a", "INV-A1")).status, "SENT");
  }));
}

module.exports = { storeContract };
