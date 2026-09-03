-- Shuv Flow product recovery: secure tenant policies and the clinic-facing domain.

-- 1. Repair the malformed V2 policies before introducing the replacement UI.
do $policy_fix$
declare
  table_name text;
begin
  foreach table_name in array array[
    'shuv_v2_workspaces', 'shuv_v2_services', 'shuv_v2_leads',
    'shuv_v2_moments', 'shuv_v2_matches', 'shuv_v2_conversations',
    'shuv_v2_outreach', 'shuv_v2_messages', 'shuv_v2_handoffs',
    'shuv_v2_outcomes'
  ] loop
    execute format('drop policy if exists %I on public.%I', table_name || '_select_member', table_name);
    execute format('drop policy if exists %I on public.%I', table_name || '_insert_operator', table_name);
    execute format('drop policy if exists %I on public.%I', table_name || '_update_operator', table_name);
    execute format('drop policy if exists %I on public.%I', table_name || '_delete_admin', table_name);

    execute format(
      'create policy %I on public.%I for select to authenticated using
       (exists (select 1 from public.shuv_memberships membership
         where membership.organization_id = %I.organization_id
           and membership.user_id = (select auth.uid())))',
      table_name || '_select_member', table_name, table_name
    );
    execute format(
      'create policy %I on public.%I for insert to authenticated with check
       (exists (select 1 from public.shuv_memberships membership
         where membership.organization_id = %I.organization_id
           and membership.user_id = (select auth.uid())
           and membership.role = any (array[''owner'', ''admin'', ''operator''])))',
      table_name || '_insert_operator', table_name, table_name
    );
    execute format(
      'create policy %I on public.%I for update to authenticated using
       (exists (select 1 from public.shuv_memberships membership
         where membership.organization_id = %I.organization_id
           and membership.user_id = (select auth.uid())
           and membership.role = any (array[''owner'', ''admin'', ''operator''])))
       with check
       (exists (select 1 from public.shuv_memberships membership
         where membership.organization_id = %I.organization_id
           and membership.user_id = (select auth.uid())
           and membership.role = any (array[''owner'', ''admin'', ''operator''])))',
      table_name || '_update_operator', table_name, table_name, table_name
    );
    execute format(
      'create policy %I on public.%I for delete to authenticated using
       (exists (select 1 from public.shuv_memberships membership
         where membership.organization_id = %I.organization_id
           and membership.user_id = (select auth.uid())
           and membership.role = any (array[''owner'', ''admin''])))',
      table_name || '_delete_admin', table_name, table_name
    );

    execute format('revoke all on public.%I from anon', table_name);
    execute format('revoke all on public.%I from authenticated', table_name);
    execute format('grant select, insert, update, delete on public.%I to authenticated', table_name);
  end loop;
end
$policy_fix$;

-- 2. Add missing indexes used by tenant and relationship checks.
create index if not exists shuv_v2_conversations_org_idx on public.shuv_v2_conversations (organization_id);
create index if not exists shuv_v2_conversations_lead_idx on public.shuv_v2_conversations (lead_id);
create index if not exists shuv_v2_handoffs_lead_idx on public.shuv_v2_handoffs (lead_id);
create index if not exists shuv_v2_matches_org_idx on public.shuv_v2_matches (organization_id);
create index if not exists shuv_v2_matches_lead_idx on public.shuv_v2_matches (lead_id);
create index if not exists shuv_v2_messages_org_idx on public.shuv_v2_messages (organization_id);
create index if not exists shuv_v2_messages_conversation_idx on public.shuv_v2_messages (conversation_id);
create index if not exists shuv_v2_outcomes_org_idx on public.shuv_v2_outcomes (organization_id);
create index if not exists shuv_v2_outcomes_lead_idx on public.shuv_v2_outcomes (lead_id);
create index if not exists shuv_v2_outreach_lead_idx on public.shuv_v2_outreach (lead_id);
create index if not exists shuv_v2_outreach_conversation_idx on public.shuv_v2_outreach (conversation_id);

