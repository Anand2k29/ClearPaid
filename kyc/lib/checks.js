// Format and checksum checks for identity fields.
// These confirm a value is well formed. They do NOT prove the document is genuine or that it belongs to the person.
(function (root) {
  // Verhoeff tables. The Aadhaar number uses a Verhoeff check digit.
  const D = [
    [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
    [1, 2, 3, 4, 0, 6, 7, 8, 9, 5],
    [2, 3, 4, 0, 1, 7, 8, 9, 5, 6],
    [3, 4, 0, 1, 2, 8, 9, 5, 6, 7],
    [4, 0, 1, 2, 3, 9, 5, 6, 7, 8],
    [5, 9, 8, 7, 6, 0, 4, 3, 2, 1],
    [6, 5, 9, 8, 7, 1, 0, 4, 3, 2],
    [7, 6, 5, 9, 8, 2, 1, 0, 4, 3],
    [8, 7, 6, 5, 9, 3, 2, 1, 0, 4],
    [9, 8, 7, 6, 5, 4, 3, 2, 1, 0]
  ];
  const P = [
    [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
    [1, 5, 7, 6, 2, 8, 3, 0, 9, 4],
    [5, 8, 0, 3, 7, 9, 6, 1, 4, 2],
    [8, 9, 1, 6, 0, 4, 3, 5, 2, 7],
    [9, 4, 5, 3, 1, 2, 6, 8, 7, 0],
    [4, 2, 8, 6, 5, 7, 3, 9, 0, 1],
    [2, 7, 9, 3, 8, 0, 6, 4, 1, 5],
    [7, 0, 4, 6, 9, 1, 3, 2, 5, 8]
  ];
  const INV = [0, 4, 3, 2, 1, 5, 6, 7, 8, 9];

  const digitsReversed = s => s.split("").reverse().map(Number);

  function verhoeffValid(num) {
    if (!/^\d+$/.test(num)) return false;
    let c = 0;
    digitsReversed(num).forEach((d, i) => { c = D[c][P[i % 8][d]]; });
    return c === 0;
  }

  // Returns the check digit that makes partial + digit valid.
  function verhoeffCheckDigit(partial) {
    let c = 0;
    digitsReversed(partial).forEach((d, i) => { c = D[c][P[(i + 1) % 8][d]]; });
    return INV[c];
  }

  function aadhaarValid(value) {
    const clean = value.replace(/\s/g, "");
    return /^[2-9]\d{11}$/.test(clean) && verhoeffValid(clean);
  }

  // PAN: 5 letters, 4 digits, 1 letter. The 4th letter is the holder type (P, C, H, F, A, T, B, L, J, G).
  function panFormatValid(value) {
    return /^[A-Z]{3}[PCHFATBLJG][A-Z][0-9]{4}[A-Z]$/.test(value);
  }

  // ICAO 9303 check digit: weights 7, 3, 1 repeating. Digits keep their value, A=10 ... Z=35, '<' = 0.
  function icaoCheckDigit(field) {
    const weights = [7, 3, 1];
    let sum = 0;
    for (let i = 0; i < field.length; i++) {
      const ch = field[i];
      let v;
      if (ch === "<") v = 0;
      else if (/\d/.test(ch)) v = Number(ch);
      else v = ch.charCodeAt(0) - 55; // 'A' is 65, so A gives 10
      sum += v * weights[i % 3];
    }
    return sum % 10;
  }

  // Checks the passport data line (TD3, 44 characters). Returns one result per check digit.
  function mrzLine2Checks(line) {
    if (line.length !== 44) return { ok: false, reason: "Line is not 44 characters" };
    const checks = {
      passportNumber: icaoCheckDigit(line.slice(0, 9)) === Number(line[9]),
      birthDate: icaoCheckDigit(line.slice(13, 19)) === Number(line[19]),
      expiry: icaoCheckDigit(line.slice(21, 27)) === Number(line[27]),
      personalNumber: icaoCheckDigit(line.slice(28, 42)) === Number(line[42])
    };
    const composite = line.slice(0, 10) + line.slice(13, 20) + line.slice(21, 43);
    checks.composite = icaoCheckDigit(composite) === Number(line[43]);
    return { ok: Object.values(checks).every(Boolean), checks };
  }

  // Parses dd/mm/yyyy, dd-mm-yyyy or dd.mm.yyyy. Returns null if the date does not exist.
  function parseDMY(text) {
    const m = text.match(/^(\d{2})[\/\-.](\d{2})[\/\-.](\d{4})$/);
    if (!m) return null;
    const day = Number(m[1]);
    const month = Number(m[2]);
    const year = Number(m[3]);
    const d = new Date(year, month - 1, day);
    if (d.getFullYear() !== year || d.getMonth() !== month - 1 || d.getDate() !== day) return null;
    return d;
  }

  // Expired, expiring within 90 days, or valid. Pass today's date explicitly so the result is testable.
  function expiryStatus(date, today) {
    const ms = date - today;
    if (ms < 0) return "expired";
    if (ms < 90 * 86400000) return "expiring";
    return "valid";
  }

  const api = {
    verhoeffValid, verhoeffCheckDigit, aadhaarValid, panFormatValid,
    icaoCheckDigit, mrzLine2Checks, parseDMY, expiryStatus
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.KycChecks = api;
})(typeof self !== "undefined" ? self : this);
