import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { reviewIssues } from "../src/agenda/index.js";
import {
  agendaTitle,
  isReviewComment,
  LinearClient,
  reviewHeading,
  reviewMarker,
  sameRevision,
  withRevision,
} from "../src/agenda/linear.js";
import type { AgendaCard } from "../src/agenda/render.js";
import { candidates, findDuplicates, issueProfiles, mergePairs, newerOf, titleWords } from "../src/review/duplicates.js";
import { reviewMarkdown, reviewTargets, syncReviews, triageReview, TRIAGE_ONLY_NOTE } from "../src/review/linear-review.js";
import type { Item, LinearIssue, Pack, VisitData } from "../src/review/types.js";

// ---------- Titles & markers ----------

test("agendaTitle: adds the prefix once, replaces an older one, keeps a newer one, never stacks", () => {
  assert.equal(agendaTitle("M1830 bathing", "2026-10-29"), "[Agenda - 2026-10-29] M1830 bathing");
  assert.equal(agendaTitle("[Agenda - 2026-10-29] M1830 bathing", "2026-10-29"), "[Agenda - 2026-10-29] M1830 bathing");
  assert.equal(agendaTitle("[Agenda - 2026-10-21] M1830 bathing", "2026-10-29"), "[Agenda - 2026-10-29] M1830 bathing");
  assert.equal(agendaTitle("[Agenda - 2026-10-30] M1830 bathing", "2026-10-29"), "[Agenda - 2026-10-30] M1830 bathing");
  assert.equal(agendaTitle("[Agenda - 2026-10-21] [Agenda - 2026-10-22] x", "2026-10-29"), "[Agenda - 2026-10-29] x");
  assert.equal(agendaTitle("[Netsmart] Push fails", "2026-10-29"), "[Agenda - 2026-10-29] [Netsmart] Push fails");
  const once = agendaTitle("[Netsmart] Push fails", "2026-10-29");
  assert.equal(agendaTitle(once, "2026-10-29"), once);
});

test("isReviewComment finds the comment by marker or by its heading; revisions compare by hash", () => {
  const body = `${reviewHeading("2026-10-29")}\n${reviewMarker("2026-10-29")}\n\nhello`;
  assert.ok(isReviewComment(body, "2026-10-29"));
  assert.ok(isReviewComment("## Agenda review — 2026-10-29\n\nmarker stripped by Linear", "2026-10-29"));
  assert.ok(!isReviewComment(body.replace(/<!--.*-->/, ""), "2026-10-28"));
  assert.ok(!isReviewComment("More reports of this from Slack", "2026-10-29"));
  assert.ok(sameRevision(withRevision("a"), withRevision("a")));
  assert.ok(!sameRevision(withRevision("a"), withRevision("b")));
  assert.ok(!sameRevision("no stamp", withRevision("a")));
});

// ---------- LinearClient writes & dry run ----------

/** A fake Linear API: answers queries from `issue`, records every request body. */
function fakeLinear(issue: { title: string; comments: { id: string; body: string }[]; team?: string }) {
  const sent: { query: string; variables: Record<string, unknown> }[] = [];
  const fetchFn = (async (_url: string, init: { body: string }) => {
    const req = JSON.parse(init.body) as { query: string; variables: Record<string, unknown> };
    sent.push(req);
    const data = /^\s*mutation/.test(req.query)
      ? { ok: { success: true } }
      : { issue: { id: "uuid-1", title: issue.title, team: { key: issue.team ?? "ENG" }, comments: { nodes: issue.comments } } };
    return { ok: true, statusText: "OK", json: async () => ({ data }) };
  }) as unknown as typeof fetch;
  return { sent, fetchFn, mutations: () => sent.filter((r) => /^\s*mutation/.test(r.query)) };
}

