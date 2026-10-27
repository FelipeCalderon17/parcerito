/**
 * The review hub: one local page with two top tabs. Agenda = every daily-agenda item, split into Today / Open /
 * Decided; Issues = the feedback loop's Linear issues (Megan's among them), split by classification. Item pages are
 * the Megan review's (see render.ts); decisions and classification overrides live in localStorage, and "Copy
 * decisions for parcerito" writes the same message the Nico-sync agenda does.
 */
import type { AgendaCard, Source } from "../agenda/render.js";
import { CSS, esc, GROUPS, issuePage, stats } from "./render.js";
import type { MeganTopic } from "./topics.js";
import type { Classification, Group, Item, Pack, Triage } from "./types.js";

/** What the copy button needs per item; `decision`/`notes` come from the browser. */
export interface SyncEntry {
  id: string;
  title: string;
  issues: string[];
  refs: string;
  decision: string;
  notes: string;
  card?: AgendaCard;
}

/**
 * Builds the "Copy decisions for parcerito" message: the visible lists plus the ```parcerito-sync block (see
 * src/agenda/sync.ts). Plain JS so the page runs this exact code; `syncText` below evaluates it for Node and tests.
 * Decided = any decision but Defer; the note is the decision plus the notes.
 */
export const SYNC_JS = String.raw`function syncText(agenda, entries, base64) {
  const note = (e) => [e.decision, e.notes].filter(Boolean).join(" — ");
  const isDecided = (e) => !!e.decision && e.decision !== "Defer";
  const decided = entries.filter(isDecided), open = entries.filter((e) => !isDecided(e));
  const entry = (e) => ({ id: e.id, note: note(e) });
  const line = (e) => "- " + e.title + " [" + (e.issues.join(",") || "no issue") + "]: " + (note(e) || "(no notes)") +
    (e.refs ? "\n  sources: " + e.refs : "");
  // Keeps the pasted message small: sources keep their links, long message texts are cut.
  const slim = (card) => ({ ...card, sources: (card.sources || []).map((s) => s.kind === "slack"
    ? { ...s, messages: s.messages.map((m) => ({ ...m, text: m.text.slice(0, 300) })) }
    : s.kind === "db" ? { ...s, rows: s.rows.slice(0, 20) } : s) });
  const payload = { v: 1, agenda, decided: decided.map(entry), open: open.map(entry),
    // The bot already has the newest agenda's cards; earlier-agenda and hand-added ones travel in full.
    cards: [...decided, ...open].filter((e) => e.card).map((e) => slim(e.card)) };
  const fence = String.fromCharCode(96, 96, 96);
  return "Decisions from the Nico sync " + agenda + "\n\nDecided (" + decided.length + "):\n" +
    decided.map(line).join("\n") + "\n\nNot decided, carry over to the next sync (" + open.length + "):\n" +
    open.map((e) => "- " + e.title + (note(e) ? ": " + note(e) : "")).join("\n") +
    "\n\n" + fence + "parcerito-sync\n" + base64(JSON.stringify(payload)) + "\n" + fence;
}`;

export const syncText = new Function(`${SYNC_JS}; return syncText;`)() as (
  agenda: string,
  entries: SyncEntry[],
  base64: (text: string) => string,
) => string;

/** The "sources:" line of an agenda item, as the agenda writes it. */
export function sourceRefs(sources: Source[]): string {
  return sources
    .map((s) =>
      s.kind === "slack"
        ? `slack #${s.channel} ${s.url}`
        : s.kind === "db"
          ? `db ${s.table} ids ${s.rows.map((r) => r.id).join(",")}`
          : `link ${s.url}`,
    )
    .join(" | ");
}

/**
 * Which top tab and sub-view an item is in. Plain JS so the page runs this exact code; `hubTab` below evaluates it for
 * Node and tests. Issues: the classification, unless overridden in the hub. Agenda: Decided = any decision but
 * Defer; otherwise Today if it first showed up since the last meeting, else Open.
 */
export const TABS_JS = String.raw`function hubTab(meta, since, decision, override) {
  if (meta.origin === "issue") return ["issues", override || meta.cls];
  return ["agenda", decision && decision !== "Defer" ? "decided" : meta.origin >= since ? "today" : "open"];
}`;

