/**
 * Renders review packs as one dark, self-contained HTML page: sidebar, overview, and per issue the Slack reports,
 * the visits with the AI's suggestions/abstentions and the Linear notes, plus a panel for questions and the decision
 * (kept in the browser's localStorage, exportable as Markdown).
 */
import { topicOf } from "./queries.js";
import type { DbRow, Group, LinearIssue, Pack, SlackThread, VisitData } from "./types.js";

/** Sidebar/overview heading of each meeting group. */
export const GROUPS: Record<Group, string> = {
  1: "ADLs · M1800s",
  2: "Mobility · GG0170",
  3: "Other OASIS items",
  4: "Agency form fields",
  5: "Narratives & templates",
  6: "Other · bugs, EHR, requests",
};

/** HTML-escapes any value (null/undefined → empty). */
export const esc = (v: unknown) =>
  String(v ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const val = (v: unknown) =>
  v === null || v === undefined || v === "" ? `<span class="muted">—</span>` : esc(typeof v === "string" ? v : JSON.stringify(v));
const when = (v: unknown) => (v ? esc(String(v).replace("T", " ").slice(0, 16)) : "");
const day = (v: unknown) => (v ? esc(String(v).slice(0, 10)) : "");
const slackDate = (ts: string) => new Date(Number(ts) * 1000).toISOString().replace("T", " ").slice(0, 16);
const rows = (v: unknown) => (Array.isArray(v) ? v : []) as Record<string, any>[];
const err = (v: unknown) =>
  v && !Array.isArray(v) && (v as { error?: string }).error ? `<div class="callout bad">Query failed: ${esc((v as { error: string }).error)}</div>` : "";
const initials = (name: string) =>
  name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join("") || "?";
const person = (v: unknown) => esc(String(v ?? "").replace(/\s*<[^>]*>$/, ""));

/** Slack mrkdwn → minimal HTML: links, mentions, bold and line breaks. */
function slackText(text: string): string {
  return esc(text)
    .replace(/&lt;(https?:[^|&]+?)\|([^&]+?)&gt;/g, '<a href="$1" target="_blank">$2</a>')
    .replace(/&lt;(https?:[^&]+?)&gt;/g, '<a href="$1" target="_blank">link</a>')
    .replace(/&lt;@(U[A-Z0-9]+)&gt;/g, '<span class="mention">@$1</span>')
    .replace(/(^|\s)\*([^*\n]+)\*/g, "$1<b>$2</b>")
    .replace(/\n/g, "<br>");
}

/** The field's own instruction: the `[id]` section of the prompt's INSTRUCTIONS block its field line points at. */
export function fieldInstruction(line: string | null, block: string | null): string | null {
  const id = line?.match(/"instruction"\s*:\s*"([^"]+)"/)?.[1];
  if (!id || !block) return null;
  const start = block.indexOf(`[${id}]`);
  if (start < 0) return null;
  const rest = block.slice(start + id.length + 2);
  const next = rest.search(/\n\[[^\]\n]+\]/);
  return (next < 0 ? rest : rest.slice(0, next)).trim() || null;
}

function prompt(line: string | null, block: string | null, stepKey?: string): string {
  const instruction = fieldInstruction(line, block);
  return `<details class="prompt"><summary><span class="ico">✦</span> Prompt instruction${stepKey ? ` <span class="muted">· ${esc(stepKey)}</span>` : ""}</summary>
    ${instruction ? `<div class="instr">${esc(instruction)}</div>` : `<div class="muted">Instruction not found in the prompt.</div>`}
    ${line ? `<div class="sub">Field line sent to the model</div><pre>${esc(line)}</pre>` : ""}
    ${block ? `<details class="inner"><summary>Full INSTRUCTIONS block</summary><pre>${esc(block)}</pre></details>` : ""}
  </details>`;
}

function evidence(list: Record<string, any>[]): string {
  if (!list.length) return `<div class="muted">No citations.</div>`;
  return list
    .map((e) => {
      const src =
        e.type === "audio"
          ? `<span class="src audio">🎙 Audio ${esc(e.at ?? "")}</span>${e.speaker ? `<span class="src">${esc(e.speaker)}</span>` : ""}`
          : e.type === "document"
            ? `<span class="src doc">📄 ${esc(e.document ?? "Document")}</span>${e.page ? `<span class="src">p.${esc(e.page)}</span>` : ""}`
            : e.type === "photo"
              ? `<span class="src photo">📷 Photo</span><span class="src mono">${esc(String(e.photo ?? "").slice(0, 8))}</span>`
              : `<span class="src">${esc(e.type)}</span>`;
      const quote = e.snippet || e.text;
      const full = e.text && e.snippet && e.text !== e.snippet ? `<details class="inner"><summary>Full passage</summary><p>${esc(e.text)}</p></details>` : "";
      return `<blockquote class="ev"><div class="srcs">${src}</div><p>${esc(quote)}</p>${full}</blockquote>`;
    })
    .join("");
}

function decisionPill(d: string | null | undefined, via?: string | null): string {
  const kind = d === "rejected" ? "bad" : d === "accepted" ? "good" : "warn";
  return `<span class="pill ${kind}">${esc(d ?? "pending")}${via ? ` · ${esc(via)}` : ""}</span>`;
}