test("dry run: reads go to Linear, mutations are only logged (fetch never sees one)", async () => {
  const api = fakeLinear({ title: "M1830 bathing", comments: [] });
  const logged: string[] = [];
  const linear = new LinearClient("key", "ENG", { dryRun: true, fetch: api.fetchFn, log: (l) => logged.push(l) });
  assert.deepEqual(await linear.ensureAgendaTitle("ENG-1", "2026-10-29"), { title: "[Agenda - 2026-10-29] M1830 bathing", changed: true });
  // Another team's issue keeps its title.
  const other = new LinearClient("key", "ENG", { dryRun: true, fetch: fakeLinear({ title: "Ops task", comments: [], team: "OPS" }).fetchFn, log: () => {} });
  assert.deepEqual(await other.ensureAgendaTitle("OPS-1", "2026-10-29"), { title: "Ops task", changed: false });
  assert.equal(await linear.upsertComment("ENG-1", "body", () => false), "created");
  await linear.comment("ENG-1", "More reports");
  await linear.markDuplicate("ENG-2", "ENG-1", "dup").catch(() => {});
  const created = await linear.createTriageIssue("[Agenda - 2026-10-29] New", "desc").catch(() => null);
  assert.equal(api.mutations().length, 0);
  assert.ok(api.sent.length > 0, "queries still run");
  assert.match(logged[0]!, /^\[linear dry-run\] issueUpdate .*\[Agenda - 2026-10-29\] M1830 bathing/);
  assert.ok(logged.some((l) => l.includes("commentCreate") && l.includes('"body":"body"')));
  if (created) assert.match(created.identifier, /^DRY-RUN-/);
});

test("LINEAR_DRY_RUN=1 forces a dry run", async () => {
  process.env.LINEAR_DRY_RUN = "1";
  try {
    const api = fakeLinear({ title: "x", comments: [] });
    const linear = new LinearClient("key", "ENG", { fetch: api.fetchFn, log: () => {} });
    assert.equal(linear.dryRun, true);
    await linear.upsertComment("ENG-1", "body", () => false);
    assert.equal(api.mutations().length, 0);
  } finally {
    delete process.env.LINEAR_DRY_RUN;
  }
});

test("upsertComment: updates the marked comment in place, skips same revision and kept bodies", async () => {
  const date = "2026-10-29";
  const old = { id: "c-1", body: `${reviewHeading(date)}\n${reviewMarker(date)}\nold` };
  const api = fakeLinear({ title: `[Agenda - ${date}] x`, comments: [{ id: "c-0", body: "unrelated" }, old] });
  const linear = new LinearClient("key", "ENG", { fetch: api.fetchFn });
  const body = withRevision(`${reviewHeading(date)}\n${reviewMarker(date)}\nnew`);
  assert.equal(await linear.upsertComment("ENG-1", body, (b) => isReviewComment(b, date)), "updated");
  const [update] = api.mutations();
  assert.match(update!.query, /commentUpdate/);
  assert.equal(update!.variables.id, "c-1");

  const same = fakeLinear({ title: "x", comments: [{ id: "c-1", body }] });
  assert.equal(await new LinearClient("k", "ENG", { fetch: same.fetchFn }).upsertComment("ENG-1", body, (b) => isReviewComment(b, date)), "unchanged");
  const kept = fakeLinear({ title: "x", comments: [old] });
  assert.equal(await new LinearClient("k", "ENG", { fetch: kept.fetchFn }).upsertComment("ENG-1", body, (b) => isReviewComment(b, date), () => true), "unchanged");
  assert.equal(same.mutations().length + kept.mutations().length, 0);
  // Already prefixed: no rename.
  assert.deepEqual(await linear.ensureAgendaTitle("ENG-1", date), { title: `[Agenda - ${date}] x`, changed: false });
  assert.equal(api.mutations().length, 1);
});

test("reviewIssues (Railway): one triage comment per existing open issue, new and closed ones skipped, full review kept", async () => {
  const calls: string[] = [];
  let keepFull = false;
  const linear = {
    ensureAgendaTitle: async (id: string, date: string) => (calls.push(`title ${id}`), { title: agendaTitle(`T ${id}`, date), changed: true }),
    upsertComment: async (id: string, body: string, isMine: (b: string) => boolean, keep?: (b: string) => boolean) => {
      calls.push(`comment ${id} ${(body.match(/### Triage/g) ?? []).length}`);
      assert.ok(isMine(body));
      keepFull = Boolean(keep?.("## Agenda review — 2026-10-29\nfull, no triage-only note")) && !keep?.(body);
      return "created" as const;
    },
  };
  const card = (title: string) => ({ title, section: "Bugs & reliability", summary: "s", proposal: "p" });
  const issue = (identifier: string, extra = {}) => ({ identifier, title: "T", url: "", state: "Triage", ...extra });
  const titles = await reviewIssues(linear, "2026-10-29", [
    { issue: issue("ENG-1"), card: card("a") },
    { issue: issue("ENG-1"), card: card("b") },
    { issue: issue("ENG-2", { isNew: true }), card: card("c") },
    { issue: issue("ENG-3", { stateType: "completed" }), card: card("d") },
  ]);
  assert.deepEqual(calls, ["title ENG-1", "comment ENG-1 2"]);
  assert.equal(titles.get("ENG-1"), "[Agenda - 2026-10-29] T ENG-1");
  assert.ok(keepFull);
  assert.ok(triageReview("2026-10-29", [card("a")]).includes(TRIAGE_ONLY_NOTE));
});

