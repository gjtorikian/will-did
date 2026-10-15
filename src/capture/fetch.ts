import * as polymarket from "../sources/polymarket.js";
import * as kalshi from "../sources/kalshi.js";
import { run, type Adapter } from "./run.js";
import type { Source } from "../types.js";

const ALL: Record<Source, Adapter> = { polymarket, kalshi };
const wanted = (process.env.SOURCES ?? "polymarket").split(",").map((s) => s.trim()) as Source[];
const adapters = Object.fromEntries(wanted.filter((s) => s in ALL).map((s) => [s, ALL[s]])) as Partial<
  Record<Source, Adapter>
>;

run({
  dataDir: process.env.DATA_DIR ?? "data",
  adapters,
  lookbackHours: Number(process.env.LOOKBACK_HOURS ?? 48),
  minVolume: Number(process.env.MIN_VOLUME ?? 0),
  exclude: process.env.EXCLUDE ? new RegExp(process.env.EXCLUDE, "i") : null,
  strict: process.env.STRICT !== "0",
  tz: process.env.DAY_TZ ?? "America/New_York",
  form: (process.env.FORM as "declarative" | "question" | undefined) ?? "declarative",
  answer: (process.env.ANSWER as "yesno" | "did" | undefined) ?? "yesno",
})
  .then((report) => {
    for (const [name, src] of Object.entries({ polymarket, kalshi }) as Array<[Source, typeof polymarket | typeof kalshi]>) {
      if (!adapters[name]) continue;
      const s = src.pace.stats;
      console.log(`${name}: ${s.requests} requests · ${s.rateLimited} rate-limited · gap peaked at ${s.maxGap} ms, ended at ${src.pace.gap()} ms`);
    }
    // Every source failed: exit non-zero so the workflow stops before render
    // and deploy, and the live site keeps its last good version rather than
    // publishing an empty today. One source of several failing carries on.
    if (report.failed.length && report.failed.length === Object.keys(adapters).length) {
      console.error(`every source failed (${report.failed.join(", ")}); not publishing this run`);
      process.exit(1);
    }
  })
  .catch((err) => {
  console.error(err);
  process.exit(1);
});
