import assert from "node:assert/strict";
import test from "node:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  advanceRecoveryLead,
  approveRecoveryMessage,
  confirmRecoveredRevenue,
  correctRecoveredRevenue,
  deferRecoveryProgress,
  dismissRecoveryRecommendation,
  markRecoveryMessageSent,
  prepareRecoveryMessage,
  reconcileStaleWork,
  recordFollowUpRequest,
  recordRecoveryResponse,
  snoozeRecoveryMessage,
} from "../lib/data";
import type { Lead, Outcome, OutreachMessage, Recommendation } from "../lib/types";

type Equal<Left, Right> = (
  (<Value>() => Value extends Left ? 1 : 2) extends
  (<Value>() => Value extends Right ? 1 : 2) ? true : false
);
type Expect<Value extends true> = Value;

type PrepareResult = Awaited<ReturnType<typeof prepareRecoveryMessage>>;
type RecordResult = Awaited<ReturnType<typeof recordRecoveryResponse>>;
type _PrepareResultHasRequiredRows = Expect<PrepareResult extends {
  lead: Lead;
  message: OutreachMessage;
  recommendation: Recommendation;
} ? true : false>;
type _RecordResultKeepsTypedRows = Expect<RecordResult extends {
  lead: Lead;
  outcome?: Outcome;
  message?: OutreachMessage;
  recommendation?: Recommendation;
} ? true : false>;
type _ResponseTypeIsClosedUnion = Expect<Equal<
  Parameters<typeof recordRecoveryResponse>[3],
  "interested" | "not_now" | "no_reply" | "dnc"
>>;
type _ProgressActionIsClosedUnion = Expect<Equal<
  Parameters<typeof advanceRecoveryLead>[3],
  "contacted" | "booked" | "closed" | "not_now"
>>;

interface RpcCall {
  name: string;
  args: Record<string, unknown>;
}

function rpcClient(data: unknown, calls: RpcCall[]): SupabaseClient {
  return {
    rpc: async (name: string, args: Record<string, unknown>) => {
      calls.push({ name, args });
      return { data, error: null };
    },
  } as unknown as SupabaseClient;
}

const transition = {
  lead: { id: "lead-1" } as Lead,
  message: { id: "message-1" } as OutreachMessage,
  recommendation: { id: "recommendation-1" } as Recommendation,
  outcome: { id: "outcome-1" } as Outcome,
};

test("transaction wrappers call the intended RPC with tenant-scoped identifiers", async () => {
  const calls: RpcCall[] = [];
  const client = rpcClient(transition, calls);

  assert.equal((await prepareRecoveryMessage(client, "org-1", "recommendation-1")).message.id, "message-1");
  await snoozeRecoveryMessage(client, "org-1", "message-1");
  await markRecoveryMessageSent(client, "org-1", "message-1", "whatsapp");
  await recordRecoveryResponse(client, "org-1", "message-1", "interested", "אשמח לקבוע");
  await advanceRecoveryLead(client, "org-1", "lead-1", "contacted");
  await confirmRecoveredRevenue(client, "org-1", "lead-1", 12500);
  await approveRecoveryMessage(client, "org-1", "message-1", "הודעה מאושרת וברורה");
  await deferRecoveryProgress(client, "org-1", "lead-1", "2026-09-10T09:00:00Z");
  await dismissRecoveryRecommendation(client, "org-1", "recommendation-1");
  await recordFollowUpRequest(client, "org-1", "message-1", "ביקשה שנחזור בשבוע הבא", "2026-09-10");
  await correctRecoveredRevenue(client, "org-1", "outcome-1", 13000, "הסכום הוקלד בטעות");

  assert.deepEqual(calls, [
    {
      name: "sf_prepare_recovery_message",
      args: { p_organization_id: "org-1", p_recommendation_id: "recommendation-1" },
    },
    {
      name: "sf_snooze_recovery_message",
      args: { p_organization_id: "org-1", p_message_id: "message-1" },
    },
    {
      name: "sf_mark_recovery_message_sent",
      args: { p_organization_id: "org-1", p_message_id: "message-1", p_channel: "whatsapp" },
    },
    {
      name: "sf_record_recovery_response",
      args: {
        p_organization_id: "org-1",
        p_message_id: "message-1",
        p_response_type: "interested",
        p_response_text: "אשמח לקבוע",
      },
    },
    {
      name: "sf_advance_recovery_lead",
      args: { p_organization_id: "org-1", p_lead_id: "lead-1", p_action: "contacted" },
    },
    {
      name: "sf_confirm_recovered_revenue",
      args: {
        p_organization_id: "org-1",
        p_lead_id: "lead-1",
        p_revenue_minor: 12500,
        p_currency: "ILS",
      },
    },
    {
      name: "sf_approve_recovery_message",
      args: {
        p_organization_id: "org-1",
        p_message_id: "message-1",
        p_body: "הודעה מאושרת וברורה",
      },
    },
    {
      name: "sf_defer_recovery_progress",
      args: {
        p_organization_id: "org-1",
        p_lead_id: "lead-1",
        p_review_at: "2026-09-10T09:00:00Z",
      },
    },
    {
      name: "sf_dismiss_recovery_recommendation",
      args: {
        p_organization_id: "org-1",
        p_recommendation_id: "recommendation-1",
      },
    },
    {
      name: "sf_record_follow_up_request",
      args: {
        p_organization_id: "org-1",
        p_message_id: "message-1",
        p_response_text: "ביקשה שנחזור בשבוע הבא",
        p_requested_date: "2026-09-10",
      },
    },
    {
      name: "sf_correct_recovered_revenue",
      args: {
        p_organization_id: "org-1",
        p_outcome_id: "outcome-1",
        p_revenue_minor: 13000,
        p_reason: "הסכום הוקלד בטעות",
      },
    },
  ]);
});

test("stale-work wrapper validates and returns the RPC counters", async () => {
  const calls: RpcCall[] = [];
  const client = rpcClient({ retired: 2, reset: 1 }, calls);
  assert.deepEqual(await reconcileStaleWork(client, "org-1"), { retired: 2, reset: 1 });
  assert.deepEqual(calls, [{ name: "sf_reconcile_stale_work", args: { p_organization_id: "org-1" } }]);
});

test("prepare wrapper rejects an incomplete transactional response", async () => {
  const client = rpcClient({ lead: transition.lead }, []);
  await assert.rejects(
    prepareRecoveryMessage(client, "org-1", "recommendation-1"),
    /INVALID_TRANSITION_RESPONSE/,
  );
});

test("transition wrappers reject non-object RPC payloads", async () => {
  const client = rpcClient(null, []);
  await assert.rejects(
    advanceRecoveryLead(client, "org-1", "lead-1", "contacted"),
    /INVALID_TRANSITION_RESPONSE/,
  );
});
