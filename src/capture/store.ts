import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Day, DayRef, Index, Market, RunStat, Shard } from "../types.js";

export const UNDATED = "undated";

/** "2026-10-04" for `now` in `tz` (en-CA gives ISO ordering). */
export function dayOf(now: Date, tz: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

/** "2026-10" from an ISO string, or "undated". */
export function monthOf(iso: string | null | undefined): string {
  return iso ? iso.slice(0, 7) : UNDATED;
}

export async function readJSON<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

export async function writeJSON(path: string, value: unknown, pretty = false): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, pretty ? JSON.stringify(value, null, 2) : JSON.stringify(value));
}

export async function readIndex(dir: string): Promise<Index | null> {
  return readJSON<Index>(join(dir, "index.json"));
}

export async function readShard(dir: string, shard: Shard): Promise<Market[]> {
  return (await readJSON<Market[]>(join(dir, shard.file))) ?? [];
}

export async function readAllOpen(dir: string, index: Index | null): Promise<Market[]> {
  if (!index) return [];
  const shards = await Promise.all(index.open.map((s) => readShard(dir, s)));
  return shards.flat();
}

/** Ids from the most recent `months` resolved shards — enough to de-dupe
 *  the lookback-window seed without reading the whole archive. */
export async function readRecentResolvedIds(dir: string, index: Index | null, months = 3): Promise<Set<string>> {
  if (!index) return new Set();
  const shards = await Promise.all(index.resolved.slice(0, months).map((s) => readShard(dir, s)));
  return new Set(shards.flat().map((m) => m.id));
}

function byMonthDesc(a: Shard, b: Shard): number {
  if (a.month === UNDATED) return -1;
  if (b.month === UNDATED) return 1;
  return b.month.localeCompare(a.month);
}

export interface WriteResult {
  index: Index;
  day: DayRef;
  /** settlements on no page this run: they fell on a day already sealed (see
   *  write). They're in resolved/ all the same. */
  late: number;
}

export interface Captured {
  asked: Market[]; // first seen this run
  answered: Market[]; // resolved this run
  voided: Market[];
  run: RunStat;
  tz: string;
}

export const emptyDay = (day: string, tz: string): Day => ({
  day, tz, sealed: false, asked: [], answered: [], voided: [], runs: [],
});

export function mergeById<T extends { id: string }>(into: T[], add: T[]): void {
  const seen = new Set(into.map((m) => m.id));
  for (const m of add) if (!seen.has(m.id)) into.push(m), seen.add(m.id);
}

/** Append newly-resolved markets into their month shards, de-duping by id.
 *  Returns the full resolved shard list (including shards untouched this run). */
export async function mergeResolved(dir: string, prev: Index | null, newlyResolved: Market[]): Promise<Shard[]> {
  const touched = new Map<string, Market[]>();
  for (const m of newlyResolved) {
    const k = monthOf(m.resolvedAt);
    (touched.get(k) ?? touched.set(k, []).get(k)!).push(m);
  }
  const shards = new Map<string, Shard>((prev?.resolved ?? []).map((s) => [s.month, s]));
  for (const [month, additions] of touched) {
    const file = `resolved/${month}.json`;
    const existing = (await readJSON<Market[]>(join(dir, file))) ?? [];
    mergeById(existing, additions);
    existing.sort((a, b) => (b.resolvedAt ?? "").localeCompare(a.resolvedAt ?? "")); // newest first
    await writeJSON(join(dir, file), existing);
    shards.set(month, { month, file, count: existing.length });
  }
  // pick up shard files on disk that the previous index didn't know about
  try {
    for (const f of await readdir(join(dir, "resolved"))) {
      const month = f.replace(/\.json$/, "");
      if (!shards.has(month)) {
        const list = (await readJSON<Market[]>(join(dir, "resolved", f))) ?? [];
        shards.set(month, { month, file: `resolved/${f}`, count: list.length });
      }
    }
  } catch {
    /* no resolved dir yet */
  }
  return [...shards.values()].sort(byMonthDesc);
}

/** The day list for the index: every file in days/, most recent first. Sealed
 *  days already in the previous index are trusted without re-reading. */
