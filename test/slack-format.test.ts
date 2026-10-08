import assert from "node:assert/strict";
import { test } from "node:test";
import { chunkMessage, toSlackMrkdwn } from "../src/slack-format.js";

test("converts bold, links, headings and strikethrough", () => {
  assert.equal(toSlackMrkdwn("**done**"), "*done*");
  assert.equal(toSlackMrkdwn("[PR #12](https://github.com/a/b/pull/12)"), "<https://github.com/a/b/pull/12|PR #12>");
  assert.equal(toSlackMrkdwn("## Summary"), "*Summary*");
  assert.equal(toSlackMrkdwn("~~old~~"), "~old~");
});

test("leaves code alone", () => {
  assert.equal(toSlackMrkdwn("run `**not bold**`"), "run `**not bold**`");
  const block = "```\n# not a heading\n**x**\n```";
  assert.equal(toSlackMrkdwn(block), block);
});

test("chunks long messages on paragraph boundaries", () => {
  const paragraph = "a".repeat(300);
  const text = Array.from({ length: 20 }, () => paragraph).join("\n\n");
  const chunks = chunkMessage(text, 1000);
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((c) => c.length <= 1000));
  assert.equal(chunks.join("\n\n"), text);
});
