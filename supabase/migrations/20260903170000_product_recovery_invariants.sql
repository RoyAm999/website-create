-- Shuv Flow contact-safety invariants and transactional product transitions.
--
-- The browser may propose a match, but the database is the final authority for
-- "NO REASON. NO MESSAGE."  All customer-facing multi-row transitions below
-- execute as the caller (SECURITY INVOKER), remain subject to RLS, and also
-- perform an explicit organization-membership check.

-- "resolved" closes a message after the clinic records what happened.  The
-- sent timestamp/channel remain intact as audit history, while the lead is free
-- to receive a future recommendation only after a genuinely new reason exists.
alter table public.sf_messages
  drop constraint if exists sf_messages_status_check;
alter table public.sf_messages
  add constraint sf_messages_status_check
  check (status in ('draft', 'copied', 'sent', 'snoozed', 'resolved'));
alter table public.sf_messages
  drop constraint if exists sf_messages_resolved_was_sent;
alter table public.sf_messages
  add constraint sf_messages_resolved_was_sent
  check (status <> 'resolved' or sent_at is not null);

-- Medical content in a reply is not a sales-stage transition.  Keep it in a
-- dedicated blocked state so the UI can route it to a human medical reviewer.
alter table public.sf_leads
  drop constraint if exists sf_leads_status_check;
alter table public.sf_leads
  add constraint sf_leads_status_check
  check (status in (
    'watching', 'approval', 'waiting', 'interested', 'contacted', 'booked',
    'closed', 'not_now', 'no_reply', 'dnc', 'medical_review'
  ));

alter table public.sf_outcomes
  drop constraint if exists sf_outcomes_response_type_check;
alter table public.sf_outcomes
  add constraint sf_outcomes_response_type_check
  check (response_type is null or response_type in (
    'interested', 'not_now', 'no_reply', 'dnc', 'medical_review'
  ));

alter table public.sf_outcomes
  drop constraint if exists sf_outcomes_status_check;
alter table public.sf_outcomes
  add constraint sf_outcomes_status_check
  check (status in ('returned', 'booked', 'closed', 'lost', 'medical_review'));


-- A real imported lead may appear only once per clinic identity.  Demo rows
-- are intentionally excluded so the repeatable sample dataset stays isolated.
create unique index if not exists sf_leads_org_phone_identity_uq
  on public.sf_leads (
    organization_id,
    (
      case
        when regexp_replace(phone, '[^0-9]', '', 'g') like '00972%' then
          '0' || substr(regexp_replace(phone, '[^0-9]', '', 'g'), 6)
        when regexp_replace(phone, '[^0-9]', '', 'g') like '972%' then
          '0' || substr(regexp_replace(phone, '[^0-9]', '', 'g'), 4)
        else regexp_replace(phone, '[^0-9]', '', 'g')
      end
    )
  )
  where not is_demo
    and phone is not null
    and regexp_replace(phone, '[^0-9]', '', 'g') <> '';

create unique index if not exists sf_leads_org_email_identity_uq
  on public.sf_leads (organization_id, (lower(btrim(email))))
  where not is_demo
    and email is not null
    and btrim(email) <> '';

create or replace function public.sf_guard_recommendation()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  lead_row public.sf_leads%rowtype;
  change_row public.sf_changes%rowtype;
  clinic_timezone text;
  local_start timestamp;
  local_end timestamp;
  preference text;
  lead_branch text;
  change_branch text;
  timing_match text[];
  earliest_minutes integer;
  latest_minutes integer;
  requested_weekday integer;
  says_morning boolean;
  rejects_morning boolean;
  says_evening boolean;
  reason_aligned boolean := false;
  service_aligned boolean := false;
  branch_aligned boolean := false;
  time_aligned boolean := true;
