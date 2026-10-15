/* Ledger League simulation engine — shared by the server (Node) and the browser. Pure functions, no I/O. */
(function (root, factory) {
  const m = factory();
  if (typeof module === "object" && module.exports) module.exports = m;
  else root.Engine = m;
})(typeof self !== "undefined" ? self : this, function () {
  const START = { cash: 5000000, capacity: 10000, inventory: 0, invValue: 0, brand: 50, quality: 50, loan: 0, fixedAssets: 3000000, cumProfit: 0 };
  const K = {
    REF_PRICE: 500, BASE_DEMAND: 9000, BASE_COST: 250, OVERHEAD: 500000, UPKEEP: 20, HOLD: 15, CAP_COST: 400,
    INTEREST: 0.03, EMERGENCY_FEE: 0.05, TAX: 0.25, DEPRECIATION: 0.05, MAX_LOAN: 10000000, BRAND_VAL: 50000, QUALITY_VAL: 30000
  };
  const DEFAULT_DEC = { price: 500, production: 8000, marketing: 300000, rd: 200000, capex: 0, loan: 0 };
  const EVENTS = {
    normal:    { name: "Steady market",          desc: "No surprises. Demand and costs are at baseline.", demand: 1, cost: 1, ps: 2, mkt: 1 },
    festive:   { name: "Festive season rush",    desc: "Diwali and wedding season: total market demand is up 30%.", demand: 1.3, cost: 1, ps: 2, mkt: 1 },
    inflation: { name: "Raw-material inflation", desc: "Steel, plastic and freight costs jump: unit cost is up 15%.", demand: 1, cost: 1.15, ps: 2, mkt: 1 },
    recession: { name: "Consumer slowdown",      desc: "Market shrinks 20% and buyers become more price-sensitive.", demand: 0.8, cost: 1, ps: 2.6, mkt: 1 },
    subsidy:   { name: "PLI subsidy",            desc: "A government production incentive cuts unit cost by 10%.", demand: 1, cost: 0.9, ps: 2, mkt: 1 },
    viral:     { name: "Social media buzz",      desc: "A trending reel puts the category in focus: marketing builds brand 50% faster.", demand: 1.05, cost: 1, ps: 2, mkt: 1.5 },
    imports:   { name: "Cheap imports arrive",   desc: "Low-cost imports take 10% of the market and buyers compare prices harder.", demand: 0.9, cost: 1, ps: 2.4, mkt: 1 }
  };
  const SCHEDULES = {
    4: ["normal", "festive", "inflation", "recession"],
    5: ["normal", "inflation", "festive", "recession", "subsidy"],
    6: ["normal", "inflation", "festive", "recession", "subsidy", "viral"],
    7: ["normal", "inflation", "imports", "festive", "recession", "subsidy", "viral"],
    8: ["normal", "inflation", "imports", "festive", "recession", "subsidy", "viral", "festive"]
  };
  const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
  const num = (x, d = 0) => { const n = Number(x); return Number.isFinite(n) ? n : d; };

  function normDec(d, p) {
    d = d || {};
    const price = Math.round(clamp(num(d.price, DEFAULT_DEC.price), 100, 2000));
    const production = Math.round(clamp(num(d.production, 0), 0, p.capacity));
    const marketing = Math.round(clamp(num(d.marketing, 0), 0, 20000000));
    const rd = Math.round(clamp(num(d.rd, 0), 0, 20000000));
    const capex = Math.round(clamp(num(d.capex, 0), 0, 50000000));
    let loan = Math.round(num(d.loan, 0));
    if (loan > 0) loan = Math.min(loan, Math.max(0, K.MAX_LOAN - p.loan));
    if (loan < 0) loan = -Math.min(-loan, p.loan, Math.max(0, p.cash));
    return { price, production, marketing, rd, capex, loan };
  }
  const companyValue = s => s.netWorth + s.brand * K.BRAND_VAL + s.quality * K.QUALITY_VAL;
  function startState(cfg) {
    const s = { ...START, cash: num(cfg.startCash, START.cash) };
    s.netWorth = s.cash + s.invValue + s.fixedAssets - s.loan;
    s.value = companyValue(s);
    return s;
  }
  /* Estimated unit cost for a decision (used by the live preview). */
  function estUnitCost(evKey, st, d) {
    const ev = EVENTS[evKey] || EVENTS.normal;
    const q = clamp(st.quality * 0.92 + 5 * Math.log(1 + d.rd / 1e5), 0, 100);
    let uc = K.BASE_COST * ev.cost * (1 + (q - 50) / 400);
    if (d.production >= 0.8 * st.capacity && d.production > 0) uc *= 0.95;
    return uc;
  }

  /* cfg:{teams:[{id}],events:[key]}, r: 1-based round, prev:{tid:state}, decs:{tid:{dec,auto,by,at}} */
  function simulate(cfg, r, prev, decs) {
    const ev = EVENTS[cfg.events[r - 1]] || EVENTS.normal;
    const tids = cfg.teams.map(t => t.id); const N = tids.length;
    const R = {};
    for (const tid of tids) {
      const p = prev[tid]; const d = normDec(decs[tid] && decs[tid].dec, p);
      const brand = clamp(p.brand * 0.85 + 6 * Math.log(1 + d.marketing / 1e5) * ev.mkt, 0, 100);
      const quality = clamp(p.quality * 0.92 + 5 * Math.log(1 + d.rd / 1e5), 0, 100);
      let unitCost = K.BASE_COST * ev.cost * (1 + (quality - 50) / 400);
      if (d.production >= 0.8 * p.capacity && d.production > 0) unitCost *= 0.95;
      const avail = p.inventory + d.production;
      const avgCost = avail > 0 ? (p.invValue + d.production * unitCost) / avail : unitCost;
      const score = Math.pow(K.REF_PRICE / d.price, ev.ps) * (0.4 + brand / 100) * (0.4 + quality / 100);
      R[tid] = { p, d, brand, quality, unitCost, avail, avgCost, score };
    }
    const avgPrice = tids.reduce((a, t) => a + R[t].d.price, 0) / N;
    const market = K.BASE_DEMAND * N * ev.demand * Math.pow(K.REF_PRICE / avgPrice, 0.8) * (1 + 0.03 * (r - 1));
    const totalScore = tids.reduce((a, t) => a + R[t].score, 0) || 1;
    let unmet = 0;
    for (const t of tids) { const x = R[t]; x.demand = market * x.score / totalScore; x.sales = Math.min(x.demand, x.avail); unmet += x.demand - x.sales; }
    // Half of the customers who found a team out of stock buy from rivals that still have stock.
    const spill = unmet * 0.5; const cand = tids.filter(t => R[t].avail - R[t].sales > 0.5);
    const cs = cand.reduce((a, t) => a + R[t].score, 0);
    if (cs > 0) for (const t of cand) { const x = R[t]; const extra = Math.min(spill * x.score / cs, x.avail - x.sales); x.sales += extra; x.demand += extra; }
    let totalSales = 0;
    for (const t of tids) { R[t].sales = Math.floor(R[t].sales); totalSales += R[t].sales; }
    const out = {};
    for (const t of tids) {
      const { p, d, brand, quality, unitCost, avail, avgCost, sales, demand } = R[t];
      const revenue = sales * d.price, cogs = sales * avgCost, endInv = avail - sales, invValue = endInv * avgCost;
      const holding = endInv * K.HOLD, overhead = K.OVERHEAD, upkeep = p.capacity * K.UPKEEP;
      const depreciation = p.fixedAssets * K.DEPRECIATION, interest = p.loan * K.INTEREST;
      const grossProfit = revenue - cogs;
      const pbt = grossProfit - d.marketing - d.rd - overhead - upkeep - holding - depreciation - interest;
      const tax = Math.max(0, pbt) * K.TAX;
      let netProfit = pbt - tax, loan = p.loan + d.loan;
      let cash = p.cash + d.loan + revenue - d.production * unitCost - d.marketing - d.rd - overhead - upkeep - holding - interest - tax - d.capex;
      let emergency = 0, fee = 0;
      if (cash < 0) { emergency = -cash; fee = emergency * K.EMERGENCY_FEE; loan += emergency + fee; cash = 0; netProfit -= fee; }
      const fixedAssets = p.fixedAssets - depreciation + d.capex;
      const capacity = p.capacity + Math.floor(d.capex / K.CAP_COST);
      const s = { cash, capacity, inventory: endInv, invValue, brand, quality, loan, fixedAssets, cumProfit: p.cumProfit + netProfit };
      s.netWorth = cash + invValue + fixedAssets - loan; s.value = companyValue(s);
      out[t] = {
        ...s, dec: d, auto: !!(decs[t] && decs[t].auto), by: (decs[t] && decs[t].by) || null, at: (decs[t] && decs[t].at) || null,
        demand: Math.round(demand), sales, lostSales: Math.max(0, Math.round(demand - sales)), share: totalSales ? sales / totalSales : 0,
        unitCost, revenue, cogs, grossProfit, overhead, upkeep, holding, depreciation, interest, pbt, tax, emergency, fee, netProfit
      };
    }
    const ranked = [...tids].sort((a, b) => out[b].value - out[a].value); ranked.forEach((t, i) => out[t].rank = i + 1);
    return { teams: out, market: { demand: Math.round(market), sales: totalSales, avgPrice, event: cfg.events[r - 1] || "normal" } };
  }
  return { START, K, DEFAULT_DEC, EVENTS, SCHEDULES, clamp, num, normDec, companyValue, startState, estUnitCost, simulate };
});
