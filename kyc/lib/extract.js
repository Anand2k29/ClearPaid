// Pulls candidate fields out of OCR text and attaches the format and checksum results.
// Output is a suggestion for the employee to confirm. Names are not extracted automatically.
(function (root) {
  const checks = typeof module !== "undefined" && module.exports
    ? require("./checks.js")
    : root.KycChecks;

  function extractFields(text, today = new Date()) {
    const lines = text.replace(/\r/g, "").split("\n").map(l => l.trim()).filter(Boolean);
    const flat = lines.join("\n");

    const result = { aadhaar: null, pan: null, dates: [], mrz: null, warnings: [] };

    // Aadhaar: 12 digits, often printed as 4-4-4.
    const aadhaarMatch = flat.match(/\b\d{4}\s?\d{4}\s?\d{4}\b/);
    if (aadhaarMatch) {
      const value = aadhaarMatch[0].replace(/\s/g, "");
      result.aadhaar = { value, checksumValid: checks.aadhaarValid(value) };
      if (!result.aadhaar.checksumValid) result.warnings.push("Aadhaar-like number fails the checksum. Re-read it or retake the photo.");
    }

    // PAN: 10 characters in a fixed pattern.
    const panMatch = flat.match(/\b[A-Z]{5}\d{4}[A-Z]\b/);
    if (panMatch) {
      result.pan = { value: panMatch[0], formatValid: checks.panFormatValid(panMatch[0]) };
    }

    // Dates, each checked as a real calendar date. Only dates labelled as expiry get an expiry status.
    // A date of birth must never be reported as expired.
    result.dates = [];
    lines.forEach(line => {
      const label = /\b(dob|birth|issue|issued)\b/i.test(line) ? "other" : /\b(valid|expir|expiry|till|upto|up to)\b/i.test(line) ? "expiry" : "other";
      [...line.matchAll(/\b\d{2}[\/\-.]\d{2}[\/\-.]\d{4}\b/g)].forEach(m => {
        const d = checks.parseDMY(m[0]);
        const kind = /\b(dob|birth)\b/i.test(line) ? "birth" : label;
        result.dates.push({
          raw: m[0],
          kind,
          valid: Boolean(d),
          status: !d ? "invalid" : kind === "expiry" ? checks.expiryStatus(d, today) : "not an expiry"
        });
      });
    });

    // Passport machine-readable zone: two 44-character lines. Line 2 carries check digits.
    const mrzLines = lines.map(l => l.replace(/\s/g, "")).filter(l => /^[A-Z0-9<]{44}$/.test(l));
    if (mrzLines.length >= 2) {
      const line2 = mrzLines[mrzLines.length - 1];
      result.mrz = { line2, ...checks.mrzLine2Checks(line2) };
      if (!result.mrz.ok) result.warnings.push("Passport check digits do not match. The text was misread or the photo is damaged.");
    }

    return result;
  }

  const api = { extractFields };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.KycExtract = api;
})(typeof self !== "undefined" ? self : this);
