import { test } from "node:test";
import assert from "node:assert/strict";
import { rewrite, willify } from "./rewrite.js";

const cases: Array<[string, "yes" | "no", string]> = [
  ["WTI Crude Oil (WTI) closes above $90 on October 13?", "yes", "WTI Crude Oil (WTI) did close above $90 on October 13."],
  ['Will Trump say "No" during the speech?', "yes", 'Trump did say "No" during the speech.'],
  ["Will Trump say 'No' during the speech?", "yes", "Trump did say 'No' during the speech."],
  ["Will Alice's and Bob's plans not happen?", "no", "Alice's and Bob's plans did happen."],
  ["Will the earnings call not air?", "no", "The earnings call did air."],
  ["Will the earnings call not air?", "yes", "The earnings call did not air."],
  ["Will Trump's Midterm Rally in Alaska not air?", "no", "Trump's Midterm Rally in Alaska did air."],
  ["Will Andy Burnham not participate in the next PMQ?", "yes", "Andy Burnham did not participate in the next PMQ."],
  ["Will the highest score achieved by an Anthropic Claude model on Humanity's Last Exam in 2026 be 55% or higher?", "yes", "The highest score achieved by an Anthropic Claude model on Humanity's Last Exam in 2026 did end up 55% or higher."],
  ['Will Domino\'s say "DoorDash" during earnings call?', "yes", 'Domino\'s did say "DoorDash" during earnings call.'],
  ['Will "Run and Hide" be said during the speech?', "no", '"Run and Hide" did not get said during the speech.'],
  ["Will there be no model release by Friday?", "no", "Was there no model release by Friday? No."],
  ["Will no press briefing air by October 31?", "yes", "Did no press briefing air by October 31? Yes."],
  ["Will Perim Island no longer be under Houthi control?", "no", "Was Perim Island no longer under Houthi control? No."],
  ["Will X headline Coachella?", "no", "Did X headline Coachella? No."],
  ["Will X have been released by Friday?", "yes", "Had X been released by Friday? Yes."],
  ["Will X win and will Y lose?", "no", "Did X win and did Y lose? No."],
  ["Will Bitcoin reach $150,000 by December 31?", "yes", "Bitcoin did reach $150,000 by December 31."],
  ["Will Bitcoin reach $150,000 by December 31?", "no", "Bitcoin did not reach $150,000 by December 31."],
  ["Will Zohran Mamdani win the NYC mayoral election?", "yes", "Zohran Mamdani did win the NYC mayoral election."],
  ["Will the Fed cut rates in December?", "no", "The Fed did not cut rates in December."],
  ["Will there be a ceasefire by June 30?", "no", "A ceasefire did not happen by June 30."],
  ["Will there be a government shutdown on October 1?", "yes", "A government shutdown did happen on October 1."],
  ["Will Taylor Swift and Travis Kelce get married in 2026?", "yes", "Taylor Swift and Travis Kelce did get married in 2026."],
  ["Will the Lakers be eliminated in the first round?", "yes", "The Lakers did get eliminated in the first round."],
  ["Will the US be in a recession in 2026?", "no", "The US did not end up in a recession in 2026."],
  ["Bitcoin Up or Down - October 6, 3PM ET", "no", "Bitcoin did go down, October 6, 3PM ET."],
  ["Bitcoin Up or Down - October 6, 3PM ET", "yes", "Bitcoin did go up, October 6, 3PM ET."],
  ["Ethereum above $4,000 on October 10?", "yes", "Ethereum did end up above $4,000 on October 10."],
  ["Will Trump say 'bitcoin' during the speech?", "yes", "Trump did say 'bitcoin' during the speech."],
  ["Will the release of GTA VI happen before 2027?", "no", "The release of GTA VI did not happen before 2027."],
  ["Will the Supreme Court rule on the tariffs by June?", "yes", "The Supreme Court did rule on the tariffs by June."],
  ["Will Elon Musk step down as CEO of Tesla?", "yes", "Elon Musk did step down as CEO of Tesla."],
  ["AI artwork hits $10M at major auction in 2026?", "no", "AI artwork did not hit $10M at major auction in 2026."],
  ["Will the Salvator Mundi be publicly exhibited by December 31?", "no", "The Salvator Mundi did not get publicly exhibited by December 31."],
  ["Will Pablo Picasso be #1 in global fine art auction turnover for 2026?", "yes", "Pablo Picasso did end up #1 in global fine art auction turnover for 2026."],
  ['Will "Veto" be said 5+ times during Episode 41 of Big Brother?', "yes", '"Veto" did get said 5+ times during Episode 41 of Big Brother.'],
  ['Will Trump say "Pearl Harbor" this week?', "no", 'Trump did not say "Pearl Harbor" this week.'],
  ["Will Jesus Christ return before 2027?", "no", "Jesus Christ did not return before 2027."],
  ["Fed decision in December: Cut 25bps", "yes", "Fed decision in December: Cut 25bps? Yes."],
  ["Will Zelensky still be president on July 1?", "yes", "Zelensky did remain president on July 1."],
  ["Will Trump officially announce a run before March?", "no", "Trump did not officially announce a run before March."],
  ["Will Trump's run end before 2028?", "no", "Trump's run did not end before 2028."],
  ["Will there be a change in leadership at the Fed by June?", "no", "A change in leadership at the Fed did not happen by June."],
  ["Will the man who shot the senator be convicted?", "yes", "The man who shot the senator did get convicted."],
  ["Will Netflix stock close above $1,000 on Friday?", "yes", "Netflix stock did close above $1,000 on Friday."],
  // "any" is licensed by a question or a negation, never by the statement itself
  ["Will Trump pardon anyone by October 31?", "yes", "Trump did pardon someone by October 31."],
  ["Will Trump pardon anyone by October 31?", "no", "Trump did not pardon anyone by October 31."],
  ["Will the Catholic Church publicly excommunicate anyone else in 2026?", "yes", "The Catholic Church did publicly excommunicate someone else in 2026."],
  ["Will any AI model reach a Chatbot Arena score of 1530 by December 31?", "yes", "Some AI model did reach a Chatbot Arena score of 1530 by December 31."],
  ["Will any AI model reach a Chatbot Arena score of 1530 by December 31?", "no", "No AI model did reach a Chatbot Arena score of 1530 by December 31."],
  ["Will any other model be the best AI model on October 5?", "yes", "Some other model did end up the best AI model on October 5."],
  ["Will any presidential candidate win outright in the first round?", "no", "No presidential candidate did win outright in the first round."],
  ["Will anyone be arrested by Friday?", "no", "No one did get arrested by Friday."],
  ["Will Bitcoin trade above $100,000 at any point in October?", "yes", "Bitcoin did trade above $100,000 at some point in October."],
  ["Will there be any arrests by Friday?", "yes", "Some arrests did happen by Friday."],
  ["Will there be any arrests by Friday?", "no", "No arrests did happen by Friday."],
  ['Will Trump say "anything" during the speech?', "yes", 'Trump did say "anything" during the speech.'],
  ["Will Trump say 'anyone' during the speech?", "yes", "Trump did say 'anyone' during the speech."],
  ["Will Netflix air Anyway anymore?", "no", "Netflix did not air Anyway anymore."],
  // so is "ever"
  ["Will Bitcoin ever reach $1,000,000?", "yes", "Bitcoin did reach $1,000,000."],
  ["Will Bitcoin ever reach $1,000,000?", "no", "Bitcoin did not ever reach $1,000,000."],
];