/** One AI suggestion: suggested vs final value, who decided, rejection, cited evidence, history and prompt. */
export function fieldCard(f: Record<string, any>, clinician: string): string {
  const answers = rows(f.answers);
  const final = answers.at(-1);
  const changed = final && JSON.stringify(final.value) !== JSON.stringify(f.ai_value);
  return `<article class="field ${esc(f.decision ?? "pending")}">
    <header><code>${esc(f.key)}</code><span class="flabel">${esc(f.label)}</span>${decisionPill(f.decision, f.accepted_via ?? f.rejected_via)}</header>
    <div class="compare">
      <div><div class="k">AI suggested</div><div class="v big">${val(f.ai_value)}</div><div class="muted small">${esc(f.basis)} · ${esc(f.model ?? "")} · ${when(f.created_at)}</div></div>
      <div class="arrow">→</div>
      <div><div class="k">Final answer</div><div class="v big ${changed ? "changed" : ""}">${final ? val(final.value) : `<span class="muted">blank</span>`}</div><div class="muted small">${final ? `${esc(final.source)}${final.by ? ` · ${person(final.by)}` : ""}` : ""}${final?.pushed_at ? ` · pushed ${when(final.pushed_at)}` : ""}</div></div>
      <div><div class="k">Decided by</div><div class="v">${f.decided_by ? `${person(f.decided_by)}${role(f.decided_by, clinician)}` : `<span class="muted">${f.decision === "rejected" || f.decision === "accepted" ? "no user recorded" : "—"}</span>`}</div><div class="muted small">${when(f.decided_at)}</div></div>
    </div>
    ${f.decision === "rejected" ? `<div class="callout bad"><b>Rejected</b> ${esc(REJECTED_VIA[f.rejected_via] ?? f.rejected_via ?? "")}${f.decided_by ? ` by ${person(f.decided_by)}` : ""}${f.rejection_reason ? ` — reason: <b>${esc(f.rejection_reason)}</b>` : " — no reason given"}</div>` : ""}
    ${rows(f.feedback).map((fb) => `<div class="callout info"><b>${person(fb.by)}</b> ${esc(fb.message)} <span class="muted small">${when(fb.at)}</span></div>`).join("")}
    ${answers.some((a) => a.push_error) ? `<div class="callout bad"><b>Push error</b> ${esc(answers.find((a) => a.push_error)!.push_error)}</div>` : ""}
    <div class="sub">Evidence the AI cited</div>${evidence(rows(f.evidence))}
    ${answers.length > 1 ? `<details class="inner"><summary>Answer history (${answers.length})</summary><ol class="hist">${answers.map((a) => `<li><b>${val(a.value)}</b> <span class="muted">${esc(a.source)}${a.by ? ` · ${person(a.by)}` : ""} · ${when(a.at)}${a.pushed_at ? ` · pushed` : ""}</span></li>`).join("")}</ol></details>` : ""}
    ${prompt(f.prompt_field_line, f.prompt_instructions, f.step_key)}
  </article>`;
}

const ABSTAIN_WHY: Record<string, string> = {
  abstained:
    "The model either returned no value or returned a value without a valid citation, so Lime dropped it. Lime does not store the raw answer or its citations for abstained fields; below is what the visit evidence the AI was given says about this item.",
  "skipped by rule": "A skip rule hid this field because of another answer on the form (e.g. a gate item left blank).",
  "document only": "The model answered only from a referral/document, but this is a current-state field that needs visit evidence.",
  "no output": "The field was in the prompt but the step produced nothing for it (failed step or no output).",
  "never asked": "This field was never sent to the model on this visit.",
};

function stepStatus(s: Record<string, any> | undefined): [string, string] {
  if (!s) return ["never asked", "muted"];
  if (s.gated) return ["skipped by rule", "info"];
  if (s.document_only) return ["document only", "info"];
  if (s.abstained) return ["abstained", "warn"];
  return ["no output", "bad"];
}

/** Cuts a long passage down to the windows around its topic matches, with the matches highlighted. */
export function excerpt(text: string, pattern: string): string {
  const re = new RegExp(pattern, "gi");
  const hits = [...text.matchAll(re)].map((m) => m.index!);
  if (!hits.length) return esc(text.slice(0, 300));
  const windows: [number, number][] = [];
  for (const at of hits.slice(0, 6)) {
    const w: [number, number] = [Math.max(0, at - 160), Math.min(text.length, at + 200)];
    const prev = windows.at(-1);
    if (prev && w[0] <= prev[1]) prev[1] = w[1];
    else windows.push(w);
  }
  return windows
    .map(([from, to]) => `${from > 0 ? "…" : ""}${esc(text.slice(from, to)).replace(new RegExp(`(${pattern})`, "gi"), "<mark>$1</mark>")}${to < text.length ? "…" : ""}`)
    .join("<br>");
}

/** The passages on the item's topic in the evidence the AI was shown (empty when the field was never asked). */
export function seenEvidence(key: string, label: string, units: Record<string, any>[], asked: boolean): string {
  const pattern = topicOf(key);
  if (!asked) return "";
  if (!pattern) return `<div class="sub">What the AI saw about this</div><div class="muted small">No topic words configured for this item.</div>`;
  const re = new RegExp(pattern, "i");
  // Overlapping transcript windows repeat the same passage; keep each passage once.
  const hits = [...new Map(units.filter((u) => re.test(u.text ?? "")).map((u) => [String(u.text).trim(), u])).values()];
  // Plain alternatives only; grouped phrases like "wash(es|ing)? (up|…)" are left out of the label.
  const words = [...new Set(pattern.replace(/\(\?![^)]*\)/g, "").split("|").map((w) => w.trim()).filter((w) => w && !/[()?]/.test(w)))];
  const audio = hits.filter((u) => u.type === "audio").length;
  const head = `<div class="sub">What the AI saw about this · ${audio} from the visit recording · ${hits.length - audio} from documents/photos</div>
    <div class="muted small">Passages in the evidence sent with the AI's latest prompt for this item that mention: ${esc(words.slice(0, 8).join(", "))}${words.length > 8 ? "…" : ""}</div>`;
  if (!hits.length)
    return `${head}<div class="callout warn"><b>Nothing about “${esc(label.replace(/^Current:\s*/i, ""))}”</b> appears in the transcript, documents or photos the AI was given for this visit, so it had nothing to answer from.</div>`;
  const card = (u: Record<string, any>) => {
    const src =
      u.type === "audio"
        ? `<span class="src audio">🎙 Audio ${esc(u.at)}</span>${u.speaker ? `<span class="src">${esc(u.speaker)}</span>` : ""}`
        : u.type === "document"
          ? `<span class="src doc">📄 ${esc(u.document ?? "Document")}</span>${u.page ? `<span class="src">p.${esc(u.page)}</span>` : ""}`
          : `<span class="src">${esc(u.type)}</span>`;
    return `<blockquote class="ev"><div class="srcs">${src}<span class="src mono">#${esc(u.handle)}</span></div><p>${excerpt(u.text ?? "", pattern)}</p></blockquote>`;
  };
  const rest = hits.slice(8);
  return `${head}${hits.slice(0, 8).map(card).join("")}${rest.length ? `<details class="inner"><summary>Show ${rest.length} more passage${rest.length === 1 ? "" : "s"}</summary>${rest.map(card).join("")}</details>` : ""}`;
}

