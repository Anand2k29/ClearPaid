// Freelancer money maths. Pure functions, so they can be tested without a browser.
// Every rate is an input the freelancer can change. The defaults are estimates from public
// sources and must be checked against PayPal's current published rates before any real use.
(function (root) {
  const DEFAULTS = {
    receivingFeePct: 4.4,     // estimate; a competitor blog cites 3% to 4.4% depending on type and volume
    conversionMarkupPct: 3.5, // estimate; cited as roughly 3% to 4% above mid-market
    withdrawalFee: 0,         // varies by source; set to the flat fee you see in your account
    midMarketRate: 83,        // INR per USD. Enter the live rate yourself; this is a placeholder
    opportunityRatePct: 12    // annual rate you could earn on money sitting unpaid. Assumption
  };

  // What arrives in the bank for one invoice, in INR.
  function netReceived(amountUsd, opts = {}) {
    const o = { ...DEFAULTS, ...opts };
    const gross = amountUsd;
    const afterReceiving = gross * (1 - o.receivingFeePct / 100);
    const usdToInrAtMarket = afterReceiving * o.midMarketRate;
    const inrAfterMarkup = usdToInrAtMarket * (1 - o.conversionMarkupPct / 100);
    const net = inrAfterMarkup - o.withdrawalFee * o.midMarketRate;
    const idealInr = amountUsd * o.midMarketRate;
    return {
      gross,
      receivingFeeUsd: gross * o.receivingFeePct / 100,
      conversionLossInr: usdToInrAtMarket - inrAfterMarkup,
      withdrawalFeeInr: o.withdrawalFee * o.midMarketRate,
      netInr: Math.round(net),
      idealInr: Math.round(idealInr),
      totalLossInr: Math.round(idealInr - net),
      effectivePct: idealInr ? Number(((1 - net / idealInr) * 100).toFixed(2)) : 0
    };
  }

  // Cost of money that arrives late: the interest you could have earned on it.
  function lateCostInr(amountUsd, daysLate, opts = {}) {
    const o = { ...DEFAULTS, ...opts };
    return Math.round(amountUsd * o.midMarketRate * (o.opportunityRatePct / 100) * (daysLate / 365));
  }

  // Compares a list of providers, each with its own fee settings, for the same invoice.
  function compare(amountUsd, providers) {
    return providers
      .map(p => ({
        name: p.name,
        receivingFeePct: p.receivingFeePct,
        conversionMarkupPct: p.conversionMarkupPct,
        ...netReceived(amountUsd, p)
      }))
      .sort((a, b) => b.netInr - a.netInr);
  }

  const api = { DEFAULTS, netReceived, lateCostInr, compare };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.FreelancerCalc = api;
})(typeof self !== "undefined" ? self : this);
