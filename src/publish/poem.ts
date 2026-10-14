/**
 * The poem: a day's chosen lines, as archive/YYYY-MM-DD.json stores them once
 * the day is sealed, and how they're chosen from the day's record.
 */
import { families } from "../text/similar.js";
import type { Day, Market, Status } from "../types.js";

/** One line of a day's poem, as printed. */
export interface PoemLine {
  id: string;
  status: Status;
  line: string;
  question: string; // the market's own wording, kept beside the line
  url: string;
  at: string; // ISO: when it was asked (a Will line) or answered (a Did line)
  asked: boolean;
  /** the family this line stands for: how many markets (itself included), and
   *  their volume together. */
  family: Family;
}

export interface Family {
  size: number;
  volume: number; // dollars, each member once at its latest volume (Polymarket only)
}

/** A day's poem: what archive/YYYY-MM-DD.json holds once the day is sealed. */
export interface Poem {
  day: string;
  tz: string;
  asked: { shown: number; total: number };
  answered: { shown: number; total: number };
  wagered: number; // dollars, every market behind the page once
  lines: PoemLine[];
}

/** Choose a day's lines: one per family, in the order things happened. */
export function compose(d: Day): Poem {
  // One pass over the whole day, so a family shows once whether its line is a
  // Will or a Did.
  // A market's answer supersedes its question before family selection.
  // Hashes are based on ID, so passing both versions would tie and keep
  // whichever came first, permanently hiding same-day settlements.
  const { kept, stats } = familiesOf(d);
  const pick = (m: Market, asked: boolean): PoemLine => ({
    id: m.id,
    status: m.status,
    line: m.line,
    question: m.question,
    url: m.url,
    at: (asked ? (m.seen ?? m.closes) : (m.resolvedAt ?? m.seen)) ?? "",
    asked,
    family: stats.get(m.id)!,
  });
  const lines = [
    ...d.asked.filter((m) => kept.has(m)).map((m) => pick(m, true)),
    ...d.answered.filter((m) => kept.has(m)).map((m) => pick(m, false)),
  ].sort((a, b) => a.at.localeCompare(b.at));
  const shown = lines.filter((l) => l.asked).length;
  return {
    day: d.day,
    tz: d.tz,
    asked: { shown, total: d.asked.length },
    answered: { shown: lines.length - shown, total: d.answered.length },
    wagered: wagered(d),
    lines,
  };
}

/** A day's families: which markets stand for one, and each member's family
 *  size and volume. A market's answer supersedes its question first: hashes
 *  are based on ID, so passing both versions would tie and keep whichever came
 *  first, permanently hiding same-day settlements. */
export function familiesOf(d: Day): { kept: Set<Market>; stats: Map<string, Family> } {
  const answeredIds = new Set(d.answered.map((m) => m.id));
  const questions = d.asked.filter((m) => !answeredIds.has(m.id));
  const kept = new Set<Market>();
  const stats = new Map<string, Family>();
  for (const f of families([...questions, ...d.answered])) {
    kept.add(f.rep);
    const fam = { size: f.members.length, volume: volumeOf(f.members) };
    for (const m of f.members) stats.set(m.id, fam);
  }
  return { kept, stats };
}

/** Each market once, at its latest volume. Polymarket only, since Kalshi
 *  counts contracts, not dollars. */
function volumeOf(markets: Market[]): number {
  const best = new Map<string, number>();
  for (const m of markets) {
    if (m.source !== "polymarket" || !m.volume) continue;
    best.set(m.id, Math.max(best.get(m.id) ?? 0, m.volume));
  }
  let total = 0;
  for (const v of best.values()) total += v;
  return total;
}

/** Everything wagered on a day's markets: each market once, at its latest
 *  volume. Polymarket only, since Kalshi counts contracts, not dollars. */
function wagered(d: Day): number {
  return volumeOf([...d.asked, ...d.answered]);
}
