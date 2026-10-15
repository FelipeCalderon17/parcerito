import type { Conversation } from "./collect.js";
import type { LinkedIssue } from "./linear.js";
import { short, type RejectedExport } from "./rejected.js";
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
  warnings: string[];
}

const URGENCY_ORDER = { high: 0, medium: 1, low: 2 } as const;

/**
 * One self-contained HTML file: a compact list of titles that expand on click. Decisions and notes are kept in
 * the browser's localStorage, keyed by the agenda date.
 */
export function renderAgenda(page: AgendaPage): string {
  const fmt = (d: Date) =>
    d.toLocaleString("en-US", { timeZone: page.timeZone, dateStyle: "medium", timeStyle: "short" });
  const created = page.items.flatMap((i) => i.issues.filter((x) => x.isNew)).length;

  const sections = (Object.keys(SECTIONS) as Section[])
    .map((section) => {
      const items = page.items
        .filter((i) => i.section === section)
        .sort((a, b) => URGENCY_ORDER[a.urgency] - URGENCY_ORDER[b.urgency]);
      if (!items.length) return "";
      return `<section><h2>${esc(SECTIONS[section])} <span class="count">${items.length}</span></h2>
${items.map((item) => renderItem(item, page.conversations)).join("\n")}</section>`;
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
<main>${renderRejected(page)}
${sections || "<section><h2>Customer chats</h2><p class=\"muted\">No issues from the service team in this window. 🎉</p></section>"}
${renderSkipped(page)}</main>
<script>${SCRIPT}</script>
</body></html>`;
}

/** A row that shows the title and expands to the details; the checkbox stays outside so ticking doesn't toggle. */
function card(opts: { id: string; title: string; issues: string; head: string; body: string }): string {
  return `<article class="item" data-id="${esc(opts.id)}" data-title="${esc(opts.title)}" data-issues="${esc(opts.issues)}">
  <input type="checkbox" class="done-box" title="Decided" aria-label="Decided">
  <details><summary>${opts.head}</summary><div class="body">${opts.body}
  <textarea placeholder="Decision / next step"></textarea></div></details>
</article>`;
}

function renderItem(item: AgendaItem, conversations: Map<string, Conversation>): string {
  const sources = item.conversationIds
    .map((id) => conversations.get(id))
    .filter((c): c is Conversation => Boolean(c))
    .map((c) => `<li>${sourceLine(c)}</li>`)
    .join("");
  const issues = item.issues
    .map(
      (i) =>
        `<a class="issue" href="${esc(i.url)}">${esc(i.identifier)}${i.isNew ? " <b>new</b>" : ""}</a> ${esc(i.title)}${
          i.state ? ` <span class="muted">· ${esc(i.state)}</span>` : ""
        }`,
    )
    .join("<br>");
  const tags = [
    ...item.customers.map((c) => `<span class="tag">${esc(c)}</span>`),
    ...item.issues.map((i) => `<span class="tag issue-tag">${esc(i.identifier)}${i.isNew ? " · new" : ""}</span>`),
  ].join("");

  return card({
    id: item.id,
    title: item.title,
    issues: item.issues.map((i) => i.identifier).join(","),
    head: `<span class="urgency ${item.urgency}">${item.urgency}</span><span class="title">${esc(item.title)}</span><span class="tags">${tags}</span>`,
    body: `<p>${esc(item.summary)}</p>
  <p class="proposal"><b>Proposal:</b> ${esc(item.proposal)}</p>
  <p>${issues || `<span class="muted">${esc(item.linearNote ?? "No Linear issue")}</span>`}</p>
  ${item.linearNote && item.issues.length ? `<p class="muted">${esc(item.linearNote)}</p>` : ""}
  <p class="label">Messages</p><ul>${sources}</ul>`,
  });
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

function renderRejected(page: AgendaPage): string {
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
  const patterns = page.rejectedPatterns
    .map((p, i) =>
      card({
        id: `rejected-${i}`,
        title: p.title,
        issues: p.relatedIssue ?? "",
        head: `<span class="title">${esc(p.title)}</span><span class="tags">${p.fieldKeys
          .slice(0, 4)
          .map((k) => `<span class="tag">${esc(k)}</span>`)
          .join("")}${p.fieldKeys.length > 4 ? `<span class="tag">+${p.fieldKeys.length - 4}</span>` : ""}</span>`,
        body: `<p>${esc(p.finding)}</p>
  <p class="proposal"><b>Proposal:</b> ${esc(p.proposal)}</p>
  ${p.relatedIssue ? `<p class="muted">Related: ${esc(p.relatedIssue)}</p>` : ""}`,
      }),
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
textarea{width:100%;min-height:48px;margin-top:8px;border:1px solid var(--line);border-radius:6px;padding:8px;background:transparent;color:inherit;font:inherit;font-size:14px}
details.table,details.skipped{margin:10px 0}details.table>summary,details.skipped>summary{cursor:pointer;color:var(--muted);font-size:13px}
details.skipped>summary h2{color:var(--ink)}details.skipped li{margin:6px 0}
table{width:100%;border-collapse:collapse;margin-top:8px;color:var(--ink);table-layout:fixed;font-size:13px}
th,td{text-align:left;vertical-align:top;border-bottom:1px solid var(--line);padding:6px 8px;overflow-wrap:anywhere}th:first-child{width:34%}code{font-size:12px}
`;

const SCRIPT = `
const key = "agenda:" + document.body.dataset.agenda;
const state = JSON.parse(localStorage.getItem(key) || "{}");
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
const toggleAll = (open) => document.querySelectorAll(".item details").forEach((d) => (d.open = open));
document.getElementById("expand").addEventListener("click", () => toggleAll(true));
document.getElementById("collapse").addEventListener("click", () => toggleAll(false));
document.getElementById("copy").addEventListener("click", async () => {
  const lines = items
    .filter((i) => state[i.dataset.id]?.decided || state[i.dataset.id]?.note)
    .map((i) => "- " + i.dataset.title + " [" + (i.dataset.issues || "no issue") + "]" +
      (state[i.dataset.id].decided ? " ✅" : "") + ": " + (state[i.dataset.id].note || "(no notes)"));
  await navigator.clipboard.writeText("Decisions from the Nico sync " + document.body.dataset.agenda + ":\\n" + lines.join("\\n"));
  const button = document.getElementById("copy"); button.textContent = "Copied ✓";
  setTimeout(() => (button.textContent = "Copy decisions for parcerito"), 1500);
});
`;
