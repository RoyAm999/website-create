import assert from "node:assert/strict";
import test from "node:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createChangeAndMatch, importLeads, importLeadsWithSummary, loadDemoLeads } from "../lib/data";
import type { BusinessChange, ImportLead, Lead, Recommendation } from "../lib/types";

interface RpcCall {
  name: string;
  args: Record<string, unknown>;
}

function importClient(result: unknown, calls: RpcCall[]): SupabaseClient {
  return {
    rpc: async (name: string, args: Record<string, unknown>) => {
      calls.push({ name, args });
      return { data: result, error: null };
    },
  } as unknown as SupabaseClient;
}

function input(overrides: Partial<ImportLead> = {}): ImportLead {
  return {
    name: "נועה",
    phone: "050-000-0000",
    service: "טיפול פנים",
    stopped_reason_code: "timing",
    stopped_reason_text: "יכולה רק אחרי 17:00",
    preferred_time: "אחרי 17:00",
    external_ref: "csv:phone:0500000000",
    ...overrides,
  };
}

test("bulk import is one tenant-scoped RPC after deterministic consolidation", async () => {
  const calls: RpcCall[] = [];
  const stored = [{ id: "lead-1", name: "נועה" }] as Lead[];
  const client = importClient({ leads: stored, inserted: 1, updated: 0, unchanged: 0 }, calls);

  assert.deepEqual(await importLeads(client, "org-1", [input(), input({ dnc: true })]), stored);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, "sf_import_leads");
  assert.equal(calls[0].args.p_organization_id, "org-1");
  const rows = calls[0].args.p_leads as Array<Record<string, unknown>>;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].dnc, true);
  assert.equal(rows[0].external_ref, "csv:phone:0500000000");
});

test("summary import preserves exact inserted, updated and unchanged counts", async () => {
  const calls: RpcCall[] = [];
  const stored = [{ id: "lead-1", name: "נועה" }] as Lead[];
  const result = { leads: stored, inserted: 0, updated: 1, unchanged: 2 };

  assert.deepEqual(await importLeadsWithSummary(importClient(result, calls), "org-1", [input()]), result);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, "sf_import_leads");
});

test("demo load uses the same atomic import path and always supplies stable identities", async () => {
  const calls: RpcCall[] = [];
  const stored = Array.from({ length: 20 }, (_, index) => ({ id: `lead-${index + 1}` })) as Lead[];
  const client = importClient({ leads: stored, inserted: 20, updated: 0, unchanged: 0 }, calls);

  assert.equal((await loadDemoLeads(client, "org-1")).length, 20);
  const rows = calls[0].args.p_leads as Array<Record<string, unknown>>;
  assert.equal(rows.length, 20);
  assert.ok(rows.every((row) => typeof row.external_ref === "string" && String(row.external_ref).startsWith("demo-")));
  assert.ok(rows.every((row) => row.is_demo === true));
});

test("import rejects malformed transactional responses", async () => {
  await assert.rejects(
    importLeads(importClient({ inserted: 1 }, []), "org-1", [input()]),
    /INVALID_IMPORT_RESPONSE/,
  );
  await assert.rejects(
    importLeads(importClient({ leads: [], inserted: 1, updated: -1, unchanged: 0 }, []), "org-1", [input()]),
    /INVALID_IMPORT_RESPONSE/,
  );
});

test("business change and every match are committed by one RPC", async () => {
  const calls: RpcCall[] = [];
  const lead = {
    id: "11111111-1111-4111-8111-111111111111",
    organization_id: "org-1",
    name: "נועה",
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
    stopped_reason_code: "requested_date",
    stopped_reason_text: "ביקשה שנחזור בינואר",
    preferred_time: null,
    requested_contact_after: "2020-01-01",
    status: "watching",
    response_text: null,
    external_ref: "csv:phone:0500000000",
    created_at: "2020-01-01T00:00:00Z",
    updated_at: "2020-01-01T00:00:00Z",
  } satisfies Lead;

  const client = {
    from: (table: string) => {
      const response = { data: table === "sf_leads" ? [lead] : [], error: null };
      const chain: Record<string, unknown> = {};
      for (const method of ["select", "eq", "order"]) chain[method] = () => chain;
      chain.then = (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) => Promise.resolve(response).then(resolve, reject);
      return chain;
    },
    rpc: async (name: string, args: Record<string, unknown>) => {
      calls.push({ name, args });
      const change = args.p_change as BusinessChange;
      const recommendations = (args.p_recommendations as Recommendation[]).map((row, index) => ({
        ...row,
        id: `recommendation-${index + 1}`,
        created_at: "2020-01-02T00:00:00Z",
      }));
      return { data: { change, recommendations, checked: 1 }, error: null };
    },
  } as unknown as SupabaseClient;

  const result = await createChangeAndMatch(client, "org-1", {
    type: "requested_date",
    service: "",
    startsAt: "2020-01-02T12:00:00Z",
    title: "הגיע מועד שביקשו לחזור",
    details: "הגיע המועד",
  });

  assert.equal(result.recommendations.length, 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, "sf_create_change_and_match");
  assert.equal((calls[0].args.p_recommendations as Recommendation[])[0].lead_id, lead.id);
  assert.equal((calls[0].args.p_change as BusinessChange).id, result.change.id);
});
