import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgendaCard } from "../src/agenda/render.js";
import { parseSync } from "../src/agenda/sync.js";
import { slackRefs, visitRefs } from "../src/review/gather.js";
import { hubTab, syncText, type SyncEntry } from "../src/review/hub.js";
import { classify, inScope, issueFresh, issueItems } from "../src/review/issues.js";
import { ISSUES } from "../src/review/megan-issues.js";
import type { LinearIssue } from "../src/review/types.js";
import { agendaItem, cmsBlock, fieldKeys, fieldPredicate, groupOf, hubId, isFresh, mergeAgendas, parseAgendaHtml, sortItems } from "../src/review/items.js";
import { topicOf } from "../src/review/queries.js";
import { excerpt, fieldCard, fieldInstruction } from "../src/review/render.js";

const UUID_A = "11111111-2222-3333-4444-555555555555";
const UUID_B = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

test("slackRefs reads thread URLs, archive permalinks and checkpoints, once each", () => {
  const text = [
    "https://app.slack.com/client/T1/C1/thread/C1-1792084072.359189",
    "https://lime.slack.com/archives/C1/p1792084072359189",
    "https://lime.slack.com/archives/C2/p1792084100000001?thread_ts=1792084000.000002",
    "channel C3; root/message 1792084200.000003",
  ].join("\n");
  assert.deepEqual(slackRefs(text), [
    { channel: "C1", ts: "1792084072.359189" },
    { channel: "C2", ts: "1792084000.000002" },
    { channel: "C3", ts: "1792084200.000003" },
  ]);
});

test("visitRefs collects distinct visit ids and explicitly named task ids", () => {
  const text = `see ?visitId=${UUID_A}&x and visitId=${UUID_A}; task_id: ${UUID_B}, Task \`${UUID_B}\``;
  assert.deepEqual(visitRefs(text), { visits: [UUID_A], tasks: [UUID_B] });
});

test("fieldInstruction picks the field's section out of the INSTRUCTIONS block", () => {
  const line = '{"key":"M1840","instruction": "toilet"}';
  const block = "[bathing]\nWhole body.\n[toilet]\nUse the more severe option.\nNo dash.\n[dressing]\nUpper body.";
  assert.equal(fieldInstruction(line, block), "Use the more severe option.\nNo dash.");
  assert.equal(fieldInstruction('{"key":"M1840"}', block), null);
  assert.equal(fieldInstruction('{"instruction": "missing"}', block), null);
});

test("excerpt highlights the item's topic words and trims around them", () => {
  const pattern = topicOf("M1840.1")!;
  assert.ok(pattern.includes("commode"));
  const text = `${"x".repeat(400)} she uses a bedside commode at night ${"y".repeat(400)}`;
  const out = excerpt(text, pattern);
  assert.match(out, /<mark>commode<\/mark>/);
  assert.ok(out.startsWith("…") && out.endsWith("…"));
  assert.equal(topicOf("Z9999"), undefined);
});

test("fieldCard escapes values and labels", () => {
  const html = fieldCard(
    { key: "M1840", label: "Toilet <transfer>", ai_value: "<b>3</b>", decision: "rejected", rejected_via: "edit", answers: [] },
    "",
  );
  assert.match(html, /Toilet &lt;transfer&gt;/);
  assert.match(html, /&lt;b&gt;3&lt;\/b&gt;/);
  assert.match(html, /overwritten by editing the answer/);
  assert.doesNotMatch(html, /<b>3<\/b>/);
});

// ---------- Review hub ----------

const card = (over: Partial<AgendaCard>): AgendaCard => ({ id: "x", title: "X", section: "Bugs", issues: [], sources: [], ...over });
const agendaHtml = (agenda: string, items: AgendaCard[]) =>
  `<html><body><script type="application/json" id="agenda-data">${JSON.stringify({ agenda, window: {}, items }).replace(/</g, "\\u003c")}</script></body></html>`;

