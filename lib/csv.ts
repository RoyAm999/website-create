import type { ImportLead, StoppedReason } from "./types";
import { hasConcreteTimingEvidence } from "./matching";
import {
  hasMedicalEscalation,
  hasUnspecifiedAvailabilityConstraint,
  importContactIdentity,
  normalizeEmail,
  normalizePhone,
} from "./lead-safety";

const headerAliases: Record<string, string> = {
  name: "name",
  "שם": "name",
  phone: "phone",
  "טלפון": "phone",
  email: "email",
  "אימייל": "email",
  service: "service",
  "שירות": "service",
  value: "value",
  "שווי": "value",
  date: "date",
  "תאריך": "date",
  "תאריך קשר אחרון": "date",
  notes: "notes",
  "הערות": "notes",
  branch: "branch",
  "סניף": "branch",
  dnc: "dnc",
  "לא ליצור קשר": "dnc",
  reason: "reason",
  "סיבת עצירה": "reason",
  preferred_time: "preferred_time",
  "זמן מועדף": "preferred_time",
  "שעה מועדפת": "preferred_time",
  requested_contact_after: "requested_contact_after",
  contact_after: "requested_contact_after",
  "מועד לחזרה": "requested_contact_after",
  "תאריך לחזרה": "requested_contact_after",
};

export type CsvImportErrorCode =
  | "EMPTY_CSV"
  | "HEADER_ONLY_CSV"
  | "MISSING_REQUIRED_COLUMNS"
  | "DUPLICATE_COLUMNS"
  | "MALFORMED_CSV";

export class CsvImportError extends Error {
  constructor(
    public readonly code: CsvImportErrorCode,
    public readonly row?: number,
  ) {
    super(row ? `${code}:${row}` : code);
    this.name = "CsvImportError";
  }
}

export function csvImportErrorMessage(error: unknown): string | null {
  if (!(error instanceof CsvImportError)) return null;
  if (error.code === "EMPTY_CSV") return "הקובץ ריק. העלו קובץ עם שורת כותרות ולפחות פנייה אחת.";
  if (error.code === "HEADER_ONLY_CSV") return "מצאנו רק כותרות, בלי פניות. הוסיפו לפחות פנייה אחת ונסו שוב.";
  if (error.code === "MISSING_REQUIRED_COLUMNS") return "חסרות כותרות חובה: שם, ובנוסף טלפון או אימייל.";
  if (error.code === "DUPLICATE_COLUMNS") return "אותה כותרת מופיעה יותר מפעם אחת. השאירו עמודה אחת מכל סוג ונסו שוב.";
  return error.row
    ? `שורה ${error.row} בקובץ לא נקראה כראוי. בדקו פסיקים ומירכאות ונסו שוב.`
    : "הקובץ לא נקרא כראוי. בדקו פסיקים ומירכאות ונסו שוב.";
}

interface CsvRecord {
  cells: string[];
  row: number;
}

/**
 * Parse RFC-4180-style comma-separated records without splitting quoted
 * newlines. Keeping this small and deterministic avoids silently shifting a
 * note into another lead when an export contains line breaks or escaped
 * quotes.
 */
function parseRecords(input: string): CsvRecord[] {
  const records: CsvRecord[] = [];
  let cells: string[] = [];
  let current = "";
  let inQuotes = false;
  let quoteClosed = false;
  let recordStartRow = 1;
  let physicalRow = 1;

  const pushCell = () => {
    cells.push(current.trim());
    current = "";
    quoteClosed = false;
  };
  const pushRecord = () => {
    pushCell();
    if (cells.some((cell) => cell.length > 0)) records.push({ cells, row: recordStartRow });
    cells = [];
    recordStartRow = physicalRow + 1;
  };

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    const next = input[index + 1];

    if (inQuotes) {
      if (char === '"' && next === '"') {
        current += '"';
        index += 1;
      } else if (char === '"') {
        inQuotes = false;
        quoteClosed = true;
      } else if (char === "\r" && next === "\n") {
        current += "\n";
        index += 1;
        physicalRow += 1;
      } else {
        current += char;
        if (char === "\n" || char === "\r") physicalRow += 1;
      }
      continue;
    }

    if (char === '"') {
      // Quotes may wrap a complete cell, but cannot appear midway through an
      // unquoted value. Accept leading whitespace used by some spreadsheet
      // exports and discard it when the quoted value begins.
      if (current.trim().length > 0 || quoteClosed) throw new CsvImportError("MALFORMED_CSV", physicalRow);
      current = "";
      inQuotes = true;
    } else if (char === ",") {
      pushCell();
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && next === "\n") index += 1;
      pushRecord();
      physicalRow += 1;
    } else if (quoteClosed) {
      if (!/\s/.test(char)) throw new CsvImportError("MALFORMED_CSV", physicalRow);
    } else if (char === "\0") {
      throw new CsvImportError("MALFORMED_CSV", physicalRow);
    } else {
      current += char;
    }
  }

  if (inQuotes) throw new CsvImportError("MALFORMED_CSV", recordStartRow);
  if (cells.length || current.length || quoteClosed) pushRecord();
  return records;
}