// ---------- Markdown ----------

const visit = (task: string, date: string, extra: Partial<Record<string, unknown>> = {}): VisitData => ({
  task,
  data: {
    task: [{ visit_date: date, organization: "Astra", form: "OASIS-E2 SOC", clinician: "Jane Nurse", app_link: `https://app/x?visitId=${task}` }],
    fields: [
      {
        key: "M1830",
        label: "Bathing",
        ai_value: "02",
        decision: "rejected",
        rejected_via: "edit",
        decided_by: "Coder One <coder@x.com>",
        decided_at: `${date}T10:00:00Z`,
        rejection_reason: "patient showers alone",
        created_at: `${date}T09:00:00Z`,
        answers: [{ value: "01", source: "user" }],
        evidence: [{ type: "audio", at: "00:12:30", snippet: "she showers by herself" }, { type: "document", document: "Referral", page: 3, text: "needs help bathing" }],
        feedback: [],
      },
    ],
    unanswered: [{ key: "M1840", label: "Toilet transferring", answers: [{ value: "00", by: "Jane Nurse" }] }],
    no_suggestion_steps: [{ key: "M1840", abstained: true, step_key: "adl" }],
    seen_evidence: [{ key: "M1840", type: "audio", at: "00:03:10", text: "she uses the toilet without help most days" }],
    other_rejections: [],
    ...extra,
  },
});

function pack(item: Partial<Item> & Pick<Item, "id" | "origin">, extra: Partial<Pack> = {}): Pack {
  const base = { title: item.id, group: 1, linear: [], slack: [], fields: "false", badges: [], meta: [], panel: { blocks: [], placeholder: "" }, text: "" };
  return { item: { ...base, ...item } as Item, linear: [], errors: [], threads: [], visits: [], ...extra };
}

const linearIssue = (identifier: string, extra: Partial<LinearIssue> = {}): LinearIssue => ({
  identifier,
  title: `Issue ${identifier}`,
  url: "",
  description: "",
  state: { name: "Triage" },
  assignee: null,
  comments: { nodes: [] },
  ...extra,
});

function fixture() {
  const card: AgendaCard = { id: "m1830", title: "M1830 coded too high", section: "Prompts & AI output quality", urgency: "high", summary: "Coders lower M1830.", proposal: "Tighten the prompt.", issues: ["ENG-1"], sources: [], cms: { codes: [{ code: "M1830", title: "Bathing", pages: [120, 122], notes: "" }], verdict: "covered", answer: "Code by ability." } };
  const agenda = pack(
    { id: "m1830", origin: { kind: "agenda", date: "2026-10-27", agenda: "2026-10-29", cardId: "m1830" }, linear: ["ENG-1"], rows: [{ id: "r1", decidedAt: "2026-10-28", customer: "Astra", form: "SOC", field: "M1830", how: "edit", aiValue: "02", coderValue: "01", reason: "x|y", decidedBy: "Coder One", appLink: "https://app/v1", visitDate: "2026-10-20" }] },
    {
      linear: [linearIssue("ENG-1")],
      threads: [{ ref: { channel: "C1", ts: "1792084072.359189" }, link: "https://slack/t1", messages: [{ author: "Abigail", ts: "1792084072.359189", text: "M1830 is wrong again", permalink: "https://slack/p1", images: [], files: [] }] }],
      visits: [visit("t-old", "2026-10-01"), visit("t-new", "2026-10-20")],
    },
  );
  const issue = pack(
    {
      id: "ENG-1",
      origin: { kind: "issue", url: "", state: "Triage" },
      linear: ["ENG-1"],
      classification: "needs-clarification",
      classificationReason: "The manual doesn't say how to weigh a referral.",
      triage: { classification: "needs-clarification", kind: "coding-rule", reason: "r", manualVerdict: "partial", questions: ["Does the referral count?", "Which visit wins?"] },
      panel: { blocks: [{ cls: "manual", title: "📘 What the docs say (CMS manual + agency prefs)", text: "Code what the patient can do (p.121).\n\nManual: M1830 p.120–122" }], placeholder: "" },
    },
    { linear: [linearIssue("ENG-1")], visits: [visit("t-new", "2026-10-20")] },
  );
  return { card, agenda, issue };
}

