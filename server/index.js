// Small server: serves the static pages and the sandbox invoice API. No dependencies.
// Run: node server/index.js   then open http://localhost:3000
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { createPayPalClient } = require("./paypal.js");
const AI = require("./ai.js");
const { configuredProviders } = require("./llm.js");
const { createStore } = require("./store.js");
const { verifyWebhook, applyEvent } = require("./webhooks.js");
const PROJECT = require("./project.js");
const R = require("./reminders.js");
const { checkBearer, setSecurityHeaders, createRateLimiter, publicError } = require("./security.js");
const PROOF = require("./proof.js");

// Invoice records keyed by PayPal invoice id, for project summaries.
function invoicesById(store) {
  return Object.fromEntries(store.all().map(i => [i.id, i]));
}

const ROOT = path.join(__dirname, "..");
const BLOCKED = ["server", "tests", "process", "node_modules", "data"];
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml"
};
const MAX_BODY = 64 * 1024;

function send(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

// Reads the raw body up to a size limit. Returns a Buffer.
function readRaw(req, limit = MAX_BODY) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", c => {
      size += c.length;
      if (size > limit) {
        reject(Object.assign(new Error("Request body too large"), { status: 413 }));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function readBody(req, limit = MAX_BODY) {
  return readRaw(req, limit).then(buf => {
    try {
      return buf.length ? JSON.parse(buf.toString("utf8")) : {};
    } catch {
      throw Object.assign(new Error("Body must be JSON"), { status: 400 });
    }
  });
}

function validateInvoice(b) {
  const errors = [];
  if (b.dueDate && !R.isDueDate(b.dueDate)) errors.push("dueDate: use YYYY-MM-DD");
  if (!b.invoiceNumber || !/^[A-Za-z0-9-]{1,20}$/.test(b.invoiceNumber)) errors.push("invoiceNumber: letters, digits and dashes, up to 20");
  if (!b.customerEmail || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(b.customerEmail)) errors.push("customerEmail: must be a valid email");
  if (!b.customerName || String(b.customerName).length > 80) errors.push("customerName: required, up to 80 characters");
  if (!(Number(b.amount) > 0) || Number(b.amount) > 100000) errors.push("amount: greater than 0 and up to 100000");
  if (b.currency && !/^[A-Z]{3}$/.test(b.currency)) errors.push("currency: three letters, such as USD");
  return errors;
}

// Routes that do not need the access token. The webhook is authenticated by PayPal's signature instead.
const PUBLIC_API = new Set(["/api/health", "/api/webhooks/paypal"]);

function createHandler({ paypal, ai = {}, store = null, webhookId = null, apiToken = null, proofSecret = null, publicUrl = null, aiLimiter = createRateLimiter({ max: 15, windowMs: 60000 }), dailyLimiter = createRateLimiter({ max: 300, windowMs: 86400000 }), limiter = createRateLimiter({ max: 60, windowMs: 60000 }), root = ROOT }) {
  return async function handler(req, res) {
    const url = new URL(req.url, "http://localhost");
    const p = decodeURIComponent(url.pathname);
    const isApi = p.startsWith("/api/");
    const isProof = p.startsWith("/proof/");
    setSecurityHeaders(res, { api: isApi || isProof });

    if (isApi || isProof) {
      const who = req.socket.remoteAddress || "unknown";
      const limit = limiter.hit(who);
      if (!limit.allowed) {
        res.setHeader("Retry-After", String(limit.retryAfterSec));
        return send(res, 429, { error: "Too many requests. Please wait and try again." });
      }
      // The public proof page is open by design. It is protected by its random token and the rate limit above.
      if (isApi && !PUBLIC_API.has(p)) {
        const reason = checkBearer(req, apiToken);
        if (reason) {
          res.setHeader("WWW-Authenticate", 'Bearer realm="clearpaid"');
          return send(res, reason === "server access token is not configured" ? 503 : 401, { error: reason === "server access token is not configured" ? "Set API_TOKEN (at least 32 characters) in .env." : "Access token required." });
        }
      }
    }

    if (isProof && req.method === "GET") {
      const token = p.slice("/proof/".length);
      const rec = store && /^[A-Za-z0-9_-]{20,64}$/.test(token) ? store.all().find(i => i.proofToken === token) : null;
      if (!rec) {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        return res.end("Proof not found");
      }
      let verified = false;
      try {
        verified = PROOF.verifyCode(rec.proofCode, proofSecret).valid;
      } catch { verified = false; }
      const html = PROOF.proofPage({
        number: rec.number,
        amountUsd: `$${Number(rec.amount).toLocaleString("en-US", { minimumFractionDigits: 2 })}`,
        issuedOn: (rec.proofIssuedOn || "").slice(0, 10),
        status: rec.status,
        verified
      });
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(html);
    }

    // Model calls are limited per client, per minute and per day, so quota cannot be drained by one caller.
    if (isApi && (p.startsWith("/api/ai/") || p === "/api/assistant")) {
      const who = req.socket.remoteAddress || "unknown";
      const perMinute = aiLimiter.hit(who);
      const perDay = dailyLimiter.hit(who);
      if (!perMinute.allowed || !perDay.allowed) {
        const wait = Math.max(perMinute.retryAfterSec, perDay.retryAfterSec);
        res.setHeader("Retry-After", String(wait));
        return send(res, 429, { error: "AI request limit reached. Please wait before asking again." });
      }
    }

    if (isApi) {
      try {
        const proofMatch = p.match(/^\/api\/invoices\/([^/]+)\/proof$/);
        if (req.method === "POST" && proofMatch) {
          if (!store) return send(res, 503, { error: "Storage is not configured." });
          if (!proofSecret) return send(res, 503, { error: "Set PROOF_SECRET (at least 32 characters) in .env." });
          const rec = store.get(proofMatch[1]);
          if (!rec || !rec.number) return send(res, 404, { error: "Invoice not found." });
          const issuedOn = (rec.sentAt || new Date().toISOString()).slice(0, 10);
          const built = PROOF.buildProof({
            number: rec.number,
            amountCents: Math.round(Number(rec.amount) * 100),
            currency: rec.currency || "USD",
            issuedOn,
            invoiceId: rec.id
          }, proofSecret);
          const token = PROOF.newProofToken();
          store.upsert(rec.id, { proofToken: token, proofCode: built.code, proofIssuedOn: issuedOn });
          const base = (publicUrl || `http://${req.headers.host || "localhost"}`).replace(/\/$/, "");
          const verifyUrl = `${base}/proof/${token}`;
          const text = `Invoice ${rec.number} for $${Number(rec.amount).toFixed(2)} is ready. Proof of issue: ${verifyUrl}`;
          return send(res, 201, {
            code: built.code,
            verifyUrl,
            text,
            whatsappUrl: `https://wa.me/?text=${encodeURIComponent(text)}`,
            mailtoUrl: `mailto:${encodeURIComponent(rec.customerEmail || "")}?subject=${encodeURIComponent(`Invoice ${rec.number} proof`)}&body=${encodeURIComponent(text)}`
          });
        }
        if (req.method === "GET" && p === "/api/health") {
          // Provider names only. Keys are never returned.
          return send(res, 200, {
            ok: true,
            paypalConfigured: Boolean(paypal),
            aiProviders: [...new Set((ai.providers || []).map(x => x.name))],
            authRequired: true,
            environment: "sandbox"
          });
        }
        if (req.method === "POST" && p === "/api/assistant") {
          const body = await readBody(req);
          return send(res, 200, await AI.answerQuestion(body.question, { llm: ai }));
        }
        if (req.method === "POST" && p === "/api/ai/classify") {
          const body = await readBody(req);
          return send(res, 200, await AI.classify(body.text, { llm: ai }));
        }
        if (req.method === "POST" && p === "/api/ai/transcribe") {
          const body = await readBody(req, 8 * 1024 * 1024);
          if (!body.audioBase64) return send(res, 400, { error: "audioBase64 is required" });
          const buffer = Buffer.from(String(body.audioBase64), "base64");
          if (!buffer.length) return send(res, 400, { error: "Audio is empty" });
          const out = await AI.transcribeAudio({ buffer, mime: body.mime, filename: body.filename }, { llm: ai });
          if (out.error) return send(res, out.status, { error: out.error });
          return send(res, 200, { text: out.text, provider: out.provider });
        }
        if (req.method === "POST" && p === "/api/ai/draft") {
          const body = await readBody(req);
          if (!AI.LABELS.includes(body.label)) return send(res, 400, { error: `label must be one of ${AI.LABELS.join(", ")}` });
          return send(res, 200, await AI.draftReply(body, { llm: ai }));
        }
        if (store && req.method === "POST" && p === "/api/projects") {
          const body = await readBody(req);
          const errors = PROJECT.validateProject(body);
          if (errors.length) return send(res, 400, { error: "Invalid project", details: errors });
          const project = PROJECT.buildProject(`proj-${Date.now().toString(36)}`, body);
          store.putProject(project);
          return send(res, 201, PROJECT.summarise(project, invoicesById(store)));
        }
        const projectMatch = p.match(/^\/api\/projects\/([^/]+)(\/invoices)?$/);
        if (store && projectMatch) {
          const project = store.getProject(projectMatch[1]);
          if (!project) return send(res, 404, { error: "Project not found" });
          if (req.method === "GET" && !projectMatch[2]) {
            return send(res, 200, PROJECT.summarise(project, invoicesById(store)));
          }
          if (req.method === "POST" && projectMatch[2]) {
            if (!paypal) return send(res, 503, { error: "PayPal is not configured. Invoices cannot be sent yet." });
            const results = [];
            for (const c of project.collaborators) {
              if (c.invoiceId) { results.push({ collaborator: c.id, skipped: "already invoiced" }); continue; }
              try {
                const number = `${project.id}-${c.id}`.slice(0, 20);
                const created = await paypal.createInvoice({
                  invoiceNumber: number,
                  customerEmail: project.clientEmail,
                  customerName: project.clientName,
                  amount: c.amountUsd,
                  currency: project.currency,
                  note: `${project.name}: ${c.name}'s share (${c.sharePct}%)`
                });
                await paypal.sendInvoice(created.id);
                store.upsert(created.id, {
                  number, status: "SENT", sentAt: new Date().toISOString(),
                  projectId: project.id, collaboratorId: c.id,
                  customerEmail: project.clientEmail, amount: c.amountUsd, currency: project.currency,
                  links: created.links || [],
                  dueDate: R.addDaysIso(R.isoDate(new Date()), 30)
                });
                c.invoiceId = created.id;
                c.invoiceNumber = number;
                results.push({ collaborator: c.id, invoiceId: created.id, invoiceNumber: number });
              } catch (err) {
                results.push({ collaborator: c.id, error: err.message });
              }
            }
            store.putProject(project);
            return send(res, 200, { results, project: PROJECT.summarise(project, invoicesById(store)) });
          }
        }
        if (store && req.method === "GET" && p === "/api/reminders") {
          return send(res, 200, { reminders: R.findOverdue(store.all(), new Date()), dailyCap: R.DEFAULT_DAILY_CAP });
        }
        const reminderMatch = p.match(/^\/api\/reminders\/([^/]+)\/(approve|snooze)$/);
        if (store && req.method === "POST" && reminderMatch) {
          if (reminderMatch[2] === "snooze") return send(res, 200, R.snoozeReminder(reminderMatch[1], { store }));
          if (!paypal) return send(res, 503, { error: "PayPal is not configured. Reminders cannot be sent yet." });
          return send(res, 200, await R.approveReminder(reminderMatch[1], { store, paypal }));
        }
        if (req.method === "POST" && p === "/api/webhooks/paypal") {
          if (!paypal) return send(res, 503, { error: "PayPal is not configured." });
          const rawBody = await readRaw(req);
          const headers = Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k.toLowerCase(), v]));
          const ok = await verifyWebhook({ headers, rawBody: rawBody.toString("utf8"), webhookId, getToken: paypal.getToken, base: paypal.base });
          if (!ok) return send(res, 401, { error: "Webhook signature not verified" });
          const event = JSON.parse(rawBody.toString("utf8"));
          const result = store ? applyEvent(event, store) : { changed: false, reason: "no store" };
          return send(res, 200, { received: true, ...result });
        }
        if (!paypal) {
          return send(res, 503, { error: "PayPal is not configured. Set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET (see .env.example)." });
        }
        if (req.method === "POST" && p === "/api/invoices") {
          const body = await readBody(req);
          const errors = validateInvoice(body);
          if (errors.length) return send(res, 400, { error: "Invalid invoice", details: errors });
          // Idempotency: the same invoice number is never created twice, so a retried request cannot charge twice.
          if (store && store.all().some(i => i.number === body.invoiceNumber)) {
            return send(res, 409, { error: "An invoice with that number already exists." });
          }
          const invoice = await paypal.createInvoice({ ...body, currency: body.currency || "USD" });
          if (store) {
            store.upsert(invoice.id, {
              number: body.invoiceNumber,
              status: invoice.status || "DRAFT",
              customerEmail: body.customerEmail,
              customerName: body.customerName,
              amount: Number(body.amount),
              currency: body.currency || "USD",
              links: invoice.links || [],
              dueDate: body.dueDate || R.addDaysIso(R.isoDate(new Date()), 30)
            });
          }
          return send(res, 201, invoice);
        }
        const sendMatch = p.match(/^\/api\/invoices\/([^/]+)\/send$/);
        if (req.method === "POST" && sendMatch) {
          const prior = store && store.get(sendMatch[1]);
          if (prior && prior.sentAt) return send(res, 409, { error: "This invoice was already sent." });
          const result = await paypal.sendInvoice(sendMatch[1]);
          if (store) store.upsert(sendMatch[1], { status: "SENT", sentAt: new Date().toISOString() });
          return send(res, 200, { ...result, emailedTo: store && store.get(sendMatch[1]) ? store.get(sendMatch[1]).customerEmail : null });
        }
        const getMatch = p.match(/^\/api\/invoices\/([^/]+)$/);
        if (req.method === "GET" && getMatch) {
          return send(res, 200, await paypal.getInvoice(getMatch[1]));
        }
        return send(res, 404, { error: "Not found" });
      } catch (err) {
        const out = publicError(err);
        if (out.status >= 500) console.error(`[api] ${req.method} ${p} failed: ${err.message}`);
        return send(res, out.status, { error: out.message });
      }
    }

    // Static files, excluding internal folders and dotfiles.
    const ROUTES = { "/": "/landing/index.html", "/app": "/freelancer/index.html" };
    const rel = ROUTES[p] || p;
    const parts = rel.split("/").filter(Boolean);
    if (parts.some(part => BLOCKED.includes(part) || part.startsWith("."))) {
      res.writeHead(404);
      return res.end("Not found");
    }
    const file = path.normalize(path.join(root, rel));
    if (!file.startsWith(path.normalize(root))) {
      res.writeHead(403);
      return res.end("Forbidden");
    }
    fs.readFile(file, (err, data) => {
      if (err) {
        res.writeHead(404);
        return res.end("Not found");
      }
      res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" });
      res.end(data);
    });
  };
}

