// Helpers for the tests that run against a real Postgres database (see scripts/test-db.js).
const { Pool } = require("pg");
const { isLocalAddress } = require("../../server/store-postgres.js");

// Empties the tables so each test starts from nothing. Only ever point this at a throwaway database.
async function emptyTables(url) {
  const pool = new Pool({ connectionString: url, ssl: isLocalAddress(url) ? false : { rejectUnauthorized: true } });
  try {
    await pool.query("TRUNCATE invoices, projects");
  } finally {
    await pool.end();
  }
}

module.exports = { emptyTables };
