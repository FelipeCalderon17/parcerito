/**
 * Agency documentation preferences (Megan's per-agency docs, indexed by `npm run agency-docs`) as classifier
 * reference: the docs of the issue's agency (or its EHR's generic docs), their best sections for the issue's codes,
 * keys and words. The docs and index stay outside the repo, in `AGENCY_DOCS_DIR` (default ~/Desktop/Lime/agency-docs).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { oasisCodes } from "../manual/codes.js";
import { fieldKeys } from "./items.js";
import type { Pack } from "./types.js";

export interface AgencySection {
  heading: string;
  text: string;
  /** OASIS codes named in the section. */
  codes: string[];
  /** lime.* keys named in the section. */
  keys: string[];
}

export interface AgencyDoc {
  file: string;
  /** null = generic for its EHR (no agency named). */
  agency: string | null;
  ehr: string | null;
  /** Lower-case tags: soc, roc, recert, discharge, evaluation, reassessment, supervisory, visit, sn, pt, pta. */
  visitTypes: string[];
  title: string;
  sections: AgencySection[];
}

export interface AgencyIndex {
  builtAt: string;
  docs: AgencyDoc[];
}

/** What an issue is about, for picking sections. */
export interface IssueContext {
  /** Organization names from its visits (task.organization). */
  orgs: string[];
  title: string;
  /** Title + description (+ comments): agencies, EHRs and visit types are matched here. */
  text: string;
  /** Title + description: the words sections are scored on. */
  focus: string;
}

/** The reference text and the `doc · heading` of every section in it. */
export interface AgencyReference {
  text: string;
  sources: string[];
}

/** Agencies we know: how issues name them and their EHR (used for generic EHR docs when the agency has none). */
export const AGENCIES: { name: string; pattern: RegExp; ehr: string | null }[] = [
  { name: "Mission Home Health", pattern: /\bmission\b(?!\s+(?:report|feedback|statement))/i, ehr: "Axxess" },
  { name: "Purpose Driven", pattern: /\bpurpose(?:[- ]driven)?(?:\s+(?:hh|home health))?\b(?!\s+of\b)/i, ehr: "Axxess" },
  { name: "CareCo", pattern: /\bcare ?co\b/i, ehr: null },
  { name: "Care Dimensions", pattern: /\bcare ?dimensions\b/i, ehr: "Netsmart" },
  { name: "New Life Home Health", pattern: /\bnew ?life\b/i, ehr: "KanTime" },
  { name: "Astra Health", pattern: /\bastra\b/i, ehr: "Axxess" },
  { name: "SDQ", pattern: /\bsdq\b/i, ehr: "Axxess" },
  { name: "Universal", pattern: /\buniversal\b/i, ehr: "Netsmart" },
];
export const EHRS: { name: string; pattern: RegExp }[] = [
  { name: "Axxess", pattern: /\baxxess\b/i },
  { name: "Netsmart", pattern: /\bnetsmart\b/i },
  { name: "KanTime", pattern: /\bkan ?time\b/i },
  { name: "WellSky", pattern: /\b(?:wellsky|kinnser)\b/i },
];
const VISIT_TYPES: [string, RegExp][] = [
  ["soc", /\b(?:soc|start of care)\b/i],
  ["roc", /\b(?:roc|resumption of care)\b/i],
  ["recert", /\brecert(?:ification)?\b/i],
  ["discharge", /\bdischarge\b/i],
  ["evaluation", /\b(?:eval|evaluation|assessment)\b/i],
  ["reassessment", /\bre-?assessment\b/i],
  ["supervisory", /\bsupervisory\b/i],
  ["visit", /\b(?:visit note|regular visit|routine visit|follow-?up visit)\b/i],
  ["sn", /\b(?:sn|skilled nursing|nurs(?:e|ing))\b/i],
  ["pt", /\b(?:pt|physical therap(?:y|ist))\b/i],
  ["pta", /\bpta\b/i],
];
const STOP = new Set(
  "about after again also because been before being between both could does doing during each from have having into just more most only other over same should some such than that their them then there these they this those through under until very were what when where which while with would your issue issues field fields value values form forms visit visits agency lime prompt prompts answer answers recording recordings status source sources chart charts default defaults preference preferences selection selected note notes patient clinician evidence validate investigate proposal proposals omission omitted push pushed left blank documentation".split(" "),
);
/** Least section score to be used: own agency docs, generic EHR docs (stricter: the agency may do it differently). */
const MIN_OWN = 4;
const MIN_GENERIC = 6;
const LONG = 1_200;

