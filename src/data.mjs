// Where the data comes from, and a small on-disk cache so repeat runs do not
// download the same files again. Nothing here needs an API key.
//
// Downloads go through curl. FRED serves its CSV files to curl's default user
// agent, and the SEC is sent a plain one that names this tool.

import { execFile } from "node:child_process";
import { mkdir, readFile, rename, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

// A cached file younger than this is used as it is. FRED's daily series change once a day.
const FRESH_FOR_MS = 6 * 60 * 60 * 1000;
const SEC_AGENT = "free-terminal";

export const defaultCacheDir = () =>
  process.env.FREE_TERMINAL_CACHE || path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"), "free-terminal");

const firstLine = (text) => text.split(/\r?\n/, 1)[0];

// A timestamp as a calendar day in the reader's own time zone.
export const localDay = (iso) => {
  const at = new Date(iso);
  return [at.getFullYear(), at.getMonth() + 1, at.getDate()].map((n) => String(n).padStart(2, "0")).join("-");
};

const SOURCES = {
  fred: (id) => ({
    name: `FRED ${id}`,
    file: `fred_${id}.csv`,
    url: `https://fred.stlouisfed.org/graph/fredgraph.csv?id=${id}`,
    looksRight: (text) => firstLine(text).endsWith(`,${id}`),
  }),
  shiller: () => ({
    name: "Shiller S&P composite (github.com/datasets/s-and-p-500)",
    file: "shiller.csv",
    url: "https://raw.githubusercontent.com/datasets/s-and-p-500/main/data/data.csv",
    looksRight: (text) => firstLine(text).startsWith("Date,SP500,Dividend"),
  }),
  sec: (cik) => ({
    name: `SEC EDGAR company facts, CIK ${cik}`,
    file: `sec_CIK${String(cik).padStart(10, "0")}.json`,
    url: `https://data.sec.gov/api/xbrl/companyfacts/CIK${String(cik).padStart(10, "0")}.json`,
    agent: SEC_AGENT,
    notFound: `The SEC has no company facts under CIK ${cik}. Check the number.`,
    looksRight: (text) => text.trimStart().startsWith("{") && text.includes('"facts"'),
  }),
};

const modifiedAt = async (file) => {
  try {
    return (await stat(file)).mtime;
  } catch {
    return null;
  }
};

const download = async (source, file) => {
  const part = `${file}.part`;
  const agent = source.agent ? ["-A", source.agent] : [];
  try {
    await exec("curl", ["-sS", "-L", "--fail", "--retry", "2", "--max-time", "60", ...agent, "-o", part, source.url]);
    if (!source.looksRight(await readFile(part, "utf8"))) throw new Error("the reply was not the expected file");
    await rename(part, file);
  } catch (err) {
    await rm(part, { force: true });
    if (err.code === "ENOENT") throw new Error("curl was not found. Install curl and try again.");
    if (source.notFound && /error: 404/.test(err.stderr ?? "")) throw new Error(source.notFound);
    throw new Error(`${source.name}: ${String(err.stderr || err.message).trim().split("\n").at(-1)}`);
  }
};

// Returns the file's text and when it was downloaded.
const fetchCached = async (source, { cacheDir, refresh, offline }) => {
  const file = path.join(cacheDir, source.file);
  const have = await modifiedAt(file);
  const cached = async () => ({ text: await readFile(file, "utf8"), retrieved: have.toISOString() });
  if (offline) {
    if (!have) throw new Error(`${source.name}: no cached copy in ${cacheDir}. Run once without --offline.`);
    return cached();
  }
  if (have && !refresh && Date.now() - have.getTime() < FRESH_FOR_MS) return cached();
  await mkdir(cacheDir, { recursive: true });
  try {
    await download(source, file);
  } catch (err) {
    if (!have) throw err;
    console.error(`free-terminal: ${err.message}. Using the copy downloaded ${localDay(have)}.`);
    return cached();
  }
  return { text: await readFile(file, "utf8"), retrieved: (await modifiedAt(file)).toISOString() };
};

/* ── Parsers ─────────────────────────────────────────────────── */

// FRED's CSV: a header, then "date,value". Missing readings are empty or ".".
export const parseFred = (text) =>
  text
    .trim()
    .split(/\r?\n/)
    .slice(1)
    .map((row) => row.split(","))
    .filter(([, v]) => v !== undefined && v !== "" && v !== ".")
    .map(([date, v]) => ({ date, ym: date.slice(0, 7), value: Number(v) }));

// Shiller's monthly table: price, annual dividend rate and consumer prices.
export const parseShiller = (text) => {
  const [header, ...lines] = text.trim().split(/\r?\n/);
  const columns = header.split(",");
  const [date, price, dividend, cpi] = ["Date", "SP500", "Dividend", "Consumer Price Index"].map((name) => {
    const n = columns.indexOf(name);
    if (n < 0) throw new Error(`The Shiller file has no "${name}" column.`);
    return n;
  });
  return lines
    .map((row) => row.split(","))
    .map((cells) => ({
      ym: cells[date].slice(0, 7),
      price: Number(cells[price]),
      dividend: Number(cells[dividend]),
      cpi: Number(cells[cpi]),
    }));
};

/* ── Loader ──────────────────────────────────────────────────── */

// Runs at most `limit` jobs at a time and keeps the results in order.
const pool = async (items, limit, job) => {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const n = next++;
      results[n] = await job(items[n]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
};

// One loader per run. `used` lists every file a command read, for its footer.
export const openData = (options) => {
  const used = [];
  const text = async (source) => {
    const got = await fetchCached(source, options);
    return { text: got.text, record: { name: source.name, url: source.url, retrieved: got.retrieved } };
  };
  return {
    used,
    // Several FRED series at once, keyed by id.
    fred: async (ids) => {
      const got = await pool(ids, 3, (id) => text(SOURCES.fred(id)));
      used.push(...got.map((g) => g.record));
      return Object.fromEntries(ids.map((id, n) => [id, parseFred(got[n].text)]));
    },
    shiller: async () => {
      const got = await text(SOURCES.shiller());
      used.push(got.record);
      return parseShiller(got.text);
    },
    companyFacts: async (cik) => {
      const got = await text(SOURCES.sec(cik));
      used.push(got.record);
      return JSON.parse(got.text);
    },
  };
};
