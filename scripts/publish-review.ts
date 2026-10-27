/** Import the existing hub without network reads, or replay its last snapshot. PHI stays outside the repo. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../src/config.js";
import { applyTriage } from "../src/review/classify.js";
import { cachedVisits, packSlackRefs, packVisits, visitRefs, packText, caseRefs } from "../src/review/gather.js";
import { inScope, issueItems } from "../src/review/issues.js";
import { publishedPack, publishReview } from "../src/review/publish.js";
import { ISSUES } from "../src/review/megan-issues.js";
import { topicQuestions, loadTopics } from "../src/review/topics.js";
import { mergeQuestions } from "../src/review/classify.js";
import { condenseQuestions } from "../src/review/questions.js";
import type { LinearIssue, Pack, SlackThread, Triage } from "../src/review/types.js";
import { withProdDb } from "./prod-db.js";
import { agendaFilesIn, agendaItemsOf } from "./hub-build.js";

const lime = path.join(os.homedir(), "Desktop", "Lime");
const out = path.join(lime, "review-hub");
const cache = path.join(out, "cache");
const megan = path.join(lime, "megan-review", "cache");
const snapshot = path.join(out, "review-snapshot.json");
const config = loadConfig();
if (!config.LIME_REVIEW_API_URL || !config.LIME_REVIEW_INGEST_KEY)
	throw new Error("Set LIME_REVIEW_API_URL and LIME_REVIEW_INGEST_KEY");
if (process.argv.includes("--snapshot")) {
	await publishReview(config, JSON.parse(fs.readFileSync(snapshot, "utf8")));
} else {
	const read = <T>(file: string): T | null =>
		fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, "utf8")) as T) : null;
	const loop = read<LinearIssue[]>(path.join(cache, "linear-loop.json")) ?? [];
	const meganLinear = new Map(
		ISSUES.map((issue) => [issue.id, read<LinearIssue>(path.join(cache, `linear-${issue.id}.json`)) ?? undefined]),
	);
	const agenda = agendaItemsOf(agendaFilesIn());
	const referenced = new Set([...agenda.flatMap((item) => item.linear), ...ISSUES.map((item) => item.id)]);
	const items = [
		...agenda,
		...issueItems(
			loop.filter((issue) => inScope(issue, referenced)),
			ISSUES,
			meganLinear,
		),
	];
	const topics = loadTopics(path.join(out, "megan-topics.json"))?.topics ?? [];
	const packs: Pack[] = items.map((item) => {
		const linear = item.linear.flatMap((id) => {
			const issue = read<LinearIssue>(path.join(cache, `linear-${id}.json`));
			return issue ? [issue] : [];
		});
		const text = linear.flatMap((l) => [l.description, ...l.comments.nodes.map((c) => c.body)]).join("\n");
		const refs = packSlackRefs(item, linear);
		const errors: string[] = [];
		const threads = refs.flatMap((ref) => {
			const data = read<SlackThread>(path.join(cache, `slack-${ref.channel}-${ref.ts}.json`));
			if (!data) errors.push(`Slack thread not cached: ${ref.channel}/${ref.ts}`);
			return data ? [data] : [];
		});
		const current = cachedVisits(item, cache);
		const visits = current.length ? current : cachedVisits(item, megan);
		if (visits.length && !current.length)
			errors.push("Visit evidence imported from the earlier Megan review cache; refresh to inspect newer runs.");
		const pack = { item, linear, threads, visits, errors };
		const classification = read<{ triage: Triage }>(path.join(cache, "classify", `${item.id}.json`));
		if (classification) applyTriage(pack, classification.triage);
		const extra = topicQuestions(topics, item.id);
		const t = item.triage;
		if (extra.length && t?.classification === "needs-clarification") t.questions = mergeQuestions(t.questions, extra);
		return pack;
	});
	await condenseQuestions(config, packs.map((pack) => pack.item), cache);
	const hydrate = process.argv.includes("--hydrate");
	if (hydrate)
		await withProdDb(async (query) => {
			let activeReads = 0;
			const waitingReads: (() => void)[] = [];
			const limitedQuery = async (sql: string): Promise<string> => {
				if (activeReads >= 3) await new Promise<void>((resolve) => waitingReads.push(resolve));
				else activeReads++;
				try {
					return await query(sql);
				} finally {
					const next = waitingReads.shift();
					if (next) next();
					else activeReads--;
				}
			};
			const memo = new Map<string, Promise<string>>();
			const read = (sql: string): Promise<string> => {
				let pending = memo.get(sql);
				if (!pending) {
					pending = limitedQuery(sql);
					memo.set(sql, pending);
				}
				return pending;
			};
			let completed = 0;
			let cursor = 0;
			const worker = async () => {
				while (cursor < packs.length) {
					const pack = packs[cursor++];
					try {
						const visits = await packVisits(read, pack, cache, !process.argv.includes("--resume"), true);
						pack.visits = visits;
						const errors = visits.some((visit) =>
							Object.values(visit.data).some(
								(value) => value && typeof value === "object" && !Array.isArray(value) && "error" in value,
							),
						);
						const found = visits.some((visit) => Array.isArray(visit.data.task) && visit.data.task.length > 0);
						const refs = visitRefs(packText(pack));
						const linked = refs.visits.length + refs.tasks.length + caseRefs(pack.threads).length > 0;
						pack.visitStatus = !linked
							? "no-linked-visit"
							: errors
								? found
									? "partial"
									: "failed"
								: found
									? "loaded"
									: "linked-visit-not-found";
						pack.errors = pack.errors.filter(
							(error) => !error.startsWith("Visit evidence imported from the earlier Megan"),
						);
					} catch {
						pack.visitStatus = pack.visits.length ? "partial" : "failed";
						pack.errors.push("Production visit refresh failed; existing traces may be stale.");
					}
					const record = publishedPack(pack, path.join(out, "assets"));
					const dates = fs
						.readdirSync(cache)
						.filter((file) => file.startsWith(`db-${pack.item.id}-`))
						.map((file) => fs.statSync(path.join(cache, file)).mtimeMs);
					if (dates.length) record.evidenceAt = new Date(Math.min(...dates)).toISOString();
					await publishReview(config, {
						id: `hydrate:${pack.item.id}`,
						observedAt: new Date().toISOString(),
						warnings: ["Production visit hydration is in progress. Completed items appear as they are imported."],
						items: [record],
					});
					console.log(`HYDRATION ${++completed}/${packs.length} visits=${pack.visits.length}`);
				}
			};
			await Promise.all([worker(), worker(), worker()]);
		});
	const observedAt = hydrate ? new Date().toISOString() : fs.statSync(path.join(out, "index.html")).mtime.toISOString();
	const records = packs.map((pack) => {
		const record = publishedPack(pack, path.join(out, "assets"));
		const dates = [fs.statSync(path.join(out, "index.html")).mtimeMs];
		for (const folder of [cache, megan])
			for (const file of fs.readdirSync(folder).filter((f) => f.startsWith(`db-${pack.item.id}-`)))
				dates.push(fs.statSync(path.join(folder, file)).mtimeMs);
		const traceDates = fs
			.readdirSync(cache)
			.filter((file) => file.startsWith(`db-${pack.item.id}-`))
			.map((file) => fs.statSync(path.join(cache, file)).mtimeMs);
		record.evidenceAt =
			hydrate && traceDates.length
				? new Date(Math.min(...traceDates)).toISOString()
				: new Date(Math.min(...dates)).toISOString();
		return record;
	});
	const pendingVisits = records.filter((record) => record.detail.visitStatus === "not-imported").length;
	const coverage = records.reduce<Record<string, number>>((counts, record) => {
		const status = record.detail.visitStatus ?? "not-imported";
		counts[status] = (counts[status] ?? 0) + 1;
		return counts;
	}, {});
	console.log(`VISIT COVERAGE ${JSON.stringify(coverage)}`);
	const run = {
		id: "hub:local-import",
		observedAt,
		warnings: hydrate
			? [
					"Visit traces refreshed using read-only production access. Slack and Linear reports are imported from the hub cache.",
				]
			: [
					"Imported from local caches. Visit evidence is not a fresh production read.",
					...(pendingVisits ? [`${pendingVisits} items have linked visits whose traces have not been imported.`] : []),
				],
		activeIssueIds: records.filter((record) => record.kind === "issue").map((record) => record.id),
		items: records,
	};
	fs.writeFileSync(snapshot, JSON.stringify(run));
	await publishReview(config, run);
	console.log(
		`Published ${records.length} items (${records.filter((r) => r.kind === "issue").length} issues) to ${config.LIME_REVIEW_API_URL}`,
	);
}
