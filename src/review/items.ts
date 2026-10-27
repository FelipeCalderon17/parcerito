/**
 * Review items from the daily agenda: reads the cards embedded in each nico-sync HTML, merges them across days and
 * derives what the agenda doesn't carry — the SQL field predicate and the priority group — from the item's text.
 */
import type { AgendaCard } from "../agenda/render.js";
import { manualItems, oasisCodes } from "../manual/codes.js";
import { loadManual, type ManualIndex } from "../manual/lookup.js";
import { pageRange, type CardCms } from "../manual/notes.js";
import type { DbRow, Group, Item } from "./types.js";

/** One agenda file's embedded data (`#agenda-data`), or null when the HTML doesn't carry it. */
export function parseAgendaHtml(html: string): { agenda: string; items: AgendaCard[] } | null {
  const match = html.match(/<script type="application\/json" id="agenda-data">(.*?)<\/script>/s);
  if (!match) return null;
  try {
    const data = JSON.parse(match[1]!) as { agenda?: unknown; items?: unknown };
    if (typeof data.agenda !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(data.agenda) || !Array.isArray(data.items)) return null;
    return { agenda: data.agenda, items: data.items as AgendaCard[] };
  } catch {
    return null;
  }
}

/** A card as it last appeared, with the first and last agenda it was on. */
export interface MergedCard {
  card: AgendaCard;
  first: string;
  last: string;
}

/**
 * Cards of several agendas by hub id: the newest card wins, `first` is the oldest date it appeared (or was carried
 * from). `rejected-N` ids are positional per day, so they're dated to keep different days' patterns apart.
 */
export function mergeAgendas(agendas: { agenda: string; items: AgendaCard[] }[]): Map<string, MergedCard> {
  const out = new Map<string, MergedCard>();
  for (const { agenda, items } of [...agendas].sort((a, b) => a.agenda.localeCompare(b.agenda))) {
    for (const card of items) {
      const id = hubId(card.id, agenda);
      const prev = out.get(id);
      const first = [prev?.first ?? agenda, card.carriedFrom ?? agenda].sort()[0]!;
      out.set(id, { card, first, last: agenda });
    }
  }
  return out;
}

/** The id a card gets in the hub: word-safe (it's an HTML id and a cache key), dated when positional. */
export function hubId(cardId: string, agenda: string): string {
  const safe = cardId.replace(/[^\w.-]/g, "_");
  return /^rejected-\d+$/.test(safe) ? `${agenda}-${safe}` : safe;
}

// ---------- Fields & group ----------

