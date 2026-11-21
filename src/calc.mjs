// The five calculations. Every function here is pure: it takes parsed series
// and returns plain numbers, so the same inputs always give the same output.
//
// Series from FRED are arrays of { date: "YYYY-MM-DD", ym: "YYYY-MM", value }.
// Shiller rows are { ym, price, dividend, cpi }, one per month since 1871.

export const round = (x, places = 2) => Math.round(x * 10 ** places) / 10 ** places;
const last = (xs) => xs.at(-1);
const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
const pct = (x, places = 1) => round(100 * x, places);
const cagr = (growth, years) => growth ** (1 / years) - 1;
const yearBefore = (ym) => `${Number(ym.slice(0, 4)) - 1}${ym.slice(4)}`;

// A daily series folded into months: the average of the month and its last value.
const monthly = (series) => {
  const by = new Map();
  for (const p of series) by.set(p.ym, [...(by.get(p.ym) ?? []), p.value]);
  return [...by].map(([ym, vs]) => ({ ym, value: mean(vs), last: vs.at(-1) }));
};

// The largest fall from any earlier peak, and where it began and bottomed.
export const drawdown = (values) => {
  let peak = values[0];
  let peakAt = 0;
  let worst = { depth: 0, peakAt: 0, troughAt: 0 };
  values.forEach((v, n) => {
    if (v > peak) {
      peak = v;
      peakAt = n;
    }
    const depth = 1 - v / peak;
    if (depth > worst.depth) worst = { depth, peakAt, troughAt: n };
  });
  return worst;
};

// The 12-month change, for the latest month that has a reading a year earlier.
// Months are matched by date. Counting 12 rows back is not safe: October 2025
// was never surveyed, so CPIAUCSL has a hole, rows and months stop lining up
// after it, and October 2026 has no month a year earlier to be compared with.
export const yearOnYear = (series) => {
  const by = new Map(series.map((p) => [p.ym, p.value]));
  const latest = series.findLast((p) => by.has(yearBefore(p.ym)));
  if (!latest) throw new Error("The series has no month with a reading one year earlier.");
  const comparedWith = yearBefore(latest.ym);
  return { month: latest.ym, comparedWith, change: latest.value / by.get(comparedWith) - 1 };
};

/* ── 1. Macro dashboard ──────────────────────────────────────── */

export const macro = ({ DGS10, DGS2, T10Y2Y, FEDFUNDS, UNRATE, CPIAUCSL, USREC, SP500 }) => {
  const inflation = yearOnYear(CPIAUCSL);
  // Fisher: 1 + real = (1 + nominal) / (1 + inflation).
  const realFedFunds = (1 + last(FEDFUNDS).value / 100) / (1 + inflation.change) - 1;
  return {
    tenYear: { value: last(DGS10).value, date: last(DGS10).date },
    twoYear: { value: last(DGS2).value, date: last(DGS2).date },
    spread: { value: last(T10Y2Y).value, date: last(T10Y2Y).date },
    fedFunds: { value: last(FEDFUNDS).value, month: last(FEDFUNDS).ym },
    unemployment: { value: last(UNRATE).value, month: last(UNRATE).ym },
    cpiYoYPct: pct(inflation.change),
    cpiMonth: inflation.month,
    cpiComparedWith: inflation.comparedWith,
    realFedFundsPct: pct(realFedFunds),
    sp500: { value: last(SP500).value, date: last(SP500).date },
    recessionDataThrough: last(USREC).ym,
    inRecessionNow: last(USREC).value === 1,
  };
};

/* ── 2. Rates and the yield curve ────────────────────────────── */

// T10Y2Y begins in June 1976, so June 1978 is the first month with two years of curve behind it.
const CURVE_RECORD_FROM = "1978-06";

