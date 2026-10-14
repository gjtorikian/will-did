import { addVerbs } from "./rewrite.js";
import { readJSON } from "../capture/store.js";

/**
 * overrides.json (repo root, committed; OVERRIDES points elsewhere) — the
 * editor's errata, applied after the rules. It isn't under data/: that's
 * working state in the Actions cache, and a fix there would never be committed.
 *
 *   {
 *     "verbs": ["ipo", "headline", "dethrone"],
 *     "lines": { "pm:12345": "Did OpenAI IPO before 2027? No." },
 *     "patterns": [{ "match": "^Will (.+) IPO (.+)\\?$", "replace": "Will $1 go public $2?" }]
 *   }
 *
 * `verbs` extends the verb list. `patterns` rewrite the *question* before the
 * grammar sees it (regex, case-insensitive). `lines` pin the final text for one
 * market by id. Everything here survives rerenders; nothing here is required.
 */
export interface Overrides {
  verbs?: string[];
  lines?: Record<string, string>;
  patterns?: Array<{ match: string; replace: string }>;
}

export async function loadOverrides(file: string = process.env.OVERRIDES ?? "overrides.json"): Promise<Overrides> {
  const o = (await readJSON<Overrides>(file)) ?? {};
  if (o.verbs?.length) addVerbs(o.verbs);
  return o;
}

export function applyPatterns(question: string, o: Overrides): string {
  let q = question;
  o.patterns?.map((p) => {
    q = q.replace(new RegExp(p.match, "i"), p.replace);
  });
  return q;
}

export const pinned = (id: string, o: Overrides): string | undefined => o.lines?.[id];
