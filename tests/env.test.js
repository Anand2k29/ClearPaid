const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { parseEnv, loadEnvFile } = require("../server/env.js");

test("parseEnv reads KEY=VALUE lines and skips comments and blanks", () => {
  const parsed = parseEnv("# a comment\n\nAPI_TOKEN=abc123\n  PORT = 3001  \n");
  assert.deepEqual(parsed, { API_TOKEN: "abc123", PORT: "3001" });
});

test("parseEnv keeps '=' inside a value and strips matching quotes", () => {
  const parsed = parseEnv('A="x=y=z"\nB=\'single\'\nC=plain=value\n');
  assert.deepEqual(parsed, { A: "x=y=z", B: "single", C: "plain=value" });
});

test("parseEnv ignores lines that are not valid variable names", () => {
  assert.deepEqual(parseEnv("=novalue\n1BAD=x\nno-dash=y\nOK=1"), { OK: "1" });
});

test("loadEnvFile sets variables from the file but never overwrites the environment", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "env-test-"));
  const file = path.join(dir, ".env");
  fs.writeFileSync(file, "NEW_KEY=fromfile\nEXISTING=fromfile\n");
  const target = { EXISTING: "fromshell" };
  const loaded = loadEnvFile(file, target);
  assert.deepEqual(loaded, ["NEW_KEY"]);
  assert.equal(target.NEW_KEY, "fromfile");
  assert.equal(target.EXISTING, "fromshell");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("loadEnvFile does nothing when the file does not exist", () => {
  const target = {};
  assert.deepEqual(loadEnvFile(path.join(os.tmpdir(), "no-such-env-file-xyz", ".env"), target), []);
  assert.deepEqual(target, {});
});