begin
  select * into lead_row
  from public.sf_leads
  where id = new.lead_id;

  select * into change_row
  from public.sf_changes
  where id = new.change_id;

  if lead_row.id is null or change_row.id is null
     or lead_row.organization_id <> new.organization_id
     or change_row.organization_id <> new.organization_id then
    raise exception using errcode = '23514', message = 'RELATED_RECORD_MISMATCH';
  end if;

  -- Historical rows may be dismissed or expired for audit purposes.  A live
  -- recommendation, however, must pass every contact-safety check below.
  if new.state <> 'review' then
    return new;
  end if;

  if lead_row.dnc
     or lead_row.medical_escalation
     or lead_row.needs_fix
     or lead_row.stopped_reason_code = 'unknown'
     or lead_row.status <> 'watching' then
    raise exception using errcode = '23514', message = 'CONTACT_NOT_ALLOWED';
  end if;

  reason_aligned := case change_row.type
    when 'slot' then lead_row.stopped_reason_code in ('timing', 'availability')
    when 'availability' then lead_row.stopped_reason_code in ('timing', 'availability')
    when 'service' then lead_row.stopped_reason_code = 'service'
    when 'requested_date' then lead_row.stopped_reason_code = 'requested_date'
    when 'payment' then lead_row.stopped_reason_code in ('payment', 'price')
    else false
  end;

  if not reason_aligned then
    raise exception using errcode = '23514', message = 'REASON_CHANGE_MISMATCH';
  end if;

  -- Every service-specific event must name the service and match the lead.
  -- A requested-contact date applies to the individual lead, not a service.
  service_aligned := case
    when change_row.type = 'requested_date' then true
    else btrim(change_row.service) <> ''
      and lower(btrim(change_row.service)) = lower(btrim(lead_row.service))
  end;

  if not service_aligned then
    raise exception using errcode = '23514', message = 'SERVICE_MISMATCH';
  end if;

  -- A branch-specific lead or event must name the same branch on both sides.
  -- If the notes mention a branch but the structured branch is missing, the
  -- evidence is incomplete and the operator must fix the lead first.
  lead_branch := lower(coalesce(nullif(btrim(lead_row.branch), ''), ''));
  change_branch := lower(coalesce(nullif(btrim(change_row.branch), ''), ''));
  branch_aligned := not (
    (concat_ws(' ', lead_row.stopped_reason_text, lead_row.notes) ~* '(סניף|branch)' and lead_branch = '')
    or ((lead_branch <> '' or change_branch <> '') and (
      lead_branch = '' or change_branch = '' or lead_branch <> change_branch
    ))
  );

  if not branch_aligned then
    raise exception using errcode = '23514', message = 'BRANCH_MISMATCH';
  end if;

  clinic_timezone := coalesce(
    (select clinic.timezone
       from public.sf_clinics clinic
      where clinic.organization_id = new.organization_id),
    'Asia/Jerusalem'
  );

  if change_row.starts_at is not null then
    local_start := change_row.starts_at at time zone clinic_timezone;
  end if;
  if change_row.ends_at is not null then
    local_end := change_row.ends_at at time zone clinic_timezone;
  end if;

  if change_row.type = 'slot' then
    if change_row.starts_at is null
       or change_row.starts_at <= now()
       or new.expires_at is null
       or new.expires_at <= now()
       or new.expires_at > change_row.starts_at then
      raise exception using errcode = '23514', message = 'CHANGE_TIME_NOT_ACTIONABLE';
    end if;

  elsif change_row.type = 'availability' then
    if change_row.starts_at is null
       or change_row.ends_at is null
       or change_row.ends_at <= change_row.starts_at
       or change_row.ends_at - change_row.starts_at > interval '14 days'
       or change_row.ends_at <= now()
       or new.expires_at is null
       or new.expires_at <= now()
       or new.expires_at > change_row.ends_at then
      raise exception using errcode = '23514', message = 'CHANGE_TIME_NOT_ACTIONABLE';
    end if;
  end if;

  if change_row.type in ('slot', 'availability') then
    if lead_row.stopped_reason_code = 'availability'
       and concat_ws(' ', lead_row.stopped_reason_text, lead_row.notes) ~*
         '(בתאריך|תאריך[[:space:]]+שביקש|במועד|מועד[[:space:]]+שביקש|ביום[[:space:]]+שביקש|בשבוע[[:space:]]+שביקש|השבוע|בחודש[[:space:]]+שביקש|החודש|when[[:space:]]+requested|requested[[:space:]]+(date|day)|that[[:space:]]+(date|day))' then
      raise exception using errcode = '23514', message = 'MISSING_AVAILABILITY_CONSTRAINT';
    end if;

    if lead_row.stopped_reason_code = 'timing' then
      preference := lower(coalesce(nullif(btrim(lead_row.preferred_time), ''), lead_row.stopped_reason_text));
      says_morning := preference ~ 'בוקר';
      rejects_morning := preference ~ '(לא|אינה?|אין[[:space:]]+(לה|אפשרות))[^.]{0,24}בבוקר';
      says_evening := preference ~ '(ערב|אחרי[[:space:]]+העבודה)';

      requested_weekday := case
        when preference ~ '((יום[[:space:]]*)?ראשון|sunday)' then 0
        when preference ~ '((יום[[:space:]]*)?שני|monday)' then 1
        when preference ~ '((יום[[:space:]]*)?שלישי|tuesday)' then 2
        when preference ~ '((יום[[:space:]]*)?רביעי|wednesday)' then 3
        when preference ~ '((יום[[:space:]]*)?חמישי|thursday)' then 4
        when preference ~ '((יום[[:space:]]*)?שישי|friday)' then 5
        when preference ~ '(שבת|saturday)' then 6
        else null
      end;

      timing_match := regexp_match(
        preference,
        '(אחרי|החל[[:space:]]*מ|לא[[:space:]]*לפני|מ(שעה|־|-)?)[[:space:]:]*([0-9]{1,2})(:([0-9]{2}))?'
      );
      if timing_match is not null then
        earliest_minutes := timing_match[3]::integer * 60 + coalesce(timing_match[5]::integer, 0);
      end if;

      if preference !~ 'לא[[:space:]]*לפני' then
        timing_match := regexp_match(
          preference,
          '(לפני|עד)[[:space:]:]*([0-9]{1,2})(:([0-9]{2}))?'
        );
        if timing_match is not null then
          latest_minutes := timing_match[2]::integer * 60 + coalesce(timing_match[4]::integer, 0);
        end if;
      end if;

      timing_match := regexp_match(
        preference,
        '(בשעה|בשעות|ב־|ב-)[[:space:]]*([0-9]{1,2})(:([0-9]{2}))?'
      );
      if timing_match is not null then
        earliest_minutes := timing_match[2]::integer * 60 + coalesce(timing_match[4]::integer, 0);
        latest_minutes := earliest_minutes;
      end if;

      if earliest_minutes is null and latest_minutes is null then
        if says_evening then
          earliest_minutes := 17 * 60;
        elsif says_morning and not rejects_morning then
          earliest_minutes := 6 * 60;
          latest_minutes := 12 * 60;
        elsif preference ~ '(צהריים|אחר[[:space:]]*הצהריים)' then
          earliest_minutes := 12 * 60;
          latest_minutes := 17 * 60;
        end if;
      end if;

      if (says_morning and not rejects_morning and says_evening)
         or (earliest_minutes is not null and earliest_minutes > 1439)
         or (latest_minutes is not null and latest_minutes > 1439)
         or (earliest_minutes is not null and latest_minutes is not null and earliest_minutes > latest_minutes)
         or (requested_weekday is null and earliest_minutes is null and latest_minutes is null) then
        time_aligned := false;
      else
        select exists (
          select 1
          from (
            select sample_at
            from generate_series(
              change_row.starts_at,
              coalesce(change_row.ends_at, change_row.starts_at),
              interval '15 minutes'
            ) as samples(sample_at)
            union all
            select coalesce(change_row.ends_at, change_row.starts_at)
          ) candidate
          where (requested_weekday is null or extract(dow from candidate.sample_at at time zone clinic_timezone) = requested_weekday)
            and (
              earliest_minutes is null
              or extract(hour from candidate.sample_at at time zone clinic_timezone)::integer * 60
                   + extract(minute from candidate.sample_at at time zone clinic_timezone)::integer >= earliest_minutes
            )
            and (
              latest_minutes is null
              or extract(hour from candidate.sample_at at time zone clinic_timezone)::integer * 60
                   + extract(minute from candidate.sample_at at time zone clinic_timezone)::integer <= latest_minutes
            )
        ) into time_aligned;
      end if;
    end if;
  elsif change_row.type = 'requested_date' then
    if change_row.starts_at is null
       or lead_row.requested_contact_after is null
       or lead_row.requested_contact_after > local_start::date
       or local_start::date > (now() at time zone clinic_timezone)::date then
      time_aligned := false;
    end if;
  elsif change_row.type in ('service', 'payment') then
    if char_length(btrim(change_row.details)) < 4
       or lower(btrim(change_row.details)) = lower(btrim(change_row.title)) then
      raise exception using errcode = '23514', message = 'CHANGE_DETAILS_NOT_CONCRETE';
    end if;
  end if;

  if not time_aligned then
    raise exception using errcode = '23514', message = 'DATE_OR_TIME_MISMATCH';
  end if;

  -- The visible evidence must be traceable to the saved lead and business
  -- change rather than invented by the client.
  if btrim(new.then_text) <> btrim(lead_row.stopped_reason_text)
     or btrim(new.now_text) <> btrim(change_row.details)
     or btrim(new.why_text) = ''
     or btrim(new.suggested_message) = ''
     or position(btrim(new.now_text) in new.suggested_message) = 0
     or (new.expires_at is not null and new.expires_at <= now()) then
    raise exception using errcode = '23514', message = 'EVIDENCE_MISMATCH';
  end if;

  if change_row.type in ('service', 'payment') then
    if btrim(new.now_text) <> btrim(change_row.details) then
      raise exception using errcode = '23514', message = 'EVIDENCE_MISMATCH';
    end if;
  elsif change_row.type = 'slot' then
    if position(btrim(change_row.title) || ':' in btrim(new.now_text)) <> 1
       or position(to_char(local_start, 'FMDD.FMMM') in new.now_text) = 0
       or position(to_char(local_start, 'HH24:MI') in new.now_text) = 0 then
      raise exception using errcode = '23514', message = 'EVIDENCE_MISMATCH';
    end if;
  elsif change_row.type = 'requested_date' then
    -- Requested-contact evidence is deliberately date-only.  A fabricated
    -- hour would imply an appointment slot that does not exist.
    if position(btrim(change_row.title) || ':' in btrim(new.now_text)) <> 1
       or position(to_char(local_start, 'FMDD.FMMM') in new.now_text) = 0
       or position(to_char(local_start, 'YYYY') in new.now_text) = 0 then
      raise exception using errcode = '23514', message = 'EVIDENCE_MISMATCH';
    end if;
  elsif change_row.type = 'availability' then
    if position(btrim(change_row.title) || ':' in btrim(new.now_text)) <> 1
       or position(to_char(local_start, 'FMDD.FMMM') in new.now_text) = 0
       or position(to_char(local_start, 'HH24:MI') in new.now_text) = 0
       or position('עד' in new.now_text) = 0
       or position(to_char(local_end, 'FMDD.FMMM') in new.now_text) = 0
       or position(to_char(local_end, 'HH24:MI') in new.now_text) = 0 then
      raise exception using errcode = '23514', message = 'EVIDENCE_MISMATCH';
    end if;
  end if;

  return new;
