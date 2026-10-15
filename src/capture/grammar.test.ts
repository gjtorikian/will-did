import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rewrite, rewriteQuestion } from "../text/rewrite.js";
import { run, type Adapter } from "./run.js";
import { rerender } from "../maintenance/rerender.js";
import { backfill } from "./backfill.js";
import type { Day, Fetched, Market } from "../types.js";

// --- the question form: one-token modal swap, no verb list needed ---
const q: Array<[string, "yes" | "no", string]> = [
  ["Will Bitcoin reach $150,000 by December 31?", "yes", "Did Bitcoin reach $150,000 by December 31? Yes."],
  ["Will OpenAI IPO before 2027?", "no", "Did OpenAI IPO before 2027? No."], // "IPO" is not in any verb list; still correct
  ["Will X headline Coachella?", "yes", "Did X headline Coachella? Yes."],
  ["Will the Lakers be eliminated in the first round?", "no", "Were the Lakers eliminated in the first round? No."],
  ["Will Pablo Picasso be #1 in auction turnover for 2026?", "yes", "Was Pablo Picasso #1 in auction turnover for 2026? Yes."],
  ["Will there be a ceasefire by June 30?", "no", "Was there a ceasefire by June 30? No."],
  ['Will "Veto" be said 5+ times during Episode 41?', "yes", 'Was "Veto" said 5+ times during Episode 41? Yes.'],
  ["Bitcoin Up or Down - October 6, 3PM ET", "no", "Did Bitcoin go up, October 6, 3PM ET? No."],
  ["Ethereum above $4,000 on October 10?", "yes", "Was Ethereum above $4,000 on October 10? Yes."],
  ["Fed decision in December: Cut 25bps", "yes", "Fed decision in December: Cut 25bps? Yes."],
];
for (const [question, r, expected] of q) {
  test(`question form: ${question} → ${r}`, () => assert.equal(rewrite(question, r, "question"), expected));
}
test("question form, did/did not answers", () => {
  assert.equal(rewriteQuestion("Will Jesus Christ return before 2027?", "no", "did"), "Did Jesus Christ return before 2027? Did not.");
  assert.equal(rewriteQuestion('Will Trump say "Tiger" this week?', "yes", "did"), 'Did Trump say "Tiger" this week? Did.');
});

// --- overrides + rerender: fix a pattern once, every stored line follows ---
const f = (id: string, question: string, closes: string, extra: Partial<Fetched> = {}): Fetched => ({
  id, source: "polymarket", question, closes, url: `https://example.test/${id}`, volume: 100, created: null,
  closed: false, result: null, closedAt: null, ...extra,
});
const fake = (open: Fetched[], closed: Fetched[]): Adapter => ({
  fetchOpen: async () => open,
  fetchClosedSince: async () => closed,
  fetchOne: async () => null,
});