export const curve = ({ DGS10, DGS2, T10Y2Y, USREC }) => {
  const curveMonthly = monthly(T10Y2Y);
  const monthIndex = new Map(curveMonthly.map((p, n) => [p.ym, n]));
  // Recessions that began inside the yield-curve record, and whether the curve
  // had been inverted in the two years before each: once on monthly averages,
  // once on any single day.
  const recessions = USREC.filter((p, n) => p.value === 1 && USREC[n - 1]?.value === 0 && p.ym >= CURVE_RECORD_FROM).map((p) => {
    const n = monthIndex.get(p.ym);
    const from = `${yearBefore(yearBefore(p.ym))}-01`;
    return {
      began: p.ym,
      invertedInMonthlyAverages: curveMonthly.slice(Math.max(0, n - 24), n).some((m) => m.value < 0),
      invertedOnAnyDay: T10Y2Y.some((d) => d.value < 0 && d.date >= from && d.date < `${p.ym}-01`),
    };
  });
  // The longest unbroken run of months whose average was below zero.
  let run = null;
  let longest = { months: 0 };
  for (const p of curveMonthly) {
    if (p.value < 0) {
      run = run ? { ...run, to: p.ym, months: run.months + 1 } : { from: p.ym, to: p.ym, months: 1 };
      if (run.months > longest.months) longest = run;
    } else run = null;
  }
  return {
    tenYear: { value: last(DGS10).value, date: last(DGS10).date },
    twoYear: { value: last(DGS2).value, date: last(DGS2).date },
    spread: { value: last(T10Y2Y).value, date: last(T10Y2Y).date },
    invertedNow: last(T10Y2Y).value < 0,
    lastInvertedMonth: curveMonthly.findLast((p) => p.value < 0)?.ym ?? null,
    longestInversion: longest,
    recessionSinceLongestInversion: USREC.some((p) => p.value === 1 && p.ym > longest.to),
    recessionDataThrough: last(USREC).ym,
    recessions,
    recessionsSince1978: recessions.map((r) => r.began),
    recessionsPrecededByInversion: recessions.filter((r) => r.invertedInMonthlyAverages).length,
    recessionsPrecededByDailyInversion: recessions.filter((r) => r.invertedOnAnyDay).length,
  };
};

/* ── 3. Company fundamentals, from annual filings ────────────── */

// Companies have reported revenue under different names over the years.
const REVENUE_TAGS = ["SalesRevenueNet", "Revenues", "RevenueFromContractWithCustomerExcludingAssessedTax"];
const INCOME_TAGS = ["NetIncomeLoss"];
const FIRST_YEAR = 2010;

// One value per fiscal year from 10-K filings: full-year periods only, and
// where a year was reported more than once, the figure from the latest filing.
const annual = (facts, tags) => {
  const byYear = new Map();
  for (const tag of tags) {
    for (const row of facts.facts?.["us-gaap"]?.[tag]?.units?.USD ?? []) {
      if (row.form !== "10-K" || !row.start) continue;
      const days = (new Date(row.end) - new Date(row.start)) / 86400000;
      if (days < 350 || days > 380) continue;
      const year = Number(row.end.slice(0, 4));
      const prev = byYear.get(year);
      if (!prev || row.filed > prev.filed) byYear.set(year, { value: row.val, filed: row.filed, end: row.end });
    }
  }
  return byYear;
};

export const company = (facts) => {
  const revenue = annual(facts, REVENUE_TAGS);
  const income = annual(facts, INCOME_TAGS);
  const years = [...revenue.keys()].filter((y) => income.has(y) && y >= FIRST_YEAR).sort();
  if (years.length === 0) {
    throw new Error(
      `${facts.entityName ?? "This company"} has no annual revenue and net income in U.S. dollars under the standard U.S. GAAP names in its 10-K filings.`,
    );
  }
  const rows = years.map((y) => ({
    year: y,
    fiscalYearEnd: revenue.get(y).end,
    revenueBn: round(revenue.get(y).value / 1e9, 1),
    netIncomeBn: round(income.get(y).value / 1e9, 1),
    marginPct: pct(income.get(y).value / revenue.get(y).value),
    revenueGrowthPct: revenue.has(y - 1) ? pct(revenue.get(y).value / revenue.get(y - 1).value - 1) : null,
  }));
  const first = rows[0];
  const latest = last(rows);
  return {
    company: facts.entityName,
    cik: Number(facts.cik),
    rows,
    revenueCagrPct: latest.year > first.year ? pct((latest.revenueBn / first.revenueBn) ** (1 / (latest.year - first.year)) - 1) : null,
    from: first.year,
    to: latest.year,
  };
};

