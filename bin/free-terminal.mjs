#!/usr/bin/env node
// free-terminal: five market-terminal functions computed from free public data.

import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import * as calc from "../src/calc.mjs";
import { resolveCompany } from "../src/companies.mjs";
import { defaultCacheDir, localDay, openData } from "../src/data.mjs";
import * as render from "../src/format.mjs";

const NOTE = "Not investment advice.";

const COMMANDS = {
  macro: {
    summary: "Rates, inflation, jobs and the S&P 500 at a glance",
    sources: "Source: FRED, Federal Reserve Bank of St. Louis.",
    run: async (data) => calc.macro(await data.fred(["DGS10", "DGS2", "T10Y2Y", "FEDFUNDS", "UNRATE", "CPIAUCSL", "USREC", "SP500"])),
  },
  curve: {
    summary: "Treasury yields, the 10-year minus 2-year spread and its record before recessions",
    sources: "Source: FRED, Federal Reserve Bank of St. Louis.",
    run: async (data) => calc.curve(await data.fred(["DGS10", "DGS2", "T10Y2Y", "USREC"])),
  },
  company: {
    usage: "company [ticker|CIK]",
    summary: "Revenue, net income and margin by fiscal year, from SEC filings (default AAPL)",
    sources: "Source: SEC EDGAR, XBRL company facts from the company's own 10-K filings.",
    run: async (data, [which = "AAPL"]) => calc.company(await data.companyFacts(resolveCompany(which))),
  },
  history: {
    summary: "The S&P composite since 1871, with and without dividends",
    sources: "Source: Robert Shiller's S&P composite data, as mirrored at github.com/datasets/s-and-p-500.",
    run: async (data) => calc.history(await data.shiller()),
  },
  faber: {
    summary: "Faber's 10-month-average rule against buy and hold since 1934",
    sources: "Sources: Shiller's S&P composite data; FRED TB3MS and SP500. Rule from Faber (2007).",
    run: async (data) => {
      const shiller = await data.shiller();
      return calc.faber({ shiller, ...(await data.fred(["TB3MS", "SP500"])) });
    },
  },
};

const help = () => {
  const width = Math.max(...Object.entries(COMMANDS).map(([name, c]) => (c.usage ?? name).length));
  return `free-terminal: five market-terminal functions on free public data

Usage
  free-terminal <command> [options]

Commands
${Object.entries(COMMANDS)
  .map(([name, c]) => `  ${(c.usage ?? name).padEnd(width)}   ${c.summary}`)
  .join("\n")}

Options
  --json         Print the numbers as JSON
  --refresh      Download fresh data even if the saved copy is recent
  --offline      Use saved data only, download nothing
  --cache <dir>  Where downloads are kept (default ${defaultCacheDir()})
  -h, --help     Show this help
  -v, --version  Show the version

${NOTE}`;
};

const main = async () => {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      json: { type: "boolean" },
      refresh: { type: "boolean" },
      offline: { type: "boolean" },
      cache: { type: "string" },
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
    },
  });
  if (values.version) return console.log(JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version);
  const [name, ...rest] = positionals;
  if (values.help || !name || name === "help") return console.log(help());
  const command = COMMANDS[name];
  if (!command) throw new Error(`Unknown command "${name}". Run free-terminal --help for the list.`);

  const data = openData({ cacheDir: values.cache ?? defaultCacheDir(), refresh: values.refresh, offline: values.offline });
  const result = await command.run(data, rest);
  if (values.json) {
    console.log(JSON.stringify({ command: name, ...result, sources: data.used, note: NOTE }, null, 2));
    return;
  }
  const downloaded = localDay(data.used.map((s) => s.retrieved).sort()[0]);
  console.log(`\n${render[name](result)}\n\n${render.footer(command.sources, downloaded, NOTE)}\n`);
};

main().catch((err) => {
  const message = err.code?.startsWith("ERR_PARSE_ARGS") ? `${err.message.split(". ")[0]}. Run free-terminal --help for the options.` : err.message;
  console.error(`free-terminal: ${message}`);
  process.exitCode = 1;
});