test("parseAgendaHtml reads the embedded agenda data and rejects anything else", () => {
  const parsed = parseAgendaHtml(agendaHtml("2026-10-22", [card({ id: "a", title: "Uses <b>" })]));
  assert.equal(parsed?.agenda, "2026-10-22");
  assert.equal(parsed?.items[0]?.title, "Uses <b>");
  assert.equal(parseAgendaHtml("<html></html>"), null);
  assert.equal(parseAgendaHtml(`<script type="application/json" id="agenda-data">{oops</script>`), null);
  assert.equal(parseAgendaHtml(agendaHtml("yesterday", [])), null);
});

test("mergeAgendas keeps the newest card, the oldest date and dates positional rejected ids", () => {
  const merged = mergeAgendas([
    { agenda: "2026-10-22", items: [card({ id: "a", title: "new" }), card({ id: "rejected-0" }), card({ id: "c", carriedFrom: "2026-10-15" })] },
    { agenda: "2026-10-21", items: [card({ id: "a", title: "old" }), card({ id: "rejected-0" })] },
  ]);
  assert.deepEqual([...merged.keys()].sort(), ["2026-10-21-rejected-0", "2026-10-22-rejected-0", "a", "c"]);
  assert.equal(merged.get("a")?.card.title, "new");
  assert.equal(merged.get("a")?.first, "2026-10-21");
  assert.equal(merged.get("a")?.last, "2026-10-22");
  assert.equal(merged.get("c")?.first, "2026-10-15");
  assert.equal(hubId("we ird/id", "2026-10-22"), "we_ird_id");
});

test("fieldPredicate only lets [A-Za-z0-9_.] into the SQL", () => {
  const keys = fieldKeys("Gene says M1830'; drop table field; -- and GG0170C, lime.vital_signs'); delete, and M1033 again M1830");
  assert.deepEqual(keys, { oasis: ["M1830", "GG0170C", "M1033"], lime: ["lime.vital_signs"] });
  assert.equal(fieldPredicate(keys), "(fd.key ~* '^(M1830|GG0170C|M1033)' or fd.key in ('lime.vital_signs'))");
  assert.equal(fieldPredicate({ oasis: ["M1830'; drop"], lime: ["lime.x' or '1'='1"] }), "false");
  assert.equal(fieldPredicate(fieldKeys("nothing here, ENG-3523 C0C71JQ499U")), "false");
});

test("groupOf orders ADLs, GG, other OASIS, narratives, agency fields, then the rest", () => {
  assert.equal(groupOf(fieldKeys("M1830 and GG0170C"), ""), 1);
  assert.equal(groupOf(fieldKeys("GG0170C A1110"), ""), 2);
  assert.equal(groupOf(fieldKeys("A1110 D0150"), ""), 3);
  assert.equal(groupOf(fieldKeys("lime.skilled_narrative"), ""), 5);
  assert.equal(groupOf(fieldKeys(""), "Per-visit narrative templates"), 5);
  assert.equal(groupOf(fieldKeys("lime.vital_signs"), ""), 4);
  assert.equal(groupOf(fieldKeys("push failed"), "Kinnser push"), 6);
});

test("agendaItem derives fields, group and panel from the card; sortItems goes group → urgency → id", () => {
  const item = agendaItem("r", {
    card: card({
      id: "r",
      title: "Bathing",
      summary: "Coders reject",
      proposal: "Tighten",
      urgency: "high",
      issues: ["ENG-1", "ENG-1"],
      sources: [
        { kind: "slack", channel: "c", channelId: "C1", threadTs: "1.2", url: "u", messages: [{ author: "a", from: "x", at: "", text: "M1830 wrong", url: "" }] },
      ],
    }),
    first: "2026-10-21",
    last: "2026-10-22",
  });
  // A code only mentioned in the chat feeds the visit query but doesn't set the group; the card's own words do.
  assert.equal(item.group, 6);
  assert.equal(item.fields, "(fd.key ~* '^(M1830)')");
  const named = agendaItem("n", { card: card({ id: "n", title: "M1830 bathing", issues: [], sources: [] }), first: "2026-10-22", last: "2026-10-22" });
  assert.equal(named.group, 1);
  assert.deepEqual(item.linear, ["ENG-1"]);
  assert.deepEqual(item.slack, [{ channel: "C1", ts: "1.2" }]);
  assert.deepEqual(item.panel.blocks.map((b) => b.text), ["Coders reject", "Tighten"]);
  assert.equal(item.panel.questions, undefined);
  const order = sortItems([
    { id: "b", group: 6 },
    { id: "z", group: 1 },
    { id: "a", group: 1, urgency: "low" as const },
    { id: "c", group: 1, urgency: "high" as const },
  ]).map((i) => i.id);
  assert.deepEqual(order, ["c", "a", "z", "b"]);
});

