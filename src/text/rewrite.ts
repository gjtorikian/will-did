import type { Answer, Form, Result } from "../types.js";

/**
 * Two invariants, so the title is literal:
 *
 *   every open line     starts with "Will"
 *   resolved lines use "did" / "did not", or retain the question with an
 *   explicit market outcome when the sentence cannot be parsed confidently
 *
 * willify() coerces a market question into a Will-sentence, or returns null
 * when it can't (headline-style titles with no verb). The pipeline drops
 * what can't be willified.
 *
 *   Will Bitcoin reach $150,000 by December 31?   (yes) → Bitcoin did reach $150,000 by December 31.
 *                                                  (no)  → Bitcoin did not reach $150,000 by December 31.
 *   Will the Lakers be eliminated in round one?    (yes) → The Lakers did get eliminated in round one.
 *   Will Picasso be #1 in auction turnover?        (no)  → Picasso did not end up #1 in auction turnover.
 *   Will there be a ceasefire by June 30?          (no)  → A ceasefire did not happen by June 30.
 *   Ethereum above $4,000 on October 10?           →  Will Ethereum be above $4,000 on October 10?
 *   AI artwork hits $10M at major auction in 2026? →  Will AI artwork hit $10M at major auction in 2026?
 *   Bitcoin Up or Down - October 6, 3PM ET         →  Will Bitcoin go up, October 6, 3PM ET?
 *                                                  (no)  → Bitcoin did go down, October 6, 3PM ET.
 *   What will Trump say during his rally: Tariff   →  Will Trump say "Tariff" during his rally?
 *   How many claims will there be…: At least 220,000 → Will there be at least 220,000 claims…?
 */

