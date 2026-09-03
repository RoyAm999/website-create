-- Do not offer a deferred follow-up after revenue was already confirmed.

create or replace function public.sf_defer_recovery_progress(
  p_organization_id uuid,
  p_lead_id uuid,
  p_review_at timestamptz
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
  if p_review_at is null
     or p_review_at <= now()
     or p_review_at > now() + interval '90 days' then
    raise exception using errcode = '22023', message = 'INVALID_REVIEW_TIME';
  end if;

  select * into lead_row
    from public.sf_leads
   where id = p_lead_id
     and organization_id = p_organization_id
   for update;
  if lead_row.id is null then
    raise exception using errcode = 'P0002', message = 'LEAD_NOT_FOUND';
  end if;
  if lead_row.status not in ('interested', 'contacted', 'booked', 'closed')
     or lead_row.dnc
     or lead_row.medical_escalation
     or lead_row.needs_fix then
    raise exception using errcode = '23514', message = 'RECOVERY_PROGRESS_NOT_DEFERRABLE';
  end if;

  select * into outcome_row
    from public.sf_outcomes
   where lead_id = lead_row.id
     and organization_id = p_organization_id
   for update;
  if outcome_row.id is null
     or outcome_row.response_type <> 'interested'
     or outcome_row.responded_at is null
     or outcome_row.revenue_confirmed_at is not null then
    raise exception using errcode = '23514', message = 'RECOVERY_PROGRESS_NOT_DEFERRABLE';
  end if;

  update public.sf_leads
     set next_review_at = p_review_at
   where id = lead_row.id
   returning * into lead_row;

  insert into public.sf_activity (organization_id, lead_id, action, details, actor_id)
  values (
    p_organization_id,
    lead_row.id,
    'recovery_progress_deferred',
    jsonb_build_object('review_at', p_review_at),
    actor_user_id
  );

  return jsonb_build_object('lead', to_jsonb(lead_row), 'outcome', to_jsonb(outcome_row));
end;
$$;

