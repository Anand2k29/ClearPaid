const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createJsonStore, DEVELOPER_OWNER } = require("../server/store.js");
const { storeContract } = require("./helpers/store-contract.js");

storeContract("JSON file store", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cp-json-"));
  const store = createJsonStore(path.join(dir, "store.json"));
  return { store, done: async () => fs.rmSync(dir, { recursive: true, force: true }) };
});

test("records saved before owners existed belong to the developer token", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cp-legacy-"));
  const file = path.join(dir, "store.json");
  fs.writeFileSync(file, JSON.stringify({ invoices: { "INV-OLD": { id: "INV-OLD", number: "OLD-1", status: "SENT" } }, projects: {} }));
  const store = createJsonStore(file);
  assert.equal((await store.listInvoices(DEVELOPER_OWNER)).length, 1);
  assert.equal((await store.listInvoices("paypal:anyone")).length, 0);
});

test("the JSON store survives a restart with owners intact", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cp-restart-"));
  const file = path.join(dir, "store.json");
  await createJsonStore(file).saveInvoice("paypal:a", "INV-A1", { number: "A-1", status: "SENT" });
  const reopened = createJsonStore(file);
  assert.equal((await reopened.getInvoice("paypal:a", "INV-A1")).number, "A-1");
  assert.equal(await reopened.getInvoice("paypal:b", "INV-A1"), null);
});