/** A field the AI gave no suggestion for: why, what the visit evidence said about it, and every prompt it was in. */
export function noSuggestionCard(u: Record<string, any>, steps: Record<string, any>[], clinician: string, seen: Record<string, any>[]): string {
  const last = steps.at(-1);
  const [status, kind] = stepStatus(last);
  const answers = rows(u.answers);
  const final = answers.at(-1);
  const attempts = steps
    .map((s) => {
      const [st, k] = stepStatus(s);
      const notes = [
        s.unresolved_citations ? `${s.unresolved_citations} unresolved citation(s) in this step` : "",
        s.rejected_handles ? `${s.rejected_handles} cited handle(s) rejected in this step` : "",
        s.error ? `error: ${s.error}` : "",
      ].filter(Boolean);
      return `<li><span class="pill ${k}">${st}</span> <span class="muted small">${esc(s.operation ?? "")} · ${esc(s.step_key)} · ${esc(s.model ?? "")} · ${when(s.created_at)}</span>
        ${notes.length ? `<div class="muted small">${notes.map(esc).join(" · ")}</div>` : ""}
        ${s.deferred ? `<div class="callout info"><b>Held answer</b> ${val(s.deferred.value)} — waited on a gate and never landed</div>${evidence(rows(s.deferred.evidence))}` : ""}</li>`;
    })
    .join("");
  return `<article class="field none">
    <header><code>${esc(u.key)}</code><span class="flabel">${esc(u.label)}</span><span class="pill ${kind}">${status}</span></header>
    <div class="compare">
      <div><div class="k">AI suggested</div><div class="v big"><span class="muted">nothing</span></div><div class="muted small">${steps.length} prompt${steps.length === 1 ? "" : "s"}</div></div>
      <div class="arrow">→</div>
      <div><div class="k">Final answer</div><div class="v big">${final ? val(final.value) : `<span class="muted">blank</span>`}</div><div class="muted small">${final ? `${esc(final.source)}${final.by ? ` · ${person(final.by)}` : ""}${final.at ? ` · ${when(final.at)}` : ""}` : "nobody answered"}</div></div>
      <div><div class="k">Answered by</div><div class="v">${final?.by ? `${person(final.by)}${role(final.by, clinician)}` : `<span class="muted">—</span>`}</div></div>
    </div>
    <div class="callout warn"><b>Why no suggestion</b> ${esc(ABSTAIN_WHY[status] ?? "")}</div>
    ${rows(u.feedback).map((fb) => `<div class="callout info"><b>${person(fb.by)}</b> ${esc(fb.message)} <span class="muted small">${when(fb.at)}</span></div>`).join("")}
    ${seenEvidence(u.key, u.label ?? "", seen.filter((x) => x.key === u.key), steps.length > 0)}
    ${steps.length ? `<details class="inner"><summary>Every time the AI was asked (${steps.length})</summary><ol class="hist">${attempts}</ol></details>` : ""}
    ${answers.length > 1 ? `<details class="inner"><summary>Answer history (${answers.length})</summary><ol class="hist">${answers.map((a) => `<li><b>${val(a.value)}</b> <span class="muted">${esc(a.source)}${a.by ? ` · ${person(a.by)}` : ""} · ${when(a.at)}</span></li>`).join("")}</ol></details>` : ""}
    ${last ? prompt(last.prompt_field_line, last.prompt_instructions, last.step_key) : ""}
  </article>`;
}

/** Labels a person as the visit's clinician or as someone else (coder / reviewer). */
function role(by: unknown, clinician: string): string {
  if (!by) return "";
  const name = person(by);
  return name && clinician && name === clinician
    ? ` <span class="pill info">visit clinician</span>`
    : ` <span class="pill">coder / reviewer</span>`;
}

const REJECTED_VIA: Record<string, string> = {
  review: "explicitly rejected in review",
  edit: "overwritten by editing the answer",
  restore: "replaced by restoring an earlier value",
};

