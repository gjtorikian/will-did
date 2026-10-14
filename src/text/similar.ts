/* Will / Did — near-duplicate lines, thinned when the site is rendered.
 *
 * Much of the corpus is one sentence issued many times with a slot changed: a
 * ladder of gold prices, the same temperature question for forty cities, a
 * Bitcoin candle every fifteen minutes, a streamer "eliminated by" fire, lava,
 * a cactus. The data keeps every market; the page prints one per family.
 *
 * Two passes, both cheap enough to run in the browser on every render:
 *
 *   1. Mask. Numbers (spelled out, ordinals, ranges, clock times) and names
 *      (runs of capitalised words) become placeholders; comparisons ("above",
 *      "or higher") are dropped. Lines that are then identical are one family.
 *   2. Join. Masked templates within a few words of each other — a word-level
 *      edit distance of at most a third of their real (unmasked) words, three
 *      at most — are joined too, transitively. Only templates that share their first or last
 *      three words are compared, so this stays near-linear.
 *
 * Rows are compared by the market's original question when they carry one, not
 * by the printed line: a Will line and a Did line from the same family read
 * differently ("Will X be above…?" / "X did not end up above…") but were asked
 * the same way. Outcome is a slot too ("did" / "did not", "Yes." / "No."), so a
 * ladder that settled both ways is one family.
 */

const NUMBER_WORDS = [
  "zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten",
  "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen",
  "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety",
  "hundred", "thousand", "million", "billion", "trillion", "point", "oh", "half", "quarter", "noon", "midnight",
  "first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth", "ninth", "tenth",
  "eleventh", "twelfth", "thirteenth", "fourteenth", "fifteenth", "sixteenth", "seventeenth",
  "eighteenth", "nineteenth", "twentieth", "thirtieth",
].sort((a, b) => b.length - a.length); // longest first, so "fourteenth" beats "four"

// digits may carry a short suffix: 8m, 25bps, 3rd, 30Y
const TOKEN = `(?:${NUMBER_WORDS.join("|")}|\\d[\\d,.:]*[a-z]{0,3})`;
// a run of number tokens joined the way prose.ts joins them: spaces, hyphens,
// "and", "a", "and a" (six and a quarter)
const RUN = new RegExp(`\\b${TOKEN}\\b(?:(?:[\\s-]+|\\s+and(?:\\s+a)?\\s+|\\s+a\\s+)${TOKEN}\\b)*`, "gi");
// "#-#", "# to #", ">#", "<#" (a ladder's end bins) and the like collapse to one mark
const MARKS = /[<>≤≥]?#(?:[\s\-–]*(?:to\s+)?[<>≤≥]?#)*/g;
// A ladder's rungs differ in their comparison as well as their number:
// "less than eighty", "between …", "fifteen or higher". The comparison means
// nothing without its number, which is masked anyway, so it's dropped.
const COMPARE =
  /\b(?:(?:less|more|greater|fewer|higher|lower) than|above|below|under|over|between|at (?:least|most)|or (?:higher|lower|above|below|more|less|fewer|greater))\b/gi;
// Capitalised words that open a sentence without naming anything.
const OPENERS = new Set(["Will", "Did", "Was", "Were", "The", "A", "An", "It", "There", "No", "Yes", "Neither", "Either"]);
// Month names are capitalised but belong to the date, which is already masked.
const MONTHS = /^(?:January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)$/;

/** Words of a template that aren't placeholders. */
function real(t: string[]): number {
  return t.filter((w) => w !== "N" && w !== "#").length;
}

/** Words of a line with numbers, comparisons and names masked. A sentence
 *  that would be left with fewer than three real words ("will N be #") keeps
 *  its names: with that little left, the names are what tell it apart. */
