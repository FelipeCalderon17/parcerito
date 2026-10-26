import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { test } from "node:test";
import { loadConfig } from "../src/config.js";
import { flushReviewOutbox, publishReview, type PublishedRun } from "../src/review/publish.js";

function fixture(dir: string, port: number) {
	return loadConfig({
		SLACK_BOT_TOKEN: "xoxb-test",
		SLACK_APP_TOKEN: "xapp-test",
		ALLOWED_SLACK_USER_IDS: "U1",
		GITHUB_REPOS: "test/repo",
		GH_TOKEN: "test",
		DATA_DIR: dir,
		LIME_REVIEW_API_URL: `http://127.0.0.1:${port}`,
		LIME_REVIEW_INGEST_KEY: "synthetic-review-key-32-characters-long",
	});
}
const run: PublishedRun = {
	id: "agenda:synthetic",
	observedAt: "2026-10-26T15:00:00.000Z",
	warnings: [],
	items: [
		{
			id: "issue:ENG-1",
			kind: "issue",
			title: "Synthetic review",
			group: 1,
			classification: "needs-clarification",
			linearIds: ["ENG-1"],
			customers: [],
			detail: { blocks: [], questions: [], reason: "", errors: [], origin: "test" },
		},
	],
};

test("a new daily build refreshes sources again without restarting the worker", async () => {
	const { beginGatherRun, cached } = await import("../src/review/gather.js");
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "review-daily-cache-"));
	try {
		let reads = 0;
		const load = async () => ++reads;
		assert.equal(await cached(dir, "linear-loop", load, true), 1);
		assert.equal(await cached(dir, "linear-loop", load, true), 1);
		beginGatherRun(dir);
		assert.equal(await cached(dir, "linear-loop", load, true), 2);
		assert.equal(await cached(dir, "linear-loop", load, true), 2);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("failed publication survives restart and replay preserves source IDs", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "review-publish-"));
	let healthy = false;
	const ids: string[] = [];
	const server = http.createServer(async (req, res) => {
		const chunks: Buffer[] = [];
		for await (const chunk of req) chunks.push(Buffer.from(chunk));
		const body = JSON.parse(Buffer.concat(chunks).toString()) as PublishedRun;
		ids.push(body.items[0].id);
		res.writeHead(healthy ? 200 : 503, { "Content-Type": "application/json" });
		res.end("{}");
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	assert(address && typeof address !== "string");
	try {
		const config = fixture(dir, address.port);
		await assert.rejects(publishReview(config, run), /503/);
		assert.equal(fs.readdirSync(path.join(dir, "review-outbox")).length, 1);
		healthy = true;
		await flushReviewOutbox(config);
		assert.equal(fs.readdirSync(path.join(dir, "review-outbox")).length, 0);
		assert.deepEqual(ids, ["issue:ENG-1", "issue:ENG-1"]);
	} finally {
		await new Promise<void>((resolve) => server.close(() => resolve()));
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("attachment-heavy snapshots upload in bounded batches", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "review-batch-"));
	const sizes: number[] = [];
	const server = http.createServer(async (req, res) => {
		let size = 0;
		for await (const chunk of req) size += Buffer.byteLength(chunk);
		sizes.push(size);
		res.end("{}");
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	assert(address && typeof address !== "string");
	try {
		const evidence = { reports: "x".repeat(4_100_000), visits: "", linear: "", css: "" };
		await publishReview(fixture(dir, address.port), {
			...run,
			items: [
				{ ...run.items[0], evidence },
				{ ...run.items[0], id: "issue:ENG-2", evidence },
			],
		});
		assert.equal(sizes.length, 2);
		assert(sizes.every((size) => size < 8_000_000));
	} finally {
		await new Promise<void>((resolve) => server.close(() => resolve()));
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("visit coverage distinguishes an unhydrated linked chart from an issue without a chart link", async () => {
	const { publishedPack } = await import("../src/review/publish.js");
	const pack: import("../src/review/types.js").Pack = {
		item: {
			id: "ENG-1",
			title: "Synthetic M1850 issue",
			origin: { kind: "issue", url: "", state: "Triage" },
			group: 1,
			linear: ["ENG-1"],
			slack: [],
			fields: "false",
			badges: [],
			meta: [],
			panel: { blocks: [], placeholder: "" },
			text: "https://app.example.test/cases/test?visitId=00000000-0000-0000-0000-000000000001",
		},
		linear: [],
		threads: [],
		visits: [],
		errors: [],
	};
	assert.equal(publishedPack(pack).detail.visitStatus, "not-imported");
	pack.item.text = "A general rule question with no chart URL";
	assert.equal(publishedPack(pack).detail.visitStatus, "no-linked-visit");
});

test("visit import batches sections and preserves healthy sections if one query fails", async () => {
	const { fetchVisit } = await import("../src/review/gather.js");
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "review-trace-"));
	try {
		let calls = 0;
		const task = "00000000-0000-0000-0000-000000000001";
		const bundled = await fetchVisit(
			async () => {
				calls++;
				return JSON.stringify({ task: [{ task_id: task }], fields: [{ key: "M1850" }] });
			},
			task,
			{ id: "bundled", fields: "false" },
			dir,
		);
		assert.equal(calls, 1);
		assert.equal((bundled.data.fields as { key: string }[])[0].key, "M1850");
		const partial = await fetchVisit(
			async (sql) => {
				if (sql.startsWith("select json_build_object") || sql.includes("r.value as ai_value"))
					throw Error("Synthetic section failure");
				return sql.includes("as task_id") ? JSON.stringify([{ task_id: task }]) : "[]";
			},
			task,
			{ id: "partial", fields: "false" },
			dir,
		);
		assert.equal((partial.data.task as { task_id: string }[])[0].task_id, task);
		assert.match((partial.data.fields as { error: string }).error, /Synthetic section failure/);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("agenda visit discovery stays within its own reports instead of inheriting parent-ticket charts", async () => {
	const { packText } = await import("../src/review/gather.js");
	const pack: import("../src/review/types.js").Pack = {
		item: {
			id: "synthetic-agenda",
			title: "Own report",
			origin: { kind: "agenda", date: "2026-10-26", agenda: "2026-10-26", cardId: "own" },
			group: 1,
			linear: ["ENG-1"],
			slack: [],
			fields: "false",
			badges: [],
			meta: [],
			panel: { blocks: [], placeholder: "" },
			text: "own source",
		},
		linear: [
			{
				identifier: "ENG-1",
				title: "Broad parent",
				url: "",
				description: "unrelated parent chart",
				state: { name: "Triage" },
				assignee: null,
				comments: { nodes: [] },
			},
		],
		threads: [],
		visits: [],
		errors: [],
	};
	assert(!packText(pack).includes("unrelated parent chart"));
	pack.item.origin = { kind: "issue", url: "", state: "Triage" };
	assert(packText(pack).includes("unrelated parent chart"));
});

test("a refreshed source manifest prevents stale charts from returning through the visit cache", async () => {
	const { cachedVisits, packVisits } = await import("../src/review/gather.js");
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "review-source-manifest-"));
	try {
		const item: import("../src/review/types.js").Item = {
			id: "source",
			title: "General question",
			origin: { kind: "agenda", date: "2026-10-26", agenda: "2026-10-26", cardId: "source" },
			group: 6,
			linear: [],
			slack: [],
			fields: "false",
			badges: [],
			meta: [],
			panel: { blocks: [], placeholder: "" },
			text: "No chart link",
		};
		fs.writeFileSync(
			path.join(dir, "db-source-stale-task.json"),
			JSON.stringify({ task: "stale-task", data: { task: [] } }),
		);
		assert.equal(cachedVisits(item, dir).length, 1);
		await packVisits(async () => "[]", { item, linear: [], threads: [], visits: [], errors: [] }, dir);
		assert.deepEqual(cachedVisits(item, dir), []);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
