import { test } from "node:test";
import assert from "node:assert/strict";
import { humanize, straightQuotes, stripMarkdown } from "./prose.js";
import { words, ordinal } from "./numbers.js";

const cases: Array<[string, string]> = [
  ['Will "AI" be said 50+ times on the next All-In Podcast?', 'Will "AI" be said fifty (or more) times on the next All-In Podcast?'],
  ["Will an artwork sell for $150 million by December 31?", "Will an artwork sell for one hundred fifty million dollars by December thirty-first?"],
  ['Will Lichtenstein "Green Head" sell for at least $3.5m at auction?', 'Will Lichtenstein "Green Head" sell for at least three and a half million dollars at auction?'],
  ["Will Warhol \"Flowers\" sell for at least $600k+ at auction?", "Will Warhol \"Flowers\" sell for at least six hundred thousand dollars (or more) at auction?"],
  ["Will Pablo Picasso be #1 in global fine art auction turnover for 2026?", "Will Pablo Picasso be number one in global fine art auction turnover for twenty twenty-six?"],
  ["Elon Musk # tweets October 6 - October 13, 2026?", "Elon Musk number of tweets October sixth to October thirteenth, twenty twenty-six?"],
  ["# of views of next MrBeast video on week 1?", "number of views of next MrBeast video on week one?"],
  ["Will the Fed cut 25bps in December?", "Will the Fed cut twenty-five basis points in December?"],
  ["Will the high in NYC exceed 70° on Oct 7?", "Will the high in NYC exceed seventy degrees on October seventh?"],
  ["Bitcoin Up or Down - October 6, 3PM ET", "Bitcoin Up or Down - October sixth, three in the afternoon, Eastern time"],
  ["Will Bitcoin reach $150,000 by December 31?", "Will Bitcoin reach one hundred fifty thousand dollars by December thirty-first?"],
  ["Will Elon Musk post 200-219 tweets this week?", "Will Elon Musk post two hundred to two hundred nineteen tweets this week?"],
  ["Will Trump win 70% of the vote?", "Will Trump win seventy percent of the vote?"],
  ["Steelers vs Browns game", "Steelers versus Browns game"],
  ["Will global art market sales hit $65 billion for 2026?", "Will global art market sales hit sixty-five billion dollars for twenty twenty-six?"],
  ["Will the Knicks win Game 7 at 8:30 PM ET?", "Will the Knicks win Game seven at eight thirty in the evening, Eastern time?"],
  ["Will GTA VI release before 2027?", "Will GTA VI release before twenty twenty-seven?"],
  ["Will OpenAI release GPT-6 before 2027?", "Will OpenAI release GPT-six before twenty twenty-seven?"],
  ["Will MrBeast hit 500M subscribers in 2026?", "Will MrBeast hit five hundred million subscribers in twenty twenty-six?"],
  ["Will the Knicks win 3-1?", "Will the Knicks win three to one?"],
  ["Will the fight start at 22:00?", "Will the fight start at ten in the evening?"],
  ['Will "Veto" be said 5+ times during Episode 41 of Big Brother?', 'Will "Veto" be said five (or more) times during Episode forty-one of Big Brother?'],
  // months spelled out, but only as dates
  ["Will Donald Trump make 140-159 Truth Social posts the week of Oct 4, 2026?", "Will Donald Trump make one hundred forty to one hundred fifty-nine Truth Social posts the week of October fourth, twenty twenty-six?"],
  ["Will it close above 5,000 on Sept. 30?", "Will it close above five thousand on September thirtieth?"],
  ["Will Jan Koum post on Dec 1-7?", "Will Jan Koum post on December first to seventh?"],
  ["Will \"Whalefall\" Opening Weekend Box Office be between 8m and 10m?", "Will \"Whalefall\" Opening Weekend Box Office be between eight million and ten million?"],
  ["Will \"Whalefall\" Opening Weekend Box Office be at least 16m?", "Will \"Whalefall\" Opening Weekend Box Office be at least sixteen million?"],
  // market-type labels, bare week-ofs, trillions
  ["Will NVIDIA (NVDA) hit (HIGH) $260 Week of October 5 2026?", "Will NVIDIA (NVDA) hit a high of two hundred sixty dollars in the week of October fifth, twenty twenty-six?"],
  ["Will S&P 500 (SPX) hit $9,300 (HIGH) in December?", "Will S&P five hundred (SPX) hit a high of nine thousand three hundred dollars in December?"],
  ["Will the U.S. 30-year Fixed-Rate Mortgage hit 5.70% (LOW) by December 31, 2026?", "Will the U.S. thirty-year Fixed-Rate Mortgage hit a low of five point seven percent by December thirty-first, twenty twenty-six?"],
  ["Will Gold (GC) dip to (LOW) $2,500 by end of December?", "Will Gold (GC) dip to two thousand five hundred dollars by end of December?"],
  ["Will SK hynix (SKHY) hit (LOW) $156 in October?", "Will SK hynix (SKHY) hit a low of one hundred fifty-six dollars in October?"],
  ["Will Anthropic's valuation hit (HIGH) $3.0T by December 31?", "Will Anthropic's valuation hit a high of three trillion dollars by December thirty-first?"],
  ["Will it close above 5,000 during the Week of October 12?", "Will it close above five thousand during the Week of October twelfth?"],
  // no digit survives
  ["Will the highest temperature in Atlanta be between 72-73°F on October 11?", "Will the highest temperature in Atlanta be between seventy-two and seventy-three degrees on October eleventh?"],
  ["Will the maximum temperature be 66-67° on Oct 5, 2026?", "Will the maximum temperature be sixty-six to sixty-seven degrees on October fifth, twenty twenty-six?"],
  ["Will Bitcoin reach $92,000 October 5-11?", "Will Bitcoin reach ninety-two thousand dollars October fifth to eleventh?"],
  ["Will the next Claude Haiku model (4.6+) be released?", "Will the next Claude Haiku model (four point six (or more)) be released?"],
  ["Will CDU finish 3rd in the 2026 Berlin state election?", "Will CDU finish third in the twenty twenty-six Berlin state election?"],
  ["Will the 30Y U.S. Treasury yield be above 5%?", "Will the thirty-year U.S. Treasury yield be above five percent?"],
  ["Will the Nasdaq-100 close above 25,000?", "Will the Nasdaq-one hundred close above twenty-five thousand?"],
  ["Will the Index.US30/USD be above $51,625?", "Will the Index.US thirty/USD be above fifty-one thousand six hundred twenty-five dollars?"],
  ["Will Boeing deliver 170 planes in Q3 2026?", "Will Boeing deliver one hundred seventy planes in Q three twenty twenty-six?"],
  ["Will the 2026-27 NBA season start on time?", "Will the twenty twenty-six to twenty-seven NBA season start on time?"],
  ["Will it happen in 1999 or 2005?", "Will it happen in nineteen ninety-nine or two thousand five?"],
];
for (const [q, expected] of cases) {
  test(`humanize: ${q}`, () => assert.equal(humanize(q), expected));
}