export const hubTab = new Function(`${TABS_JS}; return hubTab;`)() as (
  meta: { origin: string; cls?: Classification },
  since: string,
  decision: string,
  override: string,
) => [top: "agenda" | "issues", view: string];

/** Labels of the Issues sub-views (and of the classification override). */
export const CLASSES: Record<Classification, string> = {
  "needs-clarification": "Needs clarification",
  ready: "Ready to work",
  unclassified: "Unclassified",
};

/**
 * Per item, what the browser needs for tabs and the copy button. The bot only knows the newest agenda's cards, so
 * items from earlier agendas (and hand-added ones) travel in full, under their hub id.
 */
export function hubData(packs: Pack[], newest: string, since: string, cards: Map<string, AgendaCard>) {
  return {
    newest,
    since,
    items: packs.map(({ item }) => {
      const o = item.origin;
      const card = cards.get(item.id);
      return o.kind !== "agenda"
        ? { id: item.id, origin: "issue", cls: item.classification ?? "unclassified" }
        : {
            id: item.id,
            origin: o.date,
            agenda: o.agenda,
            cardId: o.agenda === newest ? o.cardId : item.id,
            title: item.title,
            issues: card?.issues ?? item.linear,
            refs: card ? sourceRefs(card.sources) : "",
            ...(card && (card.manual || o.agenda !== newest) ? { card: { ...card, id: item.id } } : {}),
          };
    }),
  };
}

const originChip = (p: Pack) =>
  p.item.origin.kind === "agenda" ? p.item.origin.date.slice(5) : p.item.origin.kind === "issue" ? p.item.id : "Megan";

/** The "ENG-1234 · state" chip of an issue item, linked to Linear. */
function issueChip(p: Pack): string {
  const o = p.item.origin;
  if (o.kind !== "issue") return "";
  const text = `${esc(p.item.id)} · ${esc(o.state)}`;
  return o.url ? `<a class="pill info" href="${esc(o.url)}" target="_blank" onclick="event.stopPropagation()">${text} ↗</a>` : `<span class="pill info">${text}</span>`;
}

const METHOD_LABEL: Record<MeganTopic["matches"][number]["method"], string> = {
  "linear-ref": "named",
  "slack-thread": "Slack thread",
  visit: "visit",
  model: "Claude",
};

/**
 * The Issues overview's "Spreadsheet topics" section: every topic of Felipe's Megan meeting spreadsheet (10-21) with
 * the hub issues it matched (and how), the ENG ids it names that aren't in the hub, or "no issue yet". Empty without topics.
 */
export function topicsSection(topics: MeganTopic[], inHub: Set<string>): string {
  if (!topics.length) return "";
  const row = (t: MeganTopic) => {
    const hub = t.matches.filter((m) => inHub.has(m.issue));
    const outside = t.linearRefs.filter((id) => !inHub.has(id));
    const links = [
      ...hub.map((m) => `<a href="#${esc(m.issue)}" title="${esc(m.why ?? "")}">${esc(m.issue)}</a> <span class="muted small">${esc(METHOD_LABEL[m.method])}</span>`),
      ...outside.map((id) => `<a href="https://linear.app/lime-health/issue/${esc(id)}" target="_blank" class="muted">${esc(id)} ↗</a> <span class="muted small">not in hub</span>`),
    ];
    return `<tr><td>${t.n}</td><td>${esc(t.topic)}${t.answer ? ` <span class="pill good">answered</span>` : ""}<div class="muted small">${esc(t.org)}</div></td>
      <td>${links.join("<br>") || `<span class="pill warn">no issue yet</span>`}</td></tr>`;
  };
  const covered = topics.filter((t) => t.matches.some((m) => inHub.has(m.issue))).length;
  return `<section id="topics" class="topics"><h2>Spreadsheet topics <span class="muted small">Megan meeting 10-21 · ${covered}/${topics.length} matched to hub issues</span></h2>
  <table class="grid"><thead><tr><th>#</th><th>Topic</th><th>Issues</th></tr></thead><tbody>${topics.map(row).join("")}</tbody></table></section>`;
}