function inferReason(text: string): { code: StoppedReason; label: string } {
  const value = text.trim();
  if (!value) return { code: "unknown", label: "לא ידוע למה הפנייה נעצרה" };
  if (/17|ערב|בוקר|שעה|זמן/i.test(value)) return { code: "timing", label: value };
  if (/תור|זמינות|פנוי/i.test(value)) return { code: "availability", label: value };
  if (/מחיר|יקר|תשלום|מימון/i.test(value)) return { code: "price", label: value };
  if (/שירות|טיפול.*חזר/i.test(value)) return { code: "service", label: value };
  if (/לחזור|אחרי|תאריך/i.test(value)) return { code: "requested_date", label: value };
  if (/לא ענה|לא ענתה|אין מענה/i.test(value)) return { code: "no_response", label: value };
  return { code: "unknown", label: value };
}

function normalizeDate(value: string): string | undefined {
  const input = value.trim();
  if (!input) return undefined;

  const localDate = input.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/);
  const candidate = localDate
    ? `${localDate[3]}-${localDate[2].padStart(2, "0")}-${localDate[1].padStart(2, "0")}`
    : input;
  const parsed = new Date(candidate.length === 10 ? `${candidate}T12:00:00Z` : candidate);
  if (!Number.isFinite(parsed.getTime())) return undefined;
  if (candidate.length === 10 && parsed.toISOString().slice(0, 10) !== candidate) return undefined;
  return candidate;
}

export function parseCsv(text: string, fallbackService: string): {
  valid: ImportLead[];
  needsFix: ImportLead[];
} {
  const source = text.replace(/^\uFEFF/, "");
  if (!source.trim()) throw new CsvImportError("EMPTY_CSV");
  const rows = parseRecords(source);
  if (!rows.length) throw new CsvImportError("EMPTY_CSV");
  if (rows.length === 1) throw new CsvImportError("HEADER_ONLY_CSV");
  const headers = rows[0].cells.map((cell) => headerAliases[cell.trim().toLowerCase()] || cell.trim().toLowerCase());
  if (!headers.includes("name") || (!headers.includes("phone") && !headers.includes("email"))) {
    throw new CsvImportError("MISSING_REQUIRED_COLUMNS");
  }
  if (new Set(headers).size !== headers.length) throw new CsvImportError("DUPLICATE_COLUMNS");

  const valid: ImportLead[] = [];
  const needsFix: ImportLead[] = [];
  rows.slice(1).forEach((record, index) => {
    const cells = record.cells;
    if (cells.length > headers.length) throw new CsvImportError("MALFORMED_CSV", record.row);
    const data = Object.fromEntries(headers.map((header, cellIndex) => [header, cells[cellIndex] || ""]));
    const requestedContactAfter = normalizeDate(data.requested_contact_after || "");
    const preferredTime = (data.preferred_time || "").trim();
    let reason = inferReason(data.reason || data.notes || "");
    // A structured promise to contact on a specific date is stronger than a
    // free-text timing hint. Preserve that commitment as the actionable reason
    // instead of silently downgrading it to a generic hour preference.
    if (requestedContactAfter) {
      reason = { code: "requested_date", label: `ביקשה לחזור בתאריך ${requestedContactAfter}` };
    } else if (reason.code === "unknown" && preferredTime) {
      reason = { code: "timing", label: `יכולה להגיע רק ${preferredTime}` };
    }
    const normalizedPhone = normalizePhone(data.phone);
    const normalizedEmail = normalizeEmail(data.email);
    const combinedContext = `${reason.label} ${data.notes || ""}`;
    const dnc = /^(1|true|yes|כן)$/i.test(data.dnc || "")
      || /(?:לא\s+ליצור\s+קשר|לא\s+לפנות|אל\s+תפנו|do\s+not\s+contact|unsubscribe)/i.test(combinedContext);
    const medicalEscalation = hasMedicalEscalation(combinedContext);
    const missingContact = !data.name || (!normalizedPhone && !normalizedEmail);
    const missingDecisionEvidence = !dnc && (
      reason.code === "unknown"
      || (reason.code === "requested_date" && !requestedContactAfter)
      || (reason.code === "timing" && !hasConcreteTimingEvidence(preferredTime || reason.label))
      || (reason.code === "availability" && hasUnspecifiedAvailabilityConstraint(combinedContext))
      || (/סניף|branch/i.test(combinedContext) && !data.branch)
      || Boolean(data.requested_contact_after && !requestedContactAfter)
      || medicalEscalation
    );
    const lead: ImportLead = {
      name: data.name || `פנייה ${index + 1}`,
      phone: normalizedPhone || undefined,
      email: normalizedEmail || undefined,
      service: data.service || fallbackService || "לא צוין שירות",
      value_minor: Math.max(0, Math.round((Number(data.value) || 0) * 100)),
      last_contact_at: normalizeDate(data.date || ""),
      notes: data.notes || "",
      branch: data.branch || undefined,
      dnc,
      stopped_reason_code: reason.code,
      stopped_reason_text: reason.label,
      preferred_time: preferredTime || undefined,
      requested_contact_after: requestedContactAfter,
      medical_escalation: medicalEscalation,
      needs_fix: missingContact || missingDecisionEvidence,
      external_ref: importContactIdentity({
        phone: normalizedPhone,
        email: normalizedEmail,
        name: data.name || `פנייה ${index + 1}`,
        service: data.service || fallbackService,
      }),
    };
    (lead.needs_fix ? needsFix : valid).push(lead);
  });
  return { valid, needsFix };
}
