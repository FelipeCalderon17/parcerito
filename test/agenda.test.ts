import assert from "node:assert/strict";
import { test } from "node:test";
import type { Conversation } from "../src/agenda/collect.js";
import { localParts } from "../src/agenda/index.js";
import { issuesFor, slackTimestamps, sourceFooter, type LinkedIssue } from "../src/agenda/linear.js";
import { renderAgenda } from "../src/agenda/render.js";

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
    conversations: new Map([[conversation.id, conversation]]),
    warnings: [],
  });
  assert.ok(!html.includes("<script>alert"));
  assert.ok(html.includes("ENG-9 <b>new</b>"));
});