function start({ port = Number(process.env.PORT) || 3000, env = process.env } = {}) {
  let paypal = null;
  if (env.PAYPAL_CLIENT_ID && env.PAYPAL_CLIENT_SECRET) {
    paypal = createPayPalClient({ clientId: env.PAYPAL_CLIENT_ID, clientSecret: env.PAYPAL_CLIENT_SECRET });
  }
  const ai = { providers: configuredProviders(env), cooldowns: new Map() };
  const store = createStore(env.DATA_FILE || path.join(ROOT, "data", "store.json"));
  const apiToken = env.API_TOKEN || null;
  const server = http.createServer(createHandler({ paypal, ai, store, webhookId: env.PAYPAL_WEBHOOK_ID || null, apiToken, proofSecret: env.PROOF_SECRET || null, publicUrl: env.PUBLIC_URL || null }));
  // Listen on localhost only by default. Set HOST to expose the server, and only behind HTTPS.
  const host = env.HOST || "127.0.0.1";
  return new Promise(resolve => server.listen(port, host, () => resolve(server)));
}

if (require.main === module) {
  start().then(server => {
    const { port } = server.address();
    console.log(`ClearPaid running at http://localhost:${port}`);
    console.log(process.env.API_TOKEN ? "API access token: set" : "API access token: NOT set. Add API_TOKEN to .env (32+ characters).");
    console.log(process.env.PAYPAL_CLIENT_ID ? "PayPal sandbox: configured" : "PayPal sandbox: NOT configured (set .env values)");
  });
}

module.exports = { createHandler, start, validateInvoice };
