-- Lead corrections are intentionally allowed through a narrow column grant.
-- The safety trigger must still be able to retire related messages and
-- recommendations after those broader tables were made RPC-only.
--
-- The caller can reach this trigger only after the sf_leads UPDATE privilege
-- and tenant RLS policy have accepted the row. organization_id is separately
-- immutable, so running the trigger as its owner cannot widen tenant access.
alter function public.sf_sync_lead_contact_safety() security definer;
alter function public.sf_sync_lead_contact_safety()
  set search_path = pg_catalog, public;

revoke all on function public.sf_sync_lead_contact_safety()
  from public, anon, authenticated;

comment on function public.sf_sync_lead_contact_safety() is
  'Tenant-gated lead update trigger that retires stale contact work after a safe correction or DNC change.';
