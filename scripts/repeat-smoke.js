// Runs the live smoke test several times. Each run uses a fresh server, so one run's rate limit never affects the next.
// Usage: node scripts/repeat-smoke.js 12
const { spawn } = require("node:child_process");
const path = require("node:path");
const { start, createHandler } = require("../server/index.js");
const { createRateLimiter } = require("../server/security.js");
const { createAuthStore } = require("../server/auth.js");

const TOKEN = "local-demo-token-0123456789abcdefghij";
const runs = Number(process.argv[2]) || 12;

function runSmoke(base) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [path.join(__dirname, "smoke.js")], {
      env: { ...process.env, BASE_URL: base, API_TOKEN: TOKEN }
    });
    let out = "";
    child.stdout.on("data", d => { out += d; });
    child.stderr.on("data", d => { out += d; });
    child.on("close", code => resolve({ code, out }));
  });
}

(async () => {
  const summary = [];
  let failedRuns = 0;
  for (let i = 1; i <= runs; i++) {
    const server = await start({ port: 0, env: {} });
    server.removeAllListeners("request");
    server.on("request", createHandler({
      paypal: null,
      apiToken: TOKEN,
      proofSecret: "local-proof-secret-0123456789abcdefghij",
      limiter: createRateLimiter({ max: 60, windowMs: 60000 }),
      aiLimiter: createRateLimiter({ max: 15, windowMs: 60000 }),
      dailyLimiter: createRateLimiter({ max: 300, windowMs: 86400000 }),
      auth: { store: createAuthStore(), clientId: null, clientSecret: null, demoEnabled: true }
    }));
    const base = `http://127.0.0.1:${server.address().port}`;
    const { code, out } = await runSmoke(base);
    const summaryLine = (out.match(/\d+ of \d+ checks passed/) || ["no summary"])[0];
    const failed = out.match(/^FAIL.*$/gm) || [];
    summary.push(`run ${String(i).padStart(2)}: ${summaryLine}  exit=${code}`);
    if (code !== 0) {
      failedRuns++;
      failed.forEach(line => summary.push(`        ${line}`));
    }
    server.close();
  }
  console.log(summary.join("\n"));
  console.log(`\nruns with any failed check: ${failedRuns} of ${runs}`);
  process.exit(failedRuns === 0 ? 0 : 1);
})();
