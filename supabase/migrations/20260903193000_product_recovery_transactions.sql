-- Atomic import and business-change evaluation.
--
-- Both functions run as the authenticated caller, remain subject to RLS, and
-- perform an explicit organization/role check. Any invalid row, identity
-- conflict, unsafe recommendation, or activity-write failure rolls back the
-- complete call.

create or replace function public.sf_import_leads(
  p_organization_id uuid,
  p_leads jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  actor_user_id uuid := auth.uid();
  input_count integer;
  inserted_count integer := 0;
  updated_count integer := 0;
  unchanged_count integer := 0;
  item jsonb;
  incoming_external_ref text;
  incoming_name text;
  incoming_phone text;
  incoming_email text;
  incoming_service text;
  incoming_is_demo boolean;
  matching_ids uuid[];
  lead_row public.sf_leads%rowtype;
  affected jsonb := '[]'::jsonb;
  should_update boolean;
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

  if p_leads is null or jsonb_typeof(p_leads) <> 'array' then
    raise exception using errcode = '22023', message = 'INVALID_IMPORT_PAYLOAD';
  end if;
  input_count := jsonb_array_length(p_leads);
  if input_count < 1 or input_count > 1000 then
    raise exception using errcode = '22023', message = 'INVALID_IMPORT_SIZE';
  end if;

  for item in select value from jsonb_array_elements(p_leads)
  loop
    if jsonb_typeof(item) <> 'object' then
      raise exception using errcode = '22023', message = 'INVALID_IMPORT_ROW';
    end if;

    incoming_external_ref := nullif(btrim(item ->> 'external_ref'), '');
    incoming_name := nullif(btrim(item ->> 'name'), '');
    incoming_service := nullif(btrim(item ->> 'service'), '');
    incoming_is_demo := coalesce((item ->> 'is_demo')::boolean, false);

    incoming_phone := nullif(regexp_replace(coalesce(item ->> 'phone', ''), '[^0-9]', '', 'g'), '');
    if incoming_phone like '00972%' then
      incoming_phone := '0' || substr(incoming_phone, 6);
    elsif incoming_phone like '972%' then
      incoming_phone := '0' || substr(incoming_phone, 4);
    end if;
    if incoming_phone is not null and char_length(incoming_phone) not between 9 and 15 then
      incoming_phone := null;
    end if;

    incoming_email := lower(nullif(btrim(item ->> 'email'), ''));
    if incoming_email is not null
       and incoming_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then
      incoming_email := null;
    end if;

    if incoming_external_ref is null
       or incoming_name is null
       or incoming_service is null then
      raise exception using errcode = '22023', message = 'INVALID_IMPORT_ROW';
    end if;

    select coalesce(array_agg(candidate.id order by candidate.created_at), array[]::uuid[])
      into matching_ids
    from public.sf_leads candidate
    where candidate.organization_id = p_organization_id
      and candidate.is_demo = incoming_is_demo
      and (
        candidate.external_ref = incoming_external_ref
        or (
          incoming_phone is not null
          and case
            when regexp_replace(coalesce(candidate.phone, ''), '[^0-9]', '', 'g') like '00972%' then
              '0' || substr(regexp_replace(candidate.phone, '[^0-9]', '', 'g'), 6)
            when regexp_replace(coalesce(candidate.phone, ''), '[^0-9]', '', 'g') like '972%' then
              '0' || substr(regexp_replace(candidate.phone, '[^0-9]', '', 'g'), 4)
            else regexp_replace(coalesce(candidate.phone, ''), '[^0-9]', '', 'g')
          end = incoming_phone
        )
        or (
          incoming_email is not null
          and lower(btrim(coalesce(candidate.email, ''))) = incoming_email
        )
      );

    if cardinality(matching_ids) > 1 then
      raise exception using errcode = '23505', message = 'CONTACT_IDENTITY_CONFLICT';
    end if;

    if cardinality(matching_ids) = 1 then
      select * into lead_row
      from public.sf_leads
      where organization_id = p_organization_id
        and id = matching_ids[1]
      for update;

      should_update :=
        (lead_row.phone is null and incoming_phone is not null)
        or (lead_row.email is null and incoming_email is not null)
        or (coalesce((item ->> 'dnc')::boolean, false) and not lead_row.dnc)
        or (coalesce((item ->> 'medical_escalation')::boolean, false) and not lead_row.medical_escalation)
        or (coalesce((item ->> 'needs_fix')::boolean, false) and not lead_row.needs_fix);

      if should_update then
        update public.sf_leads
        set phone = case when phone is null then incoming_phone else phone end,
            email = case when email is null then incoming_email else email end,
            dnc = dnc or coalesce((item ->> 'dnc')::boolean, false),
            medical_escalation = medical_escalation
              or coalesce((item ->> 'medical_escalation')::boolean, false),
            needs_fix = needs_fix or coalesce((item ->> 'needs_fix')::boolean, false)
        where organization_id = p_organization_id
          and id = lead_row.id
        returning * into lead_row;
        updated_count := updated_count + 1;
      else
        unchanged_count := unchanged_count + 1;
      end if;
    else
      insert into public.sf_leads (
        organization_id,
        external_ref,
        name,
        phone,
        email,
        service,
        value_minor,
        last_contact_at,
        notes,
        branch,
        dnc,
        medical_escalation,
        is_demo,
        needs_fix,
        stopped_reason_code,
        stopped_reason_text,
        preferred_time,
        requested_contact_after,
        status
      ) values (
        p_organization_id,
        incoming_external_ref,
        incoming_name,
        incoming_phone,
        incoming_email,
        incoming_service,
        greatest(coalesce((item ->> 'value_minor')::bigint, 0), 0),
        nullif(item ->> 'last_contact_at', '')::timestamptz,
        coalesce(item ->> 'notes', ''),
        nullif(btrim(item ->> 'branch'), ''),
        coalesce((item ->> 'dnc')::boolean, false),
        coalesce((item ->> 'medical_escalation')::boolean, false),
        incoming_is_demo,
        coalesce((item ->> 'needs_fix')::boolean, false),
        coalesce(nullif(item ->> 'stopped_reason_code', ''), 'unknown'),
        coalesce(nullif(btrim(item ->> 'stopped_reason_text'), ''), 'לא ידוע למה הפנייה נעצרה'),
        nullif(btrim(item ->> 'preferred_time'), ''),
        nullif(item ->> 'requested_contact_after', '')::date,
        case when coalesce((item ->> 'dnc')::boolean, false) then 'dnc' else 'watching' end
      )
      returning * into lead_row;
      inserted_count := inserted_count + 1;
    end if;

    affected := affected || jsonb_build_array(to_jsonb(lead_row));
  end loop;

  insert into public.sf_activity (organization_id, action, details, actor_id)
  values (
    p_organization_id,
    case
      when exists (
        select 1
        from jsonb_array_elements(p_leads) as demo_row(value)
        where coalesce((demo_row.value ->> 'is_demo')::boolean, false)
      )
        then 'demo_leads_loaded'
      else 'leads_imported'
    end,
    jsonb_build_object(
      'attempted', input_count,
      'consolidated', input_count,
      'inserted', inserted_count,
      'updated', updated_count,
      'unchanged', unchanged_count
    ),
    actor_user_id
  );

  return jsonb_build_object(
    'leads', affected,
    'inserted', inserted_count,
    'updated', updated_count,
    'unchanged', unchanged_count
  );
exception
  when invalid_text_representation or numeric_value_out_of_range or invalid_datetime_format or datetime_field_overflow then
    raise exception using errcode = '22023', message = 'INVALID_IMPORT_ROW';
end;
$$;

create or replace function public.sf_create_change_and_match(
  p_organization_id uuid,
  p_change jsonb,
  p_recommendations jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  actor_user_id uuid := auth.uid();
  change_row public.sf_changes%rowtype;
  recommendation_row public.sf_recommendations%rowtype;
  item jsonb;
  recommendations jsonb := '[]'::jsonb;
  checked_count integer;
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

  if p_change is null
     or jsonb_typeof(p_change) <> 'object'
     or p_recommendations is null
     or jsonb_typeof(p_recommendations) <> 'array'
     or jsonb_array_length(p_recommendations) > 1000 then
    raise exception using errcode = '22023', message = 'INVALID_CHANGE_PAYLOAD';
  end if;

  insert into public.sf_changes (
    id,
    organization_id,
    type,
    service,
    branch,
    starts_at,
    ends_at,
    title,
    details,
    is_demo
  ) values (
    (p_change ->> 'id')::uuid,
    p_organization_id,
    p_change ->> 'type',
    coalesce(p_change ->> 'service', ''),
    nullif(btrim(p_change ->> 'branch'), ''),
    nullif(p_change ->> 'starts_at', '')::timestamptz,
    nullif(p_change ->> 'ends_at', '')::timestamptz,
    p_change ->> 'title',
    p_change ->> 'details',
    coalesce((p_change ->> 'is_demo')::boolean, false)
  )
  on conflict (id) do nothing
  returning * into change_row;

  if change_row.id is null then
    select * into change_row
    from public.sf_changes
    where id = (p_change ->> 'id')::uuid
      and organization_id = p_organization_id
    for update;

    if change_row.id is null
       or change_row.type is distinct from (p_change ->> 'type')
       or change_row.service is distinct from coalesce(p_change ->> 'service', '')
       or change_row.branch is distinct from nullif(btrim(p_change ->> 'branch'), '')
       or change_row.starts_at is distinct from nullif(p_change ->> 'starts_at', '')::timestamptz
       or change_row.ends_at is distinct from nullif(p_change ->> 'ends_at', '')::timestamptz
       or change_row.title is distinct from (p_change ->> 'title')
       or change_row.details is distinct from (p_change ->> 'details') then
      raise exception using errcode = '23505', message = 'CHANGE_ID_CONFLICT';
    end if;

    select coalesce(jsonb_agg(to_jsonb(recommendation) order by recommendation.created_at), '[]'::jsonb)
      into recommendations
    from public.sf_recommendations recommendation
    where recommendation.organization_id = p_organization_id
      and recommendation.change_id = change_row.id;

    select count(*)::integer into checked_count
    from public.sf_leads
    where organization_id = p_organization_id;

    return jsonb_build_object(
      'change', to_jsonb(change_row),
      'recommendations', recommendations,
      'checked', checked_count
    );
  end if;
  for item in select value from jsonb_array_elements(p_recommendations)
  loop
    if jsonb_typeof(item) <> 'object' then
      raise exception using errcode = '22023', message = 'INVALID_RECOMMENDATION_PAYLOAD';
    end if;

    insert into public.sf_recommendations (
      organization_id,
      lead_id,
      change_id,
      then_text,
      now_text,
      why_text,
      suggested_message,
      state,
      expires_at
    ) values (
      p_organization_id,
      (item ->> 'lead_id')::uuid,
      change_row.id,
      item ->> 'then_text',
      item ->> 'now_text',
      item ->> 'why_text',
      item ->> 'suggested_message',
      'review',
      nullif(item ->> 'expires_at', '')::timestamptz
    )
    returning * into recommendation_row;

    recommendations := recommendations || jsonb_build_array(to_jsonb(recommendation_row));
  end loop;

  select count(*)::integer into checked_count
  from public.sf_leads
  where organization_id = p_organization_id;

  insert into public.sf_activity (organization_id, action, details, actor_id)
  values (
    p_organization_id,
    'business_change_checked',
    jsonb_build_object(
      'checked', checked_count,
      'matched', jsonb_array_length(p_recommendations),
      'type', change_row.type,
      'change_id', change_row.id
    ),
    actor_user_id
  );

  return jsonb_build_object(
    'change', to_jsonb(change_row),
    'recommendations', recommendations,
    'checked', checked_count
  );
exception
  when invalid_text_representation or numeric_value_out_of_range or invalid_datetime_format or datetime_field_overflow then
    raise exception using errcode = '22023', message = 'INVALID_CHANGE_PAYLOAD';
end;
$$;

revoke all on function public.sf_import_leads(uuid, jsonb) from public, anon;
revoke all on function public.sf_create_change_and_match(uuid, jsonb, jsonb) from public, anon;
grant execute on function public.sf_import_leads(uuid, jsonb) to authenticated;
grant execute on function public.sf_create_change_and_match(uuid, jsonb, jsonb) to authenticated;