/** The landing table: every item with its origin, visits and live status; rows are filtered by the active tab. */
function overview(packs: Pack[], newest: string, topics: MeganTopic[] = []): string {
  return `<article class="issue" id="overview">
  <header class="ihead"><div><div class="iid">Review hub · ${new Date().toISOString().slice(0, 10)}</div><h1>Review queue</h1>
    <div class="muted small">Agenda: the daily agendas up to ${esc(newest)}. Issues: the prompts &amp; forms feedback loop in Linear, by classification. Both by priority (ADLs, GG mobility, other OASIS, agency fields, narratives, other). Press → to start.</div></div>
    <div class="links"><button class="btn" id="copy">Copy decisions for parcerito</button><button class="btn ghost" id="export">Export decisions</button></div></header>
  <table class="grid overview"><thead><tr><th>Item</th><th>Group</th><th>Origin</th><th>Visits</th><th>AI</th><th>Status</th></tr></thead><tbody>
  ${packs
    .map((p) => {
      const s = stats(p);
      const o = p.item.origin;
      return `<tr data-href="#${p.item.id}" data-id="${p.item.id}"><td><b>${esc(p.item.title)}</b><div class="muted small">${esc(p.item.id)}${p.item.urgency ? ` · ${esc(p.item.urgency)}` : ""}</div>${o.kind === "issue" ? triageLine(p.item) : ""}</td><td>${esc(GROUPS[p.item.group])}</td>
        <td>${o.kind === "agenda" ? `${esc(o.date)}${o.agenda !== o.date ? `<div class="muted small">last ${esc(o.agenda)}</div>` : ""}` : issueChip(p)}</td>
        <td>${p.visits.length}</td><td class="small">${s.suggested} suggested · ${s.abstained} abstained · ${s.rejected} rejected</td>
        <td><span class="pill muted" data-status="${p.item.id}">open</span></td></tr>`;
    })
    .join("")}
  </tbody></table>
  <div class="empty" id="empty-view" hidden>Nothing in this tab.</div>
  ${topicsSection(topics, new Set(packs.filter((p) => p.item.origin.kind === "issue").map((p) => p.item.id)))}
</article>`;
}

/** Cross-links between agenda items and the issue items they reference, as a panel card (none when empty). */
function linksCard(title: string, list: Pack[]): string {
  if (!list.length) return "";
  return `
      <div class="card xlinks"><div class="ctitle">${esc(title)}</div>${list.map((p) => `<a href="#${p.item.id}"><b>${esc(p.item.origin.kind === "issue" ? p.item.id : originChip(p))}</b> ${esc(p.item.title)}</a>`).join("")}</div>`;
}

const KINDS: Record<Triage["kind"], string> = {
  "coding-rule": "Coding rule",
  "prompt-behaviour": "Prompt behaviour",
  "ehr-push": "EHR push",
  "app-bug": "App bug",
  request: "Request",
  other: "Other",
};
const VERDICTS: Record<Triage["manualVerdict"], [string, string]> = {
  covered: ["Manual: covered", "good"],
  partial: ["Manual: partial", "warn"],
  "not-in-manual": ["Not in manual", "bad"],
  "n/a": ["Manual: n/a", "muted"],
};

/** "Kind · reason" of a classified issue for the overview, one line. */
export function triageLine(item: Item): string {
  const t = item.triage;
  const reason = item.classificationReason ?? "";
  const text = [t ? KINDS[t.kind] : "", reason.length > 160 ? `${reason.slice(0, 159)}…` : reason].filter(Boolean).join(" · ");
  return text ? `<div class="muted small">${esc(text)}</div>` : "";
}

/**
 * An issue's decision card: the automatic classification (class, kind, manual verdict, reason, the agency-doc sections
 * it was given and the next step when ready; the questions for Megan render as the questions card) and an override
 * (stored as `<id>:class`), plus notes.
 */
