import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { ManualIndex, ManualItem } from "../src/manual/lookup.js";
import type { NotesModel } from "../src/manual/notes.js";
import { classifyIssues, issueInput, MAX_INPUT, mergeQuestions, REFERENCE_CAP, type ClassifyModel } from "../src/review/classify.js";
import { classCard, renderHub } from "../src/review/hub.js";
import { issueItem, withMegan } from "../src/review/issues.js";
import { ISSUES } from "../src/review/megan-issues.js";
import type { LinearIssue, Pack, Triage } from "../src/review/types.js";

const entry = (code: string, pages: [number, number]): ManualItem => ({ code, title: `${code} title`, pages, text: `${code} text` });
const manual: ManualIndex = {
  source: "s",
  version: "v1",
  builtAt: "b",
  general: [{ title: "1.5.8.2 Conventions Specific to OASIS M1800 ADL/IADL Items", pages: [14, 15], text: "adl rules" }],
  items: { M1830: entry("M1830", [125, 126]), M1840: entry("M1840", [126, 127]) },
};
const notesModel: NotesModel = async (prompt) => [`note for ${prompt.match(/about (\w+)/)![1]} (p.125)`, "Dash not valid (p.126)"];

const linear = (over: Partial<LinearIssue>): LinearIssue => ({
  identifier: "ENG-1",
  title: "T",
  url: "https://linear.app/x/issue/ENG-1",
  description: "",
  state: { name: "Triage", type: "triage" },
  assignee: null,
  comments: { nodes: [] },
  labels: { nodes: [] },
  ...over,
});
const packOf = (l: LinearIssue, over: Partial<Pack> = {}): Pack => ({ item: issueItem(l, null), linear: [l], errors: [], threads: [], visits: [], ...over });
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "classify-"));
const quiet = { log: () => {}, notesModel, manual };
const ready: Triage = { classification: "ready", kind: "app-bug", reason: "Save drops the value.", manualVerdict: "n/a", questions: [], nextStep: "Fix the save." };

test("issueInput: capped, with manual notes for named codes, ADL conventions, no bots and a compact visit trace", async () => {
  const l = linear({
    title: "Bathing M1830 rejected",
    description: "x".repeat(20_000),
    comments: { nodes: Array.from({ length: 12 }, (_, i) => ({ body: `comment ${i} ${"y".repeat(800)}`, createdAt: `2026-10-${10 + i}`, user: null })) },
  });
  const pack = packOf(l, {
    threads: [
      {
        ref: { channel: "C1", ts: "1" },
        link: "",
        messages: [
          { author: "Kim", ts: "1", text: "coder says 6", permalink: "", images: [], files: [] },
          { author: "nicolas-prange-dotterino", ts: "2", text: "BOT RELAY", permalink: "", images: [], files: [] },
        ],
      },
    ],
    visits: [
      {
        task: "t",
        data: {
          task: [{ clinician: "Ann Nurse <a@x>", visit_date: "2026-10-21", form: "SOC" }],
          fields: [
            {
              key: "M1830",
              ai_value: "02",
              decision: "rejected",
              rejected_via: "edit",
              rejection_reason: "wrong",
              decided_by: "Cody Coder <c@x>",
              answers: [{ value: "06" }],
              evidence: [{ type: "audio", at: "00:01:02", snippet: "she bathes with help" }, { type: "document", page: 2, text: "t2" }, { type: "audio", text: "t3" }],
            },
          ],
          unanswered: [{ key: "M1840", answers: [{ value: "04", by: "Ann Nurse <a@x>" }] }],
          no_suggestion_steps: [{ key: "M1840", abstained: true }],
          seen_evidence: [{ key: "M1840", type: "audio", text: "uses a bedside commode" }, { key: "M1840", type: "audio", text: "unrelated chat" }],
        },
      },
    ],
  });
  const config = { CLAUDE_MODEL: "x", DATA_DIR: tmp() };
  let prompt = "";
  await classifyIssues(config, [pack], { ...quiet, cacheDir: tmp(), generate: async (p) => ((prompt = p), ready) });
  assert.ok(prompt.length < MAX_INPUT + 3_000);
  assert.match(prompt, /M1830 M1830 title \(p\.125–126\)\nnote for M1830/);
  assert.match(prompt, /1\.5\.8\.2 .*adl rules/);
  assert.match(prompt, /coder says 6/);
  assert.doesNotMatch(prompt, /BOT RELAY/);
  assert.match(prompt, /comment 11/);
  assert.doesNotMatch(prompt, /comment 3 /);
  // Trace: AI → final, decision, role (no names), at most two evidence snippets; no-suggestion status + topic passages.
  assert.match(prompt, /- M1830: AI 02 → final 06; rejected via edit, reason wrong, by coder\/reviewer/);
  assert.match(prompt, /she bathes with help/);
  assert.doesNotMatch(prompt, /"t3"/);
  assert.match(prompt, /- M1840: no AI suggestion \(abstained\) → final 04 by visit clinician\n {4}AI saw: \[audio\] "uses a bedside commode"/);
  assert.doesNotMatch(prompt, /unrelated chat|Ann Nurse|Cody Coder/);
  assert.ok(issueInput(pack, [], { manual }).length <= MAX_INPUT);
  const input = issueInput(pack, [], { manual, reference: "r".repeat(5_000) });
  assert.ok(input.length <= MAX_INPUT + REFERENCE_CAP + 800);
  assert.match(input, /AGENCY DOCUMENTATION PREFERENCES[\s\S]*\nr{4000}$/);
  assert.doesNotMatch(input, /x{2001}/);
});

