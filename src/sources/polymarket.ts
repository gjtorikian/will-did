import { getJSON, throttle, toISO, HttpError } from "./http.js";
import type { Fetched, Result } from "../types.js";

const BASE = "https://gamma-api.polymarket.com";
const PAGE = 100; // Gamma's maximum; larger limits are silently clamped to 100
// A safety stop, not a filter: ~250,000 markets are open at once, so the default
// allows 500,000. Hitting it throws rather than truncating — a short open listing
// would read as thousands of markets vanishing.
const MAX_PAGES = Number(process.env.PM_MAX_PAGES ?? 5000);
// Gamma's "Sports" tag; league markets (MLB, EPL…) carry it alongside their
// own. Gamma silently ignores exclude_tag_id, so listings ask for tags inline
// (include_tag=true) and sports markets are filtered here.
const SPORTS_TAG = "1";
// Gamma rate-limits hard from shared IPs like GitHub's runners. One gate for
// every request this process makes, so the open and closed listings (and
// rechecks) can't burst past it together.
const gate = throttle(Number(process.env.PM_GAP_MS ?? 1000));
const get = async <T>(url: string) => {
  await gate();
  return getJSON<T>(url);
};

/** Only the Gamma fields we touch. Everything else is ignored. */
interface GammaMarket {
  id: string;
  question: string;
  slug: string;
  endDate?: string;
  createdAt?: string;
  closedTime?: string;
  closed?: boolean;
  active?: boolean;
  outcomes?: string; // JSON-encoded array, e.g. "[\"Yes\",\"No\"]"
  outcomePrices?: string; // JSON-encoded array, e.g. "[\"1\",\"0\"]"
  volumeNum?: number;
  volume?: string | number;
  tags?: Array<{ id: string }> | null; // only with include_tag=true
}

function parseArr(s: string | undefined): string[] {
  if (!s) return [];
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}

/** Resolved outcome. "Yes" wins if its price settled at 1; for Up/Down-style
 *  markets the first outcome is treated as the affirmative. */
function resultOf(m: GammaMarket): Result | null {
  const outcomes = parseArr(m.outcomes);
  const prices = parseArr(m.outcomePrices).map(Number);
  if (prices.length < 2) return null;
  let yes = outcomes.findIndex((o) => o.toLowerCase() === "yes");
  if (yes === -1) yes = 0;
  const no = yes === 0 ? 1 : 0;
  if (prices[yes] === 1) return "yes";
  if (prices[no] === 1) return "no";
  return null;
}

function toFetched(m: GammaMarket): Fetched {
  const closed = Boolean(m.closed);
  return {
    id: `pm:${m.id}`,
    source: "polymarket",
    question: (m.question ?? "").trim(),
    closes: toISO(m.endDate),
    url: `https://polymarket.com/market/${m.slug}`,
    volume: Number(m.volumeNum ?? m.volume ?? 0) || 0,
    sports: m.tags?.some((t) => String(t.id) === SPORTS_TAG) ?? false,
    created: toISO(m.createdAt),
    closed,
    result: closed ? resultOf(m) : null,
    closedAt: toISO(m.closedTime),
  };
}

interface KeysetPage {
  markets?: GammaMarket[];
  next_cursor?: string | null;
}

/** Walk a listing with Gamma's keyset cursor. The plain /markets endpoint
 *  rejects offsets past ~2,000 with a 422; the keyset endpoint has no ceiling.
 *  Cursors are sequential, so there is no parallel paging. */
async function fetchKeyset(params: string): Promise<GammaMarket[]> {
  const out: GammaMarket[] = [];
  let cursor = "";
  for (let i = 0; i < MAX_PAGES; i++) {
    const after = cursor ? `&after_cursor=${encodeURIComponent(cursor)}` : "";
    const res = await get<KeysetPage>(`${BASE}/markets/keyset?${params}&limit=${PAGE}${after}`);
    out.push(...(res.markets ?? []));
    if (!res.next_cursor || !res.markets?.length) return out;
    cursor = res.next_cursor;
  }
  throw new Error(`polymarket: listing still going after ${MAX_PAGES} pages (${params}); raise PM_MAX_PAGES`);
}

/** A listing as Fetched rows, sports already filtered out. */
async function listing(params: string): Promise<Fetched[]> {
  const out: Fetched[] = [];
  for (const m of await fetchKeyset(`${params}&include_tag=true`)) {
    const f = toFetched(m);
    if (f.question && !f.sports) out.push(f);
  }
  return out;
}

export async function fetchOpen(): Promise<Fetched[]> {
  return listing("active=true&closed=false");
}

/** Closed markets whose scheduled end falls in [from, to). `to` omitted means
 *  no upper bound, which includes markets that resolved early and still carry
 *  a far-future endDate. Gamma has no filter on the actual close time. */
export async function fetchClosedBetween(from: number, to?: number): Promise<Fetched[]> {
  const min = `&end_date_min=${new Date(from).toISOString()}`;
  const max = to === undefined ? "" : `&end_date_max=${new Date(to).toISOString()}`;
  return listing(`closed=true${min}${max}`);
}

/** Markets scheduled to have ended since `since`. Early resolutions of markets
 *  we were tracking aren't here; the run re-checks those one by one. */
export async function fetchClosedSince(since: number): Promise<Fetched[]> {
  return fetchClosedBetween(since, Date.now());
}

/** Re-check one market that vanished from the open listing. */
export async function fetchOne(id: string): Promise<Fetched | null> {
  const gammaId = id.replace(/^pm:/, "");
  try {
    const m = await get<GammaMarket>(`${BASE}/markets/${gammaId}?include_tag=true`);
    return m?.id ? toFetched(m) : null;
  } catch (err) {
    if (err instanceof HttpError && err.status === 404) return null;
    throw err;
  }
}
