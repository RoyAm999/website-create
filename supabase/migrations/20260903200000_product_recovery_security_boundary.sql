-- Make the recovery workflow and its audit trail authoritative.
--
-- Product state is still readable through RLS, but state transitions that
-- affect outreach, outcomes, or revenue can no longer be fabricated with
-- direct table writes.  The public RPCs below were audited for explicit
-- auth.uid(), organization membership, role, and organization-qualified row
-- checks before being promoted to SECURITY DEFINER.

-- Every workflow RPC writes an append-only activity row.  Running them as the
-- owning role lets us remove INSERT from the browser without weakening their
-- existing caller and tenant checks.
alter function public.sf_import_leads(uuid, jsonb) security definer;
alter function public.sf_import_leads(uuid, jsonb) set search_path = pg_catalog, public;
alter function public.sf_create_change_and_match(uuid, jsonb, jsonb) security definer;
alter function public.sf_create_change_and_match(uuid, jsonb, jsonb) set search_path = pg_catalog, public;
alter function public.sf_prepare_recovery_message(uuid, uuid) security definer;
alter function public.sf_prepare_recovery_message(uuid, uuid) set search_path = pg_catalog, public;
alter function public.sf_snooze_recovery_message(uuid, uuid) security definer;
alter function public.sf_snooze_recovery_message(uuid, uuid) set search_path = pg_catalog, public;
alter function public.sf_mark_recovery_message_sent(uuid, uuid, text) security definer;
alter function public.sf_mark_recovery_message_sent(uuid, uuid, text) set search_path = pg_catalog, public;
alter function public.sf_record_recovery_response(uuid, uuid, text, text) security definer;
alter function public.sf_record_recovery_response(uuid, uuid, text, text) set search_path = pg_catalog, public;
alter function public.sf_advance_recovery_lead(uuid, uuid, text) security definer;
alter function public.sf_advance_recovery_lead(uuid, uuid, text) set search_path = pg_catalog, public;
alter function public.sf_confirm_recovered_revenue(uuid, uuid, bigint, text) security definer;
alter function public.sf_confirm_recovered_revenue(uuid, uuid, bigint, text) set search_path = pg_catalog, public;
alter function public.sf_approve_recovery_message(uuid, uuid, text) security definer;
alter function public.sf_approve_recovery_message(uuid, uuid, text) set search_path = pg_catalog, public;
alter function public.sf_reconcile_stale_work(uuid) security definer;
alter function public.sf_reconcile_stale_work(uuid) set search_path = pg_catalog, public;
alter function public.sf_defer_recovery_progress(uuid, uuid, timestamptz) security definer;
alter function public.sf_defer_recovery_progress(uuid, uuid, timestamptz) set search_path = pg_catalog, public;
alter function public.sf_record_follow_up_request(uuid, uuid, text, date) security definer;
alter function public.sf_record_follow_up_request(uuid, uuid, text, date) set search_path = pg_catalog, public;
alter function public.sf_correct_recovered_revenue(uuid, uuid, bigint, text) security definer;
alter function public.sf_correct_recovered_revenue(uuid, uuid, bigint, text) set search_path = pg_catalog, public;

-- A customer-facing failure may still be reported from the browser, but the
-- browser cannot choose an authoritative business action or forge its actor.
create or replace function public.sf_report_client_error(
  p_organization_id uuid,
  p_details jsonb
)
returns bigint
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  actor_user_id uuid := auth.uid();
  activity_id bigint;
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
  if p_details is null
     or jsonb_typeof(p_details) <> 'object'
     or pg_column_size(p_details) > 16384 then
    raise exception using errcode = '22023', message = 'INVALID_ERROR_DETAILS';
  end if;

  insert into public.sf_activity (
    organization_id, action, details, actor_id
  ) values (
    p_organization_id, 'client_error', p_details, actor_user_id
  )
  returning id into activity_id;

  return activity_id;
end;
$$;

revoke all on function public.sf_report_client_error(uuid, jsonb)
  from public, anon, authenticated;
grant execute on function public.sf_report_client_error(uuid, jsonb)
  to authenticated;

-- The workflow log is append-only and workflow-authored.  Members can read
-- their own clinic's history, but no browser role can insert, rewrite, delete,
-- truncate, or choose sequence values.
drop policy if exists sf_activity_insert_operator on public.sf_activity;
drop policy if exists sf_activity_update_operator on public.sf_activity;
drop policy if exists sf_activity_delete_admin on public.sf_activity;
revoke insert, update, delete, truncate on public.sf_activity
  from public, anon, authenticated;
revoke all on sequence public.sf_activity_id_seq
  from public, anon, authenticated;
grant select on public.sf_activity to authenticated;

-- Outcome and revenue records are written only by the explicit, audited RPCs.
drop policy if exists sf_outcomes_insert_operator on public.sf_outcomes;
drop policy if exists sf_outcomes_update_operator on public.sf_outcomes;
drop policy if exists sf_outcomes_delete_admin on public.sf_outcomes;
revoke insert, update, delete, truncate on public.sf_outcomes
  from public, anon, authenticated;
grant select on public.sf_outcomes to authenticated;

-- The remaining workflow tables are also created by RPCs.  Keep direct lead
-- correction and clinic onboarding available, but remove unused mutation
-- capabilities that could bypass transition auditing.
revoke insert, update, delete, truncate on public.sf_changes
  from public, anon, authenticated;
revoke insert, update, delete, truncate on public.sf_recommendations
  from public, anon, authenticated;
revoke insert, update, delete, truncate on public.sf_messages
  from public, anon, authenticated;