for (const [q, r, expected] of cases) {
  test(`${q} → ${r}`, () => assert.equal(rewrite(q, r), expected));
}

const wills: Array<[string, string | null]> = [
  ["Will Bitcoin reach $150,000?", "Will Bitcoin reach $150,000?"],
  ["will trump acquire greenland before 2027", "Will trump acquire greenland before 2027?"],
  ["Ethereum above $4,000 on October 10?", "Will Ethereum be above $4,000 on October 10?"],
  ["Bitcoin Up or Down - October 6, 3PM ET", "Will Bitcoin go up, October 6, 3PM ET?"],
  ["AI artwork hits $10M at major auction in 2026?", "Will AI artwork hit $10M at major auction in 2026?"],
  ["Is Zelensky still president on July 1?", "Will Zelensky be still president on July 1?"],
  ["Elon Musk # tweets October 6 - October 13, 2026?", null],
  ["Fed decision in December: Cut 25bps", null],
  ["Next James Bond actor?", null],
];
for (const [q, expected] of wills) {
  test(`willify: ${q}`, () => assert.equal(willify(q), expected));
}

test("wh-questions get their answer put back, or are dropped", () => {
  assert.equal(
    willify("What will Donald Trump say during A New Golden Age Summit originally scheduled for October 8, 2026: Sacks"),
    'Will Donald Trump say "Sacks" during A New Golden Age Summit originally scheduled for October 8, 2026?',
  );
  assert.equal(
    willify("What will Bernie Sanders say during his town hall: Zillion / Zillionaire"),
    'Will Bernie Sanders say "Zillion" or "Zillionaire" during his town hall?',
  );
  assert.equal(
    willify("How many initial jobless claims will there be the week ending Oct 3, 2026: At least 225,000"),
    "Will there be at least 225,000 initial jobless claims in the week ending Oct 3, 2026?",
  );
  assert.equal(willify("What will Donald Trump say during Midterm Rally in Syracuse, New York: Event does not qualify"), null);
  assert.equal(willify("Who will win the election?"), null, "no answer to put back");
  assert.equal(
    rewrite("What will Trump say during his rally in Youngstown: Tariff", "no"),
    'Trump did not say "Tariff" during his rally in Youngstown.',
  );
  assert.equal(
    rewrite("How many initial jobless claims will there be the week ending Oct 3, 2026: At least 225,000", "no"),
    "At least 225,000 initial jobless claims did not happen in the week ending Oct 3, 2026.",
  );
});

