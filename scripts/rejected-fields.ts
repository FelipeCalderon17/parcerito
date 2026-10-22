/**
 * Exports the AI suggestions that coders rejected or overwrote in Lime production and uploads them to your DM
 * with the bot, where the daily agenda picks them up. Runs on your machine (see prod-db.ts).
 *
 *   npm run rejected-fields            # last 7 days (the agenda keeps only its own window)
 *   npm run rejected-fields -- --days 14
 */
import { openBotDm, withProdDb } from "./prod-db.js";

const daysArg = process.argv.indexOf("--days");
const days = daysArg > 0 ? Number(process.argv[daysArg + 1]) : 7;
if (!Number.isInteger(days) || days < 1) throw new Error("--days must be a positive integer");

// Rejected on review (with the coder's reason), or overwritten by a coder. Lime's own automatic rejections
// ('outdated', 'entity_removed') aren't feedback on the AI, so they're left out. Each row carries its trace: who
// decided, the field's line in the prompt that was sent, the INSTRUCTIONS block it points into and the cited
// evidence. The full prompt (patient, transcript, documents) stays out; the joins mirror the traces queries.
const SQL = `
select coalesce(json_agg(x order by x.decided_at desc), '[]') from (
  select r.id, r.decided_at, o.name as organization, f.name as form, fd.key as field_key, fd.label as field_label,
    fd.section, r.rejected_via, r.rejection_reason as reason, r.value as ai_value,
    (select a.value from answer a
      where a.task_id = r.task_id and a.form_field_id = r.form_field_id and a.created_at >= r.created_at
        and a.source = 'clinician'
      order by a.created_at desc limit 1) as coder_value,
    dec.who as decided_by, dec.email as decided_by_email, t.visit_date, t.task as task_name,
    coalesce(r.basis, 'stated') as ai_basis,
    concat('https://app.getlimeai.com/cases/', t.case_id, '?tab=visits&orgId=', o.id,
      '&visitId=', v.id, '&visitTab=form') as app_link,
    st.model_id as model,
    split_part(substr(st.input ->> 'user',
      nullif(strpos(st.input ->> 'user', '{"key":' || to_jsonb(fd.key)::text), 0)), E'\\n', 1) as prompt_field_line,
    substring(st.input ->> 'user' from E'\\nINSTRUCTIONS\\n(.*?)\\n\\nOUTPUT CONTRACT') as prompt_instructions,
    (select coalesce(json_agg(json_build_object(
        'type', case eu.source_kind when 'transcript_utterance' then 'transcript' when 'ocr_block' then 'document'
          when 'medication_photo' then 'photo' else coalesce(eu.source_kind, 'unresolved') end,
        'document', coalesce(fl.display_name, fl.original_name),
        'page', eu.page_number,
        'speaker', eu.speaker,
        'at', to_char(make_interval(secs => coalesce((e.c ->> 'startMs')::int, eu.start_ms) / 1000.0), 'HH24:MI:SS'),
        'snippet', e.c ->> 'snippet') order by e.ord), '[]'::json)
      from jsonb_array_elements(coalesce(r.evidence, '[]'::jsonb)) with ordinality as e(c, ord)
      left join evidence_unit eu on eu.id = (e.c ->> 'unitId')::uuid
      left join file fl on fl.id = eu.file_id) as evidence
  from ai_recommendation r
  join task t on t.id = r.task_id
  left join visit v on v.task_id = t.id
  left join clinician c on c.id = t.clinician_id
  left join organization o on o.id = c.organization_id
  join form_field ff on ff.id = r.form_field_id
  join field fd on fd.id = ff.field_id
  join form f on f.id = ff.form_id
  left join lateral (
    select coalesce(cl.linked_user_name, cl.name) as who, cl.linked_user_email as email
    from clinician cl
    where cl.propel_auth_user_id = r.decided_by::text and cl.deleted_at is null
    order by (cl.organization_id = o.id) desc, cl.created_at desc
    limit 1
  ) dec on true
  left join lateral (
    select s.model_id, s.input from ai_step s
    where s.run_id = r.ai_run_id and s.status = 'accepted' and s.kind = 'model'
      and (s.output -> 'fieldIds' @> jsonb_build_array(ff.field_id::text)
        or strpos(s.input ->> 'user', '{"key":' || to_jsonb(fd.key)::text) > 0)
    order by (s.output -> 'fieldIds' @> jsonb_build_array(ff.field_id::text)) desc nulls last, s.created_at
    limit 1
  ) st on true
  where r.decision = 'rejected'
    and (r.rejected_via = 'review' or r.rejection_reason not in ('outdated', 'entity_removed'))
    and r.decided_at > now() - interval '${days} days'
) x`;

async function main() {
  const { slack, channel } = await openBotDm();
  const rows = (JSON.parse(await withProdDb((query) => query(SQL))) as RawRow[]).map(toTrace);

  const exportedAt = new Date().toISOString();
  await slack.files.uploadV2({
    channel_id: channel,
    filename: `rejected-fields-${exportedAt.slice(0, 10)}.json`,
    title: "Rejected AI suggestions (prod export)",
    content: JSON.stringify({ exportedAt, days, rows }),
    initial_comment: `🗂️ Exported ${rows.length} rejected AI suggestion${rows.length === 1 ? "" : "s"} from the last ${days} days. The next agenda will include them.`,
  });
  console.log(`Uploaded ${rows.length} rows to your DM with the bot.`);
}

interface RawRow {
  prompt_field_line: string | null;
  prompt_instructions: string | null;
  evidence: { snippet: string | null }[] | null;
  [key: string]: unknown;
}

/** Keeps only this field's own instruction out of the prompt's INSTRUCTIONS block, and shortens long snippets. */
export function toTrace({ prompt_field_line, prompt_instructions, evidence, ...row }: RawRow) {
  return {
    ...row,
    prompt_field_line: prompt_field_line || null,
    prompt_instruction: fieldInstruction(prompt_field_line, prompt_instructions),
    evidence: (evidence ?? []).map((e) => ({
      ...e,
      snippet: e.snippet && e.snippet.length > 600 ? `${e.snippet.slice(0, 600)}…` : e.snippet,
    })),
  };
}

/** `{"key":…,"instruction":"i3"}` + `[i1] …\n[i3] …` → the text of `[i3]`. */
export function fieldInstruction(fieldLine: string | null, block: string | null): string | null {
  const id = fieldLine?.match(/"instruction"\s*:\s*"([^"]+)"/)?.[1];
  if (!id || !block) return null;
  const start = block.indexOf(`[${id}]`);
  if (start < 0) return null;
  const rest = block.slice(start + id.length + 2);
  const next = rest.search(/\n\[[^\]\n]+\]/);
  return (next < 0 ? rest : rest.slice(0, next)).trim() || null;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