/** One visit of an issue: header, chips, tally, the issue's fields, no-suggestion fields and other rejections. */
export function visitCard(v: VisitData): string {
  const t = rows(v.data.task)[0] ?? {};
  const audio = rows(v.data.audio);
  const fields = rows(v.data.fields);
  const other = rows(v.data.other_rejections);
  const unanswered = rows(v.data.unanswered);
  const steps = rows(v.data.no_suggestion_steps);
  const clinician = person(t.clinician);
  const rejected = fields.filter((f) => f.decision === "rejected");
  const summary = `<div class="tally">
    <span class="pill good">${fields.filter((f) => f.decision === "accepted").length} accepted</span>
    <span class="pill bad">${rejected.length} rejected</span>
    <span class="pill warn">${fields.filter((f) => !f.decision || f.decision === "pending").length} pending</span>
    <span class="pill">${unanswered.length} no suggestion</span>
    <span class="pill">${other.length} other rejections on this visit</span>
  </div>${rejected.length ? `<div class="callout bad"><b>Rejections on this issue's fields</b><ul class="rej">${rejected.map((f) => `<li><code>${esc(f.key)}</code> AI ${val(f.ai_value)} → ${val(rows(f.answers).at(-1)?.value)} · ${esc(REJECTED_VIA[f.rejected_via] ?? f.rejected_via ?? "")}${f.decided_by ? ` by ${person(f.decided_by)}${role(f.decided_by, clinician)}` : ""} · reason: ${f.rejection_reason ? `<b>${esc(f.rejection_reason)}</b>` : `<span class="muted">none</span>`}</li>`).join("")}</ul></div>` : ""}`;
  const chips = [
    `👩‍⚕️ ${person(t.clinician)}`,
    ...audio.map((a) => `🎙 ${esc(a.status)}${a.language ? ` · ${esc(a.language)}` : ""}${a.translated ? " · translated" : ""}`),
    `📷 ${esc(t.photos ?? 0)} photos`,
    `⚙️ ${rows(v.data.runs).length} AI runs`,
  ];
  return `<section class="visit">
    <header class="vhead">
      <div><div class="vtitle">${esc(t.organization)} <span class="muted">·</span> ${esc(t.form ?? t.task_name)}</div>
        <div class="muted small">Visit ${day(t.visit_date)} · ${esc(t.task_name)} · ${esc(t.status)}</div></div>
      ${t.app_link ? `<a class="btn" href="${esc(t.app_link)}" target="_blank">Open chart ↗</a>` : ""}
    </header>
    <div class="chips">${chips.map((c) => `<span class="chip">${c}</span>`).join("")}</div>
    ${err(v.data.task)}${err(v.data.fields)}${err(v.data.no_suggestion_steps)}
    ${summary}
    ${fields.length ? `<div class="sub">AI suggestions (${fields.length})</div>${fields.map((f) => fieldCard(f, clinician)).join("")}` : ""}
    ${unanswered.length ? `<div class="sub">Fields with no AI suggestion (${unanswered.length})</div>${unanswered.map((u) => noSuggestionCard(u, steps.filter((s) => s.key === u.key), clinician, rows(v.data.seen_evidence))).join("")}` : ""}
    ${other.length ? `<details class="inner"><summary>Other rejections on this visit (${other.length})</summary>${other.map((f) => fieldCard(f, clinician)).join("")}</details>` : ""}
  </section>`;
}

/** Counts shown on an issue page and in the overview. */
export function stats(p: Pack) {
  const all = p.visits.map((v) => v.data);
  const suggested = all.flatMap((d) => rows(d.fields));
  const abstained = new Set(all.flatMap((d, i) => rows(d.no_suggestion_steps).filter((s) => s.abstained).map((s) => `${i}:${s.key}`))).size;
  const rejected = suggested.filter((f) => f.decision === "rejected").length + all.reduce((n, d) => n + rows(d.other_rejections).length, 0);
  const orgs = [...new Set(all.map((d) => rows(d.task)[0]?.organization).filter(Boolean))];
  const reports = p.threads.reduce((n, t) => n + t.messages.length, 0);
  return { suggested: suggested.length, abstained, rejected, orgs, reports };
}

