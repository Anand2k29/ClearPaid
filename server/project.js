// Shared client projects: one client, several collaborators, each paid through their own PayPal invoice.
// The app never holds or moves money. It splits the total, tracks each share, and reports what is owed.
// Amounts are kept in cents so the shares always add up exactly to the total.

function toCents(usd) {
  return Math.round(Number(usd) * 100);
}

// Splits totalUsd by percentage shares using largest remainder, so the parts sum exactly to the total.
function splitAmounts(totalUsd, sharePcts) {
  const cents = toCents(totalUsd);
  const raw = sharePcts.map(p => cents * p / 100);
  const parts = raw.map(Math.floor);
  let remainder = cents - parts.reduce((a, b) => a + b, 0);
  const byFraction = raw.map((r, i) => [r - parts[i], i]).sort((a, b) => b[0] - a[0] || a[1] - b[1]);
  for (let k = 0; k < remainder; k++) parts[byFraction[k][1]] += 1;
  return parts.map(c => c / 100);
}

function validateProject(input) {
  const errors = [];
  const name = String(input.name || "").trim();
  if (!name || name.length > 80) errors.push("name: required, up to 80 characters");
  if (!input.clientEmail || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(input.clientEmail)) errors.push("clientEmail: must be a valid email");
  if (!(Number(input.totalUsd) > 0) || Number(input.totalUsd) > 100000) errors.push("totalUsd: greater than 0 and up to 100000");
  const list = Array.isArray(input.collaborators) ? input.collaborators : [];
  if (list.length < 2 || list.length > 10) errors.push("collaborators: between 2 and 10 people");
  list.forEach((c, i) => {
    if (!c.name || String(c.name).length > 60) errors.push(`collaborator ${i + 1}: name required, up to 60 characters`);
    if (!c.email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(c.email)) errors.push(`collaborator ${i + 1}: email must be valid (their own PayPal email)`);
    if (!(Number(c.sharePct) > 0)) errors.push(`collaborator ${i + 1}: share must be greater than 0`);
  });
  if (list.length >= 2) {
    const total = list.reduce((s, c) => s + Number(c.sharePct || 0), 0);
    if (Math.abs(total - 100) > 0.01) errors.push(`shares must add up to 100 (now ${total.toFixed(2)})`);
  }
  const emails = list.map(c => String(c.email || "").toLowerCase());
  if (new Set(emails).size !== emails.length) errors.push("each collaborator needs a different email");
  return errors;
}

// Builds a project record from validated input. Ids are assigned by the caller.
function buildProject(id, input) {
  const amounts = splitAmounts(input.totalUsd, input.collaborators.map(c => Number(c.sharePct)));
  return {
    id,
    name: String(input.name).trim(),
    clientName: String(input.clientName || "Client").trim(),
    clientEmail: input.clientEmail,
    totalUsd: Number(input.totalUsd),
    currency: "USD",
    createdAt: new Date().toISOString(),
    collaborators: input.collaborators.map((c, i) => ({
      id: `c${i + 1}`,
      name: String(c.name).trim(),
      email: c.email,
      sharePct: Number(c.sharePct),
      amountUsd: amounts[i],
      invoiceId: null,
      invoiceNumber: null
    }))
  };
}

// Status for each share, from the invoice records linked to it. invoicesById maps PayPal invoice id to its record.
function summarise(project, invoicesById = {}) {
  let paid = 0;
  let sent = 0;
  const rows = project.collaborators.map(c => {
    const inv = c.invoiceId ? invoicesById[c.invoiceId] : null;
    let status = "not_invoiced";
    if (inv && inv.status === "PAID") status = "paid";
    else if (inv && inv.status === "CANCELLED") status = "cancelled";
    else if (inv) status = "sent";
    if (status === "paid") paid += c.amountUsd;
    if (status === "sent") sent += c.amountUsd;
    return { id: c.id, name: c.name, email: c.email, sharePct: c.sharePct, amountUsd: c.amountUsd, status, invoiceNumber: c.invoiceNumber };
  });
  const totalCents = toCents(project.totalUsd);
  const paidCents = toCents(paid);
  return {
    id: project.id,
    name: project.name,
    totalUsd: project.totalUsd,
    paidUsd: paid,
    awaitingUsd: sent,
    owedUsd: (totalCents - paidCents) / 100,
    complete: rows.every(r => r.status === "paid"),
    collaborators: rows
  };
}

module.exports = { splitAmounts, validateProject, buildProject, summarise, toCents };
