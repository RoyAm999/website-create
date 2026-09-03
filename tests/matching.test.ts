import assert from "node:assert/strict";
import test from "node:test";
import { canMatchLead, concreteChangeDetails, makeRecommendation } from "../lib/matching";
import type { BusinessChange, Lead } from "../lib/types";

function lead(overrides: Partial<Lead> = {}): Lead {
  return {
    id: "00000000-0000-0000-0000-000000000001",
    organization_id: "00000000-0000-0000-0000-000000000010",
    external_ref: null,
    name: "נועה לוי",
    phone: "0500000000",
    email: null,
    service: "טיפול פנים",
    value_minor: 90000,
    currency: "ILS",
    last_contact_at: "2026-08-14T00:00:00Z",
    notes: "",
    branch: null,
    dnc: false,
    medical_escalation: false,
    is_demo: true,
    needs_fix: false,
    stopped_reason_code: "timing",
    stopped_reason_text: "יכולה רק אחרי 17:00",
    preferred_time: "אחרי 17:00",
    requested_contact_after: null,
    status: "watching",
    response_text: null,
    created_at: "2026-09-03T00:00:00Z",
    updated_at: "2026-09-03T00:00:00Z",
    ...overrides,
  };
}

const eveningChange: BusinessChange = {
  id: "00000000-0000-0000-0000-000000000002",
  organization_id: "00000000-0000-0000-0000-000000000010",
  type: "slot",
  service: "טיפול פנים",
  branch: null,
  starts_at: "2026-09-10T15:00:00Z",
  ends_at: "2026-09-10T17:00:00Z",
  title: "התפנה תור",
  details: "התפנה תור ביום חמישי בשעה 18:00",
  is_demo: false,
  created_at: "2026-09-03T00:00:00Z",
};

test("matches an evening request to a concrete evening slot", () => {
  assert.equal(canMatchLead(lead(), eveningChange), true);
});

test("a slot can match only before its exact start and expires at its start", () => {
  const beforeStart = new Date("2026-09-10T14:59:59Z");
  const atStart = new Date("2026-09-10T15:00:00Z");
  assert.equal(canMatchLead(lead(), eveningChange, beforeStart), true);
  assert.equal(canMatchLead(lead(), eveningChange, atStart), false);
  assert.equal(makeRecommendation(lead(), eveningChange).expires_at, eveningChange.starts_at);
});

test("availability must also be reported before its window begins", () => {
  const availability = { ...eveningChange, type: "availability" as const };
  const availabilityLead = lead({ stopped_reason_code: "availability", stopped_reason_text: "לא הייתה זמינות" });
  assert.equal(canMatchLead(availabilityLead, availability, new Date("2026-09-10T14:59:59Z")), true);
  assert.equal(canMatchLead(availabilityLead, availability, new Date("2026-09-10T15:00:00Z")), false);
  assert.equal(makeRecommendation(availabilityLead, availability).expires_at, availability.ends_at);
});

test("never matches DNC, medical, needs-fix or unknown leads", () => {
  assert.equal(canMatchLead(lead({ dnc: true, status: "dnc" }), eveningChange), false);
  assert.equal(canMatchLead(lead({ medical_escalation: true }), eveningChange), false);
  assert.equal(canMatchLead(lead({ needs_fix: true }), eveningChange), false);
  assert.equal(canMatchLead(lead({ stopped_reason_code: "unknown" }), eveningChange), false);
});

test("only a lead that is still watching can enter a new recovery flow", () => {
  for (const status of ["approval", "waiting", "interested", "contacted", "booked", "closed", "not_now", "no_reply", "dnc"] as const) {
    assert.equal(canMatchLead(lead({ status }), eveningChange), false, `status ${status} must not rematch`);
  }
});

test("does not treat a morning-only request as an evening match", () => {
  assert.equal(canMatchLead(lead({ stopped_reason_text: "יכולה רק בבוקר", preferred_time: "בוקר" }), eveningChange), false);
});

test("does not treat a morning slot as a match for an evening request", () => {
  const morningChange = { ...eveningChange, starts_at: "2026-09-10T06:00:00Z", ends_at: "2026-09-10T08:00:00Z", details: "התפנה תור בשעה 09:00" };
  assert.equal(canMatchLead(lead(), morningChange), false);
  assert.equal(canMatchLead(lead({ stopped_reason_text: "יכולה רק בבוקר", preferred_time: "בוקר" }), morningChange), true);
});

test("understands 'not before' as a lower bound, not an exact hour", () => {
  assert.equal(canMatchLead(lead({ stopped_reason_text: "לא לפני 17:00", preferred_time: "לא לפני 17:00" }), eveningChange), true);
});

test("does not guess when a timing reason has no concrete constraint", () => {
  assert.equal(canMatchLead(lead({ stopped_reason_text: "השעה לא התאימה", preferred_time: null }), eveningChange), false);
});

test("honors an explicit weekday request", () => {
  const fridaySlot = { ...eveningChange, starts_at: "2026-09-11T08:00:00Z", ends_at: "2026-09-11T10:00:00Z" };
  assert.equal(canMatchLead(lead({ stopped_reason_text: "יכולה רק ביום שישי", preferred_time: "שישי" }), fridaySlot), true);
  assert.equal(canMatchLead(lead({ stopped_reason_text: "יכולה רק ביום שישי", preferred_time: "שישי" }), eveningChange), false);
});

test("requires matching service and an exact reason family", () => {
  assert.equal(canMatchLead(lead({ service: "הסרת שיער" }), eveningChange), false);
  assert.equal(canMatchLead(lead({ stopped_reason_code: "price", stopped_reason_text: "היה יקר" }), eveningChange), false);
});

