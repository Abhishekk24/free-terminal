// Turns each command's numbers into a table for the terminal. Everything is
// kept inside 80 columns.

// Colour is on in a terminal and off when the output is piped or saved to a
// file. NO_COLOR turns it off everywhere; FORCE_COLOR turns it on everywhere.
const styled = process.env.NO_COLOR ? false : process.env.FORCE_COLOR ? process.env.FORCE_COLOR !== "0" : Boolean(process.stdout.isTTY);
const sgr = (on, off) => (s) => (styled ? `\x1b[${on}m${s}\x1b[${off}m` : s);
const bold = sgr(1, 22);
const dim = sgr(2, 22);
const red = sgr(31, 39);
const green = sgr(32, 39);
const yellow = sgr(33, 39);
// Green for a figure written with a plus sign, red for one with a minus sign.
const tone = (cell) => (cell.trim().startsWith("-") ? red(cell) : cell.trim().startsWith("+") ? green(cell) : cell);
const strong = (cell) => bold(tone(cell));

const fix = (v, places) => v.toFixed(places);
const signed = (v, places) => `${v >= 0 ? "+" : "-"}${fix(Math.abs(v), places)}`;
const percent = (v, places = 1) => `${fix(v, places)}%`;
const count = (v) => v.toLocaleString("en-US");
const dollars = (v) => (v >= 100 ? `$${count(Math.round(v))}` : `$${fix(v, 2)}`);
const yesNo = (v) => (v ? "yes" : "no");
// "2008: -39.2%" as two aligned pieces.
const worstYear = (text) => {
  const [year, change] = text.split(": ");
  return `${year}  ${percent(Number.parseFloat(change)).padStart(6)}`;
};

// A cell with a style of its own, used in place of its column's style.
const paint = (text, style) => ({ text: String(text), style });

// Pads the cells of each column to one width. `right` lists the columns that
// hold numbers; `styles` wraps a whole column after padding; `head` dims the
// first row. A row given as a string is a heading: it is printed as it is and
// does not widen any column.
const table = (rows, { right = [], styles = [], head = false } = {}) => {
  const body = rows.filter(Array.isArray);
  const textOf = (cell) => String(cell?.text ?? cell ?? "");
  const widths = body[0].map((_, c) => Math.max(...body.map((r) => textOf(r[c]).length)));
  return rows
    .map((r) => {
      if (!Array.isArray(r)) return `  ${r}`;
      const cells = r.map((cell, c) => {
        const text = textOf(cell);
        const lastOnLine = c === r.length - 1 && !right.includes(c);
        const padded = right.includes(c) ? text.padStart(widths[c]) : lastOnLine ? text : text.padEnd(widths[c]);
        const style = head && r === body[0] ? dim : (cell?.style ?? styles[c]);
        return style && text ? style(padded) : padded;
      });
      return `  ${cells.join("   ")}`.trimEnd();
    })
    .join("\n");
};

// Breaks a sentence into indented lines of at most `width` characters.
const wrap = (text, width = 76) => {
  const lines = [""];
  for (const word of text.split(" ")) {
    if (lines.at(-1) && lines.at(-1).length + 1 + word.length > width) lines.push(word);
    else lines[lines.length - 1] += lines.at(-1) ? ` ${word}` : word;
  }
  return lines.map((line) => `  ${line}`).join("\n");
};

const title = (text, note) => `${bold(yellow(text))}${note ? `   ${dim(note)}` : ""}`;

// The lines under every table: where the data came from, and the disclaimer.
export const footer = (sources, downloaded, note) => `${dim(wrap(`${sources} Data downloaded ${downloaded}.`))}\n  ${dim(note)}`;

