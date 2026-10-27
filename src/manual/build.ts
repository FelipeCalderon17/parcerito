/**
 * Builds the OASIS manual index from the PDF's extracted text (`=== PAGE n ===` separated, see
 * scripts/extract-manual-text.py): strips the running headers/footers, splits Chapter 3 at item headings
 * (`M1830: Bathing`, `GG0170C Lying to sitting on side of bed`, …) and keeps a few general-convention passages.
 */
import type { ManualIndex, ManualItem, ManualPassage } from "./lookup.js";

export interface Page {
  n: number;
  lines: string[];
}

/** An item heading: the codes it opens a section for and the title. `weak` titles yield to a later heading's. */
export interface Heading {
  codes: string[];
  title: string;
  weak?: boolean;
}

/** Numbered Chapter 1–3 headings worth keeping as general conventions. */
export const GENERAL_SECTIONS = ["1.5.5", "1.5.6", "1.5.8", "1.5.8.1", "1.5.8.2", "2.1", "3.3"];

const CODE = String.raw`(?:GG|[A-Z])\d{4}`;
const COLON_HEADING = new RegExp(String.raw`^(${CODE}[A-Z]{0,2}\d?)((?:\s*(?:/|-|–|and)\s*(?:[A-Z]{1,2})?\d{4}[A-Z]{0,2})*)\s*:\s*(.*)$`);
const GG_SUB = /GG\d{4}[A-Z]{1,2}\b/g;
const TOC_LINE = /\.{5,}\s*\d+\s*$/;
const LABEL = /^(Item (Intent|Rationale)|Time Points|Response|Coding|Definitions?\b|DEFINITION|Examples?\b|Activities\b(?!.)|OASIS-E2)/;

/** Splits the extracted text into pages by its `=== PAGE n ===` markers. */
export function splitPages(text: string): Page[] {
  const pages: Page[] = [];
  for (const line of text.split(/\r?\n/)) {
    const marker = line.match(/^=== PAGE (\d+) ===$/);
    if (marker) pages.push({ n: Number(marker[1]), lines: [] });
    else pages.at(-1)?.lines.push(line);
  }
  return pages;
}

/** Running header/footer lines: "OASIS-E2", "Effective 04/01/2026", "Centers for Medicare & Medicaid Services 125", chapter/section/appendix banners, the bare page number. */
export function isRunningHeader(line: string, page: number): boolean {
  const s = line.trim();
  return (
    /^OASIS-E2$/.test(s) ||
    /^Effective \d\d\/\d\d\/\d{4}$/.test(s) ||
    /^Centers for Medicare (&|and) Medicaid Services(\s+\d+)?$/.test(s) ||
    /^Chapter \d+\s*:?$/.test(s) ||
    /^Chapter \d+ (Section [A-Z]{1,2}: .*|Item-By-Item Guide .*|Data Accuracy and Correction .*)$/.test(s) ||
    /^Section [A-Z]{1,2}: [^.]*$/.test(s) ||
    /^Appendix [A-Z] [A-Z][^.]*$/.test(s) ||
    /^(OASIS Guidance Manual Introduction|Data Accuracy and Correction of The OASIS Assessments:?)$/.test(s) ||
    s === String(page)
  );
}

/** A page's content lines: running headers/footers and blank lines dropped, inner whitespace collapsed. */
export function contentLines(page: Page): string[] {
  return page.lines
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter((l) => l && !isRunningHeader(l, page.n));
}

/**
 * The item heading a line opens, or null. Recognises `M1830: Bathing`, `M1021/M1023: …`, `A2120 and A2121: …`,
 * `C0200-C0500: …` (keyed to its first code), `GG0110. Prior Device Use`, GG sub-item headings (`GG0170C Lying to …`,
 * also grouped ones naming several sub-items) and `Introduction to GG0130 … and GG0170 …`. TOC lines never match.
 */
