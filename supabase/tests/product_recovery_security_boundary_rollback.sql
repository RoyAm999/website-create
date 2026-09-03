-- Rollback-only security regression for Shuv Flow's authoritative workflow.

begin;
set local statement_timeout = '45s';
set local lock_timeout = '5s';

do $fixture_check$
begin
  if not exists (
    select 1 from auth.users
     where id = '12c216ac-608f-4534-9a78-ff7ca575019a'::uuid
  ) then
    raise exception 'QA_AUTH_USER_NOT_FOUND';
  end if;
end
$fixture_check$;

insert into public.shuv_organizations (id, name, created_by)
values
  ('f5000000-0000-4000-8000-000000000001', 'SF security A ' || txid_current(), '12c216ac-608f-4534-9a78-ff7ca575019a'),
  ('f5000000-0000-4000-8000-000000000002', 'SF security B ' || txid_current(), '12c216ac-608f-4534-9a78-ff7ca575019a');

insert into public.shuv_memberships (organization_id, user_id, role)
values ('f5000000-0000-4000-8000-000000000001', '12c216ac-608f-4534-9a78-ff7ca575019a', 'owner');
delete from public.shuv_memberships
 where organization_id = 'f5000000-0000-4000-8000-000000000002';

insert into public.sf_clinics (organization_id, clinic_name, main_service, onboarding_completed)
values
  ('f5000000-0000-4000-8000-000000000001', 'מרפאת אבטחה א', 'טיפול פנים', true),
  ('f5000000-0000-4000-8000-000000000002', 'מרפאת אבטחה ב', 'טיפול פנים', true);

insert into public.sf_leads (
  id, organization_id, name, phone, email, service, stopped_reason_code,
  stopped_reason_text, status, is_demo, next_review_at
)
values
  ('f5100000-0000-4000-8000-000000000001', 'f5000000-0000-4000-8000-000000000001', 'פנייה אמיתית', '0505550001', null, 'טיפול פנים', 'timing', 'יכולה רק אחרי 17:00', 'closed', false, null),
  ('f5100000-0000-4000-8000-000000000002', 'f5000000-0000-4000-8000-000000000001', 'פניית דוגמה', '0505550002', null, 'טיפול פנים', 'timing', 'יכולה רק אחרי 17:00', 'closed', true, null),
  ('f5100000-0000-4000-8000-000000000003', 'f5000000-0000-4000-8000-000000000001', 'דוגמה למחיקה', '0505550003', null, 'טיפול פנים', 'timing', 'יכולה רק אחרי 17:00', 'watching', true, null),
  ('f5100000-0000-4000-8000-000000000004', 'f5000000-0000-4000-8000-000000000002', 'פנייה זרה', '0505550004', null, 'טיפול פנים', 'timing', 'יכולה רק אחרי 17:00', 'closed', false, null),
  ('f5100000-0000-4000-8000-000000000005', 'f5000000-0000-4000-8000-000000000001', 'פנייה לדחיית המלצה', '0505550005', null, 'טיפול פנים', 'service', 'השירות לא היה זמין', 'watching', false, null),
  ('f5100000-0000-4000-8000-000000000006', 'f5000000-0000-4000-8000-000000000001', 'פנייה עם טלפון בלבד', '0505550006', null, 'טיפול פנים', 'service', 'השירות לא היה זמין', 'watching', false, now() + interval '2 days'),
  ('f5100000-0000-4000-8000-000000000007', 'f5000000-0000-4000-8000-000000000001', 'פנייה עם דוא״ל בלבד', null, 'clinic@example.test', 'טיפול פנים', 'service', 'השירות לא היה זמין', 'watching', false, now() + interval '2 days'),
  ('f5100000-0000-4000-8000-000000000008', 'f5000000-0000-4000-8000-000000000001', 'פנייה מתוזמנת', '0505550008', null, 'טיפול פנים', 'timing', 'יכולה רק אחרי 17:00', 'watching', false, now() + interval '2 days');

