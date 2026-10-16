import fs from "node:fs";
import path from "node:path";
import type { SlackFile } from "../attachments.js";
import type { AgendaCard } from "./render.js";

/** What "Copy decisions for parcerito" puts in the ```parcerito-sync block (base64 JSON). */
export interface SyncPayload {
  v: 1;
  agenda: string;
  decided: { id: string; note: string }[];
  open: { id: string; note: string }[];
  /** Card data for the open items, so items that only exist in the browser (added by hand) can carry over too. */
  cards: AgendaCard[];
}

export interface CarriedCard extends AgendaCard {
  carriedFrom: string;
  lastNote?: string;
}

interface CarryoverFile {
  fromAgenda: string;
  savedAt: string;
  items: CarriedCard[];
}

const BLOCK = /```\s*parcerito-sync\s*([A-Za-z0-9+/=\s]+?)\s*```/;

export function parseSync(text: string): SyncPayload | null {
  const match = text.match(BLOCK);
  if (!match) return null;
  try {
    const payload = JSON.parse(Buffer.from(match[1]!.replace(/\s/g, ""), "base64").toString("utf8"));
    return payload?.v === 1 && typeof payload.agenda === "string" ? (payload as SyncPayload) : null;
  } catch {
    return null;
  }
}

/**
 * Fallback when the block got lost on the way (e.g. trimmed before sending): reads the visible lists that
 * "Copy decisions" writes and matches the titles against that day's agenda.
 */
export function parseDecisionsText(raw: string, dataDir: string): SyncPayload | null {
  // Slack escapes these in message text.
  const text = raw.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
  const header = text.match(/Decisions from the Nico sync (\d{4}-\d{2}-\d{2})/);
  if (!header) return null;
  const agenda = header[1]!;
  const byTitle = new Map([...loadAgendaCards(dataDir, agenda).values()].map((c) => [c.title.trim(), c.id]));
  if (!byTitle.size) return null;

  const decidedPart = text.match(/Decided \(\d+\):\n([\s\S]*?)(?:\n\s*Not decided, carry over[^\n]*\n|$)/)?.[1] ?? "";
  const openPart = text.match(/Not decided, carry over[^\n]*\n([\s\S]*)$/)?.[1] ?? "";

  const decided: SyncPayload["decided"] = [];
  let current: { id: string; note: string } | null = null;
  for (const line of decidedPart.split("\n")) {
    const entry = line.match(/^- (.+?) \[[^\]]*\]: ?(.*)$/);
    const id = entry && byTitle.get(entry[1]!.trim());
    if (entry && id) {
      current = { id, note: entry[2]! };
      decided.push(current);
    } else if (current && !/^\s+sources: /.test(line)) {
      current.note += `\n${line}`;
    }
  }
  for (const d of decided) d.note = d.note.trim();

  const open = openPart
    .split("\n")
    .map((line) => line.match(/^- (.+?)(?:: (.*))?$/))
    .flatMap((m) => {
      // Titles can contain ": ", so try the whole line first.
      const whole = m && byTitle.get(`${m[1]}${m[2] !== undefined ? `: ${m[2]}` : ""}`.trim());
      if (whole) return [{ id: whole, note: "" }];
      const id = m && byTitle.get(m[1]!.trim());
      return id ? [{ id, note: m![2] ?? "" }] : [];
    });
  if (!decided.length && !open.length) return null;
  return { v: 1, agenda, decided, open, cards: [] };
}

/** The message without the machine-readable block, for prompts and notes. */
export function withoutSyncBlock(text: string): string {
  return text.replace(BLOCK, "").trim();
}

/** Long pastes arrive as Slack text snippets; read them so the block is found there too. */
export async function readTextFiles(files: SlackFile[], token: string): Promise<string> {
  const texts: string[] = [];
  for (const file of files) {
    if (!file.mimetype.startsWith("text/") || file.size > 2_000_000) continue;
    const res = await fetch(file.url, { headers: { Authorization: `Bearer ${token}` } }).catch(() => null);
    if (res?.ok) texts.push(await res.text());
  }
  return texts.join("\n\n");
}