export function detectHeading(line: string): Heading | null {
  if (TOC_LINE.test(line)) return null;
  const colon = line.match(COLON_HEADING);
  if (colon) {
    const [, first, more, title] = colon as unknown as [string, string, string, string];
    const prefix = first.match(/^(GG|[A-Z])/)![1]!;
    const range = /[-–]/.test(more);
    const listed = range ? [] : (more.match(/(?:[A-Z]{1,2})?\d{4}[A-Z]{0,2}/g) ?? []);
    const codes = [first, ...listed.map((c) => (/^\d/.test(c) ? prefix + c : c))];
    return { codes, title: title.trim(), ...(range ? { weak: true } : {}) };
  }
  const dotted = line.match(/^(GG\d{4})\.\s+([A-Z].*)$/);
  if (dotted && line.length < 80) return { codes: [dotted[1]!], title: dotted[2]!.trim() };
  if (/^GG\d{4}[A-Z]{1,2}( [A-Z0-9(]|,\s*GG)/.test(line) && line.length <= 100) {
    return { codes: [...new Set(line.match(GG_SUB))], title: line.trim() };
  }
  const intro = line.match(/^Introduction to (.*)$/);
  if (intro && new RegExp(CODE).test(intro[1]!)) {
    return { codes: [...new Set(intro[1]!.match(new RegExp(CODE, "g")))], title: line.trim(), weak: true };
  }
  return null;
}

/** Whether a heading's title wraps onto `next`: it ends mid-phrase, or `next` is a short non-sentence that isn't a label or code line. */
export function continuesTitle(title: string, next: string | undefined): boolean {
  if (!next || LABEL.test(next) || TOC_LINE.test(next)) return false;
  if (!title || /(\b(and|or|of|to|the|for|at|in|is|that|with)|,)$/.test(title)) return true;
  if (/^GG\d{4}/.test(title) || new RegExp(`^${CODE}`).test(next) || /^Introduction to /.test(next)) return false;
  return next.length <= 60 && !/[.:?]$/.test(next) && !/^[•o] /.test(next);
}

/** The title a (possibly grouped) heading gives `code`: the text after it up to the next code, minus boilerplate. */
export function titleFor(code: string, heading: Heading): string {
  if (heading.codes.length > 1 && heading.codes.every((c) => c.startsWith("GG")) && !heading.weak) {
    const after = heading.title.split(new RegExp(String.raw`\b${code}\b`))[1] ?? "";
    const own = after.split(/\bGG\d{4}/)[0]!.replace(/(\s*(,|\band\b))+\s*$/, "").trim();
    if (own) return own;
  }
  const lead = heading.codes.length === 1 && heading.title.startsWith(code) ? heading.title.slice(code.length) : heading.title;
  return lead.replace(/^\.?\s*/, "").replace(new RegExp(String.raw`^Description, Coding Tips, and Examples for ${code}\s*`), "").trim();
}

/** Marks where a page starts inside an item's text, so summaries can cite exact pages. */
const PAGE_MARK = /^\[p\.\d+\]$/;

/** The section's lines with a `[p.N]` line wherever a new page starts. */
function pagedLines(lines: { text: string; page: number }[]): string[] {
  return lines.flatMap((l, i) => (i === 0 || l.page !== lines[i - 1]!.page ? [`[p.${l.page}]`, l.text] : [l.text]));
}

/** Joins wrapped PDF lines: a line starting lowercase continues the previous one; everything else starts a new line. */
export function normalizeText(lines: string[]): string {
  const out: string[] = [];
  for (const line of lines) {
    if (out.length && /^[a-z]/.test(line) && !/^o /.test(line) && !PAGE_MARK.test(out.at(-1)!)) out[out.length - 1] += ` ${line}`;
    else out.push(line);
  }
  return out.join("\n").trim();
}

interface Line {
  page: number;
  text: string;
}

interface Section {
  heading: Heading;
  lines: Line[];
}

/** Splits Chapter 3 (from its `CHAPTER 3:` banner to `APPENDIX A`) into item sections; `SECTION X:` banners close the open one. */
export function itemSections(lines: Line[]): Section[] {
  const sections: Section[] = [];
  let open: Section | null = null;
  let inChapter = false;
  for (let i = 0; i < lines.length; i++) {
    const { text } = lines[i]!;
    if (TOC_LINE.test(text)) continue;
    if (/^CHAPTER 3:/.test(text)) inChapter = true;
    if (/^APPENDIX [A-Z]:/.test(text)) inChapter = false;
    if (!inChapter) continue;
    if (/^SECTION [A-Z]{1,2}: /.test(text)) {
      open = null;
      continue;
    }
    const heading = detectHeading(text);
    if (heading) {
      const start = i;
      for (let joins = 0; joins < 2 && continuesTitle(heading.title, lines[i + 1]?.text); joins++) {
        heading.title = `${heading.title} ${lines[++i]!.text}`.trim();
        if (heading.codes.every((c) => /^GG\d{4}[A-Z]/.test(c))) heading.codes = [...new Set(heading.title.match(GG_SUB))];
      }
      open = { heading, lines: lines.slice(start, i + 1) };
      sections.push(open);
      continue;
    }
    open?.lines.push(lines[i]!);
  }
  return sections;
}

/** The numbered general passages named in `wanted` (Chapters 1–3 intro), each up to the next numbered heading. */
export function generalPassages(lines: Line[], wanted = GENERAL_SECTIONS): ManualPassage[] {
  const out: (ManualPassage & { body: string[] })[] = [];
  let open: (ManualPassage & { body: string[] }) | null = null;
  for (const { page, text } of lines) {
    if (TOC_LINE.test(text)) continue;
    if (/^APPENDIX [A-Z]:/.test(text) || /^SECTION [A-Z]{1,2}: /.test(text)) break;
    const numbered = text.match(/^(\d+\.\d+(?:\.\d+)*)\s+([A-Z].*)$/);
    if (numbered || /^CHAPTER \d+:/.test(text)) {
      open = numbered && wanted.includes(numbered[1]!) ? { title: `${numbered[1]} ${numbered[2]}`, pages: [page, page], text: "", body: [] } : null;
      if (open) out.push(open);
      continue;
    }
    if (open) {
      open.body.push(text);
      open.pages[1] = page;
    }
  }
  return out.map(({ title, pages, body }) => ({ title, pages, text: normalizeText(body) }));
}

/** Folds item sections into one entry per code, merging repeated codes in page order. */
export function mergeSections(sections: Section[]): Record<string, ManualItem> {
  const items: Record<string, ManualItem & { weak?: boolean }> = {};
  for (const { heading, lines } of sections) {
    const range: [number, number] = [lines[0]!.page, lines.at(-1)!.page];
    const text = normalizeText(pagedLines(lines));
    for (const code of heading.codes) {
      const prev = items[code];
      if (!prev) {
        items[code] = { code, title: titleFor(code, heading), pages: [...range], text, ...(heading.weak ? { weak: true } : {}) };
        continue;
      }
      if (prev.weak && !heading.weak) {
        prev.title = titleFor(code, heading);
        delete prev.weak;
      }
      prev.ranges = [...(prev.ranges ?? [prev.pages]), range];
      prev.pages = [Math.min(prev.pages[0], range[0]), Math.max(prev.pages[1], range[1])];
      prev.text = `${prev.text}\n\n${text}`;
    }
  }
  for (const item of Object.values(items)) delete item.weak;
  return items;
}

/** The full index from the extracted manual text. */
export function buildIndex(text: string, meta: { source: string; version: string; builtAt: string }): ManualIndex {
  const lines = splitPages(text).flatMap((page) => contentLines(page).map((t) => ({ page: page.n, text: t })));
  return { ...meta, general: generalPassages(lines), items: mergeSections(itemSections(lines)) };
}
