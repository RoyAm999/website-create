import type { Lead } from "./types";

const DEFAULT_CLINIC_TIME_ZONE = "Asia/Jerusalem";

type PriorityLead = Pick<
  Lead,
  | "status"
  | "dnc"
  | "medical_escalation"
  | "needs_fix"
  | "stopped_reason_code"
  | "requested_contact_after"
  | "next_review_at"
  | "phone"
  | "email"
>;

function dateKeyAt(now: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value || "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

function validDateKey(value: string | null): string | null {
  const match = value?.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const candidate = `${match[1]}-${match[2]}-${match[3]}`;
  const parsed = new Date(`${candidate}T12:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === candidate ? candidate : null;
}

export function isDueRequestedContact(
  lead: PriorityLead,
  now = new Date(),
  timeZone = DEFAULT_CLINIC_TIME_ZONE,
): boolean {
  const requestedDate = validDateKey(lead.requested_contact_after);
  const scheduledReview = lead.next_review_at ? new Date(lead.next_review_at).getTime() : null;
  return lead.status === "watching"
    && !lead.dnc
    && !lead.medical_escalation
    && !lead.needs_fix
    && Boolean(lead.phone || lead.email)
    && lead.stopped_reason_code === "requested_date"
    && requestedDate !== null
    && requestedDate <= dateKeyAt(now, timeZone)
    && (scheduledReview === null || (Number.isFinite(scheduledReview) && scheduledReview <= now.getTime()));
}

export function dueRequestedContactCount(
  leads: PriorityLead[],
  now = new Date(),
  timeZone = DEFAULT_CLINIC_TIME_ZONE,
): number {
  return leads.filter((lead) => isDueRequestedContact(lead, now, timeZone)).length;
}
