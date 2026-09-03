import assert from "node:assert/strict";
import test from "node:test";
import { CsvImportError, csvImportErrorMessage, inferStoppedReason, parseCsv } from "../lib/csv";

test("infers internal stop reasons from the operator's plain-language account", () => {
  assert.equal(inferStoppedReason("יכולה להגיע רק אחרי 17:00").code, "timing");
  assert.equal(inferStoppedReason("ביקשה שנחזור אליה בחודש הבא").code, "requested_date");
  assert.equal(inferStoppedReason("חיפשה אפשרות לתשלומים").code, "payment");
  assert.equal(inferStoppedReason("לא הייתה זמינות לטיפול").code, "availability");
  assert.equal(inferStoppedReason("רוצה להתייעץ ולקחת עוד זמן").code, "needs_time");
  assert.equal(inferStoppedReason("פרטים כלליים בלבד").code, "unknown");
});

test("imports Hebrew headers and preserves DNC", () => {
  const csv = "שם,טלפון,שירות,שווי,סיבת עצירה,לא ליצור קשר\nנועה,0500000000,טיפול פנים,900,יכולה רק אחרי 17:00,לא\nאיילת,0520000000,טיפול פנים,700,ביקשה לא ליצור קשר,כן";
  const parsed = parseCsv(csv, "טיפול פנים");
  assert.equal(parsed.valid.length, 2);
  assert.equal(parsed.valid[0].stopped_reason_code, "timing");
  assert.equal(parsed.valid[1].dnc, true);
});

test("supports quoted commas", () => {
  const csv = 'name,email,service,notes\n"נועה לוי",noa@example.com,"טיפול פנים","רוצה ערב, אחרי העבודה"';
  const parsed = parseCsv(csv, "");
  assert.equal(parsed.valid[0].notes, "רוצה ערב, אחרי העבודה");
});

test("supports quoted multiline notes and escaped quotes without shifting rows", () => {
  const csv = [
    "name,email,service,notes,reason",
    '"נועה לוי",noa@example.com,"טיפול פנים","כתבה: ""אחזור אחרי העבודה""\nוביקשה תור ערב","יכולה רק אחרי 17:00"',
    "יעל,yael@example.com,טיפול פנים,,לא ענתה",
  ].join("\r\n");
  const parsed = parseCsv(csv, "");
  assert.equal(parsed.valid.length, 2);
  assert.equal(parsed.valid[0].notes, 'כתבה: "אחזור אחרי העבודה"\nוביקשה תור ערב');
  assert.equal(parsed.valid[1].name, "יעל");
});

test("reports friendly empty, header-only, and malformed CSV errors", () => {
  for (const [csv, code, expected] of [
    ["  \n", "EMPTY_CSV", "הקובץ ריק"],
    ["name,phone\n", "HEADER_ONLY_CSV", "רק כותרות"],
    ['name,phone,notes\nנועה,0500000000,"הערה שלא נסגרה', "MALFORMED_CSV", "שורה 2"],
    ['name,phone,notes\nנועה,0500000000,"הערה"טקסט', "MALFORMED_CSV", "שורה 2"],
  ] as const) {
    let caught: unknown;
    try { parseCsv(csv, ""); } catch (error) { caught = error; }
    assert.ok(caught instanceof CsvImportError);
    assert.equal(caught.code, code);
    assert.match(csvImportErrorMessage(caught) || "", new RegExp(expected));
  }
});

test("rejects duplicate aliases and extra cells instead of silently moving data", () => {
  assert.throws(
    () => parseCsv("name,שם,phone\nנועה,נועה,0500000000", ""),
    /DUPLICATE_COLUMNS/,
  );
  assert.throws(
    () => parseCsv("name,phone\nנועה,0500000000,unexpected", ""),
    /MALFORMED_CSV:2/,
  );
});

test("rejects a file without a contact column", () => {
  assert.throws(() => parseCsv("name,service\nנועה,טיפול", ""), /MISSING_REQUIRED_COLUMNS/);
});

test("marks an unknown stop reason for human correction", () => {
  const parsed = parseCsv("name,phone,service,notes\nנועה,0500000000,טיפול פנים,פרטים כלליים", "");
  assert.equal(parsed.valid.length, 0);
  assert.equal(parsed.needsFix.length, 1);
  assert.equal(parsed.needsFix[0].stopped_reason_code, "unknown");
});

test("a requested-date lead needs an explicit, valid follow-up date", () => {
  const missing = parseCsv("name,phone,reason\nדנה,0500000000,ביקשה שנחזור בספטמבר", "טיפול פנים");
  assert.equal(missing.needsFix.length, 1);

  const valid = parseCsv("name,phone,reason,תאריך לחזרה\nדנה,0500000000,ביקשה שנחזור בספטמבר,15/09/2026", "טיפול פנים");
  assert.equal(valid.valid.length, 1);
  assert.equal(valid.valid[0].requested_contact_after, "2026-09-15");
  assert.equal(valid.valid[0].stopped_reason_code, "requested_date");

  const invalid = parseCsv("name,phone,reason,requested_contact_after\nדנה,0500000000,ביקשה שנחזור בספטמבר,31/02/2026", "טיפול פנים");
  assert.equal(invalid.needsFix.length, 1);
});

