import type { Conversation } from "./collect.js";
import type { LinkedIssue } from "./linear.js";
import { SECTIONS, type Section, type TriageItem } from "./triage.js";

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
  conversations: Map<string, Conversation>;
  warnings: string[];
}

const URGENCY_ORDER = { high: 0, medium: 1, low: 2 } as const;

/** One self-contained HTML file. Decisions and notes are kept in the browser's localStorage. */
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
  <p class="meta">Messages from ${esc(fmt(page.since))} to ${esc(fmt(page.until))} · ${page.items.length} items ·
    ${created} Linear issue${created === 1 ? "" : "s"} filed on Dotterino's behalf</p>
  <p class="overview">${esc(page.overview)}</p>
  ${page.warnings.map((w) => `<p class="warning">⚠️ ${esc(w)}</p>`).join("")}
  <div class="toolbar"><span id="progress"></span>
    <button id="copy">Copy decisions for parcerito</button></div>
</header>
<main>${sections || "<p>Nothing new from the service team. 🎉</p>"}</main>
<script>${SCRIPT}</script>
</body></html>`;
}

function renderItem(item: AgendaItem, conversations: Map<string, Conversation>): string {
  const sources = item.conversationIds
    .map((id) => conversations.get(id))
    .filter((c): c is Conversation => Boolean(c))
    .map((c) => {
      const first = c.messages.find((m) => m.external && m.inWindow) ?? c.messages[0];
      return `<li><a href="${esc(c.url)}">#${esc(c.channelName)}</a> · ${esc(first?.author ?? "")}: ${esc(
        (first?.text ?? "").slice(0, 160),
      )}</li>`;
    })
    .join("");
  const issues = item.issues
    .map(
      (i) =>
        `<a class="issue" href="${esc(i.url)}">${esc(i.identifier)}${i.isNew ? " <b>new</b>" : ""}</a> ${esc(i.title)}${
          i.state ? ` <span class="state">${esc(i.state)}</span>` : ""
        }`,
    )
    .join("<br>");

  return `<article class="item" data-id="${esc(item.id)}" data-issues="${esc(item.issues.map((i) => i.identifier).join(","))}">
  <label class="decided"><input type="checkbox"> Decided</label>
  <h3><span class="urgency ${item.urgency}">${item.urgency}</span> ${esc(item.title)}</h3>
  <p class="customers">${item.customers.map(esc).join(" · ")}</p>
  <p>${esc(item.summary)}</p>
  <p class="proposal"><b>Proposal:</b> ${esc(item.proposal)}</p>
  <p class="linear">${issues || `<span class="muted">${esc(item.linearNote ?? "No Linear issue")}</span>`}</p>
  <details><summary>Messages (${item.conversationIds.length})</summary><ul>${sources}</ul></details>
  <textarea placeholder="Decision / next step"></textarea>
</article>`;
}

function esc(value: string): string {
  return value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

const CSS = `
:root{color-scheme:light dark;--bg:#fafaf7;--card:#fff;--ink:#1d1d1b;--muted:#6b6b66;--line:#e4e2dc;--accent:#1d3b8f}
@media (prefers-color-scheme:dark){:root{--bg:#141414;--card:#1e1e1e;--ink:#ecebe6;--muted:#9a9a94;--line:#2e2e2c;--accent:#8fa8ff}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 -apple-system,system-ui,sans-serif}
header,main{max-width:860px;margin:0 auto;padding:24px}header{padding-bottom:0}
h1{margin:0 0 4px;font-size:24px}h2{font-size:18px;margin:32px 0 12px;border-bottom:1px solid var(--line);padding-bottom:6px}
.meta,.customers,.muted,.state{color:var(--muted);font-size:13px}.overview{font-size:16px}
.warning{background:#fff4d6;color:#5c4400;padding:8px 12px;border-radius:6px}
.toolbar{display:flex;justify-content:space-between;align-items:center;position:sticky;top:0;background:var(--bg);padding:10px 0;border-bottom:1px solid var(--line)}
button{background:var(--accent);color:#fff;border:0;border-radius:6px;padding:8px 14px;font:inherit;cursor:pointer}
.count{color:var(--muted);font-weight:400}
.item{position:relative;background:var(--card);border:1px solid var(--line);border-radius:10px;padding:16px 18px;margin:12px 0}
.item.done{opacity:.55}.item.done h3{text-decoration:line-through}
.item h3{margin:0 110px 4px 0;font-size:16px}.item p{margin:6px 0}
.decided{position:absolute;top:14px;right:16px;font-size:13px;cursor:pointer}
.urgency{font-size:11px;text-transform:uppercase;padding:2px 6px;border-radius:4px;margin-right:4px;vertical-align:2px}
.high{background:#fde2e1;color:#8a1c17}.medium{background:#fdf0d5;color:#7a4d00}.low{background:#e6efe3;color:#2f5a25}
.proposal{border-left:3px solid var(--accent);padding-left:10px}
.issue{font-weight:600;color:var(--accent)}.issue b{font-size:11px;background:var(--accent);color:#fff;padding:1px 5px;border-radius:4px}
details{font-size:13px;color:var(--muted)}a{color:var(--accent)}
textarea{width:100%;min-height:52px;margin-top:8px;border:1px solid var(--line);border-radius:6px;padding:8px;background:transparent;color:inherit;font:inherit}
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
  const id = item.dataset.id, box = item.querySelector("input"), note = item.querySelector("textarea");
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
document.getElementById("copy").addEventListener("click", async () => {
  const lines = items
    .filter((i) => state[i.dataset.id]?.decided || state[i.dataset.id]?.note)
    .map((i) => "- " + i.querySelector("h3").innerText.replace(/^\\S+\\s/, "") +
      " [" + (i.dataset.issues || "no issue") + "]" + (state[i.dataset.id].decided ? " ✅" : "") +
      ": " + (state[i.dataset.id].note || "(no notes)"));
  await navigator.clipboard.writeText("Decisions from the Nico sync " + document.body.dataset.agenda + ":\\n" + lines.join("\\n"));
  const button = document.getElementById("copy"); button.textContent = "Copied ✓";
  setTimeout(() => (button.textContent = "Copy decisions for parcerito"), 1500);
});
`;
