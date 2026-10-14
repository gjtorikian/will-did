/**
 * humanize(): the pre-rewrite pass. Numerals are the market's native script;
 * this spells them out so the page reads as prose. It's a list of rules, each
 * a pattern and its replacement, applied in order. Order matters: labels and
 * money before bare numbers, ranges before their units, the catch-alls last,
 * so every digit is gone by the end.
 */
import { clock, decimal, isYear, ordinal, scaled, words, year } from "./numbers.js";

/** Markdown some market titles carry (Polymarket bolds a phrase now and then).
 *  Single * and _ are left alone: they turn up inside real identifiers. */
export function stripMarkdown(s: string): string {
  return s
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1") // [text](url)
    .replace(/(\*\*|__|~~)(.+?)\1/g, "$2") // **bold**, __bold__, ~~struck~~
    .replace(/`([^`]+)`/g, "$1"); // `code`
}

/** Curly quotes to straight ones, so every line is typed the same way:
 *  “ ” → " and ‘ ’ → ' (the closing one is also the apostrophe). */
export function straightQuotes(s: string): string {
  return s.replace(/[“”]/g, '"').replace(/[‘’]/g, "'");
}

type Rule = [pattern: RegExp, replacement: string | ((match: string, ...groups: any[]) => string)];

const MONTH_NAMES: Record<string, string> = {
  Jan: "January", Feb: "February", Mar: "March", Apr: "April", Jun: "June", Jul: "July", Aug: "August",
  Sep: "September", Sept: "September", Oct: "October", Nov: "November", Dec: "December",
};
const MONTH = "January|February|March|April|May|June|July|August|September|October|November|December";
const MONTH_OR_ABBR = `${MONTH}|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec`;

/** Words and labels to settle before any number is touched. */
const WORDING: Rule[] = [
  [/\bvs\.?\s/gi, "versus "],
  // month abbreviations, only before a number: "Jan Koum" is a person
  [/\b(Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sept|Sep|Oct|Nov|Dec)\b\.?(?=\s*\d)/g, (_, m: string) => MONTH_NAMES[m]],
  // market-type labels: "hit (HIGH) $260" → "hit a high of $260"
  [/\bhit\s+\((HIGH|LOW)\)\s*/gi, (_, hl: string) => `hit a ${hl.toLowerCase()} of `],
  // …and after the amount: "hit $9,300 (HIGH)"
  [/\bhit\s+(\$?[\d,.]+[kmbt%]?)\s+\((HIGH|LOW)\)/gi, (_, amt: string, hl: string) => `hit a ${hl.toLowerCase()} of ${amt}`],
  // anywhere else the verb already says it: "dip to (LOW) $2,500"
  [/\s*\((?:HIGH|LOW)\)/g, ""],
  // a bare "Week of October 5 2026" wants its preposition and the year its comma
  [/(?<!\b(?:the|of|in)\s)\bWeek of\b/g, "in the week of"],
  [new RegExp(`\\b(${MONTH})\\s+(\\d{1,2})\\s+((?:19|20)\\d\\d)\\b`, "g"), "$1 $2, $3"],
  // "# of tweets", "# tweets", "#1"
  [/#\s*of\s+/g, "number of "],
  [/#\s*(\d+)\b/g, (_, n) => `number ${words(Number(n))}`],
  [/#\s+([a-z])/gi, "number of $1"],
];

/** Money, then clock times: the numbers that carry their own units. */
const MONEY_AND_TIME: Rule[] = [
  // money: $150 million, $3.5m, $600k, $150,000, $10M, with optional trailing "+"
  [
    /\$\s?(\d[\d,]*(?:\.\d+)?)(?:\s?(trillion|billion|million|thousand|tn|bn|mm|t|m|b|k))?\b(\+?)/gi,
    (_, num: string, scale: string | undefined, plus: string) =>
      `${scaled(Number(num.replace(/,/g, "")), scale)} dollars${plus ? " (or more)" : ""}`,
  ],
  // times: 3PM ET, 11:59 PM ET, 10am
  [
    /\b(\d{1,2})(?::(\d{2}))?\s?(am|pm)\b(?:\s?(ET|EST|EDT|PT|PST|PDT|CT|CST|CDT|MT|UTC|GMT))?/gi,
    (_, h, m, ap, tz) => clock(Number(h), m ? Number(m) : 0, ap.toLowerCase() as "am" | "pm", tz),
  ],
  // 24-hour clock: 22:00, 09:30
  [
    /\b([01]?\d|2[0-3]):([0-5]\d)\b(?!\s?(?:am|pm)\b)/gi,
    (_, h: string, m: string) => {
      const hh = Number(h);
      return clock(hh % 12 === 0 ? 12 : hh % 12, Number(m), hh < 12 ? "am" : "pm");
    },
  ],
];

/** Units glued to numbers, ranges of them first, so "72-73°" isn't read as "72-seventy-three degrees". */
const UNITS: Rule[] = [
  // ranges glued to a unit: 72-73°, 10-20%
  [
    /(\bbetween\s+)?\b(\d+(?:\.\d+)?)\s?[-–]\s?(\d+(?:\.\d+)?)\s?(°(?:\s?[FC]\b)?|%)/gi,
    (_, between: string | undefined, a: string, b: string, unit: string) =>
      `${between ?? ""}${decimal(Number(a))} ${between ? "and" : "to"} ${decimal(Number(b))} ${unit.startsWith("%") ? "percent" : "degrees"}`,
  ],
  [/\b(\d+(?:\.\d+)?)\s?bps\b/gi, (_, n) => `${decimal(Number(n))} basis points`],
  [/(\d+(?:\.\d+)?)\s?%/g, (_, n) => `${decimal(Number(n))} percent`],
  [/(\d+(?:\.\d+)?)\s?°(?:\s?[FC]\b)?/g, (_, n) => `${decimal(Number(n))} degrees`],
  // "20+" → "twenty or more"
  [/\b(\d[\d,]*(?:\.\d+)?)\+/g, (_, n) => `${decimal(Number(n.replace(/,/g, "")))} or more`],
  // bare 100k / 2M / 1.5B followers, views, tweets — or at the end of a clause: "less than 8m?"
  [
    /(?<![\w$.])(\d[\d,]*(?:\.\d+)?)\s?(k|m|b)\b(?=\s+[a-z]|\s*[?.!,;:)]|\s*$)/gi,
    (_, n: string, k: string) => scaled(Number(n.replace(/,/g, "")), k),
  ],
];

/** Dates and ranges: days after a month name, then numeric ranges. */
const DATES_AND_RANGES: Rule[] = [
  // day ranges after a month name: October 5-11 → October fifth to eleventh
  [
    new RegExp(`\\b(${MONTH_OR_ABBR})\\.?\\s+(\\d{1,2})\\s?[-–]\\s?(\\d{1,2})\\b`, "g"),
    (_, month: string, a: string, b: string) => `${month} ${ordinal(Number(a))} to ${ordinal(Number(b))}`,
  ],
  // day-of-month after a month name → ordinal word
  [
    new RegExp(`\\b(${MONTH_OR_ABBR})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b(?!:)`, "g"),
    (_, month: string, d: string) => `${month} ${ordinal(Number(d))}`,
  ],
  // numeric ranges: 200-219, 200–219
  [
    /(\bbetween\s+)?\b(\d[\d,]*)\s?[-–]\s?(\d[\d,]*)\b(?![.:\/]\d)/g,
    (_, between: string | undefined, a: string, b: string) => {
      const x = Number(a.replace(/,/g, "")), y = Number(b.replace(/,/g, ""));
      if (isYear(x) && isYear(y)) return `${year(x)} to ${year(y)}`;
      if (isYear(x) && b.length === 2) return `${year(x)} to ${words(y)}`; // a season: 2026-27
      return `${between ?? ""}${words(x)} ${between ? "and" : "to"} ${words(y)}`;
    },
  ],
];

/** Whatever's left. No digit survives these. */
const LEFTOVERS: Rule[] = [
  // integers and decimals standing on their own; years read as years
  [
    /(?<![\w.\-\/:])(\d[\d,]*(?:\.\d+)?)(?![\w.\-\/:])/g,
    (m, n: string) => {
      const v = Number(n.replace(/,/g, ""));
      if (Number.isNaN(v)) return m;
      return isYear(v) ? year(v) : decimal(v);
    },
  ],
  // what's left is glued to something. Ordinals: 5th, 3rd
  [/\b(\d+)(?:st|nd|rd|th)\b/gi, (_, n: string) => ordinal(Number(n))],
  // terms in years: 30Y, 30-year
  [/\b(\d+)(?:Y|-year)\b/g, (_, n: string) => `${words(Number(n))}-year`],
  // anything else, spelled out where it stands, spaced off from letters: US30 → US thirty, GPT-6 → GPT-six
  [
    /(\d[\d,]*(?:\.\d+)?)/g,
    (n: string, _: string, at: number, all: string) => {
      const v = Number(n.replace(/,/g, ""));
      const w = isYear(v) ? year(v) : decimal(v);
      const before = at > 0 && /[A-Za-z]/.test(all[at - 1]) ? " " : "";
      const after = /[A-Za-z]/.test(all[at + n.length] ?? "") ? " " : "";
      return before + w + after;
    },
  ],
];

const RULES: Rule[] = [...WORDING, ...MONEY_AND_TIME, ...UNITS, ...DATES_AND_RANGES, ...LEFTOVERS];

export function humanize(input: string): string {
  return RULES.reduce<string>(
    (s, [pattern, replacement]) => s.replace(pattern, replacement as (match: string, ...groups: any[]) => string),
    input.replace(/\s+/g, " ").trim(),
  );
}