/** The agency docs dir: `AGENCY_DOCS_DIR` or ~/Desktop/Lime/agency-docs. */
export function agencyDocsDir(): string {
  return process.env.AGENCY_DOCS_DIR || path.join(os.homedir(), "Desktop", "Lime", "agency-docs");
}

/** The agency docs index (`<dir>/index.json`), or null when it's missing (the classifier runs without it). */
export function loadAgencyDocs(dir = agencyDocsDir()): AgencyIndex | null {
  const file = path.join(dir, "index.json");
  return fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, "utf8")) as AgencyIndex) : null;
}

const rows = (v: unknown) => (Array.isArray(v) ? v : []) as Record<string, any>[];

/** An issue pack's context: its visits' organizations, its Linear text and title + description. */
export function issueContext(pack: Pack): IssueContext {
  const linear = pack.linear[0];
  const focus = [pack.item.title, linear?.description ?? ""].join("\n");
  const orgs = pack.visits.map((v) => String(rows(v.data.task)[0]?.organization ?? "")).filter(Boolean);
  return { orgs, title: pack.item.title, text: [focus, ...(linear?.comments.nodes.map((c) => c.body) ?? [])].join("\n"), focus };
}

const matches = <T extends { pattern: RegExp }>(list: T[], text: string) => list.filter((x) => x.pattern.test(text));

/** The agencies an issue is about: its visits' organizations, else the first of title, description, comments naming one. */
export function issueAgencies(ctx: IssueContext): string[] {
  for (const text of [ctx.orgs.join("\n"), ctx.title, ctx.focus, ctx.text]) {
    const hit = matches(AGENCIES, text);
    if (hit.length) return hit.map((a) => a.name);
  }
  return [];
}

/** The EHRs: the matched agencies' plus any the title names; with no agency, the first of title, description naming one. */
export function issueEhrs(ctx: IssueContext, agencies: string[]): string[] {
  const named = (text: string) => matches(EHRS, text).map((e) => e.name);
  const viaAgency = AGENCIES.filter((a) => agencies.includes(a.name) && a.ehr).map((a) => a.ehr!);
  if (agencies.length) return [...new Set([...viaAgency, ...named(ctx.title)])];
  return named(ctx.title).length ? named(ctx.title) : named(ctx.focus);
}

const TIME_POINTS = ["soc", "roc", "recert", "discharge"];
const DISCIPLINES = ["sn", "pt", "pta"];

/**
 * Whether a generic (no agency) doc fits the issue's visit: generic docs cover visit notes and PT evaluations, so they
 * never apply to OASIS time points (SOC/ROC/Recert/Discharge), and otherwise need the same kind of visit and, when
 * the issue names one, the same discipline.
 */
export function genericFits(doc: Pick<AgencyDoc, "visitTypes">, focus: string): boolean {
  const types = visitTypesOf(focus);
  if (types.some((t) => TIME_POINTS.includes(t))) return false;
  const kinds = types.filter((t) => !DISCIPLINES.includes(t));
  if (/\bvisits?\b/i.test(focus) && !kinds.includes("visit")) kinds.push("visit");
  if (!kinds.some((k) => doc.visitTypes.includes(k))) return false;
  const disciplines = types.filter((t) => DISCIPLINES.includes(t));
  return !disciplines.length || disciplines.some((d) => doc.visitTypes.includes(d));
}

/** Visit-type tags named in the text (see VISIT_TYPES). */
export function visitTypesOf(text: string): string[] {
  return VISIT_TYPES.filter(([, re]) => re.test(text)).map(([t]) => t);
}

/** Lower-case content words (4+ letters, no stop words), each once. */
export function words(text: string): Set<string> {
  return new Set((text.toLowerCase().match(/[a-z][a-z0-9-]{3,}/g) ?? []).filter((w) => !STOP.has(w)));
}

