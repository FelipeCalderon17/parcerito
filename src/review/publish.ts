import { caseRefs, packText, visitRefs } from "./gather.js";
import { groupRejected, type RejectedField, type RejectedExport } from "../agenda/rejected.js";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Config } from "../config.js";
import { CSS, rowsTable, stats, linearEvidence, threadCards, visitCards } from "./render.js";
import type { Pack, VisitStatus } from "./types.js";

export interface PublishedItem {
	id: string;
	kind: "agenda" | "issue";
	title: string;
	group: number;
	classification: "ready" | "needs-clarification" | "unclassified";
	linearIds: string[];
	customers: string[];
	detail: {
		blocks: { title: string; text: string }[];
		questions: string[];
		reason: string;
		nextStep?: string;
		stats?: Record<string, number>;
		visitStatus?: VisitStatus;
		visitReferenceCount?: number;
		errors: string[];
		origin: string;
	};
	evidenceAt?: string;
	evidence?: { reports: string; visits: string; linear: string; css: string };
}
export interface PublishedRun {
	activeIssueIds?: string[];
	id: string;
	observedAt: string;
	since?: string;
	until?: string;
	warnings: string[];
	items: PublishedItem[];
}
export interface ApprovedDecision {
	id: string;
	title: string;
	linearIds: string[];
	status: string;
	answer: string;
	scope: string;
	authorName: string;
	createdAt: string;
	version: number;
}

/** Embed only cached image files, so private attachments don't need a public asset server. */
export function embedImages(html: string, assetsDir?: string): string {
	return html.replace(/src="assets\/([^"/]+)"/g, (_match, name: string) => {
		if (!assetsDir || !/^[\w.-]+\.(png|jpe?g|gif|webp)$/i.test(name)) return 'alt="Attachment unavailable"';
		const file = path.join(assetsDir, name);
		if (!fs.existsSync(file)) return 'alt="Attachment unavailable"';
		const ext = name.split(".").at(-1)!.toLowerCase().replace("jpg", "jpeg");
		return `src="data:image/${ext};base64,${fs.readFileSync(file).toString("base64")}"`;
	});
}

/** Stable source IDs keep decisions attached when the hub is rebuilt. */
export function publishedPack(pack: Pack, assetsDir?: string): PublishedItem {
	const { item } = pack;
	const kind = item.origin.kind === "agenda" ? "agenda" : "issue";
	const s = stats(pack);
	const refs = visitRefs(packText(pack));
	const referenceCount =
		refs.visits.length + refs.tasks.length + new Set(caseRefs(pack.threads).map((ref) => ref.caseId)).size;
	const hasErrors = pack.visits.some((visit) =>
		Object.values(visit.data).some(
			(section) => section && typeof section === "object" && !Array.isArray(section) && "error" in section,
		),
	);
	const visitStatus =
		pack.visitStatus ??
		(pack.visits.length ? (hasErrors ? "partial" : "loaded") : referenceCount ? "not-imported" : "no-linked-visit");
	return {
		id: `${kind}:${item.id}`,
		kind,
		title: item.title,
		group: item.group,
		classification: item.classification ?? "unclassified",
		linearIds: item.linear,
		customers: item.customers ?? s.orgs,
		detail: {
			blocks: item.panel.blocks.map(({ title, text }) => ({ title, text })),
			questions: item.triage?.questions ?? item.panel.questions?.items ?? [],
			visitStatus,
			visitReferenceCount: referenceCount,
			reason: item.triage?.reason ?? item.classificationReason ?? "",
			nextStep: item.triage?.nextStep,
			stats: {
				reports: s.reports,
				visits: pack.visits.length,
				suggested: s.suggested,
				abstained: s.abstained,
				rejected: s.rejected,
			},
			errors: [...pack.errors, ...pack.threads.flatMap((t) => (t.error ? [t.error] : []))],
			origin: item.origin.kind === "agenda" ? item.origin.agenda : "Linear feedback loop",
		},
		evidence: {
			reports: embedImages(threadCards(pack.threads) + rowsTable(item.rows ?? []), assetsDir),
			visits: embedImages(visitCards(pack.visits), assetsDir),
			linear: linearEvidence(pack),
			css: CSS,
		},
	};
}

export function reviewConfigured(config: Config): boolean {
	return Boolean(config.LIME_REVIEW_API_URL && config.LIME_REVIEW_INGEST_KEY);
}

