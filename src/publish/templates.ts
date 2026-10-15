/**
 * The Handlebars side of the generator: templates and partials from
 * site/templates, the helpers they use, and site/site.json's text.
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import Handlebars from "handlebars";

/** site/site.json: site-wide text. */
export interface Meta {
  title: string;
  tagline: string;
  intro: string;
  card: { line: string; footer: string };
}

export async function loadMeta(siteDir: string): Promise<Meta> {
  return JSON.parse(await readFile(join(siteDir, "site.json"), "utf8")) as Meta;
}

export type Templates = Awaited<ReturnType<typeof templates>>;

/** "did" / "did not" wrapped in `open` and `close`; everything else escaped. */
export function markDid(line: string, open: string, close: string): string {
  const esc = Handlebars.escapeExpression;
  let out = "";
  let last = 0;
  for (const m of line.matchAll(/\bdid(?: not)?\b/gi)) {
    out += `${esc(line.slice(last, m.index))}${open}${esc(m[0])}${close}`;
    last = m.index! + m[0].length;
  }
  return out + esc(line.slice(last));
}

export async function templates(dir: string) {
  const hb = Handlebars.create();
  hb.registerHelper("did", (line: string) => new hb.SafeString(markDid(line, '<span class="did">', "</span>")));
  hb.registerHelper("didSvg", (line: string) => new hb.SafeString(markDid(line, '<tspan font-style="italic">', "</tspan>")));
  hb.registerHelper("capitalize", (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : ""));
  hb.registerHelper("eq", (a: unknown, b: unknown) => a === b);
  try {
    for (const f of await readdir(join(dir, "partials"))) {
      if (f.endsWith(".hbs")) hb.registerPartial(f.slice(0, -4), (await readFile(join(dir, "partials", f), "utf8")).trim());
    }
  } catch {
    /* no partials */
  }
  const load = async (name: string) => hb.compile(await readFile(join(dir, `${name}.hbs`), "utf8"));
  return {
    layout: await load("layout"),
    about: await load("about"),
    day: await load("day"),
    feed: await load("feed"),
    card: await load("card"),
    /** a partial rendered on its own, as plain text: link descriptions, image footers */
    text: (partial: string, ctx: object) => hb.compile(`{{> ${partial}}}`)(ctx).replace(/<[^>]+>/g, "").trim(),
  };
}
