/**
 * The CMS OASIS-E2 manual indexed by item code (built once by `npm run manual-index`, committed under manual/), and a
 * lookup that maps Lime form keys (`GG0170C_MOBILITY_SOCROC_PERF`, `M1830_CRNT_BATHG`, `GG0170C1`) to their section.
 */
import fs from "node:fs";
import path from "node:path";

/** One item's guidance: its pages in the PDF (1-based, what a viewer's go-to-page uses) and the cleaned section text. */
export interface ManualItem {
  code: string;
  title: string;
  pages: [number, number];
  /** Every page range the text was merged from, when the item has more than one section (e.g. intro + examples). */
  ranges?: [number, number][];
  text: string;
}

export interface ManualPassage {
  title: string;
  pages: [number, number];
  text: string;
}

export interface ManualIndex {
  source: string;
  version: string;
  builtAt: string;
  /** General conventions from Chapters 1–3 intro (dash use, time points, who completes, …). */
  general: ManualPassage[];
  items: Record<string, ManualItem>;
}

export const DEFAULT_MANUAL = "manual/oasis-e2-2026-04-01.json";

const cache = new Map<string, ManualIndex | null>();

/** The index at `file` (default manual/oasis-e2-2026-04-01.json from the cwd), read once; null when the file is missing. */
export function loadManual(file = DEFAULT_MANUAL): ManualIndex | null {
  const abs = path.resolve(process.cwd(), file);
  if (!cache.has(abs)) cache.set(abs, fs.existsSync(abs) ? (JSON.parse(fs.readFileSync(abs, "utf8")) as ManualIndex) : null);
  return cache.get(abs)!;
}

/**
 * The most specific manual entry for a form key — `GG0170C1` → GG0170C (with parent GG0170), `M1033_HOSP_…` → M1033 —
 * or null for `lime.*` keys and codes the manual doesn't cover.
 */
export function manualSection(manual: ManualIndex, key: string): { item: ManualItem; parent: ManualItem | null } | null {
  const match = key.toUpperCase().match(/^((?:GG|[A-Z])\d{4})([A-Z0-9]*)/);
  if (!match) return null;
  const [, base, rest] = match as unknown as [string, string, string];
  for (let n = rest.length; n >= 0; n--) {
    const item = manual.items[base + rest.slice(0, n)];
    if (item) return { item, parent: n > 0 ? (manual.items[base] ?? null) : null };
  }
  return null;
}