-- 3. Strengthen legacy DNC and confirmed-revenue invariants.
create or replace function public.shuv_v2_guard_safe_match()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  lead_org uuid;
  lead_dnc boolean;
  lead_reason text;
  moment_org uuid;
begin
  select organization_id, dnc, lost_reason
    into lead_org, lead_dnc, lead_reason
  from public.shuv_v2_leads where id = new.lead_id;
  select organization_id into moment_org
  from public.shuv_v2_moments where id = new.moment_id;

  if lead_org is null or moment_org is null
     or lead_org <> new.organization_id or moment_org <> new.organization_id then
    raise exception 'RELATED_RECORD_MISMATCH';
  end if;
  if (new.eligible or new.recommended or new.contact_eligible)
     and (lead_dnc or lead_reason is null or lead_reason = 'unknown') then
    raise exception 'CONTACT_NOT_ALLOWED';
  end if;
  if new.recommended and (not new.reason_aligned or not new.contact_eligible or btrim(new.why_now) = '') then
    raise exception 'NO_CONCRETE_REASON';
  end if;
  return new;
end;
$$;

drop trigger if exists shuv_v2_safe_match on public.shuv_v2_matches;
create trigger shuv_v2_safe_match
before insert or update on public.shuv_v2_matches
for each row execute function public.shuv_v2_guard_safe_match();

create or replace function public.shuv_v2_guard_safe_message()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  conversation_org uuid;
  lead_dnc boolean;
  lead_reason text;
begin
  select conversation.organization_id, lead.dnc, lead.lost_reason
    into conversation_org, lead_dnc, lead_reason
  from public.shuv_v2_conversations conversation
  join public.shuv_v2_leads lead on lead.id = conversation.lead_id
  where conversation.id = new.conversation_id;

  if conversation_org is null or conversation_org <> new.organization_id then
    raise exception 'RELATED_RECORD_MISMATCH';
  end if;
  if new.direction = 'outbound'
     and (lead_dnc or lead_reason is null or lead_reason = 'unknown') then
    raise exception 'CONTACT_NOT_ALLOWED';
  end if;
  return new;
end;
$$;

drop trigger if exists shuv_v2_safe_message on public.shuv_v2_messages;
create trigger shuv_v2_safe_message
before insert or update on public.shuv_v2_messages
for each row execute function public.shuv_v2_guard_safe_message();

alter table public.shuv_v2_outcomes
  drop constraint if exists shuv_v2_outcomes_nonnegative_revenue,
  add constraint shuv_v2_outcomes_nonnegative_revenue
    check (pipeline_value_minor >= 0 and coalesce(confirmed_revenue_minor, 0) >= 0),
  drop constraint if exists shuv_v2_outcomes_confirmed_revenue_integrity,
  add constraint shuv_v2_outcomes_confirmed_revenue_integrity
    check (
      (not revenue_confirmed and confirmed_revenue_minor is null and confirmed_at is null)
      or
      (revenue_confirmed and status = 'recovered' and confirmed_revenue_minor is not null
       and confirmed_revenue_currency is not null and confirmed_at is not null)
    );