test("reviewMarkdown: triage, classification, docs, questions, duplicates, reports, rows and visits newest first", () => {
  const { card, agenda, issue } = fixture();
  const md = reviewMarkdown([agenda, issue], {
    issueId: "ENG-1",
    date: "2026-10-29",
    cards: [{ card, firstSeen: "2026-10-27" }],
    duplicates: [{ a: "ENG-1", b: "ENG-9", confidence: "high", why: "same Slack thread" }],
  });
  assert.ok(md.startsWith(`${reviewHeading("2026-10-29")}\n${reviewMarker("2026-10-29")}`));
  for (const text of [
    "**What happened:** Coders lower M1830.",
    "**CMS manual:** Covered by the manual — Code by ability. (M1830 p.120–122)",
    "Needs clarification · Coding rule · Manual: partial",
    "Code what the patient can do (p.121).",
    "1. Does the referral count?",
    "- ENG-9 (high: same Slack thread)",
    "](https://slack/p1): M1830 is wrong again",
    "x\\|y",
    "AI `02` → final `01` · **rejected** (edit) by Coder One",
    "reason: patient showers alone",
    '🎙 00:12:30: "she showers by herself"',
    '📄 Referral p.3: "needs help bathing"',
    "no AI suggestion (**abstained**",
    'saw 🎙 00:03:10: "she uses the toilet',
  ])
    assert.ok(md.includes(text), `missing: ${text}`);
  assert.ok(!md.includes("coder@x.com"), "emails are stripped");
  assert.ok(md.indexOf("2026-10-20 · Astra") < md.indexOf("2026-10-01 · Astra"), "newest visit first");
  assert.equal((md.match(/2026-10-20 · Astra/g) ?? []).length, 1, "a visit in two packs shows once");
  assert.match(md, /parcerito rev [0-9a-f]{8}<\/sub>$/);
});

test("reviewMarkdown: trims oldest visits/fields under the cap with a +N line", () => {
  const { card, agenda, issue } = fixture();
  agenda.visits = Array.from({ length: 12 }, (_, i) => visit(`t${i}`, `2026-10-${String(i + 10).padStart(2, "0")}`));
  const full = reviewMarkdown([agenda, issue], { issueId: "ENG-1", date: "2026-10-29", cards: [{ card }] });
  assert.match(full, /\+3 older visits not shown/); // 12 + the issue pack's own visit
  const cap = 4_000;
  const md = reviewMarkdown([agenda, issue], { issueId: "ENG-1", date: "2026-10-29", cards: [{ card }], cap });
  assert.ok(md.length <= cap, `${md.length} > ${cap}`);
  assert.match(md, /_\+\d+ older visits?( and \d+ fields?)? not shown/);
  assert.ok(md.includes("2026-10-21 · Astra"), "the newest visit stays");
  assert.ok(!md.includes("2026-10-10 · Astra"), "the oldest is trimmed");
});