/** Everything an agenda showed, by item id, read back from the files the build saved. */
export function loadAgendaCards(dataDir: string, date: string): Map<string, AgendaCard> {
  const dir = path.join(dataDir, "agenda", date);
  const cards = new Map<string, AgendaCard>();
  const html = path.join(dir, `nico-sync-${date}.html`);
  if (fs.existsSync(html)) {
    const match = fs.readFileSync(html, "utf8").match(/<script type="application\/json" id="agenda-data">(.*?)<\/script>/s);
    for (const card of (match ? JSON.parse(match[1]!).items : []) as AgendaCard[]) cards.set(card.id, card);
  }
  // Agendas from before the cards carried their own summary and proposal.
  const triageFile = path.join(dir, "triage.json");
  if (fs.existsSync(triageFile)) {
    const triage = JSON.parse(fs.readFileSync(triageFile, "utf8"));
    for (const item of triage.items ?? []) {
      const card = cards.get(item.id);
      if (card) Object.assign(card, { ...pick(item), ...card });
    }
    (triage.rejectedPatterns ?? []).forEach((p: { finding: string; proposal: string }, i: number) => {
      const card = cards.get(`rejected-${i}`);
      if (card) Object.assign(card, { summary: p.finding, proposal: p.proposal, ...card });
    });
  }
  return cards;
}

function pick(item: { urgency?: string; customers?: string[]; summary?: string; proposal?: string }) {
  return { urgency: item.urgency, customers: item.customers, summary: item.summary, proposal: item.proposal };
}

/** Saves the open items of a sync; they show up at the top of the next agenda until they're decided. */
export function saveCarryover(dataDir: string, payload: SyncPayload): CarriedCard[] {
  const known = loadAgendaCards(dataDir, payload.agenda);
  const fromBrowser = new Map(payload.cards.map((c) => [c.id, c]));
  const items = payload.open.flatMap(({ id, note }) => {
    const card = known.get(id) ?? fromBrowser.get(id);
    if (!card) return [];
    const carriedFrom = (card as Partial<CarriedCard>).carriedFrom ?? payload.agenda;
    return [{ ...card, carriedFrom, lastNote: note || (card as Partial<CarriedCard>).lastNote }];
  });
  const file: CarryoverFile = { fromAgenda: payload.agenda, savedAt: new Date().toISOString(), items };
  writeJson(path.join(dataDir, "agenda", "carryover.json"), file);
  writeJson(path.join(dataDir, "agenda", payload.agenda, "decisions.json"), payload);
  return items;
}

/** Open items from an earlier sync (never from the agenda being built, so a same-day rebuild doesn't repeat them). */
export function loadCarryover(dataDir: string, date: string): CarriedCard[] {
  const file = path.join(dataDir, "agenda", "carryover.json");
  if (!fs.existsSync(file)) return [];
  const carryover = JSON.parse(fs.readFileSync(file, "utf8")) as CarryoverFile;
  return carryover.fromAgenda < date ? carryover.items : [];
}

export function saveMeetingNotes(dataDir: string, date: string, notes: string): string {
  const file = path.join(dataDir, "agenda", date, "meeting-notes.md");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, notes);
  return file;
}

/** The newest meeting notes from before `date`. */
export function loadLastNotes(dataDir: string, date: string): { date: string; text: string } | null {
  const root = path.join(dataDir, "agenda");
  if (!fs.existsSync(root)) return null;
  const dates = fs
    .readdirSync(root)
    .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d) && d < date)
    .sort()
    .reverse();
  for (const d of dates) {
    const file = path.join(root, d, "meeting-notes.md");
    if (fs.existsSync(file)) return { date: d, text: fs.readFileSync(file, "utf8") };
  }
  return null;
}

function writeJson(file: string, value: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}