-- 4. Create the simple clinic-facing product domain.
create table if not exists public.sf_clinics (
  organization_id uuid primary key references public.shuv_organizations(id) on delete cascade,
  clinic_name text not null check (char_length(btrim(clinic_name)) between 2 and 120),
  main_service text not null check (char_length(btrim(main_service)) between 2 and 120),
  onboarding_completed boolean not null default false,
  timezone text not null default 'Asia/Jerusalem',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.sf_leads (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.shuv_organizations(id) on delete cascade,
  external_ref text,
  name text not null check (char_length(btrim(name)) between 1 and 120),
  phone text,
  email text,
  service text not null check (char_length(btrim(service)) between 1 and 120),
  value_minor bigint not null default 0 check (value_minor >= 0),
  currency text not null default 'ILS',
  last_contact_at timestamptz,
  notes text not null default '',
  branch text,
  dnc boolean not null default false,
  medical_escalation boolean not null default false,
  is_demo boolean not null default false,
  needs_fix boolean not null default false,
  stopped_reason_code text not null default 'unknown' check (stopped_reason_code in (
    'timing','availability','service','payment','requested_date','needs_time',
    'no_response','price','competitor','not_interested','unknown'
  )),
  stopped_reason_text text not null default 'לא ידוע למה הפנייה נעצרה',
  preferred_time text,
  requested_contact_after date,
  status text not null default 'watching' check (status in (
    'watching','approval','waiting','interested','contacted','booked','closed',
    'not_now','no_reply','dnc'
  )),
  response_text text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  unique (organization_id, external_ref),
  check (phone is not null or email is not null or needs_fix),
  check (not dnc or status = 'dnc')
);

create table if not exists public.sf_changes (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.shuv_organizations(id) on delete cascade,
  type text not null check (type in ('slot','availability','service','requested_date','payment','other')),
  service text not null default '',
  branch text,
  starts_at timestamptz,
  ends_at timestamptz,
  title text not null check (char_length(btrim(title)) >= 4),
  details text not null check (char_length(btrim(details)) >= 4),
  is_demo boolean not null default false,
  created_at timestamptz not null default now(),
  unique (organization_id, id),
  check (ends_at is null or starts_at is null or ends_at > starts_at)
);

create table if not exists public.sf_recommendations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.shuv_organizations(id) on delete cascade,
  lead_id uuid not null,
  change_id uuid not null,
  then_text text not null check (char_length(btrim(then_text)) >= 4),
  now_text text not null check (char_length(btrim(now_text)) >= 4),
  why_text text not null check (char_length(btrim(why_text)) >= 4),
  suggested_message text not null check (char_length(btrim(suggested_message)) >= 10),
  state text not null default 'review' check (state in ('review','dismissed','expired')),
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  unique (organization_id, id),
  unique (lead_id, change_id),
  foreign key (organization_id, lead_id) references public.sf_leads(organization_id, id) on delete cascade,
  foreign key (organization_id, change_id) references public.sf_changes(organization_id, id) on delete cascade
);

create table if not exists public.sf_messages (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.shuv_organizations(id) on delete cascade,
  recommendation_id uuid not null,
  lead_id uuid not null,
  body text not null check (char_length(btrim(body)) >= 10),
  status text not null default 'draft' check (status in ('draft','copied','sent','snoozed')),
  channel text check (channel is null or channel in ('whatsapp','sms','email','other')),
  copied_at timestamptz,
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  unique (recommendation_id),
  foreign key (organization_id, recommendation_id) references public.sf_recommendations(organization_id, id) on delete cascade,
  foreign key (organization_id, lead_id) references public.sf_leads(organization_id, id) on delete cascade,
  check ((status <> 'sent') or sent_at is not null)
);

create table if not exists public.sf_outcomes (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.shuv_organizations(id) on delete cascade,
  lead_id uuid not null,
  response_type text check (response_type is null or response_type in ('interested','not_now','no_reply','dnc')),
  response_text text not null default '',
  responded_at timestamptz,
  contacted_at timestamptz,
  booked_at timestamptz,
  closed_at timestamptz,
  status text not null default 'returned' check (status in ('returned','booked','closed','lost')),
  revenue_minor bigint check (revenue_minor is null or revenue_minor >= 0),
  currency text not null default 'ILS',
  revenue_confirmed_at timestamptz,
  revenue_confirmed_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  unique (lead_id),
  foreign key (organization_id, lead_id) references public.sf_leads(organization_id, id) on delete cascade,
  check (
    (revenue_confirmed_at is null and revenue_confirmed_by is null and revenue_minor is null)
    or
    (status = 'closed' and closed_at is not null and revenue_confirmed_at is not null
     and revenue_confirmed_by is not null and revenue_minor is not null)
  )
);

create table if not exists public.sf_activity (
  id bigint generated by default as identity primary key,
  organization_id uuid not null references public.shuv_organizations(id) on delete cascade,
  lead_id uuid,
  action text not null,
  details jsonb not null default '{}'::jsonb,
  actor_id uuid not null default auth.uid(),
  created_at timestamptz not null default now(),
  foreign key (organization_id, lead_id) references public.sf_leads(organization_id, id) on delete cascade
);