test("never guesses a branch", () => {
  assert.equal(canMatchLead(lead(), { ...eveningChange, branch: "צפון" }), false);
  assert.equal(canMatchLead(lead({ branch: "צפון" }), eveningChange), false);
  assert.equal(canMatchLead(lead({ branch: "צפון" }), { ...eveningChange, branch: "דרום" }), false);
  assert.equal(canMatchLead(lead({ branch: " צפון " }), { ...eveningChange, branch: "צפון" }), true);
  assert.equal(canMatchLead(lead({ stopped_reason_text: "רק בסניף צפון", preferred_time: "ערב" }), eveningChange), false);
});

test("availability must include a concrete, bounded time window", () => {
  const availabilityLead = lead({ stopped_reason_code: "availability", stopped_reason_text: "לא הייתה זמינות" });
  const availability = { ...eveningChange, type: "availability" as const };
  assert.equal(canMatchLead(availabilityLead, { ...availability, ends_at: null }), false);
  assert.equal(canMatchLead(availabilityLead, { ...availability, ends_at: availability.starts_at }), false);
  assert.equal(canMatchLead(availabilityLead, availability), true);
  assert.equal(canMatchLead(lead({ stopped_reason_text: "יכולה רק בבוקר", preferred_time: "בוקר" }), availability), false);
});

test("date-specific availability text never matches without its missing constraint", () => {
  const availabilityLead = lead({
    stopped_reason_code: "availability",
    stopped_reason_text: "לא הייתה זמינות בתאריך שביקשה",
    preferred_time: null,
  });
  assert.equal(canMatchLead(availabilityLead, eveningChange), false);
  assert.equal(canMatchLead({ ...availabilityLead, stopped_reason_text: "לא הייתה זמינות", notes: "רק בתאריך שביקשה" }, eveningChange), false);
});

test("requested-date recovery requires an explicit date that has actually arrived", () => {
  const now = new Date("2026-09-03T10:00:00Z");
  const yesterday = "2026-09-02";
  const tomorrow = "2026-09-04";
  const change: BusinessChange = {
    ...eveningChange,
    type: "requested_date",
    service: "",
    starts_at: now.toISOString(),
    ends_at: null,
    title: "הגיע מועד שביקשו לחזור",
    details: "הגיע המועד שבו ביקשו שנחזור",
  };
  const requested = lead({ stopped_reason_code: "requested_date", stopped_reason_text: "ביקשה שנחזור במועד מסוים", preferred_time: null });
  assert.equal(canMatchLead(requested, change, now), false);
  assert.equal(canMatchLead(requested, { ...change, starts_at: null }, now), false);
  assert.equal(canMatchLead(lead({ ...requested, requested_contact_after: tomorrow }), change, now), false);
  assert.equal(canMatchLead(lead({ ...requested, requested_contact_after: yesterday }), change, now), true);
  assert.equal(canMatchLead(lead({ ...requested, requested_contact_after: yesterday, next_review_at: "2026-09-03T10:00:01Z" }), change, now), false);
  assert.equal(canMatchLead(lead({ ...requested, requested_contact_after: yesterday, next_review_at: "2026-09-03T10:00:00Z" }), change, now), true);
  assert.equal(canMatchLead(lead({ ...requested, requested_contact_after: yesterday }), { ...change, starts_at: `${tomorrow}T12:00:00Z` }, now), false);
});

test("requested-date matching uses the clinic calendar date, not the UTC date", () => {
  const requested = lead({
    stopped_reason_code: "requested_date",
    stopped_reason_text: "ביקשה שנחזור ב־4 בספטמבר",
    preferred_time: null,
    requested_contact_after: "2026-09-04",
  });
  const change: BusinessChange = {
    ...eveningChange,
    type: "requested_date",
    service: "",
    starts_at: "2026-09-04T12:00:00Z",
    ends_at: null,
    title: "הגיע מועד שביקשו לחזור",
    details: "הגיע המועד שבו ביקשו שנחזור",
  };

  // It is already 4 September in Jerusalem, while UTC is still 3 September.
  assert.equal(canMatchLead(requested, change, new Date("2026-09-03T21:30:00Z")), true);
  // The operator still cannot declare 4 September before the clinic day begins.
  assert.equal(canMatchLead(requested, change, new Date("2026-09-03T20:30:00Z")), false);
});

test("recommendation includes then, now, why and a contextual message", () => {
  const recommendation = makeRecommendation(lead(), eveningChange);
  assert.match(recommendation.then_text, /17:00/);
  assert.match(recommendation.now_text, /18:00/);
  assert.match(recommendation.why_text, /בדיוק/);
  assert.match(recommendation.suggested_message, /נועה/);
});

test("requested-date evidence is date-only and does not imply a two-hour expiry", () => {
  const details = concreteChangeDetails({
    type: "requested_date",
    title: "הגיע מועד שביקשו לחזור",
    details: "",
    starts_at: "2026-09-03T12:00:00Z",
    ends_at: null,
  });
  assert.match(details, /3\.9\.2026/);
  assert.doesNotMatch(details, /15:00|שעה/);
});

test("availability evidence is persisted as a concrete dated statement", () => {
  const details = concreteChangeDetails({
    ...eveningChange,
    type: "availability",
    title: "נפתחה זמינות",
    details: "נפתחה זמינות",
  });
  assert.match(details, /נפתחה זמינות/);
  assert.match(details, /18:00/);
  assert.match(details, /20:00/);
  const recommendation = makeRecommendation(lead({ stopped_reason_code: "availability", stopped_reason_text: "לא הייתה זמינות" }), {
    ...eveningChange,
    type: "availability",
    title: "נפתחה זמינות",
    details,
  });
  assert.equal(recommendation.now_text, details);
});