end;
$$;

create or replace function public.sf_guard_message()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  recommendation_row public.sf_recommendations%rowtype;
  lead_row public.sf_leads%rowtype;
  change_row public.sf_changes%rowtype;
begin
  -- Once a message was marked sent it is immutable audit evidence.  The only
  -- later transition is sent -> resolved after the clinic records an outcome.
  if tg_op = 'UPDATE' and old.status in ('sent', 'resolved') and (
    new.organization_id is distinct from old.organization_id
    or new.recommendation_id is distinct from old.recommendation_id
    or new.lead_id is distinct from old.lead_id
    or new.body is distinct from old.body
    or new.channel is distinct from old.channel
    or new.copied_at is distinct from old.copied_at
    or new.sent_at is distinct from old.sent_at
    or (old.status = 'sent' and new.status not in ('sent', 'resolved'))
    or (old.status = 'resolved' and new.status <> 'resolved')
  ) then
    raise exception using errcode = '23514', message = 'SENT_MESSAGE_IMMUTABLE';
  end if;

  select * into recommendation_row
  from public.sf_recommendations
  where id = new.recommendation_id;

  if recommendation_row.id is not null then
    select * into lead_row
    from public.sf_leads
    where id = recommendation_row.lead_id;

    select * into change_row
    from public.sf_changes
    where id = recommendation_row.change_id;
  end if;

  if recommendation_row.id is null
     or lead_row.id is null
     or change_row.id is null
     or recommendation_row.organization_id <> new.organization_id
     or lead_row.organization_id <> new.organization_id
     or change_row.organization_id <> new.organization_id
     or recommendation_row.lead_id <> new.lead_id then
    raise exception using errcode = '23514', message = 'RELATED_RECORD_MISMATCH';
  end if;

  -- A snoozed row is retained only as an audit record.  Any message that can
  -- still be copied or marked sent must have a safe lead and a live reason.
  if new.status in ('draft', 'copied', 'sent') and (
    lead_row.dnc
    or lead_row.medical_escalation
    or lead_row.needs_fix
    or lead_row.stopped_reason_code = 'unknown'
    or recommendation_row.state <> 'review'
    or (recommendation_row.expires_at is not null and recommendation_row.expires_at <= now())
    or (
      (
        (change_row.type = 'slot' and change_row.starts_at <= now())
        or (change_row.type = 'availability' and change_row.ends_at <= now())
      )
    )
    or (new.status = 'draft' and lead_row.status not in ('watching', 'approval'))
    or (new.status = 'copied' and lead_row.status <> 'approval')
    or (new.status = 'sent' and lead_row.status not in ('approval', 'waiting'))
  ) then
    raise exception using errcode = '23514', message = 'CONTACT_NOT_ALLOWED';
  end if;

  return new;
end;
$$;

drop trigger if exists sf_recommendation_guard on public.sf_recommendations;
create trigger sf_recommendation_guard
before insert or update on public.sf_recommendations
for each row execute function public.sf_guard_recommendation();

drop trigger if exists sf_message_guard on public.sf_messages;
create trigger sf_message_guard
before insert or update on public.sf_messages
for each row execute function public.sf_guard_message();

-- Derive irreversible safety flags from the lead's free text.  This runs before
-- the contact-safety trigger (trigger names sort alphabetically), so a client
-- that omits medical_escalation or dnc still cannot make the lead matchable.
create or replace function public.sf_derive_lead_safety()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  safety_text text := lower(concat_ws(
    ' ', new.stopped_reason_text, new.notes, new.response_text
  ));
  medical_signal boolean;
  no_contact_signal boolean;
begin
  medical_signal := safety_text ~
      '(רפואי|רפואית|בהריון|בהיריון|הריון|היריון|הרה|כאב|כאבים|כואב|תרופה|תרופות|תרופתי|אנטיביוטיקה|מדלל(י)?[[:space:]]*דם|סיבוך|סיבוכים|דימום|זיהום|נפיחות|אלרג|תגובה[[:space:]]*חריגה)'
    or safety_text ~
      '(^|[^[:alpha:]])(pregnant|pregnancy|pain|painful|medication|medicine|antibiotic|blood[[:space:]]*thinner|complication|bleeding|infection|swelling|allergy|allergic|adverse[[:space:]]*reaction)([^[:alpha:]]|$)';
  no_contact_signal := safety_text ~
    '(לא[[:space:]]+ליצור[[:space:]]+קשר|אל[[:space:]]+תיצרו[[:space:]]+קשר|לא[[:space:]]+לפנות|אל[[:space:]]+תפנו|ביקש(ה)?[[:space:]]+שלא[[:space:]]+(נפנה|ליצור[[:space:]]+קשר)|הסר[[:space:]]+אותי|הסירו[[:space:]]+אותי|להסיר[[:space:]]+אותי|הסרה[[:space:]]+מרשימת|do[[:space:]]+not[[:space:]]+contact|don''t[[:space:]]+contact|unsubscribe|opt[[:space:]-]*out|stop[[:space:]]+(message|messages|messaging|contact))';

  if tg_op = 'UPDATE' then
    new.medical_escalation := old.medical_escalation
      or coalesce(new.medical_escalation, false)
      or medical_signal;
    new.dnc := old.dnc or coalesce(new.dnc, false) or no_contact_signal;
  else
    new.medical_escalation := coalesce(new.medical_escalation, false) or medical_signal;
    new.dnc := coalesce(new.dnc, false) or no_contact_signal;
  end if;

  if new.dnc then
    new.status := 'dnc';
  elsif new.medical_escalation
        and new.status in ('watching', 'approval', 'waiting', 'interested', 'contacted') then
    new.status := 'medical_review';
  end if;
  return new;
