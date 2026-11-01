// Monthly ledger for the freelancer's accountant: one row per paid invoice, exported as CSV.
// Rates are entered by the freelancer on the day the money arrived. The app does not fetch
// historical rates, so every rate shown in the export is one the freelancer typed or confirmed.
(function (root) {
  const COLUMNS = [
    "Date received", "Invoice", "Client", "Amount (USD)", "Rate on receipt (INR per USD)",
    "Gross (INR)", "PayPal receiving fee (USD)", "Net after fee (INR, estimate)", "Notes"
  ];

  // Stops spreadsheet formula injection: a cell starting with = + - @ or a tab is prefixed with an apostrophe.
  function safeCell(value) {
    let s = value === null || value === undefined ? "" : String(value);
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
    if (/[",\n\r]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
    return s;
  }

  // rows: [{ paidAt, number, clientName, amountUsd, rate, receivingFeePct, notes }]
  // Only rows that have a receipt date and rate are included. Others are listed as "missing" so nothing is hidden.
  function buildLedger(rows, { month } = {}) {
    const included = [];
    const missing = [];
    rows.forEach(r => {
      const d = r.paidAt ? new Date(r.paidAt) : null;
      if (!d || Number.isNaN(d.getTime())) return missing.push({ ...r, problem: "no receipt date" });
      if (month && d.toISOString().slice(0, 7) !== month) return;
      if (!(r.rate > 0)) return missing.push({ ...r, problem: "no rate entered" });
      const fee = r.amountUsd * (Number(r.receivingFeePct) || 0) / 100;
      const gross = r.amountUsd * r.rate;
      const net = (r.amountUsd - fee) * r.rate;
      included.push({
        date: d.toISOString().slice(0, 10),
        number: r.number || "",
        client: r.clientName || "",
        usd: r.amountUsd,
        rate: r.rate,
        gross: Math.round(gross),
        fee: Number(fee.toFixed(2)),
        net: Math.round(net),
        notes: r.notes || ""
      });
    });
    included.sort((a, b) => a.date.localeCompare(b.date));
    const totals = included.reduce((t, r) => ({
      usd: t.usd + r.usd, gross: t.gross + r.gross, fee: t.fee + r.fee, net: t.net + r.net
    }), { usd: 0, gross: 0, fee: 0, net: 0 });
    return { rows: included, totals, missing };
  }

  function toCsv(ledger) {
    const lines = [COLUMNS.map(safeCell).join(",")];
    ledger.rows.forEach(r => {
      lines.push([r.date, r.number, r.client, r.usd.toFixed(2), r.rate, r.gross, r.fee.toFixed(2), r.net, r.notes].map(safeCell).join(","));
    });
    const t = ledger.totals;
    lines.push(["Total", "", "", t.usd.toFixed(2), "", t.gross, t.fee.toFixed(2), t.net, "Estimate. Check with your bank and accountant."].map(safeCell).join(","));
    return lines.join("\r\n") + "\r\n";
  }

  const api = { COLUMNS, safeCell, buildLedger, toCsv };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.FreelancerLedger = api;
})(typeof self !== "undefined" ? self : this);
