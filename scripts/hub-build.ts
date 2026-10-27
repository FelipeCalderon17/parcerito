import { publishReview, publishedPack, loadReviewDecisions, decisionContext } from "../src/review/publish.js";
/**
 * Builds the local review hub (see review-hub.ts): shared by `npm run hub` and `npm run agenda`. Items on the agendas
 * since the last meeting refetch Linear, Slack and their visits every run; older agenda items read the cache. The
 * feedback loop's Linear issues (Megan's merged in) are listed fresh each run, but an issue's Slack threads and visits
 * are only regathered when Linear changed it since the last build (or it's on a fresh agenda item).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgendaCard } from "../src/agenda/render.js";
import { loadConfig, type Config } from "../src/config.js";
import { agencyReference, issueContext, loadAgencyDocs } from "../src/review/agency.js";
import { classifyIssues, mergeQuestions, REFERENCE_CAP } from "../src/review/classify.js";
import { cachedVisits, gatherPack, linearIssue, packVisits, primeLinear } from "../src/review/gather.js";
import { renderHub } from "../src/review/hub.js";
import { issueFresh, issueItems, loopIssues } from "../src/review/issues.js";
import { agendaItem, explainManual, isFresh, manualBlockCodes, mergeAgendas, parseAgendaHtml, sortItems } from "../src/review/items.js";
import { loadManual } from "../src/manual/lookup.js";
import { manualNotes } from "../src/manual/notes.js";
import { manualBriefs } from "../src/review/brief.js";
import { condenseQuestions, MAX_QUESTIONS } from "../src/review/questions.js";
import { ISSUES } from "../src/review/megan-issues.js";
import { loadTopics, matchTopics, topicQuestions, topicReference, withAnswers, type MeganTopic } from "../src/review/topics.js";
import type { Item, Pack } from "../src/review/types.js";
import { withProdDb } from "./prod-db.js";

const LIME = path.join(os.homedir(), "Desktop", "Lime");
const OUT = path.join(LIME, "review-hub");
const CACHE = path.join(OUT, "cache");
const ASSETS = path.join(OUT, "assets");
/** Issue id → Linear `updatedAt` of the copy last gathered, to skip unchanged issues' Slack/visit refetch. */
const SEEN = path.join(CACHE, "issues-seen.json");
/** The parsed Megan meeting spreadsheet (npm run megan-topics), with its topic → issue matches. */
export const TOPICS_FILE = path.join(OUT, "megan-topics.json");

/** Every nico-sync-*.html in `dir` (default ~/Desktop/Lime/agenda). */
export function agendaFilesIn(dir = path.join(LIME, "agenda")): string[] {
  return fs.existsSync(dir)
    ? fs.readdirSync(dir).filter((f) => /^nico-sync-.*\.html$/.test(f)).map((f) => path.join(dir, f))
    : [];
}

/**
 * The feedback loop's issue items: the list is refetched every run; each one is primed into the per-issue cache so
 * gathering doesn't fetch it again. Megan's issues the list misses (e.g. done) are loaded by id, as before.
 */
export async function loadIssues(agendaItems: Item[]): Promise<Item[]> {
  const referenced = new Set([...agendaItems.flatMap((i) => i.linear), ...ISSUES.map((i) => i.id)]);
  const loop = await loopIssues(referenced, CACHE);
  for (const issue of loop) primeLinear(CACHE, issue);
  const inLoop = new Set(loop.map((i) => i.identifier));
  const meganLinear = new Map(
    await Promise.all(
      ISSUES.filter((i) => !inLoop.has(i.id)).map(async (i) => [i.id, await linearIssue(i.id, CACHE).catch(() => undefined)] as const),
    ),
  );
  return issueItems(loop, ISSUES, meganLinear);
}

/** The agenda items of agenda files, merged across agendas. */
export function agendaItemsOf(agendaFiles: string[]): Item[] {
  const agendas = agendaFiles.flatMap((file) => {
    const parsed = parseAgendaHtml(fs.readFileSync(file, "utf8"));
    return parsed ? [parsed] : [];
  });
  return [...mergeAgendas(agendas)].map(([id, m]) => agendaItem(id, m));
}

/**
 * The issue packs from the hub cache, without prod: what `npm run megan-topics` matches against (Linear's loop list is
 * refetched; Slack threads and visits come from cache, threads not cached yet are fetched).
 */