/* ── 4. Long-run history: the S&P composite since 1871 ───────── */

// Monthly total return: price change plus one twelfth of the annual dividend.
const totalReturns = (shiller) => {
  // The mirror stops reporting dividends partway through; hold them at the last reported level.
  const lastDividendAt = shiller.findLastIndex((m) => m.dividend > 0);
  const rows = shiller.map((m, n) => (n > lastDividendAt ? { ...m, dividend: shiller[lastDividendAt].dividend } : m));
  const ret = rows.map((m, n) => (n === 0 ? 0 : (m.price + m.dividend / 12) / rows[n - 1].price - 1));
  return { rows, ret, lastDividendAt };
};

export const history = (shiller) => {
  const { rows, ret, lastDividendAt } = totalReturns(shiller);
  const lastCpiAt = rows.findLastIndex((m) => m.cpi > 0);
  const wealth = [1];
  for (let n = 1; n < rows.length; n++) wealth.push(wealth[n - 1] * (1 + ret[n]));
  const realWealth = wealth.slice(0, lastCpiAt + 1).map((v, n) => v / (rows[n].cpi / rows[0].cpi));
  const worst = drawdown(wealth);
  const years = (rows.length - 1) / 12;
  const priceGrowth = last(rows).price / rows[0].price;
  return {
    from: rows[0].ym,
    to: last(rows).ym,
    months: rows.length,
    growthOfOneDollar: Math.round(last(wealth)),
    cagrPct: pct(cagr(last(wealth), years), 2),
    realCagrPct: pct(cagr(last(realWealth), lastCpiAt / 12), 2),
    realThrough: rows[lastCpiAt].ym,
    priceOnlyGrowthOfOneDollar: Math.round(priceGrowth),
    priceOnlyCagrPct: pct(cagr(priceGrowth, years), 2),
    worstDrawdownPct: pct(worst.depth),
    worstDrawdownFrom: rows[worst.peakAt].ym,
    worstDrawdownTo: rows[worst.troughAt].ym,
    dividendsHeldFlatAfter: rows[lastDividendAt].ym,
  };
};

/* ── 5. The strategy test: Faber's 10-month rule ─────────────── */

const TEST_FROM = "1934-02"; // first month with a T-bill rate known at its start
const PUBLISHED = "2007-01"; // Faber's paper came out in 2007

