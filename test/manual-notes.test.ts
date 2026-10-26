import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { mentionedCodes } from "../src/agenda/index.js";
import { renderAgenda } from "../src/agenda/render.js";
import { triageSchema } from "../src/agenda/triage.js";
import { manualItems, oasisCodes } from "../src/manual/codes.js";
import type { ManualIndex, ManualItem } from "../src/manual/lookup.js";
import { cardCms, describeNotes, manualNotes, type NotesModel } from "../src/manual/notes.js";

const item = (code: string, pages: [number, number] = [1, 1]): ManualItem => ({ code, title: `${code} title`, pages, text: `${code} text` });
const manual: ManualIndex = {
  source: "s",
  version: "v1",
  builtAt: "b",
  general: [{ title: "1.5.8 Conventions for Completing OASIS", pages: [12, 12], text: "dash rules" }],
  items: { GG0170: item("GG0170", [136, 156]), GG0170C: item("GG0170C", [156, 158]), M1830: item("M1830", [125, 126]) },
};

test("oasisCodes and manualItems: codes from text, deduped after resolving, GG parent included", () => {
  assert.deepEqual(oasisCodes("M1830 and GG0170C1, again M1830; ENG-3523 lime.x"), ["M1830", "GG0170C1", "M1830"]);
  const codes = manualItems(manual, ["M1830", "GG0170C1", "M1830_CRNT_BATHG", "GG0170C_MOBILITY_SOCROC_PERF", "lime.vitals", "M9999"]);
  assert.deepEqual(codes.map((i) => i.code), ["M1830", "GG0170C", "GG0170"]);
});

test("mentionedCodes ranks codes from chats and rejected rows by count", () => {
  const msg = (text: string) => ({ ts: "1", author: "a", external: true, inWindow: true, text, url: "" });
  const conversations = [{ id: "c", channelId: "C", channelName: "x", rootTs: "1", url: "", messages: [msg("M1830 M1830"), msg("GG0170C")] }];
  const rejected = { exportedAt: new Date(), total: 3, groups: [{ form: "f", fieldKey: "M1033_HOSP", fieldLabel: "l", rows: [{}, {}, {}] as never }] };
  assert.deepEqual(mentionedCodes(conversations, rejected), ["M1033_HOSP", "M1830", "GG0170C"]);
});

test("manualNotes generates once per code, then reads the cache without calling the model", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "notes-"));
  const config = { CLAUDE_MODEL: "x", DATA_DIR: dataDir };
  const prompts: string[] = [];
  const generate: NotesModel = async (prompt) => {
    prompts.push(prompt);
    if (prompt.includes("about GG0170 ")) throw new Error("boom");
    return ["Measures bathing (p.125)", " ", "Dash not valid (p.126)"];
  };
  const first = await manualNotes(config, ["M1830_CRNT_BATHG", "GG0170C1", "M1830"], { manual, generate });
  // GG0170 failed: logged and skipped, the rest still comes back.
  assert.deepEqual(first.map((n) => n.code), ["M1830", "GG0170C"]);
  assert.equal(first[0]!.notes, "Measures bathing (p.125)\nDash not valid (p.126)");
  assert.deepEqual(first[0]!.pages, [125, 126]);
  assert.equal(prompts.length, 3);
  assert.match(prompts[0]!, /M1830 text/);
  assert.match(prompts[0]!, /dash rules/);
  assert.ok(fs.existsSync(path.join(dataDir, "manual-notes", "v1", "M1830.json")));

  const cached = await manualNotes(config, ["M1830", "GG0170C"], {
    manual,
    generate: async () => assert.fail("cache hit must not call the model"),
  });
  assert.deepEqual(cached, first);
  assert.deepEqual(await manualNotes(config, ["M1830"], { manual: null, generate }), []);
});

test("describeNotes cuts at whole notes; cardCms resolves triage codes to notes", () => {
  const notes = [
    { code: "M1830", title: "Bathing", pages: [125, 126] as [number, number], notes: "a (p.125)" },
    { code: "GG0170C", title: "Lying", pages: [156, 156] as [number, number], notes: "b".repeat(100) },
  ];
  assert.equal(describeNotes(notes), "M1830 Bathing (p.125–126)\na (p.125)\n\nGG0170C Lying (p.156)\n" + "b".repeat(100));
  assert.equal(describeNotes(notes, 50), "M1830 Bathing (p.125–126)\na (p.125)");
  assert.equal(cardCms(undefined, notes, manual), undefined);
  assert.deepEqual(cardCms({ codes: ["GG0170C1"], verdict: "partial", answer: "x" }, notes, manual), {
    codes: [
      { code: "GG0170C", title: "GG0170C title", pages: [156, 158], notes: "b".repeat(100) },
      { code: "GG0170", title: "GG0170 title", pages: [136, 156], notes: "" },
    ],
    verdict: "partial",
    answer: "x",
  });
});

test("triage schema offers an optional cms on items and rejected patterns", () => {
  for (const target of [triageSchema.properties.items.items, triageSchema.properties.rejectedPatterns.items]) {
    assert.ok("cms" in target.properties);
    assert.ok(!(target.required as readonly string[]).includes("cms"));
    assert.deepEqual(target.properties.cms.properties.verdict.enum, ["covered", "partial", "not-in-manual"]);
    assert.deepEqual(target.properties.cms.required, ["codes", "verdict", "answer"]);
  }
});

test("agenda HTML shows the manual block and escapes it", () => {
  const html = renderAgenda({
    date: "2026-10-26",
    since: new Date("2026-10-25T05:00:00Z"),
    until: new Date("2026-10-26T15:00:00Z"),
    timeZone: "America/Bogota",
    overview: "",
    items: [
      {
        id: "bath",
        section: "prompts",
        title: "Bathing",
        customers: [],
        urgency: "high",
        summary: "s",
        proposal: "p",
        conversationIds: [],
        issues: [],
        cms: {
          codes: [{ code: "M1830", title: "Bathing <x>", pages: [125, 126], notes: "Dash not valid <b> (p.126)" }],
          verdict: "covered",
          answer: "Code 6 <script> (p.126)",
        },
      },
      { id: "bug", section: "bugs", title: "Crash", customers: [], urgency: "low", summary: "s", proposal: "p", conversationIds: [], issues: [] },
    ],
    skipped: [],
    conversations: new Map(),
    rejected: null,
    rejectedPatterns: [],
    carried: [],
    lastNotes: null,
    warnings: [],
  });
  assert.equal(html.match(/📘 CMS OASIS-E2 manual/g)?.length, 1);
  assert.match(html, /<span class="verdict covered">Covered<\/span>/);
  assert.match(html, /Code 6 &#60;script&#62; \(p\.126\)/);
  assert.match(html, /<b>M1830<\/b> Bathing &#60;x&#62; <span class="muted">· p\.125–126<\/span><div class="quote">Dash not valid &#60;b&#62; \(p\.126\)<\/div>/);
  assert.doesNotMatch(html, /<script> \(p/);
  const data = JSON.parse(html.match(/id="agenda-data">(.*?)<\/script>/s)![1]!);
  assert.equal(data.items.find((c: { id: string }) => c.id === "bath").cms.verdict, "covered");
});
