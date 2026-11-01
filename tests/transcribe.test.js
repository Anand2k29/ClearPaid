const test = require("node:test");
const assert = require("node:assert/strict");
const AI = require("../server/ai.js");

const GROQ = { name: "groq", key: "gk", model: "x" };

test("transcription needs a Groq key and says so plainly", async () => {
  const r = await AI.transcribeAudio({ buffer: Buffer.from("abc"), mime: "audio/webm" }, { llm: { providers: [] } });
  assert.equal(r.status, 503);
  assert.match(r.error, /GROQ_API_KEY/);
});

test("an unsupported audio type is refused before any call", async () => {
  let called = false;
  const r = await AI.transcribeAudio({ buffer: Buffer.from("abc"), mime: "application/x-msdownload" }, {
    llm: { providers: [GROQ], fetchImpl: async () => { called = true; return new Response("{}"); } }
  });
  assert.equal(r.status, 415);
  assert.equal(called, false);
});

test("a successful call sends the audio as multipart with the Whisper model and returns the text", async () => {
  let sent;
  const fetchImpl = async (url, opts) => {
    sent = { url, headers: opts.headers, form: opts.body };
    return new Response(JSON.stringify({ text: "  I will pay on Friday  " }), { status: 200 });
  };
  const r = await AI.transcribeAudio({ buffer: Buffer.from("audio-bytes"), mime: "audio/webm", filename: "note.webm" }, { llm: { providers: [GROQ], fetchImpl } });
  assert.equal(r.status, 200);
  assert.equal(r.text, "I will pay on Friday");
  assert.match(sent.url, /audio\/transcriptions$/);
  assert.equal(sent.headers.Authorization, "Bearer gk");
  assert.ok(sent.form instanceof FormData);
  assert.equal(sent.form.get("model"), "whisper-large-v3-turbo");
  assert.equal(sent.form.get("file").name, "note.webm");
});

test("an empty transcript is reported, not returned as blank text", async () => {
  const fetchImpl = async () => new Response(JSON.stringify({ text: "   " }), { status: 200 });
  const r = await AI.transcribeAudio({ buffer: Buffer.from("x"), mime: "audio/ogg" }, { llm: { providers: [GROQ], fetchImpl } });
  assert.equal(r.status, 422);
});

test("a provider error gives a readable message", async () => {
  const fetchImpl = async () => new Response("{}", { status: 429 });
  const r = await AI.transcribeAudio({ buffer: Buffer.from("x"), mime: "audio/mpeg" }, { llm: { providers: [GROQ], fetchImpl } });
  assert.equal(r.status, 502);
  assert.match(r.error, /429/);
});
