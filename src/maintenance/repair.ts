/** Explicit archive correction, never part of an ordinary render.
 * Keep the selected IDs, raw questions, source links, totals and volume.
 * Repair grammar and restore an answer only from that same day's record, and
 * fill in each line's family (size and volume) from that record when the line
 * was archived before families were counted. Drop lines from before the day:
 * settlements from days already sealed, which a fetch filed on today before it
 * learned to leave them off (capture/store.ts). Then thin the poem again under
 * the current grouping rules: lines that have since become one family keep
 * one, with their families added together.
 *
 * npm run repair-archive -- --dry
 * npm run repair-archive
 */
import { readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadOverrides } from "../text/overrides.js";
import { openLine, resolvedLine, type Style } from "../capture/run.js";
import { dayOf, readJSON } from "../capture/store.js";
import { familiesOf, thin, type Poem, type PoemLine } from "../publish/poem.js";
import type { Day } from "../types.js";

/** A line whose moment fell before the poem's day: a settlement from a day
 *  already sealed, filed on this day before the store kept those off it. */
export const earlier = (poem: Poem, l: PoemLine): boolean =>
  Number.isFinite(Date.parse(l.at)) && dayOf(new Date(l.at), poem.tz) < poem.day;

export function repairPoem(poem: Poem, day: Day | null, style: Style): Poem {
  const answers = new Map((day?.day === poem.day ? day.answered : []).map((m) => [m.id, m]));
  const fams = day?.day === poem.day ? familiesOf(day).stats : new Map();
  const lines = poem.lines.filter((l) => !earlier(poem, l)).map((original) => {
    let line = { ...original };
    if (!line.family && fams.has(line.id)) line.family = fams.get(line.id);
    const answer = answers.get(line.id);
    if (line.asked && answer && (answer.status === "yes" || answer.status === "no") && answer.resolvedAt
      && Number.isFinite(Date.parse(answer.resolvedAt)) && dayOf(new Date(answer.resolvedAt), poem.tz) === poem.day) {
      line = { ...line, status: answer.status, asked: false, at: answer.resolvedAt };
    }
    if (line.status === "open") line.line = openLine(line.id, line.question, style);
    else if (line.status === "yes" || line.status === "no") line.line = resolvedLine(line.id, line.question, line.status, style);
    return line;
  }).sort((a, b) => a.at.localeCompare(b.at));
  return thin({ ...poem, lines });
}

export async function repairArchive(dataDir: string, archiveDir: string, dry = false) {
  const style: Style = { form: "declarative", answer: "yesno", overrides: await loadOverrides() };
  const report = { days: 0, changed: 0, restored: 0, dropped: 0, thinned: 0 };
  for (const file of (await readdir(archiveDir)).sort()) {
    if (!/^\d{4}-\d{2}-\d{2}\.json$/.test(file)) continue;
    const path = join(archiveDir, file);
    const poem = (await readJSON<Poem>(path))!;
    const repaired = repairPoem(poem, await readJSON<Day>(join(dataDir, "days", file)), style);
    const before = new Map(poem.lines.map((l) => [l.id, l]));
    const changed = repaired.lines.filter((l) => JSON.stringify(l) !== JSON.stringify(before.get(l.id))).length;
    const dropped = poem.lines.filter((l) => earlier(poem, l)).length;
    const thinned = poem.lines.length - dropped - repaired.lines.length;
    if (!changed && !dropped && !thinned) continue;
    report.days++;
    report.changed += changed;
    report.restored += repaired.lines.filter((l) => !l.asked && before.get(l.id)?.asked).length;
    report.dropped += dropped;
    report.thinned += thinned;
    if (!dry) await writeFile(path, JSON.stringify(repaired));
  }
  return report;
}

if (process.argv[1]?.endsWith("repair.js")) {
  const dry = process.argv.includes("--dry");
  repairArchive(process.env.DATA_DIR ?? "data", process.env.ARCHIVE_DIR ?? "archive", dry)
    .then((r) => console.log(`${r.days} days · ${r.changed} corrected lines · ${r.restored} restored answers · ${r.dropped} lines from before their day · ${r.thinned} thinned lines${dry ? " (dry run)" : ""}`))
    .catch((err) => { console.error(err); process.exitCode = 1; });
}
