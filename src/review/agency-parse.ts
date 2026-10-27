/**
 * Turns agency preference docs (Megan's .docx/.pdf) into headed sections for agency.ts. Pure text in, sections out;
 * the docs themselves live outside the repo (see scripts/agency-docs.ts).
 */
import { oasisCodes } from "../manual/codes.js";
import { fieldKeys } from "./items.js";
import type { AgencySection } from "./agency.js";

/** One line of a doc: a heading (`title` for the doc's title) or body text (table rows as `cell | cell`). */
export interface DocLine {
  text: string;
  kind: "title" | "heading" | "body";
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const decode = (s: string) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e: string) =>
    e[0] === "#" ? String.fromCodePoint(Number(e[1] === "x" || e[1] === "X" ? `0${e.slice(1)}` : e.slice(1))) : (ENTITIES[e] ?? m),
  );
const squash = (s: string) => s.replace(/\s+/g, " ").trim();

/** A `<w:p>`'s text: its `<w:t>` runs, tabs and breaks as spaces. */
function paragraphText(xml: string): string {
  const parts = [...xml.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:(?:tab|br|cr)\b[^>]*\/>/g)].map((m) => (m[1] === undefined ? " " : decode(m[1])));
  return squash(parts.join(""));
}

/** Whether every run with text is bold (`<w:b/>`, not `w:val="0"/"false"`). */
function allBold(xml: string): boolean {
  const runs = [...xml.matchAll(/<w:r\b[^>]*>([\s\S]*?)<\/w:r>/g)].map((m) => m[1]!).filter((r) => /<w:t[\s>]/.test(r));
  return runs.length > 0 && runs.every((r) => /<w:b(?:\s+w:val="(?:1|true|on)")?\s*\/>/.test(r));
}

/** A paragraph outside tables as a line: Title → title, Heading* or short bold-only → heading, Subtitle → body. */
function paragraphLine(xml: string): DocLine | null {
  const text = paragraphText(xml);
  if (!text) return null;
  const style = xml.match(/<w:pStyle w:val="([^"]*)"/)?.[1] ?? "";
  if (/^Title$/i.test(style)) return { text, kind: "title" };
  if (/^Heading\d*$/i.test(style) || (text.length <= 80 && allBold(xml))) return { text, kind: "heading" };
  return { text, kind: "body" };
}

const TOKENS = /<(\/?)w:(tbl|tr|tc)\b[^>]*>|<w:p\b[^>]*\/>|<w:p\b[^>]*>[\s\S]*?<\/w:p>/g;

/** A .docx `word/document.xml` as lines in body order: paragraphs styled as above, each table row as `cell | cell`. */
export function docxLines(xml: string): DocLine[] {
  const out: DocLine[] = [];
  let depth = 0;
  let row: string[] = [];
  let cell: string[] = [];
  for (const m of xml.matchAll(TOKENS)) {
    const [token, close, tag] = m;
    if (tag === "tbl") depth += close ? -1 : 1;
    else if (tag === "tr" && !close) row = [];
    else if (tag === "tr" && close && depth === 1) {
      const cells = row.filter(Boolean);
      if (cells.length) out.push({ text: cells.join(" | "), kind: "body" });
    } else if (tag === "tc" && !close) cell = [];
    else if (tag === "tc" && close && depth === 1) row.push(squash(cell.join(" ")));
    else if (!tag && depth > 0) cell.push(paragraphText(token));
    else if (!tag) {
      const line = paragraphLine(token);
      if (line) out.push(line);
    }
  }
  return out;
}

const PDF_HEADING = /^(?:\d{1,2}\.\s+[A-Z][^|]{2,80}(?<!\.)|Page \d{1,2}: .{3,80})$/;

/**
 * pypdf text (`=== PAGE n ===` blocks, see scripts/extract-manual-text.py) as lines: running headers/footers (a
 * page's first or last line repeated on 3+ pages) dropped, `1. Section` / `Page 3: Section` lines as headings, the
 * first two lines before the first heading (if short) as the title.
 */
export function pdfLines(text: string): DocLine[] {
  const pages = text
    .split(/^=== PAGE \d+ ===$/m)
    .map((p) => p.split("\n").map(squash).filter(Boolean))
    .filter((p) => p.length);
  const edges = new Map<string, number>();
  for (const p of pages) for (const l of new Set([p[0]!, p.at(-1)!])) edges.set(l, (edges.get(l) ?? 0) + 1);
  const running = new Set([...edges].filter(([, n]) => n >= 3).map(([l]) => l));
  const lines = pages.flat().filter((l) => !running.has(l));
  const first = lines.findIndex((l) => PDF_HEADING.test(l));
  const title = (text: string, i: number) => i < Math.min(first, 2) && text.length <= 80;
  return lines.map((text, i) => ({ text, kind: PDF_HEADING.test(text) ? "heading" : title(text, i) ? "title" : "body" }));
}

/** The doc's title (its title lines joined) and its sections: each heading with the body lines up to the next one. */
export function sectionsOf(lines: DocLine[]): { title: string; sections: AgencySection[] } {
  const title = lines.filter((l) => l.kind === "title").map((l) => l.text).join(" ");
  const sections: AgencySection[] = [];
  let heading = "Overview";
  let body: string[] = [];
  const flush = () => {
    const text = body.join("\n").trim();
    if (text) {
      const keys = fieldKeys(text);
      sections.push({ heading, text, codes: [...new Set(oasisCodes(text))], keys: keys.lime });
    }
    body = [];
  };
  for (const l of lines) {
    if (l.kind === "heading") {
      flush();
      heading = l.text;
    } else if (l.kind === "body") body.push(l.text);
  }
  flush();
  return { title, sections };
}
