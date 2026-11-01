const test = require("node:test");
const assert = require("node:assert/strict");
const LLM = require("../server/llm.js");

function net(routes) {
  const calls = [];
  const fn = async (url, opts) => {
    calls.push({ url, opts });
    const key = Object.keys(routes).find(k => url.includes(k));
    const r = key ? routes[key] : { status: 500 };
    const status = r.status || 200;
    if (status !== 200) return new Response("{}", { status });
    return new Response(JSON.stringify(r.body), { status: 200 });
  };
  fn.calls = calls;
  return fn;
}
const openai = text => ({ choices: [{ message: { content: text } }] });
const gemini = text => ({ candidates: [{ content: { parts: [{ text }] } }] });
const OK = '{"label":"will_pay","confidence":0.9,"reason":"x"}';

test("default waterfall: Groq models first, then Gemini, then OpenRouter", () => {
  const list = LLM.configuredProviders({ GROQ_API_KEY: "g", GEMINI_API_KEY: "e", OPENROUTER_API_KEY: "o" });
  assert.deepEqual(list.map(p => p.name), ["groq", "groq", "gemini", "gemini", "openrouter"]);
  assert.deepEqual(list.map(p => p.model), ["llama-3.3-70b-versatile", "llama-3.1-8b-instant", "gemini-2.5-flash", "gemini-2.5-flash-lite", "openrouter/free"]);
});

test("several keys per provider are read from one comma-separated variable, duplicates removed", () => {
  const list = LLM.configuredProviders({ GEMINI_API_KEYS: "k1, k2 ,k1,k3", GEMINI_MODELS: "gemini-2.5-flash" });
  assert.deepEqual(list.map(p => p.id), ["gemini/gemini-2.5-flash#1", "gemini/gemini-2.5-flash#2", "gemini/gemini-2.5-flash#3"]);
});

test("models are tried with the first key before moving to the next key", () => {
  const list = LLM.configuredProviders({ GEMINI_API_KEYS: "a,b", GEMINI_MODELS: "m1,m2" });
  assert.deepEqual(list.map(p => `${p.model}/${p.key}`), ["m1/a", "m1/b", "m2/a", "m2/b"]);
});

test("a provider without a key is left out entirely", () => {
  assert.deepEqual(LLM.configuredProviders({}), []);
  const list = LLM.configuredProviders({ GROQ_API_KEY: "g" });
  assert.ok(list.every(p => p.name === "groq"));
});

test("a rate-limited entry is cooled down, so the next request skips it without calling it", async () => {
  const providers = LLM.configuredProviders({ GROQ_API_KEY: "g", GROQ_MODELS: "m1,m2" });
  const cooldowns = new Map();
  const f = net({ "groq.com": { status: 429 } });
  const first = await LLM.generate({ system: "s", user: "u", providers, fetchImpl: f, cooldowns, now: 1000 });
  assert.equal(first.text, null);
  const callsAfterFirst = f.calls.length;
  const second = await LLM.generate({ system: "s", user: "u", providers, fetchImpl: f, cooldowns, now: 2000 });
  assert.equal(second.text, null);
  assert.equal(f.calls.length, callsAfterFirst, "cooled-down entries are not called again");
  assert.ok(second.errors.every(e => /cooling down/.test(e)));
});

test("after the cooldown ends, the entry is tried again", async () => {
  const providers = LLM.configuredProviders({ GROQ_API_KEY: "g", GROQ_MODELS: "m1" });
  const cooldowns = new Map();
  await LLM.generate({ system: "s", user: "u", providers, fetchImpl: net({ "groq.com": { status: 429 } }), cooldowns, now: 0 });
  const later = await LLM.generate({ system: "s", user: "u", providers, fetchImpl: net({ "groq.com": { body: openai(OK) } }), cooldowns, now: LLM.COOLDOWN_RATE_LIMITED_MS + 1 });
  assert.equal(later.provider, "groq");
});

test("the waterfall moves past a failing model to a working one, and reports which answered", async () => {
  const providers = LLM.configuredProviders({ GROQ_API_KEY: "g", GROQ_MODELS: "bad-model,good-model" });
  const f = net({});
  f.calls.length = 0;
  const custom = async (url, opts) => {
    const body = JSON.parse(opts.body);
    if (body.model === "bad-model") return new Response("{}", { status: 404 });
    return new Response(JSON.stringify(openai(OK)), { status: 200 });
  };
  const r = await LLM.generate({ system: "s", user: "u", providers, fetchImpl: custom, cooldowns: new Map() });
  assert.equal(r.provider, "groq");
  assert.equal(r.model, "good-model");
});

test("keys are sent only in headers, never in the URL", async () => {
  const providers = LLM.configuredProviders({ GEMINI_API_KEY: "secret-key-123", GEMINI_MODELS: "gemini-2.5-flash" });
  const f = net({ "generativelanguage": { body: gemini(OK) } });
  await LLM.generate({ system: "s", user: "u", providers, fetchImpl: f, cooldowns: new Map() });
  assert.equal(f.calls[0].opts.headers["x-goog-api-key"], "secret-key-123");
  assert.ok(!f.calls[0].url.includes("secret-key-123"));
});

test("errors name the entry but never contain a key", async () => {
  const providers = LLM.configuredProviders({ GROQ_API_KEY: "topsecretkey99", GROQ_MODELS: "m1" });
  const r = await LLM.generate({ system: "s", user: "u", providers, fetchImpl: net({ "groq.com": { status: 503 } }), cooldowns: new Map() });
  assert.ok(r.errors.length === 1);
  assert.ok(!r.errors.join(" ").includes("topsecretkey99"));
});
