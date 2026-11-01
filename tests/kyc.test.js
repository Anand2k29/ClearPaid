const test = require("node:test");
const assert = require("node:assert/strict");
const Q = require("../kyc/lib/quality.js");
const C = require("../kyc/lib/checks.js");

// Builds a w x h grayscale image from a pixel function f(x, y) -> 0..255.
function image(w, h, f) {
  const g = new Uint8ClampedArray(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) g[y * w + x] = f(x, y);
  return g;
}

// A sharp fine checker pattern in the centre, flat grey border, so the card does not touch the frame.
const sharpCentred = (w, h) => image(w, h, (x, y) => {
  const inside = x > w * 0.2 && x < w * 0.8 && y > h * 0.2 && y < h * 0.8;
  if (!inside) return 128;
  return (x + y) % 2 ? 100 : 160;
});

test("sharp centred card passes all checks", () => {
  const r = Q.assess(sharpCentred(96, 64), 96, 64);
  assert.equal(r.pass, true, JSON.stringify(r.issues));
});

test("flat image is reported as blurry", () => {
  const r = Q.assess(image(64, 64, () => 128), 64, 64);
  assert.ok(r.issues.some(i => i.code === "blur"));
});

test("smooth gradient is reported as blurry", () => {
  const r = Q.assess(image(64, 64, x => x * 3), 64, 64);
  assert.ok(r.issues.some(i => i.code === "blur"));
});

test("large near-white area is reported as glare", () => {
  const img = sharpCentred(96, 64);
  for (let y = 20; y < 40; y++) for (let x = 40; x < 60; x++) img[y * 96 + x] = 255;
  const r = Q.assess(img, 96, 64);
  assert.ok(r.issues.some(i => i.code === "glare"), JSON.stringify(r.metrics));
});

test("dark image is reported as too dark", () => {
  const img = sharpCentred(96, 64).map(v => Math.round(v * 0.2));
  const r = Q.assess(img, 96, 64);
  assert.ok(r.issues.some(i => i.code === "dark"));
});

test("content running to every edge is reported as cut off", () => {
  const r = Q.assess(image(96, 64, (x, y) => ((x + y) % 2 ? 100 : 160)), 96, 64);
  assert.ok(r.issues.some(i => i.code === "crop"), JSON.stringify(r.metrics));
});

test("toGray converts RGBA to luma", () => {
  const rgba = new Uint8ClampedArray([255, 255, 255, 255, 0, 0, 0, 255]);
  assert.deepEqual(Array.from(Q.toGray(rgba, 2, 1)), [255, 0]);
});

test("Verhoeff: reference value 236 gives check digit 3", () => {
  assert.equal(C.verhoeffCheckDigit("236"), 3);
  assert.equal(C.verhoeffValid("2363"), true);
  assert.equal(C.verhoeffValid("2364"), false);
});

test("Verhoeff: a generated number validates, a changed digit does not", () => {
  const base = "23456789012";
  const full = base + C.verhoeffCheckDigit(base);
  assert.equal(C.verhoeffValid(full), true);
  const wrong = full.slice(0, -2) + String((Number(full[full.length - 2]) + 1) % 10) + full.slice(-1);
  assert.equal(C.verhoeffValid(wrong), false);
});

test("Aadhaar format: must be 12 digits, start with 2-9, and pass Verhoeff", () => {
  const base = "23456789012";
  const good = base + C.verhoeffCheckDigit(base);
  assert.equal(C.aadhaarValid(good), true);
  assert.equal(C.aadhaarValid(good.replace(/(\d{4})(\d{4})(\d{4})/, "$1 $2 $3")), true, "spaces are allowed");
  assert.equal(C.aadhaarValid("1" + good.slice(1)), false, "cannot start with 1");
  assert.equal(C.aadhaarValid(good.slice(0, 11)), false, "too short");
});

test("PAN format: 4th letter must be a valid holder type", () => {
  assert.equal(C.panFormatValid("ABCPD1234E"), true);
  assert.equal(C.panFormatValid("ABCXD1234E"), false);
  assert.equal(C.panFormatValid("ABCPD12345"), false);
});

test("ICAO 9303 check digits match the specimen values", () => {
  assert.equal(C.icaoCheckDigit("L898902C<"), 3);
  assert.equal(C.icaoCheckDigit("690806"), 1);
  assert.equal(C.icaoCheckDigit("940623"), 6);
});

test("MRZ line 2: correct check digits pass, a changed date fails", () => {
  // Build a 44-character TD3 line 2 with real check digits, then check it.
  const fields = {
    number: "L898902C<", nationality: "UTO", birth: "690806", sex: "F",
    expiry: "940623", personal: "ZE184226B<<<<<"
  };
  const digitAt = f => String(C.icaoCheckDigit(f));
  const partsWithChecks = fields.number + digitAt(fields.number) + fields.nationality
    + fields.birth + digitAt(fields.birth) + fields.sex
    + fields.expiry + digitAt(fields.expiry) + fields.personal + digitAt(fields.personal);
  const composite = partsWithChecks.slice(0, 10) + partsWithChecks.slice(13, 20) + partsWithChecks.slice(21, 43);
  const line = partsWithChecks + digitAt(composite);
  assert.equal(line.length, 44, `line is ${line.length} characters`);

  const good = C.mrzLine2Checks(line);
  assert.equal(good.ok, true, JSON.stringify(good.checks));

  const changed = line[14] === "9" ? "8" : "9"; // index 14 is inside the birth date
  const tampered = line.slice(0, 14) + changed + line.slice(15);
  const bad = C.mrzLine2Checks(tampered);
  assert.equal(bad.ok, false);
  assert.equal(bad.checks.birthDate, false);
});

test("MRZ line must be 44 characters", () => {
  assert.equal(C.mrzLine2Checks("ABC").ok, false);
});

test("parseDMY accepts real dates and rejects impossible ones", () => {
  assert.ok(C.parseDMY("31/12/2030") instanceof Date);
  assert.equal(C.parseDMY("31-02-2030"), null, "no 31 February");
  assert.equal(C.parseDMY("2030-12-31"), null, "wrong order");
});

test("expiryStatus: expired, expiring within 90 days, valid", () => {
  const today = new Date(2026, 10, 1);
  assert.equal(C.expiryStatus(new Date(2026, 9, 1), today), "expired");
  assert.equal(C.expiryStatus(new Date(2027, 0, 15), today), "expiring");
  assert.equal(C.expiryStatus(new Date(2028, 0, 1), today), "valid");
});
