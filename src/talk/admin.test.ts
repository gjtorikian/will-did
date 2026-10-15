import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const template = readFileSync("site/talk/admin.hbs", "utf8");
const script = template.match(/<script>([\s\S]*?)<\/script>/)![1];

/** Run the actual admin script with recognition events supplied by the test. */
function admin(heard = 0) {
  class Element {
    textContent: string | number = "";
    innerHTML = "";
    dataset: Record<string, string> = {};
    style = { width: "" };
    hidden = false;
    onclick = () => {};
    classList = { add() {}, remove() {} };
    querySelector() { return null; }
    setAttribute() {}
    prepend() {}
  }
  const elements = new Map<string, Element>();
  const element = (selector: string) => {
    if (!elements.has(selector)) elements.set(selector, new Element());
    return elements.get(selector)!;
  };
  element("#market").dataset = { word: "word", key: "test", publicUrl: "https://example.test/" };
  element("#initial").textContent = JSON.stringify({ heard, yes: 0, no: 0, resolved: null, lineHtml: "", run: "test" });

  type RecognitionEvent = { resultIndex: number; results: { transcript: string }[][] };
  class Recognition {
    onresult!: (event: RecognitionEvent) => void;
    onend!: () => void;
    start() {}
    stop() {}
  }
  let recognition: Recognition;
  const requests: { path: string; heard?: number }[] = [];
  runInNewContext(script, {
    document: { querySelector: element, querySelectorAll: () => [], createElement: () => new Element() },
    window: { SpeechRecognition: class extends Recognition { constructor() { super(); recognition = this; } } },
    EventSource: class { addEventListener() {} },
    fetch: (path: string, options: { body: string }) => {
      requests.push({ path: path.split("?")[0], ...JSON.parse(options.body) });
      return new Promise(() => {}); // Reports are inspected without a server or response rendering.
    },
  });
  element("#listen").onclick();
  return {
    result: (texts: string[], resultIndex = 0) => recognition.onresult({ resultIndex, results: texts.map((transcript) => [{ transcript }]) }),
    end: () => recognition.onend(),
    settle: () => element("#settle").onclick(),
    transcript: () => element("#transcript").innerHTML,
    last: () => requests.at(-1),
  };
}

test("recognition revisions count the current text, including word suffixes, once", () => {
  const page = admin();
  page.result(["I'm testing some word"]);
  page.result(["I'm testing some words"]);
  assert.equal(page.last()?.heard, 1);
  assert.equal(page.transcript(), "I'm testing some <mark>words</mark>");
  page.result(["I'm testing something"]);
  assert.equal(page.last()?.heard, 0);
});

test("removing an interim result removes its count before settlement", () => {
  const page = admin();
  const transcript = "I'm testing something I'm testing something I'm testing some words";
  page.result([transcript, "word"]);
  assert.equal(page.last()?.heard, 2);
  // Only the tentative tail disappears: resultIndex equals the new length.
  page.result([transcript], 1);
  assert.equal(page.transcript(), transcript.replace("words", "<mark>words</mark>"));
  assert.equal(page.last()?.heard, 1);
  page.settle();
  assert.deepEqual(page.last(), { path: "settle", heard: 1 });
});

test("recognition can retract every interim result", () => {
  const page = admin();
  page.result(["word", "words"]);
  page.result([]);
  assert.equal(page.transcript(), "");
  assert.equal(page.last()?.heard, 0);
});

test("recognition restarts retain corrected counts and the count from page load", () => {
  const page = admin(3);
  page.result(["word", "words"]);
  page.result(["word"], 1);
  page.end();
  page.result(["wording"]);
  assert.equal(page.last()?.heard, 5);
  page.settle();
  assert.deepEqual(page.last(), { path: "settle", heard: 5 });
});
