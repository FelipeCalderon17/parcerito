import type { Conversation } from "./collect.js";
import type { LinkedIssue } from "./linear.js";
import { short, type RejectedExport } from "./rejected.js";
import type { CarriedCard } from "./sync.js";
import { SECTIONS, type RejectedPattern, type Section, type SkippedConversation, type TriageItem } from "./triage.js";

export interface AgendaItem extends Omit<TriageItem, "linear"> {
  issues: (LinkedIssue & { isNew?: boolean })[];
  linearNote?: string;
}

export interface AgendaPage {
  date: string;
  since: Date;
  until: Date;
  timeZone: string;
  overview: string;
  items: AgendaItem[];
  skipped: SkippedConversation[];
  conversations: Map<string, Conversation>;
  /** Null when today's export from `npm run rejected-fields` hasn't been uploaded. */
  rejected: RejectedExport | null;
  rejectedPatterns: RejectedPattern[];
  /** Items left open at an earlier sync, with their Linear issues refreshed. */
  carried: (CarriedCard & { issueDetails: LinkedIssue[] })[];
  /** Notes from the previous sync (e.g. the Granola summary). */
  lastNotes: { date: string; text: string } | null;
  warnings: string[];
}

const URGENCY_ORDER = { high: 0, medium: 1, low: 2 } as const;

/** Where an agenda item comes from, shown in its "Sources" accordion and embedded as JSON for other tools. */
export type Source =
  | {
      kind: "slack";
      channel: string;
      channelId: string;
      threadTs: string;
      url: string;
      messages: { author: string; from: string; at: string; text: string; url: string }[];
    }
  | {
      kind: "db";
      database: string;
      table: string;
      exportedAt: string;
      rows: {
        id: string;
        decidedAt: string;
        customer: string | null;
        form: string;
        field: string;
        how: string;
        aiValue: string;
        coderValue: string;
        reason: string | null;
      }[];
    }
  | { kind: "link"; label: string; url: string };

/** Everything about one agenda item; embedded as JSON so it can be carried over and read by other tools. */
export interface AgendaCard {
  id: string;
  title: string;
  section: string;
  urgency?: "high" | "medium" | "low";
  customers?: string[];
  summary?: string;
  proposal?: string;
  issues: string[];
  /** Sub-points to tick off one by one. */
  checklist?: { section: string; type: string; text: string }[];
  sources: Source[];
  /** Added by hand to the HTML, so it only exists in the browser. */
  manual?: boolean;
  carriedFrom?: string;
  lastNote?: string;
}

/**
 * One self-contained HTML file: a compact list of titles that expand on click. Decisions and notes are kept in
 * the browser's localStorage, keyed by the agenda date.
 */