test("verbs the archive fell back on now conjugate", () => {
  const cases: Array<[string, "yes" | "no", string]> = [
    ["Will it rain in Philadelphia, PA on October second?", "yes", "It did rain in Philadelphia, PA on October second."],
    ["Will Trump praise Allah again by September thirtieth?", "no", "Trump did not praise Allah again by September thirtieth."],
    ["Will Mamdani freeze NYC rents before twenty twenty-seven?", "yes", "Mamdani did freeze NYC rents before twenty twenty-seven."],
    ["Will Choi-wan peak as a Strong typhoon?", "no", "Choi-wan did not peak as a Strong typhoon."],
    ["Will Ukraine re-enter Obratne or Temyrivka by September thirtieth?", "no", "Ukraine did not re-enter Obratne or Temyrivka by September thirtieth."],
  ];
  for (const [q, r, expected] of cases) assert.equal(rewrite(q, r), expected, q);
});

test("names aren't verbs: capitalised words, an ʻokina, a parenthesised abbreviation, a particle", () => {
  const cases: Array<[string, string]> = [
    ["Will Veneziano Vital do Rêgo win the Governor of Paraíba election?", "Veneziano Vital do Rêgo did not win the Governor of Paraíba election."],
    ["Will Edwin van der Sar win the Ballon d'Or?", "Edwin van der Sar did not win the Ballon d'Or."],
    ["Will Mohammed bin Salman visit Washington by December?", "Mohammed bin Salman did not visit Washington by December."],
    ["Will Delta Air Lines say \"Fuel\" during earnings call?", 'Delta Air Lines did not say "Fuel" during earnings call.'],
    ["Will Ashley Trail win Big Brother season twenty-eight?", "Ashley Trail did not win Big Brother season twenty-eight."],
    ["Will RISE launch a token by September thirtieth?", "RISE did not launch a token by September thirtieth."],
    ["Will 'Olioni Manoa win the Tongatapu two by-election?", "'Olioni Manoa did not win the Tongatapu two by-election."],
    ["Will Apvienotais Saraksts (AS) win the most seats?", "Apvienotais Saraksts (AS) did not win the most seats."],
    ["Will Trump say 'tariff' this week?", "Trump did not say 'tariff' this week."],
  ];
  for (const [q, expected] of cases) assert.equal(rewrite(q, "no"), expected, q);
});
