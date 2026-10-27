import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { decisionKey, loadSynced, planUpdates, saveSynced } from "../src/review/decisions.js";
import type { ApprovedDecision } from "../src/review/publish.js";

const d = (id: string, status: string, version = 1, linearIds = ["ENG-1"]): ApprovedDecision => ({
  id,
  title: `Item ${id}`,
  linearIds,
  status,
  answer: "Code 5 for bedfast patients.",
  scope: "Purpose · Axxess SOC · M1850",
  authorName: "Megan",
  createdAt: "2026-10-27T17:00:00Z",
  version,
});

test("planUpdates: approved moves to Todo, open only comments, synced versions skipped, no-issue listed", () => {
  const synced = new Set([decisionKey(d("issue:ENG-3", "approved"))]);
  const { updates, withoutIssue } = planUpdates(
    [d("issue:ENG-1", "approved"), d("issue:ENG-2", "needs-clarification", 1, ["ENG-2"]), d("issue:ENG-3", "approved"), d("agenda:x", "approved", 1, [])],
    synced,
    (id) => (id === "issue:ENG-1" ? ["Bedfast code?"] : []),
  );
  assert.deepEqual(updates.map((u) => [u.decision.id, u.action]), [["issue:ENG-1", "comment-and-todo"], ["issue:ENG-2", "comment"]]);
  assert.deepEqual(withoutIssue.map((x) => x.id), ["agenda:x"]);
  assert.match(updates[0]!.comment, /Approved for engineering[\s\S]*1\. Bedfast code\?[\s\S]*Code 5 for bedfast patients\.[\s\S]*Recorded by Megan on 2026-10-27/);
  assert.match(updates[1]!.comment, /Still needs clarification/);
  // An edited answer (new version) syncs again.
  assert.equal(planUpdates([d("issue:ENG-3", "approved", 2)], synced, () => []).updates.length, 1);
});

test("synced keys persist in DATA_DIR", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "synced-"));
  saveSynced(dir, new Set(["issue:ENG-1#v1"]));
  assert.deepEqual([...loadSynced(dir)], ["issue:ENG-1#v1"]);
});
