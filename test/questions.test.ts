import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { condenseQuestions, MAX_QUESTIONS } from "../src/review/questions.js";
import type { Item } from "../src/review/types.js";

const item = (n: number) =>
  ({
    id: `ENG-${n}`,
    title: "M1850 bedbound",
    panel: { blocks: [] },
    triage: { classification: "needs-clarification", kind: "coding-rule", reason: "r", manualVerdict: "partial", questions: Array.from({ length: n }, (_, i) => `Q${i + 1}?`) },
  }) as unknown as Item;

test("condenseQuestions: only lists past the cap, cached by input, failure falls back to the first five", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "questions-"));
  let calls = 0;
  const generate = async () => {
    calls++;
    return ["A?", "B?", "C?"];
  };
  const short = item(3);
  const long = item(9);
  assert.equal(await condenseQuestions({ CLAUDE_MODEL: "m" }, [short, long], dir, generate), 1);
  assert.deepEqual(short.triage!.questions, ["Q1?", "Q2?", "Q3?"]);
  assert.deepEqual(long.triage!.questions, ["A?", "B?", "C?"]);
  const again = item(9);
  await condenseQuestions({ CLAUDE_MODEL: "m" }, [again], dir, generate);
  assert.equal(calls, 1);
  assert.deepEqual(again.triage!.questions, ["A?", "B?", "C?"]);

  const failing = item(24);
  await condenseQuestions({ CLAUDE_MODEL: "m" }, [failing], dir, async () => {
    throw new Error("down");
  });
  assert.equal(failing.triage!.questions.length, MAX_QUESTIONS);
});
