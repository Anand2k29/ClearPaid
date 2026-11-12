// Postgres storage for the hosted app. Same interface as the JSON store in store.js.
// Each record is kept as JSON, with its owner and the few values looked up by name (number, proof token).
// Writes run in a transaction with the row locked, so a webhook and a send cannot overwrite each other,
// and an owner can never be changed after a record is created.
// The driver (pg) is loaded only when DATABASE_URL is set, so the JSON-file setup needs no packages.
const { merge, notFound, copy } = require("./store.js");

const SCHEMA = `
CREATE TABLE IF NOT EXISTS invoices (
  id           text PRIMARY KEY,
  owner_id     text NOT NULL,
  number       text,
  proof_token  text,
  record       jsonb NOT NULL,
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS invoices_owner_idx ON invoices (owner_id);
CREATE INDEX IF NOT EXISTS invoices_number_idx ON invoices (number);
CREATE UNIQUE INDEX IF NOT EXISTS invoices_proof_token_idx ON invoices (proof_token) WHERE proof_token IS NOT NULL;
CREATE TABLE IF NOT EXISTS projects (
  id           text PRIMARY KEY,
  owner_id     text NOT NULL,
  record       jsonb NOT NULL,
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS projects_owner_idx ON projects (owner_id);
`;

// Creates the tables if they are missing. An advisory lock makes sure only one server runs the migration
// at a time, so several instances starting together cannot collide.
const MIGRATION_LOCK = 7315201;
async function migrate(pool) {
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK]);
    await client.query(SCHEMA);
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK]).catch(() => {});
    client.release();
  }
}

function createPostgresStore(pool) {
  async function inTransaction(fn) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const out = await fn(client);
      await client.query("COMMIT");
      return out;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  async function writeInvoice(client, rec) {
    // The owner is set on insert only. A later write cannot move the record to another owner.
    await client.query(
      `INSERT INTO invoices (id, owner_id, number, proof_token, record, updated_at)
       VALUES ($1, $2, $3, $4, $5, now())
       ON CONFLICT (id) DO UPDATE
         SET number = EXCLUDED.number, proof_token = EXCLUDED.proof_token,
             record = EXCLUDED.record, updated_at = now()`,
      [rec.id, rec.ownerId, rec.number || null, rec.proofToken || null, JSON.stringify(rec)]
    );
  }

  const first = result => (result.rows[0] ? result.rows[0].record : null);

  return {
    kind: "postgres",
    async getInvoice(ownerId, id) {
      return first(await pool.query("SELECT record FROM invoices WHERE id = $1 AND owner_id = $2", [id, ownerId]));
    },
    async findInvoice(id) {
      return first(await pool.query("SELECT record FROM invoices WHERE id = $1", [id]));
    },
    async findByProofToken(token) {
      return first(await pool.query("SELECT record FROM invoices WHERE proof_token = $1", [token]));
    },
    async findByNumber(number) {
      return first(await pool.query("SELECT record FROM invoices WHERE number = $1 LIMIT 1", [number]));
    },
    async listInvoices(ownerId) {
      const r = await pool.query("SELECT record FROM invoices WHERE owner_id = $1", [ownerId]);
      return r.rows.map(row => row.record);
    },
    async saveInvoice(ownerId, id, fields) {
      return inTransaction(async client => {
        const locked = await client.query("SELECT record, owner_id FROM invoices WHERE id = $1 FOR UPDATE", [id]);
        const row = locked.rows[0];
        if (row && row.owner_id !== ownerId) throw notFound();
        const next = merge(row ? row.record : null, fields, id, ownerId);
        await writeInvoice(client, next);
        return copy(next);
      });
    },
    async updateInvoice(id, fields) {
      return inTransaction(async client => {
        const locked = await client.query("SELECT record FROM invoices WHERE id = $1 FOR UPDATE", [id]);
        if (!locked.rows[0]) return null;
        const next = merge(locked.rows[0].record, fields, id);
        await writeInvoice(client, next);
        return copy(next);
      });
    },
    async recordEvent(invoiceId, event) {
      return inTransaction(async client => {
        const locked = await client.query("SELECT record FROM invoices WHERE id = $1 FOR UPDATE", [invoiceId]);
        if (!locked.rows[0]) return false;
        const rec = locked.rows[0].record;
        rec.events = rec.events || [];
        if (rec.events.some(e => e.id === event.id)) return false;
        rec.events.push(event);
        await writeInvoice(client, rec);
        return true;
      });
    },
    async getProject(ownerId, id) {
      return first(await pool.query("SELECT record FROM projects WHERE id = $1 AND owner_id = $2", [id, ownerId]));
    },
    async saveProject(ownerId, project) {
      return inTransaction(async client => {
        const locked = await client.query("SELECT owner_id FROM projects WHERE id = $1 FOR UPDATE", [project.id]);
        if (locked.rows[0] && locked.rows[0].owner_id !== ownerId) throw notFound("Project not found.");
        const next = { ...project, ownerId };
        await client.query(
          `INSERT INTO projects (id, owner_id, record, updated_at) VALUES ($1, $2, $3, now())
           ON CONFLICT (id) DO UPDATE SET record = EXCLUDED.record, updated_at = now()`,
          [project.id, ownerId, JSON.stringify(next)]
        );
        return copy(next);
      });
    },
    async close() {
      await pool.end();
    }
  };
}

// True for addresses on this machine. Those connect without TLS, because a local server has no certificate.
function isLocalAddress(connectionString) {
  const host = new URL(connectionString).hostname;
  return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
}

// Opens the hosted database, creates the tables if they are missing, and returns the store.
// Any host other than this machine must offer TLS with a certificate that checks out.
async function openPostgresStore(connectionString) {
  const { Pool } = require("pg");
  const ssl = isLocalAddress(connectionString) ? false : { rejectUnauthorized: true };
  const pool = new Pool({ connectionString, ssl, max: 5 });
  await migrate(pool);
  return createPostgresStore(pool);
}

module.exports = { openPostgresStore, createPostgresStore, migrate, isLocalAddress, SCHEMA };
