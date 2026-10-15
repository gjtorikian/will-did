import { pool } from "../sources/http.js";
import { rewrite, willify } from "../text/rewrite.js";
import { humanize, straightQuotes, stripMarkdown } from "../text/prose.js";
import { applyPatterns, loadOverrides, pinned, type Overrides } from "../text/overrides.js";
import { dayOf, readAllOpen, readIndex, readRecentResolvedIds, write } from "./store.js";
import type { Answer, DayRef, Fetched, Form, Index, Market, Result, Source } from "../types.js";

export interface Adapter {
  fetchOpen(): Promise<Fetched[]>;
  fetchClosedSince(since: number): Promise<Fetched[]>;
  fetchOne(id: string): Promise<Fetched | null>;
}

export interface RunOptions {
  dataDir: string;
  adapters: Partial<Record<Source, Adapter>>;
  now?: Date;
  lookbackHours?: number;
  /** drop markets below this volume; markets nobody traded are always dropped */
  minVolume?: number;
  exclude?: RegExp | null;
  recheckConcurrency?: number;
  /** drop markets that can't be phrased as a "Will…?" sentence (default true) */
  strict?: boolean;
  /** IANA zone the day boundary is drawn in (default America/New_York) */
  tz?: string;
  /** resolved-line shape: "Bitcoin did reach…" (declarative) or "Did Bitcoin reach…? Yes." (question) */
  form?: Form;
  /** for the question form: "Yes."/"No." or "Did."/"Did not." */
  answer?: Answer;
  log?: (msg: string) => void;
}

export interface RunReport {
  index: Index;
  newlyResolved: number;
  voided: number;
  dropped: number; // couldn't be phrased as Will…?
  late: number; // settled on a day already sealed: recorded, on no page
  failed: Source[];
  day: DayRef;
}

export interface Style {
  form: Form;
  answer: Answer;
  overrides: Overrides;
}

/** Markets the piece never prints, whatever their grammar: sports, and markets
 *  nobody traded (a $0 market is a question, not a wager). */
export function excluded(f: Fetched, minVolume = 0, exclude: RegExp | null = null): boolean {
  return Boolean(f.sports) || !(f.volume > 0) || f.volume < minVolume || Boolean(exclude?.test(f.question));
}

/** The text the grammar sees: markdown stripped and quotes straightened (so
 *  override patterns can use plain " and '), pattern overrides, then
 *  spelled-out numerals. */
export const phrase = (q: string, st: Style) => {
  const q2 = applyPatterns(straightQuotes(stripMarkdown(q)), st.overrides);
  return humanize(q2);
};

/** The open line for a market: a Will-sentence (or the question as written). */
export function openLine(id: string, question: string, st: Style): string {
  const text = phrase(question, st);
  return pinned(id, st.overrides) ?? willify(text) ?? text.replace(/\?*$/, "?");
}

/** The resolved line for a market. */
export function resolvedLine(id: string, question: string, result: Result, st: Style): string {
  return pinned(id, st.overrides) ?? rewrite(phrase(question, st), result, st.form, st.answer);
}

export function toOpen(f: Fetched, seen: string, st: Style): Market {
  return {
    id: f.id,
    source: f.source,
    question: f.question,
    line: openLine(f.id, f.question, st),
    closes: f.closes,
    created: f.created ?? undefined,
    status: "open",
    seen,
    url: f.url,
    volume: f.volume,
  };
}

export function toResolved(f: Fetched, result: Result, seen: string, now: Date, st: Style): Market {
  return {
    id: f.id,
    source: f.source,
    question: f.question,
    line: resolvedLine(f.id, f.question, result, st),
    closes: f.closes,
    created: f.created ?? undefined,
    status: result,
    seen,
    resolvedAt: f.closedAt ?? now.toISOString(),
    url: f.url,
    volume: f.volume,
  };
}

function toVoid(f: Fetched | Market, seen: string, now: Date): Market {
  return {
    id: f.id,
    source: f.source,
    question: f.question,
    line: `${stripMarkdown(f.question).replace(/\?*$/, "")}? Void.`,
    closes: f.closes,
    status: "void",
    seen,
    resolvedAt: ("closedAt" in f ? f.closedAt : null) ?? now.toISOString(),
    url: f.url,
    volume: f.volume,
  };
}

/* ---------- one run, step by step ----------
 *
 * run() is a short pipeline. The steps that decide anything are pure (markets
 * in, markets out); only pull() and recheck() touch the network.
 *
 *   pull       fetch every source's open and recently closed markets
 *   vanished   markets open last run and missing now: resolved, voided,
 *              carried forward (their source failed), or to be rechecked
 *   recheck    look those up one by one
 *   checked    what the rechecks revealed
 *   seed       settlements in the closed listing not yet recorded
 *   askedOn    which open markets were newly posed on a day still open
 */

