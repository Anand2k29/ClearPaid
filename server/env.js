// Loads a .env file into process.env, with no dependency. Works on every Node version the project supports (18+),
// so `npm start` picks up the settings without needing `node --env-file`.
// Rules: blank lines and lines starting with # are ignored; values may be wrapped in single or double quotes;
// a variable that is already set in the environment is never overwritten.
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");

function parseEnv(text) {
  const out = {};
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.endsWith(value[0])) {
      value = value.slice(1, -1);
    }
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) out[key] = value;
  }
  return out;
}

// Returns the names of the variables that were set from the file.
function loadEnvFile(file = path.join(ROOT, ".env"), target = process.env) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (err) {
    if (err && err.code === "ENOENT") return [];
    throw err;
  }
  const loaded = [];
  for (const [key, value] of Object.entries(parseEnv(text))) {
    if (target[key] === undefined) {
      target[key] = value;
      loaded.push(key);
    }
  }
  return loaded;
}

module.exports = { parseEnv, loadEnvFile };