revoke insert, truncate on public.sf_leads
  from public, anon, authenticated;
revoke update on public.sf_leads from authenticated;
grant update (
  name, phone, email, service, stopped_reason_code, stopped_reason_text,
  preferred_time, requested_contact_after, branch, dnc,
  medical_escalation, needs_fix
) on public.sf_leads to authenticated;

-- Real leads and their recovery history are not deletable from the browser.
-- Deleting the repeatable demo dataset remains available to owners/admins.
drop policy if exists sf_leads_delete_admin on public.sf_leads;
create policy sf_leads_delete_demo_admin
on public.sf_leads
for delete
to authenticated
using (
  sf_leads.is_demo
  and exists (
    select 1
      from public.shuv_memberships membership
     where membership.organization_id = sf_leads.organization_id
       and membership.user_id = (select auth.uid())
       and membership.role in ('owner', 'admin')
  )
);

drop policy if exists sf_changes_delete_admin on public.sf_changes;
drop policy if exists sf_recommendations_delete_admin on public.sf_recommendations;
drop policy if exists sf_messages_delete_admin on public.sf_messages;

-- Tenant ownership is immutable after insert, even for a user who belongs to
-- more than one clinic.  Cross-tenant moves must never be possible updates.
create or replace function public.sf_guard_organization_immutable()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog
as $$
begin
  if new.organization_id is distinct from old.organization_id then
    raise exception using errcode = '23514', message = 'ORGANIZATION_IMMUTABLE';
  end if;
  return new;
end;
$$;

do $organization_triggers$
declare
  table_name text;
begin
  foreach table_name in array array[
    'sf_clinics', 'sf_leads', 'sf_changes', 'sf_recommendations',
    'sf_messages', 'sf_outcomes', 'sf_activity'
  ] loop
    execute format(
      'drop trigger if exists sf_00_organization_immutable on public.%I',
      table_name
    );
    execute format(
      'create trigger sf_00_organization_immutable before update on public.%I '
      'for each row execute function public.sf_guard_organization_immutable()',
      table_name
    );
  end loop;
end
$organization_triggers$;

revoke all on function public.sf_guard_organization_immutable()
  from public, anon, authenticated;

-- Enforce the legal outcome state machine even for privileged maintenance.
alter table public.sf_outcomes
  drop constraint if exists sf_outcomes_lifecycle_consistent;
alter table public.sf_outcomes
  add constraint sf_outcomes_lifecycle_consistent
  check (
    response_type is not null
    and responded_at is not null
    and (
      (response_type = 'interested' and status in ('returned', 'booked', 'closed', 'lost'))
      or (response_type in ('not_now', 'no_reply', 'dnc') and status = 'lost')
      or (response_type = 'medical_review' and status = 'medical_review')
    )
    and (contacted_at is null or contacted_at >= responded_at)
    and (booked_at is null or (contacted_at is not null and booked_at >= contacted_at))
    and (closed_at is null or (booked_at is not null and closed_at >= booked_at))
    and (status <> 'returned' or (booked_at is null and closed_at is null))
    and (status <> 'booked' or (contacted_at is not null and booked_at is not null and closed_at is null))
    and (status <> 'closed' or (contacted_at is not null and booked_at is not null and closed_at is not null))
    and (status <> 'lost' or (booked_at is null and closed_at is null))
    and (status <> 'medical_review' or (contacted_at is null and booked_at is null and closed_at is null))
  ) not valid;
alter table public.sf_outcomes
  validate constraint sf_outcomes_lifecycle_consistent;

-- Confirmed revenue is real-only.  Its original confirmer and confirmation
-- time are immutable; a later amount correction may change only the amount and
-- must go through sf_correct_recovered_revenue with a written reason.
create or replace function public.sf_guard_outcome_integrity()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  lead_is_demo boolean;
  lead_org uuid;
begin
  select lead.organization_id, lead.is_demo
    into lead_org, lead_is_demo
    from public.sf_leads lead
   where lead.id = new.lead_id;

  if lead_org is null or lead_org <> new.organization_id then
    raise exception using errcode = '23514', message = 'RELATED_RECORD_MISMATCH';
  end if;

  if lead_is_demo and (
    new.revenue_minor is not null
    or new.revenue_confirmed_at is not null
    or new.revenue_confirmed_by is not null
  ) then
    raise exception using errcode = '23514', message = 'DEMO_REVENUE_NOT_ALLOWED';
  end if;

  if tg_op = 'UPDATE'
     and old.revenue_confirmed_at is not null
     and (
       new.revenue_minor is null
       or new.currency is distinct from old.currency
       or new.revenue_confirmed_at is distinct from old.revenue_confirmed_at
       or new.revenue_confirmed_by is distinct from old.revenue_confirmed_by
     ) then
    raise exception using errcode = '23514', message = 'CONFIRMED_REVENUE_PROVENANCE_IMMUTABLE';
  end if;

  return new;
end;
$$;

drop trigger if exists sf_outcome_00_integrity on public.sf_outcomes;
create trigger sf_outcome_00_integrity
before insert or update on public.sf_outcomes
for each row execute function public.sf_guard_outcome_integrity();

revoke all on function public.sf_guard_outcome_integrity()
  from public, anon, authenticated;

-- Preserve original confirmation provenance when correcting the amount.
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
  if p_revenue_minor is null or p_revenue_minor <= 0 then
    raise exception using errcode = '22023', message = 'POSITIVE_REVENUE_REQUIRED';
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

  insert into public.sf_activity (organization_id, lead_id, action, details, actor_id)
  values (
    p_organization_id,
    lead_row.id,
    'recovered_revenue_corrected',
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