/**
 * A section's score for an issue: 10 per shared code (an item and its sub-items match) or lime.* key, 2 per issue word
 * in the heading, 1 per word only in the text (max 8).
 */
export function sectionScore(section: AgencySection, codes: Set<string>, keys: Set<string>, focus: Set<string>): number {
  const issue = [...codes];
  const shared = section.codes.filter((c) => issue.some((i) => i.startsWith(c) || c.startsWith(i))).length + section.keys.filter((k) => keys.has(k)).length;
  const heading = words(section.heading);
  const text = words(section.text);
  let inHeading = 0;
  let inText = 0;
  for (const w of focus) {
    if (heading.has(w)) inHeading++;
    else if (text.has(w)) inText++;
  }
  return shared * 10 + inHeading * 2 + Math.min(inText, 8);
}

/** A long section cut to the lines naming the issue's codes, keys or words (± 1 line), with its first line. */
export function excerpt(text: string, codes: Set<string>, keys: Set<string>, focus: Set<string>): string {
  if (text.length <= LONG) return text;
  const lines = text.split("\n");
  const hit = (l: string) => oasisCodes(l).some((c) => codes.has(c)) || fieldKeys(l).lime.some((k) => keys.has(k)) || [...words(l)].some((w) => focus.has(w));
  const keep = new Set<number>([0]);
  lines.forEach((l, i) => {
    if (hit(l)) for (const j of [i - 1, i, i + 1]) if (j >= 0 && j < lines.length) keep.add(j);
  });
  return [...keep].sort((a, b) => a - b).map((i) => lines[i]).join("\n");
}

/**
 * The agency reference for an issue, at most `cap` chars: the docs of its agency plus the generic docs of its EHR
 * (+1 own agency, +3 matching visit type, for ranking); their sections scored by `sectionScore`, those under 4 (own)
 * or 6 (generic) out;
 * the best ones as `[Agency · Doc title · Section heading]\ntext`. Null when nothing relevant.
 */
export function agencyReference(index: AgencyIndex, ctx: IssueContext, cap = 4_000): AgencyReference | null {
  const agencies = issueAgencies(ctx);
  const ehrs = issueEhrs(ctx, agencies);
  const own = index.docs.filter((d) => d.agency && agencies.includes(d.agency));
  const generic = index.docs.filter((d) => !d.agency && d.ehr && ehrs.includes(d.ehr) && genericFits(d, ctx.focus));
  const docs = [...own, ...generic];
  if (!docs.length) return null;

  const all = `${ctx.focus}\n${ctx.text}`;
  const codes = new Set(oasisCodes(all));
  const keys = new Set(fieldKeys(all).lime);
  const focus = words(ctx.focus);
  const types = new Set(visitTypesOf(ctx.focus));
  const scored = docs
    .flatMap((doc) => {
      const bonus = (doc.visitTypes.some((t) => types.has(t)) ? 3 : 0) + (doc.agency ? 1 : 0);
      return doc.sections.flatMap((s) => {
        const score = sectionScore(s, codes, keys, focus);
        return score >= (doc.agency ? MIN_OWN : MIN_GENERIC) ? [{ doc, s, score: score + bonus }] : [];
      });
    })
    .sort((a, b) => b.score - a.score);

  const parts: string[] = [];
  const sources: string[] = [];
  let left = cap;
  for (const { doc, s } of scored) {
    const head = `[${doc.agency ?? `${doc.ehr} (generic)`} · ${doc.title || doc.file} · ${s.heading}]\n`;
    const body = excerpt(s.text, codes, keys, focus);
    const room = left - head.length - (parts.length ? 2 : 0);
    if (room < 200) break;
    parts.push(head + (body.length > room ? `${body.slice(0, room - 1)}…` : body));
    sources.push(`${doc.title || doc.file} · ${s.heading}`);
    left -= head.length + Math.min(body.length, room) + (parts.length > 1 ? 2 : 0);
  }
  return parts.length ? { text: parts.join("\n\n"), sources } : null;
}
