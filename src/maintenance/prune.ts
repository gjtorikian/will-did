/**
 * Keep the working state small. Once a sealed day's poem is in the archive,
 * its data has nothing left to do; and settlements older than the window the
 * live job checks for repeats (RESOLVED_MONTHS) only feed the timeline's deep
 * past. Both are deleted. What remains is what the next hourly run needs: the
 * open snapshot, today, and recent settlements.
 *
 *   npm run prune                  # after npm run render
 */
import { access, rm } from "node:fs/promises";
import { join } from "node:path";
import { readIndex, readJSON, writeIndex } from "../capture/store.js";
import type { Day } from "../types.js";

export interface PruneReport {
  days: string[];
  shards: string[];
}

export async function prune(dataDir: string, archiveDir = "archive", resolvedMonths = 3): Promise<PruneReport> {
  const report: PruneReport = { days: [], shards: [] };
  const index = await readIndex(dataDir);
  if (!index) return report;

  const exists = (p: string) => access(p).then(() => true, () => false);
  const days = [];
  for (const ref of index.days ?? []) {
    const d = await readJSON<Day>(join(dataDir, ref.file));
    if (d?.sealed && (await exists(join(archiveDir, `${ref.day}.json`)))) {
      await rm(join(dataDir, ref.file), { force: true });
      report.days.push(ref.day);
    } else days.push(ref);
  }

  // index.resolved is most recent first; "undated" sorts first and is kept
  const keep = index.resolved.filter((s, i) => s.month === "undated" || i < resolvedMonths);
  for (const s of index.resolved.filter((s) => !keep.includes(s))) {
    await rm(join(dataDir, s.file), { force: true });
    report.shards.push(s.month);
  }

  await writeIndex(dataDir, {
    ...index,
    days,
    resolved: keep,
    counts: { ...index.counts, resolved: keep.reduce((n, s) => n + s.count, 0) },
  });
  return report;
}

const isMain = process.argv[1]?.endsWith("prune.js");
if (isMain) {
  prune(process.env.DATA_DIR ?? "data", process.env.ARCHIVE_DIR ?? "archive")
    .then((r) => console.log(`pruned ${r.days.length} archived days, ${r.shards.length} old resolved shards`))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