insert into public.sf_changes (
  id, organization_id, type, service, title, details
)
values (
  'f5300000-0000-4000-8000-000000000001',
  'f5000000-0000-4000-8000-000000000001',
  'service',
  'טיפול פנים',
  'השירות חזר',
  'טיפול הפנים חזר להיות זמין להזמנה'
);

insert into public.sf_recommendations (
  id, organization_id, lead_id, change_id, then_text, now_text, why_text,
  suggested_message, state
)
values
  (
    'f5400000-0000-4000-8000-000000000001',
    'f5000000-0000-4000-8000-000000000001',
    'f5100000-0000-4000-8000-000000000005',
    'f5300000-0000-4000-8000-000000000001',
    'השירות לא היה זמין',
    'טיפול הפנים חזר להיות זמין להזמנה',
    'השירות שביקשה זמין שוב',
    'היי, טיפול הפנים חזר להיות זמין להזמנה. מתאים לבדוק שוב?',
    'review'
  ),
  (
    'f5400000-0000-4000-8000-000000000002',
    'f5000000-0000-4000-8000-000000000001',
    'f5100000-0000-4000-8000-000000000006',
    'f5300000-0000-4000-8000-000000000001',
    'השירות לא היה זמין',
    'טיפול הפנים חזר להיות זמין להזמנה',
    'השירות שביקשה זמין שוב',
    'היי, טיפול הפנים חזר להיות זמין להזמנה. מתאים לבדוק שוב?',
    'review'
  ),
  (
    'f5400000-0000-4000-8000-000000000003',
    'f5000000-0000-4000-8000-000000000001',
    'f5100000-0000-4000-8000-000000000007',
    'f5300000-0000-4000-8000-000000000001',
    'השירות לא היה זמין',
    'טיפול הפנים חזר להיות זמין להזמנה',
    'השירות שביקשה זמין שוב',
    'היי, טיפול הפנים חזר להיות זמין להזמנה. מתאים לבדוק שוב?',
    'review'
  );

-- Simulate the already-approved state used by the send RPC. Moving away from
-- watching must retire the old review schedule before the message is sent.
update public.sf_leads
   set status = 'approval'
 where id in (
   'f5100000-0000-4000-8000-000000000006',
   'f5100000-0000-4000-8000-000000000007'
 );

insert into public.sf_messages (
  id, organization_id, recommendation_id, lead_id, body, status, copied_at
)
values
  (
    'f5500000-0000-4000-8000-000000000002',
    'f5000000-0000-4000-8000-000000000001',
    'f5400000-0000-4000-8000-000000000002',
    'f5100000-0000-4000-8000-000000000006',
    'היי, טיפול הפנים חזר להיות זמין להזמנה. מתאים לבדוק שוב?',
    'copied',
    now()
  ),
  (
    'f5500000-0000-4000-8000-000000000003',
    'f5000000-0000-4000-8000-000000000001',
    'f5400000-0000-4000-8000-000000000003',
    'f5100000-0000-4000-8000-000000000007',
    'היי, טיפול הפנים חזר להיות זמין להזמנה. מתאים לבדוק שוב?',
    'copied',
    now()
  );

insert into public.sf_outcomes (
  id, organization_id, lead_id, response_type, response_text, responded_at,
  contacted_at, booked_at, closed_at, status, revenue_minor, currency,
  revenue_confirmed_at, revenue_confirmed_by
)
values
  (
    'f5200000-0000-4000-8000-000000000001',
    'f5000000-0000-4000-8000-000000000001',
    'f5100000-0000-4000-8000-000000000001',
    'interested', 'כן', now() - interval '4 days', now() - interval '3 days',
    now() - interval '2 days', now() - interval '1 day', 'closed', 100000,
    'ILS', now() - interval '12 hours', '12c216ac-608f-4534-9a78-ff7ca575019a'
  ),
  (
    'f5200000-0000-4000-8000-000000000002',
    'f5000000-0000-4000-8000-000000000001',
    'f5100000-0000-4000-8000-000000000002',
    'interested', 'כן', now() - interval '4 days', now() - interval '3 days',
    now() - interval '2 days', now() - interval '1 day', 'closed', null,
    'ILS', null, null
  ),
  (
    'f5200000-0000-4000-8000-000000000004',
    'f5000000-0000-4000-8000-000000000002',
    'f5100000-0000-4000-8000-000000000004',
    'interested', 'כן', now() - interval '4 days', now() - interval '3 days',
    now() - interval '2 days', now() - interval '1 day', 'closed', null,
    'ILS', null, null
  );