export const macro = (m) =>
  [
    title("MACRO DASHBOARD"),
    "",
    table(
      [
        ["10-year Treasury yield", percent(m.tenYear.value, 2), m.tenYear.date, "FRED DGS10"],
        ["2-year Treasury yield", percent(m.twoYear.value, 2), m.twoYear.date, "FRED DGS2"],
        ["10-year minus 2-year", signed(m.spread.value, 2), m.spread.date, "FRED T10Y2Y, in points"],
        ["Fed funds rate", percent(m.fedFunds.value, 2), m.fedFunds.month, "FRED FEDFUNDS"],
        ["CPI, year on year", percent(m.cpiYoYPct), m.cpiMonth, `FRED CPIAUCSL, vs ${m.cpiComparedWith}`],
        ["Real fed funds rate", percent(m.realFedFundsPct), "", "fed funds after inflation"],
        ["Unemployment rate", percent(m.unemployment.value), m.unemployment.month, "FRED UNRATE"],
        ["S&P 500", m.sp500.value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }), m.sp500.date, "FRED SP500"],
        ["U.S. recession", paint(yesNo(m.inRecessionNow), (cell) => bold((m.inRecessionNow ? red : green)(cell))), m.recessionDataThrough, "FRED USREC"],
      ],
      { right: [1], styles: [null, strong, null, dim] },
    ),
  ].join("\n");

export const curve = (c) =>
  [
    title("RATES AND THE YIELD CURVE"),
    "",
    table(
      [
        ["10-year Treasury yield", percent(c.tenYear.value, 2), c.tenYear.date, ""],
        ["2-year Treasury yield", percent(c.twoYear.value, 2), c.twoYear.date, ""],
        ["10-year minus 2-year", signed(c.spread.value, 2), c.spread.date, paint(c.invertedNow ? "inverted" : "not inverted", c.invertedNow ? red : green)],
      ],
      { right: [1], styles: [null, strong] },
    ),
    "",
    table(
      [
        ["Last inverted month", c.lastInvertedMonth ?? "never", "monthly average below zero"],
        ["Longest inversion", `${c.longestInversion.months} months`, `${c.longestInversion.from} to ${c.longestInversion.to}`],
        ["Recession since it ended", yesNo(c.recessionSinceLongestInversion), `recession data through ${c.recessionDataThrough}`],
      ],
      { styles: [null, bold, dim] },
    ),
    "",
    table(
      [
        bold("Recessions since 1978: was the curve inverted in the two years before?"),
        ["Began", "On monthly averages", "On any day"],
        ...c.recessions.map((r) => [r.began, yesNo(r.invertedInMonthlyAverages), yesNo(r.invertedOnAnyDay)]),
        ["Total", `${c.recessionsPrecededByInversion} of ${c.recessions.length}`, `${c.recessionsPrecededByDailyInversion} of ${c.recessions.length}`].map((cell) => paint(cell, bold)),
      ],
      { head: true },
    ),
  ].join("\n");

export const company = (c) => {
  // In a terminal, each year's revenue is also drawn as a bar.
  const largest = Math.max(...c.rows.map((r) => r.revenueBn));
  const bar = (r) => (styled ? [paint("█".repeat(Math.max(1, Math.round((r.revenueBn / largest) * 14))), yellow)] : []);
  return [
    title(c.company.toUpperCase(), `CIK ${c.cik}, fiscal ${c.from} to ${c.to}, from its 10-K filings`),
    "",
    table(
      [
        ["Year", "Year ended", "Revenue", "Net income", "Margin", "Growth", ...(styled ? [""] : [])],
        ...c.rows.map((r) => [
          r.year,
          r.fiscalYearEnd,
          paint(`$${fix(r.revenueBn, 1)}B`, bold),
          `${r.netIncomeBn < 0 ? "-" : ""}$${fix(Math.abs(r.netIncomeBn), 1)}B`,
          percent(r.marginPct),
          r.revenueGrowthPct === null ? "" : `${signed(r.revenueGrowthPct, 1)}%`,
          ...bar(r),
        ]),
      ],
      { right: [2, 3, 4, 5], styles: [null, dim, null, tone, tone, tone], head: true },
    ),
    ...(c.revenueCagrPct === null ? [] : ["", `  Revenue grew ${bold(percent(c.revenueCagrPct))} a year from ${c.from} to ${c.to}.`]),
  ].join("\n");
};