end;
$$;

drop trigger if exists sf_lead_00_derive_safety on public.sf_leads;
create trigger sf_lead_00_derive_safety
before insert or update on public.sf_leads
for each row execute function public.sf_derive_lead_safety();

-- If a lead's safety or matching inputs change after a draft was prepared,
-- retire the old recommendation and make every unsent message non-actionable.
create or replace function public.sf_sync_lead_contact_safety()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  contact_blocked boolean;
begin
  contact_blocked := new.dnc
    or new.medical_escalation
    or new.needs_fix
    or new.stopped_reason_code = 'unknown';

  if new.dnc then
    new.status := 'dnc';
  end if;

  if new.dnc is distinct from old.dnc
     or new.medical_escalation is distinct from old.medical_escalation
     or new.needs_fix is distinct from old.needs_fix
     or new.stopped_reason_code is distinct from old.stopped_reason_code
     or new.stopped_reason_text is distinct from old.stopped_reason_text
     or new.notes is distinct from old.notes
     or new.response_text is distinct from old.response_text
     or new.service is distinct from old.service
     or new.branch is distinct from old.branch
     or new.preferred_time is distinct from old.preferred_time
     or new.requested_contact_after is distinct from old.requested_contact_after then
    -- Unsent copy must always be rebuilt from the new evidence.  A sent message
    -- remains trackable after a benign correction, but is closed immediately
    -- when the lead has become unsafe for sales handling.
    update public.sf_messages
       set status = case when status = 'sent' then 'resolved' else 'snoozed' end
     where organization_id = new.organization_id
       and lead_id = new.id
       and (
         status in ('draft', 'copied')
         or (contact_blocked and status = 'sent')
       );

    update public.sf_recommendations
       set state = 'dismissed'
     where organization_id = new.organization_id
       and lead_id = new.id
       and state = 'review';

    if not new.dnc
       and not new.medical_escalation
       and (
         new.status = 'approval'
         or (contact_blocked and new.status = 'waiting')
       ) then
      new.status := 'watching';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists sf_lead_dnc_guard on public.sf_leads;
drop trigger if exists sf_lead_contact_safety on public.sf_leads;
create trigger sf_lead_contact_safety
before update of dnc, medical_escalation, needs_fix, stopped_reason_code,
  stopped_reason_text, notes, response_text, service, branch, preferred_time,
  requested_contact_after
on public.sf_leads
for each row execute function public.sf_sync_lead_contact_safety();

-- Changing the underlying business fact invalidates existing matches; they
-- must be recalculated rather than silently reusing stale evidence.
create or replace function public.sf_sync_change_contact_safety()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
begin
  update public.sf_messages message
     set status = 'snoozed'
    from public.sf_recommendations recommendation
   where recommendation.organization_id = new.organization_id
     and recommendation.change_id = new.id
     and recommendation.state = 'review'
     and message.organization_id = recommendation.organization_id
     and message.recommendation_id = recommendation.id
     and message.status in ('draft', 'copied');

  update public.sf_leads lead
     set status = 'watching'
    from public.sf_recommendations recommendation
   where recommendation.organization_id = new.organization_id
     and recommendation.change_id = new.id
     and recommendation.state = 'review'
     and lead.organization_id = recommendation.organization_id
     and lead.id = recommendation.lead_id
     and lead.status = 'approval';

  update public.sf_recommendations
     set state = 'dismissed'
   where organization_id = new.organization_id
     and change_id = new.id
     and state = 'review';
  return new;
end;
$$;

drop trigger if exists sf_change_contact_safety on public.sf_changes;
create trigger sf_change_contact_safety
after update of type, service, branch, starts_at, ends_at, title, details
on public.sf_changes
for each row
when (
  old.type is distinct from new.type
  or old.service is distinct from new.service
  or old.branch is distinct from new.branch
  or old.starts_at is distinct from new.starts_at
  or old.ends_at is distinct from new.ends_at
  or old.title is distinct from new.title
  or old.details is distinct from new.details
)
execute function public.sf_sync_change_contact_safety();

-- When a recommendation is explicitly dismissed/expired, immediately hide
-- its unsent drafts.  Sent messages remain immutable history.
create or replace function public.sf_sync_recommendation_contact_safety()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
begin
  if new.state <> 'review'
     or (new.expires_at is not null and new.expires_at <= now()) then
    update public.sf_messages
       set status = 'snoozed'
     where organization_id = new.organization_id
       and recommendation_id = new.id
       and status in ('draft', 'copied');

    -- Skip the lead write when this recommendation update itself came from the
    -- lead's BEFORE trigger.  Updating the already-being-modified tuple would
    -- raise SQLSTATE 27000.  The lead trigger resets NEW.status directly.
    if pg_trigger_depth() = 1 then
      update public.sf_leads
         set status = 'watching'
       where organization_id = new.organization_id
         and id = new.lead_id
         and status = 'approval';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists sf_recommendation_contact_safety on public.sf_recommendations;
create trigger sf_recommendation_contact_safety
after update of state, expires_at on public.sf_recommendations
for each row execute function public.sf_sync_recommendation_contact_safety();

drop function if exists public.sf_sync_dnc();

-- Serialize recommendation creation per lead and retire time-expired reasons
-- before the partial unique index is checked.  This covers stale review rows
-- both with and without a prepared message; a still-live recommendation is
-- intentionally retained and the unique index refuses a competing focus.
create or replace function public.sf_reconcile_recommendation_focus()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  lead_row public.sf_leads%rowtype;
begin
  if new.state <> 'review' then
    return new;
  end if;

  select * into lead_row
  from public.sf_leads
  where id = new.lead_id
    and organization_id = new.organization_id
  for update;

  -- The relationship guard that follows emits the canonical error.  Returning
  -- here avoids dereferencing a missing lead in this serialization trigger.
  if lead_row.id is null then
    return new;
  end if;

  update public.sf_recommendations recommendation
     set state = 'expired'
    from public.sf_changes change
   where recommendation.organization_id = new.organization_id
     and recommendation.lead_id = new.lead_id
     and recommendation.state = 'review'
     and recommendation.id <> new.id
     and change.organization_id = recommendation.organization_id
     and change.id = recommendation.change_id
     and (
       (recommendation.expires_at is not null and recommendation.expires_at <= now())
       or (
         change.type = 'slot'
         and (
           change.starts_at is null
           or change.starts_at <= now()
         )
       )
       or (
         change.type = 'availability'
         and (
           change.starts_at is null
           or change.ends_at is null
           or change.ends_at <= change.starts_at
           or change.ends_at <= now()
         )
       )
     );

  -- The nested recommendation trigger snoozes stale draft/copied messages.  It
  -- deliberately cannot update this already-locked lead, so finish the reset
  -- here only when no other live approval remains.
  update public.sf_leads lead
     set status = 'watching'
   where lead.id = new.lead_id
     and lead.organization_id = new.organization_id
     and lead.status = 'approval'
     and not exists (
       select 1
       from public.sf_messages message
       join public.sf_recommendations recommendation
         on recommendation.id = message.recommendation_id
        and recommendation.organization_id = message.organization_id
      where message.organization_id = new.organization_id
        and message.lead_id = new.lead_id
        and message.status in ('draft', 'copied')
        and recommendation.state = 'review'
     );

  return new;
