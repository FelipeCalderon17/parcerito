import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { renderHub } from "../src/review/hub.js";
import { issueItem } from "../src/review/issues.js";
import { limeIds, matchTopics, parseTopics, topicQuestions, topicReference, topicsOf, withAnswers, type MatchModel, type MeganTopic } from "../src/review/topics.js";
import type { LinearIssue, Pack } from "../src/review/types.js";
import { cellIndex, relTargets, sharedStrings, sheetRows } from "../src/review/xlsx.js";

const U = (d: string) => `${d.repeat(8)}-${d.repeat(4)}-${d.repeat(4)}-${d.repeat(4)}-${d.repeat(12)}`;

test("xlsx: shared/inline/plain cells, rich-text runs, entities and hyperlinks by rel id", () => {
  const strings = sharedStrings(`<sst><si><t>#</t></si><si><r><t>Top</t></r><r><t xml:space="preserve">ic &amp; more</t></r></si><si><t>Linear</t></si><si><t>ENG-1</t></si></sst>`);
  assert.deepEqual(strings, ["#", "Topic & more", "Linear", "ENG-1"]);
  const rels = relTargets(`<Relationships><Relationship Id="rId1" Type="h" Target="https://linear.app/x/issue/ENG-1?a=1&amp;b=2" TargetMode="External"/></Relationships>`);
  const rows = sheetRows(
    `<sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c></row>
     <row r="2"><c r="A2"><v>7</v></c><c r="B2" t="inlineStr"><is><t>Inline</t></is></c><c r="C2" t="s"><v>3</v></c></row></sheetData>
     <hyperlinks><hyperlink ref="C2" r:id="rId1"/></hyperlinks>`,
    strings,
    rels,
  );
  assert.deepEqual(rows[1]!.map((c) => c.text), ["7", "Inline", "ENG-1"]);
  assert.deepEqual(rows[1]![2]!.links, ["https://linear.app/x/issue/ENG-1?a=1&b=2"]);
  assert.deepEqual(cellIndex("AB12"), [11, 27]);
});

const cell = (text: string, links: string[] = []) => ({ text, links });
const HEAD = ["#", "Topic", "Fields", "Org · EHR", "Questions for Megan", "Open in Lime", "Slack thread(s)", "Linear", "Megan's answer", "Next step after her answer"].map((h) => cell(h));
const sheets = [
  {
    name: "Megan meeting",
    rows: [
      HEAD,
      [cell("1"), cell("Bathing code"), cell("M1830"), cell("Mission · Axxess"), cell("Which code?"), cell("case", [`https://app.getlimeai.com/cases/${U("a")}?orgId=${U("f")}`]), cell(""), cell("ENG-10\nENG-99"), cell(""), cell("Fix prompt")],
      [cell("2"), cell("Wound type"), cell("M1340"), cell("Universal"), cell("Surgical?"), cell(""), cell("#chan", ["https://x.slack.com/archives/C1/p1700000002000200"]), cell("No issue"), cell("Not surgical."), cell("Update prompt")],
      [cell("3"), cell("Emergency contact"), cell("lime.emergency_contact"), cell("Care Dimensions"), cell("Which?"), cell(""), cell(""), cell(""), cell(""), cell("")],
      [cell("4"), cell("Nothing like it"), cell(""), cell(""), cell(""), cell(""), cell(""), cell(""), cell(""), cell("")],
    ],
  },
  { name: "Links", rows: [[cell("#"), cell("Link")], [cell("1"), cell("Lime case", [`https://app.getlimeai.com/cases/x?taskId=${U("b")}`])]] },
];

const linear = (over: Partial<LinearIssue>): LinearIssue => ({
  identifier: "ENG-1",
  title: "T",
  url: "",
  description: "",
  state: { name: "Triage", type: "triage" },
  assignee: null,
  comments: { nodes: [] },
  ...over,
});
const packOf = (l: LinearIssue, over: Partial<Pack> = {}): Pack => ({ item: issueItem(l, null), linear: [l], errors: [], threads: [], visits: [], ...over });
const msg = (ts: string) => ({ author: "Kim", ts, text: "", permalink: "", images: [], files: [] });

test("parseTopics: numbered rows only, columns by header, links and other sheets' links per topic", () => {
  const topics = parseTopics(sheets);
  assert.deepEqual(topics.map((t) => t.n), [1, 2, 3, 4]);
  assert.equal(topics[0]!.fields, "M1830");
  assert.deepEqual(topics[0]!.linearRefs, ["ENG-10", "ENG-99"]);
  assert.equal(topics[0]!.extraLinks.length, 1);
  assert.deepEqual(topics[1]!.links["Slack thread(s)"], ["https://x.slack.com/archives/C1/p1700000002000200"]);
  assert.equal(topics[1]!.answer, "Not surgical.");
  // Org ids aren't case/visit/task ids.
  assert.deepEqual(limeIds(`/cases/${U("a")}?orgId=${U("f")}&taskId=${U("b")}`), [U("a"), U("b")]);
});

