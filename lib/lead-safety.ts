import type { ImportLead } from "./types";

export function normalizePhone(value: string | null | undefined): string {
  let digits = (value || "").replace(/\D/g, "");
  if (digits.startsWith("00972")) digits = `0${digits.slice(5)}`;
  else if (digits.startsWith("972")) digits = `0${digits.slice(3)}`;
  return digits.length >= 9 && digits.length <= 15 ? digits : "";
}

export function normalizeEmail(value: string | null | undefined): string {
  const email = (value || "").trim().toLocaleLowerCase("en-US");
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : "";
}

function normalizeIdentityPart(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLocaleLowerCase("he-IL");
}

export function importContactIdentity(input: {
  phone?: string;
  email?: string;
  name?: string;
  service?: string;
}): string {
  const phone = normalizePhone(input.phone);
  if (phone) return `csv:phone:${phone}`;
  const email = normalizeEmail(input.email);
  if (email) return `csv:email:${email}`;
  // Invalid rows still get a deterministic identity, so repeatedly uploading
  // the same file cannot create an unlimited pile of correction cards.
  return `csv:needs-fix:${normalizeIdentityPart(input.name || "unknown")}:${normalizeIdentityPart(input.service || "unknown")}`;
}

export interface ConsolidatedImportLead {
  lead: ImportLead;
  phones: string[];
  emails: string[];
}

function safetyRank(lead: ImportLead): number {
  return (lead.dnc ? 4 : 0) + (lead.medical_escalation ? 2 : 0) + (lead.needs_fix ? 1 : 0);
}

function stableLeadLabel(lead: ImportLead): string {
  return [lead.external_ref, lead.name, lead.service, lead.phone, lead.email].map((value) => value || "").join("|");
}

export function consolidateImportLeads(leads: ImportLead[]): ConsolidatedImportLead[] {
  const groups: Array<{ rows: ImportLead[]; phones: Set<string>; emails: Set<string>; identities: Set<string> }> = [];

  for (const lead of leads) {
    const phone = normalizePhone(lead.phone);
    const email = normalizeEmail(lead.email);
    const identity = importContactIdentity({ phone, email, name: lead.name, service: lead.service });
    const matching = groups.filter((group) => group.identities.has(identity) || (phone && group.phones.has(phone)) || (email && group.emails.has(email)));
    if (matching.length > 1) throw new Error("CONTACT_IDENTITY_CONFLICT");

    const group = matching[0] || { rows: [], phones: new Set<string>(), emails: new Set<string>(), identities: new Set<string>() };
    if (!matching.length) groups.push(group);
    group.rows.push(lead);
    group.identities.add(identity);
    if (phone) group.phones.add(phone);
    if (email) group.emails.add(email);
  }

  return groups.map((group) => {
    const phones = [...group.phones].sort();
    const emails = [...group.emails].sort();
    const primary = [...group.rows].sort((left, right) => {
      const rank = safetyRank(right) - safetyRank(left);
      return rank || stableLeadLabel(left).localeCompare(stableLeadLabel(right), "he");
    })[0];
    const dnc = group.rows.some((row) => Boolean(row.dnc));
    const medicalEscalation = group.rows.some((row) => Boolean(row.medical_escalation));
    const needsFix = group.rows.some((row) => Boolean(row.needs_fix));
    const phone = phones[0];
    const email = emails[0];
    return {
      phones,
      emails,
      lead: {
        ...primary,
        phone: phone || undefined,
        email: email || undefined,
        dnc,
        medical_escalation: medicalEscalation,
        needs_fix: needsFix,
        external_ref: importContactIdentity({ phone, email, name: primary.name, service: primary.service }),
      },
    };
  });
}

export function existingLeadIdsForContact(
  contact: Pick<ConsolidatedImportLead, "phones" | "emails">,
  existing: Array<{ id: string; phone: string | null; email: string | null }>,
): string[] {
  const phoneSet = new Set(contact.phones);
  const emailSet = new Set(contact.emails);
  return [...new Set(existing.filter((lead) => {
    const phone = normalizePhone(lead.phone);
    const email = normalizeEmail(lead.email);
    return Boolean((phone && phoneSet.has(phone)) || (email && emailSet.has(email)));
  }).map((lead) => lead.id))];
}

interface ImportSafetyState {
  phone: string | null;
  email: string | null;
  dnc: boolean;
  medical_escalation: boolean;
  needs_fix: boolean;
  status: string;
}

export function safeReimportPatch(
  current: ImportSafetyState,
  incoming: ImportSafetyState,
): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  if (!normalizePhone(current.phone) && incoming.phone) patch.phone = normalizePhone(incoming.phone) || null;
  if (!normalizeEmail(current.email) && incoming.email) patch.email = normalizeEmail(incoming.email) || null;
  if (incoming.dnc && !current.dnc) {
    patch.dnc = true;
    patch.status = "dnc";
  }
  if (incoming.medical_escalation && !current.medical_escalation) patch.medical_escalation = true;
  if (incoming.needs_fix && !current.needs_fix) patch.needs_fix = true;
  return patch;
}

export function hasMedicalEscalation(value: string): boolean {
  const text = value.trim().toLocaleLowerCase("he-IL");
  if (!text) return false;
  const hebrewRisk = /(?:רפואי|רפואית|בהריון|בהיריון|הריון|היריון|הרה|כאב|כאבים|כואב|תרופה|תרופות|תרופתי|אנטיביוטיקה|מדלל(?:י)?\s*דם|סיבוך|סיבוכים|דימום|זיהום|נפיחות|אלרג|תגובה\s*חריגה)/i.test(text);
  const englishRisk = /\b(?:pregnant|pregnancy|pain|painful|medication|medicine|antibiotic|blood\s*thinner|complication|bleeding|infection|swelling|allergy|allergic|adverse\s*reaction)\b/i.test(text);
  return hebrewRisk || englishRisk;
}

export function hasNoContactRequest(value: string): boolean {
  return /(?:לא\s+ליצור\s+קשר|לא\s+לפנות|אל\s+תפנו|do\s+not\s+contact|unsubscribe)/i.test(value);
}

export function hasUnspecifiedAvailabilityConstraint(value: string): boolean {
  const text = value.trim().toLocaleLowerCase("he-IL");
  if (!text) return false;
  return /(?:בתאריך|תאריך\s+שביקש|במועד|מועד\s+שביקש|ביום\s+שביקש|בשבוע\s+שביקש|השבוע|בחודש\s+שביקש|החודש|when\s+requested|requested\s+(?:date|day)|that\s+(?:date|day))/i.test(text);
}
