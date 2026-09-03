-- Shuv Flow product recovery integration test.
--
-- This script is intentionally rollback-only. It requires a confirmed Auth
-- user that is reserved for QA. Replace qa_user below if the canonical QA user
-- changes. Success is one final row with rolled_back = true. Any failed
-- assertion aborts before that row is returned and the connection rolls back.

begin;
set local statement_timeout = '45s';
set local lock_timeout = '5s';

do $fixture_check$
begin
  if not exists (
    select 1
      from auth.users
     where id = '12c216ac-608f-4534-9a78-ff7ca575019a'::uuid
  ) then
    raise exception 'QA_AUTH_USER_NOT_FOUND';
  end if;
end
$fixture_check$;

-- Two isolated organizations. Only organization A receives a membership.
insert into public.shuv_organizations (id, name, created_by)
values
  (
    'f1000000-0000-4000-8000-000000000001'::uuid,
    'SF rollback integration A ' || txid_current()::text,
    '12c216ac-608f-4534-9a78-ff7ca575019a'::uuid
  ),
  (
    'f1000000-0000-4000-8000-000000000002'::uuid,
    'SF rollback integration B ' || txid_current()::text,
    '12c216ac-608f-4534-9a78-ff7ca575019a'::uuid
  );

insert into public.shuv_memberships (organization_id, user_id, role)
values (
  'f1000000-0000-4000-8000-000000000001'::uuid,
  '12c216ac-608f-4534-9a78-ff7ca575019a'::uuid,
  'owner'
);

-- Protect the tenant-isolation fixture even if a future organization trigger
-- starts creating memberships automatically.
delete from public.shuv_memberships
 where organization_id = 'f1000000-0000-4000-8000-000000000002'::uuid;

insert into public.sf_clinics (
  organization_id, clinic_name, main_service, onboarding_completed
)
values
  (
    'f1000000-0000-4000-8000-000000000001'::uuid,
    'מרפאת בדיקה א',
    'טיפול פנים',
    true
  ),
  (
    'f1000000-0000-4000-8000-000000000002'::uuid,
    'מרפאת בדיקה ב',
    'טיפול פנים',
    true
  );

-- This row must be invisible to the QA user.
insert into public.sf_leads (
  id, organization_id, name, phone, service, stopped_reason_code,
  stopped_reason_text, status
)
values (
  'f2000000-0000-4000-8000-000000000001'::uuid,
  'f1000000-0000-4000-8000-000000000002'::uuid,
  'ליד של מרפאה אחרת',
  '0509990001',
  'טיפול פנים',
  'timing',
  'יכולה להגיע רק בערב',
  'watching'
);

-- Synthetic naturally-expired recommendation. Triggers are disabled only for
-- this fixture row and only inside this rollback-only transaction. This lets
-- the test exercise sf_reconcile_recommendation_focus without waiting for real
-- wall-clock time to pass (now() is stable for a transaction).
insert into public.sf_leads (
  id, organization_id, name, phone, service, stopped_reason_code,
  stopped_reason_text, preferred_time, status
)
values (
  'f2000000-0000-4000-8000-000000000002'::uuid,
  'f1000000-0000-4000-8000-000000000001'::uuid,
  'ליד עם המלצה שפגה',
  '0509990002',
  'טיפול פנים',
  'timing',
  'יכולה להגיע רק אחרי 17:00',
  'אחרי 17:00',
  'watching'
);

insert into public.sf_changes (
  id, organization_id, type, service, starts_at, ends_at, title, details
)
values (
  'f3000000-0000-4000-8000-000000000001'::uuid,
  'f1000000-0000-4000-8000-000000000001'::uuid,
  'slot',
  'טיפול פנים',
  now() - interval '2 days',
  now() - interval '2 days' + interval '45 minutes',
  'התפנה תור',
  'התפנה תור: מועד שכבר עבר'
);

