import type { BusinessChange, ChangeType, Lead, Recommendation } from "./types";
import { hasUnspecifiedAvailabilityConstraint } from "./lead-safety";

const CLINIC_TIME_ZONE = "Asia/Jerusalem";
const MAX_AVAILABILITY_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

const compatibleReasons: Record<ChangeType, string[]> = {
  slot: ["timing", "availability"],
  availability: ["timing", "availability"],
  service: ["service"],
  requested_date: ["requested_date"],
  payment: ["payment", "price"],
  other: [],
};

type MatchableChange = Pick<
  BusinessChange,
  "type" | "service" | "branch" | "starts_at" | "ends_at" | "title" | "details"
>;

interface LocalDateTime {
  date: string;
  minutes: number;
  weekday: number;
}

interface TimingConstraint {
  earliest?: number;
  latest?: number;
  weekday?: number;
}

function clean(value: string | null | undefined): string {
  return (value || "").trim().replace(/\s+/g, " ").toLocaleLowerCase("he-IL");
}

function parseDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function localDateTime(date: Date): LocalDateTime {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: CLINIC_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value || "";
  const weekdays: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    minutes: Number(get("hour")) * 60 + Number(get("minute")),
    weekday: weekdays[get("weekday")] ?? -1,
  };
}

function dateKey(value: string | null | undefined): string | null {
  if (!value) return null;
  const dateOnly = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (dateOnly) {
    const candidate = `${dateOnly[1]}-${dateOnly[2]}-${dateOnly[3]}`;
    const parsed = new Date(`${candidate}T12:00:00Z`);
    return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === candidate ? candidate : null;
  }
  const parsed = parseDate(value);
  return parsed ? localDateTime(parsed).date : null;
}

function parseHour(match: RegExpMatchArray | null): number | undefined {
  if (!match) return undefined;
  const hour = Number(match[1]);
  const minute = Number(match[2] || 0);
  if (!Number.isInteger(hour) || hour < 0 || hour > 23 || minute < 0 || minute > 59) return undefined;
  return hour * 60 + minute;
}

function requestedWeekday(text: string): number | undefined {
  const options: [RegExp, number][] = [
    [/(?:יום\s*)?ראשון|sunday/i, 0],
    [/(?:יום\s*)?שני|monday/i, 1],
    [/(?:יום\s*)?שלישי|tuesday/i, 2],
    [/(?:יום\s*)?רביעי|wednesday/i, 3],
    [/(?:יום\s*)?חמישי|thursday/i, 4],
    [/(?:יום\s*)?שישי|friday/i, 5],
    [/שבת|saturday/i, 6],
  ];
  return options.find(([pattern]) => pattern.test(text))?.[1];
}

function timingConstraint(value: string): TimingConstraint | null {
  const text = clean(value);
  if (!text) return null;

  const weekday = requestedWeekday(text);
  const after = parseHour(text.match(/(?:אחרי|החל\s*מ|לא\s*לפני|מ(?:שעה|־|-)?)[\s:]*(\d{1,2})(?::(\d{2}))?/i));
  const before = /לא\s*לפני/i.test(text)
    ? undefined
    : parseHour(text.match(/(?:לפני|עד)[\s:]*(\d{1,2})(?::(\d{2}))?/i));
  const exact = parseHour(text.match(/(?:בשעה|בשעות|ב־|ב-)[\s:]*(\d{1,2})(?::(\d{2}))?/i));
  const saysMorning = /בוקר/i.test(text);
  const rejectsMorning = /(?:לא|אינה?|אין\s+(?:לה|אפשרות))[^.]{0,24}בבוקר/i.test(text);
  const saysEvening = /ערב|אחרי\s+העבודה/i.test(text);

  // Conflicting free text is not evidence. A person should clarify it first.
  if ((saysMorning && !rejectsMorning && saysEvening) || (after !== undefined && before !== undefined && after > before)) return null;

  const constraint: TimingConstraint = {};
  if (weekday !== undefined) constraint.weekday = weekday;
  if (after !== undefined) constraint.earliest = after;
  if (before !== undefined) constraint.latest = before;
  if (exact !== undefined) {
    constraint.earliest = exact;
    constraint.latest = exact;
  }
  if (after === undefined && before === undefined && exact === undefined) {
    if (saysEvening) constraint.earliest = 17 * 60;
    else if (saysMorning && !rejectsMorning) {
      constraint.earliest = 6 * 60;
      constraint.latest = 12 * 60;
    } else if (/צהריים|אחר\s*הצהריים/i.test(text)) {
      constraint.earliest = 12 * 60;
      constraint.latest = 17 * 60;
    }
  }

  return Object.keys(constraint).length ? constraint : null;
}

export function hasConcreteTimingEvidence(value: string): boolean {
  return timingConstraint(value) !== null;
}

function fitsTiming(point: LocalDateTime, constraint: TimingConstraint): boolean {
  if (constraint.weekday !== undefined && point.weekday !== constraint.weekday) return false;
  if (constraint.earliest !== undefined && point.minutes < constraint.earliest) return false;
  if (constraint.latest !== undefined && point.minutes > constraint.latest) return false;
  return true;
}

function changeHasCompatibleTime(change: MatchableChange, constraint: TimingConstraint): boolean {
  const start = parseDate(change.starts_at);
  if (!start) return false;
  if (change.type === "slot") return fitsTiming(localDateTime(start), constraint);

  const end = parseDate(change.ends_at);
  if (!end || end <= start || end.getTime() - start.getTime() > MAX_AVAILABILITY_WINDOW_MS) return false;

  // Sample the concrete window at 15-minute intervals and include its exact end.
  for (let time = start.getTime(); time <= end.getTime(); time += 15 * 60 * 1000) {
    if (fitsTiming(localDateTime(new Date(time)), constraint)) return true;
  }
  return fitsTiming(localDateTime(end), constraint);
}

