/** Formatting shared by the views, feed and preview images. */

export const LOCALE = "en-US";

/** Noon UTC on a YYYY-MM-DD, so formatting it never slips a day. */
export const noon = (day: string) => {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d, 12));
};
export const longDate = (day: string) =>
  new Intl.DateTimeFormat(LOCALE, { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" }).format(noon(day));
export const fullDate = (day: string) =>
  new Intl.DateTimeFormat(LOCALE, { weekday: "long", month: "long", day: "numeric", year: "numeric", timeZone: "UTC" }).format(noon(day));

/** Whole dollars with thousands separators ("122,348,771"); empty below a dollar.
 *  Used by the colophon and preview cards. */
export function dollars(v: number): string {
  return v < 1 ? "" : new Intl.NumberFormat(LOCALE, { maximumFractionDigits: 0 }).format(Math.round(v));
}

/** "America/New_York" → "New York time". */
export const zoneName = (tz: string) => `${(tz.split("/").pop() ?? tz).replaceAll("_", " ")} time`;
