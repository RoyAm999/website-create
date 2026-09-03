import assert from "node:assert/strict";
import test from "node:test";
import {
  canAdvanceRecoveryLead,
  canShowRecoveryProgress,
  isRecommendationActive,
  nextRecommendationBatch,
  orderRecoveryProgressQueue,
  planTodayPendingWork,
} from "../lib/today-flow";
import type { Lead, OutreachMessage, Recommendation } from "../lib/types";

function lead(overrides: Partial<Lead> = {}): Lead {
  return {
    id: "lead-1",
    organization_id: "organization-1",
    external_ref: null,
    name: "נועה לוי",
    phone: "0500000000",
    email: null,
    service: "טיפול פנים",
    value_minor: 90000,
    currency: "ILS",
    last_contact_at: null,
    notes: "",
    branch: null,
    dnc: false,
    medical_escalation: false,
    is_demo: false,
    needs_fix: false,
    stopped_reason_code: "timing",
    stopped_reason_text: "יכולה רק בערב",
    preferred_time: "ערב",
    requested_contact_after: null,
    status: "watching",
    response_text: null,
    created_at: "2026-09-03T08:00:00Z",
    updated_at: "2026-09-03T08:00:00Z",
    ...overrides,
  };
}

function recommendation(
  relatedLead: Lead | undefined,
  overrides: Partial<Recommendation> = {},
): Recommendation {
  return {
    id: "recommendation-1",
    organization_id: "organization-1",
    lead_id: relatedLead?.id || "lead-1",
    change_id: "change-1",
    then_text: "יכולה רק בערב",
    now_text: "התפנה תור בערב",
    why_text: "השינוי עונה על הסיבה",
    suggested_message: "היי נועה, התפנה תור בערב",
    state: "review",
    expires_at: "2026-09-03T12:00:00Z",
    created_at: "2026-09-03T08:00:00Z",
    lead: relatedLead,
    ...overrides,
  };
}

function message(overrides: Partial<OutreachMessage> = {}): OutreachMessage {
  return {
    id: "message-1",
    organization_id: "organization-1",
    recommendation_id: "recommendation-1",
    lead_id: "lead-1",
    body: "היי נועה, התפנה תור בערב",
    status: "draft",
    channel: null,
    copied_at: null,
    sent_at: null,
    created_at: "2026-09-03T08:00:00Z",
    updated_at: "2026-09-03T08:00:00Z",
    ...overrides,
  };
}

const now = new Date("2026-09-03T10:00:00Z").getTime();

test("an expired draft does not suppress a recommendation from a distinct new event", () => {
  const approvingLead = lead({ status: "approval" });
  const expired = recommendation(approvingLead, {
    id: "old-recommendation",
    change_id: "old-change",
    expires_at: "2026-09-03T09:59:59Z",
  });
  const newEvent = recommendation(approvingLead, {
    id: "new-recommendation",
    change_id: "new-change",
    expires_at: "2026-09-03T18:00:00Z",
  });
  const oldDraft = message({
    id: "old-message",
    recommendation_id: expired.id,
  });

  const plan = planTodayPendingWork([approvingLead], [expired, newEvent], [oldDraft], now);

  assert.deepEqual(plan.activeRecommendationIds, [newEvent.id]);
  assert.deepEqual(plan.stalePendingMessageIds, [oldDraft.id]);
  assert.deepEqual(plan.leadIdsToReset, [approvingLead.id]);
  assert.deepEqual(plan.recommendationIdsReadyForMessage, [newEvent.id]);
});

test("cleaning an expired draft preserves approval for a newer active pending event", () => {
  const approvingLead = lead({ status: "approval" });
  const expired = recommendation(approvingLead, {
    id: "old-recommendation",
    change_id: "old-change",
    expires_at: "2026-09-03T09:00:00Z",
  });
  const newEvent = recommendation(approvingLead, {
    id: "new-recommendation",
    change_id: "new-change",
    expires_at: "2026-09-03T18:00:00Z",
  });
  const oldDraft = message({ id: "old-message", recommendation_id: expired.id });
  const newDraft = message({
    id: "new-message",
    recommendation_id: newEvent.id,
    status: "copied",
  });

  const plan = planTodayPendingWork(
    [approvingLead],
    [expired, newEvent],
    [oldDraft, newDraft],
    now,
  );

  assert.deepEqual(plan.stalePendingMessageIds, [oldDraft.id]);
  assert.deepEqual(plan.leadIdsToReset, []);
  assert.deepEqual(plan.recommendationIdsReadyForMessage, []);
});

test("recommendations expire exactly at the boundary and malformed expiry is never active", () => {
  const watchingLead = lead();
  assert.equal(isRecommendationActive(recommendation(watchingLead), now), true);
  assert.equal(isRecommendationActive(recommendation(watchingLead, {
    expires_at: new Date(now).toISOString(),
  }), now), false);
  assert.equal(isRecommendationActive(recommendation(watchingLead, {
    expires_at: "not-a-date",
  }), now), false);
  assert.equal(isRecommendationActive(recommendation(watchingLead, {
    state: "expired",
    expires_at: null,
  }), now), false);
  assert.equal(isRecommendationActive(recommendation(undefined), now), false);
});

