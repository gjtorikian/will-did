/**
 * The site generator. TypeScript decides what's on a page; Handlebars
 * templates in site/templates decide how it reads. Every word and tag on the
 * site lives in a template, a partial, or site/site.json; the code only
 * builds the data they're filled with.
 *
 *   poem.ts       the archived poem, and how a day's lines are chosen
 *   views.ts      the data each template is filled with
 *   templates.ts  Handlebars, its helpers, and site.json
 *   format.ts     dates, dollars, zones
 *   card.ts       preview images
 *   render.ts     this: gather the days, write each page
 *
 * A sealed day is final during ordinary renders. Its poem (the lines chosen
 * for it, their times and links, its counts and the total wagered) is written
 * once to archive/2026-10-13.json, committed, and read from there ever after;
 * the data behind it can then be pruned.
 *
 *   npm run render                 # data/ + archive/ → public/
 */
import { copyFile, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { dayOf, readIndex, readJSON } from "../capture/store.js";
import { loadOverrides } from "../text/overrides.js";
import { openLine, type Style } from "../capture/run.js";
import { cardLayout, png } from "./card.js";
import { dollars, longDate } from "./format.js";
import { compose, type Poem } from "./poem.js";
import { loadMeta, templates, type Meta, type Templates } from "./templates.js";
import { archiveNav, dayView, feedDays, headline, updatedView } from "./views.js";
import type { Day, Index } from "../types.js";

export interface RenderOptions {
  dataDir: string;
  outDir: string;
  /** where sealed days' poems are kept (default "archive") */
  archiveDir?: string;
  /** absolute URL the site is served from, for the feed and preview tags */
  siteUrl?: string;
  now?: Date;
  /** on the now page, lines that settled this recently show both tenses */
  turnMinutes?: number;
  /** preview images; off in tests that don't need them */
  cards?: boolean;
  /** where templates, site.json and style.css live (default "site") */
  siteDir?: string;
}

export interface RenderReport {
  pages: number;
  archived: string[]; // days newly written to the archive by this render
  lines: number;
  turning: number; // lines shown mid-turn on the now page
  bytes: number;
}

/* ---------- steps ---------- */

/** Sealed days come from the archive; a day sealed since the last render is
 *  composed from data and archived now. The unsealed day is today. */
async function gather(index: Index, dataDir: string, archiveDir: string) {
  await mkdir(archiveDir, { recursive: true });
  const poems = new Map<string, Poem>();
  for (const f of await readdir(archiveDir)) {
    if (/^\d{4}-\d{2}-\d{2}\.json$/.test(f)) poems.set(f.slice(0, 10), JSON.parse(await readFile(join(archiveDir, f), "utf8")) as Poem);
  }
  let today: Day | null = null;
  const archived: string[] = [];
  for (const ref of [...(index.days ?? [])].sort((a, b) => a.day.localeCompare(b.day))) {
    if (poems.has(ref.day)) continue;
    const d = await readJSON<Day>(join(dataDir, ref.file));
    if (!d) continue;
    if (!d.sealed) {
      today = d; // the latest unsealed day
      continue;
    }
    const p = compose(d);
    poems.set(d.day, p);
    await writeFile(join(archiveDir, `${d.day}.json`), JSON.stringify(p));
    archived.push(d.day);
  }
  return { poems, today, archived, days: [...poems.keys()].sort().reverse() };
}

/** Everything the page-writing steps share. */
interface Site {
  t: Templates;
  meta: Meta;
  url: string; // absolute, with a trailing slash
  days: string[]; // sealed days, most recent first
  write: (path: string, body: string | Buffer) => Promise<void>;
  card: (name: string, c: { date?: string; live?: boolean; line: string; footer: string }) => Promise<void>;
}

type Head = { heading: string; description: string; path: string; image: string };

async function page(s: Site, path: string, current: string, root: string, head: Head, body: string) {
  await s.write(path, s.t.layout({ ...head, meta: s.meta, site: s.url, root, current, months: archiveNav(s.days, current), body }));
}

const volumeCaption = (s: Site, p: Poem) => (p.wagered >= 1 ? s.t.text("volume-card", { amount: dollars(p.wagered) }) : "");

async function writeAbout(s: Site) {
  await page(s, "about.html", "about", "", { heading: "about", description: s.meta.tagline, path: "about.html", image: "images/about.png" }, s.t.about({ meta: s.meta }));
  await s.card("about", { line: s.meta.card.line, footer: s.meta.card.footer });
}

/** Today's poem, at the root and at now.html. Returns its line and turning counts. */
async function writeNow(s: Site, today: Day | null, index: Index, now: Date, turnMinutes: number, st: Style) {
  const tz = today?.tz ?? "America/New_York";
  const poem: Poem = today
    ? compose(today)
    : { day: dayOf(now, tz), tz, asked: { shown: 0, total: 0 }, answered: { shown: 0, total: 0 }, wagered: 0, lines: [] };
  const view = dayView(poem, true, { now, minutes: turnMinutes, was: (l) => openLine(l.id, l.question, st) });
  const body = s.t.day({ ...view, intro: s.meta.intro, updated: updatedView(today, index, tz), available: !!today, root: "" });
  const head = { heading: "now", description: s.meta.tagline, path: "", image: today ? "images/now.png" : "images/about.png" };
  await page(s, "index.html", "now", "", head, body);
  await page(s, "now.html", "now", "", head, body);
  if (today) await s.card("now", { date: longDate(poem.day), live: true, line: headline(poem), footer: volumeCaption(s, poem) });
  return { lines: poem.lines.length, turning: view.lines.filter((l) => l.was !== undefined).length };
}

/** One page per sealed day. Returns the number of lines written. */
async function writeDays(s: Site, poems: Map<string, Poem>) {
  let lines = 0;
  for (const day of s.days) {
    const p = poems.get(day)!;
    const head = { heading: longDate(day), description: headline(p) || s.meta.tagline, path: `${day}/`, image: `images/${day}.png` };
    await page(s, join(day, "index.html"), day, "../", head, s.t.day({ ...dayView(p, false), available: true, root: "../" }));
    await s.card(day, { date: longDate(day), line: headline(p), footer: volumeCaption(s, p) });
    lines += p.lines.length;
  }
  return lines;
}

/** RSS: the last thirty sealed days. */
async function writeFeed(s: Site, poems: Map<string, Poem>, now: Date) {
  await s.write("feed.xml", s.t.feed({ meta: s.meta, site: s.url, built: now.toUTCString(), days: feedDays(s.days.slice(0, 30), poems) }));
}

/* ---------- the site ---------- */

export async function render(opts: RenderOptions): Promise<RenderReport> {
  const { dataDir, outDir, archiveDir = "archive", now = new Date(), turnMinutes = 60, cards = true, siteDir = "site" } = opts;
  const report: RenderReport = { pages: 0, archived: [], lines: 0, turning: 0, bytes: 0 };
  // No working state (a first run, or a lost cache) still renders the archive.
  const index: Index = (await readIndex(dataDir)) ?? { generatedAt: "", open: [], resolved: [], days: [], counts: { open: 0, resolved: 0 } };
  const st: Style = { form: "declarative", answer: "yesno", overrides: await loadOverrides() };
  const { poems, today, archived, days } = await gather(index, dataDir, archiveDir);
  report.archived = archived;

  await rm(outDir, { recursive: true, force: true });
  await mkdir(join(outDir, "images"), { recursive: true });
  const t = await templates(join(siteDir, "templates"));
  const meta = await loadMeta(siteDir);
  const write = async (path: string, body: string | Buffer) => {
    await mkdir(join(outDir, path, ".."), { recursive: true });
    await writeFile(join(outDir, path), body);
    if (path.endsWith(".html")) report.pages++;
    report.bytes += typeof body === "string" ? Buffer.byteLength(body) : body.length;
  };
  const site: Site = {
    t,
    meta,
    url: (opts.siteUrl ?? "http://localhost:8000/").replace(/\/?$/, "/"),
    days,
    write,
    card: async (name, c) => {
      if (cards) await write(`images/${name}.png`, png(t.card({ meta, ...c, ...cardLayout(c.line) }), join(siteDir, "fonts")));
    },
  };

  await writeAbout(site);
  const nowCounts = await writeNow(site, today, index, now, turnMinutes, st);
  report.lines = nowCounts.lines + (await writeDays(site, poems));
  report.turning = nowCounts.turning;
  await writeFeed(site, poems, now);
  await copyFile(join(siteDir, "style.css"), join(outDir, "style.css"));
  return report;
}

const isMain = process.argv[1]?.endsWith("render.js");
if (isMain) {
  render({
    dataDir: process.env.DATA_DIR ?? "data",
    outDir: process.env.OUT_DIR ?? "public",
    archiveDir: process.env.ARCHIVE_DIR ?? "archive",
    siteUrl: process.env.SITE_URL,
  })
    .then((r) =>
      console.log(
        `${r.pages} pages · ${r.lines} lines · ${r.turning} turning · ${(r.bytes / 1e6).toFixed(2)} MB` +
        (r.archived.length ? ` · archived ${r.archived.join(", ")}` : ""),
      ),
    )
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
