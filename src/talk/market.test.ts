import { test } from "node:test";
import assert from "node:assert/strict";
import { empty, heard, reopen, settle, tally, vote, type TalkConfig } from "./market.js";

const cfg: TalkConfig = { question: "Will I say the word “word” more than ten times tonight?", word: "word", threshold: 10 };

test("a voter's latest answer is the one that counts", () => {
  const s = empty();
  assert.equal(vote(s, "voter-00000001", "yes"), "ok");
  assert.equal(vote(s, "voter-00000002", "yes"), "ok");
  assert.equal(vote(s, "voter-00000001", "no"), "ok");
  const t = tally(s, cfg);
  assert.deepEqual([t.yes, t.no], [1, 1]);
});

test("malformed votes are refused", () => {
  const s = empty();
  assert.equal(vote(s, "short", "yes"), "bad");
  assert.equal(vote(s, "voter-00000001", "maybe"), "bad");
  assert.equal(vote(s, 42, "yes"), "bad");
  assert.equal(vote(s, "voter 00000001", "yes"), "bad");
  const t = tally(s, cfg);
  assert.equal(t.yes + t.no, 0);
});

test("the count must be a whole number", () => {
  const s = empty();
  assert.ok(heard(s, 3));
  assert.equal(heard(s, -1), false);
  assert.equal(heard(s, 2.5), false);
  assert.equal(heard(s, "4"), false);
  assert.equal(heard(s, 10_000), false);
  assert.equal(s.heard, 3);
});

test("the question settles by the count, and reads by the site's own rules", () => {
  const s = empty();
  const open = tally(s, cfg);
  assert.equal(open.line, cfg.question);
  assert.equal(open.thresholdWord, "ten");
  heard(s, 10);
  assert.equal(tally(s, cfg).heard, null, "the count is kept from the room until it settles");
  assert.equal(settle(s, cfg), "no", "more than ten, not ten");
  assert.equal(tally(s, cfg).heard, 10);
  assert.equal(tally(s, cfg).line, "I did not say the word “word” more than ten times tonight.");
  assert.match(tally(s, cfg).lineHtml, /<span class="did">did not<\/span>/);
  reopen(s);
  assert.equal(tally(s, cfg).heard, null);
  heard(s, 11);
  assert.equal(settle(s, cfg), "yes");
  assert.equal(tally(s, cfg).line, "I did say the word “word” more than ten times tonight.");
  assert.match(tally(s, cfg).lineHtml, /^I <span class="did">did<\/span> say/);
});

test("no votes once settled; reopening allows them again", () => {
  const s = empty();
  settle(s, cfg);
  assert.equal(vote(s, "voter-00000001", "yes"), "settled");
  reopen(s);
  assert.equal(vote(s, "voter-00000001", "yes"), "ok");
  assert.equal(s.resolved, null);
});

test("each start is its own run", () => {
  const a = empty(), b = empty();
  assert.match(a.run, /^[0-9a-f]{8}$/);
  assert.notEqual(a.run, b.run);
  assert.equal(tally(a, cfg).run, a.run);
});