const LIME = /\blime\.[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*/g;
const SAFE = /^[A-Za-z0-9_.]+$/;
const NARRATIVE = /narrative|template|summary.?note/i;

/** OASIS item codes and `lime.*` field keys named anywhere in the text, each once, in order. */
export function fieldKeys(text: string): { oasis: string[]; lime: string[] } {
  const uniq = (list: string[]) => [...new Set(list.filter((k) => SAFE.test(k)))].slice(0, 40);
  return { oasis: uniq(oasisCodes(text)), lime: uniq([...text.matchAll(LIME)].map((m) => m[0])) };
}

/**
 * SQL predicate on `fd` for the keys. Only `[A-Za-z0-9_.]` ever reaches the SQL (they come from Slack text);
 * `false` when nothing was named.
 */
export function fieldPredicate(keys: { oasis: string[]; lime: string[] }): string {
  const oasis = keys.oasis.filter((k) => SAFE.test(k));
  const lime = keys.lime.filter((k) => SAFE.test(k));
  const parts = [
    ...(oasis.length ? [`fd.key ~* '^(${oasis.join("|")})'`] : []),
    ...(lime.length ? [`fd.key in (${lime.map((k) => `'${k}'`).join(", ")})`] : []),
  ];
  return parts.length ? `(${parts.join(" or ")})` : "false";
}

/** Meeting group from the keys: M18xx → 1, GG → 2, other OASIS → 3, narrative-ish → 5, lime.* → 4, else 6. */
export function groupOf(keys: { oasis: string[]; lime: string[] }, title: string): Group {
  if (keys.oasis.some((k) => /^M18\d\d/.test(k))) return 1;
  if (keys.oasis.some((k) => k.startsWith("GG"))) return 2;
  if (keys.oasis.length) return 3;
  if (keys.lime.some((k) => NARRATIVE.test(k)) || NARRATIVE.test(title)) return 5;
  if (keys.lime.length) return 4;
  return 6;
}

// ---------- Items ----------

const URGENCY = { high: 0, medium: 1, low: 2 } as const;
const URGENCY_PILL = { high: "bad", medium: "warn", low: "info" } as const;
const CMS_VERDICT = { covered: "Covered by the manual", partial: "Manual: partial", "not-in-manual": "Not in manual" } as const;
const CMS_PILL = { covered: "good", partial: "warn", "not-in-manual": "bad" } as const;

/** What the card itself says (title, triage summary, proposal, checklist, rejected fields), without the chat. */
function ownText(card: AgendaCard): string {
  return [
    card.title,
    card.summary,
    card.proposal,
    ...(card.checklist ?? []).map((c) => c.text),
    ...card.sources.flatMap((s) => (s.kind === "db" ? s.rows.map((r) => r.field) : [])),
  ]
    .filter(Boolean)
    .join("\n");
}

/** Every text an agenda card carries: what fields it names and which visits it links come from here. */
export function cardText(card: AgendaCard): string {
  return [
    ownText(card),
    ...card.sources.flatMap((s) =>
      s.kind === "slack" ? s.messages.map((m) => m.text) : s.kind === "db" ? s.rows.map((r) => r.appLink) : [s.url],
    ),
  ]
    .filter(Boolean)
    .join("\n");
}

/** A merged agenda card as a review item. */
export function agendaItem(id: string, { card, first, last }: MergedCard, manual = loadManual()): Item {
  const text = cardText(card);
  const keys = fieldKeys(text);
  const rows: DbRow[] = card.sources.flatMap((s) => (s.kind === "db" ? s.rows : []));
  return {
    id,
    title: card.title,
    origin: { kind: "agenda", date: first, agenda: last, cardId: card.id },
    // Codes mentioned in passing in the chat would misplace the item, so only the card's own words set the group.
    group: groupOf(fieldKeys(ownText(card)), card.title),
    urgency: card.urgency,
    customers: card.customers,
    linear: [...new Set(card.issues)],
    slack: card.sources.flatMap((s) => (s.kind === "slack" ? [{ channel: s.channelId, ts: s.threadTs }] : [])),
    fields: fieldPredicate(keys),
    badges: [
      ...(card.urgency ? [{ text: card.urgency, kind: URGENCY_PILL[card.urgency] }] : []),
      ...(card.cms?.verdict ? [{ text: CMS_VERDICT[card.cms.verdict], kind: CMS_PILL[card.cms.verdict] }] : []),
      { text: first === last ? `Agenda ${first}` : `Agenda ${first} → ${last}`, kind: "info" },
    ],
    meta: [
      card.section,
      ...(card.customers?.length ? [card.customers.join(", ")] : []),
      ...(card.date ? [card.date] : []),
      ...(card.people ?? []).filter((p) => p.names.length).map((p) => `${p.label}: ${p.names.join(", ")}`),
    ],
    panel: {
      blocks: [
        ...cmsBlock(card, manual),
        ...(card.summary ? [{ cls: "what", title: "📝 What happened", text: card.summary }] : []),
        ...(card.proposal ? [{ cls: "proposal", title: "💡 Proposal", text: card.proposal }] : []),
        ...(card.lastNote ? [{ cls: "manual", title: "🗒 Last note", text: card.lastNote }] : []),
      ],
      questions: card.checklist?.length
        ? { title: "☑️ Checklist", items: card.checklist.map((c) => `${c.section} · ${c.type}: ${c.text}`) }
        : undefined,
      placeholder: "Decision, next step, owner…",
    },
    rows,
    text,
  };
}

/**
 * The "📘 CMS OASIS-E2 manual" panel block: the card's own manual answer, or for older cards a deterministic one
 * from the local index (codes, titles and pages its own words name, no summaries); none when it names no field.
 */
export function cmsBlock(card: AgendaCard, manual: ManualIndex | null): Item["panel"]["blocks"] {
  if (card.cms) return manualPanel(cmsText(card.cms));
  const rowKeys = card.sources.flatMap((s) => (s.kind === "db" ? s.rows.map((r) => r.field) : []));
  return manualBlock(ownText(card), rowKeys, manual);
}

const manualPanel = (text: string) => [{ cls: "manual", title: MANUAL_TITLE, text }];

/**
 * The deterministic manual block for a text and extra form keys: per resolved code `CODE Title · p.X–Y`, else the
 * lime.* line, else none.
 */
export function manualBlock(own: string, keys: string[], manual: ManualIndex | null): Item["panel"]["blocks"] {
  const items = manual ? manualItems(manual, [...oasisCodes(own), ...keys]) : [];
  if (items.length) return manualPanel(items.map((i) => `${i.code} ${i.title} · ${pageRange(i.pages)}`).join("\n"));
  if (fieldKeys(own).lime.length) return manualPanel("Agency field (lime.*) — not in the CMS manual");
  return [];
}

const MANUAL_TITLE = "📘 CMS OASIS-E2 manual";
/** The manual card once it carries the brief over the manual and the agency prefs. */
const DOCS_TITLE = "📘 What the docs say (CMS manual + agency prefs)";
const TRIAGE_VERDICT = { ...CMS_VERDICT, "n/a": "Not a manual question" } as const;

/** The item codes a deterministic manual block lists (`CODE Title · p.X–Y` lines). */
export function manualBlockCodes(item: Pick<Item, "panel">): string[] {
  const block = item.panel.blocks.find((b) => b.title === MANUAL_TITLE);
  return block ? [...block.text.matchAll(/^([A-Z]{1,2}\d{4}[A-Z]?\d?) /gm)].map((m) => m[1]!) : [];
}

/**
 * Turns the manual block from "where it is" into "what it says and what we should do": a one-paragraph brief when
 * there is one, else the classifier's conclusion
 * (verdict, reason, next step, agency prefs used) first, then each item's rule notes with their pages.
 */
export function explainManual(
  item: Item,
  notes: { code: string; title: string; pages: [number, number]; notes: string }[],
  brief?: string,
): void {
  const block = item.panel.blocks.find((b) => b.title === MANUAL_TITLE);
  if (!block) return;
  // The short brief (brief.ts) replaces the long notes; one line keeps where each item is.
  if (brief) {
    block.title = DOCS_TITLE;
    const where = [
      notes.length ? `Manual: ${notes.map((n) => `${n.code} ${pageRange(n.pages)}`).join(" · ")}` : "",
      item.agencySources?.length ? `Agency prefs: ${item.agencySources.join("; ")}` : "",
    ];
    block.text = [brief, ...where].filter(Boolean).join("\n\n");
    return;
  }
  const t = item.triage;
  const conclusion = t
    ? [`${TRIAGE_VERDICT[t.manualVerdict]} — ${t.reason}`, t.nextStep ? `→ What to do: ${t.nextStep}` : ""]
    : [];
  const prefs = item.agencySources?.length ? [`Agency prefs used: ${item.agencySources.join("; ")}`] : [];
  const rules = notes.map((n) => `${n.code} ${n.title} · ${pageRange(n.pages)}\n${n.notes}`);
  if (!conclusion.length && !rules.length) return;
  block.text = [...conclusion, ...prefs, ...(rules.length ? rules : [block.text])].filter(Boolean).join("\n\n");
}

function cmsText(cms: CardCms): string {
  const head = [cms.verdict && CMS_VERDICT[cms.verdict], cms.answer].filter(Boolean).join(" — ");
  const codes = cms.codes.map((c) => `${c.code} ${c.title} · ${pageRange(c.pages)}${c.notes ? `\n${c.notes}` : ""}`);
  return [head, ...codes].filter(Boolean).join("\n\n");
}

/** Whether an item was on an agenda since the last meeting, so its Linear/Slack/visit data is refetched, not read from cache. */
export function isFresh(item: Pick<Item, "origin">, since: string): boolean {
  return item.origin.kind === "agenda" && item.origin.agenda >= since;
}

/** Priority order: group, then urgency (high → low → none), then id. */
export function sortItems<T extends { group: number; urgency?: keyof typeof URGENCY; id: string }>(items: T[]): T[] {
  const rank = (i: T) => (i.urgency ? URGENCY[i.urgency] : 3);
  return [...items].sort((a, b) => a.group - b.group || rank(a) - rank(b) || a.id.localeCompare(b.id));
}
