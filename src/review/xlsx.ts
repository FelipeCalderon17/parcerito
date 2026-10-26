/**
 * A minimal .xlsx reader (no deps): the zip's entries via zlib, shared strings, each sheet's cell text and the
 * hyperlinks on its cells (`<hyperlink ref r:id>` → the sheet's rels targets). Enough for a meeting spreadsheet.
 */
import fs from "node:fs";
import zlib from "node:zlib";

/** One cell: its text and every hyperlink on it. */
export interface Cell {
  text: string;
  links: string[];
}

export interface Sheet {
  name: string;
  /** Rows by position (row 1 = index 0); missing cells are blank. */
  rows: Cell[][];
}

/** Every file in a zip, by name (stored or deflated entries, read from the central directory). */
export function unzip(buf: Buffer): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  let eocd = buf.length - 22;
  while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  if (eocd < 0) throw new Error("not a zip file");
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let i = 0; i < count; i++) {
    const method = buf.readUInt16LE(p + 10);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString("utf8");
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const data = buf.subarray(start, start + size);
    out.set(name, method === 8 ? zlib.inflateRawSync(data) : Buffer.from(data));
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

/** XML text unescaped (named and numeric entities). */
export function unescapeXml(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e: string) =>
    e[0] === "#" ? String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : (ENTITIES[e] ?? m),
  );
}

const attr = (tag: string, name: string) => tag.match(new RegExp(`\\s${name}="([^"]*)"`))?.[1];
/** The text of every `<t>` in a fragment (rich-text runs joined; phonetic `<rPh>` runs left out). */
const texts = (xml: string) =>
  [...xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, "").matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((m) => unescapeXml(m[1]!)).join("");

/** The shared strings table, in order. */
export function sharedStrings(xml: string): string[] {
  return [...xml.matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => texts(m[1]!));
}

/** A rels file's relationship id → target. */
export function relTargets(xml: string): Map<string, string> {
  return new Map([...xml.matchAll(/<Relationship\b[^>]*>/g)].map((m) => [attr(m[0], "Id") ?? "", unescapeXml(attr(m[0], "Target") ?? "")]));
}

/** "AB12" → [row index 11, column index 27]. */
export function cellIndex(ref: string): [number, number] {
  const m = ref.match(/^([A-Z]+)(\d+)$/);
  if (!m) throw new Error(`bad cell ref ${ref}`);
  const col = [...m[1]!].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
  return [Number(m[2]) - 1, col];
}

/** A worksheet's rows: shared, inline and plain values, plus the hyperlinks (`rels`: the sheet's rel id → URL). */
export function sheetRows(xml: string, strings: string[], rels: Map<string, string> = new Map()): Cell[][] {
  const rows: Cell[][] = [];
  const at = (ref: string) => {
    const [r, c] = cellIndex(ref);
    const row = (rows[r] ??= []);
    for (let i = row.length; i <= c; i++) row[i] = { text: "", links: [] };
    return row[c]!;
  };
  for (const m of xml.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
    const head = m[1]!;
    const body = m[2] ?? "";
    const ref = attr(head, "r");
    if (!ref) continue;
    const type = attr(head, "t");
    const v = body.match(/<v>([\s\S]*?)<\/v>/)?.[1];
    const text = type === "s" ? (strings[Number(v)] ?? "") : type === "inlineStr" ? texts(body) : unescapeXml(v ?? "");
    at(ref).text = text;
  }
  for (const m of xml.matchAll(/<hyperlink\b[^>]*>/g)) {
    const ref = attr(m[0], "ref");
    const id = attr(m[0], "r:id");
    const url = id ? rels.get(id) : undefined;
    // A range ref ("A1:B2") links its first cell.
    if (ref && url) at(ref.split(":")[0]!).links.push(url);
  }
  for (const row of rows) if (row) for (let i = 0; i < row.length; i++) row[i] ??= { text: "", links: [] };
  return Array.from(rows, (r) => r ?? []);
}

/** Every sheet of a workbook file, in workbook order. */
export function readWorkbook(file: string): Sheet[] {
  const files = unzip(fs.readFileSync(file));
  const read = (name: string) => files.get(name)?.toString("utf8") ?? "";
  const strings = sharedStrings(read("xl/sharedStrings.xml"));
  const wbRels = relTargets(read("xl/_rels/workbook.xml.rels"));
  return [...read("xl/workbook.xml").matchAll(/<sheet\b[^>]*>/g)].map((m) => {
    const target = wbRels.get(attr(m[0], "r:id") ?? "") ?? "";
    const sheetPath = target.startsWith("/") ? target.slice(1) : `xl/${target}`;
    const relsPath = sheetPath.replace(/([^/]+)$/, "_rels/$1.rels");
    return { name: unescapeXml(attr(m[0], "name") ?? ""), rows: sheetRows(read(sheetPath), strings, relTargets(read(relsPath))) };
  });
}