/** What a run decides about markets, before anything is written. */
interface Settled {
  open: Market[]; // still open: fresh, carried forward, or confirmed by a recheck
  resolved: Market[]; // settled Yes or No this run
  voided: Market[]; // closed without a Yes/No, or gone from the source
}
const settled = (s: Partial<Settled> = {}): Settled => ({ open: s.open ?? [], resolved: s.resolved ?? [], voided: s.voided ?? [] });
const combine = (...xs: Settled[]): Settled => ({
  open: xs.flatMap((x) => x.open),
  resolved: xs.flatMap((x) => x.resolved),
  voided: xs.flatMap((x) => x.voided),
});

/** Everything a pure step needs to turn a fetched market into a recorded one. */
interface Ctx {
  now: Date;
  st: Style;
  /** when a market was posed: its earlier `seen`, else its creation time, else now */
  seenOf: (f: Fetched) => string;
}

/** Whether a fetched market belongs in the piece: kept, excluded outright
 *  (sports, untraded, filtered), or dropped because it can't be phrased as
 *  a Will-sentence (counted in the run's heartbeat). */
type Verdict = "keep" | "excluded" | "dropped";
type Judge = (f: Fetched) => Verdict;

function judge(opts: { minVolume: number; exclude: RegExp | null; strict: boolean }, st: Style): Judge {
  return (f) => {
    if (excluded(f, opts.minVolume, opts.exclude)) return "excluded";
    if (opts.strict && willify(phrase(f.question, st)) === null) return "dropped";
    return "keep";
  };
}

interface Pulled {
  open: Fetched[];
  closed: Map<string, Fetched>;
  failed: Set<Source>;
  dropped: Set<string>;
}

/** Every source in parallel. A source that fails is noted, and its markets
 *  are carried forward later: an outage must never read as "everything resolved". */
async function pull(
  adapters: Partial<Record<Source, Adapter>>,
  since: number,
  verdict: Judge,
  log: (msg: string) => void,
  lookbackHours: number,
): Promise<Pulled> {
  const out: Pulled = { open: [], closed: new Map(), failed: new Set(), dropped: new Set() };
  const kept = (f: Fetched) => {
    const v = verdict(f);
    if (v === "dropped") out.dropped.add(f.id);
    return v === "keep";
  };
  await Promise.all(
    (Object.keys(adapters) as Source[]).map(async (src) => {
      try {
        const adapter = adapters[src]!;
        const [o, c] = await Promise.all([adapter.fetchOpen(), adapter.fetchClosedSince(since)]);
        for (const f of o) if (kept(f)) out.open.push(f); // not push(...): 250k rows overflow the stack
        for (const f of c) if (kept(f)) out.closed.set(f.id, f);
        log(`${src}: ${o.length} open, ${c.length} closed in last ${lookbackHours}h`);
      } catch (err) {
        out.failed.add(src);
        console.error(`${src}: FAILED — carrying previous open markets forward`, err);
      }
    }),
  );
  return out;
}

/** Markets open last run and missing from this run's open listing: settled
 *  from the closed listing where possible, carried forward if their source
 *  failed or is switched off, otherwise left to be rechecked one by one. */
function vanished(
  prevOpen: Market[],
  pulled: Pulled,
  adapters: Partial<Record<Source, Adapter>>,
  ctx: Ctx,
): { settled: Settled; recheck: Market[] } {
  const openIds = new Set(pulled.open.map((f) => f.id));
  const out = settled();
  const recheck: Market[] = [];
  for (const m of prevOpen) {
    if (openIds.has(m.id)) continue;
    const c = pulled.closed.get(m.id);
    if (pulled.failed.has(m.source) || !adapters[m.source]) out.open.push(m); // carried forward untouched
    else if (c?.result) out.resolved.push(toResolved(c, c.result, m.seen, ctx.now, ctx.st));
    else if (c?.closed) out.voided.push(toVoid(c, m.seen, ctx.now));
    else recheck.push(m);
  }
  return { settled: out, recheck };
}

/** Look each market up on its own. `undefined` means the lookup failed (try
 *  again next hour); `null` means the source no longer has it. */
function recheck(markets: Market[], adapters: Partial<Record<Source, Adapter>>, concurrency: number): Promise<Array<Fetched | null | undefined>> {
  return pool(markets, concurrency, async (m) => {
    try {
      return await adapters[m.source]!.fetchOne(m.id);
    } catch (err) {
      console.error(`recheck ${m.id} failed`, err);
      return undefined;
    }
  });
}