test("a slot recommendation stops being actionable when the slot begins", () => {
  const watchingLead = lead();
  const slot = recommendation(watchingLead, {
    expires_at: "2026-09-03T12:00:00Z",
    change: {
      id: "change-1",
      organization_id: "organization-1",
      type: "slot",
      service: "טיפול פנים",
      branch: null,
      starts_at: "2026-09-03T10:00:00Z",
      ends_at: "2026-09-03T12:00:00Z",
      title: "התפנה תור",
      details: "התפנה תור היום בשעה 13:00",
      is_demo: false,
      created_at: "2026-09-03T08:00:00Z",
    },
  });
  assert.equal(isRecommendationActive(slot, now - 1), true);
  assert.equal(isRecommendationActive(slot, now), false);
});

test("recommendation focus counts only the selected business change", () => {
  const watchingLead = lead();
  const first = recommendation(watchingLead, { id: "new-1", change_id: "new-change" });
  const second = recommendation(lead({ id: "lead-2" }), { id: "new-2", lead_id: "lead-2", change_id: "new-change" });
  const older = recommendation(lead({ id: "lead-3" }), { id: "old-1", lead_id: "lead-3", change_id: "old-change" });
  const batch = nextRecommendationBatch([first, second, older], [], now);
  assert.deepEqual(batch, { changeId: "new-change", recommendationIds: ["new-1", "new-2"] });
});

test("recommendation focus ignores rows that already have message history", () => {
  const watchingLead = lead();
  const handled = recommendation(watchingLead, { id: "handled", change_id: "new-change" });
  const ready = recommendation(lead({ id: "lead-2" }), { id: "ready", lead_id: "lead-2", change_id: "new-change" });
  const handledMessage = message({ recommendation_id: handled.id, status: "snoozed" });
  assert.deepEqual(nextRecommendationBatch([handled, ready], [handledMessage], now), {
    changeId: "new-change",
    recommendationIds: ["ready"],
  });
});

test("positive work is ordered with fresh interest before later bookkeeping", () => {
  const queue = orderRecoveryProgressQueue([
    lead({ id: "closed", status: "closed" }),
    lead({ id: "booked", status: "booked" }),
    lead({ id: "interested", status: "interested" }),
    lead({ id: "contacted", status: "contacted" }),
  ]);
  assert.deepEqual(queue.map((item) => item.id), ["interested", "contacted", "booked", "closed"]);
});

test("deferred positive work stays out of Today until its review time", () => {
  const deferred = lead({ status: "booked" }) as Lead & { next_review_at: string | null };
  deferred.next_review_at = "2026-09-04T09:00:00Z";
  assert.equal(canShowRecoveryProgress(deferred, new Date("2026-09-04T08:59:59Z").getTime()), false);
  assert.equal(canShowRecoveryProgress(deferred, new Date("2026-09-04T09:00:00Z").getTime()), true);
  assert.equal(canAdvanceRecoveryLead(deferred, "closed", new Date("2026-09-04T08:59:59Z").getTime()), false);
  assert.equal(canAdvanceRecoveryLead(deferred, "closed", new Date("2026-09-04T09:00:00Z").getTime()), true);
});

test("DNC and medical flags block active recommendations even if status looks actionable", () => {
  for (const blockedLead of [
    lead({ dnc: true }),
    lead({ medical_escalation: true }),
    lead({ needs_fix: true }),
  ]) {
    assert.equal(isRecommendationActive(recommendation(blockedLead), now), false);
  }
});

test("recovery progression follows the ordered path for a safe lead", () => {
  assert.equal(canShowRecoveryProgress(lead({ status: "interested" })), true);
  assert.equal(canAdvanceRecoveryLead(lead({ status: "interested" }), "contacted"), true);
  assert.equal(canAdvanceRecoveryLead(lead({ status: "interested" }), "not_now"), true);
  assert.equal(canAdvanceRecoveryLead(lead({ status: "interested" }), "booked"), false);
  assert.equal(canAdvanceRecoveryLead(lead({ status: "contacted" }), "booked"), true);
  assert.equal(canAdvanceRecoveryLead(lead({ status: "booked" }), "closed"), true);
  assert.equal(canAdvanceRecoveryLead(lead({ status: "closed" }), "closed"), false);
});

test("DNC or medical escalation blocks every forward progression action", () => {
  const actions = ["contacted", "booked", "closed", "not_now"] as const;
  for (const safety of [{ dnc: true }, { medical_escalation: true }]) {
    for (const status of ["interested", "contacted", "booked", "closed"] as const) {
      const blockedLead = lead({ status, ...safety });
      assert.equal(canShowRecoveryProgress(blockedLead), false);
      for (const action of actions) {
        assert.equal(
          canAdvanceRecoveryLead(blockedLead, action),
          false,
          `${status} must not advance to ${action}`,
        );
      }
    }
  }
});

test("medical-review and incomplete leads never enter sales progression", () => {
  for (const blockedLead of [
    lead({ status: "medical_review" }),
    lead({ status: "interested", needs_fix: true }),
    lead({ status: "interested", stopped_reason_code: "unknown" }),
  ]) {
    assert.equal(canShowRecoveryProgress(blockedLead), false);
    assert.equal(canAdvanceRecoveryLead(blockedLead, "contacted"), false);
  }
});
