-- Close the remaining operator-safety gaps in the recovery workflow.
--
-- The browser can only mutate workflow state through the audited RPCs. These
-- trigger checks remain database-level invariants so a future RPC cannot leave
-- a stale review schedule or claim that a message was sent on an unavailable
-- contact channel.

create or replace function public.sf_clear_lead_review_schedule()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog
as $$
begin
  -- A scheduled review belongs only to a lead that is still being watched.
  -- Explicit updates that keep or restore `watching` may set a new schedule.
  if new.status is distinct from old.status and new.status <> 'watching' then
    new.next_review_at := null;
  end if;
  return new;
end;
$$;

drop trigger if exists sf_lead_10_clear_review_schedule on public.sf_leads;
create trigger sf_lead_10_clear_review_schedule
before update of status on public.sf_leads
for each row execute function public.sf_clear_lead_review_schedule();

revoke all on function public.sf_clear_lead_review_schedule()
  from public, anon, authenticated;

create or replace function public.sf_guard_message_contact_channel()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  lead_phone text;
  lead_email text;
  lead_org uuid;
begin
  if new.status <> 'sent' then
    return new;
  end if;

  select lead.organization_id, lead.phone, lead.email
    into lead_org, lead_phone, lead_email
    from public.sf_leads lead
   where lead.id = new.lead_id;

  if lead_org is null or lead_org <> new.organization_id then
    raise exception using errcode = '23514', message = 'RELATED_RECORD_MISMATCH';
  end if;

  if new.channel is null
     or new.channel not in ('whatsapp', 'sms', 'email', 'other') then
    raise exception using errcode = '23514', message = 'INVALID_CHANNEL';
  end if;

  if new.channel in ('whatsapp', 'sms')
     and btrim(coalesce(lead_phone, '')) = '' then
    raise exception using errcode = '23514', message = 'CONTACT_CHANNEL_UNAVAILABLE';
  end if;

  if new.channel = 'email'
     and btrim(coalesce(lead_email, '')) = '' then
    raise exception using errcode = '23514', message = 'CONTACT_CHANNEL_UNAVAILABLE';
  end if;

  return new;
end;
$$;

drop trigger if exists sf_message_10_contact_channel on public.sf_messages;
create trigger sf_message_10_contact_channel
before insert or update
on public.sf_messages
for each row execute function public.sf_guard_message_contact_channel();

revoke all on function public.sf_guard_message_contact_channel()
  from public, anon, authenticated;