test("an explicit requested-contact date takes precedence over timing text", () => {
  const parsed = parseCsv(
    "name,phone,reason,preferred_time,requested_contact_after\nדנה,0500000000,לחזור אחרי 17:00,אחרי 17:00,2026-09-15",
    "טיפול פנים",
  );
  assert.equal(parsed.valid.length, 1);
  assert.equal(parsed.valid[0].stopped_reason_code, "requested_date");
  assert.equal(parsed.valid[0].stopped_reason_text, "ביקשה לחזור בתאריך 2026-09-15");
  assert.equal(parsed.valid[0].preferred_time, "אחרי 17:00");
});

test("structured timing evidence is retained", () => {
  const parsed = parseCsv("name,phone,service,preferred_time\nנועה,0500000000,טיפול פנים,אחרי 17:00", "");
  assert.equal(parsed.valid.length, 1);
  assert.equal(parsed.valid[0].stopped_reason_code, "timing");
  assert.equal(parsed.valid[0].preferred_time, "אחרי 17:00");
});

test("ambiguous timing and branch notes require correction", () => {
  const timing = parseCsv("name,phone,service,reason\nנועה,0500000000,טיפול פנים,השעה לא התאימה", "");
  assert.equal(timing.needsFix.length, 1);

  const branch = parseCsv("name,phone,service,reason\nתמר,0500000001,טיפול לייזר,לא הייתה זמינות בסניף שביקשה", "");
  assert.equal(branch.needsFix.length, 1);
});

test("DNC remains safely importable even when the stop reason is unknown", () => {
  const parsed = parseCsv("name,phone,dnc\nנועה,0500000000,כן", "טיפול פנים");
  assert.equal(parsed.valid.length, 1);
  assert.equal(parsed.valid[0].dnc, true);
  assert.equal(parsed.valid[0].needs_fix, false);
});

test("contact identity is deterministic across repeat imports and phone formatting", () => {
  const first = parseCsv("name,phone,reason\nנועה,+972 50-000-0000,יכולה רק אחרי 17:00", "טיפול פנים");
  const repeated = parseCsv("name,phone,reason\nנועה,0500000000,יכולה רק אחרי 17:00", "טיפול פנים");
  assert.equal(first.valid[0].phone, "0500000000");
  assert.equal(first.valid[0].external_ref, repeated.valid[0].external_ref);
  assert.equal(first.valid[0].external_ref, "csv:phone:0500000000");

  const email = parseCsv("name,email,reason\nנועה, Noa@Example.COM ,יכולה רק בערב", "טיפול פנים");
  assert.equal(email.valid[0].email, "noa@example.com");
  assert.equal(email.valid[0].external_ref, "csv:email:noa@example.com");
});

test("date-specific availability without the requested date stays needs-fix", () => {
  const ambiguous = parseCsv("name,email,service,reason\nיעל,yael@example.com,הסרת שיער,לא הייתה זמינות בתאריך שביקשה", "");
  assert.equal(ambiguous.valid.length, 0);
  assert.equal(ambiguous.needsFix.length, 1);

  const general = parseCsv("name,email,service,reason\nיעל,yael@example.com,הסרת שיער,לא הייתה זמינות לטיפול", "");
  assert.equal(general.valid.length, 1);

  const qualifierInNotes = parseCsv("name,email,service,reason,notes\nיעל,yael@example.com,הסרת שיער,לא הייתה זמינות,רק בתאריך שביקשה", "");
  assert.equal(qualifierInNotes.needsFix.length, 1);

  const branchInNotes = parseCsv("name,email,service,reason,notes\nיעל,yael@example.com,הסרת שיער,לא הייתה זמינות,רק בסניף שביקשה", "");
  assert.equal(branchInNotes.needsFix.length, 1);
});

test("medical language is conservatively escalated and cannot become actionable", () => {
  for (const note of ["יש לי כאבים", "אני בהריון", "נוטלת תרופות", "היה סיבוך", "pregnant and taking medication"]) {
    const parsed = parseCsv(`name,phone,service,reason\nנועה,0500000000,טיפול פנים,${note}`, "");
    assert.equal(parsed.needsFix.length, 1, note);
    assert.equal(parsed.needsFix[0].medical_escalation, true, note);
  }
});

test("an explicit no-contact request is DNC even without a DNC column", () => {
  const parsed = parseCsv("name,phone,reason\nנועה,0500000000,ביקשה לא ליצור קשר", "טיפול פנים");
  assert.equal(parsed.valid.length, 1);
  assert.equal(parsed.valid[0].dnc, true);
});

test("an invalid contact value is not treated as a reachable lead", () => {
  const parsed = parseCsv("name,phone,reason\nנועה,not-a-phone,יכולה רק בערב", "טיפול פנים");
  assert.equal(parsed.needsFix.length, 1);
  assert.equal(parsed.needsFix[0].phone, undefined);
});