end;
$$;

drop trigger if exists sf_recommendation_00_reconcile_focus
  on public.sf_recommendations;
create trigger sf_recommendation_00_reconcile_focus
before insert on public.sf_recommendations
for each row execute function public.sf_reconcile_recommendation_focus();

create unique index if not exists sf_recommendations_one_review_per_lead_idx
  on public.sf_recommendations (lead_id)
  where state = 'review';

create unique index if not exists sf_messages_one_active_per_lead_idx
  on public.sf_messages (lead_id)
  where status in ('draft', 'copied', 'sent');

-- Prepare the approval task atomically.  This replaces the former browser
-- sequence (create draft, then update lead), which could leave a dead draft if
-- the second request failed.
create or replace function public.sf_prepare_recovery_message(
  p_organization_id uuid,
  p_recommendation_id uuid
)
returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  actor_user_id uuid := auth.uid();
  recommendation_row public.sf_recommendations%rowtype;
  change_row public.sf_changes%rowtype;
  lead_row public.sf_leads%rowtype;
  message_row public.sf_messages%rowtype;
begin
  if actor_user_id is null or not exists (
    select 1 from public.shuv_memberships membership
     where membership.organization_id = p_organization_id
       and membership.user_id = actor_user_id
       and membership.role in ('owner', 'admin', 'operator')
  ) then
    raise exception using errcode = '42501', message = 'ORGANIZATION_ACCESS_DENIED';
  end if;

  select * into recommendation_row
  from public.sf_recommendations
  where id = p_recommendation_id and organization_id = p_organization_id
  for update;
  if recommendation_row.id is null then
    raise exception using errcode = 'P0002', message = 'RECOMMENDATION_NOT_FOUND';
  end if;

  select * into change_row
  from public.sf_changes
  where id = recommendation_row.change_id and organization_id = p_organization_id
  for update;
  if change_row.id is null then
    raise exception using errcode = '23514', message = 'RELATED_RECORD_MISMATCH';
  end if;

  select * into lead_row
  from public.sf_leads
  where id = recommendation_row.lead_id and organization_id = p_organization_id
  for update;
  if lead_row.id is null then
    raise exception using errcode = '23514', message = 'RELATED_RECORD_MISMATCH';
  end if;

  if recommendation_row.state <> 'review'
     or (recommendation_row.expires_at is not null and recommendation_row.expires_at <= now())
     or (
       (
         (change_row.type = 'slot' and change_row.starts_at <= now())
         or (change_row.type = 'availability' and change_row.ends_at <= now())
       )
     )
     or lead_row.status not in ('watching', 'approval')
     or lead_row.dnc
     or lead_row.medical_escalation
     or lead_row.needs_fix
     or lead_row.stopped_reason_code = 'unknown' then
    raise exception using errcode = '23514', message = 'RECOMMENDATION_NOT_ACTIONABLE';
  end if;

  -- On first preparation, a no-op evidence update deliberately invokes the
  -- full recommendation guard under the locks above.  A retry may already be
  -- in approval; in that case the lead/change invalidation triggers guarantee
  -- the review row would already have been dismissed if its evidence changed.
  if lead_row.status = 'watching' then
    update public.sf_recommendations
       set why_text = recommendation_row.why_text
     where id = recommendation_row.id
     returning * into recommendation_row;
  end if;

  select * into message_row
  from public.sf_messages
  where recommendation_id = recommendation_row.id
    and organization_id = p_organization_id
    and lead_id = lead_row.id
  for update;

  if message_row.id is null then
    insert into public.sf_messages (
      organization_id, recommendation_id, lead_id, body, status
    ) values (
      p_organization_id,
      recommendation_row.id,
      lead_row.id,
      recommendation_row.suggested_message,
      'draft'
    )
    returning * into message_row;
  elsif message_row.status not in ('draft', 'copied') then
    raise exception using errcode = '23514', message = 'MESSAGE_NOT_PREPARABLE';
  else
    -- Re-run the message safety guard for drafts left by an interrupted older
    -- client before making them visible as an approval task.
    update public.sf_messages
       set body = message_row.body
     where id = message_row.id
     returning * into message_row;
  end if;

  update public.sf_leads
     set status = 'approval'
   where id = lead_row.id
   returning * into lead_row;
  if lead_row.status <> 'approval'
     or lead_row.dnc
     or lead_row.medical_escalation
     or lead_row.needs_fix
     or lead_row.stopped_reason_code = 'unknown' then
    raise exception using errcode = '23514', message = 'RECOMMENDATION_NOT_ACTIONABLE';
  end if;

  insert into public.sf_activity (organization_id, lead_id, action, details, actor_id)
  values (
    p_organization_id,
    lead_row.id,
    'recovery_message_prepared',
    jsonb_build_object('message_id', message_row.id, 'recommendation_id', recommendation_row.id),
    actor_user_id
  );

  return jsonb_build_object(
    'message', to_jsonb(message_row),
    'recommendation', to_jsonb(recommendation_row),
    'lead', to_jsonb(lead_row)
  );
end;
$$;

-- Transactionally snooze the message, dismiss its reason, and remove the
-- approval task from the lead.  No partial state is visible if any step fails.
create or replace function public.sf_snooze_recovery_message(
  p_organization_id uuid,
  p_message_id uuid
)
returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  actor_user_id uuid := auth.uid();
  message_row public.sf_messages%rowtype;
  recommendation_row public.sf_recommendations%rowtype;
  lead_row public.sf_leads%rowtype;