-- Dismiss a recommendation before a message has been prepared. Once a draft
-- exists the operator must use sf_snooze_recovery_message so message and lead
-- state are retired in the same transaction.
create or replace function public.sf_dismiss_recovery_recommendation(
  p_organization_id uuid,
  p_recommendation_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  actor_user_id uuid := auth.uid();
  recommendation_row public.sf_recommendations%rowtype;
  lead_row public.sf_leads%rowtype;
begin
  if actor_user_id is null or not exists (
    select 1
      from public.shuv_memberships membership
     where membership.organization_id = p_organization_id
       and membership.user_id = actor_user_id
       and membership.role in ('owner', 'admin', 'operator')
  ) then
    raise exception using errcode = '42501', message = 'ORGANIZATION_ACCESS_DENIED';
  end if;

  select * into recommendation_row
    from public.sf_recommendations
   where id = p_recommendation_id
     and organization_id = p_organization_id
   for update;
  if recommendation_row.id is null then
    raise exception using errcode = 'P0002', message = 'RECOMMENDATION_NOT_FOUND';
  end if;

  select * into lead_row
    from public.sf_leads
   where id = recommendation_row.lead_id
     and organization_id = p_organization_id
   for update;
  if lead_row.id is null
     or lead_row.organization_id <> recommendation_row.organization_id then
    raise exception using errcode = '23514', message = 'RELATED_RECORD_MISMATCH';
  end if;

  if recommendation_row.state <> 'review'
     or lead_row.status <> 'watching'
     or exists (
       select 1
         from public.sf_messages message
        where message.organization_id = p_organization_id
          and message.recommendation_id = recommendation_row.id
          and message.lead_id = lead_row.id
          and message.status in ('draft', 'copied', 'sent')
     ) then
    raise exception using errcode = '23514', message = 'RECOMMENDATION_NOT_DISMISSIBLE';
  end if;

  update public.sf_recommendations
     set state = 'dismissed'
   where id = recommendation_row.id
     and organization_id = p_organization_id
   returning * into recommendation_row;

  insert into public.sf_activity (organization_id, lead_id, action, details, actor_id)
  values (
    p_organization_id,
    lead_row.id,
    'recovery_recommendation_dismissed',
    jsonb_build_object('recommendation_id', recommendation_row.id),
    actor_user_id
  );

  return jsonb_build_object(
    'recommendation', to_jsonb(recommendation_row),
    'lead', to_jsonb(lead_row)
  );
end;
$$;

revoke all on function public.sf_dismiss_recovery_recommendation(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.sf_dismiss_recovery_recommendation(uuid, uuid)
  to authenticated;

-- A zero correction explicitly voids a previously confirmed amount while
-- preserving who confirmed it and when. The audit action distinguishes a
-- void from a positive correction.
create or replace function public.sf_correct_recovered_revenue(
  p_organization_id uuid,
  p_outcome_id uuid,
  p_revenue_minor bigint,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  actor_user_id uuid := auth.uid();
  lead_row public.sf_leads%rowtype;
  outcome_row public.sf_outcomes%rowtype;
  previous_revenue_minor bigint;
  audit_action text;
begin
  if actor_user_id is null or not exists (
    select 1
      from public.shuv_memberships membership
     where membership.organization_id = p_organization_id
       and membership.user_id = actor_user_id
       and membership.role in ('owner', 'admin', 'operator')
  ) then
    raise exception using errcode = '42501', message = 'ORGANIZATION_ACCESS_DENIED';
  end if;
  if p_revenue_minor is null or p_revenue_minor < 0 then
    raise exception using errcode = '22023', message = 'NON_NEGATIVE_REVENUE_REQUIRED';
  end if;
  if char_length(btrim(coalesce(p_reason, ''))) < 4
     or char_length(btrim(p_reason)) > 500 then
    raise exception using errcode = '22023', message = 'CORRECTION_REASON_REQUIRED';
  end if;

  select lead.* into lead_row
    from public.sf_leads lead
    join public.sf_outcomes outcome
      on outcome.lead_id = lead.id
     and outcome.organization_id = lead.organization_id
   where outcome.id = p_outcome_id
     and outcome.organization_id = p_organization_id
   for update of lead;
  if lead_row.id is null then
    raise exception using errcode = 'P0002', message = 'OUTCOME_NOT_FOUND';
  end if;

  select * into outcome_row
    from public.sf_outcomes
   where id = p_outcome_id
     and organization_id = p_organization_id
     and lead_id = lead_row.id
   for update;

  if lead_row.is_demo
     or lead_row.status <> 'closed'
     or outcome_row.status <> 'closed'
     or outcome_row.response_type <> 'interested'
     or outcome_row.revenue_minor is null
     or outcome_row.revenue_confirmed_at is null
     or outcome_row.revenue_confirmed_by is null then
    raise exception using errcode = '23514', message = 'CONFIRMED_REAL_REVENUE_REQUIRED';
  end if;

  previous_revenue_minor := outcome_row.revenue_minor;
  update public.sf_outcomes
     set revenue_minor = p_revenue_minor
   where id = outcome_row.id
     and organization_id = p_organization_id
   returning * into outcome_row;

  audit_action := case
    when p_revenue_minor = 0 then 'recovered_revenue_voided'
    else 'recovered_revenue_corrected'
  end;

  insert into public.sf_activity (organization_id, lead_id, action, details, actor_id)
  values (
    p_organization_id,
    lead_row.id,
    audit_action,
    jsonb_build_object(
      'outcome_id', outcome_row.id,
      'previous_revenue_minor', previous_revenue_minor,
      'new_revenue_minor', p_revenue_minor,
      'reason', btrim(p_reason)
    ),
    actor_user_id
  );

  return jsonb_build_object('lead', to_jsonb(lead_row), 'outcome', to_jsonb(outcome_row));
end;
$$;

revoke all on function public.sf_correct_recovered_revenue(uuid, uuid, bigint, text)
  from public, anon, authenticated;
grant execute on function public.sf_correct_recovered_revenue(uuid, uuid, bigint, text)
  to authenticated;