test("classifyIssues: cache hit skips the model; a changed input re-classifies; agenda packs are left alone", async () => {
  const config = { CLAUDE_MODEL: "x", DATA_DIR: tmp() };
  const cacheDir = tmp();
  let calls = 0;
  const generate: ClassifyModel = async () => (calls++, ready);
  const agenda: Pack = { ...packOf(linear({ identifier: "ENG-2" })), item: { ...issueItem(linear({ identifier: "ag" }), null), origin: { kind: "megan" } } };
  const first = await classifyIssues(config, [packOf(linear({})), agenda], { ...quiet, cacheDir, generate });
  assert.deepEqual(first, { ready: 1, needs: 0, failed: 0, cached: 0 });
  assert.equal(agenda.item.triage, undefined);

  const pack = packOf(linear({}));
  const again = await classifyIssues(config, [pack], { ...quiet, cacheDir, generate: async () => assert.fail("cache hit must not call the model") });
  assert.deepEqual(again, { ready: 1, needs: 0, failed: 0, cached: 1 });
  assert.equal(pack.item.classification, "ready");
  assert.equal(pack.item.classificationReason, "Save drops the value.");
  assert.deepEqual(pack.item.triage, ready);

  await classifyIssues(config, [packOf(linear({ description: "new info" }))], { ...quiet, cacheDir, generate });
  assert.equal(calls, 2);
});

test("classifyIssues: a failure keeps the placeholder class, isn't cached and is retried", async () => {
  const config = { CLAUDE_MODEL: "x", DATA_DIR: tmp() };
  const cacheDir = tmp();
  const pack = packOf(linear({ state: { name: "Todo", type: "unstarted" } }));
  const t = await classifyIssues(config, [pack], { ...quiet, cacheDir, generate: async () => { throw new Error("timeout"); } });
  assert.deepEqual(t, { ready: 0, needs: 0, failed: 1, cached: 0 });
  assert.equal(pack.item.classification, "ready");
  assert.equal(pack.item.classificationReason, "classifier failed: timeout");
  assert.equal(pack.item.triage, undefined);
  assert.equal(fs.readdirSync(path.join(cacheDir, "classify")).length, 0);
});

