const test = require("node:test");
const assert = require("node:assert/strict");
const { DICT } = require("../freelancer/lib/i18n.js");

test("English and Hindi have exactly the same keys", () => {
  const en = Object.keys(DICT.en).sort();
  const hi = Object.keys(DICT.hi).sort();
  assert.deepEqual(hi, en);
});

test("no translation is empty", () => {
  for (const lang of ["en", "hi"]) {
    for (const [key, value] of Object.entries(DICT[lang])) {
      assert.ok(value && value.trim().length > 0, `${lang}.${key} is empty`);
    }
  }
});

test("Hindi strings contain Devanagari, so they are not left in English by mistake", () => {
  const devanagari = /[ऀ-ॿ]/;
  const mustBeHindi = ["app.title", "tab.invoices", "inv.send", "money.youGet", "ledger.download"];
  mustBeHindi.forEach(key => assert.match(DICT.hi[key], devanagari, key));
});