export async function cachedIssuePacks(agendaFiles: string[]): Promise<Pack[]> {
  for (const dir of [OUT, CACHE, ASSETS]) fs.mkdirSync(dir, { recursive: true });
  const packs: Pack[] = [];
  for (const item of await loadIssues(agendaItemsOf(agendaFiles))) {
    const pack = await gatherPack(item, { cache: CACHE, assets: ASSETS }, false);
    pack.visits = cachedVisits(item, CACHE);
    packs.push(pack);
  }
  return packs;
}

/** Matches the spreadsheet topics (megan-topics.json, if parsed) to the issue packs and saves the matches back. */
export async function matchSpreadsheet(packs: Pack[], config: Pick<Config, "CLAUDE_MODEL">): Promise<MeganTopic[]> {
  const file = loadTopics(TOPICS_FILE);
  if (!file) return [];
  await matchTopics(file.topics, packs, { cacheDir: CACHE, config });
  fs.writeFileSync(TOPICS_FILE, JSON.stringify(file, null, 2));
  return file.topics;
}

/**
 * Gathers every agenda item and feedback-loop issue, pulls their visits (or reads them from cache with `noDb`),
 * classifies the issues (skipped with `noClassify`: Part-1 placeholder classes), writes the hub and returns its path.
 */
export async function buildHub({
  agendaFiles,
  noDb,
  since,
  noClassify = false,
}: {
  agendaFiles: string[];
  noDb: boolean;
  since?: string;
  noClassify?: boolean;
}): Promise<string> {
  for (const dir of [OUT, CACHE, ASSETS]) fs.mkdirSync(dir, { recursive: true });
  const dirs = { cache: CACHE, assets: ASSETS };

  const agendas = agendaFiles.flatMap((file) => {
    const parsed = parseAgendaHtml(fs.readFileSync(file, "utf8"));
    if (!parsed) console.warn(`skipping ${file}: no agenda data`);
    return parsed ? [parsed] : [];
  });
  const newest = agendas.map((a) => a.agenda).sort().at(-1) ?? "";
  // Today = every agenda since the last meeting (default: just the newest one).
  const from = since && since < newest ? since : newest;
  const merged = mergeAgendas(agendas);
  const cards = new Map<string, AgendaCard>([...merged].map(([id, m]) => [id, m.card]));
  const agendaItems: Item[] = [...merged].map(([id, m]) => agendaItem(id, m));

  const issues = await loadIssues(agendaItems);
  console.log(`${agendas.length} agendas (newest ${newest || "none"}), ${merged.size} agenda items, ${issues.length} issues`);

  const seen = fs.existsSync(SEEN) ? (JSON.parse(fs.readFileSync(SEEN, "utf8")) as Record<string, string>) : {};
  // Issues on the newest agenda refetch like its items; the rest only when Linear changed them (see issueFresh).
  const onFreshAgenda = new Set(agendaItems.filter((i) => isFresh(i, newest)).flatMap((i) => i.linear));
  const fresh = (item: Item) => (item.origin.kind === "issue" ? issueFresh(item, seen, onFreshAgenda) : isFresh(item, from));

  const all = sortItems([...agendaItems, ...issues]);
  const packs: Pack[] = [];
  let errors = 0;
  for (const item of all) {
    const pack = await gatherPack(item, dirs, fresh(item));
    errors += pack.errors.length + pack.threads.filter((t) => t.error).length;
    packs.push(pack);
    if (packs.length % 10 === 0 || packs.length === all.length)
      console.log(`gathered ${packs.length}/${all.length} (${packs.filter((p) => fresh(p.item)).length} fresh, ${errors} errors)`);
  }

  if (noDb) {
    for (const pack of packs) pack.visits = cachedVisits(pack.item, CACHE);
  } else {
    await withProdDb(async (query) => {
      for (const pack of packs) {
        try {
          pack.visits = await packVisits(query, pack, CACHE, fresh(pack.item));
        } catch (error) {
          pack.errors.push(`Couldn't load visits: ${String((error as Error).message ?? error).slice(-300)}`);
        }
        console.log(`${pack.item.id}: ${pack.visits.length} visits`);
      }
    });
  }
  // Only a run that pulled visits counts as having seen an issue's changes; a --no-db run would leave them stale.
  if (!noDb) {
    for (const item of issues) if (item.origin.kind === "issue" && item.origin.updatedAt) seen[item.id] = item.origin.updatedAt;
    fs.writeFileSync(SEEN, JSON.stringify(seen, null, 2));
  }

  const config = loadConfig();
  const decisions = await loadReviewDecisions(config).catch(() => []);
  // Felipe's Megan meeting spreadsheet (npm run megan-topics): its topics on the issues they match.
  const issuePacks = packs.filter((p) => p.item.origin.kind === "issue");
  const topics = await matchSpreadsheet(issuePacks, config);
  if (topics.length) console.log(`spreadsheet: ${topics.filter((t) => t.matches.length).length}/${topics.length} topics matched, ${topics.filter((t) => t.answer).length} answered`);

  if (!noClassify) {
    const started = Date.now();
    // Megan's agency documentation preferences, when indexed (npm run agency-docs); none → manual only. Her
    // spreadsheet answers on the issue's topics go first.
    const agency = loadAgencyDocs();
    if (!agency) console.log("no agency docs index (npm run agency-docs): classifying without agency preferences");
    const reference = (pack: Pack) => {
      const approved = decisions.filter(d => d.id === `issue:${pack.item.id}` || d.linearIds.some(id => pack.item.linear.includes(id)));
      return withAnswers([topicReference(topics,pack.item.id), decisionContext(approved)].filter(Boolean).join('\n\n') || null,
        agency ? agencyReference(agency,issueContext(pack),REFERENCE_CAP) : null);
    };
    // Manual notes are cached with the hub, not in the bot's DATA_DIR.
    const t = await classifyIssues({ ...config, DATA_DIR: path.join(CACHE, "data") }, packs, { cacheDir: CACHE, reference });
    console.log(
      `classifier: ${t.ready} ready, ${t.needs} needs clarification, ${t.failed} failed, ${t.cached} cache hits, ${packs.filter((p) => p.item.agencySources?.length).length} with agency prefs (${Math.round((Date.now() - started) / 1000)}s)`,
    );
  }

  // The spreadsheet topics' questions join the issue's own questions to resolve (no separate topic cards); an issue
  // the docs already settle (ready) doesn't reopen them.
  for (const pack of issuePacks) {
    const extra = topicQuestions(topics, pack.item.id);
    if (!extra.length) continue;
    const t = pack.item.triage;
    if (t?.classification === "needs-clarification") t.questions = mergeQuestions(t.questions, extra);
    else if (!t) pack.item.panel.questions = { title: "❓ Questions to resolve", items: mergeQuestions(pack.item.panel.questions?.items ?? [], extra) };
  }

  // At most MAX_QUESTIONS questions to resolve per item, so a meeting can get through ~20 issues.
  const condensed = await condenseQuestions(config, packs.map((p) => p.item), CACHE);
  if (condensed) console.log(`questions condensed to ${MAX_QUESTIONS} on ${condensed} items`);

  // The manual card says what the rule is and what to do, not just where it is (notes are cached per code).
  const manualIndex = loadManual();
  const notesConfig = { ...config, DATA_DIR: path.join(CACHE, "data") };
  const agencyDocs = loadAgencyDocs();
  const withNotes = [];
  for (const pack of packs) {
    if (!pack.item.panel.blocks.some((b) => b.title.includes("CMS OASIS-E2 manual"))) continue;
    const codes = manualBlockCodes(pack.item);
    const notes = codes.length ? await manualNotes(notesConfig, codes, { manual: manualIndex }).catch(() => []) : [];
    const agency = agencyDocs ? agencyReference(agencyDocs, issueContext(pack), 2_500) : null;
    if (agency && !pack.item.agencySources?.length) pack.item.agencySources = agency.sources;
    withNotes.push({ item: pack.item, notes, agency: agency?.text });
  }
  const briefs = await manualBriefs(config, withNotes, CACHE);
  for (const { item, notes } of withNotes) explainManual(item, notes, briefs.get(item.id));
  console.log(`docs briefs: ${briefs.size}/${withNotes.filter((e) => e.notes.length || e.agency).length} (${withNotes.filter((e) => e.agency).length} with agency prefs)`);

  const file = path.join(OUT, "index.html");
  fs.writeFileSync(file, renderHub(packs, newest, cards, from, topics));
  const snapshot = { id: `hub:${newest}`, observedAt: new Date().toISOString(),
    warnings: noDb ? ['Visit evidence came from the local cache; it was not refreshed from production.'] : [],
    activeIssueIds: packs.filter(pack => pack.item.origin.kind === 'issue').map(pack => `issue:${pack.item.id}`),
    items: packs.map(pack => publishedPack(pack,ASSETS)) };
  fs.writeFileSync(path.join(OUT,'review-snapshot.json'),JSON.stringify(snapshot));
  await publishReview(config,snapshot).catch(() => console.warn('Lime publish failed; snapshot saved in review-outbox.'));
  return file;
}
