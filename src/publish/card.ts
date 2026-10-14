/**
 * Preview images (1200×630, the size link previews expect). The picture is a
 * template, site/templates/card.hbs; this works out how the sentence breaks
 * and how big it can be set, and turns the finished SVG into a PNG with resvg.
 * Nothing here runs in the browser.
 *
 * The card is set in Libre Baskerville (site/fonts, SIL Open Font License).
 */
import { join } from "node:path";
import { Resvg } from "@resvg/resvg-js";

const MEASURE = 1200 - 2 * 72; // the card's width inside its margins
const TOP = 250; // baseline of the sentence's first line
const MAX_LINES = 5;

/** Break text into lines of at most `max` characters, on spaces. The font's
 *  average glyph is about half its size, which is close enough to set a measure. */
function wrap(text: string, max: number): string[] {
  const lines: string[] = [];
  let cur = "";
  for (const word of text.split(/\s+/)) {
    if (cur && cur.length + 1 + word.length > max) {
      lines.push(cur);
      cur = word;
    } else cur = cur ? `${cur} ${word}` : word;
  }
  if (cur) lines.push(cur);
  return lines;
}

/** The sentence's size and lines: as large as it can be while fitting in five lines. */
export function cardLayout(sentence: string): { size: number; lines: Array<{ y: number; text: string }> } {
  let size = 50;
  let lines = wrap(sentence, Math.floor(MEASURE / (size * 0.52)));
  while (lines.length > MAX_LINES && size > 28) {
    size -= 4;
    lines = wrap(sentence, Math.floor(MEASURE / (size * 0.52)));
  }
  if (lines.length > MAX_LINES) lines = [...lines.slice(0, MAX_LINES - 1), `${lines[MAX_LINES - 1]}…`];
  const lead = Math.round(size * 1.4);
  return { size, lines: lines.map((text, i) => ({ y: TOP + i * lead, text })) };
}

export function png(svg: string, fontsDir: string): Buffer {
  const resvg = new Resvg(svg, {
    font: {
      fontFiles: [join(fontsDir, "LibreBaskerville.ttf"), join(fontsDir, "LibreBaskerville-Italic.ttf")],
      loadSystemFonts: false,
      defaultFontFamily: "Libre Baskerville",
    },
  });
  return resvg.render().asPng();
}
