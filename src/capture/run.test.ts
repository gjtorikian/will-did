import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run, type Adapter } from "./run.js";
import type { Day, Fetched, Index, Market } from "../types.js";

const f = (id: string, question: string, closes: string, extra: Partial<Fetched> = {}): Fetched => ({
  id,
  source: id.startsWith("pm:") ? "polymarket" : "kalshi",
  question,
  closes,
  url: `https://example.test/${id}`,
  volume: 100,
  created: null,
  closed: false,
  result: null,
  closedAt: null,
  ...extra,
});

function fake(open: Fetched[], closed: Fetched[], one: Record<string, Fetched | null> = {}): Adapter {
  return {
    fetchOpen: async () => open,
    fetchClosedSince: async () => closed,
    fetchOne: async (id) => (id in one ? one[id] : null),
  };
}

const failing: Adapter = {
  fetchOpen: async () => {
    throw new Error("kalshi down");
  },
  fetchClosedSince: async () => {
    throw new Error("kalshi down");
  },
  fetchOne: async () => null,
};

async function readShard(dir: string, index: Index, kind: "open" | "resolved", month: string): Promise<Market[]> {
  const shard = index[kind].find((s) => s.month === month);
  assert.ok(shard, `${kind} shard ${month} exists`);
  return JSON.parse(await readFile(join(dir, shard.file), "utf8")) as Market[];
}

test("two cycles: open → resolved, voided, carried forward, seeded", async () => {
  const dir = await mkdtemp(join(tmpdir(), "will-did-"));
  const h1 = new Date("2026-10-06T14:00:00Z");
  const h2 = new Date("2026-10-06T15:00:00Z");

  // Hour 1: three Polymarket markets open, one Kalshi; one old Polymarket market already closed (seed).
  const pm1 = fake(
    [
      f("pm:1", "Will Bitcoin reach $150,000 by December 31?", "2026-12-31T12:00:00Z"),
      f("pm:2", "Will the Fed cut rates in October?", "2026-10-29T18:00:00Z"),
      f("pm:3", "Will there be a government shutdown on November 1?", "2026-11-01T05:00:00Z"),
      f("pm:4", "Bitcoin Up or Down - October 6, 3PM ET", "2026-10-06T19:15:00Z"),
    ],
    [f("pm:0", "Will the Mets make the playoffs?", "2026-10-01T00:00:00Z", { closed: true, result: "no", closedAt: "2026-10-01T03:00:00Z" })],
  );
  const ks1 = fake([f("ks:A", "Will the high in NYC exceed 70° on Oct 7?", "2026-10-07T23:00:00Z")], []);

  const r1 = await run({ dataDir: dir, adapters: { polymarket: pm1, kalshi: ks1 }, now: h1, log: () => {} });
  assert.equal(r1.index.counts.open, 5);
  assert.equal(r1.index.counts.resolved, 1, "seeded from the closed listing");
  assert.deepEqual(r1.index.open.map((s) => s.month), ["2026-12", "2026-11", "2026-10"], "far future first");
  const seeded = await readShard(dir, r1.index, "resolved", "2026-10");
  assert.equal(seeded[0].line, "The Mets did not make the playoffs.");

  // Hour 2: pm:2 resolved yes (in closed listing), pm:4 resolved no (only via recheck),
  // pm:3 vanished entirely (voided), pm:1 still open, pm:5 new. Kalshi is down.
  const pm2 = fake(
    [
      f("pm:1", "Will Bitcoin reach $150,000 by December 31?", "2026-12-31T12:00:00Z"),
      f("pm:5", "Will Kalshi be banned in Nevada?", "2027-01-15T00:00:00Z"),
    ],
    [f("pm:2", "Will the Fed cut rates in October?", "2026-10-29T18:00:00Z", { closed: true, result: "yes", closedAt: "2026-10-06T14:40:00Z" })],
    {
      "pm:4": f("pm:4", "Bitcoin Up or Down - October 6, 3PM ET", "2026-10-06T19:15:00Z", { closed: true, result: "no" }),
      "pm:3": null,
    },
  );

  const r2 = await run({ dataDir: dir, adapters: { polymarket: pm2, kalshi: failing }, now: h2, log: () => {} });
  assert.deepEqual(r2.failed, ["kalshi"]);
  assert.equal(r2.newlyResolved, 2);
  assert.equal(r2.voided, 1);
  assert.equal(r2.index.counts.open, 3, "pm:1, pm:5, and ks:A carried forward through the outage");
  assert.equal(r2.index.counts.resolved, 3);

  const octOpen = await readShard(dir, r2.index, "open", "2026-10");
  assert.deepEqual(octOpen.map((m) => m.id), ["ks:A"]);

  const octResolved = await readShard(dir, r2.index, "resolved", "2026-10");
  assert.deepEqual(
    octResolved.map((m) => [m.id, m.line, m.resolvedAt]),
    [
      ["pm:4", "Bitcoin did go down, October sixth, three in the afternoon, Eastern time.", h2.toISOString()],
      ["pm:2", "The Fed did cut rates in October.", "2026-10-06T14:40:00Z"],
      ["pm:0", "The Mets did not make the playoffs.", "2026-10-01T03:00:00Z"],
    ],
    "newest first; closedAt preferred over run time",
  );

  // Hour 3: nothing changed, nothing re-added. Idempotent.
  const r3 = await run({ dataDir: dir, adapters: { polymarket: pm2, kalshi: failing }, now: h2, log: () => {} });
  assert.equal(r3.newlyResolved, 0, "pm:2 is in the closed listing but already recorded");
  assert.equal(r3.index.counts.resolved, 3, "de-duped on write");

  // Days: h1/h2 are both Oct 6 in New York. One day file, growing, unsealed.
  assert.deepEqual(r3.index.days.map((d) => [d.day, d.asked, d.answered, d.sealed]), [["2026-10-06", 6, 3, false]],
    "5 asked at h1 + pm:5 at h2; 1 seeded + 2 resolved");
  const oct6 = JSON.parse(await readFile(join(dir, "days/2026-10-06.json"), "utf8")) as Day;
  assert.equal(oct6.tz, "America/New_York");
  assert.ok(oct6.asked.every((m) => m.line.startsWith("Will ")), "asked lines are Wills");
  assert.ok(oct6.answered.every((m) => / did( not)? /.test(m.line)), "answered lines are Dids");

  // Next run is 01:00 New York time on Oct 7 (05:00Z): new day file, Oct 6 sealed and untouched.
  const h3 = new Date("2026-10-07T05:00:00Z");
  const pm3 = fake([...(await pm2.fetchOpen()), f("pm:6", "Will Banksy create a new mural by December 31?", "2026-12-31T12:00:00Z")], []);
  const r4 = await run({ dataDir: dir, adapters: { polymarket: pm3 }, now: h3, log: () => {} });
  assert.deepEqual(r4.index.days.map((d) => [d.day, d.asked, d.answered, d.sealed]), [
    ["2026-10-07", 1, 0, false],
    ["2026-10-06", 6, 3, true],
  ]);
  const oct6b = JSON.parse(await readFile(join(dir, "days/2026-10-06.json"), "utf8")) as Day;
  assert.equal(oct6b.sealed, true);
  assert.deepEqual(oct6b.asked.map((m) => m.id), oct6.asked.map((m) => m.id), "sealed day content unchanged");
});