export function classCard(p: Pack): string {
  const { item } = p;
  const cls = item.classification ?? "unclassified";
  const t = item.triage;
  const pills = [
    `<span class="pill ${cls === "ready" ? "good" : cls === "needs-clarification" ? "warn" : "muted"}">${esc(CLASSES[cls])}</span>`,
    ...(t ? [`<span class="pill info">${esc(KINDS[t.kind])}</span>`, `<span class="pill ${VERDICTS[t.manualVerdict][1]}">${esc(VERDICTS[t.manualVerdict][0])}</span>`] : []),
  ];
  return `<div class="card decision"><div class="ctitle">🏷 Classification</div>
        <div class="muted small">Automatic: ${pills.join(" ")}</div>
        ${item.classificationReason ? `<p>${esc(item.classificationReason)}</p>` : ""}
        ${item.agencySources?.length ? `<div class="muted small">Agency docs given:<ul>${item.agencySources.map((s) => `<li>${esc(s)}</li>`).join("")}</ul></div>` : ""}
        ${t?.classification === "ready" && t.nextStep ? `<div class="callout info"><b>Next step</b>${esc(t.nextStep)}</div>` : ""}
        <div class="seg">${(["needs-clarification", "ready"] as const).map((c) => `<label><input type="radio" name="${item.id}-class" value="${c}" data-save="${item.id}:class"><span>${CLASSES[c]}</span></label>`).join("")}</div>
        <button class="btn ghost small" data-clear="${item.id}:class">Clear override</button>
        <textarea data-save="${item.id}:notes" placeholder="${esc(item.panel.placeholder)}"></textarea>
      </div>`;
}

/**
 * The complete hub page; `packs` in priority order, `newest` = the newest agenda date, `since` = the first agenda
 * since the last meeting (Today holds everything that showed up from then on), `topics` = the spreadsheet's topics.
 */
export function renderHub(packs: Pack[], newest: string, cards: Map<string, AgendaCard>, since = newest, topics: MeganTopic[] = []): string {
  const issues = new Map(packs.filter((p) => p.item.origin.kind !== "agenda").map((p) => [p.item.id, p]));
  const agenda = packs.filter((p) => p.item.origin.kind === "agenda");
  const page = (p: Pack, i: number) =>
    p.item.origin.kind === "agenda"
      ? issuePage(p, i, packs.length, { aside: linksCard("🔗 Issues in the hub", p.item.linear.flatMap((id) => issues.get(id) ?? [])) })
      : issuePage(p, i, packs.length, {
          aside: linksCard("🗓 On the agenda", agenda.filter((a) => a.item.linear.includes(p.item.id))),
          decision: classCard(p),
        });
  const side = ([1, 2, 3, 4, 5, 6] as Group[])
    .map((g) => {
      const items = packs.filter((p) => p.item.group === g);
      if (!items.length) return "";
      return `<div class="group"><div class="gtitle">${esc(GROUPS[g])}</div>${items
        .map(
          (p) =>
            `<a href="#${p.item.id}" data-id="${p.item.id}"><span class="dot" data-dot="${p.item.id}"></span><span class="ochip"${p.item.origin.kind === "issue" ? ` title="${esc(p.item.origin.state)}"` : ""}>${esc(originChip(p))}</span><span class="ntitle">${esc(p.item.title.replace(/^(Validate|Review|Investigate)\s+/, ""))}</span>${p.item.urgency ? `<span class="urg ${esc(p.item.urgency)}" title="${esc(p.item.urgency)} urgency"></span>` : ""}</a>`,
        )
        .join("")}</div>`;
    })
    .join("");
  const views = (top: string, list: [string, string][]) =>
    `<nav class="htabs" data-for="${top}">${list.map(([v, label]) => `<button data-view="${v}">${esc(label)}<b></b></button>`).join("")}</nav>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Review hub · ${new Date().toISOString().slice(0, 10)}</title><style>${CSS}${HUB_CSS}</style></head><body>
<aside class="side">
  <div class="brand"><div class="logo">L</div><div><b>Review hub</b><div class="muted small">Contains PHI · local only</div></div></div>
  <nav class="toptabs"><button data-top="agenda">Agenda<b></b></button><button data-top="issues">Issues<b></b></button></nav>
  ${views("agenda", [["today", "Today"], ["open", "Open"], ["decided", "Decided"]])}
  ${views("issues", Object.entries(CLASSES) as [string, string][])}
  <div class="progress"><div class="bar"><i id="bar"></i></div><span class="muted small" id="done"></span></div>
  <input id="search" placeholder="Search items…  ( / )">
  <a href="#overview" class="ov" data-id="overview">▦ Overview</a>
  ${side}
  <div class="muted small keys">← → navigate within the tab · / search</div>
</aside>
<main>${overview(packs, newest, topics)}${packs.map(page).join("")}</main>
<div id="lightbox" hidden><img></div>
<script type="application/json" id="hub-data">${JSON.stringify(hubData(packs, newest, since, cards)).replace(/</g, "\\u003c")}</script>
<script>${SYNC_JS}
${TABS_JS}
${HUB_CLIENT}</script></body></html>`;
}