create index if not exists sf_leads_org_status_idx on public.sf_leads (organization_id, status);
create index if not exists sf_leads_org_demo_idx on public.sf_leads (organization_id, is_demo);
create index if not exists sf_changes_org_created_idx on public.sf_changes (organization_id, created_at desc);
create index if not exists sf_recommendations_org_state_idx on public.sf_recommendations (organization_id, state);
create index if not exists sf_recommendations_lead_idx on public.sf_recommendations (lead_id);
create index if not exists sf_messages_org_status_idx on public.sf_messages (organization_id, status);
create index if not exists sf_messages_lead_idx on public.sf_messages (lead_id);
create index if not exists sf_outcomes_org_status_idx on public.sf_outcomes (organization_id, status);
create index if not exists sf_activity_org_created_idx on public.sf_activity (organization_id, created_at desc);

create or replace function public.sf_touch_updated_at()
returns trigger language plpgsql set search_path = pg_catalog as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists sf_clinics_touch on public.sf_clinics;
create trigger sf_clinics_touch before update on public.sf_clinics
for each row execute function public.sf_touch_updated_at();
drop trigger if exists sf_leads_touch on public.sf_leads;
create trigger sf_leads_touch before update on public.sf_leads
for each row execute function public.sf_touch_updated_at();
drop trigger if exists sf_messages_touch on public.sf_messages;
create trigger sf_messages_touch before update on public.sf_messages
for each row execute function public.sf_touch_updated_at();
drop trigger if exists sf_outcomes_touch on public.sf_outcomes;
create trigger sf_outcomes_touch before update on public.sf_outcomes
for each row execute function public.sf_touch_updated_at();

create or replace function public.sf_guard_recommendation()
returns trigger language plpgsql set search_path = pg_catalog, public as $$
declare
  lead_row public.sf_leads%rowtype;
  change_org uuid;
begin
  select * into lead_row from public.sf_leads where id = new.lead_id;
  select organization_id into change_org from public.sf_changes where id = new.change_id;
  if lead_row.id is null or change_org is null
     or lead_row.organization_id <> new.organization_id or change_org <> new.organization_id then
    raise exception 'RELATED_RECORD_MISMATCH';
  end if;
  if new.state = 'review' and (
    lead_row.dnc or lead_row.medical_escalation or lead_row.needs_fix
    or lead_row.stopped_reason_code = 'unknown'
    or btrim(new.then_text) = '' or btrim(new.now_text) = '' or btrim(new.why_text) = ''
    or (new.expires_at is not null and new.expires_at <= now())
  ) then
    raise exception 'NO_CONCRETE_CONTACT_REASON';
  end if;
  return new;
end;
$$;

drop trigger if exists sf_recommendation_guard on public.sf_recommendations;
create trigger sf_recommendation_guard
before insert or update on public.sf_recommendations
for each row execute function public.sf_guard_recommendation();

create or replace function public.sf_guard_message()
returns trigger language plpgsql set search_path = pg_catalog, public as $$
declare
  recommendation_org uuid;
  recommendation_state text;
  recommendation_expiry timestamptz;
  lead_dnc boolean;
begin
  select recommendation.organization_id, recommendation.state, recommendation.expires_at, lead.dnc
    into recommendation_org, recommendation_state, recommendation_expiry, lead_dnc
  from public.sf_recommendations recommendation
  join public.sf_leads lead on lead.id = recommendation.lead_id
  where recommendation.id = new.recommendation_id and lead.id = new.lead_id;

  if recommendation_org is null or recommendation_org <> new.organization_id then
    raise exception 'RELATED_RECORD_MISMATCH';
  end if;
  if new.status <> 'snoozed' and (
     lead_dnc or recommendation_state <> 'review'
     or (recommendation_expiry is not null and recommendation_expiry <= now())
  ) then
    raise exception 'CONTACT_NOT_ALLOWED';
  end if;
  return new;
end;
$$;

drop trigger if exists sf_message_guard on public.sf_messages;
create trigger sf_message_guard
before insert or update on public.sf_messages
for each row execute function public.sf_guard_message();

