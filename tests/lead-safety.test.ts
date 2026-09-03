import assert from "node:assert/strict";
import test from "node:test";
import { consolidateImportLeads, existingLeadIdsForContact, safeReimportPatch } from "../lib/lead-safety";
import type { ImportLead } from "../lib/types";

function imported(overrides: Partial<ImportLead> = {}): ImportLead {
  return {
    name: "נועה לוי",
    phone: "0500000000",
    service: "טיפול פנים",
    stopped_reason_code: "timing",
    stopped_reason_text: "יכולה רק בערב",
    ...overrides,
  };
}

test("batch duplicates collapse deterministically with DNC precedence", () => {
  const safe = imported({ name: "נועה", dnc: false, external_ref: "temporary-a" });
  const blocked = imported({ name: "נועה לוי", phone: "+972-50-000-0000", dnc: true, external_ref: "temporary-b" });
  const forward = consolidateImportLeads([safe, blocked]);
  const reverse = consolidateImportLeads([blocked, safe]);

  assert.equal(forward.length, 1);
  assert.equal(forward[0].lead.dnc, true);
  assert.equal(forward[0].lead.external_ref, "csv:phone:0500000000");
  assert.deepEqual(forward, reverse);
});

test("repeated invalid rows also receive one deterministic correction identity", () => {
  const invalid = imported({ phone: undefined, email: undefined, needs_fix: true });
  const consolidated = consolidateImportLeads([invalid, { ...invalid }]);
  assert.equal(consolidated.length, 1);
  assert.match(consolidated[0].lead.external_ref || "", /^csv:needs-fix:/);
});

test("phone and email resolving to different stored leads is a conflict", () => {
  const [contact] = consolidateImportLeads([imported({ email: "noa@example.com" })]);
  const ids = existingLeadIdsForContact(contact, [
    { id: "phone-lead", phone: "0500000000", email: null },
    { id: "email-lead", phone: null, email: "noa@example.com" },
  ]);
  assert.deepEqual(ids.sort(), ["email-lead", "phone-lead"]);
});

test("multiple batch groups cannot be accidentally bridged into one identity", () => {
  assert.throws(() => consolidateImportLeads([
    imported({ phone: "0500000000", email: "first@example.com" }),
    imported({ phone: "0520000000", email: "second@example.com" }),
    imported({ phone: "0500000000", email: "second@example.com" }),
  ]), /CONTACT_IDENTITY_CONFLICT/);
});

test("safe re-import only tightens safety and never resets a progressed status", () => {
  const current = {
    phone: "0500000000",
    email: null,
    dnc: false,
    medical_escalation: false,
    needs_fix: false,
    status: "booked",
  };
  const incoming = {
    phone: "0500000000",
    email: "noa@example.com",
    dnc: false,
    medical_escalation: true,
    needs_fix: true,
    status: "watching",
  };
  assert.deepEqual(safeReimportPatch(current, incoming), {
    email: "noa@example.com",
    medical_escalation: true,
    needs_fix: true,
  });

  assert.deepEqual(safeReimportPatch({ ...current, medical_escalation: true, needs_fix: true }, {
    ...incoming,
    medical_escalation: false,
    needs_fix: false,
  }), { email: "noa@example.com" });
});

test("DNC always wins during a re-import", () => {
  const patch = safeReimportPatch({
    phone: "0500000000",
    email: null,
    dnc: false,
    medical_escalation: false,
    needs_fix: false,
    status: "interested",
  }, {
    phone: "0500000000",
    email: null,
    dnc: true,
    medical_escalation: false,
    needs_fix: false,
    status: "dnc",
  });
  assert.deepEqual(patch, { dnc: true, status: "dnc" });
});
