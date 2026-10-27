import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { briefPrompt, manualBriefs } from "../src/review/brief.js";
import { explainManual } from "../src/review/items.js";
import type { Item } from "../src/review/types.js";

const item = () =>
  ({
    id: "ENG-1",
    title: "M1850 bedbound",
    panel: { blocks: [{ cls: "manual", title: "📘 CMS OASIS-E2 manual", text: "M1850 Transferring · p.129–130" }] },
  }) as unknown as Item;
const notes = [{ code: "M1850", title: "Transferring", pages: [129, 130] as [number, number], notes: "Code 5 = bedfast (p.130)" }];

test("manualBriefs: one call per item, cached by input; the card shows the brief plus one pages line", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "brief-"));
  let calls = 0;
  const generate = async (prompt: string) => {
    calls++;
    assert.match(prompt, /M1850 Transferring \(p\.129–130\)/);
    return "Bedfast patients are code 5 (p.130); the prompt should say so.";
  };
  const first = await manualBriefs({ CLAUDE_MODEL: "x" }, [{ item: item(), notes }], dir, generate);
  const again = await manualBriefs({ CLAUDE_MODEL: "x" }, [{ item: item(), notes }], dir, generate);
  assert.equal(calls, 1);
  assert.equal(again.get("ENG-1"), first.get("ENG-1"));
  const it = item();
  explainManual(it, notes, first.get("ENG-1"));
  assert.equal(it.panel.blocks[0]!.text, "Bedfast patients are code 5 (p.130); the prompt should say so.\n\nManual: M1850 p.129–130");
  assert.match(briefPrompt(item(), notes), /at most 70 words/);
});