export function renderAgenda(page: AgendaPage): string {
  const fmt = (d: Date) =>
    d.toLocaleString("en-US", { timeZone: page.timeZone, dateStyle: "medium", timeStyle: "short" });
  const created = page.items.flatMap((i) => i.issues.filter((x) => x.isNew)).length;
  const data: AgendaCard[] = [];
  const carried = renderCarried(page, data);

  const sections = (Object.keys(SECTIONS) as Section[])
    .map((section) => {
      const items = page.items
        .filter((i) => i.section === section)
        .sort((a, b) => URGENCY_ORDER[a.urgency] - URGENCY_ORDER[b.urgency]);
      if (!items.length) return "";
      return `<section><h2>${esc(SECTIONS[section])} <span class="count">${items.length}</span></h2>
${items.map((item) => renderItem(item, page.conversations, data)).join("\n")}</section>`;
    })
    .join("\n");

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Nico sync · ${esc(page.date)}</title>
<style>${CSS}</style></head>
<body data-agenda="${esc(page.date)}">
<header>
  <h1>Nico sync · ${esc(page.date)}</h1>
  <p class="meta">Messages from ${esc(fmt(page.since))} to ${esc(fmt(page.until))} · ${page.items.length} issues ·
    ${page.skipped.length} skipped · ${created} Linear issue${created === 1 ? "" : "s"} filed on Dotterino's behalf</p>
  <p class="overview">${esc(page.overview)}</p>
  ${page.warnings.map((w) => `<p class="warning">⚠️ ${esc(w)}</p>`).join("")}
</header>
<div class="toolbar"><div><span id="progress"></span>
  <button class="ghost" id="expand">Expand all</button><button class="ghost" id="collapse">Collapse all</button></div>
  <button id="copy">Copy decisions for parcerito</button></div>
<main>${renderLastNotes(page)}${carried}${renderRejected(page, data)}
${sections || "<section><h2>Customer chats</h2><p class=\"muted\">No issues from the service team in this window. 🎉</p></section>"}
${renderSkipped(page)}</main>
<script type="application/json" id="agenda-data">${json({
    agenda: page.date,
    window: { since: page.since.toISOString(), until: page.until.toISOString() },
    items: data,
  })}</script>
<script>${SCRIPT}</script>
</body></html>`;
}

/** A row that shows the title and expands to the details; the checkbox stays outside so ticking doesn't toggle. */
function card(opts: AgendaCard & { head: string; body: string }, data: AgendaCard[]): string {
  const { head, body, ...item } = opts;
  data.push(item);
  const checklist = item.checklist?.length ? renderChecklist(item.id, item.checklist) : "";
  return `<article class="item" data-id="${esc(item.id)}" data-title="${esc(item.title)}" data-issues="${esc(item.issues.join(","))}" data-refs="${esc(sourceRefs(item.sources))}">
  <input type="checkbox" class="done-box" title="Decided" aria-label="Decided">
  <details><summary>${head}</summary><div class="body">${body}
  ${checklist}
  ${renderSources(item.sources)}
  <textarea placeholder="Decision / next step"></textarea></div></details>
</article>`;
}

function renderChecklist(id: string, points: NonNullable<AgendaCard["checklist"]>): string {
  const groups: string[] = [];
  let current = "";
  points.forEach((p, n) => {
    if (p.section !== current) {
      groups.push(`${current ? "</ul>" : ""}<p class="label">${esc(p.section)}</p><ul class="checklist">`);
      current = p.section;
    }
    groups.push(
      `<li><label><input type="checkbox" class="sub" data-key="${esc(`${id}-${n}`)}"> <span class="pt ${esc(p.type.toLowerCase())}">${esc(p.type)}</span> ${esc(p.text)}</label></li>`,
    );
  });
  return `<p class="muted checklist-progress" data-for="${esc(id)}"></p>${groups.join("")}</ul>`;
}

function renderSources(sources: Source[]): string {
  const blocks = sources.map((s) => {
    if (s.kind === "slack") {
      const messages = s.messages
        .map(
          (m) => `<li><span class="muted">${esc(m.at)} · ${esc(m.author)} (${esc(m.from)}) · <a href="${esc(m.url)}">link</a></span>
<div class="quote">${esc(m.text)}</div></li>`,
        )
        .join("");
      return `<div class="source"><p><span class="kind">Slack</span> <a href="${esc(s.url)}">#${esc(s.channel)}</a>
<span class="muted">· channel ${esc(s.channelId)} · thread ${esc(s.threadTs)}</span></p><ul>${messages}</ul></div>`;
    }
    if (s.kind === "link") {
      return `<div class="source"><p><span class="kind db">Link</span> <a href="${esc(s.url)}">${esc(s.label)}</a></p></div>`;
    }
    const rows = s.rows
      .map(
        (r) => `<li><span class="muted">${esc(r.decidedAt)} · ${esc(r.customer ?? "unknown customer")} · ${esc(r.form)} · <code>${esc(r.field)}</code> · ${esc(r.how)} · id <code>${esc(r.id)}</code></span>
<div class="quote">AI <code>${esc(r.aiValue)}</code> → coder <code>${esc(r.coderValue)}</code>${r.reason ? ` · “${esc(r.reason)}”` : ""}</div></li>`,
      )
      .join("");
    return `<div class="source"><p><span class="kind db">DB</span> ${esc(s.database)} · <code>${esc(s.table)}</code>
<span class="muted">· exported ${esc(s.exportedAt)}</span></p><ul>${rows}</ul></div>`;
  });
  const count = sources.reduce(
    (n, s) => n + (s.kind === "slack" ? s.messages.length : s.kind === "db" ? s.rows.length : 1),
    0,
  );
  return `<details class="sources"><summary>Sources (${count})</summary>${blocks.join("")}</details>`;
}

/** One-line references for the copied decisions, so another tool can find the originals. */
function sourceRefs(sources: Source[]): string {
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

function slackSource(c: Conversation): Source {
  return {
    kind: "slack",
    channel: c.channelName,
    channelId: c.channelId,
    threadTs: c.rootTs,
    url: c.url,
    // The new service-team messages, plus the rest of the thread for context when it's short.
    messages: (c.messages.length <= 8 ? c.messages : c.messages.filter((m) => m.external && m.inWindow)).map((m) => ({
      author: m.author,
      from: m.external ? "service team" : m.author === "bot" ? "bot" : "internal",
      at: new Date(Number(m.ts) * 1000).toISOString(),
      text: m.text,
      url: m.url,
    })),
  };
}

function json(value: unknown): string {
  // Safe inside a <script> element.
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

function renderItem(item: AgendaItem, conversations: Map<string, Conversation>, data: AgendaCard[]): string {
  const sources = item.conversationIds
    .map((id) => conversations.get(id))
    .filter((c): c is Conversation => Boolean(c))
    .map(slackSource);
  const issues = issueLinks(item.issues);
  const tags = [
    ...item.customers.map((c) => `<span class="tag">${esc(c)}</span>`),
    ...item.issues.map((i) => `<span class="tag issue-tag">${esc(i.identifier)}${i.isNew ? " · new" : ""}</span>`),
  ].join("");

  return card(
    {
      id: item.id,
      title: item.title,
      section: SECTIONS[item.section],
      urgency: item.urgency,
      customers: item.customers,
      summary: item.summary,
      proposal: item.proposal,
      issues: item.issues.map((i) => i.identifier),
      sources,
      head: `<span class="urgency ${item.urgency}">${item.urgency}</span><span class="title">${esc(item.title)}</span><span class="tags">${tags}</span>`,
    body: `<p>${esc(item.summary)}</p>
  <p class="proposal"><b>Proposal:</b> ${esc(item.proposal)}</p>
  <p>${issues || `<span class="muted">${esc(item.linearNote ?? "No Linear issue")}</span>`}</p>
  ${item.linearNote && item.issues.length ? `<p class="muted">${esc(item.linearNote)}</p>` : ""}`,
    },
    data,
  );
}

function issueLinks(issues: (LinkedIssue & { isNew?: boolean })[]): string {
  return issues
    .map(
      (i) =>
        `<a class="issue" href="${esc(i.url)}">${esc(i.identifier)}${i.isNew ? " <b>new</b>" : ""}</a> ${esc(i.title)}${
          i.state ? ` <span class="muted">· ${esc(i.state)}</span>` : ""
        }`,
    )
    .join("<br>");
}

function renderCarried(page: AgendaPage, data: AgendaCard[]): string {
  if (!page.carried.length) return "";
  const cards = page.carried
    .map(({ issueDetails, ...item }) => {
      const tags = [
        `<span class="tag carried-tag">from ${esc(item.carriedFrom)}</span>`,
        ...(item.customers ?? []).map((c) => `<span class="tag">${esc(c)}</span>`),
        ...issueDetails.map((i) => `<span class="tag issue-tag">${esc(i.identifier)}</span>`),
      ].join("");
      return card(
        {
          ...item,
          issues: issueDetails.length ? issueDetails.map((i) => i.identifier) : item.issues,
          head: `${item.urgency ? `<span class="urgency ${item.urgency}">${item.urgency}</span>` : ""}<span class="title">${esc(item.title)}</span><span class="tags">${tags}</span>`,
          body: `${item.lastNote ? `<p class="last-note"><b>Last time:</b> ${esc(item.lastNote)}</p>` : ""}
  ${item.summary ? `<p>${esc(item.summary)}</p>` : ""}
  ${item.proposal ? `<p class="proposal"><b>Proposal:</b> ${esc(item.proposal)}</p>` : ""}
  ${issueDetails.length ? `<p>${issueLinks(issueDetails)}</p>` : ""}`,
        },
        data,
      );
    })
    .join("\n");
  return `<section><h2>Carried over <span class="count">${page.carried.length}</span></h2>
<p class="meta">Not decided at an earlier sync. Items whose Linear issues were closed since then are left out.</p>
${cards}</section>`;
}

function renderLastNotes(page: AgendaPage): string {
  if (!page.lastNotes) return "";
  return `<section><details class="notes"><summary><h2>Notes from the last sync (${esc(page.lastNotes.date)})</h2></summary>
<div class="quote notes-text">${esc(page.lastNotes.text)}</div></details></section>`;
}

function sourceLine(c: Conversation): string {
  const first = c.messages.find((m) => m.external && m.inWindow) ?? c.messages[0];
  return `<a href="${esc(c.url)}">#${esc(c.channelName)}</a> · ${esc(first?.author ?? "")}: ${esc(
    (first?.text ?? "").slice(0, 200),
  )}`;
}

function renderSkipped(page: AgendaPage): string {
  if (!page.skipped.length) return "";
  const rows = page.skipped
    .map((s) => {
      const c = page.conversations.get(s.conversationId);
      return c ? `<li>${sourceLine(c)}<br><span class="muted">→ ${esc(s.reason)}</span></li>` : "";
    })
    .join("");
  return `<section><details class="skipped"><summary><h2>Skipped, not issues <span class="count">${page.skipped.length}</span></h2></summary>