create or replace function public.sf_sync_dnc()
returns trigger language plpgsql set search_path = pg_catalog, public as $$
begin
  if new.dnc and not old.dnc then
    new.status = 'dnc';
    update public.sf_messages set status = 'snoozed'
      where organization_id = new.organization_id and lead_id = new.id and status in ('draft','copied');
    update public.sf_recommendations set state = 'dismissed'
      where organization_id = new.organization_id and lead_id = new.id and state = 'review';
  end if;
  return new;
end;
$$;

drop trigger if exists sf_lead_dnc_guard on public.sf_leads;
create trigger sf_lead_dnc_guard
before update on public.sf_leads
for each row execute function public.sf_sync_dnc();

alter table public.sf_clinics enable row level security;
alter table public.sf_leads enable row level security;
alter table public.sf_changes enable row level security;
alter table public.sf_recommendations enable row level security;
alter table public.sf_messages enable row level security;
alter table public.sf_outcomes enable row level security;
alter table public.sf_activity enable row level security;

do $sf_policies$
declare
  table_name text;
begin
  foreach table_name in array array[
    'sf_clinics','sf_leads','sf_changes','sf_recommendations',
    'sf_messages','sf_outcomes','sf_activity'
  ] loop
    execute format('drop policy if exists %I on public.%I', table_name || '_select_member', table_name);
    execute format('drop policy if exists %I on public.%I', table_name || '_insert_operator', table_name);
    execute format('drop policy if exists %I on public.%I', table_name || '_update_operator', table_name);
    execute format('drop policy if exists %I on public.%I', table_name || '_delete_admin', table_name);
    execute format(
      'create policy %I on public.%I for select to authenticated using
       (exists (select 1 from public.shuv_memberships membership
         where membership.organization_id = %I.organization_id
           and membership.user_id = (select auth.uid())))',
      table_name || '_select_member', table_name, table_name
    );
    execute format(
      'create policy %I on public.%I for insert to authenticated with check
       (exists (select 1 from public.shuv_memberships membership
         where membership.organization_id = %I.organization_id
           and membership.user_id = (select auth.uid())
           and membership.role = any (array[''owner'', ''admin'', ''operator''])))',
      table_name || '_insert_operator', table_name, table_name
    );
    if table_name <> 'sf_activity' then
      execute format(
        'create policy %I on public.%I for update to authenticated using
         (exists (select 1 from public.shuv_memberships membership
           where membership.organization_id = %I.organization_id
             and membership.user_id = (select auth.uid())
             and membership.role = any (array[''owner'', ''admin'', ''operator''])))
         with check
         (exists (select 1 from public.shuv_memberships membership
           where membership.organization_id = %I.organization_id
             and membership.user_id = (select auth.uid())
             and membership.role = any (array[''owner'', ''admin'', ''operator''])))',
        table_name || '_update_operator', table_name, table_name, table_name
      );
    end if;
    execute format(
      'create policy %I on public.%I for delete to authenticated using
       (exists (select 1 from public.shuv_memberships membership
         where membership.organization_id = %I.organization_id
           and membership.user_id = (select auth.uid())
           and membership.role = any (array[''owner'', ''admin''])))',
      table_name || '_delete_admin', table_name, table_name
    );
    execute format('revoke all on public.%I from anon', table_name);
    execute format('revoke all on public.%I from authenticated', table_name);
    execute format('grant select, insert, update, delete on public.%I to authenticated', table_name);
  end loop;
end
$sf_policies$;

revoke all on function public.sf_touch_updated_at() from public, anon, authenticated;
revoke all on function public.sf_guard_recommendation() from public, anon, authenticated;
revoke all on function public.sf_guard_message() from public, anon, authenticated;
revoke all on function public.sf_sync_dnc() from public, anon, authenticated;
revoke all on function public.shuv_v2_guard_safe_match() from public, anon, authenticated;
revoke all on function public.shuv_v2_guard_safe_message() from public, anon, authenticated;

grant usage, select on sequence public.sf_activity_id_seq to authenticated;