export async function reviewRequest(config: Config, suffix: string, init?: RequestInit): Promise<Response> {
	const result = await fetch(`${config.LIME_REVIEW_API_URL!.replace(/\/$/, "")}/internal/coder-feedback/${suffix}`, {
		...init,
		headers: { "Content-Type": "application/json", "x-parcerito-key": config.LIME_REVIEW_INGEST_KEY! },
		signal: AbortSignal.timeout(suffix === "evidence" ? 180_000 : 30_000),
	});
	if (!result.ok) throw new Error(`Lime review API returned ${result.status}`);
	return result;
}

/** The outbox is durable and replayable; a dashboard outage must not lose the morning agenda. */
export async function publishReview(config: Config, run: PublishedRun): Promise<void> {
	if (!reviewConfigured(config)) return;
	const dir = path.join(config.DATA_DIR, "review-outbox");
	fs.mkdirSync(dir, { recursive: true });
	const body = JSON.stringify(run);
	const digest = createHash("sha256").update(body).digest("hex").slice(0, 16);
	const file = path.join(dir, `${run.id.replace(/[^\w.-]/g, "_")}-${digest}.json`);
	fs.writeFileSync(`${file}.tmp`, body);
	fs.renameSync(`${file}.tmp`, file);
	await flushReviewOutbox(config);
}

const flushing = new Map<string, Promise<void>>();
export async function flushReviewOutbox(config: Config): Promise<void> {
	const running = flushing.get(config.DATA_DIR);
	if (running) {
		await running;
		return flushReviewOutbox(config);
	}
	const task = flushPending(config).finally(() => flushing.delete(config.DATA_DIR));
	flushing.set(config.DATA_DIR, task);
	await task;
}

async function flushPending(config: Config): Promise<void> {
	if (!reviewConfigured(config)) return;
	const dir = path.join(config.DATA_DIR, "review-outbox");
	if (!fs.existsSync(dir)) return;
	for (const file of fs
		.readdirSync(dir)
		.filter((f) => f.endsWith(".json"))
		.sort()) {
		const full = path.join(dir, file);
		const run = JSON.parse(fs.readFileSync(full, "utf8")) as PublishedRun;
		const chunks: PublishedItem[][] = [[]];
		let bytes = 0;
		for (const item of run.items) {
			const size = Buffer.byteLength(JSON.stringify(item));
			if (bytes + size > 8_000_000 && chunks.at(-1)!.length) {
				chunks.push([]);
				bytes = 0;
			}
			chunks.at(-1)!.push(item);
			bytes += size;
		}
		for (const [index, items] of chunks.entries())
			await reviewRequest(config, "runs", {
				method: "POST",
				body: JSON.stringify({
					...run,
					activeIssueIds: index === chunks.length - 1 ? run.activeIssueIds : undefined,
					items,
				}),
			});
		fs.unlinkSync(full);
	}
}

export async function loadReviewDecisions(config: Config): Promise<ApprovedDecision[]> {
	if (!reviewConfigured(config)) return [];
	return (await (await reviewRequest(config, "decisions")).json()) as ApprovedDecision[];
}

/** Answers saved while the item still needs clarification (posted to Linear, never used as approved context). */
export async function loadOpenDecisions(config: Config): Promise<ApprovedDecision[]> {
	if (!reviewConfigured(config)) return [];
	return (await (await reviewRequest(config, "decisions/open")).json()) as ApprovedDecision[];
}

export function decisionContext(decisions: ApprovedDecision[]): string {
	return decisions
		.map(
			(d) =>
				`[${d.linearIds.join(", ") || d.id}] ${d.title}\nScope: ${d.scope}\n` +
				`Status: ${d.status}; approved by ${d.authorName} on ${d.createdAt}\n${d.answer}`,
		)
		.join("\n\n");
}

export async function loadReviewRejections(config: Config, since: Date, until: Date): Promise<RejectedExport> {
	const response = await reviewRequest(config, "rejections", {
		method: "POST",
		body: JSON.stringify({ since: since.toISOString(), until: until.toISOString() }),
	});
	const data = (await response.json()) as { exportedAt: string; rows: RejectedField[] };
	return { exportedAt: new Date(data.exportedAt), groups: groupRejected(data.rows), total: data.rows.length };
}
