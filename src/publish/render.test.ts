import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run, type Adapter } from "../capture/run.js";
import { render } from "./render.js";
import { compose, type Poem } from "./poem.js";
import { archiveNav } from "./views.js";
import { prune } from "../maintenance/prune.js";
import type { Day, Fetched, Market } from "../types.js";

const f = (id: string, question: string, closes: string, extra: Partial<Fetched> = {}): Fetched => ({
  id, source: "polymarket", question, closes, url: `https://example.test/${id}?a=1&b=2`, volume: 100, created: null,
  closed: false, result: null, closedAt: null, ...extra,
});

test("render writes static pages: about, now, a feed and preview images", async () => {
  const data = await mkdtemp(join(tmpdir(), "will-did-"));
  const out = join(data, "public");
  const adapter: Adapter = {
    fetchOpen: async () => [
      f("pm:1", "Will Bitcoin be above $90,000 on October 7?", "2026-10-07T16:00:00Z"),
      f("pm:2", "Will Bitcoin be above $92,000 on October 7?", "2026-10-07T16:00:00Z"),
      f("pm:3", "Will <Acme> & Co. IPO before 2027?", "2026-12-31T00:00:00Z"),
    ],
    fetchClosedSince: async () => [
      // settled half an hour before the render: shown mid-turn
      f("pm:4", "Will the Fed cut rates in October?", "2026-10-06T12:00:00Z", { closed: true, result: "no", closedAt: "2026-10-06T13:30:00Z", volume: 2_400_000 }),
    ],
    fetchOne: async () => null,
  };
  const now = new Date("2026-10-06T14:00:00Z");
  await run({ dataDir: data, adapters: { polymarket: adapter }, now, log: () => { } });
  const rep = await render({ dataDir: data, outDir: out, archiveDir: join(data, "archive"), siteUrl: "https://willdid.test/", now });

  assert.deepEqual((await readdir(out)).sort(), ["about.html", "feed.xml", "images", "index.html", "now.html", "style.css"]);
  assert.deepEqual((await readdir(join(out, "images"))).sort(), ["about.png", "now.png"]);
  const about = await readFile(join(out, "about.html"), "utf8");
  const home = await readFile(join(out, "index.html"), "utf8");
  const nowPage = await readFile(join(out, "now.html"), "utf8");

  assert.match(about, /<article class="about">/, "the essay has its own page, from site/templates/about.hbs");
  assert.match(about, /aria-current="page">about</);
  assert.equal((nowPage.match(/Bitcoin/g) ?? []).length, 1, "the price ladder is one line");
  assert.match(nowPage, /&lt;Acme&gt; &amp; Co\./, "text is escaped");
  assert.match(nowPage, /\?a&#x3D;1&amp;b&#x3D;2"/, "so are links (Handlebars escapes = too; browsers read it as =)");
  assert.match(nowPage, /class="turning"[\s\S]*?<s class="was">Will the Fed cut rates in October\?<\/s>[\s\S]*?The Fed <span class="did">did not<\/span> cut rates in October\./);
  assert.equal(rep.turning, 1);
  assert.equal(home, nowPage, "the existing now URL aliases the poem homepage");
  const { intro } = JSON.parse(await readFile("site/site.json", "utf8")) as { intro: string };
  assert.ok(home.includes(`<p class="intro">${intro}</p>`), "the intro comes from site.json");
  assert.match(home, /<link rel="canonical" href="https:\/\/willdid.test\/">/);
  assert.match(home, /Updated <time datetime="2026-10-06T14:00:00.000Z">Oct 6, 10:00<\/time> · New York time/);
  assert.ok(home.indexOf('class="day-colophon"') > home.indexOf('</ol>'), "counts and money follow the poem");
  const primary = home.match(/<nav class="primary"[\s\S]*?<\/nav>/)![0];
  assert.match(primary, /aria-current="page">now</);
  assert.match(primary, /href="about.html">about</);
  assert.doesNotMatch(primary, /class="month"/);
  assert.match(nowPage, /<p class="wagered">2,400,300 USD in trading volume across this poem's underlying markets…so far\./, "the one number, in full");
  assert.match(nowPage, /<meta property="og:image" content="https:\/\/willdid\.test\/images\/now\.png">/);
  assert.match(nowPage, /href="feed\.xml"/);
  assert.doesNotMatch(about + nowPage, /\.json/, "no data is referenced");
  await render({ dataDir: data, outDir: out, archiveDir: join(data, "archive"), now: new Date("2026-10-06T18:00:00Z"), cards: false });
  const later = await readFile(join(out, "index.html"), "utf8");
  assert.doesNotMatch(later, /class="turning"/);
  assert.match(later, /Updated <time datetime="2026-10-06T14:00:00.000Z">/, "rendering does not invent a newer capture");
  const dayPath = join(data, "days", "2026-10-06.json");
  const capturedDay = JSON.parse(await readFile(dayPath, "utf8")) as Day;
  capturedDay.runs.push({ ...capturedDay.runs[0], at: "2026-10-06T17:00:00Z", failed: ["polymarket"] });
  await writeFile(dayPath, JSON.stringify(capturedDay));
  await render({ dataDir: data, outDir: out, archiveDir: join(data, "archive"), now: new Date("2026-10-06T18:00:00Z"), cards: false });
  assert.match(await readFile(join(out, "index.html"), "utf8"), /Updated <time datetime="2026-10-06T14:00:00.000Z">/, "a failed fetch does not claim fresh data");
});

test("a sealed day is archived once, rendered from the archive after, fed, and its data pruned", async () => {
  const data = await mkdtemp(join(tmpdir(), "will-did-"));
  const archive = join(data, "archive");
  const out = join(data, "public");
  const day1: Adapter = {
    fetchOpen: async () => [f("pm:1", "Will the Fed cut rates in December?", "2026-12-10T00:00:00Z", { created: "2026-10-06T13:00:00Z" })],
    fetchClosedSince: async () => [],
    fetchOne: async () => null,
  };
  await run({ dataDir: data, adapters: { polymarket: day1 }, now: new Date("2026-10-06T14:00:00Z"), log: () => { } });
  // the next day's first run seals Oct 6
  await run({ dataDir: data, adapters: { polymarket: day1 }, now: new Date("2026-10-07T14:00:00Z"), log: () => { } });

  const r1 = await render({ dataDir: data, outDir: out, archiveDir: archive, now: new Date("2026-10-07T14:00:00Z"), cards: false, siteUrl: "https://willdid.test" });
  assert.deepEqual(r1.archived, ["2026-10-06"]);
  const frozen = JSON.parse(await readFile(join(archive, "2026-10-06.json"), "utf8")) as Poem;
  assert.deepEqual(frozen.lines.map((l) => l.line), ["Will the Fed cut rates in December?"], "the archive holds the day's lines as data");
  assert.equal(frozen.wagered, 100);
  const sealedPage = await readFile(join(out, "2026-10-06", "index.html"), "utf8");
  assert.match(sealedPage, /100 USD in trading volume across this poem's underlying markets\./);
  assert.doesNotMatch(sealedPage, /class="turning"/, "nothing is mid-turn on a sealed day");

  const rss = await readFile(join(out, "feed.xml"), "utf8");
  assert.match(rss, /<title>October 6, 2026<\/title>\s*<link>https:\/\/willdid\.test\/2026-10-06\/<\/link>/);
  assert.match(rss, /Fed cut rates in December/);

  const p = await prune(data, archive);
  assert.deepEqual(p.days, ["2026-10-06"]);
  assert.deepEqual((await readdir(join(data, "days"))).sort(), ["2026-10-07.json"]);

  // with its data gone, the day still renders, from the archive, with the current nav
  const r2 = await render({ dataDir: data, outDir: out, archiveDir: archive, now: new Date("2026-10-07T15:00:00Z"), cards: false, siteUrl: "https://willdid.test" });
  assert.deepEqual(r2.archived, [], "already archived: not rewritten");
  const page = await readFile(join(out, "2026-10-06", "index.html"), "utf8");
  assert.equal(page, sealedPage, "rendered from the archive, the page is unchanged");
  assert.match(page, /href="\.\.\/">now</);
  assert.match(page, /href="\.\.\/about\.html"/);
  assert.match(page, /aria-current="page">October 6, 2026</);
});

test("a same-day answer replaces its question before family selection", () => {
  const question: Market = {
    id: "pm:1", source: "polymarket", question: "Will the Fed cut rates in October?",
    line: "Will the Fed cut rates in October?", status: "open", seen: "2026-10-06T12:00:00Z",
    closes: null, url: "https://example.test/1", volume: 10,
  };
  const answer: Market = { ...question, status: "yes", line: "The Fed did cut rates in October.", resolvedAt: "2026-10-06T16:00:00Z", volume: 50 };
  const day: Day = { day: "2026-10-06", tz: "America/New_York", sealed: false, asked: [question], answered: [answer], voided: [], runs: [] };
  const poem = compose(day);
  assert.equal(poem.lines.length, 1);
  assert.equal(poem.lines[0].line, answer.line);
  assert.equal(poem.lines[0].at, answer.resolvedAt);
  assert.equal(poem.lines[0].asked, false);
  assert.deepEqual(poem.asked, { shown: 0, total: 1 });
  assert.deepEqual(poem.answered, { shown: 1, total: 1 });
  assert.equal(poem.wagered, 50, "the same market's volume is counted once");
});

test("older months collapse except for the month being read", () => {
  const days = ["2026-10-13", "2026-10-12", "2026-09-30", "2026-08-31"];
  const months = archiveNav(days, "2026-08-31");
  assert.deepEqual(months.map((m) => [m.month, m.open]), [["2026-10", true], ["2026-09", false], ["2026-08", true]]);
  assert.deepEqual(months.flatMap((m) => m.days.map((d) => d.day)), days);
});

test("an empty installation renders the archive entrance without claiming fresh data", async () => {
  const data = await mkdtemp(join(tmpdir(), "will-did-empty-"));
  const out = join(data, "public");
  await render({ dataDir: data, outDir: out, archiveDir: join(data, "archive"), now: new Date("2026-10-06T14:00:00Z"), cards: false });
  const home = await readFile(join(out, "index.html"), "utf8");
  assert.match(home, /Today's poem is waiting for its first update/);
  assert.doesNotMatch(home, /Updated <time/);
  assert.match(home, /Tuesday, October 6, 2026/);
});
