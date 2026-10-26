/** SQL builders for the read-only prod queries behind a review pack (see gather.ts for the runner). */

/** Wraps a select so psql returns its rows as one JSON array. */
export const json = (body: string) => `select coalesce(json_agg(x), '[]') from (${body}) x`;

/** Evidence of a recommendation: transcript (with time), document page, photo, structured record. */
export const EVIDENCE = `(select coalesce(json_agg(json_build_object(
    'type', case eu.source_kind when 'transcript_utterance' then 'audio' when 'ocr_block' then 'document'
      when 'medication_photo' then 'photo' else coalesce(eu.source_kind, 'unresolved') end,
    'document', coalesce(fl.display_name, fl.original_name), 'page', eu.page_number, 'speaker', eu.speaker,
    'at', to_char(make_interval(secs => coalesce((e.c ->> 'startMs')::int, eu.start_ms) / 1000.0), 'HH24:MI:SS'),
    'photo', eu.visit_photo_id, 'snippet', e.c ->> 'snippet', 'text', left(eu.text, 1500)) order by e.ord), '[]'::json)
  from jsonb_array_elements(coalesce(r.evidence, '[]'::jsonb)) with ordinality as e(c, ord)
  left join evidence_unit eu on eu.id = (e.c ->> 'unitId')::uuid
  left join file fl on fl.id = eu.file_id)`;

/**
 * A user id (PropelAuth) → the person's name: their clinician row in the task's org, else their email signature,
 * else a case note they wrote; coders often have no clinician row. Falls back to the raw id so it's never blank.
 */
export const PERSON = (col: string) => `(case when ${col} is null then null else coalesce(
  (select coalesce(cl.linked_user_name, cl.name) || coalesce(' <' || cl.linked_user_email || '>', '')
    from clinician cl where cl.propel_auth_user_id = ${col}::text and cl.deleted_at is null
    order by (cl.organization_id = o.id) desc, cl.created_at desc limit 1),
  (select es.name || ' <' || es.email || '>' from user_email_signature es where es.user_id = ${col}::text limit 1),
  (select cn.created_by_user_name from case_note cn where cn.created_by_user_id::text = ${col}::text and cn.created_by_user_name is not null limit 1),
  'user ' || left(${col}::text, 8)) end)`;

/**
 * What each item is about, to find the passages in the evidence the AI saw that should have answered it.
 * Postgres and JS both accept these patterns (no \b — Postgres has no such word boundary).
 */
export const TOPICS: [prefix: string, pattern: string][] = [
  ["M1800", "groom|comb|brush|shav|teeth|denture|nails|makeup|make-up|wash face|washes face|wash hands|washes hands"],
  ["M1810", "dress|cloth|shirt|blouse|sweater|button|zipper|bra |gown"],
  ["M1820", "dress|cloth|pants|trouser|sock|shoe|slipper|underwear|brief"],
  ["M1830", "bath(?!room)|shower|tub |tubs|sponge|wash up|washes up|washing up|hygiene"],
  ["M1840", "toilet|commode|bedpan|urinal|bathroom|restroom"],
  ["M1845", "toilet|hygiene|incontinen|brief|wipe|perineal|pericare"],
  ["M1850", "transfer|out of bed|into bed|bed to chair|sit to stand|chair"],
  ["M1860", "walk|ambulat|walker|cane|wheelchair|gait|stairs|steps"],
  ["GG0130", "eat|feed|oral|teeth|toilet|shower|bath|dress|shoe|sock|footwear|hygiene"],
  ["GG0170", "transfer|walk|ambulat|wheelchair|stairs|steps|curb|car |chair|roll|sit|stand|pick up|bed"],
  ["M1033", "exhaust|fatigue|tired|weak|fall|hospital|emergency|medication"],
  ["M0090", "assessment|completed|visit date"],
];
export const TOPIC_ALL = TOPICS.map(([, p]) => `(${p})`).join("|");
/** The topic pattern of an item key, if one is configured. */
export const topicOf = (key: string) => TOPICS.find(([prefix]) => key.startsWith(prefix))?.[1];

