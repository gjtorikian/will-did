import { test } from "node:test";
import assert from "node:assert/strict";
import { compose } from "./poem.js";
import type { Day, Market } from "../types.js";

const m = (id: string, line: string, volume: number, extra: Partial<Market> = {}): Market => ({
  id, source: "polymarket", question: line, line, closes: null, status: "open",
  seen: "2026-10-06T14:00:00Z", url: `https://example.test/${id}`, volume, ...extra,
});

test("each line carries its family: how many markets it stands for, and their volume together", () => {
  const day: Day = {
    day: "2026-10-06", tz: "America/New_York", sealed: true, voided: [], runs: [],
    asked: [
      m("pm:1", "Will Solana dip to ninety-five dollars on October ninth?", 1_000),
      m("pm:2", "Will Solana dip to ninety dollars on October ninth?", 2_500),
      m("pm:3", "Will Solana dip to eighty-five dollars on October ninth?", 500),
      m("pm:4", "Will the Fed cut rates in December?", 40_000),
      { ...m("pm:5", "Will it rain in Miami on October seventh?", 0), source: "kalshi", volume: 9_999 },
    ],
    answered: [],
  };
  const poem = compose(day);
  const solana = poem.lines.find((l) => l.line.startsWith("Will Solana"))!;
  assert.deepEqual(solana.family, { size: 3, volume: 4_000 }, "three markets, one shown; their volume summed");
  assert.deepEqual(poem.lines.find((l) => l.id === "pm:4")!.family, { size: 1, volume: 40_000 });
  assert.deepEqual(poem.lines.find((l) => l.id === "pm:5")!.family, { size: 1, volume: 0 }, "Kalshi counts contracts, not dollars");
});
