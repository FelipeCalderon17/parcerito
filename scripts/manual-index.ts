/**
 * Indexes the CMS OASIS-E2 manual by item code into manual/oasis-e2-<version>.json (committed; shipped in the image).
 *   npm run manual-index -- <manual.txt> [--version 2026-04-01] [--source <url>]
 * manual.txt comes from scripts/extract-manual-text.py run on the CMS PDF.
 */
import fs from "node:fs";
import path from "node:path";
import { buildIndex } from "../src/manual/build.js";

const SOURCE = "https://www.cms.gov/files/document/final-oasis-e2-manual-04-01-2026.pdf";

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args.splice(i, 2)[1] : undefined;
};
const version = flag("version") ?? "2026-04-01";
const source = flag("source") ?? SOURCE;
const input = args[0];
if (!input) {
  console.error("usage: npm run manual-index -- <manual.txt> [--version 2026-04-01] [--source <url>]");
  process.exit(1);
}

const index = buildIndex(fs.readFileSync(input, "utf8"), { source, version, builtAt: new Date().toISOString() });
const out = path.join("manual", `oasis-e2-${version}.json`);
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, `${JSON.stringify(index, null, 2)}\n`);
const words = index.general.reduce((n, g) => n + g.text.split(/\s+/).length, 0);
console.log(`${out}: ${Object.keys(index.items).length} items, ${index.general.length} general passages (${words} words), ${Math.round(fs.statSync(out).size / 1024)} KB`);
