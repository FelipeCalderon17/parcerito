import assert from "node:assert/strict";
import { test } from "node:test";
import { buildIndex, contentLines, detectHeading, isRunningHeader } from "../src/manual/build.js";
import { loadManual, manualSection, type ManualIndex, type ManualItem } from "../src/manual/lookup.js";

const item = (code: string, pages: [number, number] = [1, 1]): ManualItem => ({ code, title: code, pages, text: code });

test("detectHeading reads item headings and skips TOC and body lines", () => {
  assert.deepEqual(detectHeading("M1830: Bathing"), { codes: ["M1830"], title: "Bathing" });
  assert.deepEqual(detectHeading("M1021/M1023: Primary Diagnosis/Other Diagnoses")?.codes, ["M1021", "M1023"]);
  assert.deepEqual(detectHeading("A2120 and A2121: Provision of Current Reconciled Medication List to")?.codes, ["A2120", "A2121"]);
  assert.deepEqual(detectHeading("C0200-C0500: Brief Interview for Mental Status (BIMS)"), {
    codes: ["C0200"],
    title: "Brief Interview for Mental Status (BIMS)",
    weak: true,
  });
  assert.deepEqual(detectHeading("GG0110. Prior Device Use")?.codes, ["GG0110"]);
  assert.deepEqual(detectHeading("GG0170C Lying to sitting on side of bed")?.codes, ["GG0170C"]);
  assert.deepEqual(detectHeading("GG0170A Roll Left and Right, GG0170B Sit to Lying, and GG0170C Lying to")?.codes, ["GG0170A", "GG0170B", "GG0170C"]);
  assert.deepEqual(detectHeading("Introduction to GG0130 Self-Care and GG0170 Mobility")?.codes, ["GG0130", "GG0170"]);
  for (const line of [
    "SECTION G: FUNCTIONAL STATUS .................................................................. 122",
    "M1830: Bathing ....................................................... 125",
    "GG0170C. Lying to sitting on side of bed The ability to move from lying on the back to sitting",
    "GG0170A, Roll left and right as 88, Not attempted due to medical or safety concerns.",
    "GG0170Q at SOC is coded 0-No. During the episode, the patient does begin",
    "M1033 Response 1.",
    "D0160 14",
  ]) {
    assert.equal(detectHeading(line), null, line);
  }
});

test("running headers and footers are stripped, content kept", () => {
  for (const line of [
    "OASIS-E2 ",
    "Effective 04/01/2026 ",
    "Centers for Medicare & Medicaid Services 125 ",
    "Chapter 3 Section G: Functional Status ",
    "Chapter 3",
    "Section A: Administrative Information",
    "OASIS Guidance Manual Introduction",
    "Appendix A Glossary and Common Acronyms",
  ]) {
    assert.equal(isRunningHeader(line, 125), true, line);
  }
  assert.equal(isRunningHeader("125", 125), true);
  assert.equal(isRunningHeader("14", 125), false);
  assert.equal(isRunningHeader("• Dash is not a valid response for this item.", 125), false);
  const page = { n: 7, lines: ["OASIS-E2 ", "Effective 04/01/2026 ", "Centers for Medicare & Medicaid Services 7 ", "", "M1830:   Bathing ", "Item Intent"] };
  assert.deepEqual(contentLines(page), ["M1830: Bathing", "Item Intent"]);
});

test("buildIndex splits Chapter 3 by item, merges repeats and joins wrapped titles", () => {
  const text = [
    "=== PAGE 1 ===",
    "SECTION G: FUNCTIONAL STATUS ............................ 2",
    "=== PAGE 2 ===",
    "CHAPTER 3: ITEM-BY-ITEM GUIDE",
    "SECTION G: FUNCTIONAL STATUS",
    "Section intro that belongs to no item.",
    "M1830: Bathing",
    "Item Intent",
    "Identifies the patient’s ability to bathe",
    "their entire body.",
    "=== PAGE 3 ===",
    "OASIS-E2",
    "Centers for Medicare & Medicaid Services 3",
    "• Dash is not a valid response for this item.",
    "M1311: Current Number of Unhealed Pressure Ulcers/Injuries at Each",
    "Stage",
    "Item Intent",
    "=== PAGE 4 ===",
    "GG0170: Description, Coding Tips, and Examples for GG0170 Mobility",
    "Activities",
    "GG0170C Lying to sitting on side of bed",
    "Sub-item tips.",
    "=== PAGE 9 ===",
    "M1830: Bathing",
    "More bathing guidance.",
    "APPENDIX A: GLOSSARY",
    "M1840: Toilet Transferring",
  ].join("\n");
  const index = buildIndex(text, { source: "s", version: "v", builtAt: "b" });
  assert.deepEqual(Object.keys(index.items), ["M1830", "M1311", "GG0170", "GG0170C"]);
  const bathing = index.items.M1830!;
  assert.deepEqual(bathing.pages, [2, 9]);
  assert.deepEqual(bathing.ranges, [[2, 3], [9, 9]]);
  // Page markers let the summaries cite the exact page a point comes from.
  assert.match(bathing.text, /^\[p\.2\]\nM1830: Bathing\nItem Intent\nIdentifies the patient’s ability to bathe their entire body\.\n\[p\.3\]\n/);
  assert.doesNotMatch(bathing.text, /OASIS-E2|Centers for Medicare|Section intro/);
  assert.equal(index.items.M1311!.title, "Current Number of Unhealed Pressure Ulcers/Injuries at Each Stage");
  assert.equal(index.items.GG0170!.title, "Mobility");
  assert.equal(index.items.GG0170C!.title, "Lying to sitting on side of bed");
});