test("the day boundary is drawn in the configured zone", async () => {
  const dir = await mkdtemp(join(tmpdir(), "will-did-"));
  // 03:30Z on Oct 7 is still Oct 6 in New York, but Oct 7 in UTC.
  const at = new Date("2026-10-07T03:30:00Z");
  const a = fake([f("pm:1", "Will it rain?", "2026-10-08T00:00:00Z")], []);
  const ny = await run({ dataDir: dir, adapters: { polymarket: a }, now: at, log: () => {} });
  assert.equal(ny.day.day, "2026-10-06");
  const dir2 = await mkdtemp(join(tmpdir(), "will-did-"));
  const utc = await run({ dataDir: dir2, adapters: { polymarket: a }, now: at, tz: "UTC", log: () => {} });
  assert.equal(utc.day.day, "2026-10-07");
});

test("the first run after midnight finishes yesterday at midnight exactly, then seals it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "will-did-"));
  const fed = f("pm:1", "Will the Fed cut rates in December?", "2026-12-10T00:00:00Z");
  // 23:17 New York on Oct 6
  await run({ dataDir: dir, adapters: { polymarket: fake([fed], []) }, now: new Date("2026-10-07T03:17:00Z"), log: () => {} });
  // 00:17 New York on Oct 7: since the last run, one market was posed at 23:40
  // and one settled at 23:50 (both Oct 6), and one settled at 00:05 (Oct 7)
  const late = f("pm:2", "Will Bitcoin reach $150,000 by December 31?", "2026-12-31T00:00:00Z", { created: "2026-10-07T03:40:00Z" });
  const settled = (id: string, at: string) =>
    f(id, `Will market ${id} happen?`, at, { closed: true, result: "yes", closedAt: at, created: "2026-10-06T12:00:00Z" });
  const r = await run({
    dataDir: dir,
    adapters: { polymarket: fake([fed, late], [settled("pm:3", "2026-10-07T03:50:00Z"), settled("pm:4", "2026-10-07T04:05:00Z")]) },
    now: new Date("2026-10-07T04:17:00Z"),
    log: () => {},
  });
  const day = async (d: string) => JSON.parse(await readFile(join(dir, `days/${d}.json`), "utf8"));
  const oct6 = await day("2026-10-06");
  const oct7 = await day("2026-10-07");
  assert.equal(oct6.sealed, true, "sealed after its last captures were filed");
  assert.deepEqual(oct6.asked.map((m: { id: string }) => m.id).sort(), ["pm:1", "pm:2"], "posed at 23:40, filed under Oct 6");
  assert.deepEqual(oct6.answered.map((m: { id: string }) => m.id), ["pm:3"], "settled at 23:50, filed under Oct 6");
  assert.deepEqual(oct7.answered.map((m: { id: string }) => m.id), ["pm:4"], "settled at 00:05, filed under Oct 7");
  assert.equal(oct7.runs.length, 1, "the run's heartbeat belongs to the day it ran");
  assert.equal(r.day.day, "2026-10-07");
});