test("a grammar miss is recorded, then recovered by overrides + rerender", async () => {
  const dir = await mkdtemp(join(tmpdir(), "will-did-"));
  const now = new Date("2026-10-06T14:00:00Z");
  const a = fake(
    [f("pm:1", "Will OpenAI IPO before 2027?", "2026-12-31T00:00:00Z")],
    // settled this morning, so it's on today's page as well as in the record
    [f("pm:2", "Will Tesla dethrone Toyota in 2025?", "2025-12-31T00:00:00Z", { closed: true, result: "no", closedAt: "2026-10-06T12:00:00Z" })],
  );
  const r = await run({ dataDir: dir, adapters: { polymarket: a }, now, lookbackHours: 24 * 7, log: () => {} });
  // "IPO" and "dethrone" are unknown verbs: the Will-line is fine (it starts with Will already),
  // but the declarative Did-line falls back.
  const resolved = JSON.parse(await readFile(join(dir, "resolved/2026-10.json"), "utf8")) as Market[];
  assert.equal(resolved[0].line, "Did Tesla dethrone Toyota in twenty twenty-five? No.");
  assert.equal(r.index.counts.open, 1);

  // The editor adds the verb and re-renders. No re-fetch needed.
  process.env.OVERRIDES = join(dir, "overrides.json");
  await writeFile(process.env.OVERRIDES, JSON.stringify({ verbs: ["dethrone", "ipo"] }));
  const rep = await rerender(dir, { form: "declarative", answer: "yesno" });
  delete process.env.OVERRIDES;
  assert.equal(rep.changed, 2, "the line lives in the resolved shard and in the day file");
  const fixed = JSON.parse(await readFile(join(dir, "resolved/2026-10.json"), "utf8")) as Market[];
  assert.equal(fixed[0].line, "Tesla did not dethrone Toyota in twenty twenty-five.");
  const day = JSON.parse(await readFile(join(dir, "days/2026-10-06.json"), "utf8")) as Day;
  assert.equal(day.answered[0].line, "Tesla did not dethrone Toyota in twenty twenty-five.", "day files are re-rendered too");
  assert.equal(day.runs.length, 1, "one heartbeat recorded");

  // Switching the whole archive to the question form is also just a rerender.
  const rep2 = await rerender(dir, { form: "question", answer: "did" });
  assert.equal(rep2.changed, 2);
  const asQ = JSON.parse(await readFile(join(dir, "resolved/2026-10.json"), "utf8")) as Market[];
  assert.equal(asQ[0].line, "Did Tesla dethrone Toyota in twenty twenty-five? Did not.");
});

test("unphraseable, sports and untraded markets are dropped, counted but not kept", async () => {
  const dir = await mkdtemp(join(tmpdir(), "will-did-"));
  const now = new Date("2026-10-06T14:00:00Z");
  const a = fake(
    [
      f("pm:9", "Elon Musk # tweets October 6 - October 13, 2026?", "2026-10-13T00:00:00Z"),
      f("pm:10", "Will the Jets beat the Bills?", "2026-10-12T00:00:00Z", { sports: true }),
      f("pm:11", "Will a question nobody bet on resolve?", "2026-10-12T00:00:00Z", { volume: 0 }),
      f("pm:12", "Will Bitcoin reach $150,000 by December 31?", "2026-12-31T00:00:00Z"),
    ],
    [],
  );
  const r = await run({ dataDir: dir, adapters: { polymarket: a }, now, log: () => {} });
  assert.equal(r.dropped, 1, "only the grammar miss counts as dropped; filtered markets aren't counted");
  assert.equal(r.index.counts.open, 1);
  const day = JSON.parse(await readFile(join(dir, "days/2026-10-06.json"), "utf8")) as Day & { dropped?: unknown };
  assert.deepEqual(day.asked.map((m) => m.id), ["pm:12"]);
  assert.equal(day.dropped, undefined, "the questions themselves are not stored");
  assert.equal(day.runs[0].dropped, 1);
});

test("a recorded market that now fails a filter is let go, not resolved or voided", async () => {
  const dir = await mkdtemp(join(tmpdir(), "will-did-"));
  const q = "Will the Jets beat the Bills?";
  await run({ dataDir: dir, adapters: { polymarket: fake([f("pm:20", q, "2026-10-12T00:00:00Z")], []) }, now: new Date("2026-10-06T14:00:00Z"), log: () => {} });
  // Next hour the listing excludes it as sports; the recheck reveals it settled.
  const later: Adapter = {
    fetchOpen: async () => [],
    fetchClosedSince: async () => [],
    fetchOne: async () => f("pm:20", q, "2026-10-12T00:00:00Z", { sports: true, closed: true, result: "yes", closedAt: "2026-10-06T14:30:00Z" }),
  };
  const r = await run({ dataDir: dir, adapters: { polymarket: later }, now: new Date("2026-10-06T15:00:00Z"), log: () => {} });
  assert.equal(r.index.counts.open, 0);
  assert.equal(r.newlyResolved, 0);
  assert.equal(r.voided, 0);
});