begin
  if actor_user_id is null or not exists (
    select 1 from public.shuv_memberships membership
     where membership.organization_id = p_organization_id
       and membership.user_id = actor_user_id
       and membership.role in ('owner', 'admin', 'operator')
  ) then
    raise exception using errcode = '42501', message = 'ORGANIZATION_ACCESS_DENIED';
  end if;

  select * into message_row
  from public.sf_messages
  where id = p_message_id and organization_id = p_organization_id
  for update;
  if message_row.id is null then
    raise exception using errcode = 'P0002', message = 'MESSAGE_NOT_FOUND';
  end if;
  if message_row.status not in ('draft', 'copied') then
    raise exception using errcode = '23514', message = 'MESSAGE_NOT_SNOOZABLE';
  end if;

  select * into recommendation_row
  from public.sf_recommendations
  where id = message_row.recommendation_id
    and organization_id = p_organization_id
    and lead_id = message_row.lead_id
  for update;
  if recommendation_row.id is null then
    raise exception using errcode = '23514', message = 'RELATED_RECORD_MISMATCH';
  end if;

  select * into lead_row
  from public.sf_leads
  where id = message_row.lead_id and organization_id = p_organization_id
  for update;
  if lead_row.id is null then
    raise exception using errcode = '23514', message = 'RELATED_RECORD_MISMATCH';
  end if;

  update public.sf_messages
     set status = 'snoozed'
   where id = message_row.id
   returning * into message_row;

  update public.sf_recommendations
     set state = 'dismissed'
   where id = recommendation_row.id
   returning * into recommendation_row;

  if lead_row.status = 'approval' then
    update public.sf_leads
       set status = 'watching'
     where id = lead_row.id
     returning * into lead_row;
  end if;

  insert into public.sf_activity (organization_id, lead_id, action, details, actor_id)
  values (
    p_organization_id,
    lead_row.id,
    'recovery_message_snoozed',
    jsonb_build_object('message_id', message_row.id, 'recommendation_id', recommendation_row.id),
    actor_user_id
  );

  return jsonb_build_object(
    'message', to_jsonb(message_row),
    'recommendation', to_jsonb(recommendation_row),
    'lead', to_jsonb(lead_row)
  );
end;
$$;

-- Marking sent is deliberately separate from copying/approving.  It requires
-- an approved (copied) message and moves the lead to waiting atomically.
create or replace function public.sf_mark_recovery_message_sent(
  p_organization_id uuid,
  p_message_id uuid,
  p_channel text
)
returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  actor_user_id uuid := auth.uid();
  message_row public.sf_messages%rowtype;
  recommendation_row public.sf_recommendations%rowtype;
  lead_row public.sf_leads%rowtype;
begin
  if actor_user_id is null or not exists (
    select 1 from public.shuv_memberships membership
     where membership.organization_id = p_organization_id
       and membership.user_id = actor_user_id
       and membership.role in ('owner', 'admin', 'operator')
  ) then
    raise exception using errcode = '42501', message = 'ORGANIZATION_ACCESS_DENIED';
  end if;

  if p_channel is null or p_channel not in ('whatsapp', 'sms', 'email', 'other') then
    raise exception using errcode = '22023', message = 'INVALID_CHANNEL';
  end if;

  select * into message_row
  from public.sf_messages
  where id = p_message_id and organization_id = p_organization_id
  for update;
  if message_row.id is null then
    raise exception using errcode = 'P0002', message = 'MESSAGE_NOT_FOUND';
  end if;
  if message_row.status <> 'copied' then
    raise exception using errcode = '23514', message = 'MESSAGE_NOT_APPROVED';
  end if;

  select * into recommendation_row
  from public.sf_recommendations
  where id = message_row.recommendation_id
    and organization_id = p_organization_id
    and lead_id = message_row.lead_id
  for update;
  if recommendation_row.id is null then
    raise exception using errcode = '23514', message = 'RELATED_RECORD_MISMATCH';
  end if;

  select * into lead_row
  from public.sf_leads
  where id = message_row.lead_id and organization_id = p_organization_id
  for update;
  if lead_row.id is null or lead_row.status <> 'approval' then
    raise exception using errcode = '23514', message = 'LEAD_NOT_AWAITING_APPROVAL';
  end if;
  if lead_row.dnc
     or lead_row.medical_escalation
     or lead_row.needs_fix
     or lead_row.stopped_reason_code = 'unknown' then
    raise exception using errcode = '23514', message = 'CONTACT_NOT_ALLOWED';
  end if;

  update public.sf_messages
     set status = 'sent', channel = p_channel, sent_at = now()
   where id = message_row.id
   returning * into message_row;

  update public.sf_leads
     set status = 'waiting'
   where id = lead_row.id
   returning * into lead_row;
  if lead_row.status <> 'waiting'
     or lead_row.dnc
     or lead_row.medical_escalation
     or lead_row.needs_fix
     or lead_row.stopped_reason_code = 'unknown' then
    raise exception using errcode = '23514', message = 'CONTACT_NOT_ALLOWED';
  end if;

  insert into public.sf_activity (organization_id, lead_id, action, details, actor_id)
  values (
    p_organization_id,
    lead_row.id,
    'recovery_message_sent',
    jsonb_build_object('message_id', message_row.id, 'channel', p_channel),
    actor_user_id
  );

  return jsonb_build_object(
    'message', to_jsonb(message_row),
    'recommendation', to_jsonb(recommendation_row),
    'lead', to_jsonb(lead_row)
  );
end;
$$;

-- Record the human-reported response together with the lead/outcome state.
create or replace function public.sf_record_recovery_response(
  p_organization_id uuid,
  p_message_id uuid,
  p_response_type text,
  p_response_text text default ''
)
returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  actor_user_id uuid := auth.uid();
  message_row public.sf_messages%rowtype;
  recommendation_row public.sf_recommendations%rowtype;
  lead_row public.sf_leads%rowtype;
  outcome_row public.sf_outcomes%rowtype;
  next_lead_status text;
  next_outcome_status text;
  effective_response_type text;
  normalized_response text := lower(coalesce(p_response_text, ''));
  response_medical_signal boolean;
  response_dnc_signal boolean;