/** Every query one visit needs for an issue, by name; `fields` is the issue's SQL predicate on `fd`. */
export function visitQueries(task: string, fields: string): Record<string, string> {
  const base = `from ai_recommendation r join task t on t.id = r.task_id
    left join clinician c on c.id = t.clinician_id left join organization o on o.id = c.organization_id
    join form_field ff on ff.id = r.form_field_id join field fd on fd.id = ff.field_id`;
  const step = `left join lateral (
      select s.id, s.model_id, s.step_key, s.input from ai_step s
      where s.run_id = r.ai_run_id and s.kind = 'model'
        and (s.output -> 'fieldIds' @> jsonb_build_array(ff.field_id::text)
          or strpos(s.input ->> 'user', '{"key":' || to_jsonb(fd.key)::text) > 0)
      order by (s.status = 'accepted') desc, s.created_at desc limit 1) st on true`;
  const recCols = `r.id, r.created_at, fd.key, fd.label, fd.section, r.value as ai_value, coalesce(r.basis, 'stated') as basis,
      r.decision, r.accepted_via, r.rejected_via, r.rejection_reason, r.decided_at, ${PERSON("r.decided_by")} as decided_by,
      st.model_id as model, st.step_key, st.id as step_id,
      split_part(substr(st.input ->> 'user', nullif(strpos(st.input ->> 'user', '{"key":' || to_jsonb(fd.key)::text), 0)), E'\\n', 1) as prompt_field_line,
      substring(st.input ->> 'user' from E'\\nINSTRUCTIONS\\n(.*?)\\n\\nOUTPUT CONTRACT') as prompt_instructions,
      ${EVIDENCE} as evidence,
      (select coalesce(json_agg(json_build_object('at', a.created_at, 'value', a.value, 'source', a.source,
          'by', ${PERSON("a.user_id")}, 'pushed_at', a.pushed_at, 'push_error', a.push_error) order by a.created_at), '[]')
        from answer a where a.task_id = r.task_id and a.form_field_id = r.form_field_id) as answers,
      (select coalesce(json_agg(json_build_object('at', fb.created_at, 'by', ${PERSON("fb.author_user_id")}, 'message', fb.message)), '[]')
        from field_feedback fb where fb.task_id = r.task_id and fb.form_field_id = r.form_field_id) as feedback`;
  return {
    task: json(`
      select t.id as task_id, t.case_id, v.id as visit_id, t.task as task_name, t.type, t.status, t.visit_date,
        o.name as organization, coalesce(c.linked_user_name, c.name) as clinician, c.linked_user_email as clinician_email,
        (select fm.name from ai_recommendation r join form_field ff on ff.id = r.form_field_id join form fm on fm.id = ff.form_id
          where r.task_id = t.id and r.form_field_id is not null limit 1) as form,
        concat('https://app.getlimeai.com/cases/', t.case_id, '?tab=visits&orgId=', o.id, '&visitId=', v.id, '&visitTab=form') as app_link,
        (select count(*) from visit_photo p where p.task_id = t.id) as photos
      from task t left join visit v on v.task_id = t.id
      left join clinician c on c.id = t.clinician_id left join organization o on o.id = c.organization_id
      where t.id = '${task}' limit 1`),
    runs: json(`select r.id, r.operation, r.status, r.created_at, r.latest_error from ai_run r where r.task_id = '${task}' order by r.created_at`),
    // Recordings: whether the transcript was translated is the non-English signal.
    audio: json(`
      select a.id, a.status, a.created_at, a.translated_transcript is not null as translated,
        coalesce(a.audio_metadata ->> 'language_code', a.audio_metadata ->> 'language') as language
      from audio a where a.entity_id in (select id from visit where task_id = '${task}') or a.entity_id = '${task}'
      order by a.created_at`),
    fields: json(`select ${recCols} ${base} ${step} where r.task_id = '${task}' and ${fields} order by fd.key, r.created_at`),
    // The issue's fields that have no AI suggestion at all (blank / abstained / never asked).
    unanswered: json(`
      select fd.key, fd.label, fd.section,
        (select json_agg(json_build_object('at', a.created_at, 'value', a.value, 'source', a.source, 'by', ${PERSON("a.user_id")}) order by a.created_at)
          from answer a where a.task_id = t.id and a.form_field_id = ff.id) as answers,
        (select json_agg(json_build_object('at', fb.created_at, 'by', ${PERSON("fb.author_user_id")}, 'message', fb.message) order by fb.created_at)
          from field_feedback fb where fb.task_id = t.id and fb.form_field_id = ff.id) as feedback
      from task t left join clinician c on c.id = t.clinician_id left join organization o on o.id = c.organization_id
      join form_field ff on ff.form_id = (select ff2.form_id from ai_recommendation r join form_field ff2 on ff2.id = r.form_field_id
          where r.task_id = t.id and r.form_field_id is not null limit 1)
      join field fd on fd.id = ff.field_id
      where t.id = '${task}' and ${fields}
        and not exists (select 1 from ai_recommendation r where r.task_id = t.id and r.form_field_id = ff.id)
      order by ff.group_sort, ff.sort`),
    // For the issue's fields without a suggestion: every model step that was asked for them, with the field's
    // prompt line, the INSTRUCTIONS block and what the step did with it (abstained / gated / document-only).
    no_suggestion_steps: json(`
      with keys as (
        select fd.key, ff.field_id::text as field_id
        from form_field ff join field fd on fd.id = ff.field_id
        where ff.form_id = (select ff2.form_id from ai_recommendation r join form_field ff2 on ff2.id = r.form_field_id
            where r.task_id = '${task}' and r.form_field_id is not null limit 1)
          and ${fields}
          and not exists (select 1 from ai_recommendation r where r.task_id = '${task}' and r.form_field_id = ff.id))
      select k.key, s.run_id, s.step_key, s.status, s.error, s.model_id as model, s.created_at,
        (select r.operation from ai_run r where r.id = s.run_id) as operation,
        (s.output ->> 'unresolvedCitations')::int as unresolved_citations,
        jsonb_array_length(coalesce(s.output -> 'rejectedHandles', '[]')) as rejected_handles,
        (select d from jsonb_array_elements(coalesce(s.output -> 'deferred', '[]')) d where d ->> 'key' = k.key limit 1) as deferred,
        split_part(substr(s.input ->> 'user', strpos(s.input ->> 'user', '{"key":' || to_jsonb(k.key)::text)), E'\\n', 1) as prompt_field_line,
        substring(s.input ->> 'user' from E'\\nINSTRUCTIONS\\n(.*?)\\n\\nOUTPUT CONTRACT') as prompt_instructions,
        coalesce(s.output -> 'abstained' ? k.field_id, false) as abstained,
        coalesce(s.output -> 'gated' ? k.key, false) as gated,
        coalesce(s.output -> 'documentOnlyFields' ? k.field_id, false) as document_only
      from keys k join ai_step s on s.run_id in (select id from ai_run where task_id = '${task}') and s.kind = 'model'
        and strpos(s.input ->> 'user', '{"key":' || to_jsonb(k.key)::text) > 0
      order by k.key, s.created_at`),
    // For the same fields: the passages in the evidence the AI was shown (its latest prompt for the field) that
    // mention the field's topic — what the visit actually said, so a reviewer can see why the AI held back.
    seen_evidence: json(`
      with keys as (
        select fd.key, ff.field_id::text as field_id
        from form_field ff join field fd on fd.id = ff.field_id
        where ff.form_id = (select ff2.form_id from ai_recommendation r join form_field ff2 on ff2.id = r.form_field_id
            where r.task_id = '${task}' and r.form_field_id is not null limit 1)
          and ${fields}
          and not exists (select 1 from ai_recommendation r where r.task_id = '${task}' and r.form_field_id = ff.id)),
      latest as (
        select distinct on (k.key) k.key, s.input
        from keys k join ai_step s on s.run_id in (select id from ai_run where task_id = '${task}') and s.kind = 'model'
          and strpos(s.input ->> 'user', '{"key":' || to_jsonb(k.key)::text) > 0
        order by k.key, s.created_at desc)
      select l.key, (h ->> 'h')::int as handle,
        case eu.source_kind when 'transcript_utterance' then 'audio' when 'ocr_block' then 'document'
          when 'medication_photo' then 'photo' else eu.source_kind end as type,
        coalesce(fl.display_name, fl.original_name) as document, eu.page_number as page, eu.speaker, eu.start_ms,
        to_char(make_interval(secs => coalesce(eu.start_ms, 0) / 1000.0), 'HH24:MI:SS') as at,
        eu.visit_photo_id as photo, eu.text
      from latest l cross join lateral jsonb_array_elements(coalesce(l.input -> 'handles', '[]')) h
      join evidence_unit eu on eu.id = (h ->> 'unitId')::uuid
      left join file fl on fl.id = eu.file_id
      where eu.text ~* '${TOPIC_ALL}'
      order by l.key, (eu.source_kind = 'transcript_utterance') desc, eu.start_ms, eu.page_number`),
    // Every other suggestion a coder rejected or overwrote on this visit.
    other_rejections: json(`
      select ${recCols} ${base} ${step}
      where r.task_id = '${task}' and r.decision = 'rejected' and not (${fields})
        and (r.rejected_via = 'review' or r.rejection_reason not in ('outdated', 'entity_removed'))
      order by r.decided_at desc`),
  };
}