// --- backfill: days reconstructed from source timestamps, witnessed days untouched ---
test("backfill writes sealed, flagged days and leaves witnessed days alone", async () => {
  const dir = await mkdtemp(join(tmpdir(), "will-did-"));
  // a witnessed day first
  const live = fake([f("pm:1", "Will Bitcoin reach $150,000 by December 31?", "2026-12-31T00:00:00Z")], []);
  await run({ dataDir: dir, adapters: { polymarket: live }, now: new Date("2026-10-06T14:00:00Z"), log: () => {} });

  const history: Fetched[] = [
    f("pm:100", "Will the Mets make the playoffs?", "2026-10-01T00:00:00Z", { closed: true, result: "no", created: "2026-03-02T15:00:00Z", closedAt: "2026-10-01T03:00:00Z" }),
    f("pm:101", "Will the Fed cut rates in September?", "2026-09-17T18:00:00Z", { closed: true, result: "yes", created: "2026-06-10T12:00:00Z", closedAt: "2026-09-17T18:05:00Z" }),
    f("pm:102", "Will it rain in NYC on Oct 6?", "2026-10-06T23:59:00Z", { closed: true, result: "yes", created: "2026-10-05T12:00:00Z", closedAt: "2026-10-06T23:59:00Z" }), // lands on the witnessed day
  ];
  const kalshiHistory: Fetched[] = [
    { ...f("ks:KXHIGHNY-26SEP17-T70", "Will the high temperature in NYC be above 70° on Sep 17?", "2026-09-17T23:00:00Z",
        { closed: true, result: "yes", created: "2026-09-15T13:00:00Z", closedAt: "2026-09-17T23:00:00Z" }), source: "kalshi" },
  ];
  const rep = await backfill({
    dataDir: dir,
    since: new Date("2026-01-01"),
    sources: {
      polymarket: async () => history,
      kalshi: async () => kalshiHistory,
    },
    log: () => {},
  });
  assert.deepEqual(rep.failed, []);
  assert.deepEqual(rep.skippedWitnessed, ["2026-10-06"]);
  const days = rep.index.days.map((d) => [d.day, d.asked, d.answered, d.sealed]);
  assert.deepEqual(days, [
    ["2026-10-06", 1, 0, false], // witnessed, untouched
    ["2026-10-05", 1, 0, true], // pm:102 asked
    ["2026-09-30", 0, 1, true], // pm:100 closed 03:00Z = 11pm Sep 30 New York
    ["2026-09-17", 0, 2, true], // pm:101 and the Kalshi market
    ["2026-09-15", 1, 0, true], // Kalshi market asked (open_time)
    ["2026-06-10", 1, 0, true],
    ["2026-03-02", 1, 0, true],
  ]);
  const sep17 = JSON.parse(await readFile(join(dir, "days/2026-09-17.json"), "utf8")) as Day;
  assert.equal(sep17.backfilled, true);
  assert.deepEqual(sep17.answered.map((m) => m.line).sort(), [
    "The Fed did cut rates in September.",
    "The high temperature in NYC did end up above seventy degrees on September seventeenth.",
  ]);
  assert.equal(rep.index.counts.resolved, 4, "answered markets also join the resolved shards");

  // A failing source loses only its own history.
  const rep2 = await backfill({
    dataDir: dir,
    since: new Date("2026-01-01"),
    sources: { polymarket: async () => history, kalshi: async () => { throw new Error("kalshi down"); } },
    log: () => {},
  });
  assert.deepEqual(rep2.skippedWitnessed, ["2026-10-06"], "backfilled days are merged into on a re-run; only the witnessed one is skipped");
  assert.deepEqual(rep2.failed, ["kalshi"]);
  assert.equal(rep2.index.counts.resolved, 4, "idempotent: nothing duplicated, nothing lost");
});