test("reviewTargets + syncReviews: one review per open newest-agenda issue, one line each", async () => {
  const { card, agenda, issue } = fixture();
  const old = pack({ id: "old", origin: { kind: "agenda", date: "2026-10-01", agenda: "2026-10-01", cardId: "old" }, linear: ["ENG-5"] });
  const closed = pack({ id: "c", origin: { kind: "agenda", date: "2026-10-29", agenda: "2026-10-29", cardId: "c" }, linear: ["ENG-7"] }, { linear: [linearIssue("ENG-7", { state: { name: "Done" } })] });
  const targets = reviewTargets([agenda, issue, old, closed], "2026-10-29", new Map([["m1830", card]]));
  assert.deepEqual(targets.map((t) => [t.issueId, t.packs.length, t.cards.length]), [["ENG-1", 2, 1]]);
  const lines: string[] = [];
  const bodies: string[] = [];
  const writer = {
    dryRun: true,
    ensureAgendaTitle: async () => ({ title: "t", changed: true }),
    upsertComment: async (_id: string, body: string, isMine: (b: string) => boolean) => {
      assert.ok(isMine(triageReview("2026-10-29", [card])), "replaces Railway's triage-only comment");
      bodies.push(body);
      return "updated" as const;
    },
  };
  const tally = await syncReviews(writer, targets, { date: "2026-10-29", log: (l) => lines.push(l) });
  assert.deepEqual(tally, { renamed: 1, written: 1, unchanged: 0, failed: 0 });
  assert.match(lines[0]!, /^✓ ENG-1 renamed \+ review updated \(dry run\)/);
  assert.match(bodies[0]!, /### Classification/);
});

// ---------- Duplicates ----------

test("duplicates pre-filter: shared thread/visit or codes + similar title; agenda prefixes ignored", () => {
  const thread = (ts: string) => ({ ref: { channel: "C1", ts }, link: "", messages: [] });
  const packs = [
    pack({ id: "ENG-1", origin: { kind: "issue", url: "", state: "Triage" } }, { linear: [linearIssue("ENG-1", { title: "[Agenda - 2026-10-29] M1830 bathing coded too high" })], threads: [thread("1.1")] }),
    pack({ id: "ENG-2", origin: { kind: "issue", url: "", state: "Triage" } }, { linear: [linearIssue("ENG-2", { title: "Bathing" })], threads: [thread("1.1")] }),
    pack({ id: "ENG-3", origin: { kind: "issue", url: "", state: "Triage" } }, { linear: [linearIssue("ENG-3", { title: "M1830 bathing coded too low" })] }),
    pack({ id: "ENG-4", origin: { kind: "issue", url: "", state: "Triage" } }, { linear: [linearIssue("ENG-4", { title: "Netsmart push timeout" })] }),
  ];
  assert.deepEqual(titleWords("[Agenda - 2026-10-29] [Netsmart] Push fails for wounds"), ["push", "fails", "wounds"]);
  const profiles = issueProfiles(packs);
  const found = candidates(profiles.get("ENG-1")!, [...profiles.values()]);
  assert.deepEqual(found.map((c) => c.profile.id), ["ENG-2", "ENG-3"]);
  assert.match(found[0]!.signals.join(), /same Slack thread/);
  assert.match(found[1]!.signals.join(), /same codes M1830 and similar titles/);
});

test("findDuplicates: one cached call per group, invented pairs dropped, pairs merged; newerOf picks the later issue", async () => {
  const thread = { ref: { channel: "C1", ts: "1.1" }, link: "", messages: [] };
  const packs = ["ENG-1", "ENG-2", "ENG-3"].map((id) => pack({ id, origin: { kind: "issue", url: "", state: "Triage" } }, { linear: [linearIssue(id, { title: `Bathing M1830 ${id}` })], threads: [thread] }));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dups-"));
  let calls = 0;
  const generate = async () => {
    calls++;
    return [
      { a: "ENG-1", b: "ENG-2", confidence: "high" as const, why: "same thread" },
      { a: "ENG-1", b: "ENG-99", confidence: "high" as const, why: "invented" },
    ];
  };
  const opts = { targets: ["ENG-1"], pool: ["ENG-2", "ENG-3"], cacheDir: dir, generate };
  const first = await findDuplicates({ CLAUDE_MODEL: "x" }, packs, opts);
  const again = await findDuplicates({ CLAUDE_MODEL: "x" }, packs, opts);
  assert.equal(calls, 1);
  assert.deepEqual(first.pairs, [{ a: "ENG-1", b: "ENG-2", confidence: "high", why: "same thread" }]);
  assert.deepEqual(again.pairs, first.pairs);
  assert.equal(again.calls, 0);
  assert.deepEqual(mergePairs([{ a: "A", b: "B", confidence: "low", why: "" }, { a: "B", b: "A", confidence: "high", why: "h" }]), [{ a: "B", b: "A", confidence: "high", why: "h" }]);
  assert.deepEqual(newerOf({ a: "ENG-10", b: "ENG-9", confidence: "high", why: "" }), { newer: "ENG-10", older: "ENG-9" });
  assert.deepEqual(newerOf({ a: "ENG-10", b: "ENG-9", confidence: "high", why: "" }, new Map([["ENG-10", "2026-01-01"], ["ENG-9", "2026-02-01"]])), { newer: "ENG-9", older: "ENG-10" });
});

test("reviewMarkdown: an umbrella agenda item's visits only show when the issue has none of its own", () => {
  const { card, agenda, issue } = fixture();
  agenda.item.linear = ["ENG-1", "ENG-2"];
  const md = reviewMarkdown([agenda, issue], { issueId: "ENG-1", date: "2026-10-29", cards: [{ card }] });
  assert.ok(!md.includes("2026-10-01 · Astra"), "umbrella visit left out");
  assert.ok(md.includes("2026-10-20 · Astra"));
  issue.visits = [];
  assert.ok(reviewMarkdown([agenda, issue], { issueId: "ENG-1", date: "2026-10-29", cards: [{ card }] }).includes("2026-10-01 · Astra"));
});
