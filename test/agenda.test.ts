import assert from "node:assert/strict";
import { test } from "node:test";
import type { Conversation } from "../src/agenda/collect.js";
import { localParts } from "../src/agenda/index.js";
import { issuesFor, slackTimestamps, sourceFooter, type LinkedIssue } from "../src/agenda/linear.js";
import { groupRejected, type RejectedField } from "../src/agenda/rejected.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { renderAgenda } from "../src/agenda/render.js";
import { loadCarryover, parseSync, saveCarryover, withoutSyncBlock, type SyncPayload } from "../src/agenda/sync.js";

const conversation: Conversation = {
  id: "C1-1792084072.359189",
  channelId: "C1",
  channelName: "mission-home-care-chat",
  rootTs: "1792084072.359189",
  url: "https://lime.slack.com/archives/C1/p1792084072359189",
  messages: [
    {
      ts: "1792084072.359189",
      author: "Abigail",
      external: true,
      inWindow: true,
      text: "<script>alert(1)</script> M1400 is empty",
      url: "https://lime.slack.com/archives/C1/p1792084072359189",
    },
    {
      ts: "1792084100.000100",
      author: "Abigail",
      external: true,
      inWindow: true,
      text: "same on another chart",
      url: "https://lime.slack.com/archives/C1/p1792084100000100",
    },
  ],
};

test("finds Slack timestamps in Dotterino checkpoints and permalinks", () => {
  assert.deepEqual(
    slackTimestamps(
      "Source checkpoint: channel C1; root/message 1792084072.359189\nhttps://x.slack.com/archives/C1/p1792084100000100",
    ),
    ["1792084072.359189", "1792084100.000100"],
  );
});

test("a conversation is tracked if any of its messages is cited", () => {
  const issue: LinkedIssue = { identifier: "ENG-1", title: "M1400", url: "https://linear.app/x", state: "Triage" };
  assert.deepEqual(issuesFor(conversation, new Map([["1792084100.000100", [issue]]])), [issue]);
  assert.deepEqual(issuesFor(conversation, new Map()), []);
});

test("our footer is recognized as tracking the conversation", () => {
  assert.ok(slackTimestamps(sourceFooter([conversation])).includes(conversation.rootTs));
});

test("local time in Bogota", () => {
  // 2026-10-16 15:00 UTC is Friday 10:00 in Bogota.
  assert.deepEqual(localParts(new Date("2026-10-16T15:00:00Z"), "America/Bogota"), {
    date: "2026-10-16",
    weekday: 5,
    hour: 10,
    minute: 0,
  });
});

test("agenda HTML escapes Slack text", () => {
  const html = renderAgenda({
    date: "2026-10-16",
    since: new Date("2026-10-14T05:00:00Z"),
    until: new Date("2026-10-16T15:00:00Z"),
    timeZone: "America/Bogota",
    overview: "One thing",
    items: [
      {
        id: "m1400",
        section: "prompts",
        title: "M1400 omitted",
        customers: ["Mission"],
        urgency: "high",
        summary: "Abigail reports M1400 empty",
        proposal: "Check retrieval",
        conversationIds: [conversation.id],
        issues: [{ identifier: "ENG-9", title: "M1400", url: "https://linear.app/x", state: "Triage", isNew: true }],
      },
    ],
    skipped: [],
    conversations: new Map([[conversation.id, conversation]]),
    rejected: null,
    rejectedPatterns: [],
    carried: [
      {
        id: "megan-list",
        title: "Megan's SN visit list",
        section: "Prompts",
        issues: ["ENG-3472"],
        checklist: [{ section: "Vitals", type: "Warning", text: "Flag missing temperature" }],
        sources: [],
        carriedFrom: "2026-10-15",
        lastNote: "Felipe to draft prompt changes",
        issueDetails: [{ identifier: "ENG-3472", title: "Astra QA", url: "https://linear.app/x", state: "Triage" }],
      },
    ],
    lastNotes: { date: "2026-10-15", text: "Agreed to tune the SN narrative prompt" },
    warnings: [],
  });
  assert.ok(!html.includes("<script>alert"));
  assert.ok(html.includes("ENG-9 <b>new</b>"));
  assert.ok(html.includes('data-title="M1400 omitted"'));
  const data = JSON.parse(html.match(/<script type="application\/json" id="agenda-data">(.*?)<\/script>/s)![1]!);
  const m1400 = data.items.find((i: { id: string }) => i.id === "m1400");
  assert.equal(m1400.sources[0].kind, "slack");
  assert.equal(m1400.sources[0].channelId, "C1");
  assert.equal(m1400.summary, "Abigail reports M1400 empty");
  assert.ok(html.includes("from 2026-10-15") && html.includes("Felipe to draft prompt changes"));
  assert.ok(html.includes('data-key="megan-list-0"'));
  assert.ok(html.includes("Notes from the last sync (2026-10-15)"));
  // Slack text with </script> must not break out of the JSON block.
  assert.equal(m1400.sources[0].messages[0].text, "<script>alert(1)</script> M1400 is empty");
});

test("groups rejected suggestions by form and field, most rejected first", () => {
  const row = (form: string, field_key: string): RejectedField => ({
    id: `${form}-${field_key}-${Math.random()}`,
    decided_at: "2026-10-15T12:00:00Z",
    organization: "Mission",
    form,
    field_key,
    field_label: field_key,
    section: null,
    rejected_via: "review",
    reason: "Transcript only",
    ai_value: "2",
    coder_value: null,
  });
  const groups = groupRejected([row("SOC", "A1005"), row("SOC", "GG0100A"), row("SOC", "GG0100A"), row("ROC", "GG0100A")]);
  assert.deepEqual(
    groups.map((g) => `${g.form}:${g.fieldKey}:${g.rows.length}`),
    ["SOC:GG0100A:2", "SOC:A1005:1", "ROC:GG0100A:1"],
  );
});

test("decisions pasted in Slack round-trip, and open items carry over to later agendas only", () => {
  const payload: SyncPayload = {
    v: 1,
    agenda: "2026-10-16",
    decided: [{ id: "a", note: "ship it" }],
    open: [{ id: "manual-1", note: "next time" }],
    cards: [{ id: "manual-1", title: "Added by hand", section: "Prompts", issues: [], sources: [], manual: true }],
  };
  // What the browser builds: base64 of the UTF-8 JSON inside a fenced block, around the readable text.
  const message = `Decisions from the Nico sync 2026-10-16 ✅\n\n\`\`\`parcerito-sync\n${Buffer.from(JSON.stringify(payload)).toString("base64")}\n\`\`\``;
  assert.deepEqual(parseSync(message), payload);
  assert.equal(withoutSyncBlock(message), "Decisions from the Nico sync 2026-10-16 ✅");
  assert.equal(parseSync("no block here"), null);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agenda-"));
  const carried = saveCarryover(dir, payload);
  assert.deepEqual(carried.map((c) => [c.id, c.carriedFrom, c.lastNote]), [["manual-1", "2026-10-16", "next time"]]);
  assert.equal(loadCarryover(dir, "2026-10-16").length, 0);
  assert.equal(loadCarryover(dir, "2026-10-19").length, 1);
});
