// PayPal webhook handling. Every event is verified with PayPal before it changes anything.
// Verification follows PayPal's verify-webhook-signature API. Not yet run against a live sandbox.
const { SANDBOX_BASE } = require("./paypal.js");

const HEADERS = {
  authAlgo: "paypal-auth-algo",
  certUrl: "paypal-cert-url",
  transmissionId: "paypal-transmission-id",
  transmissionSig: "paypal-transmission-sig",
  transmissionTime: "paypal-transmission-time"
};

// Returns true only when PayPal says SUCCESS for this exact body and headers.
const REPLAY_WINDOW_MS = 5 * 60 * 1000;

async function verifyWebhook({ headers, rawBody, webhookId, getToken, fetchImpl = fetch, base = SANDBOX_BASE, now = Date.now() }) {
  if (!webhookId) throw new Error("PAYPAL_WEBHOOK_ID is not set");
  // Refuse old or future-dated deliveries, so a captured request cannot be replayed later.
  const sent = Date.parse(headers[HEADERS.transmissionTime]);
  if (!Number.isFinite(sent) || Math.abs(now - sent) > REPLAY_WINDOW_MS) return false;
  const event = JSON.parse(rawBody);
  const token = await getToken();
  const res = await fetchImpl(`${base}/v1/notifications/verify-webhook-signature`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      auth_algo: headers[HEADERS.authAlgo],
      cert_url: headers[HEADERS.certUrl],
      transmission_id: headers[HEADERS.transmissionId],
      transmission_sig: headers[HEADERS.transmissionSig],
      transmission_time: headers[HEADERS.transmissionTime],
      webhook_id: webhookId,
      webhook_event: event
    })
  });
  if (!res.ok) return false;
  const data = await res.json();
  return data.verification_status === "SUCCESS";
}

// Applies one verified event to the store. Returns what changed, for logging.
function applyEvent(event, store) {
  const type = event.event_type;
  const invoiceId = event.resource && event.resource.id;
  if (!invoiceId) return { changed: false, reason: "no invoice id" };
  if (!store.get(invoiceId)) return { changed: false, reason: "unknown invoice" };

  const recorded = store.recordEvent(invoiceId, { id: event.id, type, at: event.create_time || new Date().toISOString() });
  if (!recorded) return { changed: false, reason: "duplicate event" };

  if (type === "INVOICING.INVOICE.PAID") {
    store.upsert(invoiceId, { status: "PAID", paidAt: event.create_time || new Date().toISOString() });
    return { changed: true, status: "PAID" };
  }
  if (type === "INVOICING.INVOICE.CANCELLED") {
    store.upsert(invoiceId, { status: "CANCELLED" });
    return { changed: true, status: "CANCELLED" };
  }
  return { changed: false, reason: `not handled: ${type}` };
}

module.exports = { verifyWebhook, applyEvent, HEADERS };
