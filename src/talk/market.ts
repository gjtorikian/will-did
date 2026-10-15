/**
 * A market about the talk itself. "Will I say the word “word” more than ten
 * times tonight?" is asked of the room over a QR code; the room answers yes
 * or no from their phones; the admin page listens for the word and reports
 * how often it has been said; and at the end the question settles into a
 * did / did not sentence by the same rules as every other line on the site.
 *
 * This file is the state and its arithmetic. server.ts owns the I/O.
 */
import { randomBytes } from "node:crypto";
import { markDid } from "../publish/templates.js";
import { humanize } from "../text/prose.js";
import { rewrite, willify } from "../text/rewrite.js";
import type { Result } from "../types.js";

/** site/talk.json */
export interface TalkConfig {
  question: string;
  /** the word being counted, matched whole and case-insensitively */
  word: string;
  /** "more than" this many settles yes */
  threshold: number;
}

export interface TalkState {
  run: string; // this start of the server; a phone that voted in an earlier run is asked again
  votes: Record<string, Result>; // voter → latest answer
  heard: number; // times the word has been said, as last reported by the admin page
  resolved: Result | null;
}

/** What both pages show, and what /events streams. */
export interface Tally {
  run: string;
  question: string; // the open line
  line: string; // as it reads now: the question while open, the answer once settled
  lineHtml: string; // the same with did / did not marked, for the pages
  word: string;
  threshold: number;
  thresholdWord: string; // "ten"
  yes: number;
  no: number;
  heard: number | null; // the count, once settled; kept from the room until then
  resolved: Result | null;
}

export const empty = (): TalkState => ({ run: randomBytes(4).toString("hex"), votes: {}, heard: 0, resolved: null });

const VOTER = /^[\w-]{8,64}$/;
export const isResult = (v: unknown): v is Result => v === "yes" || v === "no";

export type VoteOutcome = "ok" | "settled" | "bad";

/** A voter's latest answer is the one that counts, until the market settles. */
export function vote(s: TalkState, voter: unknown, choice: unknown): VoteOutcome {
  if (typeof voter !== "string" || !VOTER.test(voter) || !isResult(choice)) return "bad";
  if (s.resolved) return "settled";
  s.votes[voter] = choice;
  return "ok";
}

/** The admin page's running count: a whole number, within reason. */
export function heard(s: TalkState, n: unknown): boolean {
  if (typeof n !== "number" || !Number.isInteger(n) || n < 0 || n > 9999) return false;
  s.heard = n;
  return true;
}

/** Settle by the count: more than the threshold is yes. */
export function settle(s: TalkState, cfg: TalkConfig): Result {
  s.resolved = s.heard > cfg.threshold ? "yes" : "no";
  return s.resolved;
}

export function reopen(s: TalkState): void {
  s.resolved = null;
}

export function tally(s: TalkState, cfg: TalkConfig): Tally {
  const question = willify(cfg.question) ?? cfg.question;
  const line = s.resolved ? rewrite(question, s.resolved) : question;
  const votes = Object.values(s.votes);
  return {
    run: s.run,
    question,
    line,
    lineHtml: markDid(line, '<span class="did">', "</span>"),
    word: cfg.word,
    threshold: cfg.threshold,
    thresholdWord: humanize(String(cfg.threshold)),
    yes: votes.filter((v) => v === "yes").length,
    no: votes.filter((v) => v === "no").length,
    heard: s.resolved ? s.heard : null,
    resolved: s.resolved,
  };
}
