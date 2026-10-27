/** OASIS item codes named in free text, and how they map to manual entries. Shared by the agenda and the review hub. */
import { manualSection, type ManualIndex, type ManualItem } from "./lookup.js";

const OASIS = /\b(GG\d{4}[A-Z]?\d?|[A-O]\d{4}[A-Z]?)\b/g;

/** OASIS item codes (`M1830`, `GG0170C1`) named anywhere in the text, in order, with repeats. */
export function oasisCodes(text: string): string[] {
  return [...text.matchAll(OASIS)].map((m) => m[1]!);
}

/**
 * The manual entries behind codes or Lime form keys, each once, in order: the most specific entry, then its parent
 * for sub-items (`GG0170C1` → GG0170C, GG0170). Keys the manual doesn't cover (`lime.*`, unknown codes) are dropped.
 */
export function manualItems(manual: ManualIndex, keys: string[]): ManualItem[] {
  const out = new Map<string, ManualItem>();
  for (const key of keys) {
    const hit = manualSection(manual, key);
    for (const item of hit ? [hit.item, hit.parent] : []) if (item && !out.has(item.code)) out.set(item.code, item);
  }
  return [...out.values()];
}