export const faber = ({ shiller, TB3MS, SP500 }) => {
  const { rows, ret } = totalReturns(shiller);
  const bill = new Map(TB3MS.map((p) => [p.ym, p.value]));
  const at = (ym) => rows.findIndex((m) => m.ym === ym);
  const startAt = at(TEST_FROM);
  const splitAt = at(PUBLISHED);
  const endAt = rows.length - 1;
  if (startAt < 0 || splitAt < 0) throw new Error("The S&P history does not cover 1934 to 2007, so the test cannot run.");

  const sma = (n) => mean(rows.slice(n - 9, n + 1).map((m) => m.price));
  // Signal read at month n-2, traded during month n-1, earning the return of
  // month n. The delay is there because Shiller's monthly prices are averages
  // of daily closes, which nobody can trade at.
  const invested = rows.map((m, n) => (n < startAt ? null : rows[n - 2].price > sma(n - 2)));
  const cashReturn = rows.map((m, n) => (n < startAt ? null : (bill.get(rows[n - 1].ym) ?? 0) / 1200));
  const ruleReturn = rows.map((m, n) => (n < startAt ? null : invested[n] ? ret[n] : cashReturn[n]));

  const stats = (returns, from, to, flags) => {
    const slice = returns.slice(from, to + 1);
    const path = [1];
    for (const r of slice) path.push(path.at(-1) * (1 + r));
    const worst = drawdown(path);
    const byYear = new Map();
    slice.forEach((r, k) => {
      const y = rows[from + k].ym.slice(0, 4);
      byYear.set(y, { growth: (byYear.get(y)?.growth ?? 1) * (1 + r), months: (byYear.get(y)?.months ?? 0) + 1 });
    });
    const fullYears = [...byYear].filter(([, v]) => v.months === 12).map(([y, v]) => ({ year: y, ret: v.growth - 1 }));
    const worstYear = fullYears.reduce((a, b) => (b.ret < a.ret ? b : a));
    const out = {
      from: rows[from].ym,
      to: rows[to].ym,
      cagrPct: pct(cagr(last(path), slice.length / 12), 2),
      growthOfOneDollar: round(last(path), last(path) > 100 ? 0 : 2),
      worstDrawdownPct: pct(worst.depth),
      worstDrawdownTrough: rows[from + Math.max(0, worst.troughAt - 1)].ym,
      worstCalendarYear: `${worstYear.year}: ${pct(worstYear.ret)}%`,
    };
    if (flags) {
      const f = flags.slice(from, to + 1);
      out.shareOfMonthsInvestedPct = pct(f.filter(Boolean).length / f.length);
      out.switches = f.filter((v, k) => k > 0 && v !== f[k - 1]).length;
    }
    return out;
  };
  const both = (from, to) => ({ hold: stats(ret, from, to), rule: stats(ruleReturn, from, to, invested) });

  // What stocks returned in the months the rule held them and in the months it
  // sat out, and where the extreme months fell.
  const annualised = (returns) => returns.reduce((g, r) => g * (1 + r), 1) ** (12 / returns.length) - 1;
  const tested = rows.map((m, n) => n).slice(startAt);
  const monthsIn = tested.filter((n) => invested[n]);
  const monthsOut = tested.filter((n) => !invested[n]);
  const extremesWhileOut = (order) => [...tested].sort(order).slice(0, 20).filter((n) => !invested[n]).length;

  // A second look on true month-end closes: FRED's daily S&P 500 level, which
  // covers the last ten years, without dividends.
  const closes = monthly(SP500).slice(0, -1); // drop the unfinished current month
  let hold = 1;
  let rule = 1;
  const holdPath = [1];
  const rulePath = [1];
  let first = null;
  for (let n = 10; n < closes.length; n++) {
    const r = closes[n].last / closes[n - 1].last - 1;
    const average = mean(closes.slice(n - 10, n).map((m) => m.last));
    const inMarket = closes[n - 1].last > average;
    hold *= 1 + r;
    rule *= 1 + (inMarket ? r : (bill.get(closes[n - 1].ym) ?? 0) / 1200);
    holdPath.push(hold);
    rulePath.push(rule);
    first ??= closes[n].ym;
  }
  if (first === null) throw new Error("FRED's SP500 series is too short for the month-end check.");
  const years = (holdPath.length - 1) / 12;
  const sameWindowAt = at(first);

  return {
    rule: "Hold stocks when the monthly price is above its 10-month average, else 3-month T-bills. Signal applied with a one-month delay.",
    full: both(startAt, endAt),
    beforePublication: both(startAt, splitAt - 1),
    afterPublication: both(splitAt, endAt),
    monthEndCheck: {
      from: first,
      to: last(closes).ym,
      holdCagrPct: pct(cagr(hold, years), 2),
      ruleCagrPct: pct(cagr(rule, years), 2),
      holdWorstDrawdownPct: pct(drawdown(holdPath).depth),
      ruleWorstDrawdownPct: pct(drawdown(rulePath).depth),
    },
    sameYearsOnAveragedData: sameWindowAt < 0 ? null : both(sameWindowAt, endAt),
    whileInAndOut: {
      from: rows[startAt].ym,
      to: rows[endAt].ym,
      monthsIn: monthsIn.length,
      monthsOut: monthsOut.length,
      stocksWhileInPct: pct(annualised(monthsIn.map((n) => ret[n]))),
      stocksWhileOutPct: pct(annualised(monthsOut.map((n) => ret[n]))),
      billsWhileOutPct: pct(annualised(monthsOut.map((n) => cashReturn[n]))),
      worst20MonthsWhileOut: extremesWhileOut((a, b) => ret[a] - ret[b]),
      best20MonthsWhileOut: extremesWhileOut((a, b) => ret[b] - ret[a]),
    },
  };
};
