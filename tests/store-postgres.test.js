const test = require("node:test");
const assert = require("node:assert/strict");
const { storeContract } = require("./helpers/store-contract.js");
const { openPostgresStore } = require("../server/store-postgres.js");
const { emptyTables } = require("./helpers/postgres.js");

// These tests run the store rules against a real Postgres database.
// Set TEST_DATABASE_URL to a throwaway database: each test empties the tables first.
// Without it, the tests are skipped, so the normal test run needs no database.
const URL = process.env.TEST_DATABASE_URL;
const skip = URL ? false : "set TEST_DATABASE_URL to run the Postgres store tests";

storeContract("Postgres store", async () => {
  const store = await openPostgresStore(URL);
  await emptyTables(URL);
  return { store, done: () => store.close() };
}, { skip });

test("the schema can be created again without error (migrations are repeatable)", { skip }, async () => {
  const first = await openPostgresStore(URL);
  await first.close();
  const second = await openPostgresStore(URL);
  await second.close();
});

test("the database itself refuses two invoices with the same proof token", { skip }, async () => {
  const store = await openPostgresStore(URL);
  try {
    await emptyTables(URL);
    await store.saveInvoice("paypal:a", "INV-P1", { proofToken: "same-token-0123456789abcdefgh" });
    await assert.rejects(
      store.saveInvoice("paypal:a", "INV-P2", { proofToken: "same-token-0123456789abcdefgh" }),
      err => err.code === "23505"
    );
  } finally {
    await store.close();
  }
});