export function template(line: string): string[] {
  const s = line
    .replace(COMPARE, " ")
    .replace(RUN, " # ")
    .replace(/#\s+in the (?:morning|afternoon|evening)\b/gi, "#") // prose.ts's clock times; "noon" has none
    .replace(MARKS, " # ");
  const masked = tokens(s, true);
  return real(masked) >= 3 ? masked : tokens(s, false);
}

function tokens(s: string, maskNames: boolean): string[] {
  const out: string[] = [];
  for (const w of s.split(/[^\p{L}\p{N}#''&]+/u)) {
    if (!w) continue;
    const name = maskNames && /^\p{Lu}/u.test(w) && !(out.length === 0 && OPENERS.has(w)) && !MONTHS.test(w);
    const tok = name ? "N" : w.toLowerCase();
    if ((tok === "N" || tok === "#") && out[out.length - 1] === tok) continue; // "New York City" is one name
    if (tok === "not" && out[out.length - 1] === "did") continue; // the outcome is a slot, not a difference
    out.push(tok);
  }
  if (out.length > 1 && (out[out.length - 1] === "yes" || out[out.length - 1] === "no")) out.pop(); // "…? Yes." / "…? No."
  return out;
}

/** The exact-match family key: the masked template as one string. */
export function family(line: string): string {
  return template(line).join(" ");
}

/** Word-level edit distance, giving up (returning max + 1) once it must exceed `max`. */
function distance(a: string[], b: string[], max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (cur[j] < best) best = cur[j];
    }
    if (best > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}

/** How many words two templates may differ by and still be one family:
 *  a third of their real words (placeholders don't count), three at most. A
 *  template that's mostly placeholders ("will N be #") gets no slack at all. */
const slack = (a: string[], b: string[]) => Math.min(3, Math.floor(Math.min(real(a), real(b)) / 3));

/** FNV-1a: a cheap, stable stand-in for a random draw. */
function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return h >>> 0;
}

type Row = { id: string; line: string; question?: string };

/** One line per family, in the original order. Which member stands for the
 *  family is arbitrary but stable — the one whose id hashes lowest — so a
 *  sealed day reads the same on every visit. `scope` partitions the rows
 *  further (the timeline passes the date, so a daily ladder keeps a line a
 *  day). */
export function onePerFamily<T extends Row>(rows: T[], scope?: (row: T) => string): T[] {
  const keep = new Set(families(rows, scope).map((f) => f.rep));
  return rows.filter((r) => keep.has(r));
}

const SEP = "\u0000";

/** Pass 1: each row's exact template, keyed within its partition. */
function keyed<T extends Row>(rows: T[], scope?: (row: T) => string) {
  const words = new Map<string, string[]>(); // key → template, in first-seen order
  const rowKey = rows.map((row) => {
    const t = template(row.question ?? row.line);
    const k = `${scope ? scope(row) : ""}${SEP}${t.join(" ")}`;
    if (!words.has(k)) words.set(k, t);
    return k;
  });
  return { words, rowKey };
}

/** Union-find over template keys: which family each key has joined. */
function unionFind(keys: Iterable<string>) {
  const parent = new Map([...keys].map((k) => [k, k]));
  const find = (k: string): string => {
    let r = k;
    while (parent.get(r) !== r) r = parent.get(r)!;
    parent.set(k, r);
    return r;
  };
  return { find, union: (a: string, b: string) => void parent.set(find(a), find(b)) };
}

/** Candidate pairs come only from templates in the same partition that share
 *  their first or last three words, so joining stays near-linear. */
function blocks(words: Map<string, string[]>): string[][] {
  const out = new Map<string, string[]>();
  for (const [k, t] of words) {
    const part = k.slice(0, k.lastIndexOf(SEP));
    for (const edge of [`<${t.slice(0, 3).join(" ")}`, `>${t.slice(-3).join(" ")}`]) {
      const b = `${part}${SEP}${edge}`;
      (out.get(b) ?? out.set(b, []).get(b)!).push(k);
    }
  }
  return [...out.values()];
}

/** Pass 2: join templates within a few words of each other. */
function joinNear(words: Map<string, string[]>, uf: ReturnType<typeof unionFind>): void {
  for (const members of blocks(words)) {
    for (let i = 0; i < members.length; i++) {
      for (let j = i + 1; j < members.length; j++) {
        const a = members[i], b = members[j];
        if (uf.find(a) === uf.find(b)) continue;
        const ta = words.get(a)!, tb = words.get(b)!;
        const max = slack(ta, tb);
        if (max > 0 && distance(ta, tb, max) <= max) uf.union(a, b);
      }
    }
  }
}

/** Group rows by family; the member whose id hashes lowest stands for it. */
function gather<T extends Row>(rows: T[], familyOf: (i: number) => string): Array<{ rep: T; members: T[] }> {
  const fams = new Map<string, { rep: T; h: number; members: T[] }>();
  rows.forEach((row, i) => {
    const f = familyOf(i);
    const h = hash(row.id);
    const cur = fams.get(f);
    if (!cur) fams.set(f, { rep: row, h, members: [row] });
    else {
      cur.members.push(row);
      if (h < cur.h) Object.assign(cur, { rep: row, h });
    }
  });
  return [...fams.values()].map(({ rep, members }) => ({ rep, members }));
}

/** Every family: the member that stands for it, and all its members (the
 *  representative included), each in the original order. */
export function families<T extends Row>(rows: T[], scope?: (row: T) => string): Array<{ rep: T; members: T[] }> {
  const { words, rowKey } = keyed(rows, scope);
  const uf = unionFind(words.keys());
  joinNear(words, uf);
  return gather(rows, (i) => uf.find(rowKey[i]));
}
