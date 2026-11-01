// Small JSON-file store for invoice status, updated by PayPal webhooks.
// Holds PayPal invoice ids and statuses only. No card data, no bank data, no passwords.
const fs = require("node:fs");
const path = require("node:path");

function createStore(file) {
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

  function save() {
    if (!file) return;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
  }

  return {
    file,
    get(id) {
      return data.invoices[id] || null;
    },
    getProject(id) {
      return data.projects[id] || null;
    },
    putProject(project) {
      data.projects[project.id] = project;
      save();
      return project;
    },
    all() {
      return Object.values(data.invoices);
    },
    // Creates or merges an invoice record. Never lowers a PAID status back to an earlier one.
    upsert(id, fields) {
      const prev = data.invoices[id] || { id, status: "DRAFT", events: [] };
      const next = { ...prev, ...fields, id };
      if (prev.status === "PAID" && next.status !== "PAID") next.status = "PAID";
      data.invoices[id] = next;
      save();
      return next;
    },
    // Records a webhook event once, using PayPal's event id so retries are harmless.
    recordEvent(invoiceId, event) {
      const rec = data.invoices[invoiceId];
      if (!rec) return false;
      rec.events = rec.events || [];
      if (rec.events.some(e => e.id === event.id)) return false;
      rec.events.push(event);
      save();
      return true;
    }
  };
}

module.exports = { createStore };