/** One Slack thread with avatars, screenshots and file names. */
export function thread(t: SlackThread): string {
  return `<div class="thread">
    <div class="thead"><span class="muted small">Slack thread</span><a href="${esc(t.link)}" target="_blank">Open in Slack ↗</a></div>
    ${t.error ? `<div class="callout bad">Couldn't read this thread (${esc(t.error)}), the bot may not be in the channel.</div>` : ""}
    ${t.messages
      .map((m) => {
        const bot = /dotterino|parcerito|bot/i.test(m.author);
        return `<div class="msg ${bot ? "bot" : ""}"><div class="avatar">${esc(initials(m.author))}</div><div class="mbody">
          <div class="mhead"><b>${esc(m.author)}</b><a class="muted small" href="${esc(m.permalink)}" target="_blank">${slackDate(m.ts)}</a></div>
          <div class="mtext ${bot ? "clamp" : ""}">${slackText(m.text)}</div>
          ${m.images.length ? `<div class="shots">${m.images.map((src) => `<img src="${esc(src)}" loading="lazy" data-zoom>`).join("")}</div>` : ""}
          ${m.files.length ? `<div class="muted small">📎 ${m.files.map(esc).join(", ")}</div>` : ""}
        </div></div>`;
      })
      .join("")}
  </div>`;
}

/** Rejected rows behind an agenda card: field, AI value → coder value, reason, who and the visit. */
export function rowsTable(list: DbRow[]): string {
  if (!list.length) return "";
  return `<div class="thread"><div class="thead"><span class="muted small">Rejected AI suggestions (${list.length})</span></div>
    <table class="grid"><thead><tr><th>Field</th><th>AI → coder</th><th>Reason</th><th>Decided by</th><th>Visit</th></tr></thead><tbody>
    ${list
      .map(
        (r) => `<tr><td><code>${esc(r.field)}</code><div class="muted small">${esc(r.form)}${r.customer ? ` · ${esc(r.customer)}` : ""}</div></td>
      <td>${val(r.aiValue)} → ${val(r.coderValue)}<div class="muted small">${esc(r.how)}</div></td><td>${r.reason ? esc(r.reason) : `<span class="muted">none</span>`}</td>
      <td>${esc(r.decidedBy ?? "")}<div class="muted small">${day(r.decidedAt)}</div></td>
      <td>${r.appLink ? `<a href="${esc(r.appLink)}" target="_blank">${r.visitDate ? day(r.visitDate) : "Open"} ↗</a>` : day(r.visitDate)}</td></tr>`,
      )
      .join("")}
    </tbody></table></div>`;
}

const linearBody = (l: LinearIssue) =>
  `<div class="md">${esc(l.description)}</div>${l.comments.nodes.map((c) => `<div class="comment"><div class="mhead"><b>${esc(c.user?.name ?? "")}</b><span class="muted small">${when(c.createdAt)}</span></div><div class="md">${esc(c.body)}</div></div>`).join("")}`;

/** The Linear tab: one issue as-is, several each under a heading. */
export function linearEvidence(p: Pack): string {
  if (p.linear.length === 1) return linearBody(p.linear[0]!);
  const issues = p.linear
    .map((l) => `<div class="sub"><a href="${esc(l.url)}" target="_blank">${esc(l.identifier)}</a> · ${esc(l.title)} · ${esc(l.state.name)} · ${esc(l.assignee?.name ?? "unassigned")}</div>${linearBody(l)}`)
    .join("");
  return issues || `<div class="empty">No Linear issue linked.</div>`;
}

function linearLinks(list: LinearIssue[]): string {
  if (list.length === 1) return `<a class="btn ghost" href="${esc(list[0]!.url)}" target="_blank">Linear ↗</a>`;
  return list.length ? `<div class="links">${list.map((l) => `<a class="btn ghost" href="${esc(l.url)}" target="_blank">${esc(l.identifier)} ↗</a>`).join("")}</div>` : "";
}

/**
 * The page of item `i` of `total`: stats, tabs (Reports / Visits & AI / Linear notes) and the decision panel. The hub
 * can add panel cards (`aside`) and swap the decision card (`decision`); without them the page is the Megan review's.
 */
export function issuePage(p: Pack, i: number, total: number, opts: { aside?: string; decision?: string } = {}): string {
  const { item } = p;
  const s = stats(p);
  const { blocks, questions, placeholder } = item.panel;
  const cards = [
    ...blocks.map((b) => `<div class="card ${esc(b.cls)}"><div class="ctitle">${esc(b.title)}</div><p>${esc(b.text)}</p></div>`),
    ...(questions
      ? [`<div class="card ask"><div class="ctitle">${esc(questions.title)}</div>
        ${questions.items.map((a, qi) => `<label class="q"><input type="checkbox" data-save="${item.id}:q${qi}"><span>${esc(a)}</span></label>`).join("")}
      </div>`]
      : []),
  ];
  return `<article class="issue" id="${item.id}" data-group="${item.group}">
  <div class="crumbs"><span>${esc(GROUPS[item.group])}</span><span class="muted">${i + 1} / ${total}</span></div>
  <header class="ihead">
    <div><div class="iid">${esc(item.id)}${item.badges.map((b) => ` <span class="pill ${esc(b.kind)}">${esc(b.text)}</span>`).join("")}</div>
      <h1>${esc(item.title)}</h1>
      <div class="muted small">${item.meta.map(esc).join(" · ")}${s.orgs.length ? ` · ${s.orgs.map(esc).join(", ")}` : ""}</div></div>
    ${linearLinks(p.linear)}
  </header>
  <div class="stats">
    <div><b>${s.reports}</b><span>Slack messages</span></div>
    <div><b>${p.visits.length}</b><span>Visits</span></div>
    <div><b>${s.suggested}</b><span>AI suggestions</span></div>
    <div class="${s.abstained ? "warn" : ""}"><b>${s.abstained}</b><span>Abstained</span></div>
    <div class="${s.rejected ? "bad" : ""}"><b>${s.rejected}</b><span>Rejected</span></div>
  </div>
  <div class="layout">
    <div class="content">${p.errors.map((e) => `<div class="callout bad">${esc(e)}</div>`).join("")}
      <nav class="tabs"><button data-tab="reports" class="on">Reports</button><button data-tab="visits">Visits &amp; AI (${p.visits.length})</button><button data-tab="linear">Linear notes</button></nav>
      <div class="tab" data-tab="reports">${p.threads.map(thread).join("") + rowsTable(item.rows ?? []) || `<div class="empty">No Slack thread linked from the issue.</div>`}</div>
      <div class="tab" data-tab="visits" hidden>${p.visits.map(visitCard).join("") || `<div class="empty">The reports don't link a specific visit. This is a general request, so the decision is about the rule, not a chart.</div>`}</div>
      <div class="tab" data-tab="linear" hidden>${linearEvidence(p)}</div>
    </div>
    <aside class="panel">
      ${cards.join("\n      ")}${opts.aside ?? ""}
      ${opts.decision ?? `<div class="card decision"><div class="ctitle">✅ Decision</div>
        <div class="seg">${["Approved", "Change prompt", "Ask agency", "Defer"].map((d) => `<label><input type="radio" name="${item.id}" value="${d}" data-save="${item.id}:decision"><span>${d}</span></label>`).join("")}</div>
        <textarea data-save="${item.id}:notes" placeholder="${esc(placeholder)}"></textarea>
      </div>`}
      <div class="pager">${i > 0 ? `<a class="btn ghost" data-go="prev">← Prev</a>` : "<span></span>"}${i < total - 1 ? `<a class="btn" data-go="next">Next →</a>` : ""}</div>
    </aside>
  </div>
</article>`;
}

/** The landing table of every issue with its live decision status. */
export function overview(packs: Pack[]): string {
  return `<article class="issue" id="overview">
  <header class="ihead"><div><div class="iid">Meeting with Megan · ${new Date().toISOString().slice(0, 10)}</div><h1>Clarification issues</h1>
    <div class="muted small">${packs.length} issues, ordered by priority: ADLs first, then GG mobility, other OASIS items, agency fields and narratives. Press → to start.</div></div>
    <button class="btn ghost" id="export">Export decisions</button></header>
  <table class="grid overview"><thead><tr><th>Issue</th><th>Group</th><th>Manual</th><th>Visits</th><th>AI</th><th>Decision</th></tr></thead><tbody>
  ${packs
    .map((p) => {
      const s = stats(p);
      return `<tr data-href="#${p.item.id}"><td><b>${esc(p.item.id)}</b><div class="muted small">${esc(p.item.title)}</div></td><td>${esc(GROUPS[p.item.group])}</td>
        <td>${p.item.verdict === "partial" ? `<span class="pill warn">partial</span>` : `<span class="pill bad">not in manual</span>`}</td>
        <td>${p.visits.length}</td><td class="small">${s.suggested} suggested · ${s.abstained} abstained · ${s.rejected} rejected</td>
        <td><span class="pill muted" data-status="${p.item.id}">open</span></td></tr>`;
    })
    .join("")}
  </tbody></table>
</article>`;
}

/** The complete HTML document for the packs, in the given order. */
export function render(packs: Pack[]): string {
  const side = ([1, 2, 3, 4, 5] as const)
    .map((g) => {
      const items = packs.filter((p) => p.item.group === g);
      if (!items.length) return "";
      return `<div class="group"><div class="gtitle">${esc(GROUPS[g])}</div>${items
        .map((p) => `<a href="#${p.item.id}" data-id="${p.item.id}"><span class="dot" data-dot="${p.item.id}"></span><span class="nid">${esc(p.item.id)}</span><span class="ntitle">${esc(p.item.title.replace(/^(Validate|Review|Investigate)\s+/, ""))}</span></a>`)
        .join("")}</div>`;
    })
    .join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Megan review · ${new Date().toISOString().slice(0, 10)}</title><style>${CSS}</style></head><body>
<aside class="side">
  <div class="brand"><div class="logo">L</div><div><b>Megan review</b><div class="muted small">Contains PHI · local only</div></div></div>
  <div class="progress"><div class="bar"><i id="bar"></i></div><span class="muted small" id="done">0 / ${packs.length} decided</span></div>
  <input id="search" placeholder="Search issues…  ( / )">
  <a href="#overview" class="ov" data-id="overview">▦ Overview</a>
  ${side}
  <div class="muted small keys">← → navigate · / search</div>
</aside>
<main>${overview(packs)}${packs.map((p, i) => issuePage(p, i, packs.length)).join("")}</main>
<div id="lightbox" hidden><img></div>
<script>${CLIENT}</script></body></html>`;
}