test("backfill walks bounded windows, ending in an open-ended one for early resolutions", async () => {
  const dir = await mkdtemp(join(tmpdir(), "will-did-"));
  const calls: Array<[string, string | null]> = [];
  const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  const rep = await backfill({
    dataDir: dir,
    since: new Date("2026-10-01T00:00:00Z"),
    now: new Date("2026-10-10T12:00:00Z"),
    windowDays: 4,
    sources: {
      polymarket: async (from, to) => {
        calls.push([day(from), to === undefined ? null : day(to)]);
        if (to !== undefined) return [];
        return [
          // resolved early, far-future end date: only the open-ended window can see it
          f("pm:200", "Will Bitcoin reach $150,000 by December 31?", "2027-12-31T00:00:00Z", { closed: true, result: "yes", created: "2026-09-01T12:00:00Z", closedAt: "2026-10-03T15:00:00Z" }),
          // resolved early, but before the range: left out
          f("pm:201", "Will Ethereum reach $10,000 by December 31?", "2027-12-31T00:00:00Z", { closed: true, result: "no", created: "2026-01-01T12:00:00Z", closedAt: "2026-06-01T15:00:00Z" }),
        ];
      },
    },
    log: () => {},
  });
  assert.deepEqual(calls, [
    ["2026-10-01", "2026-10-05"],
    ["2026-10-05", "2026-10-09"],
    ["2026-10-09", null],
  ]);
  assert.equal(rep.answered, 1);
  assert.deepEqual(rep.index.days.map((d) => d.day), ["2026-10-03"], "the Sep 1 asked day is before since: a fragment, not written");
});

test("backfill only writes days that fall wholly after since", async () => {
  const dir = await mkdtemp(join(tmpdir(), "will-did-"));
  const rows: Fetched[] = [
    // settled the evening of Oct 5 in New York, after since (00:00 UTC Oct 6): Oct 5 is only partly covered
    f("pm:40", "Will the Fed cut rates in October?", "2026-10-05T23:00:00Z", { closed: true, result: "no", created: "2026-10-01T12:00:00Z", closedAt: "2026-10-06T01:00:00Z" }),
    f("pm:41", "Will Bitcoin reach $150,000 by December 31?", "2026-10-07T00:00:00Z", { closed: true, result: "no", created: "2026-10-06T15:00:00Z", closedAt: "2026-10-07T15:00:00Z" }),
  ];
  const rep = await backfill({
    dataDir: dir,
    since: new Date("2026-10-06T00:00:00Z"),
    now: new Date("2026-10-08T12:00:00Z"),
    sources: { polymarket: async (_from, to) => (to === undefined ? rows : []) },
    log: () => {},
  });
  assert.deepEqual(rep.index.days.map((d) => [d.day, d.asked, d.answered]), [
    ["2026-10-07", 0, 1],
    ["2026-10-06", 1, 0],
  ]);
  assert.equal(rep.index.counts.resolved, 2, "both markets still join the resolved archive");
});

test("a market is asked on the day it was posed, not the day it was first fetched", async () => {
  const dir = await mkdtemp(join(tmpdir(), "will-did-"));
  const a = fake(
    [
      f("pm:30", "Will Bitcoin reach $150,000 by December 31?", "2026-12-31T00:00:00Z", { created: "2026-08-01T12:00:00Z" }),
      f("pm:31", "Will the Fed cut rates in December?", "2026-12-10T00:00:00Z", { created: "2026-10-06T13:00:00Z" }),
      f("pm:32", "Will it rain in Miami on October 7?", "2026-10-07T23:00:00Z"), // no creation time: asked now
    ],
    [],
  );
  const r = await run({ dataDir: dir, adapters: { polymarket: a }, now: new Date("2026-10-06T14:00:00Z"), log: () => {} });
  assert.equal(r.index.counts.open, 3, "every open market is on the timeline");
  const day = JSON.parse(await readFile(join(dir, "days/2026-10-06.json"), "utf8")) as Day;
  assert.deepEqual(day.asked.map((m) => m.id).sort(), ["pm:31", "pm:32"], "the August market isn't today's");
  assert.equal(day.asked.find((m) => m.id === "pm:31")?.seen, "2026-10-06T13:00:00Z", "seen is when it was posed");
});
