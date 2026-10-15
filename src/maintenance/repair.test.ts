import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repairArchive, repairPoem } from "./repair.js";
import type { Poem } from "../publish/poem.js";
import type { Day, Market } from "../types.js";
import type { Style } from "../capture/run.js";

const style: Style = { form: "declarative", answer: "yesno", overrides: {} };
// An archive file from before families were counted: its lines have no `family`, which repair fills in.
const poem = {
  day: "2026-10-06", tz: "America/New_York", asked: { shown: 2, total: 100 }, answered: { shown: 1, total: 200 }, wagered: 12345,
  lines: [
    { id: "a", status: "open", asked: true, question: "Will the Fed cut rates?", line: "Will the Fed cut rates?", at: "2026-10-06T12:00:00Z", url: "https://example.test/a" },
    { id: "b", status: "open", asked: true, question: "Will the rain stop?", line: "Will the rain stop?", at: "2026-10-06T13:00:00Z", url: "https://example.test/b" },
    { id: "c", status: "no", asked: false, question: "Will the earnings call not air?", line: "The earnings did not call not air.", at: "2026-10-06T14:00:00Z", url: "https://example.test/c" },
  ],
} as Poem;
const answer = (id: string, at: string): Market => ({
  id, source: "polymarket", status: "yes", question: "", line: "", url: "", seen: "2026-10-06T12:00:00Z", resolvedAt: at, closes: null,
});
const day: Day = {
  day: poem.day, tz: poem.tz, sealed: true, asked: [], voided: [], runs: [],
  answered: [answer("a", "2026-10-06T16:00:00Z"), answer("b", "2026-10-07T16:00:00Z"), answer("unselected", "2026-10-06T16:00:00Z")],
};

test("archive repair preserves selection and provenance, restores only same-day answers, and is idempotent", () => {
  const repaired = repairPoem(poem, day, style);
  assert.deepEqual(repaired.lines.map((l) => l.id), ["b", "c", "a"], "the restored answer moves to its settlement time");
  assert.equal(repaired.lines[0].status, "open", "a later outcome cannot rewrite an earlier day");
  assert.equal(repaired.lines[1].line, "The earnings call did air.");
  assert.equal(repaired.lines[2].line, "The Fed did cut rates.");
  assert.deepEqual(repaired.asked, { shown: 1, total: 100 });
  assert.deepEqual(repaired.answered, { shown: 2, total: 200 });
  assert.equal(repaired.wagered, poem.wagered);
  for (const line of repaired.lines) {
    const original = poem.lines.find((l) => l.id === line.id)!;
    assert.equal(line.question, original.question);
    assert.equal(line.url, original.url);
  }
  assert.deepEqual(repairPoem(repaired, day, style), repaired);
  assert.equal(poem.lines[0].status, "open", "the original object is untouched");
  assert.equal(repairPoem(poem, null, style).lines[0].status, "open", "without retained evidence only grammar is corrected");
});

test("archive repair dry run leaves files intact and a second apply is a no-op", async () => {
  const dir = await mkdtemp(join(tmpdir(), "will-did-repair-"));
  const archive = join(dir, "archive");
  await mkdir(archive);
  await mkdir(join(dir, "days"));
  const path = join(archive, `${poem.day}.json`);
  await writeFile(path, JSON.stringify(poem));
  await writeFile(join(dir, "days", `${poem.day}.json`), JSON.stringify(day));
  // three lines change: two grammar corrections (one restoring an answer), and
  // every line gains its family, which this poem was archived without
  assert.deepEqual(await repairArchive(dir, archive, true), { days: 1, changed: 3, restored: 1, dropped: 0, thinned: 0 });
  assert.equal(await readFile(path, "utf8"), JSON.stringify(poem));
  assert.deepEqual(await repairArchive(dir, archive), { days: 1, changed: 3, restored: 1, dropped: 0, thinned: 0 });
  assert.deepEqual(await repairArchive(dir, archive), { days: 0, changed: 0, restored: 0, dropped: 0, thinned: 0 });
});

test("archive repair drops a line from before the day", () => {
  // A ladder rung Polymarket closed on September 28 that turned up, and was
  // filed on October 6, once its scheduled end passed: before the store kept
  // settlements from sealed days off the page.
  const rung = {
    id: "d", status: "no", asked: false, question: "Will the next model be released on October 6?",
    line: "The next model did not get released on October sixth.", at: "2026-09-28T20:08:17Z", url: "https://example.test/d",
    family: { size: 1, volume: 10 },
  };
  const repaired = repairPoem({ ...poem, lines: [...poem.lines, rung] } as Poem, null, style);
  assert.deepEqual(repaired.lines.map((l) => l.id), ["a", "b", "c"]);
  assert.deepEqual(repaired.answered, { shown: 1, total: 200 }, "the total is the day's record and stays");
});