/** Page styles. */
export const CSS = `
:root{--bg:#0b0d12;--panel:#12151c;--panel2:#181c25;--line:#252b37;--text:#e7eaf0;--muted:#8a93a6;--accent:#8b7dff;--accent2:#5eead4;
--good:#34d399;--bad:#f87171;--warn:#fbbf24;--info:#60a5fa;--r:12px}
*{box-sizing:border-box}html{color-scheme:dark}
body{margin:0;background:var(--bg);color:var(--text);font:14px/1.55 Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;display:flex;min-height:100vh}
a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}
code,pre,.mono{font-family:"JetBrains Mono",ui-monospace,SFMono-Regular,Menlo,monospace}
.muted{color:var(--muted)}.small{font-size:12px}
.side{position:sticky;top:0;height:100vh;width:300px;flex:none;overflow:auto;background:var(--panel);border-right:1px solid var(--line);padding:18px 14px}
.brand{display:flex;gap:10px;align-items:center;margin-bottom:16px}.logo{width:34px;height:34px;border-radius:10px;display:grid;place-items:center;font-weight:800;background:linear-gradient(135deg,var(--accent),var(--accent2));color:#0b0d12}
.progress{margin-bottom:12px}.bar{height:6px;border-radius:6px;background:var(--line);overflow:hidden;margin-bottom:4px}.bar i{display:block;height:100%;width:0;background:linear-gradient(90deg,var(--accent),var(--accent2));transition:width .3s}
#search{width:100%;padding:9px 12px;border-radius:10px;border:1px solid var(--line);background:var(--bg);color:var(--text);margin-bottom:10px;font:inherit}
#search:focus{outline:none;border-color:var(--accent)}
.side a{display:flex;gap:8px;align-items:baseline;padding:7px 9px;border-radius:9px;color:var(--text);text-decoration:none;margin:1px 0}
.side a:hover{background:var(--panel2)}.side a.on{background:rgba(139,125,255,.16);box-shadow:inset 2px 0 0 var(--accent)}
.side .ov{font-weight:600;margin-bottom:6px}.gtitle{font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);margin:14px 9px 4px}
.nid{font-family:"JetBrains Mono",ui-monospace,monospace;font-size:12px;color:var(--muted);flex:none}.ntitle{font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dot{width:8px;height:8px;border-radius:50%;background:var(--line);flex:none;align-self:center}
.dot[data-s="Approved"]{background:var(--good)}.dot[data-s="Change prompt"]{background:var(--accent)}.dot[data-s="Ask agency"]{background:var(--warn)}.dot[data-s="Defer"]{background:var(--muted)}
.keys{margin:18px 9px 0}
main{flex:1;min-width:0;padding:28px 36px 80px}
.issue{display:none;max-width:1400px;margin:0 auto;animation:fade .2s ease}.issue.on{display:block}@keyframes fade{from{opacity:0;transform:translateY(4px)}}
.crumbs{display:flex;justify-content:space-between;font-size:12px;color:var(--accent2);text-transform:uppercase;letter-spacing:.08em;margin-bottom:6px}
.ihead{display:flex;justify-content:space-between;gap:20px;align-items:flex-start;margin-bottom:18px}
.iid{font-family:"JetBrains Mono",ui-monospace,monospace;color:var(--muted);display:flex;gap:10px;align-items:center}
h1{font-size:24px;line-height:1.25;margin:6px 0;font-weight:650;letter-spacing:-.01em}
.btn{display:inline-block;padding:8px 14px;border-radius:10px;background:var(--accent);color:#0b0d12;font-weight:600;border:0;cursor:pointer;white-space:nowrap;font:inherit;font-weight:600}
.btn:hover{text-decoration:none;filter:brightness(1.1)}.btn.ghost{background:transparent;color:var(--text);border:1px solid var(--line)}
.stats{display:grid;grid-template-columns:repeat(5,1fr);gap:10px;margin-bottom:20px}
.stats div{background:var(--panel);border:1px solid var(--line);border-radius:var(--r);padding:12px 14px}.stats b{display:block;font-size:22px}.stats span{color:var(--muted);font-size:12px}
.stats .warn b{color:var(--warn)}.stats .bad b{color:var(--bad)}
.layout{display:grid;grid-template-columns:minmax(0,1fr) 360px;gap:22px;align-items:start}
.panel{position:sticky;top:20px;display:flex;flex-direction:column;gap:12px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:var(--r);padding:14px 16px}.card p{margin:6px 0 0;color:#c9cfdb}
.ctitle{font-weight:650;font-size:13px}.manual{border-color:rgba(96,165,250,.35)}.ask{border-color:rgba(251,191,36,.35)}.decision{border-color:rgba(139,125,255,.45)}
.q{display:flex;gap:10px;padding:8px 0;border-top:1px solid var(--line);cursor:pointer}.q:first-of-type{border-top:0}.q input{margin-top:4px;accent-color:var(--accent)}
.q input:checked+span{color:var(--muted);text-decoration:line-through}
.seg{display:grid;grid-template-columns:1fr 1fr;gap:6px;margin:10px 0}.seg input{display:none}
.seg span{display:block;text-align:center;padding:7px;border-radius:9px;border:1px solid var(--line);cursor:pointer;font-size:13px}
.seg input:checked+span{background:var(--accent);color:#0b0d12;border-color:var(--accent);font-weight:600}
textarea{width:100%;min-height:110px;resize:vertical;background:var(--bg);color:var(--text);border:1px solid var(--line);border-radius:10px;padding:10px;font:inherit}
textarea:focus{outline:none;border-color:var(--accent)}
.pager{display:flex;justify-content:space-between}
.tabs{display:flex;gap:4px;border-bottom:1px solid var(--line);margin-bottom:16px}
.tabs button{background:none;border:0;color:var(--muted);padding:10px 14px;font:inherit;cursor:pointer;border-bottom:2px solid transparent;margin-bottom:-1px}
.tabs button.on{color:var(--text);border-color:var(--accent)}
.thread{background:var(--panel);border:1px solid var(--line);border-radius:var(--r);padding:6px 16px 10px;margin-bottom:14px}
.thead{display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid var(--line)}
.msg{display:flex;gap:12px;padding:12px 0;border-bottom:1px solid var(--line)}.msg:last-child{border-bottom:0}
.avatar{width:34px;height:34px;flex:none;border-radius:50%;display:grid;place-items:center;font-size:12px;font-weight:700;background:var(--panel2);border:1px solid var(--line)}
.msg.bot{opacity:.7}.msg.bot .avatar{color:var(--accent2)}.mbody{min-width:0;flex:1}.mhead{display:flex;gap:10px;align-items:baseline}
.mtext{overflow-wrap:anywhere;margin-top:2px}.mtext.clamp{display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden;cursor:pointer}.mtext.clamp.open{display:block}
.mention{color:var(--accent2)}
.shots{display:flex;flex-wrap:wrap;gap:8px;margin-top:8px}.shots img{height:150px;max-width:100%;object-fit:cover;border-radius:10px;border:1px solid var(--line);cursor:zoom-in;transition:transform .15s}.shots img:hover{transform:scale(1.02)}
.visit{background:var(--panel);border:1px solid var(--line);border-radius:var(--r);padding:16px 18px;margin-bottom:16px}
.vhead{display:flex;justify-content:space-between;gap:12px;align-items:center}.vtitle{font-weight:650;font-size:16px}
.chips{display:flex;flex-wrap:wrap;gap:6px;margin:12px 0}.chip{background:var(--panel2);border:1px solid var(--line);border-radius:999px;padding:3px 10px;font-size:12px}
.sub{font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);margin:16px 0 8px}
.field{background:var(--panel2);border:1px solid var(--line);border-left:3px solid var(--warn);border-radius:10px;padding:12px 14px;margin-bottom:10px}
.field.rejected{border-left-color:var(--bad)}.field.accepted{border-left-color:var(--good)}
.field header{display:flex;gap:10px;align-items:center;flex-wrap:wrap}.flabel{font-weight:600;flex:1}
.compare{display:grid;grid-template-columns:1fr auto 1fr 1fr;gap:14px;align-items:start;margin:12px 0;padding:12px;background:var(--bg);border-radius:10px}
.compare .k{font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.06em}.compare .v{margin-top:2px;overflow-wrap:anywhere}.compare .big{font-size:18px;font-weight:650}
.compare .changed{color:var(--warn)}.arrow{color:var(--muted);align-self:center;font-size:18px}
.pill{display:inline-block;font-size:11px;font-weight:600;padding:2px 9px;border-radius:999px;white-space:nowrap;background:var(--panel2);border:1px solid var(--line);color:var(--muted)}
.pill.good{color:var(--good);border-color:rgba(52,211,153,.4);background:rgba(52,211,153,.1)}.pill.bad{color:var(--bad);border-color:rgba(248,113,113,.4);background:rgba(248,113,113,.1)}
.pill.warn{color:var(--warn);border-color:rgba(251,191,36,.4);background:rgba(251,191,36,.1)}.pill.info{color:var(--info);border-color:rgba(96,165,250,.4);background:rgba(96,165,250,.1)}
.pill.on{color:#0b0d12;background:var(--accent);border-color:var(--accent)}
.callout{border-radius:10px;padding:9px 12px;margin:8px 0;font-size:13px}.callout.bad{background:rgba(248,113,113,.1);border:1px solid rgba(248,113,113,.35)}
.callout.info{background:rgba(96,165,250,.08);border:1px solid rgba(96,165,250,.3)}.callout.warn{background:rgba(251,191,36,.07);border:1px solid rgba(251,191,36,.3)}
.field.none{border-left-color:var(--muted)}mark{background:rgba(251,191,36,.3);color:inherit;border-radius:3px;padding:0 2px}.mono{font-family:"JetBrains Mono",ui-monospace,monospace}.tally{display:flex;flex-wrap:wrap;gap:6px;margin:4px 0 8px}ul.rej{margin:6px 0 0;padding-left:18px}ul.rej li{margin:3px 0}.callout b{margin-right:6px}
blockquote.ev{margin:6px 0;padding:8px 12px;border-left:3px solid var(--accent2);background:var(--bg);border-radius:0 10px 10px 0}blockquote.ev p{margin:4px 0 0;color:#c9cfdb}
.srcs{display:flex;gap:6px;flex-wrap:wrap}.src{font-size:11px;padding:1px 8px;border-radius:999px;background:var(--panel2);border:1px solid var(--line)}
.src.audio{color:var(--accent2)}.src.doc{color:var(--info)}.src.photo{color:var(--warn)}
details>summary{cursor:pointer;color:var(--muted);font-size:13px;list-style:none;padding:4px 0}details>summary::-webkit-details-marker{display:none}
details>summary:before{content:"▸ ";}details[open]>summary:before{content:"▾ "}details>summary:hover{color:var(--text)}
.prompt{margin-top:8px}.prompt .ico{color:var(--accent)}
.instr{background:rgba(139,125,255,.08);border:1px solid rgba(139,125,255,.3);border-radius:10px;padding:10px 12px;white-space:pre-wrap;margin:6px 0}
pre{white-space:pre-wrap;font-size:12px;background:var(--bg);border:1px solid var(--line);padding:10px;border-radius:10px;max-height:420px;overflow:auto;color:#c9cfdb}
table.grid{width:100%;border-collapse:separate;border-spacing:0;border:1px solid var(--line);border-radius:10px;overflow:hidden}
.grid th{text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);background:var(--panel2);padding:8px 10px;font-weight:600}
.grid td{padding:9px 10px;border-top:1px solid var(--line);vertical-align:top}
.overview tr[data-href]{cursor:pointer}.overview tr[data-href]:hover td{background:var(--panel2)}
ol.hist{margin:4px 0;padding-left:20px}
.md{white-space:pre-wrap;background:var(--panel);border:1px solid var(--line);border-radius:var(--r);padding:14px 16px;font-size:13px;color:#c9cfdb;overflow-wrap:anywhere}
.comment{margin-top:12px}.comment .md{margin-top:6px}
.empty{border:1px dashed var(--line);border-radius:var(--r);padding:28px;text-align:center;color:var(--muted)}
#lightbox{position:fixed;inset:0;background:rgba(0,0,0,.85);display:grid;place-items:center;z-index:10;cursor:zoom-out}#lightbox[hidden]{display:none}
#lightbox img{max-width:94vw;max-height:94vh;border-radius:10px}
@media (max-width:1100px){.layout{grid-template-columns:1fr}.panel{position:static}.stats{grid-template-columns:repeat(3,1fr)}}
@media print{.side,.pager,.tabs{display:none}.issue{display:block!important;page-break-after:always}.tab{display:block!important}}
`;

