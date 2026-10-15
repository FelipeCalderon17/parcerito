import type { WebClient } from "@slack/web-api";

/** One AI suggestion a coder rejected or overwrote, as exported by `npm run rejected-fields`. */
export interface RejectedField {
  id: string;
  decided_at: string;
  organization: string | null;
  form: string;
  field_key: string;
  field_label: string;
  section: string | null;
  rejected_via: "review" | "edit";
  reason: string | null;
  ai_value: unknown;
  coder_value: unknown;
}

export interface RejectedGroup {
  form: string;
  fieldKey: string;
  fieldLabel: string;
  rows: RejectedField[];
}

export interface RejectedExport {
  exportedAt: Date;
  groups: RejectedGroup[];
  total: number;
}

const EXPORT_FILE = /^rejected-fields-.*\.json$/;

/**
 * Finds the newest export the local script uploaded to the DM and keeps the rows decided inside the window.
 * Returns null when there's no export from the last day, so the agenda can say it's missing.
 */
export async function loadRejectedFields(
  client: WebClient,
  opts: { dmChannel: string; token: string; since: Date; until: Date },
): Promise<RejectedExport | null> {
  const files = await client.files.list({
    channel: opts.dmChannel,
    ts_from: String(Math.floor(opts.until.getTime() / 1000) - 24 * 3600),
    count: 20,
  });
  const latest = (files.files ?? [])
    .filter((f) => f.name && EXPORT_FILE.test(f.name) && f.url_private_download)
    .sort((a, b) => (b.created ?? 0) - (a.created ?? 0))[0];
  if (!latest) return null;

  const res = await fetch(latest.url_private_download!, { headers: { Authorization: `Bearer ${opts.token}` } });
  if (!res.ok) throw new Error(`Couldn't download ${latest.name}: ${res.status}`);
  const data = (await res.json()) as { exportedAt: string; rows: RejectedField[] };
  const rows = data.rows.filter((r) => {
    const decided = new Date(r.decided_at).getTime();
    return decided >= opts.since.getTime() && decided < opts.until.getTime();
  });
  return { exportedAt: new Date(data.exportedAt), groups: groupRejected(rows), total: rows.length };
}

/** Groups by form and field, most rejected first. */
export function groupRejected(rows: RejectedField[]): RejectedGroup[] {
  const groups = new Map<string, RejectedGroup>();
  for (const row of rows) {
    const key = `${row.form}\u0000${row.field_key}`;
    const group = groups.get(key) ?? { form: row.form, fieldKey: row.field_key, fieldLabel: row.field_label, rows: [] };
    group.rows.push(row);
    groups.set(key, group);
  }
  return [...groups.values()].sort((a, b) => b.rows.length - a.rows.length || a.fieldKey.localeCompare(b.fieldKey));
}

/** Compact text for the triage prompt. */
export function describeRejected(groups: RejectedGroup[]): string {
  return groups
    .map((g) => {
      const examples = g.rows
        .slice(0, 5)
        .map(
          (r) =>
            `  - ${r.organization ?? "unknown org"}, ${r.rejected_via === "review" ? "rejected" : "overwritten"}: ` +
            `AI ${short(r.ai_value)} → coder ${short(r.coder_value)}${r.reason ? `; reason: ${r.reason}` : ""}`,
        )
        .join("\n");
      return `${g.form} · ${g.fieldKey} (${g.fieldLabel}): ${g.rows.length}×\n${examples}`;
    })
    .join("\n");
}

export function short(value: unknown, max = 80): string {
  if (value === null || value === undefined || value === "") return "(empty)";
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
