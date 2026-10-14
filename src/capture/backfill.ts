/**
 * Reconstruct past days from the record. The live job witnesses a day hour by
 * hour; this reads the sources' own timestamps instead — a market was "asked"
 * when it was created (Polymarket `createdAt`, Kalshi `open_time`) and
 * "answered" when it closed with a result — and writes sealed day files flagged
 * `backfilled: true`. Days already witnessed live are left alone. Answered
 * markets also land in the resolved shards, so the folded timeline gains a past.
 *
 * The range is walked in windows of scheduled close date (`--window-days`,
 * default 7), each written to disk before the next is fetched, so a long
 * backfill holds one window in memory and an interrupted one keeps its
 * progress. The last window has no upper bound, which picks up markets that
 * resolved early and still carry a far-future close date.
 *
 *   npm run backfill -- --since 2026-01-01            # every source in SOURCES
 *   npm run backfill -- --since 2026-01-01 --window-days 1
 *   SOURCES=kalshi npm run backfill -- --since 2026-06-01
 */
import { join } from "node:path";
import * as polymarket from "../sources/polymarket.js";
import * as kalshi from "../sources/kalshi.js";
import { loadOverrides } from "../text/overrides.js";
import { collectDays, dayOf, emptyDay, mergeById, mergeResolved, readIndex, readJSON, writeIndex, writeJSON } from "./store.js";
import { excluded, phrase, toOpen, toResolved, type Style } from "./run.js";
import { willify, isFallback } from "../text/rewrite.js";
import type { Day, Fetched, Index, Market, Source } from "../types.js";

/** A source's history: everything scheduled to close in [fromMs, toMs) — no
 *  upper bound when toMs is omitted — with `created` and `closedAt` filled in. */
export type HistoryList = (fromMs: number, toMs?: number) => Promise<Fetched[]>;

export const HISTORY: Record<Source, HistoryList> = {
  polymarket: polymarket.fetchClosedBetween,
  kalshi: kalshi.fetchClosedBetween,
};

export interface BackfillOptions {
  dataDir: string;
  since: Date;
  tz?: string;
  style?: Omit<Style, "overrides">;
  /** which sources to read; defaults to both */
  sources?: Partial<Record<Source, HistoryList>>;
  strict?: boolean;
  /** days per listing window (default 7) */
  windowDays?: number;
  /** same filters as the live run, so the backfilled past matches what it would have printed */
  minVolume?: number;
  exclude?: RegExp | null;
  now?: Date;
  log?: (msg: string) => void;
}

export interface BackfillReport {
  days: number;
  asked: number;
  answered: number;
  skippedWitnessed: string[];
  failed: Source[];
  index: Index;
}