set local session_replication_role = replica;
insert into public.sf_recommendations (
  id, organization_id, lead_id, change_id, then_text, now_text, why_text,
  suggested_message, state, expires_at
)
values (
  'f4000000-0000-4000-8000-000000000001'::uuid,
  'f1000000-0000-4000-8000-000000000001'::uuid,
  'f2000000-0000-4000-8000-000000000002'::uuid,
  'f3000000-0000-4000-8000-000000000001'::uuid,
  'יכולה להגיע רק אחרי 17:00',
  'התפנה תור: מועד שכבר עבר',
  'הסיבה הייתה רלוונטית בעבר',
  'היי, התפנה תור: מועד שכבר עבר. האם זה מתאים?',
  'review',
  now() - interval '1 day'
);
set local session_replication_role = origin;

set local role authenticated;
set local row_security = on;
select set_config(
  'request.jwt.claim.sub',
  '12c216ac-608f-4534-9a78-ff7ca575019a',
  true
);
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config(
  'request.jwt.claims',
  '{"sub":"12c216ac-608f-4534-9a78-ff7ca575019a","role":"authenticated"}',
  true
);

do $integration$
declare
  v_org constant uuid := 'f1000000-0000-4000-8000-000000000001'::uuid;
  v_other_org constant uuid := 'f1000000-0000-4000-8000-000000000002'::uuid;
  v_user constant uuid := '12c216ac-608f-4534-9a78-ff7ca575019a'::uuid;
  v_stale_lead constant uuid := 'f2000000-0000-4000-8000-000000000002'::uuid;
  v_stale_recommendation constant uuid := 'f4000000-0000-4000-8000-000000000001'::uuid;
  v_lead uuid;
  v_change uuid;
  v_recommendation uuid;
  v_message uuid;
  v_dnc_lead uuid;
  v_medical_lead uuid;
  v_medical_recommendation uuid;
  v_medical_message uuid;
  v_duplicate_lead uuid;
  v_new_change uuid;
  v_new_recommendation uuid;
  v_start timestamptz;
  v_end timestamptz;
  v_now_text text;
