import assert from "node:assert/strict";
import { test } from "node:test";
import { needsAck } from "../src/agenda/ack.js";

const opts = { teamIds: ["UFELIPE", "UNICO"], botUserId: "UBOT" };

test("needsAck: a thread with only service-team and bot messages needs a reply", () => {
  assert.equal(needsAck([{ user: "UCODER", text: "M1400 is empty" }, { bot_id: "BDOTTERINO", text: "filed" }], opts), true);
});

test("needsAck: skips threads the team or this bot already answered", () => {
  assert.equal(needsAck([{ user: "UCODER" }, { user: "UFELIPE" }], opts), false);
  assert.equal(needsAck([{ user: "UCODER" }, { user: "UNICO" }], opts), false);
  assert.equal(needsAck([{ user: "UCODER" }, { user: "UBOT", bot_id: "B1" }], opts), false);
});
