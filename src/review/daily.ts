/** The scheduled hub build uses Lime's read-only evidence API, with no AWS login on the bot. */
import fs from "node:fs";
import path from "node:path";
import type { Config } from "../config.js";
import { agencyReference, issueContext, loadAgencyDocs } from "./agency.js";
import { classifyIssues, REFERENCE_CAP } from "./classify.js";
import { beginGatherRun, cachedVisits, caseRefs, gatherPack, packText, primeLinear, visitRefs } from "./gather.js";
import { issueItems, loopIssues } from "./issues.js";
import { agendaItem, fieldKeys, mergeAgendas, parseAgendaHtml } from "./items.js";
import { ISSUES } from "./megan-issues.js";
import {
	decisionContext,
	loadReviewDecisions,
	publishReview,
	publishedPack,
	reviewConfigured,
	reviewRequest,
} from "./publish.js";
import { loadTopics, matchTopics, topicBlocks, topicReference, withAnswers } from "./topics.js";
import type { Pack, VisitData } from "./types.js";

const builds = new Map<string, Promise<void>>();
function agendaFiles(dir: string): string[] {
	if (!fs.existsSync(dir)) return [];
	return fs
		.readdirSync(dir, { withFileTypes: true })
		.flatMap((file) =>
			file.isDirectory()
				? agendaFiles(path.join(dir, file.name))
				: /^nico-sync-.*\.html$/.test(file.name)
					? [path.join(dir, file.name)]
					: [],
		);
}

