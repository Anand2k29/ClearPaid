// Builds a readable timeline of what PayPal did for each invoice, newest first.
// Each entry names the PayPal product and the endpoint or event involved, so the app can show PayPal at work.
function buildActivity(invoices, limit = 30) {
  const events = [];
  for (const inv of invoices) {
    if (!inv.paypalId && !inv.id) continue;
    const ref = {
      invoice: inv.number || inv.id,
      client: inv.clientName || null,
      amountUsd: typeof inv.amount === "number" ? inv.amount : null
    };
    if (inv.createdAt) {
      events.push({ at: inv.createdAt, label: "Invoice created", product: "PayPal Invoicing API", endpoint: "POST /v2/invoicing/invoices", ...ref });
    }
    if (inv.sentAt) {
      events.push({ at: inv.sentAt, label: "PayPal emailed the invoice to the client", product: "PayPal Invoicing API", endpoint: "POST /v2/invoicing/invoices/{id}/send", ...ref });
    }
    if (inv.proofIssuedOn) {
      events.push({ at: inv.proofIssuedOn, label: "Signed proof created", product: "ClearPaid proof (HMAC-SHA256)", endpoint: "server-side signature", ...ref });
    }
    if (inv.lastRemindedAt) {
      events.push({ at: inv.lastRemindedAt, label: "Approved payment reminder sent", product: "PayPal Invoicing API", endpoint: "POST /v2/invoicing/invoices/{id}/remind", ...ref });
    }
    for (const e of inv.events || []) {
      const paid = e.type === "INVOICING.INVOICE.PAID";
      events.push({
        at: e.at,
        label: paid ? "PayPal confirmed the payment" : `PayPal event: ${e.type}`,
        product: "PayPal Webhooks",
        endpoint: e.type,
        ...ref
      });
    }
  }
  return events
    .filter(e => e.at && !Number.isNaN(Date.parse(e.at)))
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
    .slice(0, limit);
}

// Which PayPal features this server has switched on. Shown in the app so the integration is visible.
function paypalFeatures({ paypalConfigured, webhookId, loginClientId }) {
  return [
    { name: "Invoicing API", on: Boolean(paypalConfigured), detail: "Create, send and check invoices" },
    { name: "Reminders", on: Boolean(paypalConfigured), detail: "Approved reminders through PayPal" },
    { name: "Webhooks", on: Boolean(webhookId), detail: "Payments confirmed by PayPal, signature checked" },
    { name: "Log in with PayPal", on: Boolean(loginClientId), detail: "Sign in with a PayPal account (OpenID Connect)" },
    { name: "Sandbox", on: true, detail: "Test environment, no real money moves" }
  ];
}

module.exports = { buildActivity, paypalFeatures };