begin
  -- Tenant isolation: SELECT hides foreign rows, INSERT and RPC are denied.
  if exists (
    select 1 from public.sf_leads where organization_id = v_other_org
  ) then
    raise exception 'ASSERT_TENANT_SELECT_LEAK';
  end if;

  begin
    insert into public.sf_leads (
      organization_id, name, phone, service, stopped_reason_code,
      stopped_reason_text
    ) values (
      v_other_org, 'ניסיון חוצה ארגון', '0509990003', 'טיפול פנים',
      'timing', 'יכולה להגיע רק בערב'
    );
    raise exception 'ASSERT_TENANT_INSERT_WAS_ALLOWED';
  exception
    when insufficient_privilege then null;
  end;

  begin
    perform public.sf_prepare_recovery_message(
      v_other_org,
      v_stale_recommendation
    );
    raise exception 'ASSERT_TENANT_RPC_WAS_ALLOWED';
  exception
    when insufficient_privilege then
      if position('ORGANIZATION_ACCESS_DENIED' in sqlerrm) = 0 then
        raise;
      end if;
  end;

  -- A concrete evening slot and one eligible lead.
  v_start := (
    date_trunc('day', now() at time zone 'Asia/Jerusalem')
      + interval '7 days 18 hours'
  ) at time zone 'Asia/Jerusalem';
  v_end := v_start + interval '45 minutes';

  insert into public.sf_leads (
    organization_id, name, phone, service, value_minor,
    stopped_reason_code, stopped_reason_text, preferred_time, status
  ) values (
    v_org, 'נועה לוי', '0501110001', 'טיפול פנים', 125000,
    'timing', 'יכולה להגיע רק אחרי 17:00', 'אחרי 17:00', 'watching'
  ) returning id into v_lead;

  insert into public.sf_changes (
    organization_id, type, service, starts_at, ends_at, title, details
  ) values (
    v_org,
    'slot',
    'טיפול פנים',
    v_start,
    v_end,
    'התפנה תור',
    'התפנה תור: ' || to_char(
      v_start at time zone 'Asia/Jerusalem',
      'FMDD.FMMM HH24:MI'
    )
  ) returning id, details into v_change, v_now_text;

  insert into public.sf_recommendations (
    organization_id, lead_id, change_id, then_text, now_text, why_text,
    suggested_message, expires_at
  ) values (
    v_org,
    v_lead,
    v_change,
    'יכולה להגיע רק אחרי 17:00',
    v_now_text,
    'יש התאמה מדויקת לשעה שביקשה',
    'היי נועה, ' || v_now_text || '. האם זה מתאים לך?',
    v_start
  ) returning id into v_recommendation;

  -- Preparing is atomic and idempotent.
  perform public.sf_prepare_recovery_message(v_org, v_recommendation);
  select id into strict v_message
    from public.sf_messages
   where recommendation_id = v_recommendation;
  perform public.sf_prepare_recovery_message(v_org, v_recommendation);

  if (select count(*) from public.sf_messages where lead_id = v_lead) <> 1
     or (select status from public.sf_leads where id = v_lead) <> 'approval'
     or (select status from public.sf_messages where id = v_message) <> 'draft' then
    raise exception 'ASSERT_PREPARE_NOT_ATOMIC_OR_IDEMPOTENT';
  end if;

  -- A message cannot be marked sent before explicit copy/approval.
  begin
    perform public.sf_mark_recovery_message_sent(v_org, v_message, 'whatsapp');
    raise exception 'ASSERT_UNAPPROVED_MESSAGE_WAS_SENT';
  exception
    when check_violation then
      if position('MESSAGE_NOT_APPROVED' in sqlerrm) = 0 then
        raise;
      end if;
  end;

  update public.sf_messages
     set status = 'copied', copied_at = now()
   where id = v_message;
  perform public.sf_mark_recovery_message_sent(v_org, v_message, 'whatsapp');

  if (select status from public.sf_leads where id = v_lead) <> 'waiting'
     or (select status from public.sf_messages where id = v_message) <> 'sent' then
    raise exception 'ASSERT_MARK_SENT_NOT_ATOMIC';
  end if;

  perform public.sf_record_recovery_response(
    v_org,
    v_message,
    'interested',
    'כן, אשמח לקבוע'
  );

  -- Booking before the human-contacted step is illegal.
  begin
    perform public.sf_advance_recovery_lead(v_org, v_lead, 'booked');
    raise exception 'ASSERT_INVALID_BOOKING_TRANSITION_WAS_ALLOWED';
  exception
    when check_violation then
      if position('INVALID_RECOVERY_TRANSITION' in sqlerrm) = 0 then
        raise;
      end if;
  end;

  perform public.sf_advance_recovery_lead(v_org, v_lead, 'contacted');
  perform public.sf_advance_recovery_lead(v_org, v_lead, 'booked');
  perform public.sf_advance_recovery_lead(v_org, v_lead, 'closed');
  perform public.sf_confirm_recovered_revenue(v_org, v_lead, 125000, 'ILS');

  if not exists (
    select 1
      from public.sf_leads lead
      join public.sf_messages message on message.lead_id = lead.id
      join public.sf_recommendations recommendation
        on recommendation.id = message.recommendation_id
      join public.sf_outcomes outcome on outcome.lead_id = lead.id
     where lead.id = v_lead
       and lead.status = 'closed'
       and message.status = 'resolved'
       and message.sent_at is not null
       and recommendation.state = 'dismissed'
       and outcome.response_type = 'interested'
       and outcome.status = 'closed'
       and outcome.contacted_at is not null
       and outcome.booked_at is not null
       and outcome.closed_at is not null
       and outcome.revenue_minor = 125000
       and outcome.currency = 'ILS'
       and outcome.revenue_confirmed_at is not null
       and outcome.revenue_confirmed_by = v_user
  ) then
    raise exception 'ASSERT_HAPPY_PATH_FINAL_STATE';
  end if;

  -- DNC is derived from text and can never enter a recommendation flow.
  insert into public.sf_leads (
    organization_id, name, phone, service, stopped_reason_code,
    stopped_reason_text, notes, status
  ) values (
    v_org, 'דנה חסומה', '0501110002', 'טיפול פנים', 'timing',
    'יכולה להגיע רק אחרי 17:00', 'ביקשה לא ליצור קשר', 'watching'
  ) returning id into v_dnc_lead;

  if not exists (
    select 1 from public.sf_leads
     where id = v_dnc_lead and dnc and status = 'dnc'
  ) then
    raise exception 'ASSERT_DNC_NOT_DERIVED';
  end if;

  begin
    insert into public.sf_recommendations (
      organization_id, lead_id, change_id, then_text, now_text, why_text,
      suggested_message, expires_at
    ) values (
      v_org, v_dnc_lead, v_change, 'יכולה להגיע רק אחרי 17:00',
      v_now_text, 'לכאורה יש התאמה',
      'היי דנה, ' || v_now_text || '. האם זה מתאים לך?', v_start
    );
    raise exception 'ASSERT_DNC_RECOMMENDATION_WAS_ALLOWED';
  exception
    when check_violation then
      if position('CONTACT_NOT_ALLOWED' in sqlerrm) = 0 then
        raise;
      end if;
  end;

  -- Medical content in a reply is diverted from the sales funnel.
  insert into public.sf_leads (
    organization_id, name, phone, service, stopped_reason_code,
    stopped_reason_text, preferred_time, status
  ) values (
    v_org, 'מיכל כהן', '0501110003', 'טיפול פנים', 'timing',
    'יכולה להגיע רק אחרי 17:00', 'אחרי 17:00', 'watching'
  ) returning id into v_medical_lead;

  insert into public.sf_recommendations (
    organization_id, lead_id, change_id, then_text, now_text, why_text,
    suggested_message, expires_at
  ) values (
    v_org, v_medical_lead, v_change, 'יכולה להגיע רק אחרי 17:00',
    v_now_text, 'יש התאמה מדויקת לשעה שביקשה',
    'היי מיכל, ' || v_now_text || '. האם זה מתאים לך?', v_start
  ) returning id into v_medical_recommendation;

  perform public.sf_prepare_recovery_message(v_org, v_medical_recommendation);
  select id into strict v_medical_message
    from public.sf_messages
   where recommendation_id = v_medical_recommendation;
  update public.sf_messages
     set status = 'copied', copied_at = now()
   where id = v_medical_message;
  perform public.sf_mark_recovery_message_sent(
    v_org,
    v_medical_message,
    'whatsapp'
  );
  perform public.sf_record_recovery_response(
    v_org,
    v_medical_message,
    'interested',
    'אני בהריון ורוצה להבין אם הטיפול מתאים'
  );

  if not exists (
    select 1
      from public.sf_leads lead
      join public.sf_outcomes outcome on outcome.lead_id = lead.id
      join public.sf_messages message on message.lead_id = lead.id
     where lead.id = v_medical_lead
       and lead.medical_escalation
       and lead.needs_fix
       and lead.status = 'medical_review'
       and outcome.response_type = 'medical_review'
       and outcome.status = 'medical_review'
       and message.status = 'resolved'
  ) then
    raise exception 'ASSERT_MEDICAL_RESPONSE_NOT_ESCALATED';
  end if;

  begin
    perform public.sf_advance_recovery_lead(
      v_org,
      v_medical_lead,
      'contacted'
    );
    raise exception 'ASSERT_MEDICAL_LEAD_ADVANCED';
  exception
    when check_violation then
      if position('RECOVERY_PROGRESS_BLOCKED' in sqlerrm) = 0 then
        raise;
      end if;
  end;

  -- Real lead identity is unique after phone normalization and email folding.
  insert into public.sf_leads (
    organization_id, name, phone, email, service, stopped_reason_code,
    stopped_reason_text
  ) values (
    v_org, 'כפילות מקור', '050-123-4567', 'Dup@Test.Example',
    'טיפול פנים', 'no_response', 'לא חזרה להודעה'
  ) returning id into v_duplicate_lead;

  begin
    insert into public.sf_leads (
      organization_id, name, phone, email, service, stopped_reason_code,
      stopped_reason_text
    ) values (
      v_org, 'כפילות טלפון', '+972 50 123 4567', 'other@test.example',
      'טיפול פנים', 'no_response', 'לא חזרה להודעה'
    );
    raise exception 'ASSERT_DUPLICATE_PHONE_WAS_ALLOWED';
  exception
    when unique_violation then
      if position('sf_leads_org_phone_identity_uq' in sqlerrm) = 0 then
        raise;
      end if;
  end;

  begin
    insert into public.sf_leads (
      organization_id, name, phone, email, service, stopped_reason_code,
      stopped_reason_text
    ) values (
      v_org, 'כפילות אימייל', '0521234567', '  dup@test.example ',
      'טיפול פנים', 'no_response', 'לא חזרה להודעה'
    );
    raise exception 'ASSERT_DUPLICATE_EMAIL_WAS_ALLOWED';
  exception
    when unique_violation then
      if position('sf_leads_org_email_identity_uq' in sqlerrm) = 0 then
        raise;
      end if;
  end;

  -- A naturally stale review row is expired automatically before a new,
  -- concrete event is accepted for the same lead.
  insert into public.sf_changes (
    organization_id, type, service, starts_at, ends_at, title, details
  ) values (
    v_org,
    'slot',
    'טיפול פנים',
    v_start,
    v_end,
    'התפנה תור חדש',
    'התפנה תור חדש: ' || to_char(
      v_start at time zone 'Asia/Jerusalem',
      'FMDD.FMMM HH24:MI'
    )
  ) returning id, details into v_new_change, v_now_text;

  insert into public.sf_recommendations (
    organization_id, lead_id, change_id, then_text, now_text, why_text,
    suggested_message, expires_at
  ) values (
    v_org,
    v_stale_lead,
    v_new_change,
    'יכולה להגיע רק אחרי 17:00',
    v_now_text,
    'זהו אירוע חדש שמתאים לבקשה',
    'היי, ' || v_now_text || '. האם זה מתאים לך?',
    v_start
  ) returning id into v_new_recommendation;

  if (select state from public.sf_recommendations where id = v_stale_recommendation) <> 'expired'
     or (select state from public.sf_recommendations where id = v_new_recommendation) <> 'review' then
    raise exception 'ASSERT_STALE_RECOMMENDATION_BLOCKED_NEW_EVENT';
  end if;

  -- All audit records created by product RPCs identify the authenticated actor.
  if exists (
    select 1
      from public.sf_activity
     where organization_id = v_org
       and action in (
         'recovery_message_prepared',
         'recovery_message_sent',
         'recovery_response_recorded',
         'recovery_lead_advanced',
         'recovered_revenue_confirmed'
       )
       and actor_id is distinct from v_user
  ) then
    raise exception 'ASSERT_ACTIVITY_ACTOR_MISMATCH';
  end if;

  raise notice 'SHUV_FLOW_PRODUCT_RECOVERY_INTEGRATION_PASS';
end
$integration$;

reset role;
rollback;

select
  not exists (
    select 1
      from public.shuv_organizations
     where id in (
       'f1000000-0000-4000-8000-000000000001'::uuid,
       'f1000000-0000-4000-8000-000000000002'::uuid
     )
  ) as rolled_back,
  'SHUV_FLOW_PRODUCT_RECOVERY_INTEGRATION_PASS'::text as result;
