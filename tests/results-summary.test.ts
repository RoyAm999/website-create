import assert from "node:assert/strict";
import test from "node:test";
import { summarizeResults } from "../lib/results-summary";
import type { Lead, Outcome } from "../lib/types";

function lead(isDemo: boolean): Lead {
  return {
    id: isDemo ? "demo-lead" : "real-lead",
    organization_id: "organization-1",
    external_ref: null,
    name: "פנייה",
    phone: "0500000000",
    email: null,
    service: "טיפול",
    value_minor: 0,
    currency: "ILS",
    last_contact_at: null,
    notes: "",
    branch: null,
    dnc: false,
    medical_escalation: false,
    is_demo: isDemo,
    needs_fix: false,
    stopped_reason_code: "timing",
    stopped_reason_text: "רק בערב",
    preferred_time: "ערב",
    requested_contact_after: null,
    status: "closed",
    response_text: null,
    created_at: "2026-09-03T08:00:00Z",
    updated_at: "2026-09-03T08:00:00Z",
  };
}

function outcome(id: string, relatedLead: Lead, overrides: Partial<Outcome> = {}): Outcome {
  return {
    id,
    organization_id: "organization-1",
    lead_id: relatedLead.id,
    response_type: "interested",
    response_text: "רוצה לקבוע",
    responded_at: "2026-09-03T08:00:00Z",
    contacted_at: "2026-09-03T08:05:00Z",
    booked_at: "2026-09-03T08:10:00Z",
    closed_at: "2026-09-03T08:15:00Z",
    status: "closed",
    revenue_minor: 100_000,
    currency: "ILS",
    revenue_confirmed_at: "2026-09-03T08:20:00Z",
    created_at: "2026-09-03T08:00:00Z",
    updated_at: "2026-09-03T08:20:00Z",
    lead: relatedLead,
    ...overrides,
  };
}

test("demo results and revenue never enter the real results funnel", () => {
  const real = outcome("real-outcome", lead(false));
  const demo = outcome("demo-outcome", lead(true), { revenue_minor: 9_999_900 });
  const medical = outcome("medical-outcome", lead(false), {
    response_type: "medical_review",
    status: "medical_review",
    booked_at: null,
    closed_at: null,
    revenue_minor: null,
    revenue_confirmed_at: null,
  });
  const missingLead = outcome("unverified-outcome", lead(false), { lead: undefined });

  const summary = summarizeResults([demo, medical, missingLead, real]);

  assert.deepEqual(summary.realRecovered.map((item) => item.id), [real.id]);
  assert.deepEqual(summary.demoRecovered.map((item) => item.id), [demo.id]);
  assert.deepEqual(summary.funnel, { returned: 1, booked: 1, closed: 1, revenue: 100_000 });
});