test("words", () => {
  assert.equal(words(0), "zero");
  assert.equal(words(21), "twenty-one");
  assert.equal(words(150), "one hundred fifty");
  assert.equal(words(1234), "one thousand two hundred thirty-four");
  assert.equal(words(66317010), "sixty-six million three hundred seventeen thousand ten");
});
test("no digits anywhere", () => {
  for (const [q] of cases) assert.doesNotMatch(humanize(q), /\d/, q);
});
test("stripMarkdown", () => {
  assert.equal(stripMarkdown("Will average **gas prices** be above $4.01?"), "Will average gas prices be above $4.01?");
  assert.equal(stripMarkdown("Will __this__ and ~~that~~ and `code` and [a link](https://x.test) survive?"), "Will this and that and code and a link survive?");
  assert.equal(stripMarkdown("Will KALYANI [YouTube video 12: z5y8Clp_TdE] rank number one?"), "Will KALYANI [YouTube video 12: z5y8Clp_TdE] rank number one?", "brackets without a link, and lone underscores, are left alone");
});
test("ordinal", () => {
  assert.equal(ordinal(1), "first");
  assert.equal(ordinal(6), "sixth");
  assert.equal(ordinal(13), "thirteenth");
  assert.equal(ordinal(20), "twentieth");
  assert.equal(ordinal(31), "thirty-first");
});

test("straightQuotes", () => {
  assert.equal(straightQuotes("Will Rashid Johnson’s “Anxious Man” sell for $750k?"), `Will Rashid Johnson's "Anxious Man" sell for $750k?`);
  assert.equal(straightQuotes("Will Trump say ‘tariff’ this week?"), "Will Trump say 'tariff' this week?");
});

test("comparison symbols and ranges across months", () => {
  assert.equal(humanize("MicroStrategy announces >1000 BTC purchase September 29-October 5?"), "MicroStrategy announces greater than one thousand BTC purchase September twenty-ninth to October fifth?");
  assert.equal(humanize("Will Palantir (PLTR) close at <$180 on Friday?"), "Will Palantir (PLTR) close at less than one hundred eighty dollars on Friday?");
  assert.equal(humanize("Will the September 2026 unemployment rate be ≤3.8%?"), "Will the September twenty twenty-six unemployment rate be less than (or equal to) three point eight percent?");
  assert.equal(humanize("Will a dozen eggs cost ≥$2.70 in September?"), "Will a dozen eggs cost greater than (or equal to) two point seven dollars in September?");
});

test("durations with a plus", () => {
  assert.equal(humanize("Will the Tesla Roadster fly for 1s+?"), "Will the Tesla Roadster fly for one second (or more)?");
  assert.equal(humanize("Will the stream last 30min+?"), "Will the stream last thirty minutes (or more)?");
  assert.equal(humanize("Will the outage last 2h+?"), "Will the outage last two hours (or more)?");
});

test("qualifiers are always in parentheses, once", () => {
  assert.equal(humanize("Will the Green Party win 40% or more of the vote?"), "Will the Green Party win forty percent (or more) of the vote?");
  assert.equal(humanize("Will inflation be 2% or less?"), "Will inflation be two percent (or less)?");
  assert.equal(humanize("Will it be greater than or equal to 5?"), "Will it be greater than (or equal to) five?");
  assert.equal(humanize("Will 50+ people (or more) attend?"), "Will fifty (or more) people (or more) attend?", "an existing (or more) isn't wrapped again");
});