test("matchTopics: linear-ref, slack-thread via a reply's root, visit via ids in the issue text, model for the rest; many-to-many", async () => {
  const topics = parseTopics(sheets);
  const packs = [
    packOf(linear({ identifier: "ENG-10", title: "Bathing M1830", description: "Mission chart" })),
    // Its thread holds the topic's reply ts: the topic's permalink resolves to the same root.
    packOf(linear({ identifier: "ENG-20", title: "Wound" }), {
      threads: [{ ref: { channel: "C1", ts: "1700000001.000100" }, link: "", messages: [msg("1700000001.000100"), msg("1700000002.000200")] }],
    }),
    // The topic's task id (from the Links sheet) is in this issue's comment; ids only in Slack messages don't count.
    packOf(linear({ identifier: "ENG-30", title: "Other", comments: { nodes: [{ body: `see taskId=${U("b")}`, createdAt: "", user: null }] } })),
    packOf(linear({ identifier: "ENG-31", title: "Other" }), {
      threads: [{ ref: { channel: "C9", ts: "1.000001" }, link: "", messages: [{ ...msg("1.000001"), text: `/cases/${U("a")}` }] }],
    }),
    packOf(linear({ identifier: "ENG-40", title: "Emergency contact person wrong", description: "lime.emergency_contact Care Dimensions" })),
  ];
  let prompts = 0;
  const generate: MatchModel = async (prompt) => {
    prompts++;
    assert.match(prompt, /#3: Emergency contact/);
    assert.doesNotMatch(prompt, /#1: Bathing/);
    return [
      { topic: 3, issue: "ENG-40", confidence: "high", why: "same field" },
      { topic: 3, issue: "ENG-10", confidence: "low", why: "loose" },
      { topic: 3, issue: "ENG-404", confidence: "high", why: "not a candidate" },
    ];
  };
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "topics-"));
  await matchTopics(topics, packs, { cacheDir, config: { CLAUDE_MODEL: "m" }, generate });
  const by = (n: number) => topics.find((t) => t.n === n)!.matches.map((m) => `${m.issue}:${m.method}`);
  assert.deepEqual(by(1), ["ENG-10:linear-ref", "ENG-30:visit"]);
  assert.deepEqual(by(2), ["ENG-20:slack-thread"]);
  assert.deepEqual(by(3), ["ENG-40:model"]);
  assert.deepEqual(by(4), []);
  // Second run hits the cache.
  await matchTopics(topics, packs, { cacheDir, config: { CLAUDE_MODEL: "m" }, generate });
  assert.equal(prompts, 1);

  // One issue, several topics.
  topics.find((t) => t.n === 2)!.matches.push({ issue: "ENG-10", method: "model", why: "w", confidence: "medium" });
  assert.equal(topicsOf(topics, "ENG-10").length, 2);
});

test("topicReference carries Megan's answer only when filled; questions merge in and the overview section shows topics", () => {
  const topics: MeganTopic[] = parseTopics(sheets);
  topics[0]!.matches = [{ issue: "ENG-10", method: "linear-ref" }];
  topics[1]!.matches = [{ issue: "ENG-10", method: "slack-thread" }, { issue: "ENG-20", method: "slack-thread" }];
  assert.equal(topicReference(topics, "ENG-20"), "[Megan's answer · spreadsheet 10-21 · topic #2] Wound type\nNot surgical.");
  assert.equal(topicReference(topics, "ENG-10"), "[Megan's answer · spreadsheet 10-21 · topic #2] Wound type\nNot surgical.");
  const agency = { text: "[Mission · Doc · Wounds]\nrule", sources: ["Doc · Wounds"] };
  const ref = withAnswers(topicReference(topics, "ENG-20"), agency)!;
  assert.match(ref.text, /^\[Megan's answer[^\n]*\nNot surgical\.\n\n\[Mission/);
  assert.deepEqual(ref.sources, ["Megan spreadsheet 10-21", "Doc · Wounds"]);
  topics[1]!.answer = "";
  assert.equal(topicReference(topics, "ENG-10"), null);
  // No answer: the agency reference is untouched, so the classifier cache keeps hitting.
  assert.equal(withAnswers(topicReference(topics, "ENG-10"), agency), agency);

  // The topic's questions join the issue's questions to resolve (no separate topic card).
  assert.ok(topicQuestions(topics, "ENG-20").some((q) => /Surgical\?/.test(q)));

  const html = renderHub([packOf(linear({ identifier: "ENG-10" }))], "2026-10-22", new Map(), "2026-10-22", topics);
  assert.match(html, /Spreadsheet topics/);
  assert.match(html, /href="#ENG-10"/);
  assert.match(html, /ENG-99 ↗/);
  assert.match(html, /no issue yet/);
});

test("matchTopics: a busy thread (more than MAX_THREAD_ISSUES issues) only matches the issue naming the same reply", async () => {
  const [topic] = parseTopics(sheets).filter((t) => t.n === 2);
  const thread = (ts: string) => ({ ref: { channel: "C1", ts }, link: "", messages: [msg("1700000001.000100"), msg("1700000002.000200"), msg("1700000003.000300")] });
  const packs = ["ENG-1", "ENG-2", "ENG-3", "ENG-4"].map((id, i) =>
    packOf(linear({ identifier: id }), { threads: [thread(i === 0 ? "1700000002.000200" : "1700000003.000300")] }),
  );
  await matchTopics([topic!], packs, { cacheDir: fs.mkdtempSync(path.join(os.tmpdir(), "topics-")), config: { CLAUDE_MODEL: "m" }, generate: async () => [] });
  assert.deepEqual(topic!.matches.map((m) => m.issue), ["ENG-1"]);
});
