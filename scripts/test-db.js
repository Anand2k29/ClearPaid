// Runs the Postgres store tests against a temporary, local Postgres server.
// No Docker and no account are needed: the embedded-postgres package brings its own server binaries.
// The server, its data folder and its password exist only for this run. Usage: npm run test:db
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const EmbeddedPostgres = require("embedded-postgres").default;

const ROOT = path.join(__dirname, "..");
const PASSWORD = "throwaway-test-password";

function runTests(env) {
  return new Promise(resolve => {
    // One file at a time: the files share one database, and each test empties its tables first.
    const child = spawn(process.execPath, ["--test", "--test-concurrency=1", "tests/store-postgres.test.js", "tests/isolation.test.js"], { cwd: ROOT, env, stdio: "inherit" });
    child.on("exit", code => resolve(code === null ? 1 : code));
  });
}

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cp-pg-"));
  const port = 55500 + Math.floor(Math.random() * 400);
  const pg = new EmbeddedPostgres({
    databaseDir: path.join(dir, "data"),
    user: "clearpaid",
    password: PASSWORD,
    port,
    persistent: false
  });
  let code = 1;
  try {
    await pg.initialise();
    await pg.start();
    await pg.createDatabase("clearpaid_test");
    const url = `postgres://clearpaid:${PASSWORD}@127.0.0.1:${port}/clearpaid_test`;
    console.log(`Temporary Postgres running on port ${port}`);
    code = await runTests({ ...process.env, TEST_DATABASE_URL: url });
  } finally {
    await pg.stop().catch(() => {});
    fs.rmSync(dir, { recursive: true, force: true });
  }
  process.exit(code);
}

main().catch(err => {
  console.error("Could not run the Postgres tests:", err.message);
  process.exit(1);
});