test("Megan's issues stay needs-clarification; her questions first, new ones appended deduped", async () => {
  const megan = ISSUES[0]!;
  const l = linear({ identifier: megan.id, title: "Toileting M1840" });
  const pack: Pack = { item: withMegan(issueItem(l, null), megan), linear: [l], errors: [], threads: [], visits: [] };
  let prompt = "";
  const generate: ClassifyModel = async (p) => (
    (prompt = p), { ...ready, classification: "ready", kind: "coding-rule", reason: "M1840 p.126 covers it.", questions: [`${megan.ask[0]!.toUpperCase()}`, "Is a urinal a bedpan?"] }
  );
  await classifyIssues({ CLAUDE_MODEL: "x", DATA_DIR: tmp() }, [pack], { ...quiet, cacheDir: tmp(), generate });
  assert.match(prompt, /ALREADY ASKED OF MEGAN/);
  assert.equal(pack.item.classification, "needs-clarification");
  assert.equal(pack.item.triage?.classification, "needs-clarification");
  assert.deepEqual(pack.item.panel.questions?.items, [...megan.ask, "Is a urinal a bedpan?"]);
  assert.deepEqual(mergeQuestions(["A b?"], ["a, B", "", "c"]), ["A b?", "c"]);
});

test("render: ready shows the next step, needs-clarification the questions for Megan; overview has kind + reason", async () => {
  const config = { CLAUDE_MODEL: "x", DATA_DIR: tmp() };
  const a = packOf(linear({ identifier: "ENG-1" }));
  const b = packOf(linear({ identifier: "ENG-2" }));
  const needs: Triage = { classification: "needs-clarification", kind: "coding-rule", reason: "Agency field <lime.x>.", manualVerdict: "not-in-manual", questions: ["Which default?"] };
  await classifyIssues(config, [a, b], { ...quiet, cacheDir: tmp(), generate: async (p) => (p.includes("ISSUE ENG-1:") ? ready : needs) });
  const ca = classCard(a);
  assert.match(ca, /Ready to work/);
  assert.match(ca, /App bug/);
  assert.match(ca, /<b>Next step<\/b>Fix the save\./);
  assert.equal(a.item.panel.questions, undefined);
  const cb = classCard(b);
  assert.match(cb, /Not in manual/);
  assert.match(cb, /Agency field &lt;lime\.x&gt;\./);
  assert.doesNotMatch(cb, /Next step/);
  const html = renderHub([a, b], "2026-10-22", new Map());
  assert.match(html, /❓ Questions for Megan<\/div>\s*<label class="q"><input type="checkbox" data-save="ENG-2:q0"><span>Which default\?/);
  assert.match(html, /<div class="muted small">App bug · Save drops the value\.<\/div>/);
});

test("classifyIssues: the agency reference goes in the prompt, keys the cache and its sources render under the reason", async () => {
  const config = { CLAUDE_MODEL: "x", DATA_DIR: tmp() };
  const cacheDir = tmp();
  const prompts: string[] = [];
  const generate: ClassifyModel = async (p) => (prompts.push(p), ready);
  const reference = (text: string) => () => ({ text, sources: ["Doc A · 2. Vitals"] });
  const pack = packOf(linear({}));
  await classifyIssues(config, [pack], { ...quiet, cacheDir, generate, reference: reference("[Acme · Doc A · 2. Vitals]\nLeave parameters blank.") });
  assert.match(prompts[0]!, /AGENCY DOCUMENTATION PREFERENCES[\s\S]*Agency prefs: <doc> · <section>[\s\S]*\[Acme · Doc A · 2\. Vitals\]\nLeave parameters blank\.$/);
  assert.deepEqual(pack.item.agencySources, ["Doc A · 2. Vitals"]);
  assert.match(classCard(pack), /Agency docs given:<ul><li>Doc A · 2\. Vitals<\/li><\/ul>/);

  const hit = await classifyIssues(config, [packOf(linear({}))], { ...quiet, cacheDir, generate, reference: reference("[Acme · Doc A · 2. Vitals]\nLeave parameters blank.") });
  assert.equal(hit.cached, 1);
  await classifyIssues(config, [packOf(linear({}))], { ...quiet, cacheDir, generate, reference: reference("changed") });
  const none = packOf(linear({}));
  await classifyIssues(config, [none], { ...quiet, cacheDir, generate, reference: () => null });
  assert.equal(prompts.length, 3);
  assert.doesNotMatch(prompts[2]!, /AGENCY DOCUMENTATION/);
  assert.equal(none.item.agencySources, undefined);
  assert.doesNotMatch(classCard(none), /Agency docs/);
});
