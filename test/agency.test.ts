import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { agencyReference, issueAgencies, issueEhrs, loadAgencyDocs, sectionScore, words, type AgencyIndex, type IssueContext } from "../src/review/agency.js";
import { docxLines, pdfLines, sectionsOf } from "../src/review/agency-parse.js";

// Made-up fixtures only: the real agency docs are customer documents and never go in the repo.
const p = (text: string, props = "", runProps = "") => `<w:p>${props ? `<w:pPr>${props}</w:pPr>` : ""}<w:r>${runProps ? `<w:rPr>${runProps}</w:rPr>` : ""}<w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
const cell = (...paras: string[]) => `<w:tc><w:tcPr/>${paras.map((t) => p(t)).join("")}</w:tc>`;
const DOCX = `<w:document><w:body>
  ${p("Widget EMR", '<w:pStyle w:val="Title"/>')}${p("Sub line", '<w:pStyle w:val="Subtitle"/>')}
  ${p("Intro text &amp; more")}<w:p/>
  ${p("1. Vitals", '<w:pStyle w:val="Heading1"/>')}
  <w:tbl><w:tblPr/><w:tr>${cell("Item")}${cell("Default")}</w:tr><w:tr>${cell("M1033 risk", "second para")}${cell("Leave blank.")}</w:tr></w:tbl>
  ${p("Bold Heading", "", "<w:b/>")}${p("Not bold", "", '<w:b w:val="0"/>')}