/** What the rechecks revealed, market by market. */
function checked(markets: Market[], results: Array<Fetched | null | undefined>, verdict: Judge, ctx: Ctx): { settled: Settled; dropped: string[] } {
  const out = settled();
  const dropped: string[] = [];
  markets.forEach((m, i) => {
    const f = results[i];
    if (f === undefined) return void out.open.push(m); // transient: keep it open, try again next hour
    if (f === null) return void out.voided.push(toVoid(m, m.seen, ctx.now)); // gone from the source entirely
    const v = verdict(f);
    if (v !== "keep") return void (v === "dropped" && dropped.push(f.id)); // recorded under looser filters: let it go quietly
    if (f.result) out.resolved.push(toResolved(f, f.result, m.seen, ctx.now, ctx.st));
    else if (f.closed) out.voided.push(toVoid(f, m.seen, ctx.now));
    else out.open.push(toOpen(f, m.seen, ctx.st)); // still open after all (the listing was incomplete)
  });
  return { settled: out, dropped };
}

/** Settlements in the closed listing not yet recorded: anything a missed hour
 *  dropped, and on a first run the recent past. All go in resolved/, so the
 *  next run knows them; the store puts on a page only those that settled on
 *  a day still open. */
function seed(closed: Map<string, Fetched>, recorded: Set<string>, ctx: Ctx): Market[] {
  return [...closed.values()]
    .filter((f) => f.result && !recorded.has(f.id))
    .map((f) => toResolved(f, f.result!, ctx.seenOf(f), ctx.now, ctx.st));
}

/** Asked: new this run and posed on a day that's still open: today, or
 *  yesterday until this run seals it (a market posed at 23:40 and first seen
 *  at 00:17 belongs to yesterday). Older markets seen for the first time (the
 *  first fetch, a source switched on) are tracked but not added to a page;
 *  their days are backfill's to reconstruct. */
function askedOn(open: Market[], known: Map<string, Market>, openDays: Set<string>, tz: string): Market[] {
  return open.filter((m) => !known.has(m.id) && openDays.has(dayOf(new Date(m.seen), tz)));
}

export async function run(opts: RunOptions): Promise<RunReport> {
  const {
    dataDir,
    adapters,
    now = new Date(),
    lookbackHours = 48,
    minVolume = 0,
    exclude = null,
    recheckConcurrency = 8,
    strict = true,
    tz = "America/New_York",
    form = "declarative",
    answer = "yesno",
    log = console.log,
  } = opts;
  const t0 = Date.now();
  const nowISO = now.toISOString();
  const st: Style = { form, answer, overrides: await loadOverrides() };
  const verdict = judge({ minVolume, exclude, strict }, st);

  const index = await readIndex(dataDir);
  const prevOpen = await readAllOpen(dataDir, index);
  const known = new Map(prevOpen.map((m) => [m.id, m]));
  const ctx: Ctx = {
    now,
    st,
    // A market is "asked" when it was posed, not when we first happened to
    // fetch it, as backfill does; now only when the source doesn't say.
    seenOf: (f) => known.get(f.id)?.seen ?? (f.created && f.created < nowISO ? f.created : nowISO),
  };

  const pulled = await pull(adapters, now.getTime() - lookbackHours * 3600_000, verdict, log, lookbackHours);
  const fresh = settled({ open: pulled.open.map((f) => toOpen(f, ctx.seenOf(f), st)) });
  const gone = vanished(prevOpen, pulled, adapters, ctx);
  const found = checked(gone.recheck, await recheck(gone.recheck, adapters, recheckConcurrency), verdict, ctx);
  const recorded = new Set([
    ...(await readRecentResolvedIds(dataDir, index)),
    ...gone.settled.resolved.map((m) => m.id),
    ...found.settled.resolved.map((m) => m.id),
  ]);
  const all = combine(fresh, gone.settled, found.settled, settled({ resolved: seed(pulled.closed, recorded, ctx) }));

  const today = dayOf(now, tz);
  const openDays = new Set([today, ...(index?.days ?? []).filter((d) => !d.sealed).map((d) => d.day)]);
  const asked = askedOn(all.open, known, openDays, tz);
  const dropped = new Set([...pulled.dropped, ...found.dropped]).size;
  const failed = [...pulled.failed];

  const { index: next, day, late } = await write(dataDir, index, all.open, all.resolved, now, {
    asked,
    answered: all.resolved,
    voided: all.voided,
    run: { at: nowISO, open: all.open.length, asked: asked.length, answered: all.resolved.length, voided: all.voided.length, dropped, failed },
    tz,
  });

  log(
    `open ${next.counts.open} · newly resolved ${all.resolved.length} · voided ${all.voided.length} · dropped ${dropped} · ` +
    `late ${late} · resolved total ${next.counts.resolved} · ${day.day}: ${day.asked} asked, ${day.answered} answered · ` +
    `${((Date.now() - t0) / 1000).toFixed(1)}s`,
  );
  return { index: next, newlyResolved: all.resolved.length, voided: all.voided.length, dropped, late, failed, day };
}
