// Signed proof of an invoice. The proof is a short text payload plus an HMAC-SHA256 signature made with a
// server-side secret (PROOF_SECRET). Anyone holding the QR code can check it with the public verification page,
// and nobody can forge or change an invoice's details without the secret.
// The public page shows only what the client needs: invoice number, amount, date, and status.
const crypto = require("node:crypto");

const MIN_SECRET_LENGTH = 32;
const VERSION = "CP1";

function requireSecret(secret) {
  if (!secret || secret.length < MIN_SECRET_LENGTH) {
    const err = new Error("PROOF_SECRET must be set (at least 32 characters) before proofs can be created.");
    err.status = 503;
    throw err;
  }
}

// Canonical payload: fixed field order, no free text that could hide separators.
function payloadFor({ number, amountCents, currency, issuedOn, invoiceId }) {
  if (!/^[A-Za-z0-9-]{1,20}$/.test(number)) throw new Error("invoice number is not safe to sign");
  if (!/^[A-Z]{3}$/.test(currency)) throw new Error("currency is not valid");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(issuedOn)) throw new Error("issue date is not valid");
  return [VERSION, number, String(amountCents), currency, issuedOn, invoiceId].join("|");
}

function sign(payload, secret) {
  requireSecret(secret);
  return crypto.createHmac("sha256", secret).update(payload).digest("base64url").slice(0, 32);
}

// Returns { payload, signature, code } where code is what goes into the QR.
function buildProof(fields, secret) {
  const payload = payloadFor(fields);
  const signature = sign(payload, secret);
  return { payload, signature, code: `${payload}|${signature}` };
}

// Checks a code produced by buildProof. Returns { valid, fields } or { valid: false, reason }.
function verifyCode(code, secret) {
  requireSecret(secret);
  const parts = String(code || "").split("|");
  if (parts.length !== 7 || parts[0] !== VERSION) return { valid: false, reason: "not a ClearPaid proof" };
  const [, number, amountCents, currency, issuedOn, invoiceId, signature] = parts;
  const payload = [VERSION, number, amountCents, currency, issuedOn, invoiceId].join("|");
  const expected = sign(payload, secret);
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  const ok = a.length === b.length && crypto.timingSafeEqual(a, b);
  if (!ok) return { valid: false, reason: "signature does not match" };
  return { valid: true, fields: { number, amountCents: Number(amountCents), currency, issuedOn, invoiceId } };
}

// A random, unguessable token for the public proof page. Not derived from the invoice, so it reveals nothing.
function newProofToken() {
  return crypto.randomBytes(24).toString("base64url");
}

// HTML-escapes text placed into the public page.
function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// Public verification page. Shows only the fields the client needs.
function proofPage({ number, amountUsd, issuedOn, status, verified }) {
  const badge = verified ? '<span class="ok">Signature verified</span>' : '<span class="bad">Signature not verified</span>';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Invoice proof · ClearPaid</title>
<style>
body{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;margin:0;background:#f5f5ff;color:#1e1b3a;line-height:1.5}
main{max-width:460px;margin:0 auto;padding:24px 16px}
.card{background:#fff;border:1px solid #e4e6f2;border-radius:16px;padding:20px}
h1{font-size:20px;margin:0 0 12px}
.row{display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid #e4e6f2;font-size:15px}
.row:last-child{border:0}.k{color:#5b5f78}
.ok{color:#047857;font-weight:600}.bad{color:#be123c;font-weight:600}
p.note{color:#5b5f78;font-size:13px}
</style></head><body><main>
<div class="card">
<h1>Invoice proof</h1>
<div class="row"><span class="k">Invoice</span><span>${esc(number)}</span></div>
<div class="row"><span class="k">Amount</span><span>${esc(amountUsd)}</span></div>
<div class="row"><span class="k">Issued</span><span>${esc(issuedOn)}</span></div>
<div class="row"><span class="k">Status</span><span>${esc(status)}</span></div>
<p>${badge}</p>
<p class="note">This page confirms the invoice details were issued by the sender. Payment status comes from PayPal. Contact details are not shown here.</p>
</div></main></body></html>`;
}

module.exports = { MIN_SECRET_LENGTH, buildProof, verifyCode, newProofToken, proofPage, payloadFor, esc };
