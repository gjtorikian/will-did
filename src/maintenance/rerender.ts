/**
 * Re-derive every `line` from its stored `question` using the current grammar
 * and overrides.json. Lines are never load-bearing: the raw question is
 * always kept beside them. This operates on working data only; sealed poems
 * use the explicit repair-archive command.
 * With STRICT (the default), a stored market whose question no longer reads as
 * a Will-sentence under the current rules is removed, as a fetch would drop it.
 *
 *   npm run rerender            # rewrite lines in place, print a miss report
 *   npm run rerender -- --dry   # report only
 */
import { join } from "node:path";
import { readIndex, readJSON, writeIndex, writeJSON } from "../capture/store.js";
import { loadOverrides, pinned } from "../text/overrides.js";
import { openLine, phrase, resolvedLine, type Style } from "../capture/run.js";
import { isFallback, willify } from "../text/rewrite.js";
import type { Day, Index, Market } from "../types.js";

export interface RerenderReport {
  files: number;
  lines: number;
  changed: number;
  removed: number; // markets dropped because they no longer read as Will-sentences
  fallbacks: string[]; // resolved lines the grammar gave up on
}

export async function rerender(dataDir: string, style: Omit<Style, "overrides">, dry = false, strict = true): Promise<RerenderReport> {
  const index = await readIndex(dataDir);
  if (!index) throw new Error(`no index at ${dataDir}`);
  const st: Style = { ...style, overrides: await loadOverrides() };
  const report: RerenderReport = { files: 0, lines: 0, changed: 0, removed: 0, fallbacks: [] };

  const keep = (m: Market): boolean => {
    const ok = !strict || m.status === "void" || pinned(m.id, st.overrides) !== undefined || willify(phrase(m.question, st)) !== null;
    if (!ok) report.removed++;
    return ok;
  };

  const render = (m: Market): Market => {
    const line =
      m.status === "open" ? openLine(m.id, m.question, st)
      : m.status === "void" ? m.line
      : resolvedLine(m.id, m.question, m.status, st);
    report.lines++;
    if (line !== m.line) report.changed++;
    if (m.status !== "open" && m.status !== "void" && isFallback(line)) report.fallbacks.push(line);
    return { ...m, line };
  };

  for (const shard of [...index.open, ...index.resolved]) {
    const path = join(dataDir, shard.file);
    const list = (await readJSON<Market[]>(path)) ?? [];
    const out = list.filter(keep).map(render);
    shard.count = out.length;
    report.files++;
    if (!dry) await writeJSON(path, out);
  }
  for (const ref of index.days) {
    const path = join(dataDir, ref.file);
    const d = await readJSON<Day>(path);
    if (!d) continue;
    d.asked = d.asked.filter(keep).map(render);
    d.answered = d.answered.filter(keep).map(render);
    ref.asked = d.asked.length;
    ref.answered = d.answered.length;
    report.files++;
    if (!dry) await writeJSON(path, d);
  }
  if (!dry && report.removed) {
    index.counts = {
      open: index.open.reduce((n, s) => n + s.count, 0),
      resolved: index.resolved.reduce((n, s) => n + s.count, 0),
    };
    await writeIndex(dataDir, index);
  }
  return report;
}

const isMain = process.argv[1]?.endsWith("rerender.js");
if (isMain) {
  const dry = process.argv.includes("--dry");
  rerender(
    process.env.DATA_DIR ?? "data",
    {
      form: (process.env.FORM as Style["form"] | undefined) ?? "declarative",
      answer: (process.env.ANSWER as Style["answer"] | undefined) ?? "yesno",
    },
    dry,
    process.env.STRICT !== "0",
  )
    .then((r) => {
      console.log(`${r.files} files · ${r.lines} lines · ${r.changed} changed · ${r.removed} removed${dry ? " (dry run)" : ""}`);
      if (r.fallbacks.length) {
        console.log(`\n${r.fallbacks.length} resolved lines the grammar gave up on:`);
        for (const l of r.fallbacks.slice(0, 50)) console.log(`  ${l}`);
      }
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