insert into public.sf_activity (organization_id, lead_id, action, details, actor_id)
values
  ('f5000000-0000-4000-8000-000000000001', 'f5100000-0000-4000-8000-000000000001', 'fixture', '{}', '12c216ac-608f-4534-9a78-ff7ca575019a'),
  ('f5000000-0000-4000-8000-000000000002', 'f5100000-0000-4000-8000-000000000004', 'fixture', '{}', '12c216ac-608f-4534-9a78-ff7ca575019a');

do $rpc_privileges$
begin
  if has_function_privilege(
       'anon',
       'public.sf_dismiss_recovery_recommendation(uuid,uuid)',
       'EXECUTE'
     ) or not has_function_privilege(
       'authenticated',
       'public.sf_dismiss_recovery_recommendation(uuid,uuid)',
       'EXECUTE'
     ) then
    raise exception 'ASSERT_DISMISS_RPC_EXECUTE_PRIVILEGES';
  end if;
end
$rpc_privileges$;

set local role authenticated;
set local row_security = on;
select set_config('request.jwt.claim.sub', '12c216ac-608f-4534-9a78-ff7ca575019a', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claims', '{"sub":"12c216ac-608f-4534-9a78-ff7ca575019a","role":"authenticated"}', true);

do $authenticated_boundary$
declare
  affected integer;
  original_confirmed_at timestamptz;
  original_confirmed_by uuid;
begin
  if (select count(*) from public.sf_outcomes) <> 2
     or exists (select 1 from public.sf_outcomes where organization_id = 'f5000000-0000-4000-8000-000000000002')
     or exists (select 1 from public.sf_activity where organization_id = 'f5000000-0000-4000-8000-000000000002') then
    raise exception 'ASSERT_TENANT_SELECT_BOUNDARY';
  end if;

  begin
    insert into public.sf_outcomes (
      organization_id, lead_id, response_type, responded_at, status
    ) values (
      'f5000000-0000-4000-8000-000000000001',
      'f5100000-0000-4000-8000-000000000003',
      'interested', now(), 'returned'
    );
    raise exception 'ASSERT_DIRECT_OUTCOME_INSERT_ALLOWED';
  exception when insufficient_privilege then null;
  end;

  begin
    update public.sf_outcomes set revenue_minor = 999999
     where id = 'f5200000-0000-4000-8000-000000000001';
    raise exception 'ASSERT_DIRECT_OUTCOME_UPDATE_ALLOWED';
  exception when insufficient_privilege then null;
  end;

  begin
    delete from public.sf_outcomes
     where id = 'f5200000-0000-4000-8000-000000000001';
    raise exception 'ASSERT_DIRECT_OUTCOME_DELETE_ALLOWED';
  exception when insufficient_privilege then null;
  end;

  begin
    insert into public.sf_activity (organization_id, action, details, actor_id)
    values ('f5000000-0000-4000-8000-000000000001', 'forged_revenue', '{}', '12c216ac-608f-4534-9a78-ff7ca575019a');
    raise exception 'ASSERT_DIRECT_ACTIVITY_INSERT_ALLOWED';
  exception when insufficient_privilege then null;
  end;

  begin
    update public.sf_activity set action = 'rewritten';
    raise exception 'ASSERT_ACTIVITY_UPDATE_ALLOWED';
  exception when insufficient_privilege then null;
  end;

  begin
    delete from public.sf_activity;
    raise exception 'ASSERT_ACTIVITY_DELETE_ALLOWED';
  exception when insufficient_privilege then null;
  end;

  perform public.sf_report_client_error(
    'f5000000-0000-4000-8000-000000000001',
    jsonb_build_object('id', 'test-error', 'scope', 'rollback-test')
  );
  if not exists (
    select 1 from public.sf_activity
     where organization_id = 'f5000000-0000-4000-8000-000000000001'
       and action = 'client_error'
       and actor_id = '12c216ac-608f-4534-9a78-ff7ca575019a'
  ) then
    raise exception 'ASSERT_SAFE_CLIENT_ERROR_NOT_RECORDED';
  end if;

  begin
    perform public.sf_report_client_error(
      'f5000000-0000-4000-8000-000000000002',
      '{"scope":"foreign"}'::jsonb
    );
    raise exception 'ASSERT_CROSS_TENANT_ERROR_REPORT_ALLOWED';
  exception when insufficient_privilege then
    if position('ORGANIZATION_ACCESS_DENIED' in sqlerrm) = 0 then raise; end if;
  end;

  begin
    update public.sf_leads set status = 'waiting'
     where id = 'f5100000-0000-4000-8000-000000000001';
    raise exception 'ASSERT_DIRECT_LEAD_STATUS_UPDATE_ALLOWED';
  exception when insufficient_privilege then null;
  end;

  update public.sf_leads set name = 'פנייה אמיתית מתוקנת'
   where id = 'f5100000-0000-4000-8000-000000000001';
  if (select name from public.sf_leads where id = 'f5100000-0000-4000-8000-000000000001') <> 'פנייה אמיתית מתוקנת' then
    raise exception 'ASSERT_SAFE_LEAD_CORRECTION_BLOCKED';
  end if;

  -- This column invokes sf_sync_lead_contact_safety. It must remain usable
  -- after direct message/recommendation mutation is revoked from operators.
  update public.sf_leads
     set stopped_reason_text = 'יכולה רק אחרי 18:00'
   where id = 'f5100000-0000-4000-8000-000000000001';
  if (select stopped_reason_text from public.sf_leads where id = 'f5100000-0000-4000-8000-000000000001')
       <> 'יכולה רק אחרי 18:00' then
    raise exception 'ASSERT_TRIGGERED_LEAD_CORRECTION_BLOCKED';
  end if;

  update public.sf_leads
     set dnc = true
   where id = 'f5100000-0000-4000-8000-000000000003';
  if not exists (
    select 1 from public.sf_leads
     where id = 'f5100000-0000-4000-8000-000000000003'
       and dnc
       and status = 'dnc'
  ) then
    raise exception 'ASSERT_TRIGGERED_DNC_BLOCKED';
  end if;

  delete from public.sf_leads
   where id = 'f5100000-0000-4000-8000-000000000001';
  get diagnostics affected = row_count;
  if affected <> 0 then raise exception 'ASSERT_REAL_LEAD_DELETE_ALLOWED'; end if;

  delete from public.sf_leads
   where id = 'f5100000-0000-4000-8000-000000000003';
  get diagnostics affected = row_count;
  if affected <> 1 then raise exception 'ASSERT_DEMO_LEAD_DELETE_BLOCKED'; end if;

  if exists (
    select 1
      from public.sf_leads
     where id in (
       'f5100000-0000-4000-8000-000000000006',
       'f5100000-0000-4000-8000-000000000007'
     )
       and next_review_at is not null
  ) then
    raise exception 'ASSERT_STATUS_CHANGE_DID_NOT_CLEAR_REVIEW_SCHEDULE';
  end if;

  perform public.sf_dismiss_recovery_recommendation(
    'f5000000-0000-4000-8000-000000000001',
    'f5400000-0000-4000-8000-000000000001'
  );
  if not exists (
    select 1
      from public.sf_recommendations recommendation
      join public.sf_leads lead
        on lead.id = recommendation.lead_id
       and lead.organization_id = recommendation.organization_id
     where recommendation.id = 'f5400000-0000-4000-8000-000000000001'
       and recommendation.state = 'dismissed'
       and lead.status = 'watching'
  ) or not exists (
    select 1
      from public.sf_activity
     where organization_id = 'f5000000-0000-4000-8000-000000000001'
       and lead_id = 'f5100000-0000-4000-8000-000000000005'
       and action = 'recovery_recommendation_dismissed'
       and details ->> 'recommendation_id' = 'f5400000-0000-4000-8000-000000000001'
       and actor_id = '12c216ac-608f-4534-9a78-ff7ca575019a'
  ) then
    raise exception 'ASSERT_RECOMMENDATION_DISMISS_NOT_ATOMIC_OR_AUDITED';
  end if;

  begin
    perform public.sf_dismiss_recovery_recommendation(
      'f5000000-0000-4000-8000-000000000001',
      'f5400000-0000-4000-8000-000000000001'
    );
    raise exception 'ASSERT_RECOMMENDATION_DISMISS_RETRY_ALLOWED';
  exception when check_violation then
    if position('RECOMMENDATION_NOT_DISMISSIBLE' in sqlerrm) = 0 then raise; end if;
  end;

  begin
    perform public.sf_dismiss_recovery_recommendation(
      'f5000000-0000-4000-8000-000000000002',
      'f5400000-0000-4000-8000-000000000001'
    );
    raise exception 'ASSERT_CROSS_TENANT_RECOMMENDATION_DISMISS_ALLOWED';
  exception when insufficient_privilege then
    if position('ORGANIZATION_ACCESS_DENIED' in sqlerrm) = 0 then raise; end if;
  end;

  begin
    perform public.sf_dismiss_recovery_recommendation(
      'f5000000-0000-4000-8000-000000000001',
      'f5400000-0000-4000-8000-000000000002'
    );
    raise exception 'ASSERT_ACTIVE_MESSAGE_RECOMMENDATION_DISMISS_ALLOWED';
  exception when check_violation then
    if position('RECOMMENDATION_NOT_DISMISSIBLE' in sqlerrm) = 0 then raise; end if;
  end;

  begin
    perform public.sf_mark_recovery_message_sent(
      'f5000000-0000-4000-8000-000000000001',
      'f5500000-0000-4000-8000-000000000002',
      'email'
    );
    raise exception 'ASSERT_EMAIL_WITHOUT_ADDRESS_WAS_ALLOWED';
  exception when check_violation then
    if position('CONTACT_CHANNEL_UNAVAILABLE' in sqlerrm) = 0 then raise; end if;
  end;
  perform public.sf_mark_recovery_message_sent(
    'f5000000-0000-4000-8000-000000000001',
    'f5500000-0000-4000-8000-000000000002',
    'whatsapp'
  );

  begin
    perform public.sf_mark_recovery_message_sent(
      'f5000000-0000-4000-8000-000000000001',
      'f5500000-0000-4000-8000-000000000003',
      'sms'
    );
    raise exception 'ASSERT_SMS_WITHOUT_PHONE_WAS_ALLOWED';
  exception when check_violation then
    if position('CONTACT_CHANNEL_UNAVAILABLE' in sqlerrm) = 0 then raise; end if;
  end;
  begin
    perform public.sf_mark_recovery_message_sent(
      'f5000000-0000-4000-8000-000000000001',
      'f5500000-0000-4000-8000-000000000003',
      'whatsapp'
    );
    raise exception 'ASSERT_WHATSAPP_WITHOUT_PHONE_WAS_ALLOWED';
  exception when check_violation then
    if position('CONTACT_CHANNEL_UNAVAILABLE' in sqlerrm) = 0 then raise; end if;
  end;
  perform public.sf_mark_recovery_message_sent(
    'f5000000-0000-4000-8000-000000000001',
    'f5500000-0000-4000-8000-000000000003',
    'email'
  );

  if not exists (
    select 1
      from public.sf_messages message
      join public.sf_leads lead
        on lead.id = message.lead_id
       and lead.organization_id = message.organization_id
     where message.id = 'f5500000-0000-4000-8000-000000000002'
       and message.status = 'sent'
       and message.channel = 'whatsapp'
       and lead.status = 'waiting'
  ) or not exists (
    select 1
      from public.sf_messages message
      join public.sf_leads lead
        on lead.id = message.lead_id
       and lead.organization_id = message.organization_id
     where message.id = 'f5500000-0000-4000-8000-000000000003'
       and message.status = 'sent'
       and message.channel = 'email'
       and lead.status = 'waiting'
  ) then
    raise exception 'ASSERT_AVAILABLE_CONTACT_CHANNEL_WAS_BLOCKED';
  end if;

  begin
    perform public.sf_confirm_recovered_revenue(
      'f5000000-0000-4000-8000-000000000001',
      'f5100000-0000-4000-8000-000000000002',
      50000,
      'ILS'
    );
    raise exception 'ASSERT_DEMO_REVENUE_ALLOWED';
  exception when check_violation then
    if position('DEMO_REVENUE_NOT_ALLOWED' in sqlerrm) = 0 then raise; end if;
  end;

  select revenue_confirmed_at, revenue_confirmed_by
    into original_confirmed_at, original_confirmed_by
    from public.sf_outcomes
   where id = 'f5200000-0000-4000-8000-000000000001';

  begin
    perform public.sf_confirm_recovered_revenue(
      'f5000000-0000-4000-8000-000000000001',
      'f5100000-0000-4000-8000-000000000001',
      200000,
      'ILS'
    );
    raise exception 'ASSERT_SECOND_REVENUE_CONFIRMATION_ALLOWED';
  exception when check_violation then
    if position('CONFIRMED_REVENUE_PROVENANCE_IMMUTABLE' in sqlerrm) = 0 then raise; end if;
  end;

  perform public.sf_correct_recovered_revenue(
    'f5000000-0000-4000-8000-000000000001',
    'f5200000-0000-4000-8000-000000000001',
    125000,
    'תיקון לפי אישור המרפאה'
  );
  if not exists (
    select 1 from public.sf_outcomes
     where id = 'f5200000-0000-4000-8000-000000000001'
       and revenue_minor = 125000
       and revenue_confirmed_at = original_confirmed_at
       and revenue_confirmed_by = original_confirmed_by
  ) then
    raise exception 'ASSERT_CORRECTION_LOST_ORIGINAL_PROVENANCE';
  end if;

  perform public.sf_correct_recovered_revenue(
    'f5000000-0000-4000-8000-000000000001',
    'f5200000-0000-4000-8000-000000000001',
    0,
    'ביטול לפי אישור המרפאה'
  );
  if not exists (
    select 1 from public.sf_outcomes
     where id = 'f5200000-0000-4000-8000-000000000001'
       and revenue_minor = 0
       and revenue_confirmed_at = original_confirmed_at
       and revenue_confirmed_by = original_confirmed_by
  ) or not exists (
    select 1 from public.sf_activity
     where organization_id = 'f5000000-0000-4000-8000-000000000001'
       and lead_id = 'f5100000-0000-4000-8000-000000000001'
       and action = 'recovered_revenue_voided'
       and (details ->> 'previous_revenue_minor')::bigint = 125000
       and (details ->> 'new_revenue_minor')::bigint = 0
       and details ->> 'reason' = 'ביטול לפי אישור המרפאה'
       and actor_id = '12c216ac-608f-4534-9a78-ff7ca575019a'
  ) then
    raise exception 'ASSERT_REVENUE_VOID_NOT_PRESERVED_OR_AUDITED';
  end if;

  perform public.sf_correct_recovered_revenue(
    'f5000000-0000-4000-8000-000000000001',
    'f5200000-0000-4000-8000-000000000001',
    99000,
    'אישור סכום חדש מהמרפאה'
  );
  if not exists (
    select 1 from public.sf_outcomes
     where id = 'f5200000-0000-4000-8000-000000000001'
       and revenue_minor = 99000
       and revenue_confirmed_at = original_confirmed_at
       and revenue_confirmed_by = original_confirmed_by
  ) or not exists (
    select 1 from public.sf_activity
     where organization_id = 'f5000000-0000-4000-8000-000000000001'
       and lead_id = 'f5100000-0000-4000-8000-000000000001'
       and action = 'recovered_revenue_corrected'
       and (details ->> 'previous_revenue_minor')::bigint = 0
       and (details ->> 'new_revenue_minor')::bigint = 99000
  ) then
    raise exception 'ASSERT_POSITIVE_REVENUE_CORRECTION_REGRESSED';
  end if;

  begin
    perform public.sf_correct_recovered_revenue(
      'f5000000-0000-4000-8000-000000000001',
      'f5200000-0000-4000-8000-000000000001',
      -1,
      'סכום שלילי אסור'
    );
    raise exception 'ASSERT_NEGATIVE_REVENUE_CORRECTION_ALLOWED';
  exception when invalid_parameter_value then
    if position('NON_NEGATIVE_REVENUE_REQUIRED' in sqlerrm) = 0 then raise; end if;
  end;
end
$authenticated_boundary$;

reset role;

do $privileged_invariants$
begin
  update public.sf_leads
     set status = 'watching',
         next_review_at = now() + interval '3 days'
   where id = 'f5100000-0000-4000-8000-000000000008';
  if not exists (
    select 1 from public.sf_leads
     where id = 'f5100000-0000-4000-8000-000000000008'
       and status = 'watching'
       and next_review_at is not null
  ) then
    raise exception 'ASSERT_WATCHING_SCHEDULE_WAS_CLEARED';
  end if;

  update public.sf_leads
     set status = 'approval'
   where id = 'f5100000-0000-4000-8000-000000000008';
  if exists (
    select 1 from public.sf_leads
     where id = 'f5100000-0000-4000-8000-000000000008'
       and next_review_at is not null
  ) then
    raise exception 'ASSERT_NON_WATCHING_SCHEDULE_WAS_PRESERVED';
  end if;

  begin
    update public.sf_outcomes
       set revenue_minor = null,
           revenue_confirmed_at = null,
           revenue_confirmed_by = null
     where id = 'f5200000-0000-4000-8000-000000000001';
    raise exception 'ASSERT_CONFIRMED_OUTCOME_RESET_ALLOWED';
  exception when check_violation then
    if position('CONFIRMED_REVENUE_PROVENANCE_IMMUTABLE' in sqlerrm) = 0 then raise; end if;
  end;

  begin
    update public.sf_leads
       set organization_id = 'f5000000-0000-4000-8000-000000000002'
     where id = 'f5100000-0000-4000-8000-000000000001';
    raise exception 'ASSERT_ORGANIZATION_MOVE_ALLOWED';
  exception when check_violation then
    if position('ORGANIZATION_IMMUTABLE' in sqlerrm) = 0 then raise; end if;
  end;

  begin
    insert into public.sf_outcomes (
      organization_id, lead_id, response_type, responded_at, contacted_at,
      booked_at, status
    ) values (
      'f5000000-0000-4000-8000-000000000001',
      'f5100000-0000-4000-8000-000000000003',
      'interested', now(), now() - interval '1 day', now() - interval '2 days',
      'booked'
    );
    raise exception 'ASSERT_INVALID_OUTCOME_LIFECYCLE_ALLOWED';
  exception when check_violation then null;
  end;
end
$privileged_invariants$;

rollback;

select
  not exists (
    select 1 from public.shuv_organizations
     where id in (
       'f5000000-0000-4000-8000-000000000001',
       'f5000000-0000-4000-8000-000000000002'
     )
  ) as rolled_back,
  'SHUV_FLOW_SECURITY_BOUNDARY_PASS'::text as result;
