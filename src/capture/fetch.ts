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
}).catch((err) => {
  console.error(err);
  process.exit(1);
});
