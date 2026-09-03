import type { BusinessChange, Lead, OutreachMessage, Recommendation } from "./types";

type TodayLead = Pick<
  Lead,
  "id" | "status" | "dnc" | "medical_escalation" | "needs_fix" | "stopped_reason_code"
> & { next_review_at?: string | null };

type TodayRecommendation = Pick<
  Recommendation,
  "id" | "lead_id" | "change_id" | "state" | "expires_at"
> & {
  lead?: TodayLead;
  change?: Pick<BusinessChange, "type" | "starts_at">;
};

type TodayMessage = Pick<OutreachMessage, "id" | "recommendation_id" | "lead_id" | "status">;

export type RecoveryProgressAction = "contacted" | "booked" | "closed" | "not_now";

const pendingMessageStatuses = new Set<OutreachMessage["status"]>(["draft", "copied"]);
const progressLeadStatuses = new Set<Lead["status"]>(["interested", "contacted", "booked", "closed"]);

const allowedProgressActions: Partial<Record<Lead["status"], readonly RecoveryProgressAction[]>> = {
  interested: ["contacted", "not_now"],
  contacted: ["booked", "not_now"],
  booked: ["closed"],
};

function hasContactSafetyBlock(
  lead: Pick<Lead, "dnc" | "medical_escalation" | "needs_fix" | "stopped_reason_code">,
): boolean {
  return lead.dnc
    || lead.medical_escalation
    || lead.needs_fix
    || lead.stopped_reason_code === "unknown";
}

/**
 * Frontend actionability check. The database remains the final authority, but
 * expired or newly unsafe work should disappear from the operator's queue
 * before an action is attempted.
 */
export function isRecommendationActive(
  recommendation: TodayRecommendation,
  at = Date.now(),
): boolean {
  const lead = recommendation.lead;
  const expiresAt = recommendation.expires_at
    ? new Date(recommendation.expires_at).getTime()
    : null;
  const slotStartsAt = recommendation.change?.type === "slot"
    ? new Date(recommendation.change.starts_at || "").getTime()
    : null;
  return recommendation.state === "review"
    && (expiresAt === null || (Number.isFinite(expiresAt) && expiresAt > at))
    // A free appointment is useful only before it begins. Older records may
    // still carry a synthetic two-hour end time, so the change itself is the
    // source of truth at this boundary.
    && (slotStartsAt === null || (Number.isFinite(slotStartsAt) && slotStartsAt > at))
    && Boolean(lead)
    && !hasContactSafetyBlock(lead!)
    && (lead?.status === "watching" || lead?.status === "approval");
}

/**
 * Returns one coherent batch for the recommendation card on Today. A headline
 * must never count recommendations from several changes and then open only the
 * first change's subset.
 */
export function nextRecommendationBatch(
  recommendations: TodayRecommendation[],
  messages: TodayMessage[],
  at = Date.now(),
): { changeId: string; recommendationIds: string[] } | null {
  const recommendationIdsWithMessages = new Set(messages.map((message) => message.recommendation_id));
  const ready = recommendations.filter((recommendation) => (
    isRecommendationActive(recommendation, at)
    && !recommendationIdsWithMessages.has(recommendation.id)
  ));
  const first = ready[0];
  if (!first) return null;
  return {
    changeId: first.change_id,
    recommendationIds: ready
      .filter((recommendation) => recommendation.change_id === first.change_id)
      .map((recommendation) => recommendation.id),
  };
}

const recoveryProgressPriority: Partial<Record<Lead["status"], number>> = {
  interested: 0,
  contacted: 1,
  booked: 2,
  closed: 3,
};

/**
 * Fresh replies come before bookkeeping tasks. The input order is retained
 * within each stage, which keeps the database's newest-first order stable.
 */
export function orderRecoveryProgressQueue<T extends TodayLead>(leads: T[]): T[] {
  return leads
    .map((lead, index) => ({ lead, index }))
    .sort((left, right) => (
      (recoveryProgressPriority[left.lead.status] ?? 99)
      - (recoveryProgressPriority[right.lead.status] ?? 99)
      || left.index - right.index
    ))
    .map(({ lead }) => lead);
}

export interface TodayPendingPlan {
  activeRecommendationIds: string[];
  stalePendingMessageIds: string[];
  leadIdsToReset: string[];
  recommendationIdsReadyForMessage: string[];
}

/**
 * Computes the reconciliation work performed after today's data is loaded.
 * Message ownership is recommendation-scoped: history from an expired reason
 * must not hide a recommendation created for a distinct, genuine new event.
 */
export function planTodayPendingWork(
  leads: TodayLead[],
  recommendations: TodayRecommendation[],
  messages: TodayMessage[],
  at = Date.now(),
): TodayPendingPlan {
  const activeRecommendations = recommendations.filter((recommendation) => (
    isRecommendationActive(recommendation, at)
  ));
  const activeRecommendationIds = new Set(activeRecommendations.map((recommendation) => recommendation.id));
  const stalePendingMessages = messages.filter((message) => (
    pendingMessageStatuses.has(message.status)
    && !activeRecommendationIds.has(message.recommendation_id)
  ));
  const activePendingLeadIds = new Set(messages
    .filter((message) => (
      pendingMessageStatuses.has(message.status)
      && activeRecommendationIds.has(message.recommendation_id)
    ))
    .map((message) => message.lead_id));
  const stalePendingLeadIds = new Set(stalePendingMessages.map((message) => message.lead_id));
  const messageRecommendationIds = new Set(messages.map((message) => message.recommendation_id));

  return {
    activeRecommendationIds: [...activeRecommendationIds],
    stalePendingMessageIds: stalePendingMessages.map((message) => message.id),
    leadIdsToReset: leads
      .filter((lead) => (
        lead.status === "approval"
        && stalePendingLeadIds.has(lead.id)
        && !activePendingLeadIds.has(lead.id)
      ))
      .map((lead) => lead.id),
    recommendationIdsReadyForMessage: activeRecommendations
      .filter((recommendation) => !messageRecommendationIds.has(recommendation.id))
      .map((recommendation) => recommendation.id),
  };
}

export function canShowRecoveryProgress(lead: TodayLead, at = Date.now()): boolean {
  const nextReviewAt = lead.next_review_at
    ? new Date(lead.next_review_at).getTime()
    : null;
  return !hasContactSafetyBlock(lead)
    && progressLeadStatuses.has(lead.status)
    && (nextReviewAt === null || (Number.isFinite(nextReviewAt) && nextReviewAt <= at));
}

export function canAdvanceRecoveryLead(
  lead: TodayLead,
  action: RecoveryProgressAction,
  at = Date.now(),
): boolean {
  if (!canShowRecoveryProgress(lead, at)) return false;
  return allowedProgressActions[lead.status]?.includes(action) ?? false;
}
