// Invoice and project storage for ClearPaid. Every record has an owner: the signed-in freelancer
// ("paypal:<id>" or "demo:<id>"), or DEVELOPER_OWNER for the access token. Freelancer-facing reads and
// writes take the owner, so one person never sees or changes another person's records.
// Two stores share this interface: this JSON file (local development and tests) and Postgres (hosted,
// see store-postgres.js). Every method returns a promise.
// Holds PayPal invoice ids, statuses and client contact details only. No card data, no bank data, no passwords.
const fs = require("node:fs");
const path = require("node:path");

const DEVELOPER_OWNER = "developer";

function notFound(message = "Invoice not found.") {
  return Object.assign(new Error(message), { status: 404 });
}

// Applies a partial update to an invoice record. Never lowers a PAID status, and never changes the id or owner.
function merge(prev, fields, id, ownerId) {
  const base = prev || { id, ownerId, status: "DRAFT", events: [] };
  const next = { ...base, ...fields, id, ownerId: base.ownerId };
  if (base.status === "PAID" && next.status !== "PAID") next.status = "PAID";
  return next;
}

function copy(value) {
  return value == null ? null : JSON.parse(JSON.stringify(value));
}

function createJsonStore(file) {
  let data = { invoices: {}, projects: {} };
  if (file && fs.existsSync(file)) {
    try {
      data = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      data = { invoices: {}, projects: {} };
    }
  }
  data.invoices = data.invoices || {};
  data.projects = data.projects || {};
  // Records saved before owners existed belong to the developer token.
  for (const rec of Object.values(data.invoices)) rec.ownerId = rec.ownerId || DEVELOPER_OWNER;
  for (const p of Object.values(data.projects)) p.ownerId = p.ownerId || DEVELOPER_OWNER;

  function save() {
    if (!file) return;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
  }

  return {
    kind: "json file",
    file,
    // Freelancer-facing: only the owner's own invoice.
    async getInvoice(ownerId, id) {
      const rec = data.invoices[id];
      return rec && rec.ownerId === ownerId ? copy(rec) : null;
    },
    // Internal, for webhooks: finds the invoice whatever its owner.
    async findInvoice(id) {
      return copy(data.invoices[id]);
    },
    // Public proof page: looked up by the random token, which reveals only what the proof shows.
    async findByProofToken(token) {
      return copy(Object.values(data.invoices).find(i => i.proofToken === token));
    },
    // Invoice numbers are unique on the PayPal account, so this check spans every owner.
    async findByNumber(number) {
      return copy(Object.values(data.invoices).find(i => i.number === number));
    },
    async listInvoices(ownerId) {
      return Object.values(data.invoices).filter(i => i.ownerId === ownerId).map(copy);
    },
    // Creates or merges one of the owner's invoices. Fails with 404 if the id belongs to someone else.
    async saveInvoice(ownerId, id, fields) {
      const prev = data.invoices[id];
      if (prev && prev.ownerId !== ownerId) throw notFound();
      const next = merge(prev, fields, id, ownerId);
      data.invoices[id] = next;
      save();
      return copy(next);
    },
    // Internal update for webhooks. Keeps the owner.
    async updateInvoice(id, fields) {
      const prev = data.invoices[id];
      if (!prev) return null;
      const next = merge(prev, fields, id);
      data.invoices[id] = next;
      save();
      return copy(next);
    },
    // Records a webhook event once, using PayPal's event id so retries are harmless.
    async recordEvent(invoiceId, event) {
      const rec = data.invoices[invoiceId];
      if (!rec) return false;
      rec.events = rec.events || [];
      if (rec.events.some(e => e.id === event.id)) return false;
      rec.events.push(event);
      save();
      return true;
    },
    async getProject(ownerId, id) {
      const p = data.projects[id];
      return p && p.ownerId === ownerId ? copy(p) : null;
    },
    async saveProject(ownerId, project) {
      const prev = data.projects[project.id];
      if (prev && prev.ownerId !== ownerId) throw notFound("Project not found.");
      const next = { ...project, ownerId };
      data.projects[project.id] = next;
      save();
      return copy(next);
    },
    async close() {}
  };
}

module.exports = { createJsonStore, merge, notFound, copy, DEVELOPER_OWNER };