export async function backfill(opts: BackfillOptions): Promise<BackfillReport> {
  const {
    dataDir,
    since,
    tz = "America/New_York",
    style = { form: "declarative", answer: "yesno" },
    sources = HISTORY,
    strict = true,
    windowDays = 7,
    minVolume = 0,
    exclude = null,
    now = new Date(),
    log = console.log,
  } = opts;
  const st: Style = { ...style, overrides: await loadOverrides() };
  let index = await readIndex(dataDir);
  // Days the live job captured are left alone; days backfill wrote itself are
  // merged into, so a re-run can complete a day it only partly covered.
  const witnessed = new Set<string>();
  for (const ref of index?.days ?? []) {
    const d = await readJSON<Day>(join(dataDir, ref.file));
    if (d && !d.backfilled) witnessed.add(ref.day);
  }
  const stamp = now.toISOString();
  const sinceMs = since.getTime();
  const today = dayOf(now, tz);
  // Only days that fall wholly after `since` can be complete: a day before it
  // would hold just the markets asked then that happened to settle later. So
  // the first day written is since's own day if since is its midnight, else
  // the next one.
  const sinceDay = dayOf(since, tz);
  const firstDay = dayOf(new Date(sinceMs - 1), tz) === sinceDay ? dayOf(new Date(sinceMs + 864e5), tz) : sinceDay;
  const step = windowDays * 864e5;

  const failed = new Set<Source>();
  const report: BackfillReport = { days: 0, asked: 0, answered: 0, skippedWitnessed: [], failed: [], index: index! };
  const skipped = new Set<string>();
  const written = new Set<string>();
  let fallbacks = 0;

  for (let from = sinceMs; ; from += step) {
    const last = from + step >= now.getTime();
    const to = last ? undefined : from + step;
    const label = `${new Date(from).toISOString().slice(0, 10)} → ${to ? new Date(to).toISOString().slice(0, 10) : "∞"}`;

    // Every source in parallel; one failing doesn't lose the others.
    const rows: Fetched[] = [];
    await Promise.all(
      (Object.entries(sources) as Array<[Source, HistoryList]>).map(async ([src, list]) => {
        try {
          const r = await list(from, to);
          for (const f of r) rows.push(f); // not push(...r): spreading 100k+ rows overflows the stack
          log(`${src}: ${label}: ${r.length} closed markets`);
        } catch (err) {
          failed.add(src);
          console.error(`${src}: ${label}: backfill FAILED`, err);
        }
      }),
    );

    const days = new Map<string, Day>();
    const dayFor = (iso: string) => {
      const k = dayOf(new Date(iso), tz);
      return days.get(k) ?? days.set(k, { ...emptyDay(k, tz), sealed: k < today, backfilled: true }).get(k)!;
    };
    const answered: Market[] = [];
    for (const f of rows) {
      if (!f.result) continue; // voided or unresolved: not part of the record we reconstruct
      if (f.closedAt && Date.parse(f.closedAt) < sinceMs) continue; // early resolution from before the range
      if (excluded(f, minVolume, exclude)) continue;
      if (strict && willify(phrase(f.question, st)) === null) continue;
      const seen = f.created ?? f.closedAt ?? stamp;
      const m = toResolved(f, f.result, seen, new Date(f.closedAt ?? stamp), st);
      if (f.created && dayOf(new Date(f.created), tz) >= firstDay) dayFor(f.created).asked.push(toOpen(f, seen, st));
      if (f.closedAt && dayOf(new Date(f.closedAt), tz) >= firstDay) dayFor(f.closedAt).answered.push(m);
      answered.push(m);
    }

    for (const [k, d] of days) {
      if (witnessed.has(k)) {
        skipped.add(k);
        continue;
      }
      const path = join(dataDir, `days/${k}.json`);
      const existing = await readJSON<Day>(path);
      const out = existing?.backfilled ? existing : { ...emptyDay(k, tz), sealed: k < today, backfilled: true };
      out.sealed = k < today; // today is still being written; the live job seals it after midnight
      mergeById(out.asked, d.asked);
      mergeById(out.answered, d.answered);
      out.asked.sort((a, b) => (b.closes ?? "").localeCompare(a.closes ?? ""));
      out.answered.sort((a, b) => (b.resolvedAt ?? "").localeCompare(a.resolvedAt ?? ""));
      await writeJSON(path, out);
      written.add(k);
      report.asked += d.asked.length;
      report.answered += d.answered.length;
    }

    // Write the index after every window so an interrupted backfill is still consistent.
    const resolved = await mergeResolved(dataDir, index, answered);
    const dayRefs = await collectDays(dataDir, index);
    index = {
      generatedAt: index?.generatedAt ?? stamp,
      open: index?.open ?? [],
      resolved,
      days: dayRefs,
      counts: { open: index?.counts.open ?? 0, resolved: resolved.reduce((n, s) => n + s.count, 0) },
    };
    await writeIndex(dataDir, index);
    fallbacks += answered.filter((m) => isFallback(m.line)).length;
    log(`${label}: ${answered.length} answered · ${days.size} days touched`);
    if (last) break;
  }

  report.days = written.size;
  report.skippedWitnessed = [...skipped].sort();
  report.failed = [...failed];
  report.index = index!;
  log(`${report.days} days written · ${report.asked} asked · ${report.answered} answered · ${fallbacks} grammar fallbacks · ${report.skippedWitnessed.length} witnessed days left alone`);
  return report;
}

const isMain = process.argv[1]?.endsWith("backfill.js");
if (isMain) {
  const i = process.argv.indexOf("--since");
  const since = i !== -1 ? new Date(process.argv[i + 1]) : new Date(Date.now() - 30 * 864e5);
  const w = process.argv.indexOf("--window-days");
  const windowDays = w !== -1 ? Number(process.argv[w + 1]) : 7;
  if (Number.isNaN(since.getTime()) || !(windowDays > 0)) {
    console.error("usage: npm run backfill -- --since YYYY-MM-DD [--window-days N]");
    process.exit(2);
  }
  const wanted = (process.env.SOURCES ?? "polymarket").split(",").map((x) => x.trim()) as Source[];
  const sources = Object.fromEntries(wanted.filter((x) => x in HISTORY).map((x) => [x, HISTORY[x]])) as Partial<
    Record<Source, HistoryList>
  >;
  backfill({
    dataDir: process.env.DATA_DIR ?? "data",
    since,
    sources,
    tz: process.env.DAY_TZ ?? "America/New_York",
    style: {
      form: (process.env.FORM as Style["form"] | undefined) ?? "declarative",
      answer: (process.env.ANSWER as Style["answer"] | undefined) ?? "yesno",
    },
    strict: process.env.STRICT !== "0",
    windowDays,
    minVolume: Number(process.env.MIN_VOLUME ?? 0),
    exclude: process.env.EXCLUDE ? new RegExp(process.env.EXCLUDE, "i") : null,
  }).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
