// Small checks on made-up data. The real check is against live data: see
// "How the numbers were checked" in the README.

import assert from "node:assert/strict";
import { test } from "node:test";
import { company, curve, drawdown, history, macro, yearOnYear } from "../src/calc.mjs";
import { resolveCompany } from "../src/companies.mjs";
import { parseFred, parseShiller } from "../src/data.mjs";

const point = (ym, value) => ({ date: `${ym}-01`, ym, value });
// One reading a month from `from` for `count` months.
const months = (from, count, value) =>
  Array.from({ length: count }, (_, n) => {
    const at = new Date(Date.UTC(Number(from.slice(0, 4)), Number(from.slice(5)) - 1 + n, 1));
    const ym = at.toISOString().slice(0, 7);
    return point(ym, typeof value === "function" ? value(ym, n) : value);
  });

test("FRED rows with no reading are dropped", () => {
  const rows = parseFred("observation_date,CPIAUCSL\r\n2025-09-01,324.245\r\n2025-10-01,\r\n2025-11-01,325.063\r\n2025-12-01,.\r\n");
  assert.deepEqual(rows, [point("2025-09", 324.245), point("2025-11", 325.063)]);
});

test("year-on-year inflation matches months by date, not by row", () => {
  // October 2025 is missing, as it is in CPIAUCSL.
  const cpi = months("2025-01", 22, (ym, n) => 100 + n).filter((p) => p.ym !== "2025-10");
  const got = yearOnYear(cpi);
  // October 2026 has nothing a year earlier, so the latest usable month is September.
  assert.equal(got.month, "2026-09");
  assert.equal(got.comparedWith, "2025-09");
  assert.equal(got.change, 120 / 108 - 1);
  // Counting 12 rows back from the last row would have compared October 2026 with September 2025.
  assert.notEqual(got.change, cpi.at(-1).value / cpi.at(-13).value - 1);
});

test("the dashboard deflates the fed funds rate with date-matched inflation", () => {
  const flat = [point("2026-10", 5)];
  const cpi = [point("2025-09", 100), point("2025-11", 150), point("2026-09", 104), point("2026-10", 160)];
  const got = macro({ DGS10: flat, DGS2: flat, T10Y2Y: flat, FEDFUNDS: [point("2026-10", 6.08)], UNRATE: flat, CPIAUCSL: cpi, USREC: [point("2026-10", 0)], SP500: flat });
  assert.equal(got.cpiMonth, "2026-09");
  assert.equal(got.cpiYoYPct, 4);
  assert.equal(got.realFedFundsPct, 2);
  assert.equal(got.inRecessionNow, false);
});

test("drawdown finds the largest fall from an earlier peak", () => {
  assert.deepEqual(drawdown([1, 2, 1.5, 3, 1.2, 4]), { depth: 1 - 1.2 / 3, peakAt: 3, troughAt: 4 });
});

test("the curve's record before a recession", () => {
  const inverted = (ym) => ym >= "1978-09" && ym <= "1980-04";
  const spread = months("1976-06", 120, (ym) => (inverted(ym) ? -0.5 : 1));
  const recession = months("1976-06", 120, (ym) => (ym >= "1980-02" && ym <= "1980-07" ? 1 : 0));
  const got = curve({ DGS10: [point("1986-05", 8)], DGS2: [point("1986-05", 7)], T10Y2Y: spread, USREC: recession });
  assert.deepEqual(got.recessions, [{ began: "1980-02", invertedInMonthlyAverages: true, invertedOnAnyDay: true }]);
  assert.deepEqual(got.longestInversion, { from: "1978-09", to: "1980-04", months: 20 });
  assert.equal(got.lastInvertedMonth, "1980-04");
  assert.equal(got.recessionSinceLongestInversion, true);
  assert.equal(got.invertedNow, false);
});

test("company rows use full-year 10-K figures and the latest filing", () => {
  const row = (start, end, val, filed, form = "10-K") => ({ start, end, val, filed, form });
  const facts = {
    cik: 1,
    entityName: "Example Corp",
    facts: {
      "us-gaap": {
        Revenues: {
          units: {
            USD: [
              row("2023-01-01", "2023-12-31", 80e9, "2024-02-01"),
              row("2024-01-01", "2024-12-31", 99e9, "2025-02-01"),
              row("2024-01-01", "2024-12-31", 100e9, "2026-02-01"), // restated a year later
              row("2024-10-01", "2024-12-31", 30e9, "2025-02-01"), // a quarter
              row("2025-01-01", "2025-12-31", 120e9, "2026-02-01"),
              row("2025-01-01", "2025-12-31", 999e9, "2026-03-01", "10-K/A"),
            ],
          },
        },
        NetIncomeLoss: { units: { USD: [row("2024-01-01", "2024-12-31", 20e9, "2025-02-01"), row("2025-01-01", "2025-12-31", -6e9, "2026-02-01")] } },
      },
    },
  };
  assert.deepEqual(company(facts), {
    company: "Example Corp",
    cik: 1,
    rows: [
      { year: 2024, fiscalYearEnd: "2024-12-31", revenueBn: 100, netIncomeBn: 20, marginPct: 20, revenueGrowthPct: 25 },
      { year: 2025, fiscalYearEnd: "2025-12-31", revenueBn: 120, netIncomeBn: -6, marginPct: -5, revenueGrowthPct: 20 },
    ],
    revenueCagrPct: 20,
    from: 2024,
    to: 2025,
  });
  assert.throws(() => company({ entityName: "Foreign Co", facts: {} }), /no annual revenue/);
});

test("history compounds price and dividends, and holds dividends flat when they stop", () => {
  const csv = ["Date,SP500,Dividend,Earnings,Consumer Price Index", "2000-01-01,100,12,0,50", "2000-02-01,100,12,0,50", "2000-03-01,50,0,0,0", "2001-01-01,200,0,0,0"].join("\n");
  const got = history(parseShiller(csv));
  // Month 2 pays 1 on 100. Month 3 falls to 50 and still pays 1, a 49% fall. Month 4 ends at 200 and pays 1.
  const wealth = 1.01 * (51 / 100) * (201 / 50);
  assert.equal(got.growthOfOneDollar, Math.round(wealth));
  assert.equal(got.priceOnlyGrowthOfOneDollar, 2);
  assert.equal(got.dividendsHeldFlatAfter, "2000-02");
  assert.equal(got.realThrough, "2000-02");
  assert.equal(got.worstDrawdownPct, 49);
  assert.equal(got.worstDrawdownFrom, "2000-02");
  assert.equal(got.worstDrawdownTo, "2000-03");
});

test("a company is a built-in ticker or a CIK number", () => {
  assert.equal(resolveCompany("aapl"), 320193);
  assert.equal(resolveCompany("789019"), 789019);
  assert.equal(resolveCompany("CIK0000789019"), 789019);
  assert.throws(() => resolveCompany("ZZZZ"), /not one of the built-in tickers/);
});