begin
  if actor_user_id is null or not exists (
    select 1 from public.shuv_memberships membership
     where membership.organization_id = p_organization_id
       and membership.user_id = actor_user_id
       and membership.role in ('owner', 'admin', 'operator')
  ) then
    raise exception using errcode = '42501', message = 'ORGANIZATION_ACCESS_DENIED';
  end if;

  if p_response_type is null or p_response_type not in ('interested', 'not_now', 'no_reply', 'dnc') then
    raise exception using errcode = '22023', message = 'INVALID_RESPONSE_TYPE';
  end if;
  if p_response_type = 'interested' and btrim(coalesce(p_response_text, '')) = '' then
    raise exception using errcode = '22023', message = 'POSITIVE_RESPONSE_TEXT_REQUIRED';
  end if;

  response_medical_signal := normalized_response ~
      '(רפואי|רפואית|בהריון|בהיריון|הריון|היריון|הרה|כאב|כאבים|כואב|תרופה|תרופות|תרופתי|אנטיביוטיקה|מדלל(י)?[[:space:]]*דם|סיבוך|סיבוכים|דימום|זיהום|נפיחות|אלרג|תגובה[[:space:]]*חריגה)'
    or normalized_response ~
      '(^|[^[:alpha:]])(pregnant|pregnancy|pain|painful|medication|medicine|antibiotic|blood[[:space:]]*thinner|complication|bleeding|infection|swelling|allergy|allergic|adverse[[:space:]]*reaction)([^[:alpha:]]|$)';
  response_dnc_signal := normalized_response ~
    '(לא[[:space:]]+ליצור[[:space:]]+קשר|אל[[:space:]]+תיצרו[[:space:]]+קשר|לא[[:space:]]+לפנות|אל[[:space:]]+תפנו|ביקש(ה)?[[:space:]]+שלא[[:space:]]+(נפנה|ליצור[[:space:]]+קשר)|הסר[[:space:]]+אותי|הסירו[[:space:]]+אותי|להסיר[[:space:]]+אותי|הסרה[[:space:]]+מרשימת|do[[:space:]]+not[[:space:]]+contact|don''t[[:space:]]+contact|unsubscribe|opt[[:space:]-]*out|stop[[:space:]]+(message|messages|messaging|contact))';

  effective_response_type := case
    when p_response_type = 'dnc' or response_dnc_signal then 'dnc'
    when response_medical_signal then 'medical_review'
    else p_response_type
  end;

  select * into message_row
  from public.sf_messages
  where id = p_message_id and organization_id = p_organization_id
  for update;
  if message_row.id is null or message_row.status <> 'sent' then
    raise exception using errcode = '23514', message = 'SENT_MESSAGE_REQUIRED';
  end if;

  select recommendation.* into recommendation_row
  from public.sf_recommendations recommendation
  join public.sf_changes change
    on change.id = recommendation.change_id
   and change.organization_id = recommendation.organization_id
  where recommendation.id = message_row.recommendation_id
    and recommendation.organization_id = p_organization_id
    and recommendation.lead_id = message_row.lead_id
  for update of recommendation;
  if recommendation_row.id is null then
    raise exception using errcode = '23514', message = 'RELATED_RECORD_MISMATCH';
  end if;

  select * into lead_row
  from public.sf_leads
  where id = message_row.lead_id and organization_id = p_organization_id
  for update;
  if lead_row.id is null or lead_row.status <> 'waiting' then
    raise exception using errcode = '23514', message = 'LEAD_NOT_WAITING';
  end if;
  if (
    lead_row.dnc
    or lead_row.medical_escalation
    or lead_row.needs_fix
    or lead_row.stopped_reason_code = 'unknown'
  ) and effective_response_type not in ('dnc', 'medical_review') then
    raise exception using errcode = '23514', message = 'RECOVERY_RESPONSE_BLOCKED';
  end if;

  next_lead_status := case effective_response_type
    when 'interested' then 'interested'
    when 'not_now' then 'not_now'
    when 'no_reply' then 'no_reply'
    when 'medical_review' then 'medical_review'
    else 'dnc'
  end;
  next_outcome_status := case effective_response_type
    when 'interested' then 'returned'
    when 'medical_review' then 'medical_review'
    else 'lost'
  end;

  update public.sf_messages
     set status = 'resolved'
   where id = message_row.id
   returning * into message_row;

  update public.sf_recommendations
     set state = 'dismissed'
   where id = recommendation_row.id
   returning * into recommendation_row;

  update public.sf_leads
     set status = next_lead_status,
         dnc = (effective_response_type = 'dnc'),
         medical_escalation = medical_escalation
           or effective_response_type = 'medical_review',
         needs_fix = needs_fix or effective_response_type = 'medical_review',
         response_text = coalesce(p_response_text, '')
   where id = lead_row.id
   returning * into lead_row;

  insert into public.sf_outcomes (
    organization_id, lead_id, response_type, response_text, responded_at, status
  ) values (
    p_organization_id, lead_row.id, effective_response_type,
    coalesce(p_response_text, ''), now(), next_outcome_status
  )
  on conflict (lead_id) do update
     set response_type = excluded.response_type,
         response_text = excluded.response_text,
         responded_at = excluded.responded_at,
         contacted_at = null,
         booked_at = null,
         closed_at = null,
         status = excluded.status,
         revenue_minor = null,
         revenue_confirmed_at = null,
         revenue_confirmed_by = null,
         updated_at = now()
  returning * into outcome_row;

  insert into public.sf_activity (organization_id, lead_id, action, details, actor_id)
  values (
    p_organization_id,
    lead_row.id,
    'recovery_response_recorded',
    jsonb_build_object(
      'message_id', message_row.id,
      'response_type', effective_response_type,
      'requires_medical_review', effective_response_type = 'medical_review'
    ),
    actor_user_id
  );

  return jsonb_build_object(
    'message', to_jsonb(message_row),
    'recommendation', to_jsonb(recommendation_row),
    'lead', to_jsonb(lead_row),
    'outcome', to_jsonb(outcome_row),
    'requires_medical_review', effective_response_type = 'medical_review'
  );
end;
$$;

-- Advance only through legal human-confirmed stages.  Each action updates the
-- lead and its outcome in the same transaction.
create or replace function public.sf_advance_recovery_lead(
  p_organization_id uuid,
  p_lead_id uuid,
  p_action text
)
returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  actor_user_id uuid := auth.uid();
  lead_row public.sf_leads%rowtype;
  outcome_row public.sf_outcomes%rowtype;
  expected_status text;