function strip(q: string): string {
  return q.trim().replace(/\s+/g, " ").replace(/\?+$/, "").trim();
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/* ---------- willify ---------- */

/** A question shape willify() knows: the Will-sentence it makes, `null` to
 *  drop the question (it's this shape but can't be phrased), or `undefined`
 *  when the question isn't this shape and the next one should be tried. */
type Shape = (q: string) => string | null | undefined;

const SHAPES: Shape[] = [
  // already a Will-sentence
  (q) => (/^will\b/i.test(q) ? `${cap(q)}?` : undefined),
  // A wh-question isn't a proposition until its answer is put back in; if
  // that can't be done, it's dropped rather than guessed at.
  (q) => (/^(?:what|who|whom|which|how|when|where|why)\b/i.test(q) ? restate(q) : undefined),
  // "Bitcoin Up or Down - October 6, 3PM ET" → "Will Bitcoin go up, October 6, 3PM ET?"
  (q) => {
    const ud = /^(.+?)\s+up or down\b[\s\-–—:,]*(.*)$/i.exec(q);
    return ud ? `Will ${ud[1].trim()} go up${ud[2].trim() ? `, ${ud[2].trim()}` : ""}?` : undefined;
  },
  // "Ethereum above $4,000 on October 10?" → "Will Ethereum be above $4,000 on October 10?"
  (q) => {
    const level = /^(.+?)\s+(above|below|over|under|between|at or above|at or below)\s+(.+)$/i.exec(q);
    if (!level) return undefined;
    const subject = level[1].trim().split(" ");
    const last = uninflect(clean(subject.at(-1)!));
    // "WTI closes above …" already has its verb; inserting "be" would
    // turn that verb into part of the subject.
    if (subject.length > 1 && last && VERBS.has(last)) {
      subject[subject.length - 1] = last;
      return `Will ${subject.join(" ")} ${level[2].toLowerCase()} ${level[3].trim()}?`;
    }
    return `Will ${level[1].trim()} be ${level[2].toLowerCase()} ${level[3].trim()}?`;
  },
  // "Is X …?", "Has X …?", "Does X …?"
  (q) => {
    const aux = /^(is|are|does|do|has|have)\s+(.+)$/i.exec(q);
    if (!aux) return undefined;
    const a = aux[1].toLowerCase();
    const rest = aux[2];
    if (a === "is" || a === "are") return `Will ${rest.replace(/^(.+?)\s(.*)$/, "$1 be $2")}?`;
    if (a === "has" || a === "have") return `Will ${rest.replace(/^(.+?)\s(.*)$/, "$1 have $2")}?`;
    return `Will ${rest}?`;
  },
  // third-person present: "X hits Y" → "Will X hit Y"
  (q) => {
    const tokens = q.split(" ");
    for (let i = 1; i < tokens.length; i++) {
      if (/^["“'‘]/.test(tokens[i])) continue;
      const base = uninflect(clean(tokens[i]));
      if (!base || !VERBS.has(base)) continue;
      if (tokens[i - 1] === "#" || NOT_BEFORE_VERB.has(clean(tokens[i - 1]))) continue; // "# tweets" is a count, not a verb
      const rest = tokens.slice(i + 1).join(" ");
      return `Will ${tokens.slice(0, i).join(" ")} ${base}${rest ? ` ${rest}` : ""}?`;
    }
    return undefined;
  },
];

/** A market question as a Will-sentence, trying each shape in turn; `null`
 *  when no shape fits (headline-style titles with no verb). */
export function willify(question: string): string | null {
  const q = strip(question);
  if (!q) return null;
  for (const shape of SHAPES) {
    const w = shape(q);
    if (w !== undefined) return w;
  }
  return null;
}

/** Kalshi asks some markets as a wh-question with the answer in a subtitle;
 *  the adapter joins the two with ": ", and the last one is the seam. */
function restate(q: string): string | null {
  const seam = q.lastIndexOf(": ");
  if (seam === -1) return null;
  const head = q.slice(0, seam).trim();
  const answer = q.slice(seam + 2).trim().replace(/[.?]+$/, "");
  // "Event does not qualify" is a contract on the event itself happening, not a sentence
  if (!answer || /^event does not qualify$/i.test(answer)) return null;

  // mention markets: What will X say during E: Word / Other word
  const said = /^what will (.+?) (say|post|tweet|mention)\b\s*(.*)$/i.exec(head);
  if (said) {
    const words = answer.split(/\s*\/\s*/).map((w) => `"${w}"`).join(" or ");
    return `Will ${said[1]} ${said[2].toLowerCase()} ${words}${said[3] ? ` ${said[3]}` : ""}?`;
  }

  // counts: How many X will there be in P: At least N
  const many = /^how many (.+?) will there be\b\s*(.*)$/i.exec(head);
  if (many) {
    const when = many[2].replace(/^the (week|month|day|year)\b/i, "in the $1"); // "the week ending…" wants its preposition
    return `Will there be ${answer.charAt(0).toLowerCase()}${answer.slice(1)} ${many[1]}${when ? ` ${when}` : ""}?`;
  }
  return null;
}

/** hits→hit, reaches→reach, flies→fly, says→say, is→be, has→have, does→do */
function uninflect(v: string): string | null {
  if (!v) return null;
  if (v === "is") return "be";
  if (v === "has") return "have";
  if (v === "does") return "do";
  if (/ies$/.test(v)) return `${v.slice(0, -3)}y`;
  if (/(ches|shes|sses|xes|zes|oes)$/.test(v)) return v.slice(0, -2);
  if (/s$/.test(v) && !/ss$/.test(v)) return v.slice(0, -1);
  return null;
}

/* ---------- rewrite ---------- */

/** A declarative clause: "Zelensky still be president on July 1" →
 *  subject "Zelensky", modifiers ["still"], verb "be", rest ["president", …]. */
interface Clause {
  subject: string;
  modifiers: string[]; // adverbs and "not" between subject and verb
  verb: string;
  rest: string[];
}

/** The body with quoted mentions removed, so a negation inside a quote
 *  ("Will Trump say 'no deal'?") isn't read as the sentence's own. */
const unquote = (body: string) => body.replace(/"[^"]*"|“[^”]*”/g, "").replace(/(^|\s)'[^']*'(?=$|[\s,.])/g, "$1");

/** Find the clause, or `null` when its structure is too ambiguous to rewrite
 *  safely (no verb found, stacked negatives, a perfect tense, a second verb). */
function parseClause(body: string, unquoted: string): Clause | null {
  const tokens = body.split(" ");
  const vi = findVerb(tokens);
  if (vi <= 0) return null;
  // adverbs sitting between subject and verb ("Zelensky still be president",
  // "X officially announce Y") move to after "did": "Zelensky did still…"
  let si = vi;
  while (si > 1 && (isAdverb(clean(tokens[si - 1])) || clean(tokens[si - 1]) === "not")) si--;
  const clause: Clause = { subject: tokens.slice(0, si).join(" "), modifiers: tokens.slice(si, vi).map(clean), verb: clean(tokens[vi]), rest: tokens.slice(vi + 1) };
  const negatives = (unquoted.match(/\bnot\b/gi) ?? []).length;
  if (negatives && (negatives !== 1 || !clause.modifiers.includes("not"))) return null;
  if (clause.verb === "have" && clause.rest[0] && isParticiple(clean(clause.rest[0]))) return null;
  // A second finite verb often means the first candidate was a noun, or
  // that this is a compound clause. Leave ambiguous structures intact.
  if (clause.verb !== "be" && clause.rest.some((t) => clean(t) === "be") && !clause.rest.some((t) => /^(?:to|that)$/i.test(t))) return null;
  return clause;
}

/** The clause in the past tense with "did" / "did not". */
function conjugate({ subject, modifiers, verb, rest }: Clause, result: Result): string {
  // "Will X not air?" settled No means it did air
  const negated = modifiers.includes("not");
  const not = (result === "yes") === negated ? " not" : "";
  const adverbs = modifiers.filter((a) => a !== "not");
  const tail = rest.length ? ` ${rest.join(" ")}` : "";
  if (verb === "be" && adverbs.includes("still")) {
    // "Will X still be Y" → "X did (not) remain Y"
    const others = adverbs.filter((a) => a !== "still");
    return cap(`${subject} did${not}${others.length ? ` ${others.join(" ")}` : ""} remain${tail}.`);
  }
  const adv = adverbs.length ? ` ${adverbs.join(" ")}` : "";
  if (verb === "be") {
    // passive ("be said", "be publicly exhibited") → get; predicative ("be #1", "be above $4,000") → end up
    const next = rest.find((t) => !/ly$/i.test(clean(t)));
    const passive = next !== undefined && isParticiple(clean(next));
    return cap(`${subject} did${not}${adv} ${passive ? "get" : "end up"}${tail}.`);
  }
  return cap(`${subject} did${not}${adv} ${verb}${tail}.`);
}

/** A settled market's line. The declarative form ("Bitcoin did not reach…")
 *  when the sentence can be turned safely; otherwise, and always under
 *  form "question", the question form ("Did no episode air? No."). */
export function rewrite(question: string, result: Result, form: Form = "declarative", answer: Answer = "yesno"): string {
  if (form === "question") return rewriteQuestion(question, result, answer);
  const w = willify(question);
  if (!w) return fallback(question, result, answer);
  const body = strip(w).replace(/^will\s+/i, "");

  // Up/Down: No means down, not "did not go up"
  const ud = /up or down/i.test(question) && /^(.+?)\s+go up(.*)$/i.exec(body);
  if (ud) return cap(`${ud[1]} did go ${result === "yes" ? "up" : "down"}${ud[2]}.`);

  // A negative subject or a compound proposition needs more than a tense
  // swap; inventing a double negative ("No episode did not air") is worse.
  const unquoted = unquote(body);
  if (/\b(?:no|neither|nobody|nothing|none|never)\b|\bno longer\b|\bwill\b/i.test(unquoted)) return fallback(question, result, answer);

  // "There be a ceasefire by June" → "A ceasefire did (not) happen by June"
  const there = /^there be (.+)$/i.exec(body);
  if (there) {
    if (/\bnot\b/i.test(unquoted)) return fallback(question, result, answer);
    const [thing, tail] = splitTail(there[1]);
    return cap(`${thing} did${result === "yes" ? "" : " not"} happen${tail ? ` ${tail}` : ""}.`);
  }

  const clause = parseClause(body, unquoted);
  return clause ? conjugate(clause, result) : fallback(question, result, answer);
}

/** When the declarative rewrite can't be trusted (negations like "no X",
 *  "no longer", "there be no"; unknown verbs; compound questions), the
 *  question form takes over: it needs no verb list and keeps the line a
 *  settled answer rather than an open question. */
function fallback(question: string, result: Result, answer: Answer): string {
  return rewriteQuestion(question, result, answer);
}

/**
 * The question form needs almost no parsing. English makes a yes/no question by
 * fronting the auxiliary, so swapping "Will" for "Did" is a one-token change
 * that stays grammatical for every verb but *be* — and *be* is a literal token
 * you can find without a verb list:
 *
 *   Will Bitcoin reach $150,000 by December 31?  → Did Bitcoin reach $150,000 by December 31? Yes.
 *   Will the Lakers be eliminated?                → Were the Lakers eliminated? No.
 *   Will there be a ceasefire by June 30?         → Was there a ceasefire by June 30? No.
 *
 * With answer "did": "… ? Did." / "… ? Did not."
 */
export function rewriteQuestion(question: string, result: Result, answer: Answer = "yesno"): string {
  const w = willify(question);
  const yes = result === "yes";
  const tail = answer === "did" ? (yes ? "Did." : "Did not.") : yes ? "Yes." : "No.";
  if (!w) return `${strip(question)}? ${tail}`;
  // a second "will" in a compound question turns too: "…and will Y lose" → "…and did Y lose"
  const body = strip(w).replace(/^will\s+/i, "").replace(/\b(and|or|but) will\b/gi, "$1 did");
  const tokens = body.split(" ");

  const there = /^there be (.+)$/i.exec(body);
  if (there) return `Was there ${there[1]}? ${tail}`;

  // the perfect: "X have been released" → "Had X been released"
  const hi = tokens.findIndex((t, i) => i > 0 && clean(t) === "have" && /^(been|[a-z]+ed|[a-z]+en)$/i.test(clean(tokens[i + 1] ?? "")));
  if (hi > 0) return `Had ${tokens.slice(0, hi).join(" ")} ${tokens.slice(hi + 1).join(" ")}? ${tail}`;

  const bi = tokens.findIndex((t, i) => i > 0 && clean(t) === "be" && !/^["“'‘]/.test(t));
  if (bi > 0) {
    const subject = tokens.slice(0, bi).join(" ");
    const rest = tokens.slice(bi + 1).join(" ");
    const was = isPlural(subject) ? "Were" : "Was";
    return `${was} ${subject}${rest ? ` ${rest}` : ""}? ${tail}`;
  }
  return `Did ${body}? ${tail}`;
}

function isPlural(subject: string): boolean {
  if (/\b(and|or)\b/i.test(subject)) return true;
  const last = clean(subject.trim().split(" ").pop() ?? "");
  return /s$/.test(last) && !/(ss|'s|'s|us|is|as|os|news|series|means)$/.test(last);
}

/** "a ceasefire by June 30" → ["a ceasefire", "by June 30"]. Deadline words win
 *  over place words, so "a change in leadership by June" splits at "by". */
function splitTail(s: string): [string, string] {
  const tokens = s.split(" ");
  for (const preps of [DEADLINE_PREPS, PLACE_PREPS]) {
    const i = tokens.findIndex((t, k) => k > 0 && preps.has(clean(t)));
    if (i !== -1) return [tokens.slice(0, i).join(" "), tokens.slice(i).join(" ")];
  }
  return [s, ""];
}

const DEADLINE_PREPS = new Set(["by", "before", "after", "until", "within", "during", "this", "next"]);
const PLACE_PREPS = new Set(["on", "in", "at"]);

const ADVERBS = new Set(["still", "ever", "also", "again", "even", "now", "soon", "already", "formally", "officially",
  "publicly", "successfully", "ultimately", "eventually", "finally", "actually", "really"]);
const isAdverb = (w: string) => ADVERBS.has(w) || (/ly$/.test(w) && w.length > 4 && !/(family|rally|ally|supply|apply|reply|italy|fly)$/.test(w));

/* ---------- grammar helpers ---------- */

const NOT_BEFORE_VERB = new Set([
  "the", "a", "an", "this", "that", "these", "those", "its", "his", "her", "their", "our", "my",
  "your", "any", "no", "each", "every", "some", "which", "what", "of", "to", "for", "in", "on", "at",
  "by", "from", "with", "about", "into", "than", "as", "per",
]);

function clean(tok: string): string {
  return tok.replace(/[^a-z''-]/gi, "").toLowerCase();
}

function findVerb(tokens: string[]): number {
  let quoted = false;
  for (let i = 0; i < tokens.length; i++) {
    const raw = tokens[i];
    // A leading apostrophe opens a quote only if one closes later: Tongan
    // names begin with an ʻokina ('Olioni, 'Aisake) and close nothing.
    const startsQuote = /^["“'‘]/.test(raw) && tokens.slice(i).some((t, k) => (k > 0 || t.length > 1) && /["”''][,.:;?]?$/u.test(t));
    const endsQuote = /["”''][,.:;]?$/u.test(raw);
    if (startsQuote || quoted) {
      quoted = !endsQuote;
      continue;
    }
    // Mid-clause, a capitalised word is a name or title, not a verb: "RISE
    // launch…", "Humanity's Last Exam".
    if (/^\p{Lu}/u.test(raw)) continue;
    const v = clean(tokens[i]);
    if (!VERBS.has(v)) continue;
    const prevRaw = i > 0 ? tokens[i - 1] : "";
    const prev = clean(prevRaw);
    // a parenthesised abbreviation, "(AS)", isn't the word "as"
    if (prev && NOT_BEFORE_VERB.has(prev) && !/^\(/.test(prevRaw)) continue;
    // Noun compounds and modifiers: "earnings call", "highest score",
    // "gold close price". A possessive only disqualifies a possible noun:
    // "Trump's run end" versus "Domino's say …".
    if (NOUN_MODIFIERS.has(prev) || (v === "call" && prev === "earnings")) continue;
    if (NOUN_VERBS.has(v) && (/['']s$|s['']$/.test(prevRaw) || NOUN_HEADS.has(clean(tokens[i + 1] ?? "")))) continue;
    return i;
  }
  return -1;
}

const NOUN_MODIFIERS = new Set(["highest", "lowest", "biggest", "smallest", "average", "total", "maximum", "minimum", "longest", "shortest"]);
const NOUN_VERBS = new Set(["run", "release", "call", "score", "change", "close", "post", "return", "control", "ban", "visit", "launch"]);
const NOUN_HEADS = new Set(["price", "prices", "count", "counts", "rate", "rates", "ban", "record", "records"]);

const PARTICIPLES = new Set([
  "been",
  "said", "won", "held", "made", "done", "seen", "given", "taken", "gotten", "chosen", "known", "shown", "thrown",
  "sold", "bought", "brought", "caught", "built", "found", "kept", "left", "lost", "met", "paid", "sent", "spent",
  "struck", "sworn", "torn", "worn", "written", "beaten", "broken", "hit", "set", "put", "cut", "shut", "split",
  "led", "read", "fed", "bred", "hidden", "ridden", "driven", "frozen", "stolen", "forgotten", "overturned", "upheld",
  "withdrawn", "undone", "overtaken", "sunk", "sung", "hung", "stuck", "shot", "lit", "bet", "cast", "spread", "wed",
]);

function isParticiple(w: string): boolean {
  return PARTICIPLES.has(w) || /[a-z]{2,}ed$/.test(w);
}

const IRREGULAR_BASES = [
  "be", "have", "do", "go", "get", "make", "take", "say", "see", "come", "give", "find", "tell", "become", "leave",
  "hold", "keep", "run", "win", "lose", "beat", "meet", "hit", "set", "put", "let", "cut", "shut", "split", "quit",
  "bet", "cost", "read", "lead", "pay", "sell", "buy", "bring", "think", "fight", "seek", "catch", "teach", "break",
  "speak", "choose", "drive", "ride", "rise", "write", "fall", "feel", "send", "spend", "build", "sit", "stand",
  "understand", "withdraw", "draw", "grow", "know", "throw", "fly", "begin", "sing", "sink", "swim", "ring", "drink",
  "strike", "overtake", "undergo", "wear", "steal", "forget", "hang", "hear", "hide", "lend", "mean", "shoot", "sleep",
  "light", "eat", "wed", "occur", "admit", "commit", "refer", "prefer", "control", "cancel", "upset", "forecast",
  "broadcast", "overturn", "step", "drop", "lay", "shed", "stay", "play", "delay",
];

const REGULAR = [
  "reach", "announce", "release", "sign", "pass", "happen", "close", "open", "exceed", "resign", "die",
  "visit", "attend", "launch", "approve", "ban", "raise", "declare", "mention", "tweet", "post", "play",
  "score", "start", "end", "finish", "return", "remain", "stay", "confirm", "deny", "apologize", "surpass",
  "host", "trade", "settle", "debut", "premiere", "air", "appear", "achieve", "acquire", "agree", "allow",
  "arrive", "ask", "attack", "award", "call", "change", "claim", "clear", "complete", "continue", "create",
  "decide", "deliver", "depart", "dissolve", "enact", "enter", "establish", "expire", "extend", "face",
  "file", "fire", "form", "hire", "impose", "include", "increase", "indict", "invade", "join", "kill",
  "land", "list", "lift", "lower", "name", "nominate", "offer", "order", "outperform", "perform", "pick",
  "plan", "publish", "qualify", "receive", "record", "reject", "remove", "repeal", "replace", "report",
  "request", "resume", "retire", "reveal", "rule", "schedule", "secure", "seize", "serve", "ship", "show",
  "stop", "submit", "succeed", "suspend", "test", "top", "trail", "travel", "unveil", "use", "veto", "vote",
  "marry", "pardon", "impeach", "invoke", "default", "surge", "crash", "tap", "enforce", "deploy", "decline",
  "fail", "elect", "legalize", "recognize", "accept", "add", "address", "adopt", "appoint", "back", "block",
  "carry", "clinch", "collapse", "convict", "cover", "cross", "defeat", "delay", "expand", "fine", "finalize",
  "flip", "ground", "halt", "hike", "issue", "limit", "mark", "miss", "move", "notch", "own", "pull", "push",
  "ratify", "reduce", "refuse", "register", "relocate", "renew", "repeat", "resolve", "respond", "retain",
  "revoke", "roll", "sack", "scrap", "seal", "share", "shift", "slash", "sue", "support", "sweep", "switch",
  "testify", "threaten", "tie", "trigger", "triple", "double", "turn", "uphold", "walk", "warn", "wrap",
  "endorse", "concede", "certify", "comply", "exit", "merge", "delist", "sanction", "fill", "mandate", "execute",
  "arrest", "charge", "sentence", "deport", "capture", "occupy", "recapture", "evacuate", "detonate", "intercept",
  "dip", "hover", "touch", "print", "pause", "taper", "gain", "rank", "place", "medal", "advance", "eliminate", "target", "insult", "participate",
  "rush", "kick", "waive", "pitch", "homer", "exhibit", "feature", "exist", "produce", "sell",
  "rain", "snow", "praise", "cease", "try", "freeze", "rename", "transit", "process", "peak",
  "excommunicate", "decrease", "re-enter",
];

const VERBS = new Set<string>([...IRREGULAR_BASES, ...REGULAR]);

/** Extend the verb list at runtime (from overrides.json). */
export function addVerbs(verbs: readonly string[]): void {
  for (const v of verbs) VERBS.add(v.toLowerCase().trim());
}

/** Lines the grammar gave up on contain this marker. Grep for it. */
/** A resolved line the declarative rewrite handed to the question form
 *  ("Did no episode air? No."). Only meaningful under the declarative form,
 *  where these are the exceptions worth reviewing. */
export function isFallback(line: string): boolean {
  return /^(?:Did|Was|Were|Had)\b.*\? (?:Yes|No|Did|Did not)\.$/.test(line);
}