test("syncText writes the agenda's copy format and round-trips through parseSync", () => {
  const entries: SyncEntry[] = [
    { id: "a", title: "Bathing", issues: ["ENG-1"], refs: "slack #c u", decision: "Approved", notes: "ship it" },
    { id: "b", title: "Push", issues: [], refs: "", decision: "Defer", notes: "" },
    { id: "m", title: "Manual", issues: [], refs: "", decision: "", notes: "café", card: card({ id: "m", manual: true }) },
  ];
  const text = syncText("2026-10-22", entries, (s) => Buffer.from(s, "utf8").toString("base64"));
  assert.ok(text.startsWith("Decisions from the Nico sync 2026-10-22\n\nDecided (1):\n- Bathing [ENG-1]: Approved — ship it\n  sources: slack #c u"));
  assert.match(text, /Not decided, carry over to the next sync \(2\):\n- Push: Defer\n- Manual: café\n\n```parcerito-sync\n/);
  const payload = parseSync(text);
  assert.deepEqual(payload && { ...payload, cards: payload.cards.map((c) => c.id) }, {
    v: 1,
    agenda: "2026-10-22",
    decided: [{ id: "a", note: "Approved — ship it" }],
    open: [
      { id: "b", note: "Defer" },
      { id: "m", note: "café" },
    ],
    cards: ["m"],
  });
});

test("isFresh: items last seen since the last meeting refetch, never Megan items", () => {
  const agenda = (last: string) => ({ origin: { kind: "agenda" as const, date: "2026-10-20", agenda: last, cardId: "c" } });
  assert.equal(isFresh(agenda("2026-10-26"), "2026-10-26"), true);
  assert.equal(isFresh(agenda("2026-10-23"), "2026-10-26"), false);
  assert.equal(isFresh(agenda("2026-10-23"), "2026-10-22"), true);
  assert.equal(isFresh({ origin: { kind: "megan" } }, "2026-10-26"), false);
});

test("agendaItem's manual block: the card's cms first, else codes/pages from the index, else lime-only", () => {
  const index = {
    source: "s",
    version: "v",
    builtAt: "b",
    general: [],
    items: {
      M1830: { code: "M1830", title: "Bathing", pages: [125, 126] as [number, number], text: "" },
      GG0170: { code: "GG0170", title: "Mobility", pages: [136, 156] as [number, number], text: "" },
      GG0170C: { code: "GG0170C", title: "Lying to Sitting", pages: [156, 158] as [number, number], text: "" },
    },
  };
  const withCms = agendaItem(
    "c",
    {
      card: card({
        summary: "s",
        cms: { codes: [{ code: "M1830", title: "Bathing", pages: [125, 126], notes: "Dash not valid (p.126)" }], verdict: "partial", answer: "Helps (p.125)." },
      }),
      first: "2026-10-26",
      last: "2026-10-26",
    },
    index,
  );
  assert.deepEqual(withCms.panel.blocks[0], {
    cls: "manual",
    title: "📘 CMS OASIS-E2 manual",
    text: "Manual: partial — Helps (p.125).\n\nM1830 Bathing · p.125–126\nDash not valid (p.126)",
  });
  assert.ok(withCms.badges.some((b) => b.text === "Manual: partial" && b.kind === "warn"));
  // Older cards: deterministic, from the card's own words and rejected rows; chat-only codes don't count.
  const db = { kind: "db" as const, database: "d", table: "t", exportedAt: "", rows: [{ field: "M1830_CRNT_BATHG" } as never] };
  assert.deepEqual(cmsBlock(card({ title: "GG0170C1 wrong", sources: [db] }), index)[0]?.text, [
    "GG0170C Lying to Sitting · p.156–158",
    "GG0170 Mobility · p.136–156",
    "M1830 Bathing · p.125–126",
  ].join("\n"));
  assert.equal(cmsBlock(card({ title: "Vitals", summary: "lime.vital_signs empty" }), index)[0]?.text, "Agency field (lime.*) — not in the CMS manual");
  const chatOnly = { kind: "slack" as const, channel: "c", channelId: "C", threadTs: "1", url: "u", messages: [{ author: "a", from: "x", at: "", text: "M1830", url: "" }] };
  assert.deepEqual(cmsBlock(card({ title: "Push failed", sources: [chatOnly] }), index), []);
  assert.deepEqual(cmsBlock(card({ title: "M1830" }), null), []);
});

// ---------- Issues tab ----------

const linear = (over: Partial<LinearIssue>): LinearIssue => ({
  identifier: "ENG-1",
  title: "T",
  url: "https://linear.app/x/issue/ENG-1",
  description: "",
  state: { name: "Triage", type: "triage" },
  assignee: null,
  comments: { nodes: [] },
  labels: { nodes: [] },
  ...over,
});
const labelled = (...names: string[]) => ({ nodes: names.map((name) => ({ name })) });

test("inScope: Dotterino/parcerito markers, loop labels or a reference; never Infra / Sentry or closed states", () => {
  const none = new Set<string>();
  assert.equal(inScope(linear({ description: "…\nSource checkpoint: channel C1; root/message 1.2" }), none), true);
  assert.equal(inScope(linear({ description: "Filed by parcerito on Dotterino's behalf (the message wasn't tracked)." }), none), true);
  assert.equal(inScope(linear({ description: "🤖 Opus on behalf of Nicolas" }), none), false);
  assert.equal(inScope(linear({ labels: labelled("Bug", "Felipe · Nico sync") }), none), true);
  assert.equal(inScope(linear({ labels: labelled("parcerito") }), none), true);
  assert.equal(inScope(linear({}), none), false);
  assert.equal(inScope(linear({}), new Set(["ENG-1"])), true);
  assert.equal(inScope(linear({ labels: labelled("parcerito", "Infra / Sentry") }), none), false);
  assert.equal(inScope(linear({ state: { name: "Done", type: "completed" } }), new Set(["ENG-1"])), false);
  assert.equal(inScope(linear({ description: null as unknown as string, labels: undefined }), new Set(["ENG-1"])), true);
});

test("classify: Megan → needs clarification (her verdict), planned/started → ready, else unclassified", () => {
  assert.deepEqual(classify({ name: "Backlog", type: "backlog" }, { verdict: "partial" }), {
    classification: "needs-clarification",
    classificationReason: "Manual: partial",
  });
  assert.equal(classify({ name: "Done", type: "completed" }, { verdict: "not-in-manual" }).classificationReason, "Not in manual");
  for (const state of [{ name: "Todo", type: "unstarted" }, { name: "In Progress", type: "started" }, { name: "In Review" }, { name: "Blocked", type: "started" }])
    assert.deepEqual(classify(state), { classification: "ready", classificationReason: "already planned" });
  assert.deepEqual(classify({ name: "Triage", type: "triage" }), { classification: "unclassified" });
  assert.deepEqual(classify({ name: "Backlog", type: "backlog" }), { classification: "unclassified" });
});

test("issueItems: one item per issue, Megan's data merged onto hers, her missing issues still listed", () => {
  const megan = ISSUES.slice(0, 2);
  const [a, b] = megan as [(typeof ISSUES)[number], (typeof ISSUES)[number]];
  const loop = [
    linear({
      identifier: a.id,
      title: "Toileting M1840",
      description: "Coders reject. https://lime.slack.com/archives/C1/p1792084072359189",
      state: { name: "Todo", type: "unstarted" },
      labels: labelled("parcerito"),
    }),
    linear({ identifier: "ENG-9", title: "Vitals", description: "lime.vital_signs empty", comments: { nodes: [{ body: "see GG0170C", createdAt: "", user: null }] } }),
  ];
  const items = issueItems(loop, megan, new Map([[b.id, linear({ identifier: b.id, title: "Bathing", state: { name: "Done", type: "completed" } })]]), null);
  assert.deepEqual(items.map((i) => i.id), [a.id, "ENG-9", b.id]);
  const [ma, other, mb] = items as [(typeof items)[number], (typeof items)[number], (typeof items)[number]];
  // Megan's curated data wins over what the issue text would give.
  assert.equal(ma.fields, a.fields);
  assert.equal(ma.group, a.group);
  assert.equal(ma.verdict, a.verdict);
  assert.equal(ma.classification, "needs-clarification");
  assert.equal(ma.panel.questions?.title, "❓ Questions for Megan");
  assert.deepEqual(ma.panel.questions?.items, a.ask);
  assert.equal(ma.panel.blocks[0]?.text, a.manual);
  assert.ok(ma.panel.blocks.some((b) => b.title === "📄 Issue"));
  assert.ok(ma.badges.some((x) => x.text === "Todo") && ma.badges.some((x) => x.text === "parcerito"));
  assert.deepEqual(ma.slack, [{ channel: "C1", ts: "1792084072.359189" }]);
  assert.deepEqual(ma.origin, { kind: "issue", url: "https://linear.app/x/issue/ENG-1", state: "Todo", stateType: "unstarted", updatedAt: undefined });
  // Non-Megan: fields from title + description + comments, group from title + description only (the GG code is
  // only in a comment, so it's an agency-field issue).
  assert.equal(other.classification, "unclassified");
  assert.equal(other.group, 4);
  assert.equal(other.fields, "(fd.key ~* '^(GG0170C)' or fd.key in ('lime.vital_signs'))");
  assert.equal(mb.classification, "needs-clarification");
  assert.equal(mb.title, "Bathing");
  // A Megan issue Linear couldn't load at all still gets her page.
  const lost = issueItems([], [a], new Map(), null)[0]!;
  assert.equal(lost.origin.kind, "issue");
  assert.equal(lost.panel.blocks.length, 1);
  assert.equal(lost.badges.length, 1);
});

test("issueFresh: on a fresh agenda, or changed in Linear since the last gather", () => {
  const item = (updatedAt?: string) => ({ id: "ENG-1", origin: { kind: "issue" as const, url: "", state: "Triage", updatedAt } });
  assert.equal(issueFresh(item("2026-10-26"), { "ENG-1": "2026-10-26" }, new Set()), false);
  assert.equal(issueFresh(item("2026-10-26"), { "ENG-1": "2026-10-25" }, new Set()), true);
  assert.equal(issueFresh(item("2026-10-26"), {}, new Set()), true);
  assert.equal(issueFresh(item(undefined), {}, new Set()), false);
  assert.equal(issueFresh(item(undefined), {}, new Set(["ENG-1"])), true);
});

test("hubTab: issues by (overridden) classification, agenda by decision and date", () => {
  const issue = { origin: "issue", cls: "unclassified" as const };
  assert.deepEqual(hubTab(issue, "2026-10-22", "", ""), ["issues", "unclassified"]);
  assert.deepEqual(hubTab(issue, "2026-10-22", "Approved", "ready"), ["issues", "ready"]);
  const agenda = (date: string) => ({ origin: date });
  assert.deepEqual(hubTab(agenda("2026-10-23"), "2026-10-22", "", ""), ["agenda", "today"]);
  assert.deepEqual(hubTab(agenda("2026-10-21"), "2026-10-22", "Defer", ""), ["agenda", "open"]);
  assert.deepEqual(hubTab(agenda("2026-10-21"), "2026-10-22", "Change prompt", ""), ["agenda", "decided"]);
});