begin
  if actor_user_id is null or not exists (
    select 1 from public.shuv_memberships membership
     where membership.organization_id = p_organization_id
       and membership.user_id = actor_user_id
       and membership.role in ('owner', 'admin', 'operator')
  ) then
    raise exception using errcode = '42501', message = 'ORGANIZATION_ACCESS_DENIED';
  end if;

  if p_action is null or p_action not in ('contacted', 'booked', 'closed', 'not_now') then
    raise exception using errcode = '22023', message = 'INVALID_RECOVERY_ACTION';
  end if;

  select * into lead_row
  from public.sf_leads
  where id = p_lead_id and organization_id = p_organization_id
  for update;
  if lead_row.id is null then
    raise exception using errcode = 'P0002', message = 'LEAD_NOT_FOUND';
  end if;
  if lead_row.dnc
     or lead_row.medical_escalation
     or lead_row.needs_fix
     or lead_row.stopped_reason_code = 'unknown' then
    raise exception using errcode = '23514', message = 'RECOVERY_PROGRESS_BLOCKED';
  end if;

  select * into outcome_row
  from public.sf_outcomes
  where lead_id = lead_row.id and organization_id = p_organization_id
  for update;
  if outcome_row.id is null then
    raise exception using errcode = 'P0002', message = 'OUTCOME_NOT_FOUND';
  end if;
  if outcome_row.response_type <> 'interested'
     or outcome_row.responded_at is null then
    raise exception using errcode = '23514', message = 'INVALID_RECOVERY_TRANSITION';
  end if;

  if p_action = 'contacted' then
    if lead_row.status <> 'interested' or outcome_row.status <> 'returned' then
      raise exception using errcode = '23514', message = 'INVALID_RECOVERY_TRANSITION';
    end if;
    update public.sf_leads set status = 'contacted' where id = lead_row.id returning * into lead_row;
    update public.sf_outcomes
       set status = 'returned', contacted_at = coalesce(contacted_at, now())
     where id = outcome_row.id returning * into outcome_row;
  elsif p_action = 'booked' then
    if lead_row.status <> 'contacted' or outcome_row.contacted_at is null then
      raise exception using errcode = '23514', message = 'INVALID_RECOVERY_TRANSITION';
    end if;
    update public.sf_leads set status = 'booked' where id = lead_row.id returning * into lead_row;
    update public.sf_outcomes
       set status = 'booked', booked_at = coalesce(booked_at, now())
     where id = outcome_row.id returning * into outcome_row;
  elsif p_action = 'closed' then
    if lead_row.status <> 'booked' or outcome_row.booked_at is null then
      raise exception using errcode = '23514', message = 'INVALID_RECOVERY_TRANSITION';
    end if;
    update public.sf_leads set status = 'closed' where id = lead_row.id returning * into lead_row;
    update public.sf_outcomes
       set status = 'closed', closed_at = coalesce(closed_at, now())
     where id = outcome_row.id returning * into outcome_row;
  else
    if lead_row.status not in ('interested', 'contacted')
       or outcome_row.status <> 'returned' then
      raise exception using errcode = '23514', message = 'INVALID_RECOVERY_TRANSITION';
    end if;
    update public.sf_leads set status = 'not_now' where id = lead_row.id returning * into lead_row;
    update public.sf_outcomes
       set status = 'lost'
     where id = outcome_row.id returning * into outcome_row;
  end if;

  expected_status := case p_action
    when 'contacted' then 'contacted'
    when 'booked' then 'booked'
    when 'closed' then 'closed'
    else 'not_now'
  end;

  if lead_row.status <> expected_status
     or lead_row.dnc
     or lead_row.medical_escalation
     or lead_row.needs_fix
     or lead_row.stopped_reason_code = 'unknown' then
    raise exception using errcode = '23514', message = 'RECOVERY_PROGRESS_BLOCKED';
  end if;

  insert into public.sf_activity (organization_id, lead_id, action, details, actor_id)
  values (
    p_organization_id,
    lead_row.id,
    'recovery_lead_advanced',
    jsonb_build_object('action', p_action),
    actor_user_id
  );

  return jsonb_build_object('lead', to_jsonb(lead_row), 'outcome', to_jsonb(outcome_row));
end;
$$;

-- Revenue is never inferred.  It can only be confirmed for a closed outcome
-- by the authenticated operator who performs this explicit RPC call.
create or replace function public.sf_confirm_recovered_revenue(
  p_organization_id uuid,
  p_lead_id uuid,
  p_revenue_minor bigint,
  p_currency text default 'ILS'
)
returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  actor_user_id uuid := auth.uid();
  lead_row public.sf_leads%rowtype;
  outcome_row public.sf_outcomes%rowtype;
  safe_currency text := upper(btrim(coalesce(p_currency, '')));
begin
  if actor_user_id is null or not exists (
    select 1 from public.shuv_memberships membership
     where membership.organization_id = p_organization_id
       and membership.user_id = actor_user_id
       and membership.role in ('owner', 'admin', 'operator')
  ) then
    raise exception using errcode = '42501', message = 'ORGANIZATION_ACCESS_DENIED';
  end if;

  if p_revenue_minor is null or p_revenue_minor <= 0 then
    raise exception using errcode = '22023', message = 'POSITIVE_REVENUE_REQUIRED';
  end if;
  if safe_currency !~ '^[A-Z]{3}$' then
    raise exception using errcode = '22023', message = 'INVALID_CURRENCY';
  end if;

  select * into lead_row
  from public.sf_leads
  where id = p_lead_id and organization_id = p_organization_id
  for update;
  if lead_row.id is null or lead_row.status <> 'closed' then
    raise exception using errcode = '23514', message = 'CLOSED_LEAD_REQUIRED';
  end if;
  if lead_row.dnc
     or lead_row.medical_escalation
     or lead_row.needs_fix
     or lead_row.stopped_reason_code = 'unknown' then
    raise exception using errcode = '23514', message = 'RECOVERY_PROGRESS_BLOCKED';
  end if;

  select * into outcome_row
  from public.sf_outcomes
  where lead_id = lead_row.id and organization_id = p_organization_id
  for update;
  if outcome_row.id is null
     or outcome_row.status <> 'closed'
     or outcome_row.closed_at is null
     or outcome_row.response_type <> 'interested'
     or outcome_row.responded_at is null then
    raise exception using errcode = '23514', message = 'CLOSED_OUTCOME_REQUIRED';
  end if;

  update public.sf_outcomes
     set revenue_minor = p_revenue_minor,
         currency = safe_currency,
         revenue_confirmed_at = now(),
         revenue_confirmed_by = actor_user_id
   where id = outcome_row.id
   returning * into outcome_row;

  insert into public.sf_activity (organization_id, lead_id, action, details, actor_id)
  values (
    p_organization_id,
    lead_row.id,
    'recovered_revenue_confirmed',
    jsonb_build_object('revenue_minor', p_revenue_minor, 'currency', safe_currency),
    actor_user_id
  );

  return jsonb_build_object('lead', to_jsonb(lead_row), 'outcome', to_jsonb(outcome_row));
end;
$$;

-- Trigger functions execute only through their triggers.  Product RPCs are
-- callable only by authenticated users and remain constrained by RLS.
revoke all on function public.sf_guard_recommendation() from public, anon, authenticated;
revoke all on function public.sf_guard_message() from public, anon, authenticated;
revoke all on function public.sf_derive_lead_safety() from public, anon, authenticated;
revoke all on function public.sf_sync_lead_contact_safety() from public, anon, authenticated;
revoke all on function public.sf_sync_change_contact_safety() from public, anon, authenticated;
revoke all on function public.sf_sync_recommendation_contact_safety() from public, anon, authenticated;
revoke all on function public.sf_reconcile_recommendation_focus() from public, anon, authenticated;

revoke all on function public.sf_prepare_recovery_message(uuid, uuid) from public, anon, authenticated;
revoke all on function public.sf_snooze_recovery_message(uuid, uuid) from public, anon, authenticated;
revoke all on function public.sf_mark_recovery_message_sent(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.sf_record_recovery_response(uuid, uuid, text, text) from public, anon, authenticated;
revoke all on function public.sf_advance_recovery_lead(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.sf_confirm_recovered_revenue(uuid, uuid, bigint, text) from public, anon, authenticated;

grant execute on function public.sf_prepare_recovery_message(uuid, uuid) to authenticated;
grant execute on function public.sf_snooze_recovery_message(uuid, uuid) to authenticated;
grant execute on function public.sf_mark_recovery_message_sent(uuid, uuid, text) to authenticated;
grant execute on function public.sf_record_recovery_response(uuid, uuid, text, text) to authenticated;
grant execute on function public.sf_advance_recovery_lead(uuid, uuid, text) to authenticated;
grant execute on function public.sf_confirm_recovered_revenue(uuid, uuid, bigint, text) to authenticated;