/** Browser script: navigation, tabs, localStorage persistence, search, lightbox and Markdown export. */
export const CLIENT = `
const $ = (s, el = document) => el.querySelector(s), $$ = (s, el = document) => [...el.querySelectorAll(s)];
const ids = $$(".issue").map((a) => a.id);
const KEY = "megan-review:";

function show() {
  const id = ids.includes(location.hash.slice(1)) ? location.hash.slice(1) : "overview";
  $$(".issue").forEach((a) => a.classList.toggle("on", a.id === id));
  $$(".side a").forEach((a) => a.classList.toggle("on", a.dataset.id === id));
  $(".side a.on")?.scrollIntoView({ block: "nearest" });
  window.scrollTo(0, 0);
}
function go(step) {
  const i = ids.indexOf($(".issue.on").id) + step;
  if (i >= 0 && i < ids.length) location.hash = ids[i];
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

// Tabs per issue.
$$(".issue").forEach((issue) =>
  $$(".tabs button", issue).forEach((b) =>
    b.addEventListener("click", () => {
      $$(".tabs button", issue).forEach((x) => x.classList.toggle("on", x === b));
      $$(".tab", issue).forEach((t) => (t.hidden = t.dataset.tab !== b.dataset.tab));
    }),
  ),
);

// Persist questions, decision and notes in the browser.
function load() {
  $$("[data-save]").forEach((el) => {
    const v = localStorage.getItem(KEY + el.dataset.save);
    if (el.type === "checkbox") el.checked = v === "1";
    else if (el.type === "radio") el.checked = v === el.value;
    else el.value = v ?? "";
  });
}
function status() {
  let done = 0;
  ids.filter((id) => id !== "overview").forEach((id) => {
    const d = localStorage.getItem(KEY + id + ":decision");
    if (d) done++;
    const dot = $('[data-dot="' + id + '"]'); if (dot) dot.dataset.s = d || "";
    const pill = $('[data-status="' + id + '"]');
    if (pill) { pill.textContent = d || "open"; pill.className = "pill " + (d ? "on" : "muted"); }
  });
  const total = ids.length - 1;
  $("#done").textContent = done + " / " + total + " decided";
  $("#bar").style.width = (100 * done) / total + "%";
}
$$("[data-save]").forEach((el) =>
  el.addEventListener(el.tagName === "TEXTAREA" ? "input" : "change", () => {
    localStorage.setItem(KEY + el.dataset.save, el.type === "checkbox" ? (el.checked ? "1" : "") : el.value);
    status();
  }),
);

// Search filters the sidebar.
$("#search").addEventListener("input", (e) => {
  const q = e.target.value.toLowerCase();
  $$(".side a[data-id]").forEach((a) => (a.style.display = !q || a.textContent.toLowerCase().includes(q) ? "" : "none"));
});

// Long bot messages expand on click; screenshots open in a lightbox.
$$(".mtext.clamp").forEach((m) => m.addEventListener("click", () => m.classList.toggle("open")));
$$("[data-zoom]").forEach((img) => img.addEventListener("click", () => { $("#lightbox img").src = img.src; $("#lightbox").hidden = false; }));
$("#lightbox").addEventListener("click", () => ($("#lightbox").hidden = true));

// Export decisions as Markdown, ready to paste into Linear or Slack.
$("#export").addEventListener("click", () => {
  const out = ids.filter((id) => id !== "overview").map((id) => {
    const art = document.getElementById(id);
    const qs = $$(".q", art).map((q) => "- [" + ($("input", q).checked ? "x" : " ") + "] " + q.textContent.trim()).join("\\n");
    const d = localStorage.getItem(KEY + id + ":decision") || "open";
    const n = localStorage.getItem(KEY + id + ":notes") || "";
    return "## " + id + " · " + $("h1", art).textContent + "\\n**Decision:** " + d + "\\n" + qs + (n ? "\\n\\n" + n : "");
  }).join("\\n\\n");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([out], { type: "text/markdown" }));
  a.download = "megan-decisions-" + new Date().toISOString().slice(0, 10) + ".md";
  a.click();
});

load(); status(); show();
`;