export const history = (h) =>
  [
    title("S&P COMPOSITE SINCE 1871", `monthly, ${h.from} to ${h.to}, ${count(h.months)} months`),
    "",
    table(
      [
        ["", "$1 became", "A year", ""],
        ["With dividends reinvested", dollars(h.growthOfOneDollar), percent(h.cagrPct, 2), ""],
        ["Price only", dollars(h.priceOnlyGrowthOfOneDollar), percent(h.priceOnlyCagrPct, 2), ""],
        ["With dividends, after inflation", "", percent(h.realCagrPct, 2), `through ${h.realThrough}`],
      ],
      { right: [1, 2], styles: [null, bold, bold, dim], head: true },
    ),
    "",
    `  Worst fall: ${red(`-${percent(h.worstDrawdownPct)}`)}, from ${h.worstDrawdownFrom} to ${h.worstDrawdownTo}, with dividends.`,
    `  Dividends are held at their last reported level after ${h.dividendsHeldFlatAfter}.`,
  ].join("\n");

export const faber = (f) => {
  const span = (s) => `${s.hold.from} to ${s.hold.to}`;
  const line = (label, s) => [label, paint(percent(s.cagrPct, 2), bold), dollars(s.growthOfOneDollar), `-${percent(s.worstDrawdownPct)}`, s.worstDrawdownTrough, worstYear(s.worstCalendarYear)];
  const period = (label, s) => [
    bold(`${label}, ${span(s)}`),
    line("  Buy and hold", s.hold),
    line(paint("  10-month rule", yellow), s.rule),
    dim(`  The rule was in stocks ${percent(s.rule.shareOfMonthsInvestedPct)} of months and switched ${s.rule.switches} times.`),
  ];
  const m = f.monthEndCheck;
  const w = f.whileInAndOut;
  return [
    title("FABER'S 10-MONTH RULE", `S&P composite with dividends, ${span(f.full)}`),
    "",
    "  Hold stocks when the monthly price is above its 10-month average,",
    "  otherwise 3-month Treasury bills. The signal is applied one month late.",
    "",
    table(
      [
        ["", "A year", "$1 became", "Worst fall", "Bottomed", "Worst year"],
        ...period("Whole record", f.full),
        ...period("Before the paper", f.beforePublication),
        ...period("After the paper", f.afterPublication),
        ...(f.sameYearsOnAveragedData ? period("Same years as the check below", f.sameYearsOnAveragedData) : []),
      ],
      { right: [1, 2, 3], styles: [null, null, null, tone], head: true },
    ),
    "",
    table(
      [
        bold(`Checked on month-end closes, no dividends, ${m.from} to ${m.to}`),
        ["", "A year", "Worst fall"],
        ["  Buy and hold", paint(percent(m.holdCagrPct, 2), bold), `-${percent(m.holdWorstDrawdownPct)}`],
        [paint("  10-month rule", yellow), paint(percent(m.ruleCagrPct, 2), bold), `-${percent(m.ruleWorstDrawdownPct)}`],
      ],
      { right: [1, 2], styles: [null, null, tone], head: true },
    ),
    "",
    table(
      [
        bold(`Stocks above and below the average, ${w.from} to ${w.to}`),
        ["", "Months", "Stocks, a year", "T-bills, a year"],
        ["  Above the average", count(w.monthsIn), paint(percent(w.stocksWhileInPct), bold), ""],
        ["  Below the average", count(w.monthsOut), paint(percent(w.stocksWhileOutPct), bold), percent(w.billsWhileOutPct)],
      ],
      { right: [1, 2, 3], head: true },
    ),
    wrap(`Of the 20 worst months, ${w.worst20MonthsWhileOut} came while below the average. Of the 20 best, ${w.best20MonthsWhileOut}.`),
  ].join("\n");
};