const HUB_CSS = `
.toptabs{display:grid;grid-template-columns:1fr 1fr;gap:4px;margin-bottom:6px}
.toptabs button{background:var(--bg);border:1px solid var(--line);color:var(--muted);padding:8px 4px;border-radius:10px;font:inherit;font-size:14px;font-weight:600;cursor:pointer}
.toptabs button.on{background:var(--panel2);color:var(--text);border-color:var(--accent)}.toptabs b{margin-left:6px;color:var(--accent2)}
.htabs{display:grid;grid-template-columns:repeat(3,1fr);gap:3px;margin-bottom:12px;background:var(--bg);border:1px solid var(--line);border-radius:10px;padding:3px}
.htabs[hidden]{display:none}
.htabs button{background:none;border:0;color:var(--muted);padding:6px 4px;border-radius:8px;font:inherit;font-size:13px;line-height:1.2;cursor:pointer}
.htabs button.on{background:var(--panel2);color:var(--text);box-shadow:inset 0 -2px 0 var(--accent)}.htabs b{margin-left:5px;color:var(--accent2);font-weight:600}
.ochip{font-family:"JetBrains Mono",ui-monospace,monospace;font-size:11px;color:var(--muted);flex:none;min-width:38px}
.urg{width:6px;height:6px;border-radius:50%;flex:none;align-self:center;margin-left:auto}.urg.high{background:var(--bad)}.urg.medium{background:var(--warn)}.urg.low{background:var(--info)}
.card p{white-space:pre-wrap}.what{border-color:rgba(94,234,212,.35)}.proposal{border-color:rgba(139,125,255,.35)}
.xlinks a{display:block;font-size:13px;margin-top:6px;color:var(--text);text-decoration:none}.xlinks a:hover{color:var(--accent2)}.xlinks b{color:var(--accent2);font-weight:600}
.dot[data-s="needs-clarification"]{background:var(--warn)}.dot[data-s="ready"]{background:var(--good)}
.links{display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end}
.topics{margin-top:22px}.topics[hidden]{display:none}.topics h2{font-size:16px;margin:0 0 8px}.topics td{vertical-align:top}.megan-topic{border-color:rgba(250,204,21,.35)}.thread table.grid{margin:10px 0 6px}
`;

