-- Follow-up hardening after running Supabase advisors.

-- The recovered product no longer calls the legacy sales-control RPCs directly.
revoke execute on function public.shuv_import_leads(uuid, text, text, jsonb) from authenticated, anon;
revoke execute on function public.shuv_queue_message(uuid, integer, text, text, text, text, timestamptz, text) from authenticated, anon;
revoke execute on function public.shuv_record_manual_inbound(uuid, integer, text, text, text, text) from authenticated, anon;
revoke execute on function public.shuv_transition_lead(uuid, integer, text, text, text, numeric, text, text, text) from authenticated, anon;
revoke execute on function public.shuv_update_pilot_settings(uuid, integer, boolean, boolean, boolean, boolean, smallint, smallint, time, time, text, numeric) from authenticated, anon;

-- Composite indexes cover the tenant-aware foreign keys used by the new domain.
create index if not exists sf_activity_org_lead_idx
  on public.sf_activity (organization_id, lead_id);
create index if not exists sf_messages_org_lead_idx
  on public.sf_messages (organization_id, lead_id);
create index if not exists sf_messages_org_recommendation_idx
  on public.sf_messages (organization_id, recommendation_id);
create index if not exists sf_outcomes_org_lead_idx
  on public.sf_outcomes (organization_id, lead_id);
create index if not exists sf_outcomes_confirmed_by_idx
  on public.sf_outcomes (revenue_confirmed_by);
create index if not exists sf_recommendations_org_change_idx
  on public.sf_recommendations (organization_id, change_id);
create index if not exists sf_recommendations_org_lead_idx
  on public.sf_recommendations (organization_id, lead_id);
