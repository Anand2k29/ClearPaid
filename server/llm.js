// Waterfall of free LLM providers, models and keys.
// Order: for each provider, its models in order, each tried with each key. The first answer wins.
// A rate-limited (429) or failing entry goes into a short cooldown, so the next request skips it.
// Free quotas are per account or per Google Cloud project, not per key. Extra keys help only when they
// belong to projects or accounts you legitimately own. They do not add quota to the same one.
// Keys are sent only in request headers, never in URLs or logs.
//
// Check current free-tier limits before relying on them:
//   Groq       https://console.groq.com/settings/limits
//   Gemini     https://aistudio.google.com (limits per model)
//   OpenRouter https://openrouter.ai/docs/api/reference/limits

const DEFAULT_ORDER = ["groq", "gemini", "openrouter"];

const PROVIDERS = {
  groq: {
    keysVar: "GROQ_API_KEYS", singleVar: "GROQ_API_KEY", modelsVar: "GROQ_MODELS",
    defaultModels: ["llama-3.3-70b-versatile", "llama-3.1-8b-instant"],
    url: () => "https://api.groq.com/openai/v1/chat/completions",
    style: "openai",
    headers: key => ({ Authorization: `Bearer ${key}` })
  },
  gemini: {
    keysVar: "GEMINI_API_KEYS", singleVar: "GEMINI_API_KEY", modelsVar: "GEMINI_MODELS",
    defaultModels: ["gemini-2.5-flash", "gemini-2.5-flash-lite"],
    url: model => `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
    style: "gemini",
    headers: key => ({ "x-goog-api-key": key })
  },
  openrouter: {
    keysVar: "OPENROUTER_API_KEYS", singleVar: "OPENROUTER_API_KEY", modelsVar: "OPENROUTER_MODELS",
    defaultModels: ["openrouter/free"],
    url: () => "https://openrouter.ai/api/v1/chat/completions",
    style: "openai",
    headers: key => ({ Authorization: `Bearer ${key}` })
  }
};

const COOLDOWN_RATE_LIMITED_MS = 60 * 1000;
const COOLDOWN_FAILED_MS = 15 * 1000;

function splitList(value) {
  return String(value || "").split(",").map(s => s.trim()).filter(Boolean);
}

// Reads the environment and returns every usable entry in waterfall order. Each entry is { name, model, key, id }.
function configuredProviders(env = process.env, order = DEFAULT_ORDER) {
  const entries = [];
  for (const name of order) {
    const cfg = PROVIDERS[name];
    if (!cfg) continue;
    const keys = [...new Set([...splitList(env[cfg.keysVar]), ...splitList(env[cfg.singleVar])])];
    if (!keys.length) continue;
    const models = splitList(env[cfg.modelsVar]);
    const useModels = models.length ? models : cfg.defaultModels;
    useModels.forEach(model => {
      keys.forEach((key, k) => {
        entries.push({ name, model, key, id: `${name}/${model}#${k + 1}` });
      });
    });
  }
  return entries;
}

function requestFor(provider, system, user, maxTokens) {
  const cfg = PROVIDERS[provider.name];
  if (cfg.style === "gemini") {
    return {
      url: cfg.url(provider.model),
      body: {
        system_instruction: { parts: [{ text: system }] },
        contents: [{ role: "user", parts: [{ text: user }] }],
        generationConfig: { maxOutputTokens: maxTokens, temperature: 0.2 }
      }
    };
  }
  return {
    url: cfg.url(provider.model),
    body: {
      model: provider.model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user }
      ],
      max_tokens: maxTokens,
      temperature: 0.2
    }
  };
}

function textFrom(provider, data) {
  if (PROVIDERS[provider.name].style === "gemini") {
    const parts = data && data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts;
    return parts ? parts.map(p => p.text || "").join("") : "";
  }
  return (data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || "";
}

async function callProvider(provider, { system, user, maxTokens, fetchImpl, timeoutMs }) {
  const cfg = PROVIDERS[provider.name];
  const req = requestFor(provider, system, user, maxTokens);
  const res = await fetchImpl(req.url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...cfg.headers(provider.key) },
    body: JSON.stringify(req.body),
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return textFrom(provider, await res.json());
}

function entryId(provider) {
  return provider.id || `${provider.name}/${provider.model}`;
}

// Returns { text, provider, model } from the first entry that answers, or { text: null, provider: "rules", errors }.
// `cooldowns` is a Map shared across requests on the server. If none is passed, each call starts fresh.
async function generate({ system, user, maxTokens = 300, providers = [], fetchImpl = fetch, timeoutMs = 8000, cooldowns = new Map(), now = Date.now() }) {
  const errors = [];
  for (const provider of providers) {
    const id = entryId(provider);
    if ((cooldowns.get(id) || 0) > now) {
      errors.push(`${id}: cooling down`);
      continue;
    }
    try {
      const text = (await callProvider(provider, { system, user, maxTokens, fetchImpl, timeoutMs })).trim();
      if (text) return { text, provider: provider.name, model: provider.model };
      errors.push(`${id}: empty reply`);
      cooldowns.set(id, now + COOLDOWN_FAILED_MS);
    } catch (err) {
      if (err.name === "TimeoutError") {
        errors.push(`${id}: timed out`);
        cooldowns.set(id, now + COOLDOWN_FAILED_MS);
      } else if (err.status === 429) {
        errors.push(`${id}: rate limited`);
        cooldowns.set(id, now + COOLDOWN_RATE_LIMITED_MS);
      } else {
        errors.push(`${id}: ${err.message}`);
        cooldowns.set(id, now + COOLDOWN_FAILED_MS);
      }
    }
  }
  return { text: null, provider: "rules", errors };
}

module.exports = { DEFAULT_ORDER, PROVIDERS, configuredProviders, generate, requestFor, textFrom, COOLDOWN_RATE_LIMITED_MS };
