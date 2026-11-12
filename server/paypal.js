// PayPal sandbox client for invoices. Sandbox only. Credentials come from environment variables.
// Endpoints follow PayPal's REST invoicing API. Check them against the sandbox docs before the demo,
// because this code has not yet been run against a live sandbox account.
const SANDBOX_BASE = "https://api-m.sandbox.paypal.com";

function createPayPalClient({ clientId, clientSecret, fetchImpl = fetch, base = SANDBOX_BASE }) {
  if (!clientId || !clientSecret) {
    throw new Error("PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET are not set. See .env.example.");
  }

  let token = null;
  let tokenExpiresAt = 0;

  async function getToken() {
    if (token && Date.now() < tokenExpiresAt - 60000) return token;
    const auth = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
    const res = await fetchImpl(`${base}/v1/oauth2/token`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: "grant_type=client_credentials"
    });
    if (!res.ok) throw new Error(`PayPal sign-in failed (${res.status}). Check the sandbox client ID and secret.`);
    const data = await res.json();
    token = data.access_token;
    tokenExpiresAt = Date.now() + data.expires_in * 1000;
    return token;
  }

  async function call(path, { method = "GET", body } = {}) {
    const accessToken = await getToken();
    const res = await fetchImpl(`${base}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        Prefer: "return=representation"
      },
      body: body ? JSON.stringify(body) : undefined
    });
    const text = await res.text();
    const data = text ? JSON.parse(text) : {};
    if (!res.ok) {
      const detail = data.message || (data.details && data.details[0] && data.details[0].description) || "";
      throw new Error(`PayPal ${method} ${path} failed (${res.status}) ${detail}`.trim());
    }
    return data;
  }

  function buildInvoiceBody({ invoiceNumber, customerEmail, customerName, amount, currency = "USD", note }) {
    return {
      detail: {
        invoice_number: invoiceNumber,
        currency_code: currency,
        note: note || "Thank you for your business.",
        payment_term: { term_type: "NET_30" }
      },
      primary_recipients: [
        { billing_info: { email_address: customerEmail, name: { given_name: customerName } } }
      ],
      items: [
        {
          name: `Invoice ${invoiceNumber}`,
          quantity: "1",
          unit_amount: { currency_code: currency, value: Number(amount).toFixed(2) }
        }
      ]
    };
  }

  return {
    buildInvoiceBody,
    getToken,
    base,
    createInvoice: args => call("/v2/invoicing/invoices", { method: "POST", body: buildInvoiceBody(args) }),
    sendInvoice: id => call(`/v2/invoicing/invoices/${encodeURIComponent(id)}/send`, {
      method: "POST",
      body: { send_to_recipient: true }
    }),
    getInvoice: id => call(`/v2/invoicing/invoices/${encodeURIComponent(id)}`),
    // Pay link: a PayPal order the client can approve in one click, with no invoice email.
    // Verified against PayPal's Orders v2 reference: POST /v2/checkout/orders, intent, purchase_units, custom_id.
    // Not yet verified: application_context.return_url / cancel_url, and the "approve" link name. Check in the sandbox.
    createOrder: async ({ amount, currency = "USD", customId, description, returnUrl, cancelUrl }) => {
      const order = await call("/v2/checkout/orders", {
        method: "POST",
        body: {
          intent: "CAPTURE",
          purchase_units: [{
            reference_id: customId,
            custom_id: customId,
            description: (description || "Invoice payment").slice(0, 127),
            amount: { currency_code: currency, value: Number(amount).toFixed(2) }
          }],
          application_context: { return_url: returnUrl, cancel_url: cancelUrl, user_action: "PAY_NOW" }
        }
      });
      const link = (order.links || []).find(l => l.rel === "approve" || l.rel === "payer-action");
      return { id: order.id, status: order.status, approveUrl: link ? link.href : null };
    },
    // Real fees from the sandbox account. Verified: GET /v1/reporting/transactions, max 31 days per request,
    // dates in RFC 3339 with seconds. Returns transaction_details (transaction_info.fee_amount, transaction_amount).
    listTransactions: ({ startDate, endDate }) => call(
      `/v1/reporting/transactions?start_date=${encodeURIComponent(startDate)}&end_date=${encodeURIComponent(endDate)}&fields=transaction_info&page_size=500`
    ),
    // Asks PayPal to send its own payment reminder for an open invoice. Endpoint not yet verified in the sandbox.
    remindInvoice: (id, note) => call(`/v2/invoicing/invoices/${encodeURIComponent(id)}/remind`, {
      method: "POST",
      body: { subject: "Payment reminder", note: note || "This invoice is past its due date.", send_to_recipient: true }
    })
  };
}

module.exports = { createPayPalClient, SANDBOX_BASE };
