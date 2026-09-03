import assert from "node:assert/strict";
import test from "node:test";
import { dueRequestedContactCount, isDueRequestedContact } from "../lib/priorities";
import type { Lead } from "../lib/types";

function lead(overrides: Partial<Lead> = {}): Lead {
  return {
    id: "00000000-0000-0000-0000-000000000001",
    organization_id: "00000000-0000-0000-0000-000000000010",
    external_ref: null,
    name: "דנה בר",
    phone: "0500000000",
    email: null,
    service: "טיפול פנים",
    value_minor: 0,
    currency: "ILS",
    last_contact_at: null,
    notes: "",
    branch: null,
    dnc: false,
    medical_escalation: false,
    is_demo: false,
    needs_fix: false,
    stopped_reason_code: "requested_date",
    stopped_reason_text: "ביקשה שנחזור בספטמבר",
    preferred_time: null,
    requested_contact_after: "2026-09-03",
    status: "watching",
    response_text: null,
    created_at: "2026-09-03T00:00:00Z",
    updated_at: "2026-09-03T00:00:00Z",
    ...overrides,
  };
}

const now = new Date("2026-09-03T10:00:00Z");

test("counts only explicit requested-contact dates that have arrived", () => {
  assert.equal(isDueRequestedContact(lead(), now), true);
  assert.equal(isDueRequestedContact(lead({ requested_contact_after: "2026-09-04" }), now), false);
  assert.equal(isDueRequestedContact(lead({ requested_contact_after: null }), now), false);
  assert.equal(dueRequestedContactCount([
    lead(),
    lead({ id: "2", requested_contact_after: "2026-09-01" }),
    lead({ id: "3", requested_contact_after: "2026-09-04" }),
  ], now), 2);
});

test("never prioritizes a blocked, unsafe, incomplete, or already active lead", () => {
  assert.equal(isDueRequestedContact(lead({ dnc: true, status: "dnc" }), now), false);
  assert.equal(isDueRequestedContact(lead({ medical_escalation: true }), now), false);
  assert.equal(isDueRequestedContact(lead({ needs_fix: true }), now), false);
  assert.equal(isDueRequestedContact(lead({ phone: null, email: null }), now), false);
  assert.equal(isDueRequestedContact(lead({ stopped_reason_code: "availability" }), now), false);
  assert.equal(isDueRequestedContact(lead({ status: "approval" }), now), false);
});

test("uses the clinic timezone at the calendar-day boundary", () => {
  const beforeMidnightUtc = new Date("2026-09-02T21:30:00Z");
  assert.equal(isDueRequestedContact(lead(), beforeMidnightUtc, "Asia/Jerusalem"), true);
  assert.equal(isDueRequestedContact(lead(), beforeMidnightUtc, "UTC"), false);
});

test("rejects malformed and impossible requested dates", () => {
  for (const requested_contact_after of ["2026-02-30", "03/09/2026", "2026-9-3", "", "tomorrow"]) {
    assert.equal(isDueRequestedContact(lead({ requested_contact_after }), now), false);
  }
});

test("an email-only requested-date lead is due when the clinic day arrives", () => {
  assert.equal(isDueRequestedContact(lead({ phone: null, email: "dana@example.com" }), now), true);
});

test("waits for the exact scheduled review time even after the calendar date arrives", () => {
  assert.equal(isDueRequestedContact(lead({ next_review_at: "2026-09-03T10:00:01Z" }), now), false);
  assert.equal(isDueRequestedContact(lead({ next_review_at: "2026-09-03T10:00:00Z" }), now), true);
  assert.equal(isDueRequestedContact(lead({ next_review_at: "not-a-date" }), now), false);
});
