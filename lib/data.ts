import type { SupabaseClient, User } from "@supabase/supabase-js";
import { DEMO_LEADS } from "./demo";
import {
  consolidateImportLeads,
  hasMedicalEscalation,
  normalizeEmail,
  normalizePhone,
} from "./lead-safety";
import { canMatchLead, concreteChangeDetails, makeRecommendation } from "./matching";
import { isDueRequestedContact } from "./priorities";
import { isRecommendationActive } from "./today-flow";
import type {
  BusinessChange,
  ChangeType,
  Clinic,
  ImportLead,
  Lead,
  Outcome,
  OutreachMessage,
  Recommendation,
} from "./types";

export interface WorkspaceContext {
  user: User;
  organizationId: string;
  clinic: Clinic | null;
  role: "owner" | "admin" | "operator" | null;
}

function throwIfError(error: { message: string } | null) {
  if (error) throw new Error(error.message);
}

export async function currentWorkspace(client: SupabaseClient): Promise<WorkspaceContext | null> {
  const { data: userData, error: userError } = await client.auth.getUser();
  throwIfError(userError);
  if (!userData.user) return null;

  const { data: membership, error: membershipError } = await client
    .from("shuv_memberships")
    .select("organization_id, joined_at, role")
    .eq("user_id", userData.user.id)
    .order("joined_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  throwIfError(membershipError);
  if (!membership) return { user: userData.user, organizationId: "", clinic: null, role: null };

  const { data: clinic, error: clinicError } = await client
    .from("sf_clinics")
    .select("*")
    .eq("organization_id", membership.organization_id)
    .maybeSingle();
  throwIfError(clinicError);
  return {
    user: userData.user,
    organizationId: membership.organization_id,
    clinic: (clinic as Clinic | null) ?? null,
    role: membership.role === "owner" || membership.role === "admin" || membership.role === "operator"
      ? membership.role
      : null,
  };
}

export async function bootstrapClinic(
  client: SupabaseClient,
  clinicName: string,
  mainService: string,
): Promise<WorkspaceContext> {
  const { data: org, error: orgError } = await client.rpc("shuv_bootstrap_organization", {
    p_name: clinicName.trim(),
  });
  throwIfError(orgError);
  const organizationId = (org as { id: string }).id;
  const { error: clinicError } = await client.from("sf_clinics").upsert({
    organization_id: organizationId,
    clinic_name: clinicName.trim(),
    main_service: mainService.trim(),
    onboarding_completed: false,
  });
  throwIfError(clinicError);
  const { data: userData } = await client.auth.getUser();
  if (!userData.user) throw new Error("AUTH_REQUIRED");
  return {
    user: userData.user,
    organizationId,
    role: "owner",
    clinic: {
      organization_id: organizationId,
      clinic_name: clinicName.trim(),
      main_service: mainService.trim(),
      onboarding_completed: false,
    },
  };
}

function toLeadRow(organizationId: string, lead: ImportLead, isDemo: boolean) {
  const stoppedCode = lead.stopped_reason_code || "unknown";
  const dnc = Boolean(lead.dnc);
  return {
    organization_id: organizationId,
    external_ref: lead.external_ref || null,
    name: lead.name.trim() || "פנייה ללא שם",
    phone: normalizePhone(lead.phone) || null,
    email: normalizeEmail(lead.email) || null,
    service: lead.service.trim() || "לא צוין שירות",
    value_minor: lead.value_minor || 0,
    last_contact_at: lead.last_contact_at || null,
    notes: lead.notes || "",
    branch: lead.branch || null,
    dnc,
    medical_escalation: Boolean(lead.medical_escalation) || hasMedicalEscalation(`${lead.stopped_reason_text || ""} ${lead.notes || ""}`),
    is_demo: isDemo,
    needs_fix: Boolean(lead.needs_fix),
    stopped_reason_code: stoppedCode,
    stopped_reason_text: lead.stopped_reason_text || "לא ידוע למה הפנייה נעצרה",
    preferred_time: lead.preferred_time || null,
    requested_contact_after: lead.requested_contact_after || null,
    status: dnc ? "dnc" : "watching",
  };
}

export async function loadDemoLeads(client: SupabaseClient, organizationId: string): Promise<Lead[]> {
  const rows = DEMO_LEADS.map((lead) => toLeadRow(organizationId, lead, true));
  return importLeadRows(client, organizationId, rows);
}

export interface ImportResult {
  leads: Lead[];
  inserted: number;
  updated: number;
  unchanged: number;
}

function importResult(data: unknown): ImportResult {
  const result = data as Partial<ImportResult> | null;
  if (
    !result
    || typeof result !== "object"
    || !Array.isArray(result.leads)
    || !Number.isInteger(result.inserted)
    || !Number.isInteger(result.updated)
    || !Number.isInteger(result.unchanged)
    || Number(result.inserted) < 0
    || Number(result.updated) < 0
    || Number(result.unchanged) < 0
  ) {
    throw new Error("INVALID_IMPORT_RESPONSE");
  }
  return result as ImportResult;
}

async function importLeadRows(
  client: SupabaseClient,
  organizationId: string,
  rows: ReturnType<typeof toLeadRow>[],
): Promise<Lead[]> {
  return (await importLeadRowsWithSummary(client, organizationId, rows)).leads;
}

async function importLeadRowsWithSummary(
  client: SupabaseClient,
  organizationId: string,
  rows: ReturnType<typeof toLeadRow>[],
): Promise<ImportResult> {
  const { data, error } = await client.rpc("sf_import_leads", {
    p_organization_id: organizationId,
    p_leads: rows,
  });
  throwIfError(error);
  return importResult(data);
}

export async function importLeads(
  client: SupabaseClient,
  organizationId: string,
  leads: ImportLead[],
): Promise<Lead[]> {
  const batch = consolidateImportLeads(leads);
  const rows = batch.map((candidate) => toLeadRow(organizationId, candidate.lead, false));
  return importLeadRows(client, organizationId, rows);
}

export async function importLeadsWithSummary(
  client: SupabaseClient,
  organizationId: string,
  leads: ImportLead[],
): Promise<ImportResult> {
  const batch = consolidateImportLeads(leads);
  const rows = batch.map((candidate) => toLeadRow(organizationId, candidate.lead, false));
  return importLeadRowsWithSummary(client, organizationId, rows);
}

export async function finishOnboarding(client: SupabaseClient, organizationId: string) {
  const { error } = await client
    .from("sf_clinics")
    .update({ onboarding_completed: true })
    .eq("organization_id", organizationId);
  throwIfError(error);
}

export async function listLeads(client: SupabaseClient, organizationId: string): Promise<Lead[]> {
  const { data, error } = await client
    .from("sf_leads")
    .select("*")
    .eq("organization_id", organizationId)
    .order("created_at", { ascending: false });
  throwIfError(error);
  return (data || []) as Lead[];
}

export async function listRecommendations(
  client: SupabaseClient,
  organizationId: string,
): Promise<Recommendation[]> {
  const { data, error } = await client
    .from("sf_recommendations")
    .select("*, lead:sf_leads(*), change:sf_changes(*)")
    .eq("organization_id", organizationId)
    .eq("state", "review")
    .order("created_at", { ascending: false });
  throwIfError(error);
  return (data || []) as unknown as Recommendation[];
}

export async function listMessages(
  client: SupabaseClient,
  organizationId: string,
): Promise<OutreachMessage[]> {
  const { data, error } = await client
    .from("sf_messages")
    .select("*")
    .eq("organization_id", organizationId)
    .order("created_at", { ascending: false });
  throwIfError(error);
  return (data || []) as OutreachMessage[];
}

export async function listOutcomes(client: SupabaseClient, organizationId: string): Promise<Outcome[]> {
  const { data, error } = await client
    .from("sf_outcomes")
    .select("*, lead:sf_leads(*)")
    .eq("organization_id", organizationId)
    .order("updated_at", { ascending: false });
  throwIfError(error);
  return (data || []) as unknown as Outcome[];
}

export interface NewChangeInput {
  type: ChangeType;
  service: string;
  branch?: string;
  startsAt?: string;
  endsAt?: string;
  title: string;
  details: string;
}

function randomUuid(): string {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((value) => value.toString(16).padStart(2, "0"));
  return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10).join("")}`;
}

function changeMatchResult(data: unknown): { change: BusinessChange; recommendations: Recommendation[]; checked: number } {
  if (!data || typeof data !== "object") throw new Error("INVALID_CHANGE_RESPONSE");
  const result = data as { change?: BusinessChange; recommendations?: Recommendation[]; checked?: number };
  if (!result.change || !Array.isArray(result.recommendations) || typeof result.checked !== "number") {
    throw new Error("INVALID_CHANGE_RESPONSE");
  }
  return result as { change: BusinessChange; recommendations: Recommendation[]; checked: number };
}

export async function createChangeAndMatch(
  client: SupabaseClient,
  organizationId: string,
  input: NewChangeInput,
): Promise<{ change: BusinessChange; recommendations: Recommendation[]; checked: number }> {
  const startsAt = input.startsAt || null;
  const endsAt = input.endsAt || null;
  const details = concreteChangeDetails({
    type: input.type,
    title: input.title,
    details: input.details,
    starts_at: startsAt,
    ends_at: endsAt,
  });
  const change: BusinessChange = {
    id: randomUuid(),
    organization_id: organizationId,
    type: input.type,
    service: input.service,
    branch: input.branch || null,
    starts_at: startsAt,
    ends_at: endsAt,
    title: input.title,
    details,
    is_demo: false,
    created_at: new Date().toISOString(),
  };
  const [leads, existingRecommendations] = await Promise.all([
    listLeads(client, organizationId),
    listRecommendations(client, organizationId),
  ]);
  const activeLeadIds = new Set(existingRecommendations
    .filter((recommendation) => isRecommendationActive(recommendation))
    .map((recommendation) => recommendation.lead_id));
  const matched = leads.filter((lead) => !activeLeadIds.has(lead.id) && canMatchLead(lead, change));
  const rows = matched.map((lead) => makeRecommendation(lead, change));
  const { data, error } = await client.rpc("sf_create_change_and_match", {
    p_organization_id: organizationId,
    p_change: change,
    p_recommendations: rows,
  });
  throwIfError(error);
  return changeMatchResult(data);
}

export async function ensureDueRequestedContactMatches(
  client: SupabaseClient,
  organizationId: string,
  leads: Lead[],
): Promise<{ changeId: string; count: number } | null> {
  const dueLeadIds = new Set(leads.filter((lead) => isDueRequestedContact(lead)).map((lead) => lead.id));
  if (!dueLeadIds.size) return null;

  const existing = (await listRecommendations(client, organizationId))
    .filter((recommendation) => isRecommendationActive(recommendation) && dueLeadIds.has(recommendation.lead_id));
  if (existing.length) {
    const grouped = new Map<string, number>();
    for (const recommendation of existing) grouped.set(recommendation.change_id, (grouped.get(recommendation.change_id) || 0) + 1);
    const [changeId, count] = [...grouped].sort((left, right) => right[1] - left[1])[0];
    return { changeId, count };
  }

  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Jerusalem",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value || "";
  const date = `${value("year")}-${value("month")}-${value("day")}`;
  const result = await createChangeAndMatch(client, organizationId, {
    type: "requested_date",
    service: "",
    startsAt: new Date(`${date}T12:00:00Z`).toISOString(),
    title: "הגיע מועד שביקשו לחזור",
    details: "הגיע המועד שבו ביקשו שנחזור",
  });
  return result.recommendations.length
    ? { changeId: result.change.id, count: result.recommendations.length }
    : null;
}

interface RecoveryTransition {
  lead: Lead;
  outcome?: Outcome;
  message?: OutreachMessage;
  recommendation?: Recommendation;
}

function transitionResult(data: unknown): RecoveryTransition {
  if (!data || typeof data !== "object") throw new Error("INVALID_TRANSITION_RESPONSE");
  return data as RecoveryTransition;
}

export async function prepareRecoveryMessage(
  client: SupabaseClient,
  organizationId: string,
  recommendationId: string,
) {
  const { data, error } = await client.rpc("sf_prepare_recovery_message", {
    p_organization_id: organizationId,
    p_recommendation_id: recommendationId,
  });
  throwIfError(error);
  const result = transitionResult(data);
  if (!result.message || !result.recommendation || !result.lead) throw new Error("INVALID_TRANSITION_RESPONSE");
  return result as Required<Pick<RecoveryTransition, "message" | "recommendation" | "lead">>;
}

export async function snoozeRecoveryMessage(
  client: SupabaseClient,
  organizationId: string,
  messageId: string,
) {
  const { data, error } = await client.rpc("sf_snooze_recovery_message", {
    p_organization_id: organizationId,
    p_message_id: messageId,
  });
  throwIfError(error);
  return transitionResult(data);
}

export async function dismissRecoveryRecommendation(
  client: SupabaseClient,
  organizationId: string,
  recommendationId: string,
) {
  const { data, error } = await client.rpc("sf_dismiss_recovery_recommendation", {
    p_organization_id: organizationId,
    p_recommendation_id: recommendationId,
  });
  throwIfError(error);
  const result = transitionResult(data);
  if (!result.recommendation || !result.lead) throw new Error("INVALID_TRANSITION_RESPONSE");
  return result as Required<Pick<RecoveryTransition, "recommendation" | "lead">>;
}

export async function markRecoveryMessageSent(
  client: SupabaseClient,
  organizationId: string,
  messageId: string,
  channel: string,
) {
  const { data, error } = await client.rpc("sf_mark_recovery_message_sent", {
    p_organization_id: organizationId,
    p_message_id: messageId,
    p_channel: channel,
  });
  throwIfError(error);
  return transitionResult(data);
}

export async function recordRecoveryResponse(
  client: SupabaseClient,
  organizationId: string,
  messageId: string,
  responseType: "interested" | "not_now" | "no_reply" | "dnc",
  responseText: string,
) {
  const { data, error } = await client.rpc("sf_record_recovery_response", {
    p_organization_id: organizationId,
    p_message_id: messageId,
    p_response_type: responseType,
    p_response_text: responseText,
  });
  throwIfError(error);
  return transitionResult(data);
}

export async function advanceRecoveryLead(
  client: SupabaseClient,
  organizationId: string,
  leadId: string,
  action: "contacted" | "booked" | "closed" | "not_now",
) {
  const { data, error } = await client.rpc("sf_advance_recovery_lead", {
    p_organization_id: organizationId,
    p_lead_id: leadId,
    p_action: action,
  });
  throwIfError(error);
  return transitionResult(data);
}

export async function confirmRecoveredRevenue(
  client: SupabaseClient,
  organizationId: string,
  leadId: string,
  revenueMinor: number,
) {
  const { data, error } = await client.rpc("sf_confirm_recovered_revenue", {
    p_organization_id: organizationId,
    p_lead_id: leadId,
    p_revenue_minor: revenueMinor,
    p_currency: "ILS",
  });
  throwIfError(error);
  return transitionResult(data);
}

export async function approveRecoveryMessage(
  client: SupabaseClient,
  organizationId: string,
  messageId: string,
  body: string,
) {
  const { data, error } = await client.rpc("sf_approve_recovery_message", {
    p_organization_id: organizationId,
    p_message_id: messageId,
    p_body: body,
  });
  throwIfError(error);
  const result = transitionResult(data);
  if (!result.message || !result.recommendation || !result.lead) throw new Error("INVALID_TRANSITION_RESPONSE");
  return result as Required<Pick<RecoveryTransition, "message" | "recommendation" | "lead">>;
}

export async function reconcileStaleWork(
  client: SupabaseClient,
  organizationId: string,
): Promise<{ retired: number; reset: number }> {
  const { data, error } = await client.rpc("sf_reconcile_stale_work", {
    p_organization_id: organizationId,
  });
  throwIfError(error);
  if (!data || typeof data !== "object") throw new Error("INVALID_RECONCILIATION_RESPONSE");
  const result = data as { retired?: number; reset?: number };
  if (typeof result.retired !== "number" || typeof result.reset !== "number") {
    throw new Error("INVALID_RECONCILIATION_RESPONSE");
  }
  return { retired: result.retired, reset: result.reset };
}

export async function deferRecoveryProgress(
  client: SupabaseClient,
  organizationId: string,
  leadId: string,
  reviewAt: string,
) {
  const { data, error } = await client.rpc("sf_defer_recovery_progress", {
    p_organization_id: organizationId,
    p_lead_id: leadId,
    p_review_at: reviewAt,
  });
  throwIfError(error);
  return transitionResult(data);
}

export async function recordFollowUpRequest(
  client: SupabaseClient,
  organizationId: string,
  messageId: string,
  responseText: string,
  requestedDate: string,
) {
  const { data, error } = await client.rpc("sf_record_follow_up_request", {
    p_organization_id: organizationId,
    p_message_id: messageId,
    p_response_text: responseText,
    p_requested_date: requestedDate,
  });
  throwIfError(error);
  return transitionResult(data);
}

export async function correctRecoveredRevenue(
  client: SupabaseClient,
  organizationId: string,
  outcomeId: string,
  revenueMinor: number,
  reason: string,
) {
  const { data, error } = await client.rpc("sf_correct_recovered_revenue", {
    p_organization_id: organizationId,
    p_outcome_id: outcomeId,
    p_revenue_minor: revenueMinor,
    p_reason: reason,
  });
  throwIfError(error);
  return transitionResult(data);
}

export async function updateLead(
  client: SupabaseClient,
  id: string,
  patch: Partial<Pick<Lead, "name" | "phone" | "email" | "service" | "dnc" | "medical_escalation" | "stopped_reason_code" | "stopped_reason_text" | "preferred_time" | "requested_contact_after" | "branch" | "needs_fix">>,
) {
  const { data, error } = await client.from("sf_leads").update(patch).eq("id", id).select("*").single();
  throwIfError(error);
  return data as Lead;
}
