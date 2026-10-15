/**
 * View models: the plain data each template is filled with. Pure; no I/O.
 */
import type { Index, Day } from "../types.js";
import { LOCALE, dollars, fullDate, longDate, noon, zoneName } from "./format.js";
import type { Family, Poem, PoemLine } from "./poem.js";

export interface Turn {
  now: Date;
  minutes: number;
  was: (l: PoemLine) => string;
}

/** Recent days stay one click away; older months disclose their dates. */
export function archiveNav(days: string[], current: string) {
  const recentMonth = days[0]?.slice(0, 7);
  const months = new Map<string, { month: string; label: string; open: boolean; days: Array<{ day: string; date: string }> }>();
  for (const day of days) {
    const month = day.slice(0, 7);
    if (!months.has(month)) months.set(month, {
      month,
      label: new Intl.DateTimeFormat(LOCALE, { month: "long", year: "numeric", timeZone: "UTC" }).format(noon(day)),
      open: month === recentMonth || month === current.slice(0, 7),
      days: [],
    });
    months.get(month)!.days.push({ day, date: longDate(day) });
  }
  return [...months.values()];
}

/** What day.hbs is filled with. */
export function dayView(p: Poem, live: boolean, turn?: Turn) {
  // 24-hour, so "13:02" fits the same five-character gutter as "Oct 11". A
  // line's moment normally falls on the page's day; one that doesn't (a poem
  // archived before settlements from sealed days were kept off the page, or a
  // source clock ahead of ours) shows its date instead.
  const clock = new Intl.DateTimeFormat(LOCALE, { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: p.tz });
  const dateIn = new Intl.DateTimeFormat("en-CA", { timeZone: p.tz }); // YYYY-MM-DD
  const short = new Intl.DateTimeFormat(LOCALE, { month: "short", day: "numeric", timeZone: p.tz });
  const label = (iso: string) => {
    const t = new Date(iso);
    if (Number.isNaN(t.getTime())) return "";
    return dateIn.format(t) === p.day ? clock.format(t) : short.format(t);
  };
  // The time's hover title: the full moment, and whether it fell before this day.
  const stamp = new Intl.DateTimeFormat(LOCALE, {
    weekday: "long", month: "long", day: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: p.tz,
  });
  const moment = (iso: string) => {
    const t = new Date(iso);
    if (Number.isNaN(t.getTime())) return undefined;
    return { full: stamp.format(t), earlier: dateIn.format(t) < p.day };
  };
  const since = turn ? turn.now.getTime() - turn.minutes * 60_000 : Infinity;
  const turning = (l: PoemLine) => !!turn && !l.asked && Date.parse(l.at) > since && Date.parse(l.at) <= turn.now.getTime();
  const count = new Intl.NumberFormat(LOCALE);
  const tally = (t: { shown: number; total: number }) => ({ shown: count.format(t.shown), total: count.format(t.total), partial: t.shown !== t.total });
  // In the gutter the cost is short ("$4.8M") so it fits under a time; the
  // exact figure goes in the hover text.
  const compact = new Intl.NumberFormat(LOCALE, { style: "currency", currency: "USD", notation: "compact", maximumFractionDigits: 1 });
  const whole = new Intl.NumberFormat(LOCALE, { style: "currency", currency: "USD", maximumFractionDigits: 0 });
  const family = (f?: Family) =>
    f && {
      size: count.format(f.size),
      single: f.size === 1,
      cost: f.volume < 1 ? "" : f.volume < 1000 ? whole.format(f.volume) : compact.format(f.volume),
      volume: dollars(f.volume),
    };
  return {
    day: p.day,
    live,
    zone: zoneName(p.tz),
    date: fullDate(p.day),
    asked: tally(p.asked),
    answered: tally(p.answered),
    lines: p.lines.map((l) => ({
      ...l, label: label(l.at), moment: moment(l.at),
      settled: l.status === "yes" || l.status === "no",
      outcome: l.status === "yes" ? "Yes" : "No",
      was: turning(l) ? turn!.was(l) : undefined,
      family: family(l.family),
    })),
    wagered: dollars(p.wagered),
  };
}

/** The line a day is shown by in previews: its first answered line, else its first. */
export const headline = (p: Poem) => (p.lines.find((l) => !l.asked) ?? p.lines[0])?.line ?? "";

/** The now page's "Updated …" line: the last run that reached Polymarket,
 *  never the render clock, so a render can't make stale data look fresh. */
export function updatedView(today: Day | null, index: Index, tz: string) {
  const at = today?.runs.length
    ? [...today.runs].reverse().find((r) => !r.failed.includes("polymarket"))?.at ?? ""
    : today ? index.generatedAt : "";
  const t = new Date(at);
  if (Number.isNaN(t.getTime())) return undefined;
  return {
    at,
    label: new Intl.DateTimeFormat(LOCALE, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: tz }).format(t),
    zone: zoneName(tz),
  };
}

/** The feed's days, most recent first. A day is complete at midnight after it,
 *  New York time; noon plus sixteen hours is close enough for a feed. */
export function feedDays(days: string[], poems: Map<string, Poem>) {
  return days.map((day) => {
    const p = poems.get(day)!;
    return { day, date: longDate(day), sealed: new Date(noon(day).getTime() + 16 * 3600_000).toUTCString(), lines: p.lines, wagered: dollars(p.wagered) };
  });
}