export async function collectDays(dir: string, prev: Index | null): Promise<DayRef[]> {
  const known = new Map<string, DayRef>((prev?.days ?? []).map((d) => [d.day, d]));
  const refs: DayRef[] = [];
  let files: string[] = [];
  try {
    files = (await readdir(join(dir, "days"))).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  for (const f of files) {
    const day = f.replace(/\.json$/, "");
    const k = known.get(day);
    if (k?.sealed) {
      refs.push(k);
      continue;
    }
    const d = await readJSON<Day>(join(dir, "days", f));
    if (d) refs.push({ day, file: `days/${f}`, asked: d.asked.length, answered: d.answered.length, sealed: d.sealed });
  }
  return refs.sort((a, b) => b.day.localeCompare(a.day));
}

/** Mark every day before `today` sealed, in its file and in the list. */
export async function sealBefore(dir: string, refs: DayRef[], today: string): Promise<void> {
  for (const ref of refs) {
    if (ref.day >= today || ref.sealed) continue;
    const d = await readJSON<Day>(join(dir, ref.file));
    if (d) {
      d.sealed = true;
      await writeJSON(join(dir, ref.file), d);
    }
    ref.sealed = true;
  }
}

export async function writeIndex(dir: string, index: Index): Promise<void> {
  await writeJSON(join(dir, "index.json"), index, true);
}

/** Replace the open shards wholesale; merge newly-resolved markets into their
 *  month shards; append this run's captures to today's day file; rewrite the index. */
export async function write(
  dir: string,
  prev: Index | null,
  open: Market[],
  newlyResolved: Market[],
  now: Date,
  captured: Captured,
): Promise<WriteResult> {
  // --- open: wipe and rewrite (it's a snapshot, not an archive) ---
  const openDir = join(dir, "open");
  await rm(openDir, { recursive: true, force: true });
  const openGroups = new Map<string, Market[]>();
  for (const m of open) {
    const k = monthOf(m.closes);
    (openGroups.get(k) ?? openGroups.set(k, []).get(k)!).push(m);
  }
  const openShards: Shard[] = [];
  for (const [month, list] of openGroups) {
    list.sort((a, b) => (b.closes ?? "").localeCompare(a.closes ?? "")); // far future first
    const file = `open/${month}.json`;
    await writeJSON(join(dir, file), list);
    openShards.push({ month, file, count: list.length });
  }
  openShards.sort(byMonthDesc);

  const resolved = await mergeResolved(dir, prev, newlyResolved);

  // --- days: each capture goes to the day of its own timestamp (asked when
  // the market was created, answered or voided when it settled) if that day is
  // still open: today, or yesterday before this run seals it. So the first run
  // after midnight finishes yesterday at midnight exactly, then seals it.
  // A settlement from a day already sealed, or from before the record began,
  // goes on no page: its day's poem is final, and it didn't happen today. It
  // stays in resolved/, so the next run knows it. (Polymarket closes a whole
  // ladder the day its event happens, weeks before the rungs' scheduled ends;
  // a rung never tracked as open turns up in the closed listing only once its
  // end date passes.) ---
  const today = dayOf(now, captured.tz);
  const files = new Map<string, Day>();
  const load = async (day: string): Promise<Day | null> => {
    if (files.has(day)) return files.get(day)!;
    const d = (await readJSON<Day>(join(dir, `days/${day}.json`))) ?? (day === today ? emptyDay(today, captured.tz) : null);
    if (d) files.set(day, d);
    return d;
  };
  const dayFor = (iso: string | null | undefined): string => {
    const t = iso ? new Date(iso) : null;
    return t && !Number.isNaN(t.getTime()) ? dayOf(t, captured.tz) : today;
  };
  /** The still-open day a capture belongs to; null once that day is sealed. */
  const target = async (iso: string | null | undefined): Promise<Day | null> => {
    const day = dayFor(iso);
    if (day >= today) return load(today); // today, or a source clock ahead of ours
    const d = await load(day);
    return d && !d.sealed ? d : null;
  };
  let late = 0;
  // askedOn() keeps asked markets to open days already; the fallback is only for form.
  for (const m of captured.asked) mergeById(((await target(m.seen)) ?? (await load(today)))!.asked, [m]);
  for (const m of captured.answered) {
    const d = await target(m.resolvedAt);
    if (d) mergeById(d.answered, [m]);
    else late++;
  }
  for (const m of captured.voided) {
    const d = await target(m.resolvedAt);
    if (d) mergeById(d.voided, [m]);
    else late++;
  }
  (await load(today))!.runs.push(captured.run);
  // Nothing settled before a day stays in its file: today's may still hold
  // settlements from sealed days, filed before the rule above.
  const settledOn = (day: string, list: Market[]): Market[] => {
    const kept = list.filter((m) => dayFor(m.resolvedAt) >= day);
    late += list.length - kept.length;
    return kept;
  };
  for (const [day, d] of files) {
    if (d.sealed) continue; // only probed; never touched again
    d.answered = settledOn(day, d.answered);
    d.voided = settledOn(day, d.voided);
    d.asked.sort((a, b) => (b.closes ?? "").localeCompare(a.closes ?? ""));
    d.answered.sort((a, b) => (b.resolvedAt ?? "").localeCompare(a.resolvedAt ?? ""));
    await writeJSON(join(dir, `days/${day}.json`), d);
  }

  const days = await collectDays(dir, prev);
  await sealBefore(dir, days, today);

  const index: Index = {
    generatedAt: now.toISOString(),
    open: openShards,
    resolved,
    days,
    counts: {
      open: open.length,
      resolved: resolved.reduce((n, s) => n + s.count, 0),
    },
  };
  await writeIndex(dir, index);
  return { index, day: days.find((x) => x.day === today)!, late };
}
