// Reads invoice-like text (a bill, an email, a PDF's text layer, or OCR output) and proposes fields.
// Rule-based and free. Every field includes the snippet it came from, so the freelancer can check it.
// Nothing here is saved or sent. The result only pre-fills a form for the freelancer to confirm.
(function (root) {
  const CURRENCY_SYMBOLS = [
    [/\bUSD\b|US\$|\$/i, "USD"],
    [/\bINR\b|₹|\bRs\.?\b/i, "INR"],
    [/\bEUR\b|€/i, "EUR"],
    [/\bGBP\b|£/i, "GBP"]
  ];
  const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
  const NUM = "(\\d{1,3}(?:,\\d{3})+|\\d+)(?:\\.(\\d{1,2}))?";

  function toNumber(intPart, decPart) {
    const n = Number(intPart.replace(/,/g, "") + (decPart ? "." + decPart : ""));
    return Number.isFinite(n) ? n : NaN;
  }

  function currencyOf(text) {
    for (const [re, code] of CURRENCY_SYMBOLS) if (re.test(text)) return code;
    return null;
  }

  // Amount: prefer a labelled total ("Total", "Amount due", "Balance due") over any other money figure.
  function findAmount(text) {
    const labelled = new RegExp(`(total(?: due)?|amount due|balance due|grand total)[^\\n\\d]{0,20}(USD|INR|EUR|GBP|US\\$|\\$|₹|€|£)?\\s?${NUM}`, "i");
    const m = text.match(labelled);
    if (m) {
      const value = toNumber(m[3], m[4]);
      const currency = currencyOf(m[2] || text) || null;
      if (value > 0) return { value, currency, snippet: m[0].trim() };
    }
    const anyMoney = new RegExp(`(USD|INR|EUR|GBP|US\\$|\\$|₹|€|£)\\s?${NUM}|${NUM}\\s?(USD|INR|EUR|GBP)`, "gi");
    let best = null;
    for (const hit of text.matchAll(anyMoney)) {
      const intPart = hit[2] || hit[5];
      const decPart = hit[3] || hit[6];
      const sym = hit[1] || hit[4];
      const value = toNumber(intPart, decPart);
      if (value > 0 && (!best || value > best.value)) {
        best = { value, currency: currencyOf(sym || text), snippet: hit[0].trim() };
      }
    }
    return best;
  }

  function findInvoiceNumber(text) {
    const m = text.match(/invoice\s*(?:no\.?|number|#)?\s*[:#]?\s*([A-Z0-9][A-Z0-9-]{2,19})\b/i);
    if (!m) return null;
    // Avoid picking up the word "date" or "to" as the number.
    if (/^(date|to|from|no|number)$/i.test(m[1])) return null;
    return { value: m[1].toUpperCase(), snippet: m[0].trim() };
  }

  function toIso(y, mo, d) {
    const date = new Date(y, mo - 1, d);
    if (date.getFullYear() !== y || date.getMonth() !== mo - 1 || date.getDate() !== d) return null;
    return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  }

  function findDueDate(text) {
    const m = text.match(/(?:due(?: date)?|payable by|pay by)\s*[:\-]?\s*([^\n]{6,30})/i);
    if (!m) return null;
    const raw = m[1].trim();
    let iso = null;
    let hit = raw.match(/(\d{4})-(\d{2})-(\d{2})/);
    if (hit) iso = toIso(+hit[1], +hit[2], +hit[3]);
    if (!iso) {
      hit = raw.match(/(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})/);
      if (hit) {
        const y = hit[3].length === 2 ? 2000 + Number(hit[3]) : Number(hit[3]);
        iso = toIso(y, +hit[2], +hit[1]);
      }
    }
    if (!iso) {
      hit = raw.match(/([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})/);
      const mo = hit ? MONTHS[hit[1].slice(0, 4).toLowerCase()] || MONTHS[hit[1].slice(0, 3).toLowerCase()] : undefined;
      if (mo) iso = toIso(+hit[3], mo, +hit[2]);
    }
    return iso ? { value: iso, snippet: `Due ${raw}` } : null;
  }

  // Client: the line after "Bill to" or "Client", or the name before an email if no label is found.
  function findClient(text) {
    const lines = text.replace(/\r/g, "").split("\n").map(l => l.trim()).filter(Boolean);
    const idx = lines.findIndex(l => /^(bill(ed)? to|client|customer|to)\s*:?\s*$/i.test(l) || /^(bill(ed)? to|client)\s*:\s*\S/i.test(l));
    if (idx >= 0) {
      const inline = lines[idx].match(/^(?:bill(?:ed)? to|client)\s*:\s*(.+)$/i);
      const name = inline ? inline[1] : lines[idx + 1];
      if (name && name.length >= 2 && name.length <= 80 && !/@/.test(name) && !/\d{4,}/.test(name)) {
        return { value: name.replace(/[,;]$/, ""), snippet: lines[idx] };
      }
    }
    return null;
  }

  function findEmail(text) {
    const m = text.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
    return m ? { value: m[0], snippet: m[0] } : null;
  }

  // Main entry point. Returns the proposed fields and a rough confidence score.
  function parseInvoice(rawText) {
    const text = String(rawText || "").slice(0, 20000);
    const fields = {
      amount: findAmount(text),
      invoiceNumber: findInvoiceNumber(text),
      dueDate: findDueDate(text),
      clientName: findClient(text),
      clientEmail: findEmail(text)
    };
    const found = Object.values(fields).filter(Boolean).length;
    const warnings = [];
    if (fields.amount && !fields.amount.currency) warnings.push("Currency not found. Check the amount is in USD.");
    if (fields.amount && fields.amount.currency && fields.amount.currency !== "USD") {
      warnings.push(`This invoice is in ${fields.amount.currency}. The calculator expects USD. Convert it first.`);
    }
    if (!fields.amount) warnings.push("No total found. Type the amount yourself.");
    return { fields, found, total: 5, confidence: Number((found / 5).toFixed(2)), warnings };
  }

  const api = { parseInvoice, findAmount, findInvoiceNumber, findDueDate, findClient, findEmail };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.InvoiceParser = api;
})(typeof self !== "undefined" ? self : this);