</w:body></w:document>`;

test("docxLines: Title, Heading/bold-only headings, table rows as cells, entities decoded", () => {
  const lines = docxLines(DOCX);
  assert.deepEqual(lines, [
    { text: "Widget EMR", kind: "title" },
    { text: "Sub line", kind: "body" },
    { text: "Intro text & more", kind: "body" },
    { text: "1. Vitals", kind: "heading" },
    { text: "Item | Default", kind: "body" },
    { text: "M1033 risk second para | Leave blank.", kind: "body" },
    { text: "Bold Heading", kind: "heading" },
    { text: "Not bold", kind: "body" },
  ]);
  const { title, sections } = sectionsOf(lines);
  assert.equal(title, "Widget EMR");
  assert.deepEqual(sections.map((s) => [s.heading, s.codes]), [["Overview", []], ["1. Vitals", ["M1033"]], ["Bold Heading", []]]);
  assert.equal(sections[1]!.text, "Item | Default\nM1033 risk second para | Leave blank.");
});

test("pdfLines: running headers out, numbered/Page headings, title lines", () => {
  const page = (n: number, body: string) => `=== PAGE ${n} ===\n${body}\nAcme Footer Line\n`;
  const text = [page(1, "Acme Prefs\nSecond title\n1. Demographics\nM0040 name Intake"), page(2, "2. Pain\nGG0130 lime.pain.scale ok"), page(3, "Page 3: Wounds\n12. Not a heading.")].join("");
  const { title, sections } = sectionsOf(pdfLines(text));
  assert.equal(title, "Acme Prefs Second title");
  assert.deepEqual(sections.map((s) => s.heading), ["1. Demographics", "2. Pain", "Page 3: Wounds"]);
  assert.deepEqual(sections[1]!.codes, ["GG0130"]);
  assert.deepEqual(sections[1]!.keys, ["lime.pain.scale"]);
  assert.doesNotMatch(JSON.stringify(sections), /Acme Footer/);
});

const index: AgencyIndex = {
  builtAt: "b",
  docs: [
    { file: "m.pdf", agency: "Mission Home Health", ehr: "Axxess", visitTypes: ["soc"], title: "Mission SOC", sections: [
      { heading: "7. Pain", text: "Pain scale defaults to zero", codes: [], keys: [] },
      { heading: "3. Risk", text: "M1033 hospitalization risk: agency default none", codes: ["M1033"], keys: [] },
      { heading: "9. Other", text: "Unrelated words entirely", codes: [], keys: [] },
    ] },
    { file: "g.docx", agency: null, ehr: "Axxess", visitTypes: ["sn", "visit"], title: "Axxess SN Visit", sections: [
      { heading: "Vital Signs", text: "Vital sign parameters stay blank. " + "filler ".repeat(400), codes: [], keys: [] },
    ] },
    { file: "c.pdf", agency: "Care Dimensions", ehr: "Netsmart", visitTypes: ["soc"], title: "CD SOC", sections: [
      { heading: "Risk", text: "M1033 risk", codes: ["M1033"], keys: [] },
    ] },
  ],
};
const ctx = (title: string, description = "", comments = "", orgs: string[] = []): IssueContext => ({
  orgs,
  title,
  focus: `${title}\n${description}`,
  text: `${title}\n${description}\n${comments}`,
});

test("agency matching: orgs first, then title, description, comments; tolerant names; EHR via agency", () => {
  assert.deepEqual(issueAgencies(ctx("Purpose Driven HH: M1033", "Care Dimensions mentioned")), ["Purpose Driven"]);
  assert.deepEqual(issueAgencies(ctx("M1033 wrong", "", "", ["CareDimensions Hospice"])), ["Care Dimensions"]);
  assert.deepEqual(issueAgencies(ctx("M1033 wrong", "", "seen at new life")), ["New Life Home Health"]);
  assert.deepEqual(issueAgencies(ctx("Mission report of the week")), []);
  assert.deepEqual(issueEhrs(ctx("Purpose: x", "netsmart too"), ["Purpose Driven"]), ["Axxess"]);
  assert.deepEqual(issueEhrs(ctx("x", "kantime push"), []), ["KanTime"]);
});

test("agencyReference: own agency + generic EHR docs, scored by codes and words, under the cap", () => {
  const ref = agencyReference(index, ctx("Mission SOC: M1033 risk wrong"), 4_000)!;
  assert.deepEqual(ref.sources, ["Mission SOC · 3. Risk"]);
  assert.match(ref.text, /^\[Mission Home Health · Mission SOC · 3\. Risk\]\nM1033 hospitalization risk/);
  assert.doesNotMatch(ref.text, /CD SOC|Unrelated/);

  // Generic visit-note docs only fit a matching visit, never an OASIS time point or an unnamed visit type.
  assert.equal(agencyReference(index, ctx("Purpose SOC: vital signs parameters filled", "parameters should stay blank"), 600), null);
  assert.equal(agencyReference(index, ctx("Purpose: vital signs parameters filled", "parameters should stay blank"), 600), null);
  const both = agencyReference(index, ctx("Purpose SN visit: vital signs parameters filled", "parameters should stay blank"), 600)!;
  assert.deepEqual(both.sources, ["Axxess SN Visit · Vital Signs"]);
  assert.match(both.text, /^\[Axxess \(generic\) · Axxess SN Visit · Vital Signs\]/);
  assert.ok(both.text.length <= 600);

  assert.equal(agencyReference(index, ctx("Login page broken"), 4_000), null);
  assert.equal(agencyReference(index, ctx("Mission: nothing matching here"), 4_000), null);
});

test("sectionScore: 10 per shared code (sub-items match their parent), words in heading 2, text 1", () => {
  const s = { heading: "Pain status", text: "scale zero", codes: ["GG0130"], keys: ["lime.a"] };
  assert.equal(sectionScore(s, new Set(["GG0130A"]), new Set(["lime.a"]), words("pain scale")), 10 + 10 + 2 + 1);
});

test("loadAgencyDocs: null when the index is missing", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agency-"));
  assert.equal(loadAgencyDocs(dir), null);
  fs.writeFileSync(path.join(dir, "index.json"), JSON.stringify(index));
  assert.equal(loadAgencyDocs(dir)?.docs.length, 3);
});