function hasConcreteChange(change: MatchableChange): boolean {
  if (["slot", "availability", "service", "payment"].includes(change.type) && !clean(change.service)) return false;
  if (change.type === "slot") return Boolean(parseDate(change.starts_at));
  if (change.type === "availability") {
    const start = parseDate(change.starts_at);
    const end = parseDate(change.ends_at);
    return Boolean(start && end && end > start && end.getTime() - start.getTime() <= MAX_AVAILABILITY_WINDOW_MS);
  }
  if (change.type === "requested_date") return Boolean(dateKey(change.starts_at));
  if (change.type === "service" || change.type === "payment") {
    const details = clean(change.details);
    return details.length >= 4 && details !== clean(change.title);
  }
  return false;
}

export function canMatchLead(lead: Lead, change: MatchableChange, now = new Date()): boolean {
  if (lead.status !== "watching") return false;
  if (lead.dnc || lead.medical_escalation || lead.needs_fix) return false;
  if (lead.stopped_reason_code === "unknown") return false;
  if (lead.stopped_reason_code === "availability" && hasUnspecifiedAvailabilityConstraint(`${lead.stopped_reason_text} ${lead.notes}`)) return false;
  if (!compatibleReasons[change.type].includes(lead.stopped_reason_code)) return false;
  if (!hasConcreteChange(change)) return false;
  if (change.type !== "requested_date" && clean(lead.service) !== clean(change.service)) return false;

  // A slot or availability window must still be ahead of the operator. A
  // reason that has started already is not a defensible reason to send a new
  // message, even if an old record included a later synthetic end time.
  if (change.type === "slot" || change.type === "availability") {
    const start = parseDate(change.starts_at);
    if (!start || start.getTime() <= now.getTime()) return false;
  }

  const leadBranch = clean(lead.branch);
  const changeBranch = clean(change.branch);
  const leadMentionsBranch = /סניף|branch/i.test(`${lead.stopped_reason_text} ${lead.notes}`);
  // If either side is branch-specific, both sides must name the same branch.
  // A blank branch is not permission to guess.
  if (leadMentionsBranch && !leadBranch) return false;
  if ((leadBranch || changeBranch) && (!leadBranch || !changeBranch || leadBranch !== changeBranch)) return false;

  if ((change.type === "slot" || change.type === "availability") && lead.stopped_reason_code === "timing") {
    const constraint = timingConstraint(lead.preferred_time || lead.stopped_reason_text);
    if (!constraint || !changeHasCompatibleTime(change, constraint)) return false;
  }

  if (change.type === "requested_date") {
    const requestedDate = dateKey(lead.requested_contact_after);
    const asOfDate = dateKey(change.starts_at);
    const today = localDateTime(now).date;
    // Free-text "call later" is not enough: the promised date must be stored,
    // it must have arrived, and the operator cannot pre-trigger a future date.
    const scheduledReview = lead.next_review_at ? new Date(lead.next_review_at).getTime() : null;
    if (!requestedDate || !asOfDate || requestedDate > asOfDate || asOfDate > today) return false;
    if (scheduledReview !== null && (!Number.isFinite(scheduledReview) || scheduledReview > now.getTime())) return false;
  }

  return true;
}

function formatMoment(value: string): string {
  return new Intl.DateTimeFormat("he-IL", {
    timeZone: CLINIC_TIME_ZONE,
    weekday: "long",
    day: "numeric",
    month: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function formatLocalDate(value: string): string {
  return new Intl.DateTimeFormat("he-IL", {
    timeZone: CLINIC_TIME_ZONE,
    weekday: "long",
    day: "numeric",
    month: "numeric",
    year: "numeric",
  }).format(new Date(value));
}

export function concreteChangeDetails(change: Pick<BusinessChange, "type" | "title" | "details" | "starts_at" | "ends_at">): string {
  const start = parseDate(change.starts_at);
  const end = parseDate(change.ends_at);
  if (change.type === "slot" && start) return `${change.title}: ${formatMoment(start.toISOString())}`;
  if (change.type === "availability" && start && end) {
    return `${change.title}: ${formatMoment(start.toISOString())} עד ${formatMoment(end.toISOString())}`;
  }
  if (change.type === "requested_date" && start) return `${change.title}: ${formatLocalDate(start.toISOString())}`;
  return change.details.trim() || change.title;
}

export function makeRecommendation(
  lead: Lead,
  change: Pick<BusinessChange, "id" | "organization_id" | "type" | "title" | "details" | "starts_at" | "ends_at">,
): Omit<Recommendation, "id" | "created_at" | "lead" | "change"> {
  // createChangeAndMatch persists the concrete evidence in change.details.
  // Keeping this byte-for-byte aligned also lets the database independently
  // verify that the client did not invent a different "why now" claim.
  const nowText = change.details.trim();
  return {
    organization_id: change.organization_id,
    lead_id: lead.id,
    change_id: change.id,
    then_text: lead.stopped_reason_text,
    now_text: nowText,
    why_text: "השינוי החדש עונה בדיוק על הסיבה שבגללה הפנייה נעצרה.",
    suggested_message: `היי ${lead.name.split(" ")[0]}, כאן צוות המרפאה. זכרנו ש${lead.stopped_reason_text}. רצינו לעדכן ש${nowText}. אם זה עדיין רלוונטי, נשמח לבדוק עבורך את הפרטים.`,
    state: "review",
    // A concrete slot stops being actionable when it begins. Availability is
    // a window and remains actionable until that explicitly supplied window
    // ends. Other reasons do not receive an invented expiry.
    expires_at: change.type === "slot" ? change.starts_at : change.ends_at,
  };
}