<p class="muted">Messages the triage decided need no work. Check nothing important slipped through.</p><ul>${rows}</ul></details></section>`;
}

function renderRejected(page: AgendaPage, data: AgendaCard[]): string {
  const { rejected } = page;
  if (!rejected) {
    return `<section><h2>Rejected AI suggestions</h2><p class="warning">No export from production yet. Run
<code>rejected-fields</code> in your terminal, then DM me <code>agenda</code> to rebuild this.</p></section>`;
  }
  const exported = rejected.exportedAt.toLocaleString("en-US", {
    timeZone: page.timeZone,
    dateStyle: "medium",
    timeStyle: "short",
  });
  const dbSource = (fieldKeys: string[]): Source => ({
    kind: "db",
    database: "Lime production (prod_db)",
    table: "ai_recommendation",
    exportedAt: rejected.exportedAt.toISOString(),
    rows: rejected.groups
      .filter((g) => fieldKeys.includes(g.fieldKey))
      .flatMap((g) => g.rows)
      .map((r) => ({
        id: r.id,
        decidedAt: r.decided_at,
        customer: r.organization,
        form: r.form,
        field: r.field_key,
        how: r.rejected_via === "review" ? "rejected" : "overwritten",
        aiValue: short(r.ai_value, 300),
        coderValue: short(r.coder_value, 300),
        reason: r.reason,
      })),
  });
  const patterns = page.rejectedPatterns
    .map((p, i) =>
      card(
        {
          id: `rejected-${i}`,
          title: p.title,
          section: "Rejected AI suggestions",
          summary: p.finding,
          proposal: p.proposal,
          issues: p.relatedIssue ? [p.relatedIssue] : [],
          sources: [dbSource(p.fieldKeys)],
          head: `<span class="title">${esc(p.title)}</span><span class="tags">${p.fieldKeys
          .slice(0, 4)
          .map((k) => `<span class="tag">${esc(k)}</span>`)
          .join("")}${p.fieldKeys.length > 4 ? `<span class="tag">+${p.fieldKeys.length - 4}</span>` : ""}</span>`,
          body: `<p>${esc(p.finding)}</p>
  <p class="proposal"><b>Proposal:</b> ${esc(p.proposal)}</p>
  ${p.relatedIssue ? `<p class="muted">Related: ${esc(p.relatedIssue)}</p>` : ""}`,
        },
        data,
      ),
    )
    .join("\n");
  const rows = rejected.groups
    .map((g) =>
      g.rows
        .map(
          (r, i) => `<tr>${
            i === 0
              ? `<td rowspan="${g.rows.length}"><b>${esc(g.fieldKey)}</b> <span class="count">${g.rows.length}×</span><br><span class="muted">${esc(g.form)} · ${esc(g.fieldLabel)}</span></td>`
              : ""
          }<td>${esc(r.organization ?? "")}</td><td>${r.rejected_via === "review" ? "rejected" : "overwritten"}</td>
