// Which company a `company` argument means.
//
// The SEC files every company under a number, its CIK. The SEC's own
// ticker-to-CIK list is not served to an undeclared client, so this tool
// carries a short list and takes a CIK for anything else. Each company below
// was checked: the name the SEC returns for the number, and a full table with
// no missing years.

export const TICKERS = {
  AAPL: 320193,
  MSFT: 789019,
  NVDA: 1045810,
  AMZN: 1018724,
  GOOGL: 1652044,
  GOOG: 1652044,
  META: 1326801,
  TSLA: 1318605,
  NFLX: 1065280,
  AMD: 2488,
  INTC: 50863,
};

export const resolveCompany = (which) => {
  const text = String(which).trim();
  const digits = text.match(/^(?:CIK)?(\d{1,10})$/i)?.[1];
  if (digits) return Number(digits);
  const cik = TICKERS[text.toUpperCase()];
  if (cik) return cik;
  throw new Error(
    `"${text}" is not one of the built-in tickers (${Object.keys(TICKERS).join(", ")}). ` +
      "For any other company, pass its CIK number, which is shown on its page in the SEC's EDGAR search.",
  );
};