async function buildDailyReview(config: Config): Promise<void> {
	const root = path.join(config.DATA_DIR, "review");
	const cache = path.join(root, "cache"),
		assets = path.join(root, "assets");
	for (const dir of [cache, assets]) fs.mkdirSync(dir, { recursive: true });
	beginGatherRun(cache);
	const agendas = agendaFiles(path.join(config.DATA_DIR, "agenda")).flatMap((file) => {
		const parsed = parseAgendaHtml(fs.readFileSync(file, "utf8"));
		return parsed ? [parsed] : [];
	});
	const agendaItems = [...mergeAgendas(agendas)].map(([id, merged]) => agendaItem(id, merged));
	const referenced = new Set([...agendaItems.flatMap((item) => item.linear), ...ISSUES.map((item) => item.id)]);
	const loop = await loopIssues(referenced, cache);
	for (const issue of loop) primeLinear(cache, issue);
	const extras = new Map(ISSUES.map((issue) => [issue.id, loop.find((l) => l.identifier === issue.id)]));
	const items = [...agendaItems, ...issueItems(loop, ISSUES, extras)];
	const seenFile = path.join(cache, "sources-seen.json");
	const seen: Record<string, string> = fs.existsSync(seenFile) ? JSON.parse(fs.readFileSync(seenFile, "utf8")) : {};
	const packs: Pack[] = [];
	for (const item of items) {
		const signature = JSON.stringify({ sourceVersion: 2, origin: item.origin });
		const fresh = seen[item.id] !== signature;
		const pack = await gatherPack(item, { cache, assets }, fresh);
		if (!fresh) pack.visits = cachedVisits(item, cache);
		if (fresh || !pack.visits.length) {
			const refs = visitRefs(packText(pack)),
				cases = caseRefs(pack.threads);
			if (refs.tasks.length || refs.visits.length || cases.length) {
				const keys = fieldKeys(item.text);
				try {
					const response = await reviewRequest(config, "evidence", {
						method: "POST",
						body: JSON.stringify({
							taskIds: refs.tasks.slice(0, 25),
							visitIds: refs.visits.slice(0, 25),
							cases: cases.slice(0, 25),
							fields: [...keys.oasis, ...keys.lime],
						}),
					});
					pack.visits = (await response.json()) as VisitData[];
					pack.visitStatus = pack.visits.length ? undefined : "linked-visit-not-found";
					fs.writeFileSync(
						path.join(cache, `visit-tasks-${item.id}.json`),
						JSON.stringify(pack.visits.map((visit) => visit.task)),
					);
					for (const visit of pack.visits)
						fs.writeFileSync(path.join(cache, `db-${item.id}-${visit.task}.json`), JSON.stringify(visit));
					if (refs.tasks.length > 25 || refs.visits.length > 25 || cases.length > 25)
						pack.errors.push("This item names more than 25 charts; narrow the issue to review the remaining charts.");
				} catch {
					pack.errors.push("Live evidence could not be refreshed; any visit traces shown are from cache.");
					pack.visits = cachedVisits(item, cache);
					pack.visitStatus = pack.visits.length ? "partial" : "failed";
				}
			}
		}
		if (
			pack.visits.some((visit) =>
				Object.values(visit.data).some(
					(section) => section && typeof section === "object" && !Array.isArray(section) && "error" in section,
				),
			)
		) {
			pack.errors.push("Some visit evidence sections failed to load. This item will be retried.");
		}
		packs.push(pack);
		if (!pack.errors.length && !pack.threads.some((thread) => thread.error)) seen[item.id] = signature;
		else delete seen[item.id];
		console.log(`[review] gathered ${packs.length}/${items.length}`);
	}
	const topics = loadTopics(config.LIME_REVIEW_TOPICS_FILE ?? path.join(root, "megan-topics.json"));
	if (topics)
		await matchTopics(
			topics.topics,
			packs.filter((pack) => pack.item.origin.kind === "issue"),
			{ cacheDir: cache, config },
		);
	const decisions = await loadReviewDecisions(config);
	const agency = loadAgencyDocs();
	for (const pack of packs) pack.item.panel.blocks.push(...topicBlocks(topics?.topics ?? [], pack.item.id));
	await classifyIssues(config, packs, {
		cacheDir: cache,
		reference: (pack) => {
			const answers = decisions.filter(
				(decision) =>
					decision.id === `${pack.item.origin.kind === "agenda" ? "agenda" : "issue"}:${pack.item.id}` ||
					decision.linearIds.some((id) => pack.item.linear.includes(id)),
			);
			return withAnswers(
				[topicReference(topics?.topics ?? [], pack.item.id), decisionContext(answers)].filter(Boolean).join("\n\n") ||
					null,
				agency ? agencyReference(agency, issueContext(pack), REFERENCE_CAP) : null,
			);
		},
	});
	const observedAt = new Date().toISOString();
	const snapshot = {
		id: `daily-review:${observedAt}`,
		observedAt,
		warnings: !agency ? ["Agency preference documents have not been provisioned on this worker."] : [],
		activeIssueIds: packs.filter((pack) => pack.item.origin.kind === "issue").map((pack) => `issue:${pack.item.id}`),
		items: packs.map((pack) => {
			const result = publishedPack(pack, assets);
			const files = fs.readdirSync(cache).filter((file) => file.startsWith(`db-${pack.item.id}-`));
			if (files.length)
				result.evidenceAt = new Date(
					Math.min(...files.map((file) => fs.statSync(path.join(cache, file)).mtimeMs)),
				).toISOString();
			return result;
		}),
	};
	fs.writeFileSync(path.join(root, "snapshot.json"), JSON.stringify(snapshot));
	await publishReview(config, snapshot);
	fs.writeFileSync(seenFile, JSON.stringify(seen));
	if (packs.some((pack) => pack.errors.length || pack.threads.some((thread) => thread.error)))
		throw new Error("Partial evidence import published; failed sections remain queued for retry");
}

/** One durable marker is enough: each build merges every stored agenda, including days missed during downtime. */
export function queueReviewBuild(config: Config): void {
	if (!reviewConfigured(config)) return;
	fs.mkdirSync(config.DATA_DIR, { recursive: true });
	fs.writeFileSync(
		path.join(config.DATA_DIR, "review-build-pending.json"),
		JSON.stringify({ requestedAt: new Date().toISOString() }),
	);
	void processReviewBuild(config).catch((error) =>
		console.warn("[review] build pending:", error instanceof Error ? error.message : "failed"),
	);
}

export async function processReviewBuild(config: Config): Promise<void> {
	if (!reviewConfigured(config) || builds.has(config.DATA_DIR)) return;
	const marker = path.join(config.DATA_DIR, "review-build-pending.json");
	if (!fs.existsSync(marker)) return;
	const initial = fs.readFileSync(marker, "utf8");
	const task = buildDailyReview(config)
		.then(() => {
			if (fs.existsSync(marker) && fs.readFileSync(marker, "utf8") === initial) fs.unlinkSync(marker);
		})
		.finally(() => builds.delete(config.DATA_DIR));
	builds.set(config.DATA_DIR, task);
	await task;
}