<td><code>${esc(short(r.ai_value))}</code> → <code>${esc(short(r.coder_value))}</code></td><td>${esc(r.reason ?? "")}</td></tr>`,
        )
        .join(""),
    )
    .join("");
  return `<section><h2>Rejected AI suggestions <span class="count">${rejected.total}</span></h2>
<p class="meta">From the production export of ${esc(exported)}: fields a coder rejected or overwrote in this window.</p>
${patterns}
${
  rows
    ? `<details class="table"><summary>All ${rejected.total} by field</summary><table><thead><tr><th>Field</th><th>Customer</th><th>How</th><th>AI → coder</th><th>Reason</th></tr></thead><tbody>${rows}</tbody></table></details>`
    : `<p class="muted">No rejections in this window. 🎉</p>`
}</section>`;
}

function esc(value: string): string {
  return value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

const CSS = `
:root{color-scheme:light dark;--bg:#fafaf7;--card:#fff;--ink:#1d1d1b;--muted:#6b6b66;--line:#e4e2dc;--accent:#1d3b8f;--tag:#f0efe9}
@media (prefers-color-scheme:dark){:root{--bg:#141414;--card:#1e1e1e;--ink:#ecebe6;--muted:#9a9a94;--line:#2e2e2c;--accent:#8fa8ff;--tag:#2a2a28}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 -apple-system,system-ui,sans-serif}
header,main{max-width:900px;margin:0 auto;padding:24px 24px 0}main{padding-bottom:48px}
h1{margin:0 0 4px;font-size:24px}h2{font-size:17px;margin:28px 0 10px;display:inline-block}
.meta,.muted{color:var(--muted);font-size:13px}.overview{font-size:16px;margin:12px 0}.count{color:var(--muted);font-weight:400}
.warning{background:#fff4d6;color:#5c4400;padding:8px 12px;border-radius:6px;font-size:14px}
.toolbar{position:sticky;top:0;z-index:1;background:var(--bg);border-bottom:1px solid var(--line);display:flex;justify-content:space-between;align-items:center;gap:8px;max-width:900px;margin:0 auto;padding:10px 24px}
.toolbar>div{display:flex;align-items:center;gap:8px}#progress{font-size:13px;color:var(--muted);margin-right:6px}
button{background:var(--accent);color:#fff;border:0;border-radius:6px;padding:7px 12px;font:inherit;font-size:13px;cursor:pointer}
button.ghost{background:transparent;color:var(--muted);border:1px solid var(--line)}
.item{display:flex;align-items:flex-start;gap:10px;background:var(--card);border:1px solid var(--line);border-radius:8px;padding:10px 14px;margin:6px 0}
.done-box{margin-top:4px;width:16px;height:16px;flex:none;cursor:pointer;accent-color:var(--accent)}
.item details{flex:1;min-width:0}.item summary{cursor:pointer;list-style:none;display:flex;align-items:baseline;gap:8px}
.item summary::-webkit-details-marker{display:none}
.item summary::before{content:"▸";color:var(--muted);font-size:12px}.item details[open] summary::before{content:"▾"}
.item .title{font-weight:600;flex:1;min-width:0}.urgency{flex:none}.item.done{opacity:.5}.item.done .title{text-decoration:line-through}
.tags{display:flex;flex-wrap:wrap;justify-content:flex-end;gap:4px;max-width:40%}
.tag{font-size:11px;background:var(--tag);color:var(--muted);border-radius:4px;padding:1px 6px;white-space:nowrap}.issue-tag{color:var(--accent)}
.body{padding:8px 0 2px 18px}.body p{margin:6px 0}.body ul{margin:4px 0;padding-left:18px;font-size:13px}
.label{font-size:12px;color:var(--muted);text-transform:uppercase;letter-spacing:.04em}
.urgency{font-size:10px;text-transform:uppercase;padding:2px 6px;border-radius:4px;letter-spacing:.04em}
.high{background:#fde2e1;color:#8a1c17}.medium{background:#fdf0d5;color:#7a4d00}.low{background:#e6efe3;color:#2f5a25}
.proposal{border-left:3px solid var(--accent);padding-left:10px}
.issue{font-weight:600;color:var(--accent)}.issue b{font-size:10px;background:var(--accent);color:#fff;padding:1px 5px;border-radius:4px}
a{color:var(--accent)}
details.sources{margin:10px 0 4px;font-size:13px}details.sources>summary{cursor:pointer;color:var(--muted)}
.source{border-left:2px solid var(--line);padding:2px 0 2px 10px;margin:8px 0}.source p{margin:2px 0}.source ul{list-style:none;padding:0}
.source li{margin:6px 0}.quote{white-space:pre-wrap;color:var(--ink);margin-top:2px}
.kind{font-size:10px;text-transform:uppercase;letter-spacing:.04em;background:#e8e3f8;color:#4a2f9a;border-radius:4px;padding:1px 6px}
.kind.db{background:#dff1f0;color:#0d5c58}
.checklist{list-style:none;padding-left:0!important}.checklist li{margin:3px 0}.checklist label{cursor:pointer}
.checklist label:has(input:checked){color:var(--muted);text-decoration:line-through}
.pt{font-size:10px;text-transform:uppercase;letter-spacing:.04em;border-radius:4px;padding:1px 5px;margin-right:2px;background:var(--tag);color:var(--muted)}
.pt.prompt{background:#e8e3f8;color:#4a2f9a}.pt.warning{background:#fdf0d5;color:#7a4d00}.pt.layout{background:#dff1f0;color:#0d5c58}
.pt.ok{background:#e6efe3;color:#2f5a25}.pt.open{background:#fde2e1;color:#8a1c17}
.carried-tag{color:#7a4d00;background:#fdf0d5}.last-note{background:var(--tag);border-radius:6px;padding:6px 10px}
details.notes>summary{cursor:pointer}.notes-text{font-size:14px;background:var(--card);border:1px solid var(--line);border-radius:8px;padding:12px 14px}
textarea{width:100%;min-height:48px;margin-top:8px;border:1px solid var(--line);border-radius:6px;padding:8px;background:transparent;color:inherit;font:inherit;font-size:14px}
details.table,details.skipped{margin:10px 0}details.table>summary,details.skipped>summary{cursor:pointer;color:var(--muted);font-size:13px}
details.skipped>summary h2{color:var(--ink)}details.skipped li{margin:6px 0}
table{width:100%;border-collapse:collapse;margin-top:8px;color:var(--ink);table-layout:fixed;font-size:13px}
th,td{text-align:left;vertical-align:top;border-bottom:1px solid var(--line);padding:6px 8px;overflow-wrap:anywhere}th:first-child{width:34%}code{font-size:12px}
`;

const SCRIPT = `
const agenda = document.body.dataset.agenda;
const key = "agenda:" + agenda;
const state = JSON.parse(localStorage.getItem(key) || "{}");
const cards = new Map(JSON.parse(document.getElementById("agenda-data").textContent).items.map((c) => [c.id, c]));
const items = [...document.querySelectorAll(".item")];
const progress = () => {
  document.getElementById("progress").textContent =
    items.filter((i) => state[i.dataset.id]?.decided).length + " / " + items.length + " decided";
};
for (const item of items) {
  const id = item.dataset.id, box = item.querySelector(".done-box"), note = item.querySelector("textarea");
  const saved = state[id] || {};
  box.checked = !!saved.decided; note.value = saved.note || ""; item.classList.toggle("done", box.checked);
  const save = () => {
    state[id] = { decided: box.checked, note: note.value };
    localStorage.setItem(key, JSON.stringify(state));
    item.classList.toggle("done", box.checked); progress();
  };
  box.addEventListener("change", save); note.addEventListener("input", save);
}
progress();

// Checklist points inside an item.
const subKey = key + ":checklist";
const subState = JSON.parse(localStorage.getItem(subKey) || "{}");
const subProgress = () => document.querySelectorAll(".checklist-progress").forEach((el) => {
  const boxes = [...document.querySelectorAll('.item[data-id="' + el.dataset.for + '"] input.sub')];
  el.textContent = boxes.filter((b) => b.checked).length + " / " + boxes.length + " points discussed";
});
for (const b of document.querySelectorAll("input.sub")) {
  b.checked = !!subState[b.dataset.key];
  b.addEventListener("change", () => { subState[b.dataset.key] = b.checked; localStorage.setItem(subKey, JSON.stringify(subState)); subProgress(); });
}
subProgress();

const toggleAll = (open) => document.querySelectorAll(".item details").forEach((d) => (d.open = open));
document.getElementById("expand").addEventListener("click", () => toggleAll(true));
document.getElementById("collapse").addEventListener("click", () => toggleAll(false));

const base64 = (text) => {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
};
// Keeps the pasted message small: sources keep their links, long message texts are cut.
const slim = (card) => ({ ...card, sources: (card.sources || []).map((s) => s.kind === "slack"
  ? { ...s, messages: s.messages.map((m) => ({ ...m, text: m.text.slice(0, 300) })) }
  : s.kind === "db" ? { ...s, rows: s.rows.slice(0, 20) } : s) });
document.getElementById("copy").addEventListener("click", async () => {
  const entry = (i) => ({ id: i.dataset.id, note: state[i.dataset.id]?.note || "" });
  const decided = items.filter((i) => state[i.dataset.id]?.decided);
  const open = items.filter((i) => !state[i.dataset.id]?.decided);
  const line = (i) => "- " + i.dataset.title + " [" + (i.dataset.issues || "no issue") + "]: " +
    (state[i.dataset.id]?.note || "(no notes)") + (i.dataset.refs ? "\\n  sources: " + i.dataset.refs : "");
  const payload = { v: 1, agenda, decided: decided.map(entry), open: open.map(entry),
    cards: open.map((i) => cards.get(i.dataset.id)).filter(Boolean).map(slim) };
  const text = "Decisions from the Nico sync " + agenda + "\\n\\nDecided (" + decided.length + "):\\n" +
    decided.map(line).join("\\n") + "\\n\\nNot decided, carry over to the next sync (" + open.length + "):\\n" +
    open.map((i) => "- " + i.dataset.title + (state[i.dataset.id]?.note ? ": " + state[i.dataset.id].note : "")).join("\\n") +
    "\\n\\n\\u0060\\u0060\\u0060parcerito-sync\\n" + base64(JSON.stringify(payload)) + "\\n\\u0060\\u0060\\u0060";
  await navigator.clipboard.writeText(text);
  const button = document.getElementById("copy"); button.textContent = "Copied ✓";
  setTimeout(() => (button.textContent = "Copy decisions for parcerito"), 1500);
});
`;