/** Browser script: the Megan page's navigation/persistence plus the top tabs, sub-views, overrides and the copy button. */
const HUB_CLIENT = `
const $ = (s, el = document) => el.querySelector(s), $$ = (s, el = document) => [...el.querySelectorAll(s)];
const ids = $$(".issue").map((a) => a.id);
const items = ids.filter((id) => id !== "overview");
const KEY = "review-hub:";
const DATA = JSON.parse($("#hub-data").textContent);
const META = new Map(DATA.items.map((i) => [i.id, i]));
const CLASSES = ${JSON.stringify(CLASSES)};
let topTab = localStorage.getItem(KEY + "@top") || "agenda";
const view = { agenda: localStorage.getItem(KEY + "@view") || "today", issues: localStorage.getItem(KEY + "@issues-view") || "needs-clarification" };

const decision = (id) => localStorage.getItem(KEY + id + ":decision") || "";
const override = (id) => localStorage.getItem(KEY + id + ":class") || "";
const tabOf = (id) => hubTab(META.get(id), DATA.since, decision(id), override(id));
const inView = (id) => id === "overview" || (tabOf(id)[0] === topTab && tabOf(id)[1] === view[topTab]);

function show() {
  const id = ids.includes(location.hash.slice(1)) ? location.hash.slice(1) : "overview";
  // Following a cross-link into the other top tab switches to it.
  if (id !== "overview" && !inView(id)) { topTab = tabOf(id)[0]; view[topTab] = tabOf(id)[1]; status(); }
  $$(".issue").forEach((a) => a.classList.toggle("on", a.id === id));
  $$(".side a").forEach((a) => a.classList.toggle("on", a.dataset.id === id));
  $(".side a.on")?.scrollIntoView({ block: "nearest" });
  window.scrollTo(0, 0);
}
// Next/previous item within the active tab.
function go(step) {
  for (let i = ids.indexOf($(".issue.on").id) + step; i >= 0 && i < ids.length; i += step)
    if (inView(ids[i])) return void (location.hash = ids[i]);
}
addEventListener("hashchange", show);
addEventListener("keydown", (e) => {
  if (/INPUT|TEXTAREA/.test(document.activeElement.tagName)) { if (e.key === "Escape") document.activeElement.blur(); return; }
  if (e.key === "ArrowRight") go(1);
  if (e.key === "ArrowLeft") go(-1);
  if (e.key === "/") { e.preventDefault(); $("#search").focus(); }
  if (e.key === "Escape") $("#lightbox").hidden = true;
});
$$("[data-go]").forEach((b) => b.addEventListener("click", () => go(b.dataset.go === "next" ? 1 : -1)));
$$(".overview tr[data-href]").forEach((r) => r.addEventListener("click", () => (location.hash = r.dataset.href)));

// Tabs per item.
$$(".issue").forEach((issue) =>
  $$(".tabs button", issue).forEach((b) =>
    b.addEventListener("click", () => {
      $$(".tabs button", issue).forEach((x) => x.classList.toggle("on", x === b));
      $$(".tab", issue).forEach((t) => (t.hidden = t.dataset.tab !== b.dataset.tab));
    }),
  ),
);

// Top tab + sub-view filter the sidebar and the overview; search narrows the sidebar further.
function filter() {
  const q = $("#search").value.toLowerCase();
  $$(".side a[data-id]").forEach((a) => (a.style.display = inView(a.dataset.id) && (!q || a.textContent.toLowerCase().includes(q)) ? "" : "none"));
  $$(".side .group").forEach((g) => (g.style.display = $$("a[data-id]", g).some((a) => a.style.display !== "none") ? "" : "none"));
  $$(".overview tr[data-id]").forEach((r) => (r.hidden = !inView(r.dataset.id)));
  $$(".toptabs button").forEach((b) => {
    b.classList.toggle("on", b.dataset.top === topTab);
    $("b", b).textContent = items.filter((id) => tabOf(id)[0] === b.dataset.top).length;
  });
  $$(".htabs").forEach((nav) => {
    nav.hidden = nav.dataset.for !== topTab;
    $$("button", nav).forEach((b) => {
      b.classList.toggle("on", b.dataset.view === view[nav.dataset.for]);
      $("b", b).textContent = items.filter((id) => tabOf(id)[0] === nav.dataset.for && tabOf(id)[1] === b.dataset.view).length;
    });
  });
  $("#empty-view").hidden = items.some(inView);
  if ($("#topics")) $("#topics").hidden = topTab !== "issues";
}
$$(".toptabs button").forEach((b) => b.addEventListener("click", () => {
  topTab = b.dataset.top; localStorage.setItem(KEY + "@top", topTab); status(); location.hash = "overview";
}));
$$(".htabs button").forEach((b) => b.addEventListener("click", () => {
  const t = b.closest(".htabs").dataset.for;
  view[t] = b.dataset.view; localStorage.setItem(KEY + (t === "agenda" ? "@view" : "@issues-view"), view[t]); filter(); location.hash = "overview";
}));
$("#search").addEventListener("input", filter);

// Persist questions, decision, classification override and notes in the browser.
function load() {
  $$("[data-save]").forEach((el) => {
    const v = localStorage.getItem(KEY + el.dataset.save);
    if (el.type === "checkbox") el.checked = v === "1";
    else if (el.type === "radio") el.checked = v === el.value;
    else el.value = v ?? "";
  });
}
// Agenda items show their decision; issues their (overridden) classification. Progress counts the active top tab.
function status() {
  items.forEach((id) => {
    const [t, sub] = tabOf(id);
    const s = t === "issues" ? sub : decision(id);
    const dot = $('[data-dot="' + id + '"]'); if (dot) dot.dataset.s = t === "issues" ? sub : s;
    const pill = $('[data-status="' + id + '"]');
    if (pill) {
      pill.textContent = t === "issues" ? CLASSES[sub] + (override(id) ? " (set)" : "") : s || "open";
      pill.className = "pill " + (t === "issues" ? (sub === "unclassified" ? "muted" : "on") : s ? "on" : "muted");
    }
  });
  const mine = items.filter((id) => tabOf(id)[0] === topTab);
  const done = mine.filter((id) => (topTab === "issues" ? tabOf(id)[1] !== "unclassified" : tabOf(id)[1] === "decided")).length;
  $("#done").textContent = done + " / " + mine.length + (topTab === "issues" ? " classified" : " decided");
  $("#bar").style.width = (100 * done) / Math.max(mine.length, 1) + "%";
  filter();
}
$$("[data-save]").forEach((el) =>
  el.addEventListener(el.tagName === "TEXTAREA" ? "input" : "change", () => {
    localStorage.setItem(KEY + el.dataset.save, el.type === "checkbox" ? (el.checked ? "1" : "") : el.value);
    status();
  }),
);
$$("[data-clear]").forEach((b) => b.addEventListener("click", () => {
  localStorage.removeItem(KEY + b.dataset.clear);
  $$('[data-save="' + b.dataset.clear + '"]').forEach((r) => (r.checked = false));
  status();
}));

// Long bot messages expand on click; screenshots open in a lightbox.
$$(".mtext.clamp").forEach((m) => m.addEventListener("click", () => m.classList.toggle("open")));
$$("[data-zoom]").forEach((img) => img.addEventListener("click", () => { $("#lightbox img").src = img.src; $("#lightbox").hidden = false; }));
$("#lightbox").addEventListener("click", () => ($("#lightbox").hidden = true));

// Every agenda item seen since the last meeting, in the agenda's own format, for the bot (issues stay out).
const base64 = (text) => {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
};
$("#copy").addEventListener("click", async () => {
  const entries = DATA.items.filter((i) => i.agenda && i.agenda >= DATA.since).map((i) => ({
    id: i.cardId, title: i.title, issues: i.issues, refs: i.refs, card: i.card,
    decision: decision(i.id), notes: localStorage.getItem(KEY + i.id + ":notes") || "" }));
  await navigator.clipboard.writeText(syncText(DATA.newest, entries, base64));
  const button = $("#copy"); button.textContent = "Copied ✓";
  setTimeout(() => (button.textContent = "Copy decisions for parcerito"), 1500);
});

// Export every item's decision (issues: classification) as Markdown, ready to paste into Linear or Slack.
$("#export").addEventListener("click", () => {
  const out = items.map((id) => {
    const art = document.getElementById(id);
    const qs = $$(".q", art).map((q) => "- [" + ($("input", q).checked ? "x" : " ") + "] " + q.textContent.trim()).join("\\n");
    const n = localStorage.getItem(KEY + id + ":notes") || "";
    const [t, sub] = tabOf(id);
    const head = t === "issues" ? "**Classification:** " + CLASSES[sub] : "**Decision:** " + (decision(id) || "open");
    return "## " + id + " · " + $("h1", art).textContent + "\\n" + head + "\\n" + qs + (n ? "\\n\\n" + n : "");
  }).join("\\n\\n");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([out], { type: "text/markdown" }));
  a.download = "review-hub-decisions-" + new Date().toISOString().slice(0, 10) + ".md";
  a.click();
});

load(); status(); show();
`;
