import { test } from "node:test";
import assert from "node:assert/strict";
import { family, onePerFamily } from "./similar.js";

test("lines that differ only in their numbers or comparisons share a family", () => {
  const same: Array<[string, string]> = [
    [
      "The gold did close price be above four thousand one hundred thirty-three point nine nine USD/ounce on October fifth, 2026 at eight in the evening, Eastern time.",
      "The gold did close price be above four thousand one hundred thirty-one point nine nine USD/ounce on October fifth, 2026 at eight in the evening, Eastern time.",
    ],
    ["Will the maximum temperature be 72-seventy-three degrees on Oct fifth, 2026?", "Will the maximum temperature be 70-seventy-one degrees on Oct fifth, 2026?"],
    ["Will the maximum temperature be >ninety-two degrees on Oct fifth, 2026?", "Will the maximum temperature be 70-seventy-one degrees on Oct fifth, 2026?"],
    [
      "Will Solana go up, October fifth, ten fifty in the evening-ten fifty-five in the evening, Eastern time?",
      "Will Solana go up, October fifth, eleven in the evening-eleven oh five in the evening, Eastern time?",
    ],
    // fractions prose.ts spells as "and a quarter", "and a half"
    [
      "Will Diesel Price on October twelfth, twenty twenty-six be above six point three zero five dollars?",
      "Will Diesel Price on October twelfth, twenty twenty-six be above six and a quarter dollars?",
    ],
    ["Will average **gas prices** be above four point zero one dollars?", "Will average **gas prices** be above four and a quarter dollars?"],
    // numbers with a unit attached
    ['Will "Whalefall" Opening Weekend Box Office be between 8m and 10m?', 'Will "Whalefall" Opening Weekend Box Office be at least 16m?'],
    // the comparison changes along a ladder too
    ["Will the price of Solana be less than eighty dollars on October eleventh?", "Will the price of Solana be above one hundred thirty dollars on October eleventh?"],
    ["Will the lowest temperature in London be seven degrees or below on October sixth?", "Will the lowest temperature in London be seventeen degrees or higher on October sixth?"],
    ["Will Solana go up, October sixth, at noon, Eastern time?", "Will Solana go up, October sixth, at eight in the evening, Eastern time?"],
  ];
  for (const [a, b] of same) assert.equal(family(a), family(b), `${a}\n${b}`);
});

test("names are masked: the same question about a different place or person", () => {
  assert.equal(
    family("Will the highest temperature in Atlanta be between seventy-two and seventy-three degrees on October eleventh?"),
    family("Will the highest temperature in New York City be twenty-one degrees or higher on October eleventh?"),
  );
  assert.equal(family("Will Solana go up, October fifth?"), family("Will Ethereum go up, October fifth?"));
  assert.equal(family("Bitcoin did go down, October fifth."), family("BNB did go down, October fifth."));
});

test("outcome is a slot: a ladder that settled both ways is one family", () => {
  const pairs: Array<[string, string]> = [
    [
      "Phoenix · Consecutive days with avg temperature did end up above ninety degrees (Week of October fifth): three or more consecutive days.",
      "Dallas/Fort Worth · Consecutive days with avg temperature did not end up above ninety degrees (Week of October fifth): five or more consecutive days.",
    ],
    [
      "Donald Trump did not make between thirty and thirty-nine Truth Social posts on October eleventh, twenty twenty-six.",
      "Donald Trump did make between fifteen and nineteen Truth Social posts on October eleventh, twenty twenty-six.",
    ],
    [
      "More than two million six hundred thousand people did not get screened by the TSA on average this week.",
      "More than two million people did get screened by the TSA on average this week.",
    ],
    ["Did Bitcoin reach ninety thousand dollars? Yes.", "Did Bitcoin reach ninety-five thousand dollars? No."],
  ];
  for (const [a, b] of pairs) assert.equal(family(a), family(b), `${a}\n${b}`);
});

test("a Will line and a Did line are grouped by the question they came from", () => {
  const rows = [
    {
      id: "a",
      question: "Will the highest hourly total system load reported for the ERCOT grid on October 11, 2026 be above 69,000 MW?",
      line: "Will the highest hourly total system load reported for the ERCOT grid on October eleventh, twenty twenty-six be above sixty-nine thousand MW?",
    },
    {
      id: "b",
      question: "Will the highest hourly total system load reported for the ERCOT grid on October 10, 2026 be above 78,000 MW?",
      line: "The highest hourly total system load reported for the ERCOT grid on October tenth, twenty twenty-six did not end up above seventy-eight thousand MW.",
    },
  ];
  assert.equal(onePerFamily(rows).length, 1);
});

test("a sentence that is mostly placeholders doesn't absorb its neighbours", () => {
  const rows = [
    { id: "a", line: 'Will "Whalefall" Opening Weekend Box Office be between eight million and ten million?' },
    { id: "b", line: 'Will "Whalefall" Opening Weekend Box Office be at least sixteen million?' },
    { id: "c", line: "Will Avengers: Secret Wars be delayed?" },
  ];
  assert.equal(onePerFamily(rows).length, 2);
});

test("different sentences stay apart", () => {
  assert.notEqual(family("Will anyone win?"), family("Will someone win?"), "number words only match whole words");
  const rows = [
    { id: "a", line: "Will Trump endorse at least fifty people on Truth Social this week?" },
    { id: "b", line: "Will it rain in Miami on October fifth?" },
    { id: "c", line: "Will the Fed cut rates in December?" },
  ];
  assert.equal(onePerFamily(rows).length, 3);
});

test("a few changed words join a family", () => {
  const rows = [
    { id: "a", line: "Will Jynxzi, Ron or Los be eliminated by a projectile?", status: "open" },
    { id: "b", line: "Will Jynxzi, Ron or Los be eliminated by a cactus?", status: "open" },
    { id: "c", line: "Will Jynxzi, Ron or Los be eliminated by fire?", status: "open" },
    { id: "d", line: "Will Jynxzi, Ron or Los be eliminated by the void?", status: "open" },
    { id: "e", line: "Gold did end up above four thousand dollars.", status: "yes" },
    { id: "f", line: "Gold did not end up above four thousand one hundred dollars.", status: "no" },
  ];
  const kept = onePerFamily(rows);
  assert.equal(kept.filter((r) => r.status === "open").length, 1);
  assert.equal(kept.filter((r) => r.status !== "open").length, 1, "the gold ladder is one family, whichever way each rung went");
});

test("one line per family, stable, in the original order", () => {
  const rows = [
    { id: "a", line: "Will Bitcoin be above ninety thousand on October fifth?" },
    { id: "b", line: "Will Trump say \"Tariff\" this week?" },
    { id: "c", line: "Will Bitcoin be above ninety-one thousand on October fifth?" },
    { id: "d", line: "Will Bitcoin be above ninety-two thousand on October fifth?" },
  ];
  const once = onePerFamily(rows);
  assert.equal(once.length, 2);
  assert.ok(once.some((r) => r.id === "b"));
  assert.deepEqual(onePerFamily([...rows].reverse()).map((r) => r.id).sort(), once.map((r) => r.id).sort(), "the pick doesn't depend on order");
  assert.equal(onePerFamily(rows, (r) => r.id).length, 4, "scope splits families");
});
