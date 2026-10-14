import { getJSON, throttle, toISO, HttpError } from "./http.js";
import type { Fetched, Result } from "../types.js";

const BASE = "https://api.elections.kalshi.com/trade-api/v2";
const PAGE = 1000; // Kalshi's maximum
// A safety stop that throws rather than truncating. Kalshi settles ~90,000
// non-parlay markets a day, so a week-long backfill window needs ~600 pages.
const MAX_PAGES = Number(process.env.KS_MAX_PAGES ?? 2000);
// Kalshi rate-limits reads; one gate for every request this process makes, so
// the open and closed listings (and rechecks) can't burst past it together.
const gate = throttle(Number(process.env.KS_GAP_MS ?? 200));
const get = async <T>(url: string) => {
  await gate();
  return getJSON<T>(url);
};

interface KalshiMarket {
  ticker: string;
  event_ticker: string;
  title: string;
  yes_sub_title?: string;
  subtitle?: string;
  close_time?: string;
  open_time?: string;
  status?: string;
  result?: string; // "yes" | "no" | "" | others for voided/scalar
  volume?: number;
  volume_fp?: string;
}

/** Tickers of every series Kalshi files under Sports, fetched once per process. */
let sportsSeries: Promise<Set<string>> | null = null;
function loadSports(): Promise<Set<string>> {
  sportsSeries ??= get<{ series?: Array<{ ticker: string }> }>(`${BASE}/series?category=Sports`).then(
    (r) => new Set((r.series ?? []).map((s) => s.ticker)),
  );
  sportsSeries.catch(() => (sportsSeries = null)); // a failed load is retried next call, not cached
  return sportsSeries;
}

/** An event ticker begins with its series ticker, but series tickers can
 *  themselves contain hyphens (KXNFLWINS-DEN), so try every hyphen prefix. */
function inSeries(eventTicker: string, series: Set<string>): boolean {
  const parts = eventTicker.split("-");
  for (let i = 1; i <= parts.length; i++) if (series.has(parts.slice(0, i).join("-"))) return true;
  return false;
}

interface Listing {
  markets: KalshiMarket[];
  cursor?: string;
}

/** Kalshi titles are often fragments ("Fed decision in December?") with the
 *  actual proposition in yes_sub_title. Build one sentence out of them. */
function questionOf(m: KalshiMarket): string {
  const title = (m.title ?? "").trim();
  if (/^will\b/i.test(title)) return title;
  const sub = (m.yes_sub_title ?? m.subtitle ?? "").trim();
  if (sub && sub.toLowerCase() !== title.toLowerCase()) {
    return `${title.replace(/\?$/, "")}: ${sub}`;
  }
  return title;
}

function resultOf(m: KalshiMarket): Result | null {
  const r = (m.result ?? "").toLowerCase();
  return r === "yes" || r === "no" ? r : null;
}

function toFetched(m: KalshiMarket, sports: Set<string>): Fetched {
  const closed = m.status === "settled" || m.status === "closed" || m.status === "finalized";
  return {
    id: `ks:${m.ticker}`,
    source: "kalshi",
    question: questionOf(m),
    closes: toISO(m.close_time),
    // Kalshi's public URLs are series/event based; this lands on the event page.
    url: `https://kalshi.com/markets/${m.event_ticker?.toLowerCase() ?? m.ticker.toLowerCase()}`,
    volume: Number(m.volume ?? m.volume_fp ?? 0) || 0,
    sports: inSeries(m.event_ticker ?? m.ticker, sports),
    created: toISO(m.open_time),
    closed,
    result: closed ? resultOf(m) : null,
    closedAt: closed ? toISO(m.close_time) : null,
  };
}

/** Every listing excludes multivariate (parlay) markets: their titles are
 *  comma-joined lists of legs, not sentences, and they outnumber everything
 *  else on Kalshi many times over. */
async function fetchPaged(params: string): Promise<KalshiMarket[]> {
  const out: KalshiMarket[] = [];
  let cursor = "";
  for (let i = 0; i < MAX_PAGES; i++) {
    const url = `${BASE}/markets?${params}&mve_filter=exclude&limit=${PAGE}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
    const res = await get<Listing>(url);
    out.push(...(res.markets ?? []));
    if (!res.cursor || !res.markets?.length) return out;
    cursor = res.cursor;
  }
  throw new Error(`kalshi: listing still going after ${MAX_PAGES} pages (${params}); raise KS_MAX_PAGES`);
}

/** Sports markets are filtered here rather than handed on */
async function listing(params: string): Promise<Fetched[]> {
  const [sports, rows] = await Promise.all([loadSports(), fetchPaged(params)]);
  const out: Fetched[] = [];
  for (const m of rows) {
    const f = toFetched(m, sports);
    if (f.question && !f.sports) out.push(f);
  }
  return out;
}

export async function fetchOpen(): Promise<Fetched[]> {
  return listing("status=open");
}

/** Settled markets whose close time falls in [from, to); `to` omitted means no upper bound. */
export async function fetchClosedBetween(from: number, to?: number): Promise<Fetched[]> {
  const max = to === undefined ? "" : `&max_close_ts=${Math.floor(to / 1000)}`;
  return listing(`status=settled&min_close_ts=${Math.floor(from / 1000)}${max}`);
}

export async function fetchClosedSince(since: number): Promise<Fetched[]> {
  return fetchClosedBetween(since);
}

export async function fetchOne(id: string): Promise<Fetched | null> {
  const ticker = id.replace(/^ks:/, "");
  try {
    const res = await get<{ market: KalshiMarket }>(`${BASE}/markets/${encodeURIComponent(ticker)}`);
    return res?.market?.ticker ? toFetched(res.market, await loadSports()) : null;
  } catch (err) {
    if (err instanceof HttpError && err.status === 404) return null;
    throw err;
  }
}