test("manualSection resolves Lime form keys to the most specific entry plus its parent", () => {
  const manual: ManualIndex = {
    source: "s",
    version: "v",
    builtAt: "b",
    general: [],
    items: { GG0170: item("GG0170"), GG0170C: item("GG0170C"), M1830: item("M1830"), M1033: item("M1033"), M1311: item("M1311") },
  };
  const codes = (key: string) => {
    const hit = manualSection(manual, key);
    return hit && [hit.item.code, hit.parent?.code ?? null];
  };
  assert.deepEqual(codes("GG0170C1"), ["GG0170C", "GG0170"]);
  assert.deepEqual(codes("GG0170C_MOBILITY_SOCROC_PERF"), ["GG0170C", "GG0170"]);
  assert.deepEqual(codes("GG0170D_MOBILITY_SOCROC_PERF"), ["GG0170", null]);
  assert.deepEqual(codes("M1830_CRNT_BATHG"), ["M1830", null]);
  assert.deepEqual(codes("M1033_HOSP_RISK_CRNT_EXHSTN"), ["M1033", null]);
  assert.deepEqual(codes("M1311D1"), ["M1311", null]);
  assert.equal(manualSection(manual, "lime.foo"), null);
  assert.equal(manualSection(manual, "M9999_X"), null);
  assert.equal(manualSection(manual, ""), null);
});

test("the committed OASIS-E2 index has the agenda's usual items on plausible pages", () => {
  const manual = loadManual();
  assert.ok(manual, "manual/oasis-e2-2026-04-01.json is missing — run npm run manual-index");
  assert.equal(loadManual(), manual, "cached");
  assert.equal(manual.version, "2026-04-01");
  const expect: Record<string, [string, number, number]> = {
    M1830: ["Bathing", 120, 130],
    M1840: ["Toilet Transferring", 120, 130],
    M1800: ["Grooming", 118, 128],
    M1810: ["Upper Body", 118, 128],
    M1820: ["Lower Body", 118, 128],
    M1850: ["Transferring", 120, 135],
    GG0170: ["Mobility", 130, 175],
    GG0170C: ["Lying to Sitting", 150, 165],
    GG0130: ["Self-Care", 130, 160],
    M1033: ["Risk of Hospitalization", 175, 190],
    M0090: ["Date Assessment Completed", 35, 50],
    A1110: ["Language", 35, 45],
    D0150: ["Patient Mood Interview", 100, 115],
    D0160: ["Total Severity Score", 100, 115],
    M1311: ["Pressure Ulcers", 200, 220],
    M1324: ["Most Problematic", 210, 225],
  };
  for (const [code, [title, from, to]] of Object.entries(expect)) {
    const entry = manual.items[code];
    assert.ok(entry, code);
    assert.ok(entry.title.includes(title), `${code} title: ${entry.title}`);
    assert.ok(entry.pages[0] >= from && entry.pages[1] <= to && entry.pages[0] <= entry.pages[1], `${code} pages ${entry.pages}`);
    assert.ok(entry.text.length > 300, `${code} text`);
    assert.doesNotMatch(entry.text, /Effective 04\/01\/2026|=== PAGE/, code);
  }
  assert.deepEqual(manual.items.M1830!.pages, [125, 126]);
  assert.ok(manual.general.length >= 4 && manual.general.some((g) => /Conventions/.test(g.title)));
});
