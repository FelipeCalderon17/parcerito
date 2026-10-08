import assert from "node:assert/strict";
import { test } from "node:test";
import { slackFiles } from "../src/attachments.js";

test("extracts downloadable files from Slack events", () => {
  const files = slackFiles([
    { name: "bug.png", mimetype: "image/png", size: 1234, url_private_download: "https://files.slack.com/a" },
    { name: "no-url.txt", mimetype: "text/plain" },
  ]);
  assert.deepEqual(files, [{ name: "bug.png", mimetype: "image/png", size: 1234, url: "https://files.slack.com/a" }]);
  assert.deepEqual(slackFiles(undefined), []);
});
