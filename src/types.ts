export type Source = "polymarket" | "kalshi";
export type Result = "yes" | "no";
export type Status = "open" | Result | "void";
export type Form = "declarative" | "question"; // "Bitcoin did reach…" | "Did Bitcoin reach…? Yes."
export type Answer = "yesno" | "did"; // for the question form: "Yes." / "No." | "Did." / "Did not."

/** A market as shipped to the page. Kept small: ~180 bytes each. */
export interface Market {
  id: string; // "pm:<gamma id>" | "ks:<ticker>"
  source: Source;
  question: string; // original wording
  line: string; // what the page prints — question while open, rewritten once resolved
  closes: string | null; // ISO; scheduled close
  created?: string; // ISO; when the market was created at the source (backfill uses this as the asked-day)
  status: Status;
  seen: string; // ISO; when this market was first captured — the day it was "asked"
  resolvedAt?: string; // ISO; set when status !== "open" — the day it was "answered"
  url: string;
  volume?: number; // $ wagered on it (Polymarket) or contracts (Kalshi) when last seen; summed once per day page, never shown per line
}

/** What a source adapter hands back before merge. */
export interface Fetched {
  id: string;
  source: Source;
  question: string;
  closes: string | null;
  url: string;
  volume: number; // $ for Polymarket, contracts for Kalshi — only used for filtering
  sports?: boolean; // set by adapters that can tell; sports markets are never printed
  created: string | null;
  closed: boolean;
  result: Result | null; // null while open, or closed without a usable outcome (voided)
  closedAt: string | null;
}

export interface Shard {
  month: string; // "YYYY-MM" or "undated"
  file: string; // relative to the data dir
  count: number;
}

/** One captured day, in the configured time zone. Sealed once that day has ended:
 *  the file is never touched again, whatever arrives later with an earlier timestamp. */
/** One run's heartbeat. 24 of these per day reconstruct the hour-by-hour state. */
export interface RunStat {
  at: string; // ISO
  open: number;
  asked: number;
  answered: number;
  voided: number;
  dropped: number; // couldn't be phrased as Will…?; counted, not kept
  failed: Source[];
}

export interface Day {
  day: string; // "YYYY-MM-DD" in `tz`
  tz: string; // IANA zone the day boundary is drawn in
  sealed: boolean;
  backfilled?: boolean; // reconstructed from the record rather than witnessed hour by hour
  asked: Market[]; // markets first captured on this day, as Will-lines
  answered: Market[]; // markets that settled on this day, as Did-lines
  voided: Market[]; // closed without a Yes/No, or vanished from the source
  runs: RunStat[];
}

export interface DayRef {
  day: string;
  file: string;
  asked: number;
  answered: number;
  sealed: boolean;
}

export interface Index {
  generatedAt: string;
  open: Shard[]; // sorted by month, descending (far future first); "undated" first
  resolved: Shard[]; // sorted by month, descending (most recent first)
  days: DayRef[]; // most recent first
  counts: { open: number; resolved: number };
}
