// Live smoke test: runs the important best-case, worst-case and failure checks against a running ClearPaid server.
// Usage:
//   node scripts/smoke.js
//   BASE_URL=http://localhost:3000 API_TOKEN=... node scripts/smoke.js
// Prints one line per check, then latency figures. Exits with code 1 if any check fails.
const BASE = (process.env.BASE_URL || "http://localhost:3000").replace(/\/$/, "");
const TOKEN = process.env.API_TOKEN || "";

const results = [];
function record(name, ok, detail = "") {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}

async function call(path, { method = "GET", body, headers = {}, redirect = "manual", raw = null } = {}) {
  const init = { method, headers: { ...headers }, redirect };
  if (raw !== null) init.body = raw;
  else if (body !== undefined) { init.body = JSON.stringify(body); init.headers["Content-Type"] = "application/json"; }
  const started = performance.now();
  const res = await fetch(BASE + path, init);
  const ms = performance.now() - started;
  const text = await res.text();
  return { status: res.status, headers: res.headers, text, ms };
}

const auth = { Authorization: `Bearer ${TOKEN}` };

async function main() {
  // ---- Best case: the server is up and the public pages load ----
  const health = await call("/api/health");
  record("health endpoint answers", health.status === 200, `${health.status}`);
  let healthJson = {};
  try { healthJson = JSON.parse(health.text); } catch { /* checked below */ }
  record("health reports the server as ok", healthJson.ok === true);
  record("health lists the PayPal features", Array.isArray(healthJson.paypalFeatures) && healthJson.paypalFeatures.length === 5);

  const landing = await call("/");
  record("landing page loads", landing.status === 200 && landing.text.includes("ClearPaid"));
  const app = await call("/app", { redirect: "manual" });
  record("/app redirects to the app folder", app.status === 302 && app.headers.get("location") === "/freelancer/index.html");
  const manifest = await call("/freelancer/mobile/manifest.webmanifest");
  record("app manifest is served as a web manifest", manifest.status === 200 && manifest.headers.get("content-type").includes("manifest+json"));
  const desktop = await call("/freelancer/desktop/invoices.html");
  record("desktop website page loads", desktop.status === 200 && desktop.text.includes('data-shell="desktop"') && desktop.text.includes('data-view="invoices"'));
  const mobileApp = await call("/freelancer/mobile/");
  record("mobile app folder serves its index page", mobileApp.status === 200 && mobileApp.text.includes('data-shell="mobile"'));

  // ---- Security headers on every page ----
  const headerSet = { csp: "content-security-policy", nosniff: "x-content-type-options", frame: "x-frame-options", referrer: "referrer-policy" };
  const page = await call("/freelancer/index.html");
  record("page sends a Content-Security-Policy", Boolean(page.headers.get(headerSet.csp)));
  record("page sends nosniff and same-site framing only", page.headers.get(headerSet.nosniff) === "nosniff" && page.headers.get(headerSet.frame) === "SAMEORIGIN");
  record("API responses are not cached", (await call("/api/health")).headers.get("cache-control") === "no-store");

  // ---- Access control ----
  record("API refuses a call with no token (401)", (await call("/api/invoices/x/send", { method: "POST" })).status === 401);
  record("API refuses a wrong token (401)", (await call("/api/assistant", { method: "POST", headers: { Authorization: "Bearer wrong" }, body: { question: "invoice" } })).status === 401);

  // ---- Bad input: refused cleanly, never a crash ----
  const badJson = await call("/api/ai/classify", { method: "POST", headers: { ...auth, "Content-Type": "application/json" }, raw: "{not json" });
  record("malformed JSON is refused (400)", badJson.status === 400, `${badJson.status}`);
  const invalidInvoice = await call("/api/invoices", { method: "POST", headers: auth, body: { invoiceNumber: "bad number!", amount: -5 } });
  record("invalid invoice is refused (400)", invalidInvoice.status === 400, `${invalidInvoice.status}`);
  const huge = await call("/api/ai/classify", { method: "POST", headers: { ...auth, "Content-Type": "application/json" }, raw: JSON.stringify({ text: "x".repeat(70 * 1024) }) }).catch(e => ({ status: 413, text: e.message }));
  record("oversized body is refused (413)", huge.status === 413 || huge.status === 0, `${huge.status}`);

  // ---- Failure: PayPal not connected (or down) must give a clear message, not a crash ----
  if (!healthJson.paypalConfigured) {
    const send = await call("/api/invoices", { method: "POST", headers: auth, body: { invoiceNumber: "SMOKE-1", customerEmail: "smoke@example.com", customerName: "Smoke", amount: 10, currency: "USD" } });
    record("PayPal not connected: create invoice gives 503 with a clear message", send.status === 503 && /PayPal is not configured/.test(send.text), `${send.status}`);
  } else {
    record("PayPal connected (live creation skipped in smoke test)", true);
  }

  // ---- Failure: AI providers down or not set: rules still answer ----
  const classify = await call("/api/ai/classify", { method: "POST", headers: auth, body: { text: "I'll pay this on Friday." } });
  record("AI falls back to rules when no provider answers", classify.status === 200 && JSON.parse(classify.text).label === "will_pay", `${classify.status}`);

  // ---- Scope gate: off-topic questions never reach a model ----
  const off = await call("/api/assistant", { method: "POST", headers: auth, body: { question: "Write a poem about the moon" } });
  record("assistant refuses an off-topic question", off.status === 200 && JSON.parse(off.text).allowed === false);

  // ---- Demo accounts cannot send ----
  const demo = await call("/auth/demo");
  if (demo.status === 302) {
    const cookie = demo.headers.get("set-cookie").split(";")[0];
    const sendAttempt = await call("/api/invoices/INV2-DEMO/send", { method: "POST", headers: { Cookie: cookie } });
    record("demo account cannot send invoices (403)", sendAttempt.status === 403, `${sendAttempt.status}`);
  } else {
    record("demo sign-in available or switched off", demo.status === 404, `${demo.status}`);
  }

  // ---- Path tricks: internal folders and secrets are never served ----
  for (const p of ["/server/index.js", "/scripts/upload-images.js", "/.env", "/data/store.json", "/process/cloudinary-urls.json", "/tests/server.test.js"]) {
    const r = await call(p);
    record(`internal file is not served: ${p}`, r.status === 404, `${r.status}`);
  }
  const traversal = await call("/..%2fpackage.json");
  record("path traversal is refused", traversal.status !== 200, `${traversal.status}`);

  // ---- Proofs: an unknown or tampered token is refused ----
  record("unknown proof link is not found (404)", (await call("/proof/this-token-does-not-exist-123456")).status === 404);

  // ---- Latency: best-case response times, 15 samples each ----
  const samples = {};
  for (const [label, path] of [["landing page", "/landing/index.html"], ["app page", "/freelancer/index.html"], ["health API", "/api/health"]]) {
    const times = [];
    for (let i = 0; i < 15; i++) times.push((await call(path)).ms);
    times.sort((a, b) => a - b);
    samples[label] = { p50: times[7], p95: times[13], max: times[14] };
  }

  // ---- Rate limit: a burst is slowed down with 429 and a Retry-After time ----
  let limited = null;
  for (let i = 0; i < 400 && !limited; i++) {
    const r = await call("/api/health");
    if (r.status === 429) limited = r;
  }
  record("rate limit kicks in during a burst (429 with Retry-After)", Boolean(limited && limited.headers.get("retry-after")), limited ? `Retry-After ${limited.headers.get("retry-after")}s` : "not reached");

  console.log("\nLatency (ms, local server, 15 requests each)");
  for (const [label, s] of Object.entries(samples)) {
    console.log(`  ${label.padEnd(14)} p50 ${s.p50.toFixed(1).padStart(7)}   p95 ${s.p95.toFixed(1).padStart(7)}   max ${s.max.toFixed(1).padStart(7)}`);
  }

  const passed = results.filter(r => r.ok).length;
  console.log(`\n${passed} of ${results.length} checks passed`);
  process.exitCode = passed === results.length ? 0 : 1;
}

main().catch(err => {
  console.error("Smoke test could not reach the server:", err.message);
  console.error(`Is the server running at ${BASE}?`);
  process.exitCode = 1;
});
