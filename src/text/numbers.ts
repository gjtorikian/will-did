/**
 * Numbers as words: the vocabulary humanize() spells numerals out with.
 *
 *   words(150)    → one hundred fifty
 *   decimal(3.5)  → three and a half
 *   ordinal(31)   → thirty-first
 *   year(2026)    → twenty twenty-six
 *   clock(3, 0, "pm", "ET") → three in the afternoon, Eastern time
 */

export const isYear = (n: number) => Number.isInteger(n) && n >= 1900 && n <= 2099;

/** Years as they're said: twenty twenty-six, nineteen ninety-nine, two thousand five, nineteen oh five. */
export function year(n: number): string {
  if (n >= 2000 && n < 2010) return words(n);
  const head = Math.floor(n / 100), tail = n % 100;
  if (tail === 0) return `${words(head)} hundred`;
  return `${words(head)} ${tail < 10 ? `oh ${words(tail)}` : words(tail)}`;
}

export function scaled(n: number, scale: string | undefined): string {
  const key = (scale ?? "").toLowerCase();
  const name =
    key === "trillion" || key === "tn" || key === "t" ? "trillion"
      : key === "billion" || key === "bn" || key === "b" ? "billion"
        : key === "million" || key === "mm" || key === "m" ? "million"
          : key === "thousand" || key === "k" ? "thousand"
            : "";
  return name ? `${decimal(n)} ${name}` : decimal(n);
}

/** 3.5 → "three and a half"; 1.8 → "one point eight"; 150 → "one hundred fifty". */
export function decimal(n: number): string {
  if (Number.isInteger(n)) return words(n);
  const whole = Math.floor(n);
  const frac = Math.round((n - whole) * 100) / 100;
  if (frac === 0.5) return whole === 0 ? "a half" : `${words(whole)} and a half`;
  if (frac === 0.25) return `${words(whole)} and a quarter`;
  if (frac === 0.75) return `${words(whole)} and three quarters`;
  const digits = String(n).split(".")[1] ?? "";
  return `${words(whole)} point ${[...digits].map((d) => ONES[Number(d)]).join(" ")}`;
}

const ONES = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve",
  "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"];
const TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];
const SCALES: Array<[number, string]> = [[1e12, "trillion"], [1e9, "billion"], [1e6, "million"], [1e3, "thousand"]];

export function words(n: number): string {
  if (!Number.isFinite(n)) return String(n);
  if (n < 0) return `minus ${words(-n)}`;
  if (n < 20) return ONES[n];
  if (n < 100) return TENS[Math.floor(n / 10)] + (n % 10 ? `-${ONES[n % 10]}` : "");
  if (n < 1000) return `${ONES[Math.floor(n / 100)]} hundred${n % 100 ? ` ${words(n % 100)}` : ""}`;
  for (const [value, name] of SCALES) {
    if (n >= value) {
      const head = Math.floor(n / value), rest = n % value;
      return `${words(head)} ${name}${rest ? ` ${words(rest)}` : ""}`;
    }
  }
  return String(n);
}

const ORDINALS: Record<string, string> = {
  one: "first", two: "second", three: "third", five: "fifth", eight: "eighth", nine: "ninth", twelve: "twelfth",
};
export function ordinal(n: number): string {
  const w = words(n);
  const parts = w.split(/[\s-]/);
  const last = parts[parts.length - 1];
  const ord = ORDINALS[last] ?? (last.endsWith("y") ? `${last.slice(0, -1)}ieth` : `${last}th`);
  return w.slice(0, w.length - last.length) + ord;
}

export function clock(h: number, m: number, ap: "am" | "pm", tz?: string): string {
  const hour = ONES[h === 0 ? 12 : h];
  const minutes = m === 0 ? "" : m < 10 ? ` oh ${ONES[m]}` : ` ${words(m)}`;
  const part =
    ap === "am" ? (h === 12 ? "at midnight" : "in the morning")
      : h === 12 ? "at noon"
        : h < 6 ? "in the afternoon"
          : "in the evening";
  const base = (h === 12 && m === 0) ? part : `${hour}${minutes} ${part}`;
  const zone = tz ? `, ${ZONES[tz.toUpperCase()] ?? tz} time` : "";
  return base + zone;
}

const ZONES: Record<string, string> = {
  ET: "Eastern", EST: "Eastern", EDT: "Eastern", CT: "Central", CST: "Central", CDT: "Central",
  MT: "Mountain", PT: "Pacific", PST: "Pacific", PDT: "Pacific", UTC: "universal", GMT: "Greenwich",
};
